#!/usr/bin/env node
/**
 * Primary Group Head service for Raspberry Pi.
 * Exposes REST endpoints to onboard devices, manage policies and proxy access checks.
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const bodyParser = require("body-parser");
const { ethers } = require("ethers");
const ThreatModel = require("./threatModel");
const client = require("prom-client");
const resourceStorePath = path.join(__dirname, "..", "..", "config", "resourceStore.json");
const resourceStore = fs.existsSync(resourceStorePath)
  ? JSON.parse(fs.readFileSync(resourceStorePath, "utf8"))
  : {};
const bootstrapConfigPath = path.join(__dirname, "..", "..", "tmp", "bootstrap-config.json");
const bootstrapConfig = fs.existsSync(bootstrapConfigPath) ? JSON.parse(fs.readFileSync(bootstrapConfigPath, "utf8")) : {};
const DEFAULT_OBJECT_ADDRESS = process.env.DEFAULT_OBJECT_ADDRESS || bootstrapConfig.objectAddress || null;
const DEFAULT_ACC_TYPE = process.env.DEFAULT_ACC_TYPE || bootstrapConfig.accType || "sensor";
const ESP_TELEMETRY_DIR = path.join(__dirname, "results", "esp-telemetry");
if (!fs.existsSync(ESP_TELEMETRY_DIR)) {
  fs.mkdirSync(ESP_TELEMETRY_DIR, { recursive: true });
}
const DEMO_LOG_DIR = process.env.DEMO_LOG_DIR || path.join(__dirname, "results", "demo-telemetry");
if (!fs.existsSync(DEMO_LOG_DIR)) {
  fs.mkdirSync(DEMO_LOG_DIR, { recursive: true });
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const METRICS_PATH = process.env.METRICS_PATH || "/metrics";
const METRIC_PREFIX = process.env.METRICS_PREFIX || "primary_group_head_";
const ACCESS_EVAL_FALLBACK_GAS_LIMIT = Number(process.env.ACCESS_EVAL_FALLBACK_GAS_LIMIT || 3_000_000);

const registry = new client.Registry();
client.collectDefaultMetrics({ prefix: METRIC_PREFIX, register: registry });

const httpRequestCounter = new client.Counter({
  name: `${METRIC_PREFIX}http_requests_total`,
  help: "HTTP requests processed by the primary group head",
  labelNames: ["endpoint", "status"],
  registers: [registry],
});

const httpRequestDuration = new client.Histogram({
  name: `${METRIC_PREFIX}http_request_duration_seconds`,
  help: "HTTP request duration in seconds",
  labelNames: ["endpoint"],
  buckets: [0.05, 0.1, 0.2, 0.5, 1, 2, 5],
  registers: [registry],
});

const blockchainTxDuration = new client.Histogram({
  name: `${METRIC_PREFIX}tx_duration_seconds`,
  help: "Blockchain transaction duration in seconds",
  labelNames: ["operation"],
  buckets: [0.5, 1, 2, 5, 10, 20],
  registers: [registry],
});

const blockchainGasUsed = new client.Histogram({
  name: `${METRIC_PREFIX}tx_gas_used`,
  help: "Gas used per blockchain transaction",
  labelNames: ["operation"],
  buckets: [50000, 80000, 120000, 200000, 350000, 500000],
  registers: [registry],
});

const accessDecisionCounter = new client.Counter({
  name: `${METRIC_PREFIX}access_decisions_total`,
  help: "Access decisions returned by evaluate endpoint",
  labelNames: ["result"],
  registers: [registry],
});

const contractInfoGauge = new client.Gauge({
  name: `${METRIC_PREFIX}access_contract_info`,
  help: "Metadata for latest access-control contract deployment",
  labelNames: ["contract", "object", "subject", "accType"],
  registers: [registry],
});

const policyOperationCounter = new client.Counter({
  name: `${METRIC_PREFIX}policy_operations_total`,
  help: "Policy operations performed through the primary group head",
  labelNames: ["operation", "contract"],
  registers: [registry],
});

const threatEventsCounter = new client.Counter({
  name: `${METRIC_PREFIX}threat_events_total`,
  help: "Threat events detected by the primary group head",
  labelNames: ["code", "severity", "stride", "response"],
  registers: [registry],
});

const tokenAdjustmentsCounter = new client.Counter({
  name: `${METRIC_PREFIX}token_adjustments_total`,
  help: "Token adjustments applied as part of threat responses",
  labelNames: ["type"],
  registers: [registry],
});

const stats = {
  startedAt: new Date().toISOString(),
  requests: {
    registerDevice: { ok: 0, error: 0 },
    deployContract: { ok: 0, error: 0 },
    policies: { ok: 0, error: 0 },
    evaluate: { ok: 0, error: 0 },
  },
  transactions: {
    registerDevice: { count: 0, totalGas: 0 },
    deployContract: { count: 0, totalGas: 0 },
    policyAdd: { count: 0, totalGas: 0 },
  },
  accessDecisions: { allow: 0, deny: 0 },
  lastDeployedContract: null,
  lastPolicyChange: null,
  recentEvents: [],
  threats: {
    total: 0,
    byCode: {},
    tokenAdjustments: [],
  },
  accounts: new Set(),
};

function pushRecentEvent(event) {
  stats.recentEvents.unshift({ timestamp: new Date().toISOString(), ...event });
  if (stats.recentEvents.length > 20) {
    stats.recentEvents.pop();
  }
}

function logEvent(event, payload = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    ...payload,
  };
  console.log(JSON.stringify(entry));
  pushRecentEvent({ event, ...payload });
}

function recordTransactionMetrics(operation, receipt, timerEnd) {
  if (typeof timerEnd === "function") {
    timerEnd();
  }

  if (!receipt) {
    return;
  }

  const gasUsed = receipt.gasUsed ? Number(receipt.gasUsed) : undefined;
  if (gasUsed && !Number.isNaN(gasUsed)) {
    blockchainGasUsed.observe({ operation }, gasUsed);
    const bucket =
      operation === "register_device"
        ? stats.transactions.registerDevice
        : operation === "deploy_contract"
        ? stats.transactions.deployContract
        : operation === "policy_add"
        ? stats.transactions.policyAdd
        : null;
    if (bucket) {
      bucket.count += 1;
      bucket.totalGas += gasUsed;
    }
  }
}

function getResourcePayload(resource, action) {
  const resourceEntry = resourceStore[resource];
  if (!resourceEntry) {
    return null;
  }
  const actionEntry = resourceEntry[action];
  if (!actionEntry) {
    return null;
  }
  return {
    ...actionEntry,
    deliveredAt: new Date().toISOString(),
    resource,
    action,
  };
}

function recordThreatEvent(threat, { subjectAddress, objectAddress, accType, resource, action }) {
  stats.threats.total += 1;
  if (!stats.threats.byCode[threat.code]) {
    stats.threats.byCode[threat.code] = {
      count: 0,
      severity: threat.severity,
      stride: threat.stride,
    };
  }
  stats.threats.byCode[threat.code].count += 1;

  threatEventsCounter.inc({
    code: threat.code,
    severity: threat.severity,
    stride: threat.stride,
    response: threat.response,
  });

  logEvent("threat_detected", {
    code: threat.code,
    severity: threat.severity,
    stride: threat.stride,
    response: threat.response,
    tokenAdjustment: threat.tokenAdjustment,
    subjectAddress,
    objectAddress,
    accType,
    resource,
    action,
  });
}

async function executeJudgeAction(operation, fn, wallet) {
  const timer = blockchainTxDuration.startTimer({ operation });
  let overrides = {};

  while (true) {
    try {
      const tx = await fn(overrides);
      const receipt = await tx.wait();
      recordTransactionMetrics(operation, receipt, timer);
      return receipt;
    } catch (err) {
      const message = err?.message || "";
      if (message.includes("nonce")) {
        const nextNonce = await wallet.getNonce("pending");
        overrides = { ...overrides, nonce: nextNonce };
        continue;
      }
      throw err;
    }
  }
}

async function sendTxWithNonceRetry(wallet, fn) {
  let overrides = {};

  while (true) {
    try {
      const tx = await fn(overrides);
      const receipt = await tx.wait();
      return { tx, receipt };
    } catch (err) {
      const message = err?.message || "";
      if (message.includes("nonce")) {
        const nextNonce = await wallet.getNonce("pending");
        overrides = { ...overrides, nonce: nextNonce };
        continue;
      }
      throw err;
    }
  }
}

async function sendTxAllowRevert(wallet, fn) {
  let overrides = {};
  let gasLimit = null;

  while (true) {
    try {
      const tx = await fn({
        ...overrides,
        ...(gasLimit ? { gasLimit } : {}),
      });
      try {
        const receipt = await tx.wait();
        return { tx, receipt, reverted: receipt?.status === 0 };
      } catch (err) {
        if (err?.receipt) {
          return { tx, receipt: err.receipt, reverted: true, error: err };
        }
        throw err;
      }
    } catch (err) {
      const message = String(err?.message || "");
      const lower = message.toLowerCase();
      if (!gasLimit && (lower.includes("estimategas") || lower.includes("missing revert data") || lower.includes("execution reverted"))) {
        gasLimit = ACCESS_EVAL_FALLBACK_GAS_LIMIT;
        continue;
      }
      if (lower.includes("nonce")) {
        const nextNonce = await wallet.getNonce("pending");
        overrides = { ...overrides, nonce: nextNonce };
        continue;
      }
      throw err;
    }
  }
}

const THREAT_TO_JUDGE_REASON = {
  UNAUTHORIZED_ACCESS: "Unauthorized access attempt",
  TOO_MANY_ACCESS_ATTEMPTS: "Too frequent access",
  DISRUPTION_OF_SERVICE: "Denial of Service",
  DATA_TAMPERING: "Tampering with data",
};

function normalizeAddress(address) {
  return typeof address === "string" ? address.toLowerCase() : "";
}

function toNumber(value, fallback = 0) {
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === "string" && value.length) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function unixToIso(value) {
  const seconds = toNumber(value);
  if (!seconds) {
    return null;
  }
  const millis = seconds * 1000;
  if (!Number.isFinite(millis) || millis < 0 || millis > 8.64e15) {
    return null;
  }
  const asDate = new Date(millis);
  if (Number.isNaN(asDate.getTime())) {
    return null;
  }
  return asDate.toISOString();
}

function mapThreatToJudgeReason(threat) {
  if (!threat) {
    return null;
  }
  return THREAT_TO_JUDGE_REASON[threat.code] || threat.name || threat.code;
}

function summarizeJudgeState(state) {
  if (!state) {
    return null;
  }
  return {
    waveIndex: toNumber(state.waveIndex),
    blockedAttemptCountInWave: toNumber(state.blockedAttemptCountInWave),
    quarantineLevel: toNumber(state.quarantineLevel),
    quarantineUntil: toNumber(state.quarantineUntil),
    quarantineUntilIso: unixToIso(state.quarantineUntil),
    temporaryQuarantineActive: Boolean(state.temporarilyQuarantined),
    permanentRevoked: Boolean(state.permanentRevoked),
    securityTokenBudget: toNumber(state.securityTokenBudget, 100),
    cumulativePenalty: toNumber(state.cumulativePenalty),
    lastMaliciousAt: toNumber(state.lastMaliciousAt),
    lastMaliciousAtIso: unixToIso(state.lastMaliciousAt),
    lastBenignAt: toNumber(state.lastBenignAt),
    lastBenignAtIso: unixToIso(state.lastBenignAt),
    consecutiveMaliciousCount: toNumber(state.consecutiveMaliciousCount),
  };
}

function sanitizeJson(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJson(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeJson(entry)]));
  }
  return value;
}

async function handleThreatResponses({ threat, subjectAddress, judgeContract, wallet }) {
  const auto = threat.autoResponse || {};
  if (!auto.type) {
    return;
  }

  switch (auto.type) {
    case "suspend":
    case "ban": {
      const reason = mapThreatToJudgeReason(threat);
      await executeJudgeAction(
        "judge_report_malicious",
        (overrides) => judgeContract.reportMaliciousActivity(subjectAddress, reason, overrides),
        wallet
      );
      tokenAdjustmentsCounter.inc({ type: "deduct" }, Math.abs(threat.tokenAdjustment || 0));
      stats.threats.tokenAdjustments.push({
        subjectAddress,
        delta: threat.tokenAdjustment,
        reason,
        timestamp: new Date().toISOString(),
      });
      break;
    }
    case "reward": {
      await executeJudgeAction(
        "judge_reward_member",
        (overrides) => judgeContract.reportNonPenalizeMisbehavior(subjectAddress, overrides),
        wallet
      );
      tokenAdjustmentsCounter.inc({ type: "reward" }, Math.abs(threat.tokenAdjustment || 0));
      stats.threats.tokenAdjustments.push({
        subjectAddress,
        delta: threat.tokenAdjustment,
        reason: threat.name || threat.code,
        timestamp: new Date().toISOString(),
      });
      break;
    }
    case "warn": {
      stats.threats.tokenAdjustments.push({
        subjectAddress,
        delta: threat.tokenAdjustment,
        reason: threat.name || threat.code,
        timestamp: new Date().toISOString(),
      });
      break;
    }
    default:
      break;
  }
}

function loadAbi(abiPath) {
  if (!fs.existsSync(abiPath)) {
    throw new Error(`ABI not found at ${abiPath}`);
  }
  const raw = fs.readFileSync(abiPath, "utf8");
  const parsed = JSON.parse(raw);
  return parsed.abi || parsed;
}

function ensureFields(fields, payload) {
  const missing = fields.filter((field) => payload[field] === undefined || payload[field] === null);
  if (missing.length) {
    const err = new Error(`Missing fields: ${missing.join(", ")}`);
    err.status = 400;
    throw err;
  }
}

function createGatewayApp({ roleBased, accessFactory, registerContract, loadAccessContract, judgeContract, roleToken, wallet, provider }) {
  if (!roleBased || !accessFactory || !registerContract || !loadAccessContract || !judgeContract || !roleToken || !wallet || !provider) {
    throw new Error("createGatewayApp requires roleBased, accessFactory, registerContract, loadAccessContract, judgeContract, roleToken, wallet, and provider");
  }

  const threatEngine = new ThreatModel.ThreatEngine({ roleBasedContract: roleBased, judgeContract, provider });
  const gatewayContainment = new Map();

  async function readJudgeState(subjectAddress) {
    const state = await threatEngine.getMemberSecurityState(subjectAddress);
    threatEngine.syncGatewayQuarantine(subjectAddress, state, {
      source: "judge_sync",
      updatedAt: await threatEngine.getChainTimestamp(),
    });
    return state;
  }

  function getContainmentState(subjectAddress) {
    return gatewayContainment.get(normalizeAddress(subjectAddress)) || null;
  }

  async function enforcePermanentContainment({ subjectAddress, accessContract, accessContractAddress, judgeState }) {
    if (!judgeState?.permanentRevoked) {
      return null;
    }

    const key = normalizeAddress(subjectAddress);
    const existing = gatewayContainment.get(key) || {};
    const containment = {
      subjectAddress,
      accessContractAddress,
      permanentRevoked: true,
      deactivated: Boolean(existing.deactivated),
      roleRevoked: Boolean(existing.roleRevoked),
      lastUpdatedAt: new Date().toISOString(),
      deactivateTxHash: existing.deactivateTxHash || null,
      revokeTxHash: existing.revokeTxHash || null,
      deactivateError: existing.deactivateError || null,
      revokeError: existing.revokeError || null,
    };

    if (!containment.deactivated && accessContract) {
      try {
        const { receipt } = await sendTxWithNonceRetry(wallet, (overrides) => accessContract.deactivateContract(overrides));
        containment.deactivated = true;
        containment.deactivateTxHash = receipt.hash;
        containment.deactivateError = null;
        logEvent("gateway_permanent_containment_deactivate", {
          subjectAddress,
          accessContractAddress,
          txHash: receipt.hash,
        });
      } catch (err) {
        const message = err?.shortMessage || err?.reason || err?.message || String(err);
        if (message.includes("Contract is not active")) {
          containment.deactivated = true;
          containment.deactivateError = null;
        } else {
          containment.deactivateError = message;
        }
      }
    }

    if (!containment.roleRevoked) {
      try {
        const currentRole = await roleBased.getRole(subjectAddress);
        if (String(currentRole) === "0") {
          containment.roleRevoked = true;
        } else {
          const { receipt } = await sendTxWithNonceRetry(wallet, (overrides) => roleBased.revokeRole(subjectAddress, overrides));
          containment.roleRevoked = true;
          containment.revokeTxHash = receipt.hash;
          containment.revokeError = null;
          logEvent("gateway_permanent_containment_revoke_role", {
            subjectAddress,
            txHash: receipt.hash,
          });
        }
      } catch (err) {
        const message = err?.shortMessage || err?.reason || err?.message || String(err);
        if (message.includes("Account does not have a role")) {
          containment.roleRevoked = true;
          containment.revokeError = null;
        } else {
          containment.revokeError = message;
        }
      }
    }

    gatewayContainment.set(key, containment);
    return containment;
  }

  const processThreats = async (threats, context = {}) => {
    for (const threat of (threats || [])) {
      if (!threat) continue;
      recordThreatEvent(threat, {
        subjectAddress: context.subjectAddress || context.deviceAddress,
        objectAddress: context.objectAddress || null,
        accType: context.accType || "n/a",
        resource: context.resource || context.operation || "n/a",
        action: context.action || "n/a",
      });
      await handleThreatResponses({
        threat,
        subjectAddress: context.subjectAddress || context.deviceAddress,
        judgeContract,
        wallet,
      });

      if (context.subjectAddress || context.deviceAddress) {
        const postState = await readJudgeState(context.subjectAddress || context.deviceAddress);
        if (postState.permanentRevoked && context.objectAddress && context.accType) {
          const accessContractAddress = await registerContract.getAccessControlContract(
            context.objectAddress,
            context.subjectAddress || context.deviceAddress,
            context.accType
          );
          if (accessContractAddress && accessContractAddress !== ZERO_ADDRESS) {
            const accessContract = await loadAccessContract(accessContractAddress);
            await enforcePermanentContainment({
              subjectAddress: context.subjectAddress || context.deviceAddress,
              accessContract,
              accessContractAddress,
              judgeState: postState,
            });
          }
        }
      }
    }
  };

  const app = express();
  app.use(bodyParser.json({ limit: "256kb" }));

  app.get(METRICS_PATH, async (_req, res) => {
    res.set("Content-Type", registry.contentType);
    res.end(await registry.metrics());
  });

  app.get("/status", async (_req, res) => {
    const accountList = Array.from(stats.accounts || []);
    const balances = [];

    for (const address of accountList) {
      try {
        const raw = await roleToken.balanceOf(address);
        const judgeState = await readJudgeState(address);
        const gatewayState = threatEngine.getGatewayQuarantineState(address, await threatEngine.getChainTimestamp());
        balances.push({
          address,
          balance: ethers.formatUnits(raw, 18),
          judgeState: summarizeJudgeState(judgeState),
          gatewayState,
          containment: getContainmentState(address),
        });
      } catch (err) {
        balances.push({ address, balance: null, error: err.message });
      }
    }

    res.json({
      startedAt: stats.startedAt,
      uptimeSeconds: process.uptime(),
      metricsPath: METRICS_PATH,
      requests: stats.requests,
      transactions: {
        registerDevice: stats.transactions.registerDevice,
        deployContract: stats.transactions.deployContract,
        policyAdd: stats.transactions.policyAdd,
      },
      accessDecisions: stats.accessDecisions,
      lastDeployedContract: stats.lastDeployedContract,
      lastPolicyChange: stats.lastPolicyChange,
      threats: {
        total: stats.threats.total,
        byCode: stats.threats.byCode,
        recentAdjustments: stats.threats.tokenAdjustments.slice(-10),
      },
      gatewayContainment: Array.from(gatewayContainment.values()),
      accountBalances: balances,
      recentEvents: stats.recentEvents,
    });
  });

  app.get("/member-security/:address", async (req, res, next) => {
    try {
      const subjectAddress = req.params.address;
      const member = await roleBased.getMember(subjectAddress).catch(() => null);
      const judgeState = await readJudgeState(subjectAddress);
      const gatewayState = threatEngine.getGatewayQuarantineState(subjectAddress, await threatEngine.getChainTimestamp());
      const rawBalance = await roleToken.balanceOf(subjectAddress).catch(() => null);
      res.json({
        status: "ok",
        subjectAddress,
        role: await threatEngine.getRoleName(subjectAddress),
        member: sanitizeJson(member),
        roleTokenBalance: rawBalance === null ? null : ethers.formatUnits(rawBalance, 18),
        judgeState: summarizeJudgeState(judgeState),
        gatewayState,
        containment: getContainmentState(subjectAddress),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/register-device", async (req, res, next) => {
    const endpoint = "/register-device";
    const stopHttpTimer = httpRequestDuration.startTimer({ endpoint });
    try {
      ensureFields(["deviceAddress", "name", "memberType"], req.body);
      const { deviceAddress, name, memberType } = req.body;

      const existingRole = await threatEngine.getRoleName(deviceAddress);
      const registrationAssessment = await threatEngine.assessRegistration({
        deviceAddress,
        existingRole,
      });
      if (registrationAssessment.findings.length) {
        stats.requests.registerDevice.error += 1;
        httpRequestCounter.inc({ endpoint, status: "409" });
        await processThreats(registrationAssessment.findings, {
          deviceAddress,
          operation: "register_device",
        });
        return res.status(409).json({
          status: "error",
          message: "Device already has a role",
          threats: registrationAssessment.findings,
        });
      }

      const txTimer = blockchainTxDuration.startTimer({ operation: "register_device" });
      const { tx, receipt } = await sendTxWithNonceRetry(
        wallet,
        (overrides) => roleBased.assignRole(deviceAddress, name, memberType, overrides)
      );
      recordTransactionMetrics("register_device", receipt, txTimer);
      policyOperationCounter.inc({ operation: "register_device", contract: ZERO_ADDRESS });

      httpRequestCounter.inc({ endpoint, status: "ok" });
      stats.requests.registerDevice.ok += 1;
      stats.accounts.add(deviceAddress);
      logEvent("register_device_success", {
        deviceAddress,
      });
      logDemo("register_device_success", { deviceAddress, name, memberType, txHash: receipt.hash });

      res.json({
        status: "ok",
        txHash: receipt.hash,
      });
    } catch (err) {
      stats.requests.registerDevice.error += 1;
      httpRequestCounter.inc({ endpoint, status: String(err.status || 500) });
      logEvent("register_device_error", {
        message: err.message,
        stack: err.stack,
      });
      logDemo("register_device_error", {
        message: err.message,
        payload: req.body,
      });
      next(err);
    } finally {
      stopHttpTimer();
    }
  });

  app.post("/deploy-contract", async (req, res, next) => {
    const endpoint = "/deploy-contract";
    const stopHttpTimer = httpRequestDuration.startTimer({ endpoint });
    try {
      ensureFields(["objectAddress", "subjectAddress", "accType"], req.body);
      const { objectAddress, subjectAddress, accType } = req.body;

      // If it already exists, return it instead of reverting.
      const existing = await registerContract.getAccessControlContract(objectAddress, subjectAddress, accType);
      if (existing && existing !== ZERO_ADDRESS) {
        httpRequestCounter.inc({ endpoint, status: "ok" });
        stats.requests.deployContract.ok += 1;
        stats.lastDeployedContract = {
          contractAddress: existing,
          objectAddress,
          subjectAddress,
          accType,
          txHash: null,
          gasUsed: undefined,
          timestamp: new Date().toISOString(),
          note: "exists",
        };
        logEvent("deploy_contract_exists", {
          contractAddress: existing,
          objectAddress,
          subjectAddress,
          accType,
        });
        logDemo("deploy_contract_exists", {
          contractAddress: existing,
          objectAddress,
          subjectAddress,
          accType,
        });
        await grantAccAdminRole(existing);
        return res.json({
          status: "ok",
          contractAddress: existing,
          note: "existing",
        });
      }

      const txTimer = blockchainTxDuration.startTimer({ operation: "deploy_contract" });
      const { tx, receipt } = await sendTxWithNonceRetry(
        wallet,
        (overrides) => accessFactory.deployAccessControlContract(objectAddress, subjectAddress, accType, overrides)
      );
      recordTransactionMetrics("deploy_contract", receipt, txTimer);
      const contractAddress = await registerContract.getAccessControlContract(objectAddress, subjectAddress, accType);

      await grantAccAdminRole(contractAddress);

      httpRequestCounter.inc({ endpoint, status: "ok" });
      stats.requests.deployContract.ok += 1;
      stats.lastDeployedContract = {
        contractAddress,
        objectAddress,
        subjectAddress,
        accType,
        txHash: receipt.hash,
        gasUsed: receipt.gasUsed ? Number(receipt.gasUsed) : undefined,
        timestamp: new Date().toISOString(),
      };
      contractInfoGauge.set(
        {
          contract: contractAddress,
          object: objectAddress,
          subject: subjectAddress,
          accType,
        },
        1
      );
      logEvent("deploy_contract_success", {
        txHash: receipt.hash,
        contractAddress,
        objectAddress,
        subjectAddress,
        accType,
        gasUsed: receipt.gasUsed ? Number(receipt.gasUsed) : undefined,
      });
      logDemo("deploy_contract_success", {
        txHash: receipt.hash,
        contractAddress,
        objectAddress,
        subjectAddress,
        accType,
        gasUsed: receipt.gasUsed ? Number(receipt.gasUsed) : undefined,
      });

      res.json({
        status: "ok",
        txHash: receipt.hash,
        contractAddress,
      });
    } catch (err) {
      stats.requests.deployContract.error += 1;
      httpRequestCounter.inc({ endpoint, status: String(err.status || 500) });
      logEvent("deploy_contract_error", {
        message: err.message,
        stack: err.stack,
        payload: req.body,
      });
      logDemo("deploy_contract_error", {
        message: err.message,
        payload: req.body,
      });
      next(err);
    } finally {
      stopHttpTimer();
    }
  });

  app.post("/policies", async (req, res, next) => {
    const endpoint = "/policies";
    const stopHttpTimer = httpRequestDuration.startTimer({ endpoint });
    try {
      ensureFields(["subjectAddress", "objectAddress", "accType", "resource", "action", "permission"], req.body);
      const { subjectAddress, objectAddress, accType, resource, action, permission } = req.body;

      stats.accounts.add(subjectAddress);
      stats.accounts.add(objectAddress);

      const accessContractAddress = await registerContract.getAccessControlContract(objectAddress, subjectAddress, accType);
      if (!accessContractAddress || accessContractAddress === ZERO_ADDRESS) {
        throw Object.assign(new Error("Access contract not found for subject/object/type"), { status: 404 });
      }

      const accessContract = await loadAccessContract(accessContractAddress);
      const txTimer = blockchainTxDuration.startTimer({ operation: "policy_add" });
      const { tx, receipt } = await sendTxWithNonceRetry(
        wallet,
        (overrides) => accessContract.policyAdd(resource, action, permission, overrides)
      );
      recordTransactionMetrics("policy_add", receipt, txTimer);
      policyOperationCounter.inc({ operation: "add", contract: accessContractAddress });

      httpRequestCounter.inc({ endpoint, status: "ok" });
      stats.requests.policies.ok += 1;
      stats.lastPolicyChange = {
        contractAddress: accessContractAddress,
        resource,
        action,
        permission,
        txHash: receipt.hash,
        gasUsed: receipt.gasUsed ? Number(receipt.gasUsed) : undefined,
        timestamp: new Date().toISOString(),
      };
      logEvent("policy_add_success", {
        contractAddress: accessContractAddress,
        resource,
        action,
        permission,
        txHash: receipt.hash,
        gasUsed: receipt.gasUsed ? Number(receipt.gasUsed) : undefined,
      });
      logDemo("policy_add_success", {
        contractAddress: accessContractAddress,
        resource,
        action,
        permission,
        txHash: receipt.hash,
        gasUsed: receipt.gasUsed ? Number(receipt.gasUsed) : undefined,
      });

      res.json({
        status: "ok",
        txHash: receipt.hash,
      });
    } catch (err) {
      stats.requests.policies.error += 1;
      httpRequestCounter.inc({ endpoint, status: String(err.status || 500) });
      logEvent("policy_add_error", {
        message: err.message,
        stack: err.stack,
        payload: req.body,
      });
      logDemo("policy_add_error", {
        message: err.message,
        payload: req.body,
      });
      next(err);
    } finally {
      stopHttpTimer();
    }
  });

  app.post("/evaluate-access", async (req, res, next) => {
    const endpoint = "/evaluate-access";
    const stopHttpTimer = httpRequestDuration.startTimer({ endpoint });
    try {
      ensureFields(["subjectAddress", "objectAddress", "accType", "resource", "action"], req.body);
      const { subjectAddress, objectAddress, accType, resource, action } = req.body;
      const logOnChain = Boolean(req.body.logOnChain);
      const subjectPrivateKey = req.body.subjectPrivateKey;

      stats.accounts.add(subjectAddress);
      stats.accounts.add(objectAddress);

      const result = await evaluateAccessCore({
        subjectAddress,
        objectAddress,
        accType,
        resource,
        action,
        logOnChain,
        subjectPrivateKey,
      });

      httpRequestCounter.inc({ endpoint, status: "ok" });
      stats.requests.evaluate.ok += 1;
      accessDecisionCounter.inc({ result: result.allowed ? "allow" : "deny" });
      if (result.allowed) {
        stats.accessDecisions.allow += 1;
      } else {
        stats.accessDecisions.deny += 1;
      }

      logEvent("evaluate_access", result.threatPayload);
      logDemo("evaluate_access", {
        subjectAddress,
        objectAddress,
        accType,
        resource,
        action,
        allowed: result.allowed,
        role: result.roleName,
        threats: result.threats,
        txHash: result.txHash || null,
      });

      res.json({
        status: "ok",
        allowed: result.allowed,
        note: logOnChain
          ? "Result reflects a real on-chain subject transaction."
          : "Result is a read-only simulation. Set logOnChain=true to persist the evaluation on-chain.",
        role: result.roleName,
        threats: result.threats,
        payload: result.payload,
        txHash: result.txHash || null,
        receiptStatus: result.receiptStatus,
        denialReason: result.denialReason || null,
        judgeStateBefore: result.judgeStateBefore,
        judgeStateAfter: result.judgeStateAfter,
        gatewayStateBefore: result.gatewayStateBefore,
        gatewayStateAfter: result.gatewayStateAfter,
        containment: result.containment,
        accessContractAddress: result.accessContractAddress,
      });
    } catch (err) {
      stats.requests.evaluate.error += 1;
      httpRequestCounter.inc({ endpoint, status: String(err.status || 500) });
      logEvent("evaluate_access_error", {
        message: err.message,
        stack: err.stack,
        payload: req.body,
      });
      logDemo("evaluate_access_error", {
        message: err.message,
        payload: req.body,
      });
      next(err);
    } finally {
      stopHttpTimer();
    }
  });

  app.post("/esp/evaluate", async (req, res, next) => {
    const endpoint = "/esp/evaluate";
    const stopHttpTimer = httpRequestDuration.startTimer({ endpoint });
    try {
      ensureFields(["deviceAddress", "resource", "action"], req.body);
      const { deviceAddress, resource, action, telemetry } = req.body;
      const objectAddress = req.body.objectAddress || DEFAULT_OBJECT_ADDRESS;
      const accType = req.body.accType || DEFAULT_ACC_TYPE;
      const logOnChain = Boolean(req.body.logOnChain);
      const subjectPrivateKey = req.body.subjectPrivateKey;

      if (!objectAddress) {
        throw Object.assign(new Error("objectAddress required. Set DEFAULT_OBJECT_ADDRESS or include objectAddress in the payload."), { status: 400 });
      }

      stats.accounts.add(deviceAddress);
      stats.accounts.add(objectAddress);

      const result = await evaluateAccessCore({
        subjectAddress: deviceAddress,
        objectAddress,
        accType,
        resource,
        action,
        logOnChain,
        subjectPrivateKey,
      });

      httpRequestCounter.inc({ endpoint, status: "ok" });
      stats.requests.evaluate.ok += 1;
      accessDecisionCounter.inc({ result: result.allowed ? "allow" : "deny" });
      if (result.allowed) {
        stats.accessDecisions.allow += 1;
      } else {
        stats.accessDecisions.deny += 1;
      }

      logEvent("esp_evaluate", {
        ...result.threatPayload,
        telemetryIncluded: Boolean(telemetry),
      });
      logDemo("esp_evaluate", {
        deviceAddress,
        objectAddress,
        accType,
        resource,
        action,
        allowed: result.allowed,
        role: result.roleName,
        threats: result.threats,
        telemetry: telemetry || null,
        txHash: result.txHash || null,
      });

      if (telemetry) {
        writeEspTelemetry({
          subjectAddress: deviceAddress,
          objectAddress,
          accType,
          resource,
          action,
          telemetry,
          allowed: result.allowed,
          threats: result.threats,
        });
      }

      res.json({
        status: "ok",
        allowed: result.allowed,
        role: result.roleName,
        threats: result.threats,
        payload: result.payload,
        objectAddress,
        accType,
        txHash: result.txHash || null,
        receiptStatus: result.receiptStatus,
        denialReason: result.denialReason || null,
        judgeStateBefore: result.judgeStateBefore,
        judgeStateAfter: result.judgeStateAfter,
        gatewayStateBefore: result.gatewayStateBefore,
        gatewayStateAfter: result.gatewayStateAfter,
        containment: result.containment,
        accessContractAddress: result.accessContractAddress,
        note: "ESP bridge evaluation (PGH forwarded to on-chain access control).",
      });
    } catch (err) {
      stats.requests.evaluate.error += 1;
      httpRequestCounter.inc({ endpoint, status: String(err.status || 500) });
      logEvent("esp_evaluate_error", {
        message: err.message,
        stack: err.stack,
        payload: req.body,
      });
      logDemo("esp_evaluate_error", {
        message: err.message,
        payload: req.body,
      });
      next(err);
    } finally {
      stopHttpTimer();
    }
  });

  app.use((err, req, res, _next) => {
    const status = err.status || 500;
    res.status(status).json({
      status: "error",
      message: err.message || "Internal server error",
    });
  });

  async function grantAccAdminRole(contractAddress) {
    if (!contractAddress || contractAddress === ZERO_ADDRESS) {
      return;
    }

    try {
      const { tx, receipt } = await sendTxWithNonceRetry(
        wallet,
        (overrides) => roleToken.assignAdminRole(wallet.address, contractAddress, overrides)
      );
      logEvent("acc_admin_granted", {
        contractAddress,
        txHash: receipt.hash,
      });
    } catch (err) {
      const message = err?.message || err?.reason || "";
      if (message.includes("Member already has a role")) {
        logEvent("acc_admin_grant_skipped", {
          contractAddress,
          reason: "already has role",
        });
        return;
      }
      logEvent("acc_admin_grant_error", {
        contractAddress,
        message,
      });
      throw err;
    }
  }

  async function evaluateAccessCore({ subjectAddress, objectAddress, accType, resource, action, logOnChain = false, subjectPrivateKey }) {
    const accessContractAddress = await registerContract.getAccessControlContract(objectAddress, subjectAddress, accType);
    if (!accessContractAddress || accessContractAddress === ZERO_ADDRESS) {
      throw Object.assign(new Error("Access contract not found for subject/object/type"), { status: 404 });
    }

    const accessContract = await loadAccessContract(accessContractAddress);
    const preJudgeState = await readJudgeState(subjectAddress);
    const gatewayStateBefore = threatEngine.getGatewayQuarantineState(
      subjectAddress,
      await threatEngine.getChainTimestamp()
    );
    let txHash = null;
    let allowed;
    let receipt = null;
    let onChainRevert = null;

    if (logOnChain) {
      if (!subjectPrivateKey) {
        throw Object.assign(new Error("subjectPrivateKey required when logOnChain is true"), { status: 400 });
      }
      const subjectWallet = new ethers.Wallet(subjectPrivateKey, provider);
      if (subjectWallet.address.toLowerCase() !== subjectAddress.toLowerCase()) {
        throw Object.assign(new Error("subjectPrivateKey does not match subjectAddress"), { status: 400 });
      }
      try {
        // Static call keeps the happy-path outcome precise while still allowing
        // the real transaction to be submitted for reverted threat-path traces.
        allowed = await accessContract.connect(subjectWallet).accessControl.staticCall(resource, action);
      } catch (err) {
        allowed = false;
        onChainRevert = err;
      }

      const sent = await sendTxAllowRevert(
        subjectWallet,
        (overrides) => accessContract.connect(subjectWallet).accessControl(resource, action, {
          gasLimit: ACCESS_EVAL_FALLBACK_GAS_LIMIT,
          ...overrides,
        })
      );
      receipt = sent.receipt || null;
      txHash = sent.tx?.hash || sent.receipt?.hash || null;
      if (sent.error && !onChainRevert) {
        onChainRevert = sent.error;
      }

      if (receipt?.status === 0) {
        allowed = false;
      } else if (receipt) {
        // Try to derive allowed from the event if present
        try {
          const iface = accessContract.interface;
          for (const log of receipt.logs) {
            try {
              const parsed = iface.parseLog(log);
              if (parsed.name === "AccessControlChecked") {
                allowed = parsed.args[3];
                break;
              }
            } catch (_e) {
              // ignore parse errors
            }
          }
        } catch (_err) {
          // best effort
        }
      }
    } else {
      const data = accessContract.interface.encodeFunctionData("accessControl", [resource, action]);
      const response = await provider.call({
        to: accessContractAddress,
        from: subjectAddress,
        data,
      });
      [allowed] = accessContract.interface.decodeFunctionResult("accessControl", response);
    }

    const postJudgeState = await readJudgeState(subjectAddress);
    const assessment = await threatEngine.assessRequest({
      subjectAddress,
      objectAddress,
      accType,
      resource,
      action,
      allowedByBlockchain: allowed,
      preJudgeState,
      postJudgeState,
      denialReason: onChainRevert?.shortMessage || onChainRevert?.reason || onChainRevert?.message || null,
    });
    const gatewayStateAfter = threatEngine.getGatewayQuarantineState(
      subjectAddress,
      await threatEngine.getChainTimestamp()
    );
    let containment = null;

    if (postJudgeState?.permanentRevoked) {
      containment = await enforcePermanentContainment({
        subjectAddress,
        accessContract,
        accessContractAddress,
        judgeState: postJudgeState,
      });
    }

    if (!logOnChain) {
      await processThreats(assessment.findings, { subjectAddress, objectAddress, accType, resource, action });
    }

    let denialReason = onChainRevert?.shortMessage || onChainRevert?.reason || onChainRevert?.message || null;
    if (!allowed) {
      if (postJudgeState?.permanentRevoked || containment?.permanentRevoked) {
        denialReason = "PERMANENTLY_REVOKED";
      } else if (postJudgeState?.temporarilyQuarantined || gatewayStateAfter?.quarantineUntil) {
        denialReason = "TEMPORARILY_QUARANTINED";
      } else if (assessment.findings.some((threat) => threat?.code === "DISRUPTION_OF_SERVICE")) {
        denialReason = "DISRUPTION_OF_SERVICE";
      } else if (assessment.findings.some((threat) => threat?.code === "TOO_MANY_ACCESS_ATTEMPTS")) {
        denialReason = "TOO_MANY_ACCESS_ATTEMPTS";
      } else if (assessment.findings.some((threat) => threat?.code === "UNAUTHORIZED_ACCESS")) {
        denialReason = "UNAUTHORIZED_ACCESS";
      } else if (!denialReason) {
        denialReason = "ACCESS_DENIED";
      }
    }

    return {
      allowed,
      payload: allowed ? getResourcePayload(resource, action) : null,
      roleName: assessment.roleName,
      threats: assessment.findings,
      threatPayload: {
        subjectAddress,
        objectAddress,
        accType,
        resource,
        action,
        allowed,
        role: assessment.roleName,
        threats: assessment.findings,
        payloadDelivered: allowed,
        judgeStateBefore: summarizeJudgeState(preJudgeState),
        judgeStateAfter: summarizeJudgeState(postJudgeState),
        gatewayStateBefore,
        gatewayStateAfter,
        containment,
      },
      txHash,
      receiptStatus: receipt?.status ?? null,
      denialReason,
      judgeStateBefore: summarizeJudgeState(preJudgeState),
      judgeStateAfter: summarizeJudgeState(postJudgeState),
      gatewayStateBefore,
      gatewayStateAfter,
      containment,
      accessContractAddress,
    };
  }

  function writeEspTelemetry({ subjectAddress, objectAddress, accType, resource, action, telemetry, allowed, threats }) {
    const body = {
      timestamp: new Date().toISOString(),
      subjectAddress,
      objectAddress,
      accType,
      resource,
      action,
      allowed,
      threats,
      telemetry,
    };
    const suffix = subjectAddress ? subjectAddress.slice(-6) : "esp";
    const file = path.join(ESP_TELEMETRY_DIR, `${Date.now()}-${suffix}.json`);
    fs.writeFileSync(file, JSON.stringify(body, null, 2), "utf8");
  }

  function logDemo(event, data) {
    try {
      const file = path.join(DEMO_LOG_DIR, `${Date.now()}-${event}.json`);
      const body = {
        timestamp: new Date().toISOString(),
        event,
        data,
      };
      fs.writeFileSync(file, JSON.stringify(body, null, 2), "utf8");
    } catch (_err) {
      // best-effort
    }
  }

  return app;
}

function ensureWalletInGanacheKeys(walletAddress) {
  const defaultPath = path.join(__dirname, "..", "..", "tmp", "ganache-keys.json");
  const keysPath = process.env.GANACHE_KEYS_PATH || defaultPath;

  if (!fs.existsSync(keysPath)) {
    return;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(keysPath, "utf8"));
    const entries = Object.keys(raw.private_keys || {}).map((addr) => addr.toLowerCase());
    if (!entries.includes(walletAddress.toLowerCase())) {
      throw new Error(
        `Wallet ${walletAddress} not found in ${keysPath}. Ganache was likely restarted. Rerun npm run bootstrap or update PRIMARY_HEAD_KEY.`
      );
    }
  } catch (err) {
    throw new Error(`Failed to validate PRIMARY_HEAD_KEY against ${keysPath}: ${err.message || err}`);
  }
}

function buildGatewayFromEnv() {
  const PORT = process.env.PORT || 8080;
  const RPC_URL = process.env.RPC_URL;
  const PRIVATE_KEY = process.env.PRIMARY_HEAD_KEY;
  const ROLE_BASED_CONTRACT = process.env.ROLE_BASED_ADDRESS;
  const ACCESS_CONTROL_FACTORY = process.env.ACCESS_FACTORY_ADDRESS;
  const REGISTER_CONTRACT = process.env.REGISTER_ADDRESS;
  const JUDGE_CONTRACT = process.env.JUDGE_ADDRESS;
  const ROLE_TOKEN_CONTRACT = process.env.ROLE_TOKEN_ADDRESS;
  const ACCESS_CONTROL_ABI_PATH = process.env.ACCESS_CONTROL_ABI || path.join(__dirname, "../abis/AccessControlContract.json");
  const ROLE_BASED_ABI_PATH = process.env.ROLE_BASED_ABI || path.join(__dirname, "../abis/RoleBasedAccessControl.json");
  const FACTORY_ABI_PATH = process.env.FACTORY_ABI || path.join(__dirname, "../abis/AccessControlFactory.json");
  const REGISTER_ABI_PATH = process.env.REGISTER_ABI || path.join(__dirname, "../abis/RegisterContract.json");
  const JUDGE_ABI_PATH = process.env.JUDGE_ABI || path.join(__dirname, "../abis/JudgeContract.json");
  const ROLE_TOKEN_ABI_PATH = process.env.ROLE_TOKEN_ABI || path.join(__dirname, "../abis/RoleToken.json");

  if (!RPC_URL || !PRIVATE_KEY || !ROLE_BASED_CONTRACT || !ACCESS_CONTROL_FACTORY || !REGISTER_CONTRACT || !JUDGE_CONTRACT || !ROLE_TOKEN_CONTRACT) {
    throw new Error("Missing required environment variables. Check RPC_URL, PRIMARY_HEAD_KEY, ROLE_BASED_ADDRESS, ACCESS_FACTORY_ADDRESS, REGISTER_ADDRESS, JUDGE_ADDRESS, ROLE_TOKEN_ADDRESS.");
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  ensureWalletInGanacheKeys(wallet.address);

  const accessControlAbi = loadAbi(ACCESS_CONTROL_ABI_PATH);
  const roleBasedAbi = loadAbi(ROLE_BASED_ABI_PATH);
  const factoryAbi = loadAbi(FACTORY_ABI_PATH);
  const registerAbi = loadAbi(REGISTER_ABI_PATH);
  const judgeAbi = loadAbi(JUDGE_ABI_PATH);
  const roleTokenAbi = loadAbi(ROLE_TOKEN_ABI_PATH);

  const roleBased = new ethers.Contract(ROLE_BASED_CONTRACT, roleBasedAbi, wallet);
  const accessFactory = new ethers.Contract(ACCESS_CONTROL_FACTORY, factoryAbi, wallet);
  const registerContract = new ethers.Contract(REGISTER_CONTRACT, registerAbi, wallet);
  const judgeContract = new ethers.Contract(JUDGE_CONTRACT, judgeAbi, wallet);
  const roleToken = new ethers.Contract(ROLE_TOKEN_CONTRACT, roleTokenAbi, wallet);

  const loadAccessContract = async (address) => new ethers.Contract(address, accessControlAbi, wallet);

  return {
    provider,
    wallet,
    roleBased,
    accessFactory,
    registerContract,
    loadAccessContract,
    judgeContract,
    roleToken,
    port: PORT,
  };
}

if (require.main === module) {
  try {
    const { provider, roleBased, accessFactory, registerContract, loadAccessContract, judgeContract, roleToken, wallet, port } = buildGatewayFromEnv();
    const app = createGatewayApp({ roleBased, accessFactory, registerContract, loadAccessContract, judgeContract, roleToken, wallet, provider });
    app.listen(port, () => {
      logEvent("primary_group_head_start", { port });
    });
  } catch (err) {
    console.error(err.stack || err.message || err);
    process.exit(1);
  }
}

module.exports = {
  createGatewayApp,
  loadAbi,
  buildGatewayFromEnv,
  ZERO_ADDRESS,
};
