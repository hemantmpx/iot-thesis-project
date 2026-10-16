#!/usr/bin/env node
/**
 * Cross-PGH attack simulation (A -> B) with verbose reporting.
 *
 * What it does:
 * - Verifies PGH-A and PGH-B readiness (/status + /metrics)
 * - Picks fresh Role.NONE addresses (objectA, attacker1, attacker2, objectB)
 * - Registers object + attackers on PGH-A (baseline/home PGH)
 * - Registers object + attackers on PGH-B (target PGH)
 * - Deploys ACC on PGH-A for baseline access
 * - Deploys ACCs on PGH-B for each attacker
 * - Adds policies:
 *   - attacker1: allow view, deny edit (baseline + tamper)
 *   - attacker2: deny view (brute-force / too-many-attempts)
 * - Executes:
 *   - PGH-A: attacker1 view (allowed, baseline)
 *   - PGH-B: attacker1 view (allowed, reward)
 *   - PGH-B: attacker1 edit (denied, tamper -> judge penalty)
 *   - PGH-B: attacker2 view repeated (unauthorized + too-many-attempts)
 * - Writes a verbose JSON report + Markdown summary
 *
 * Env:
 *   RPC_URL                (required)
 *   PGH_A_BASE             (default http://127.0.0.1:8080)
 *   PGH_B_BASE             (default http://127.0.0.1:8081)
 *   ATTACK_ATTEMPTS        (default 6)
 *   LOG_ON_CHAIN           (default 1)
 *   VERBOSE                (default 1)
 *
 * Args:
 *   --check-only           (preflight only, no mutations)
 *   --attempts <n>         (override ATTACK_ATTEMPTS)
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("../node_modules/ethers");
require("../node_modules/dotenv").config({ path: path.join(__dirname, "..", ".env") });

const ROOT = path.join(__dirname, "..", "..", "..");
const RESULTS_DIR = path.join(__dirname, "..", "results");
const DEMO_DIR = path.join(__dirname, "..", "results", "demo-telemetry");

const argv = process.argv.slice(2);
const argValue = (flag) => {
  const idx = argv.indexOf(flag);
  return idx !== -1 ? argv[idx + 1] : null;
};

const CHECK_ONLY = argv.includes("--check-only") || process.env.CHECK_ONLY === "1";
const ATTACK_ATTEMPTS = parseInt(argValue("--attempts") || process.env.ATTACK_ATTEMPTS || "6", 10);
const LOG_ON_CHAIN = (argValue("--log-on-chain") || process.env.LOG_ON_CHAIN || "1") !== "0";
const VERBOSE = (argValue("--verbose") || process.env.VERBOSE || "1") !== "0";

const PGH_A = process.env.PGH_A_BASE || "http://127.0.0.1:8080";
const PGH_B = process.env.PGH_B_BASE || "http://127.0.0.1:8081";
const METRICS_A_URL = process.env.METRICS_A_URL || `${PGH_A}/metrics`;
const METRICS_B_URL = process.env.METRICS_B_URL || `${PGH_B}/metrics`;
const RPC_URL = process.env.RPC_URL;

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = path.join(RESULTS_DIR, `run-cross-pgh-attack-${timestamp}`);
fs.mkdirSync(RUN_DIR, { recursive: true });
const reportPath = path.join(RUN_DIR, "report.json");
const summaryPath = path.join(RUN_DIR, "summary.md");

function ensureFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${label || "file"}: ${filePath}`);
  }
}

function redactPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const cloned = JSON.parse(JSON.stringify(payload));
  if (cloned.subjectPrivateKey) {
    cloned.subjectPrivateKey = "***redacted***";
  }
  return cloned;
}

function cleanValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(cleanValue);
  if (value && typeof value === "object") {
    if (typeof value.toString === "function" && value.toString !== Object.prototype.toString) {
      try {
        return value.toString();
      } catch (_e) {
        // fallthrough
      }
    }
  }
  return value;
}

function parseMetrics(text) {
  const prefixes = [
    "primary_group_head_token_adjustments_total",
    "primary_group_head_threat_events_total",
    "primary_group_head_http_requests_total",
    "primary_group_head_tx_duration_seconds_count",
    "primary_group_head_tx_duration_seconds_sum",
    "primary_group_head_tx_gas_used_count",
    "primary_group_head_tx_gas_used_sum",
    "primary_group_head_access_decisions_total",
    "primary_group_head_policy_operations_total",
  ];
  return text
    .split(/\r?\n/)
    .filter((line) => prefixes.some((p) => line.startsWith(p)));
}

async function fetchJson(url) {
  let res;
  try {
    res = await fetchWithTimeout(url, {}, 5000);
  } catch (err) {
    throw new Error(`Failed to reach ${url}: ${err.message || err}`);
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function withTimeout(promise, timeoutMs, label) {
  let timeout;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label || "Operation"} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timer]);
  } finally {
    clearTimeout(timeout);
  }
}

async function writeMetrics(url, tag, runDir) {
  const outPath = path.join(runDir, `metrics-${tag}-${timestamp}.txt`);
  try {
    const res = await fetchWithTimeout(url, {}, 5000);
    const text = await res.text();
    fs.writeFileSync(outPath, text, "utf8");
    return { path: outPath, summary: parseMetrics(text) };
  } catch (err) {
    fs.writeFileSync(outPath, `metrics unavailable: ${err.message || err}`, "utf8");
    return { path: outPath, summary: [] };
  }
}

async function describeTx(provider, txHash, labelForAddress, interfaces) {
  if (!txHash) return null;
  const [tx, receipt] = await Promise.all([
    provider.getTransaction(txHash),
    provider.getTransactionReceipt(txHash),
  ]);
  if (!receipt) return null;

  const gasUsed = receipt.gasUsed ?? null;
  const gasPrice = receipt.effectiveGasPrice ?? null;
  const gasCostWei = gasUsed && gasPrice ? gasUsed * gasPrice : null;

  const events = [];
  for (const log of receipt.logs || []) {
    let parsed = null;
    for (const iface of interfaces) {
      try {
        parsed = iface.parseLog(log);
        if (parsed) break;
      } catch (_e) {
        // ignore
      }
    }
    if (parsed) {
      const args = {};
      parsed.eventFragment.inputs.forEach((input, idx) => {
        const key = input.name || `arg${idx}`;
        args[key] = cleanValue(parsed.args[idx]);
      });
      events.push({
        address: log.address,
        contractLabel: labelForAddress(log.address),
        event: parsed.name,
        args,
      });
    }
  }

  return {
    hash: txHash,
    from: tx?.from || null,
    to: tx?.to || null,
    toLabel: tx?.to ? labelForAddress(tx.to) : null,
    blockNumber: receipt.blockNumber,
    status: receipt.status,
    gasUsed: gasUsed ? gasUsed.toString() : null,
    effectiveGasPrice: gasPrice ? gasPrice.toString() : null,
    gasCostWei: gasCostWei ? gasCostWei.toString() : null,
    gasCostEth: gasCostWei ? ethers.formatEther(gasCostWei) : null,
    events,
  };
}

async function postJson(base, pathname, payload) {
  const res = await fetchWithTimeout(`${base}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }, 20000);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
}

async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const report = {
    meta: {
      timestamp: new Date().toISOString(),
      script: path.relative(ROOT, __filename),
      rpcUrl: RPC_URL || null,
      pghA: PGH_A,
      pghB: PGH_B,
      attempts: ATTACK_ATTEMPTS,
      logOnChain: LOG_ON_CHAIN,
      checkOnly: CHECK_ONLY,
    },
    readiness: {},
    addresses: {},
    contracts: {},
    steps: [],
    evaluations: [],
    tokenHistory: {},
    metricsSnapshots: {},
    demoLogs: {},
    errors: [],
    notes: [],
  };

  try {
    if (!RPC_URL) {
      throw new Error("RPC_URL is not set in iot/pi/.env");
    }

    const deployedPath = path.join(ROOT, "tmp", "deployed-addresses.json");
    const keysPath = path.join(ROOT, "tmp", "ganache-keys.json");
    const roleTokenAbiPath = path.join(ROOT, "iot", "abis", "RoleToken.json");
    const accessAbiPath = path.join(ROOT, "iot", "abis", "AccessControlContract.json");
    const factoryAbiPath = path.join(ROOT, "iot", "abis", "AccessControlFactory.json");
    const registerAbiPath = path.join(ROOT, "iot", "abis", "RegisterContract.json");
    const judgeAbiPath = path.join(ROOT, "iot", "abis", "JudgeContract.json");

    ensureFile(deployedPath, "deployed-addresses.json");
    ensureFile(keysPath, "ganache-keys.json");
    ensureFile(roleTokenAbiPath, "RoleToken ABI");
    ensureFile(accessAbiPath, "AccessControlContract ABI");
    ensureFile(factoryAbiPath, "AccessControlFactory ABI");
    ensureFile(registerAbiPath, "RegisterContract ABI");
    ensureFile(judgeAbiPath, "JudgeContract ABI");

    const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8")).addresses || {};
    const keysRaw = JSON.parse(fs.readFileSync(keysPath, "utf8"));
    const privateKeys = keysRaw.private_keys || {};

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const roleTokenAbi = require(roleTokenAbiPath).abi;
    const accessAbi = require(accessAbiPath).abi;
    const factoryAbi = require(factoryAbiPath).abi;
    const registerAbi = require(registerAbiPath).abi;
    const judgeAbi = require(judgeAbiPath).abi;

    const roleToken = new ethers.Contract(deployed.roleToken, roleTokenAbi, provider);
    const judge = new ethers.Contract(deployed.judgeContract, judgeAbi, provider);

    const labelMap = new Map();
    const addLabel = (addr, label) => {
      if (!addr) return;
      labelMap.set(addr.toLowerCase(), label);
    };
    addLabel(deployed.roleToken, "RoleToken");
    addLabel(deployed.roleBasedAccessControl, "RoleBasedAccessControl");
    addLabel(deployed.accessControlFactory, "AccessControlFactory");
    addLabel(deployed.registerContract, "RegisterContract");
    addLabel(deployed.judgeContract, "JudgeContract");

    const labelForAddress = (addr) => {
      if (!addr) return null;
      return labelMap.get(addr.toLowerCase()) || "UnknownContract";
    };

    report.contracts = {
      roleToken: deployed.roleToken,
      roleBasedAccessControl: deployed.roleBasedAccessControl,
      accessControlFactory: deployed.accessControlFactory,
      registerContract: deployed.registerContract,
      judgeContract: deployed.judgeContract,
    };

    // Preflight: PGH readiness + RPC
    const chainBlock = await withTimeout(provider.getBlockNumber(), 5000, "RPC getBlockNumber");
    report.readiness.chain = { blockNumber: chainBlock };

    const statusA = await fetchJson(`${PGH_A}/status`);
    if (!statusA.ok) {
      throw new Error(`PGH-A not ready at ${PGH_A} (status ${statusA.status})`);
    }
    const statusB = await fetchJson(`${PGH_B}/status`);
    if (!statusB.ok) {
      throw new Error(`PGH-B not ready at ${PGH_B} (status ${statusB.status})`);
    }
    report.readiness.pghA = statusA.body;
    report.readiness.pghB = statusB.body;
    report.statusSnapshots = {
      before: {
        pghA: statusA.body,
        pghB: statusB.body,
      },
    };

    const metricsA = await writeMetrics(METRICS_A_URL, "cross-pgh-attack-A-pre", RUN_DIR);
    const metricsB = await writeMetrics(METRICS_B_URL, "cross-pgh-attack-B-pre", RUN_DIR);
    report.metricsSnapshots.pre = {
      pghA: metricsA,
      pghB: metricsB,
    };

    const demoBefore = fs.existsSync(DEMO_DIR) ? new Set(fs.readdirSync(DEMO_DIR)) : new Set();

    if (CHECK_ONLY) {
      report.notes.push("CHECK_ONLY enabled: preflight complete, no on-chain actions executed.");
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
      return;
    }

    // Identify admin wallet (RoleToken owner)
    const owner = await roleToken.owner();
    const adminPk = privateKeys[owner.toLowerCase()];
    if (!adminPk) {
      throw new Error(`Admin key not found for RoleToken owner ${owner}`);
    }
    const adminWallet = new ethers.Wallet(adminPk, provider);
    report.addresses.adminOwner = owner;

    // Pick Role.NONE addresses (objectA, attacker1, attacker2, objectB)
    async function roleOf(addr) {
      try {
        const role = await roleToken.getRole(addr);
        return role.toString();
      } catch (_e) {
        return null;
      }
    }

    async function ensureNone(addr) {
      const role = await roleOf(addr);
      if (role && role !== "0" && role !== "1") {
        const roleTokenAdmin = new ethers.Contract(deployed.roleToken, roleTokenAbi, adminWallet);
        const tx = await roleTokenAdmin.revokeRole(addr);
        const receipt = await tx.wait();
        const txInfo = await describeTx(provider, receipt.hash, labelForAddress, [
          new ethers.Interface(roleTokenAbi),
        ]);
        report.steps.push({
          label: "revoke-role",
          pgh: "admin",
          endpoint: "RoleToken.revokeRole",
          payload: { address: addr },
          status: 200,
          response: { txHash: receipt.hash },
          tx: txInfo,
        });
      }
    }

    const exclude = new Set([owner.toLowerCase()]);
    const candidates = Object.keys(privateKeys);
    const picks = [];

    for (const addr of candidates) {
      if (exclude.has(addr.toLowerCase())) continue;
      const role = await roleOf(addr);
      if (role === "0") picks.push(addr);
      if (picks.length >= 3) break;
    }

    if (picks.length < 4) {
      for (const addr of candidates) {
        if (exclude.has(addr.toLowerCase())) continue;
        const role = await roleOf(addr);
        if (role && role !== "0" && role !== "1") {
          await ensureNone(addr);
          if ((await roleOf(addr)) === "0") picks.push(addr);
          if (picks.length >= 3) break;
        }
      }
    }

      if (picks.length < 4) {
        throw new Error("Not enough Role.NONE addresses to run attack scenario");
      }

    const [objectA, attacker1, attacker2, objectB] = picks;
    report.addresses = {
      ...report.addresses,
      objectA,
      objectB,
      attacker1,
      attacker2,
    };

    const attacker1Pk = privateKeys[attacker1.toLowerCase()];
    const attacker2Pk = privateKeys[attacker2.toLowerCase()];

    // Pre-attack token + judge status
    async function snapshotBalances() {
      const entries = {};
      for (const addr of [objectA, objectB, attacker1, attacker2]) {
        try {
          const raw = await roleToken.balanceOf(addr);
          entries[addr] = {
            raw: raw.toString(),
            formatted: ethers.formatUnits(raw, 18),
          };
        } catch (err) {
          entries[addr] = { error: err.message || String(err) };
        }
      }
      return entries;
    }

    async function snapshotJudge(addr) {
      try {
        const history = await judge.misbehaviorHistory(addr);
        const blockingEndTime = await judge.getBlockingEndTime(addr);
        return {
          lastPenaltyTime: history?.[0]?.toString?.() || null,
          blockingEndTime: history?.[1]?.toString?.() || null,
          blockingEndTimeDirect: blockingEndTime?.toString?.() || null,
        };
      } catch (err) {
        return { error: err.message || String(err) };
      }
    }

    report.tokenHistory.before = await snapshotBalances();
    report.tokenHistory.judgeBefore = {
      [attacker1]: await snapshotJudge(attacker1),
      [attacker2]: await snapshotJudge(attacker2),
    };

    const interfaces = [
      new ethers.Interface(accessAbi),
      new ethers.Interface(factoryAbi),
      new ethers.Interface(registerAbi),
      new ethers.Interface(roleTokenAbi),
      new ethers.Interface(judgeAbi),
    ];

    async function callAndRecord(label, base, endpoint, payload, expectedContract) {
      const startedAt = Date.now();
      const res = await postJson(base, endpoint, payload);
      const durationMs = Date.now() - startedAt;
      const txHash =
        res.body?.txHash ||
        res.body?.tx_hash ||
        res.body?.txhash ||
        res.body?.transactionHash ||
        res.body?.deployTxHash ||
        null;

      const step = {
        label,
        pgh: base === PGH_A ? "PGH-A" : "PGH-B",
        endpoint,
        durationMs,
        expectedContract,
        payload: redactPayload(payload),
        status: res.status,
        response: res.body,
      };

      if (txHash) {
        step.tx = await describeTx(provider, txHash, labelForAddress, interfaces);
      }

      report.steps.push(step);
      return { res, step };
    }

    // Register object + attackers on PGH-A (home PGH)
    await callAndRecord(
      "register-objectA",
      PGH_A,
      "/register-device",
      { deviceAddress: objectA, name: "objectA", memberType: "type1" },
      deployed.roleBasedAccessControl
    );
    await callAndRecord(
      "register-attacker1-A",
      PGH_A,
      "/register-device",
      { deviceAddress: attacker1, name: "attacker1", memberType: "type1" },
      deployed.roleBasedAccessControl
    );
    await callAndRecord(
      "register-attacker2-A",
      PGH_A,
      "/register-device",
      { deviceAddress: attacker2, name: "attacker2", memberType: "type1" },
      deployed.roleBasedAccessControl
    );

    // Baseline ACC on PGH-A (normal access before the attack)
    const depA = await callAndRecord(
      "deploy-acc-baseline-A",
      PGH_A,
      "/deploy-contract",
      { objectAddress: objectA, subjectAddress: attacker1, accType: "sensor" },
      deployed.accessControlFactory
    );
    const accA = depA.res.body?.contractAddress || depA.res.body?.contract_address || null;
    if (accA) addLabel(accA, "ACC-objectA-attacker1");
    await callAndRecord(
      "policy-allow-view-A",
      PGH_A,
      "/policies",
      {
        objectAddress: objectA,
        subjectAddress: attacker1,
        accType: "sensor",
        resource: "sensor/temp",
        action: "view",
        permission: "allow",
      },
      accA
    );
    const baseline = await callAndRecord(
      "baseline-view-A",
      PGH_A,
      "/evaluate-access",
      {
        subjectAddress: attacker1,
        objectAddress: objectA,
        accType: "sensor",
        resource: "sensor/temp",
        action: "view",
        logOnChain: LOG_ON_CHAIN,
        subjectPrivateKey: attacker1Pk,
      },
      accA
    );
    report.evaluations.push({
      label: "baseline-view-A",
      subject: attacker1,
      object: objectA,
      response: baseline.res.body,
    });

    // Register object + attackers on PGH-B (target PGH)
    await callAndRecord(
      "register-objectB",
      PGH_B,
      "/register-device",
      { deviceAddress: objectB, name: "objectB", memberType: "type1" },
      deployed.roleBasedAccessControl
    );
    await callAndRecord(
      "register-attacker1-B",
      PGH_B,
      "/register-device",
      { deviceAddress: attacker1, name: "attacker1", memberType: "type1" },
      deployed.roleBasedAccessControl
    );
    await callAndRecord(
      "register-attacker2-B",
      PGH_B,
      "/register-device",
      { deviceAddress: attacker2, name: "attacker2", memberType: "type1" },
      deployed.roleBasedAccessControl
    );

    // Deploy ACCs
    const dep1 = await callAndRecord(
      "deploy-acc-attacker1",
      PGH_B,
      "/deploy-contract",
      { objectAddress: objectB, subjectAddress: attacker1, accType: "sensor" },
      deployed.accessControlFactory
    );
    const acc1 =
      dep1.res.body?.contractAddress || dep1.res.body?.contract_address || null;
    if (acc1) addLabel(acc1, "ACC-objectB-attacker1");

    const dep2 = await callAndRecord(
      "deploy-acc-attacker2",
      PGH_B,
      "/deploy-contract",
      { objectAddress: objectB, subjectAddress: attacker2, accType: "sensor" },
      deployed.accessControlFactory
    );
    const acc2 =
      dep2.res.body?.contractAddress || dep2.res.body?.contract_address || null;
    if (acc2) addLabel(acc2, "ACC-objectB-attacker2");

    report.contracts = {
      ...report.contracts,
      accBaselineA: accA,
      accAttacker1: acc1,
      accAttacker2: acc2,
    };

    // Policies for attacker1 (allow view, deny edit)
    await callAndRecord(
      "policy-allow-view-attacker1",
      PGH_B,
      "/policies",
      {
        objectAddress: objectB,
        subjectAddress: attacker1,
        accType: "sensor",
        resource: "sensor/temp",
        action: "view",
        permission: "allow",
      },
      acc1
    );
    await callAndRecord(
      "policy-deny-edit-attacker1",
      PGH_B,
      "/policies",
      {
        objectAddress: objectB,
        subjectAddress: attacker1,
        accType: "sensor",
        resource: "sensor/temp",
        action: "edit",
        permission: "deny",
      },
      acc1
    );

    // Policies for attacker2 (deny view)
    await callAndRecord(
      "policy-deny-view-attacker2",
      PGH_B,
      "/policies",
      {
        objectAddress: objectB,
        subjectAddress: attacker2,
        accType: "sensor",
        resource: "sensor/temp",
        action: "view",
        permission: "deny",
      },
      acc2
    );

    // Baseline: allowed view (attacker1)
    const view1 = await callAndRecord(
      "attack-baseline-view",
      PGH_B,
      "/evaluate-access",
      {
        subjectAddress: attacker1,
        objectAddress: objectB,
        accType: "sensor",
        resource: "sensor/temp",
        action: "view",
        logOnChain: LOG_ON_CHAIN,
        subjectPrivateKey: attacker1Pk,
      },
      acc1
    );
    report.evaluations.push({
      label: "baseline-view",
      subject: attacker1,
      object: objectB,
      response: view1.res.body,
    });

    // Attack: tamper edit (attacker1)
    const edit1 = await callAndRecord(
      "attack-edit-tamper",
      PGH_B,
      "/evaluate-access",
      {
        subjectAddress: attacker1,
        objectAddress: objectB,
        accType: "sensor",
        resource: "sensor/temp",
        action: "edit",
        logOnChain: LOG_ON_CHAIN,
        subjectPrivateKey: attacker1Pk,
      },
      acc1
    );
    report.evaluations.push({
      label: "edit-tamper",
      subject: attacker1,
      object: objectB,
      response: edit1.res.body,
    });

    // Attack: brute-force (attacker2)
    for (let i = 1; i <= ATTACK_ATTEMPTS; i += 1) {
      const attempt = await callAndRecord(
        `attack-bruteforce-${i}`,
        PGH_B,
        "/evaluate-access",
        {
          subjectAddress: attacker2,
          objectAddress: objectB,
          accType: "sensor",
          resource: "sensor/temp",
          action: "view",
          logOnChain: LOG_ON_CHAIN,
          subjectPrivateKey: attacker2Pk,
        },
        acc2
      );
      report.evaluations.push({
        label: `bruteforce-${i}`,
        subject: attacker2,
        object: objectB,
        response: attempt.res.body,
      });
    }

    // Post-attack snapshots
    report.tokenHistory.after = await snapshotBalances();
    const deltas = {};
    for (const addr of [objectA, objectB, attacker1, attacker2]) {
      const before = report.tokenHistory.before?.[addr]?.raw;
      const after = report.tokenHistory.after?.[addr]?.raw;
      if (before && after) {
        try {
          const delta = BigInt(after) - BigInt(before);
          deltas[addr] = {
            raw: delta.toString(),
            formatted: ethers.formatUnits(delta, 18),
          };
        } catch (_e) {
          deltas[addr] = { raw: null, formatted: null };
        }
      }
    }
    report.tokenHistory.delta = deltas;
    report.tokenHistory.judgeAfter = {
      [attacker1]: await snapshotJudge(attacker1),
      [attacker2]: await snapshotJudge(attacker2),
    };

    // Judge + RoleToken events for attackers in this block window
    const endBlock = await provider.getBlockNumber();
    report.tokenHistory.blockRange = { start: chainBlock, end: endBlock };

    async function mapEvent(ev) {
      return {
        blockNumber: ev.blockNumber,
        txHash: ev.transactionHash,
        args: Object.fromEntries(
          ev.fragment.inputs.map((input, idx) => [input.name || `arg${idx}`, cleanValue(ev.args[idx])])
        ),
      };
    }

    async function collectJudgeEvents(address) {
      const penalized = await judge.queryFilter(judge.filters.Penalized(address), chainBlock, endBlock);
      const rewarded = await judge.queryFilter(judge.filters.RewardIssued(address), chainBlock, endBlock);
      const blocked = await judge.queryFilter(judge.filters.MemberBlocked(address), chainBlock, endBlock);
      return {
        penalized: await Promise.all(penalized.map(mapEvent)),
        rewarded: await Promise.all(rewarded.map(mapEvent)),
        blocked: await Promise.all(blocked.map(mapEvent)),
      };
    }

    const roleTokenContract = new ethers.Contract(deployed.roleToken, roleTokenAbi, provider);
    async function collectTransfers(address) {
      const sent = await roleTokenContract.queryFilter(roleTokenContract.filters.Transfer(address, null), chainBlock, endBlock);
      const received = await roleTokenContract.queryFilter(roleTokenContract.filters.Transfer(null, address), chainBlock, endBlock);
      const mapTransfer = (ev) => ({
        blockNumber: ev.blockNumber,
        txHash: ev.transactionHash,
        from: ev.args[0],
        to: ev.args[1],
        value: cleanValue(ev.args[2]),
      });
      return {
        sent: sent.map(mapTransfer),
        received: received.map(mapTransfer),
      };
    }

    report.tokenHistory.judgeEvents = {
      [attacker1]: await collectJudgeEvents(attacker1),
      [attacker2]: await collectJudgeEvents(attacker2),
    };
    report.tokenHistory.roleTokenTransfers = {
      [attacker1]: await collectTransfers(attacker1),
      [attacker2]: await collectTransfers(attacker2),
    };

    const statusAAfter = await fetchJson(`${PGH_A}/status`);
    const statusBAfter = await fetchJson(`${PGH_B}/status`);
    report.statusSnapshots.after = {
      pghA: statusAAfter.body,
      pghB: statusBAfter.body,
    };

    const metricsAAfter = await writeMetrics(METRICS_A_URL, "cross-pgh-attack-A-post", RUN_DIR);
    const metricsBAfter = await writeMetrics(METRICS_B_URL, "cross-pgh-attack-B-post", RUN_DIR);
    report.metricsSnapshots.post = {
      pghA: metricsAAfter,
      pghB: metricsBAfter,
    };

    const demoAfter = fs.existsSync(DEMO_DIR) ? new Set(fs.readdirSync(DEMO_DIR)) : new Set();
    const newDemoLogs = Array.from(demoAfter).filter((f) => !demoBefore.has(f));
    report.demoLogs = {
      path: path.relative(ROOT, DEMO_DIR),
      newFiles: newDemoLogs,
    };
  } catch (err) {
    report.errors.push({
      message: err.message || String(err),
      stack: err.stack || null,
    });
  } finally {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    if (VERBOSE) {
      const lines = [];
      lines.push(`# Cross-PGH Attack Report`);
      lines.push(``);
      lines.push(`Timestamp: ${report.meta.timestamp}`);
      lines.push(`PGH-A: ${report.meta.pghA}`);
      lines.push(`PGH-B: ${report.meta.pghB}`);
      lines.push(`RPC: ${report.meta.rpcUrl}`);
      lines.push(`Attempts: ${report.meta.attempts}`);
      lines.push(`Log on-chain: ${report.meta.logOnChain}`);
      lines.push(``);
      if (report.errors.length) {
        lines.push(`## Errors`);
        report.errors.forEach((e) => lines.push(`- ${e.message}`));
        lines.push(``);
      }
      lines.push(`## Addresses`);
      Object.entries(report.addresses || {}).forEach(([k, v]) => {
        lines.push(`- ${k}: ${v}`);
      });
      lines.push(``);
      lines.push(`## Contracts`);
      Object.entries(report.contracts || {}).forEach(([k, v]) => {
        lines.push(`- ${k}: ${v}`);
      });
      lines.push(``);
      lines.push(`## Steps (summary)`);
      report.steps.forEach((s) => {
        const tx = s.tx ? ` tx=${s.tx.hash} gas=${s.tx.gasUsed}` : " tx=n/a";
        lines.push(`- ${s.label} [${s.pgh}] status=${s.status}${tx}`);
      });
      lines.push(``);
      lines.push(`## Token balances (before -> after)`);
      const before = report.tokenHistory.before || {};
      const after = report.tokenHistory.after || {};
      Object.keys(before).forEach((addr) => {
        const b = before[addr]?.formatted || before[addr]?.raw || "n/a";
        const a = after[addr]?.formatted || after[addr]?.raw || "n/a";
        lines.push(`- ${addr}: ${b} -> ${a}`);
      });
      lines.push(``);
      lines.push(`## Metrics snapshots`);
      if (report.metricsSnapshots.pre) {
        lines.push(`- pre A: ${report.metricsSnapshots.pre.pghA?.path || "n/a"}`);
        lines.push(`- pre B: ${report.metricsSnapshots.pre.pghB?.path || "n/a"}`);
      }
      if (report.metricsSnapshots.post) {
        lines.push(`- post A: ${report.metricsSnapshots.post.pghA?.path || "n/a"}`);
        lines.push(`- post B: ${report.metricsSnapshots.post.pghB?.path || "n/a"}`);
      }
      lines.push(``);
      lines.push(`## Demo logs`);
      if (report.demoLogs?.path) {
        lines.push(`- path: ${report.demoLogs.path}`);
        lines.push(`- new files: ${report.demoLogs.newFiles?.length || 0}`);
      }
      fs.writeFileSync(summaryPath, lines.join("\n"), "utf8");
    }
  }
}

main().then(() => {
  console.log(`Cross-PGH attack report written to ${reportPath}`);
  console.log(`Summary written to ${summaryPath}`);
  process.exit(0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
