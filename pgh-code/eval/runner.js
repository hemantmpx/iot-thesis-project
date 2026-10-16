#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const net = require("net");
const { execSync, spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const IOT_PI_DIR = path.join(ROOT, "iot", "pi");
const DOTENV_PATH = path.join(IOT_PI_DIR, "node_modules", "dotenv");
const ETHERS_PATH = path.join(IOT_PI_DIR, "node_modules", "ethers");
const SOLC_PATH = path.join(IOT_PI_DIR, "node_modules", "solc");
const CONTRACT_SOURCE_DIR = path.join(ROOT, "informational", "contracts");
const NODE_MODULES_DIR = path.join(IOT_PI_DIR, "node_modules");

// Load env from iot/pi/.env to match existing PGH setup
try {
  // eslint-disable-next-line import/no-dynamic-require
  require(DOTENV_PATH).config({ path: path.join(IOT_PI_DIR, ".env") });
} catch (_err) {
  // dotenv missing; continue with process.env
}

// eslint-disable-next-line import/no-dynamic-require
const { ethers } = require(ETHERS_PATH);
const { GasLogger } = require("./gas_logger");
const { buildScenarioLibrary, DEFAULT_ACC_TYPE } = require("./scenario_library");

const RESULTS_DIR = path.join(ROOT, "results");
const RUN_ID = process.env.EVAL_RUN_ID || `eval-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}`;
const MEMBER_TYPE_RUN_SUFFIX = RUN_ID.replace(/[^a-zA-Z0-9]/g, "").slice(-12);
const DEFAULT_ESP_DB = path.join(ROOT, "esp_api_project", "esp_data.db");
const DEFAULT_ESP_API_SCRIPT = path.join(ROOT, "esp_api_project", "esp_api_2waycomm.py");
const DEFAULT_ESP_SANDBOX_ROOT = path.join(ROOT, "tmp", "esp_eval");

function parseCsvList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

const CONFIG = {
  rpcUrl: process.env.RPC_URL,
  pghBase: process.env.PGH_API_BASE || "http://127.0.0.1:8080",
  pghApiBase: process.env.PGH_API_BASE || "http://127.0.0.1:8080",
  pghABase: process.env.PGH_A_BASE || process.env.PGH_API_BASE || "http://127.0.0.1:8080",
  pghBBase: process.env.PGH_B_BASE || "http://127.0.0.1:8081",
  modeBEnabled: process.env.EVAL_ENABLE_MODE_B !== "0",
  targetOps: parseInt(process.env.EVAL_TARGET_OPS || "1200", 10),
  maxScenarios: parseInt(process.env.EVAL_MAX_SCENARIOS || "10000", 10),
  maliciousRate: parseFloat(process.env.EVAL_MALICIOUS_RATE || "0.35"),
  extraBlockLookahead: parseInt(process.env.EVAL_EXTRA_BLOCK_LOOKAHEAD || "6", 10),
  extraBlockWaitMs: parseInt(process.env.EVAL_EXTRA_BLOCK_WAIT_MS || "1500", 10),
  interOpDelayMs: parseInt(process.env.EVAL_INTER_OP_DELAY_MS || "0", 10),
  minimal: process.env.EVAL_MINIMAL === "1",
  forceModeB: process.env.EVAL_FORCE_MODE_B === "1",
  scenarioIds: parseCsvList(process.env.EVAL_SCENARIO_IDS),
  scenarioGroup: (process.env.EVAL_SCENARIO_GROUP || "").trim(),
  scenarioRepeat: Math.max(1, parseInt(process.env.EVAL_SCENARIO_REPEAT || "1", 10) || 1),
  disableRandomFill: process.env.EVAL_DISABLE_RANDOM_FILL === "1",
  onlyModeB: process.env.EVAL_ONLY_MODE_B === "1",
  includeSetupInScenario: process.env.EVAL_INCLUDE_SETUP_IN_SCENARIO !== "0",
  rpcTimeoutMs: parseInt(process.env.EVAL_RPC_TIMEOUT_MS || "30000", 10),
  rpcCheckTimeoutMs: parseInt(process.env.EVAL_RPC_CHECK_TIMEOUT_MS || "8000", 10),
  espPythonBin: process.env.EVAL_ESP_PYTHON || process.env.PYTHON || "python3",
  espApiScript: process.env.EVAL_ESP_API_SCRIPT || DEFAULT_ESP_API_SCRIPT,
  espSourceDb: process.env.EVAL_ESP_SOURCE_DB || DEFAULT_ESP_DB,
  espSandboxRoot: process.env.EVAL_ESP_SANDBOX_ROOT || DEFAULT_ESP_SANDBOX_ROOT,
  espHost: process.env.EVAL_ESP_HOST || "127.0.0.1",
  espPortBase: parseInt(process.env.EVAL_ESP_PORT_BASE || "5100", 10),
  espStartupTimeoutMs: parseInt(process.env.EVAL_ESP_STARTUP_TIMEOUT_MS || "20000", 10),
  espPollIntervalMs: parseInt(process.env.EVAL_ESP_POLL_INTERVAL_MS || "250", 10),
  espChainActionLimit: parseInt(process.env.EVAL_ESP_CHAIN_ACTION_LIMIT || "250", 10),
  espActionSettleMs: parseInt(process.env.EVAL_ESP_ACTION_SETTLE_MS || "125", 10),
  espRequestorMac: (process.env.EVAL_ESP_REQUESTOR_MAC || "").trim(),
  espTargetMac: (process.env.EVAL_ESP_TARGET_MAC || "").trim(),
  espRefreshTemperatureDelta: parseFloat(process.env.EVAL_ESP_REFRESH_TEMP_DELTA || "0.2"),
  espRefreshHumidityDelta: parseFloat(process.env.EVAL_ESP_REFRESH_HUMIDITY_DELTA || "0.2"),
  localSignerMinBalanceEth: process.env.EVAL_LOCAL_SIGNER_MIN_BALANCE_ETH || "0.05",
  localSignerTopUpEth: process.env.EVAL_LOCAL_SIGNER_TOP_UP_ETH || "1.0",
};

const ACTIVE_CHILD_PROCESSES = new Set();
process.on("exit", () => {
  for (const child of ACTIVE_CHILD_PROCESSES) {
    try {
      child.kill("SIGKILL");
    } catch (_err) {
      // ignore cleanup failures during process exit
    }
  }
});

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const FALLBACK_GAS_LIMIT = BigInt(process.env.EVAL_FALLBACK_GAS_LIMIT || "1000000");

let solcInstance = null;

function nowUtc() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeMac(value) {
  return String(value || "").trim().toUpperCase();
}

function parseEspDbTimestampMs(value) {
  if (!value) return null;
  const normalized = String(value).trim().replace(" ", "T");
  const parsed = new Date(normalized).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function scenarioUsesEspBridge(scenario) {
  if (scenario?.usesEspBridge) return true;
  return Boolean((scenario?.operations || []).some((op) => typeof op.op === "string" && op.op.startsWith("ESP ")));
}

function resetEspSandboxDb(pythonBin, dbPath) {
  const script = `
import sqlite3
import sys

db_path = sys.argv[1]
tables = [
    "logs",
    "approvals",
    "access_grants",
    "peer_access_requests",
    "peer_transfers",
    "blockchain_identities",
    "contract_bindings",
    "chain_actions",
    "chain_status_snapshots",
    "simulation_runs",
]

conn = sqlite3.connect(db_path)
cur = conn.cursor()
existing = {row[0] for row in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")}
for table in tables:
    if table in existing:
        cur.execute(f"DELETE FROM {table}")
conn.commit()
conn.close()
`;
  const result = spawnSync(pythonBin, ["-c", script, dbPath], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || result.stdout || "").trim();
    throw new Error(`Failed resetting ESP sandbox database ${dbPath}: ${stderr || `exit ${result.status}`}`);
  }
}

function reserveEspSandboxAccounts(pythonBin, dbPath, addresses) {
  const normalized = Array.from(new Set((addresses || [])
    .map((address) => String(address || "").trim().toLowerCase())
    .filter(Boolean)));
  if (!normalized.length) return;

  const script = `
import sqlite3
import sys

db_path = sys.argv[1]
addresses = [addr for addr in sys.argv[2:] if addr]

conn = sqlite3.connect(db_path)
cur = conn.cursor()
cur.execute("""
    CREATE TABLE IF NOT EXISTS blockchain_identities (
        mac TEXT PRIMARY KEY,
        subject_address TEXT,
        private_key TEXT,
        contract_address TEXT,
        member_type TEXT,
        created_at TEXT
    )
""")

for index, address in enumerate(addresses):
    mac = f"RESERVED_{index}_{address}"
    cur.execute(
        """
        INSERT OR REPLACE INTO blockchain_identities
        (mac, subject_address, private_key, contract_address, member_type, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        """,
        (mac, address, "", "", "reserved")
    )

conn.commit()
conn.close()
`;
  const result = spawnSync(pythonBin, ["-c", script, dbPath, ...normalized], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || result.stdout || "").trim();
    throw new Error(`Failed reserving ESP sandbox accounts in ${dbPath}: ${stderr || `exit ${result.status}`}`);
  }
}

async function findFreePort(startPort, host = "127.0.0.1") {
  let candidate = Number(startPort || 0);
  while (candidate < 65535) {
    // eslint-disable-next-line no-await-in-loop
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.unref();
      server.once("error", () => resolve(false));
      server.listen(candidate, host, () => {
        server.close(() => resolve(true));
      });
    });
    if (available) return candidate;
    candidate += 1;
  }
  throw new Error(`No free TCP port found starting at ${startPort}`);
}

async function requestJson(method, base, pathname, options = {}) {
  const startMs = Date.now();
  const url = new URL(pathname, base);
  if (options.query && typeof options.query === "object") {
    for (const [key, value] of Object.entries(options.query)) {
      if (value === null || value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }

  const headers = { ...(options.headers || {}) };
  let body = options.body;
  if (body !== undefined && body !== null && typeof body === "object" && !(body instanceof ArrayBuffer) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }

  const res = await fetch(url, {
    method,
    headers,
    body,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  const endMs = Date.now();
  return {
    status: res.status,
    body: parsed,
    text,
    timing: { startMs, endMs, latencyMs: endMs - startMs },
    url: url.toString(),
  };
}

async function getJson(base, pathname, options = {}) {
  return requestJson("GET", base, pathname, options);
}

function msToUtc(value) {
  if (value === null || value === undefined) return "";
  return new Date(value).toISOString();
}

function secToUtc(value) {
  if (value === null || value === undefined || value === "") return "";
  try {
    const seconds = typeof value === "bigint" ? Number(value) : Number(value);
    if (!Number.isFinite(seconds)) return "";
    return new Date(seconds * 1000).toISOString();
  } catch (_err) {
    return "";
  }
}

function diffMs(start, end) {
  if (start === null || start === undefined || end === null || end === undefined) return null;
  return end - start;
}

function toBigIntSafe(value) {
  if (value === null || value === undefined || value === "") return null;
  try {
    return BigInt(value);
  } catch (_err) {
    return null;
  }
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadAbi(abiPath) {
  const raw = JSON.parse(fs.readFileSync(abiPath, "utf8"));
  return raw.abi || raw;
}

function getSolc() {
  if (!solcInstance) {
    // eslint-disable-next-line import/no-dynamic-require
    solcInstance = require(SOLC_PATH);
  }
  return solcInstance;
}

function resolveImportPath(importPath) {
  const candidates = [
    path.join(CONTRACT_SOURCE_DIR, importPath),
    path.join(NODE_MODULES_DIR, importPath),
    path.join(CONTRACT_SOURCE_DIR, path.basename(importPath)),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function compileSourceArtifact(name) {
  const sourcePath = path.join(CONTRACT_SOURCE_DIR, `${name}.sol`);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source file not found for ${name}: ${sourcePath}`);
  }

  const sourceName = `${name}.sol`;
  const input = {
    language: "Solidity",
    sources: {
      [sourceName]: {
        content: fs.readFileSync(sourcePath, "utf8"),
      },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris",
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object"],
        },
      },
    },
  };

  const output = JSON.parse(getSolc().compile(JSON.stringify(input), {
    import: (importPath) => {
      const resolved = resolveImportPath(importPath);
      if (!resolved) {
        return { error: `File not found: ${importPath}` };
      }
      return { contents: fs.readFileSync(resolved, "utf8") };
    },
  }));

  if (output.errors) {
    const fatal = output.errors.filter((err) => err.severity === "error");
    if (fatal.length) {
      throw new Error(`Failed compiling ${name}: ${fatal.map((err) => err.formattedMessage).join("\n")}`);
    }
  }

  const contract = output.contracts?.[sourceName]?.[name];
  const abi = contract?.abi;
  const bytecode = contract?.evm?.bytecode?.object || null;
  if (!abi || !bytecode) {
    throw new Error(`Compiled artifact for ${name} is missing abi or bytecode`);
  }
  return { abi, bytecode };
}

function loadDeploymentArtifact(name) {
  if (name === "TableAccessControlContract") {
    return compileSourceArtifact(name);
  }

  const artifactPaths = [
    path.join(ROOT, "iot", "abis", `${name}.json`),
    path.join(ROOT, "informational", "contracts", "artifacts", `${name}.json`),
  ];
  for (const artifactPath of artifactPaths) {
    if (!fs.existsSync(artifactPath)) continue;
    const artifact = loadJson(artifactPath);
    const abi = artifact.abi;
    const bytecode = artifact?.data?.bytecode?.object || artifact?.bytecode || null;
    if (abi && bytecode) {
      return { abi, bytecode };
    }
  }

  return compileSourceArtifact(name);
}

function extractTxHash(body) {
  if (!body || typeof body !== "object") return null;
  return body.txHash || body.tx_hash || body.txhash || body.transactionHash || body.deployTxHash || null;
}

function sanitizeError(err) {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  return err.message || err.reason || JSON.stringify(err);
}

async function postJson(base, pathname, payload) {
  const startMs = Date.now();
  const res = await fetch(`${base}${pathname}` , {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  const endMs = Date.now();
  return {
    status: res.status,
    body,
    timing: { startMs, endMs, latencyMs: endMs - startMs },
  };
}

function gatewayMessage(body) {
  if (!body) return "";
  if (typeof body === "string") return body;
  if (typeof body === "object") {
    if (typeof body.message === "string") return body.message;
    try {
      return JSON.stringify(body);
    } catch (_err) {
      return "";
    }
  }
  return String(body);
}

function isRetryableGatewayError(body) {
  const msg = gatewayMessage(body).toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("nonce")
    || msg.includes("underpriced")
    || msg.includes("replacement transaction")
    || msg.includes("request timeout")
    || msg.includes("timeout")
    || msg.includes("already known")
    || msg.includes("temporarily")
  );
}

async function postJsonWithRetry(base, pathname, payload, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 1));
  const retryDelayMs = Number(options.retryDelayMs || 350);
  const statuses = [];
  let firstStart = null;
  let lastEnd = null;
  let totalLatency = 0;
  let last = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const res = await postJson(base, pathname, payload);
    last = res;
    if (firstStart === null || firstStart === undefined) {
      firstStart = res.timing?.startMs ?? null;
    }
    lastEnd = res.timing?.endMs ?? lastEnd;
    totalLatency += res.timing?.latencyMs ?? 0;
    statuses.push(res.status);

    if (res.status === 200) {
      return {
        ...res,
        attempts: attempt,
        attempt_statuses: statuses,
        timing: {
          startMs: firstStart,
          endMs: lastEnd,
          latencyMs: totalLatency,
        },
      };
    }

    if (attempt < attempts && isRetryableGatewayError(res.body)) {
      await sleep(retryDelayMs);
      continue;
    }

    break;
  }

  return {
    ...last,
    attempts: statuses.length,
    attempt_statuses: statuses,
    timing: {
      startMs: firstStart,
      endMs: lastEnd,
      latencyMs: totalLatency,
    },
  };
}

async function checkPgh(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/status`);
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: sanitizeError(err) };
  }
}

async function checkRpc(rpcUrl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_chainId",
        params: [],
        id: 1,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (!res.ok) {
      return { ok: false, status: res.status, body };
    }
    if (body && body.error) {
      return { ok: false, status: res.status, body: body.error };
    }
    return { ok: true, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: sanitizeError(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForBlock(provider, targetBlock, timeoutMs) {
  const start = Date.now();
  let current = await provider.getBlockNumber();
  while (current < targetBlock && Date.now() - start < timeoutMs) {
    await sleep(200);
    current = await provider.getBlockNumber();
  }
  return current;
}

function decodeRevertReason(data) {
  if (!data || typeof data !== "string") return null;
  if (!data.startsWith("0x")) return null;
  const errorSig = "0x08c379a0"; // Error(string)
  const panicSig = "0x4e487b71"; // Panic(uint256)
  try {
    if (data.startsWith(errorSig)) {
      const encoded = "0x" + data.slice(10);
      const reason = ethers.AbiCoder.defaultAbiCoder().decode(["string"], encoded)[0];
      return reason;
    }
    if (data.startsWith(panicSig)) {
      const encoded = "0x" + data.slice(10);
      const code = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], encoded)[0];
      return `panic_${code.toString()}`;
    }
  } catch (_err) {
    return null;
  }
  return null;
}

async function getRevertReason(provider, tx, receipt) {
  if (!tx || !receipt || receipt.status !== 0) return null;
  try {
    await provider.call(
      {
        to: tx.to,
        from: tx.from,
        data: tx.data,
        value: tx.value,
      },
      receipt.blockNumber
    );
  } catch (err) {
    const data = err?.data || err?.error?.data || err?.info?.error?.data || err?.info?.error?.body;
    const reason = decodeRevertReason(data);
    return reason || sanitizeError(err);
  }
  return null;
}

function bigintToString(value) {
  if (value === null || value === undefined) return null;
  try {
    return value.toString();
  } catch (_err) {
    return null;
  }
}

function createJudgeMetrics() {
  return {
    eventNames: new Set(),
    affectedMembers: new Set(),
    statusUpdates: new Set(),
    penaltyEventCount: 0,
    penaltyAmountTotal: 0n,
    penaltyReasons: new Set(),
    blockEventCount: 0,
    latestBlockingEndTs: null,
    rewardEventCount: 0,
    rewardAmountTotal: 0n,
  };
}

function addJudgeMetricValue(set, value) {
  if (value === null || value === undefined || value === "") return;
  set.add(String(value));
}

function absorbJudgeParsedLog(judgeMetrics, parsedLog) {
  if (!judgeMetrics || !parsedLog?.name) return;
  const args = parsedLog.args || [];
  judgeMetrics.eventNames.add(parsedLog.name);

  switch (parsedLog.name) {
    case "StatusUpdated":
      addJudgeMetricValue(judgeMetrics.affectedMembers, args[0]);
      addJudgeMetricValue(judgeMetrics.statusUpdates, args[1]);
      break;
    case "Penalized":
      addJudgeMetricValue(judgeMetrics.affectedMembers, args[0]);
      judgeMetrics.penaltyEventCount += 1;
      try {
        judgeMetrics.penaltyAmountTotal += BigInt(args[1]?.toString?.() ?? args[1] ?? 0);
      } catch (_err) {
        // Ignore malformed values.
      }
      addJudgeMetricValue(judgeMetrics.penaltyReasons, args[2]);
      break;
    case "MemberBlocked": {
      addJudgeMetricValue(judgeMetrics.affectedMembers, args[0]);
      judgeMetrics.blockEventCount += 1;
      addJudgeMetricValue(judgeMetrics.penaltyReasons, args[2]);
      try {
        const blockEnd = BigInt(args[1]?.toString?.() ?? args[1] ?? 0);
        if (judgeMetrics.latestBlockingEndTs === null || blockEnd > judgeMetrics.latestBlockingEndTs) {
          judgeMetrics.latestBlockingEndTs = blockEnd;
        }
      } catch (_err) {
        // Ignore malformed values.
      }
      break;
    }
    case "RewardIssued":
      addJudgeMetricValue(judgeMetrics.affectedMembers, args[0]);
      judgeMetrics.rewardEventCount += 1;
      try {
        judgeMetrics.rewardAmountTotal += BigInt(args[1]?.toString?.() ?? args[1] ?? 0);
      } catch (_err) {
        // Ignore malformed values.
      }
      break;
    default:
      break;
  }
}

function mergeJudgeMetrics(target, source) {
  if (!target || !source) return target;
  for (const name of source.eventNames || []) target.eventNames.add(name);
  for (const member of source.affectedMembers || []) target.affectedMembers.add(member);
  for (const status of source.statusUpdates || []) target.statusUpdates.add(status);
  target.penaltyEventCount += Number(source.penaltyEventCount || 0);
  target.blockEventCount += Number(source.blockEventCount || 0);
  target.rewardEventCount += Number(source.rewardEventCount || 0);
  if (source.penaltyReasons) {
    for (const reason of source.penaltyReasons) target.penaltyReasons.add(reason);
  }
  try {
    if (source.penaltyAmountTotal !== null && source.penaltyAmountTotal !== undefined) {
      target.penaltyAmountTotal += BigInt(source.penaltyAmountTotal);
    }
  } catch (_err) {
    // Ignore malformed values.
  }
  try {
    if (source.rewardAmountTotal !== null && source.rewardAmountTotal !== undefined) {
      target.rewardAmountTotal += BigInt(source.rewardAmountTotal);
    }
  } catch (_err) {
    // Ignore malformed values.
  }
  try {
    if (source.latestBlockingEndTs !== null && source.latestBlockingEndTs !== undefined && source.latestBlockingEndTs !== "") {
      const candidate = BigInt(source.latestBlockingEndTs);
      if (target.latestBlockingEndTs === null || candidate > target.latestBlockingEndTs) {
        target.latestBlockingEndTs = candidate;
      }
    }
  } catch (_err) {
    // Ignore malformed values.
  }
  return target;
}

function formatJudgeMetrics(judgeMetrics) {
  const metrics = judgeMetrics || createJudgeMetrics();
  return {
    judge_event_names: Array.from(metrics.eventNames || []).join(","),
    judge_affected_members: Array.from(metrics.affectedMembers || []).join(","),
    judge_status_updates: Array.from(metrics.statusUpdates || []).join(","),
    judge_penalty_event_count: Number(metrics.penaltyEventCount || 0),
    judge_penalty_amount_total: Number(metrics.penaltyEventCount || 0) > 0 ? bigintToString(metrics.penaltyAmountTotal ?? 0n) : "",
    judge_penalty_reasons: Array.from(metrics.penaltyReasons || []).join(","),
    judge_block_event_count: Number(metrics.blockEventCount || 0),
    judge_latest_blocking_end_utc: secToUtc(metrics.latestBlockingEndTs),
    judge_reward_event_count: Number(metrics.rewardEventCount || 0),
    judge_reward_amount_total: Number(metrics.rewardEventCount || 0) > 0 ? bigintToString(metrics.rewardAmountTotal ?? 0n) : "",
  };
}

async function buildFeeOverrides(wallet, bump) {
  if (!wallet?.provider) return {};
  try {
    const feeData = await wallet.provider.getFeeData();
    const block = await wallet.provider.getBlock("latest");
    const baseFee = block?.baseFeePerGas ?? null;
    const toBigInt = (value) => (typeof value === "bigint" ? value : BigInt(value));
    const out = {};

    let maxPriority = feeData.maxPriorityFeePerGas ?? feeData.gasPrice ?? null;
    let maxFee = feeData.maxFeePerGas ?? feeData.gasPrice ?? null;

    if (maxPriority !== null && maxPriority !== undefined) {
      maxPriority = toBigInt(maxPriority) * bump;
    }
    if (maxFee !== null && maxFee !== undefined) {
      maxFee = toBigInt(maxFee) * bump;
    }

    if (baseFee !== null && baseFee !== undefined && maxPriority !== null && maxPriority !== undefined) {
      const desired = toBigInt(baseFee) * bump + maxPriority;
      if (maxFee === null || maxFee === undefined || desired > maxFee) {
        maxFee = desired;
      }
    }

    if (maxFee !== null && maxFee !== undefined) {
      out.maxFeePerGas = maxFee;
    }
    if (maxPriority !== null && maxPriority !== undefined) {
      out.maxPriorityFeePerGas = maxPriority;
    }
    if ((!out.maxFeePerGas && !out.maxPriorityFeePerGas) && feeData.gasPrice) {
      out.gasPrice = toBigInt(feeData.gasPrice) * bump;
    }

    return out;
  } catch (_err) {
    return {};
  }
}

async function sendWithNonce(wallet, sendFn) {
  let overrides = {};
  let bump = 2n;
  let gasLimit = null;
  while (true) {
    try {
      const feeOverrides = await buildFeeOverrides(wallet, bump);
      const sentAtMs = Date.now();
      const tx = await sendFn({ ...overrides, ...feeOverrides, ...(gasLimit ? { gasLimit } : {}) });
      try {
        const receipt = await tx.wait();
        const minedAtMs = Date.now();
        return { tx, receipt, sentAtMs, minedAtMs };
      } catch (err) {
        const minedAtMs = Date.now();
        if (err && err.receipt) {
          return { tx, receipt: err.receipt, sentAtMs, minedAtMs, error: err };
        }
        throw err;
      }
    } catch (err) {
      const message = err?.message || "";
      const lower = message.toLowerCase();
      if (lower.includes("estimategas") || lower.includes("missing revert data") || lower.includes("execution reverted")) {
        if (!gasLimit) {
          // Some threat-path and TAC operations fail gas estimation even though a real
          // transaction can complete or revert meaningfully on-chain. Use a generous
          // fallback instead of the old 1,000,000 cap, which was producing artificial
          // out-of-gas failures in the dataset.
          gasLimit = FALLBACK_GAS_LIMIT;
          continue;
        }
      }
      if (lower.includes("underpriced") || lower.includes("fee too low") || lower.includes("max fee per gas")) {
        bump *= 2n;
        continue;
      }
      if (lower.includes("nonce")) {
        let nextNonce = null;
        if (typeof wallet.getNonce === "function") {
          nextNonce = await wallet.getNonce("pending");
        } else if (wallet?.provider && typeof wallet.getAddress === "function") {
          const addr = await wallet.getAddress();
          nextNonce = await wallet.provider.getTransactionCount(addr, "pending");
        }
        if (nextNonce !== null && nextNonce !== undefined) {
          overrides = { ...overrides, nonce: nextNonce };
          continue;
        }
      }
      throw err;
    }
  }
}

async function describeTx(provider, txHash, contractRegistry, note) {
  const tx = await provider.getTransaction(txHash);
  const receipt = await provider.getTransactionReceipt(txHash);
  const toAddress = tx?.to ? tx.to.toLowerCase() : null;
  const entry = toAddress ? contractRegistry.get(toAddress) : null;
  let contractName = entry?.name || (tx?.to ? "Unknown" : "ContractCreation");
  let functionName = "unknown";

  if (entry?.iface && tx?.data) {
    try {
      const parsed = entry.iface.parseTransaction({ data: tx.data, value: tx.value });
      if (parsed && parsed.name) {
        functionName = parsed.name;
      }
    } catch (_err) {
      functionName = "unknown";
    }
  }

  const gasUsed = receipt?.gasUsed ?? null;
  const gasLimit = tx?.gasLimit ?? null;
  const effectiveGasPrice = receipt?.effectiveGasPrice ?? tx?.gasPrice ?? null;
  const feePaidWei = gasUsed && effectiveGasPrice ? gasUsed * effectiveGasPrice : null;
  const revertReason = await getRevertReason(provider, tx, receipt);
  let outOfGas = false;
  try {
    if (receipt?.status === 0 && gasUsed !== null && gasLimit !== null) {
      const used = typeof gasUsed === "bigint" ? gasUsed : BigInt(gasUsed);
      const limit = typeof gasLimit === "bigint" ? gasLimit : BigInt(gasLimit);
      if (used >= limit) {
        outOfGas = true;
      }
    }
  } catch (_err) {
    outOfGas = false;
  }

  const emittedContracts = new Set();
  const emittedEvents = [];
  const emittedJudgeEvents = [];
  const judgeMetrics = createJudgeMetrics();
  for (const log of receipt?.logs || []) {
    const logAddress = log?.address ? String(log.address).toLowerCase() : null;
    if (!logAddress) continue;
    const logEntry = contractRegistry.get(logAddress);
    if (!logEntry?.name) continue;
    emittedContracts.add(logEntry.name);
    if (!logEntry.iface) continue;
    try {
      const parsedLog = logEntry.iface.parseLog(log);
      if (!parsedLog?.name) continue;
      emittedEvents.push({
        contractName: logEntry.name,
        eventName: parsedLog.name,
      });
      if (logEntry.name === "JudgeContract") {
        emittedJudgeEvents.push(parsedLog.name);
        absorbJudgeParsedLog(judgeMetrics, parsedLog);
      }
    } catch (_err) {
      // Ignore non-decodable logs.
    }
  }

  return {
    tx,
    receipt,
    contractName,
    functionName,
    gasUsed,
    gasLimit,
    effectiveGasPrice,
    feePaidWei,
    revertReason,
    outOfGas,
    note,
    emittedContracts: Array.from(emittedContracts),
    emittedEvents,
    emittedJudgeEvents,
    judgeMetrics,
  };
}

async function collectExtraTxs(provider, { startBlock, endBlock, knownTxHashes, seenTxHashes, toAddresses }) {
  const extras = [];
  for (let blockNum = startBlock; blockNum <= endBlock; blockNum += 1) {
    const block = await provider.getBlock(blockNum, true);
    if (!block || !block.transactions) continue;
    for (const tx of block.transactions) {
      if (!tx?.hash) continue;
      const hash = tx.hash;
      if (knownTxHashes.has(hash) || seenTxHashes.has(hash)) continue;
      if (toAddresses && tx.to) {
        const toLower = tx.to.toLowerCase();
        if (!toAddresses.has(toLower)) continue;
      }
      extras.push(hash);
    }
  }
  return extras;
}

class AccountPool {
  constructor(privateKeys, roleToken, adminWallet, judgeContract, provider) {
    this.privateKeys = privateKeys;
    this.addresses = Object.keys(privateKeys || {});
    this.roleToken = roleToken;
    this.adminWallet = adminWallet;
    this.judgeContract = judgeContract;
    this.provider = provider;
    this.pointer = 0;
  }

  async isBlocked(address, nowTs) {
    if (!this.judgeContract) return false;
    try {
      const blockingEndTime = await this.judgeContract.getBlockingEndTime(address);
      if (blockingEndTime === null || blockingEndTime === undefined) return false;
      const end = BigInt(blockingEndTime.toString());
      const now = BigInt(nowTs);
      return end > now;
    } catch (_err) {
      return false;
    }
  }

  async ensureNone(address) {
    const role = await this.roleToken.getRole(address);
    const roleValue = typeof role === "object" && role.toString ? role.toString() : String(role);
    if (roleValue === "0" || roleValue === "1") return;
    try {
      await sendWithNonce(this.adminWallet, (overrides) => this.roleToken.connect(this.adminWallet).revokeRole(address, overrides));
    } catch (err) {
      const msg = err?.message || "";
      if (msg.toLowerCase().includes("does not have a role") || msg.toLowerCase().includes("account does not have a role")) {
        return;
      }
      try {
        const updated = await this.roleToken.getRole(address);
        const updatedValue = typeof updated === "object" && updated.toString ? updated.toString() : String(updated);
        if (updatedValue === "0" || updatedValue === "1") {
          return;
        }
      } catch (_err) {
        // ignore secondary check errors
      }
      throw err;
    }
  }

  async getFresh(label, exclude) {
    const excludeSet = exclude || new Set();
    const readNowTs = async () => {
      let now = Math.floor(Date.now() / 1000);
      if (this.provider) {
        try {
          const block = await this.provider.getBlock("latest");
          if (block && block.timestamp) now = block.timestamp;
        } catch (_err) {
          // fallback to wall-clock time
        }
      }
      return now;
    };

    const scanForFresh = async (nowTs, allowBlocked = false) => {
      for (let i = 0; i < this.addresses.length; i += 1) {
        const idx = (this.pointer + i) % this.addresses.length;
        const addr = this.addresses[idx];
        if (excludeSet.has(addr.toLowerCase())) continue;
        if (!allowBlocked && await this.isBlocked(addr, nowTs)) continue;
        await this.ensureNone(addr);
        this.pointer = idx + 1;
        return {
          label,
          address: addr,
          privateKey: this.privateKeys[addr.toLowerCase()],
        };
      }
      return null;
    };

    let nowTs = await readNowTs();
    let candidate = await scanForFresh(nowTs, false);
    if (candidate) return candidate;

    if (this.judgeContract && this.provider) {
      try {
        let maxEnd = BigInt(0);
        for (const addr of this.addresses) {
          if (excludeSet.has(addr.toLowerCase())) continue;
          const endTime = await this.judgeContract.getBlockingEndTime(addr);
          if (endTime === null || endTime === undefined) continue;
          const end = BigInt(endTime.toString());
          if (end > maxEnd) maxEnd = end;
        }
        if (maxEnd > BigInt(nowTs)) {
          const delta = Number(maxEnd - BigInt(nowTs) + BigInt(1));
          await this.provider.send("evm_increaseTime", [delta]);
          await this.provider.send("evm_mine", []);
          nowTs = await readNowTs();
          candidate = await scanForFresh(nowTs, false);
          if (candidate) return candidate;
        }
      } catch (_err) {
        // fall through to blocked reuse
      }
    }

    candidate = await scanForFresh(nowTs, true);
    if (candidate) return candidate;
    throw new Error("No available addresses in pool");
  }
}

async function ensureDeployed(provider, name, address) {
  if (!address) throw new Error(`${name} address missing`);
  const code = await provider.getCode(address);
  if (!code || code === "0x") {
    throw new Error(`${name} not deployed at ${address}`);
  }
}

async function main() {
  if (!CONFIG.rpcUrl) {
    console.error("RPC_URL is required (set in iot/pi/.env)");
    process.exit(1);
  }

  const rpcCheck = await checkRpc(CONFIG.rpcUrl, CONFIG.rpcCheckTimeoutMs);
  if (!rpcCheck.ok) {
    console.error(`RPC not reachable at ${CONFIG.rpcUrl}: ${JSON.stringify(rpcCheck.body)}`);
    process.exit(1);
  }

  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }

  const deployedPath = process.env.EVAL_DEPLOYED_ADDRESSES
    ? path.resolve(process.env.EVAL_DEPLOYED_ADDRESSES)
    : path.join(ROOT, "tmp", "deployed-addresses.json");
  if (!fs.existsSync(deployedPath)) {
    console.error(`Missing ${deployedPath}. Run existing bootstrap/deploy flow first.`);
    process.exit(1);
  }

  const deployed = loadJson(deployedPath);
  const addresses = deployed.addresses || deployed;

  const keysPath = path.join(ROOT, "tmp", "ganache-keys.json");
  const keysRaw = loadJson(keysPath);
  const privateKeys = keysRaw.private_keys || {};

  const rpcRequest = new ethers.FetchRequest(CONFIG.rpcUrl);
  rpcRequest.timeout = CONFIG.rpcTimeoutMs;
  const provider = new ethers.JsonRpcProvider(rpcRequest);
  const network = await provider.getNetwork();

  const abiDir = path.join(ROOT, "iot", "abis");
  const abiRoleToken = loadAbi(path.join(abiDir, "RoleToken.json"));
  const abiRoleBased = loadAbi(path.join(abiDir, "RoleBasedAccessControl.json"));
  const abiFactory = loadAbi(path.join(abiDir, "AccessControlFactory.json"));
  const abiRegister = loadAbi(path.join(abiDir, "RegisterContract.json"));
  const abiJudge = loadAbi(path.join(abiDir, "JudgeContract.json"));
  const abiAccess = loadAbi(path.join(abiDir, "AccessControlContract.json"));
  let abiTac;
  const tacLocal = path.join(abiDir, "TableAccessControlContract.json");
  const tacFallback = path.join(ROOT, "informational", "contracts", "artifacts", "TableAccessControlContract.json");
  if (fs.existsSync(tacLocal)) {
    abiTac = loadAbi(tacLocal);
  } else if (fs.existsSync(tacFallback)) {
    abiTac = loadAbi(tacFallback);
  }

  await ensureDeployed(provider, "RoleToken", addresses.roleToken);
  await ensureDeployed(provider, "RoleBasedAccessControl", addresses.roleBasedAccessControl);
  await ensureDeployed(provider, "AccessControlFactory", addresses.accessControlFactory);
  await ensureDeployed(provider, "RegisterContract", addresses.registerContract);
  await ensureDeployed(provider, "JudgeContract", addresses.judgeContract);

  const roleToken = new ethers.Contract(addresses.roleToken, abiRoleToken, provider);
  const roleBased = new ethers.Contract(addresses.roleBasedAccessControl, abiRoleBased, provider);
  const accessFactory = new ethers.Contract(addresses.accessControlFactory, abiFactory, provider);
  const registerContract = new ethers.Contract(addresses.registerContract, abiRegister, provider);
  const judgeContract = new ethers.Contract(addresses.judgeContract, abiJudge, provider);

  const owner = await roleToken.owner();
  let adminPk = process.env.ADMIN_KEY || "";
  if (adminPk) {
    adminPk = adminPk.trim();
  }
  if (!adminPk) {
    adminPk = privateKeys[owner.toLowerCase()] || "";
  }
  if (!adminPk) {
    console.error(`Admin key not found for owner ${owner} in ganache-keys.json and ADMIN_KEY not set.`);
    process.exit(1);
  }
  let adminWallet = new ethers.Wallet(adminPk, provider);
  let adminRoleStr = null;
  const preManifestFailures = [];
  try {
    const roleVal = await roleToken.getRole(adminWallet.address);
    adminRoleStr = typeof roleVal === "object" && roleVal.toString ? roleVal.toString() : String(roleVal);
    if (adminRoleStr !== "1") {
      const ownerPk = privateKeys[owner.toLowerCase()];
      if (ownerPk && ownerPk !== adminPk) {
        adminWallet = new ethers.Wallet(ownerPk, provider);
        const roleValOwner = await roleToken.getRole(adminWallet.address);
        adminRoleStr = typeof roleValOwner === "object" && roleValOwner.toString ? roleValOwner.toString() : String(roleValOwner);
      }
    }
  } catch (_err) {
    // continue with provided admin wallet
  }

  if (adminRoleStr !== "1") {
    let ownerSigner = null;
    const ownerPk = privateKeys[owner.toLowerCase()];
    if (ownerPk) {
      ownerSigner = new ethers.Wallet(ownerPk, provider);
    } else {
      try {
        const accounts = await provider.send("eth_accounts", []);
        if (Array.isArray(accounts) && accounts.some((a) => a.toLowerCase() === owner.toLowerCase())) {
          ownerSigner = await provider.getSigner(owner);
        }
      } catch (_err) {
        ownerSigner = null;
      }
    }

    if (ownerSigner) {
      try {
        await sendWithNonce(ownerSigner, (overrides) =>
          roleToken.connect(ownerSigner).assignAdminRole(owner, adminWallet.address, overrides)
        );
        const roleVal = await roleToken.getRole(adminWallet.address);
        adminRoleStr = typeof roleVal === "object" && roleVal.toString ? roleVal.toString() : String(roleVal);
      } catch (err) {
        preManifestFailures.push({ stage: "grant_admin", message: sanitizeError(err) });
      }
    } else {
      preManifestFailures.push({ stage: "grant_admin", message: `owner signer unavailable for ${owner}` });
    }
  }

  const pghKey = process.env.PRIMARY_HEAD_KEY || "";
  const pghWalletAddress = pghKey ? new ethers.Wallet(pghKey).address : null;
  const pghBKey = process.env.PGH_B_KEY || "";
  const pghBWalletAddress = pghBKey ? new ethers.Wallet(pghBKey).address : (process.env.PGH_B_ADDRESS || null);

  const reservedAdmins = new Set(
    [pghWalletAddress, pghBWalletAddress].filter(Boolean).map((addr) => addr.toLowerCase())
  );

  if (reservedAdmins.has(adminWallet.address.toLowerCase()) && privateKeys) {
    const exclude = new Set([...reservedAdmins, adminWallet.address.toLowerCase()]);
    for (const addr of Object.keys(privateKeys)) {
      const lower = addr.toLowerCase();
      if (exclude.has(lower)) continue;
      try {
        const roleVal = await roleToken.getRole(addr);
        const roleStr = typeof roleVal === "object" && roleVal.toString ? roleVal.toString() : String(roleVal);
        if (roleStr === "1") {
          adminWallet = new ethers.Wallet(privateKeys[lower], provider);
          break;
        }
      } catch (_err) {
        // ignore and continue
      }
    }

    if (reservedAdmins.has(adminWallet.address.toLowerCase())) {
      const candidateEntry = Object.entries(privateKeys).find(([addr]) => {
        const lower = addr.toLowerCase();
        return !reservedAdmins.has(lower) && lower !== owner.toLowerCase();
      });
      if (candidateEntry) {
        const [candidateAddress, candidatePk] = candidateEntry;
        const candidateLower = candidateAddress.toLowerCase();
        try {
          const roleVal = await roleToken.getRole(candidateAddress);
          const roleStr = typeof roleVal === "object" && roleVal.toString ? roleVal.toString() : String(roleVal);
          if (roleStr !== "1") {
            await sendWithNonce(adminWallet, (overrides) =>
              roleToken.connect(adminWallet).assignAdminRole(adminWallet.address, candidateAddress, overrides)
            );
          }
          adminWallet = new ethers.Wallet(candidatePk, provider);
        } catch (err) {
          preManifestFailures.push({
            stage: "promote_dedicated_admin",
            target: candidateLower,
            message: sanitizeError(err),
          });
        }
      }
    }
  }

  const ensureAdminRoleForAddress = async (targetAddress, label) => {
    if (!targetAddress) return;
    const lower = targetAddress.toLowerCase();
    try {
      const roleVal = await roleToken.getRole(targetAddress);
      const roleStr = typeof roleVal === "object" && roleVal.toString ? roleVal.toString() : String(roleVal);
      if (roleStr === "1") return;
      await sendWithNonce(adminWallet, (overrides) =>
        roleToken.connect(adminWallet).assignAdminRole(adminWallet.address, targetAddress, overrides)
      );
    } catch (err) {
      const msg = sanitizeError(err);
      if (msg.toLowerCase().includes("already has a role")) return;
      preManifestFailures.push({
        stage: "ensure_pgh_admin_role",
        target: lower,
        label,
        message: msg,
      });
    }
  };

  await ensureAdminRoleForAddress(pghWalletAddress, "pgh_a");
  await ensureAdminRoleForAddress(pghBWalletAddress, "pgh_b");

  const contractRegistry = new Map();
  const addContract = (address, name, abi) => {
    if (!address) return;
    const lower = address.toLowerCase();
    contractRegistry.set(lower, { name, iface: new ethers.Interface(abi) });
  };

  addContract(addresses.roleToken, "RoleToken", abiRoleToken);
  addContract(addresses.roleBasedAccessControl, "RoleBasedAccessControl", abiRoleBased);
  addContract(addresses.accessControlFactory, "AccessControlFactory", abiFactory);
  addContract(addresses.registerContract, "RegisterContract", abiRegister);
  addContract(addresses.judgeContract, "JudgeContract", abiJudge);
  if (addresses.tableAccessControlContract && abiTac) {
    addContract(addresses.tableAccessControlContract, "TableAccessControlContract", abiTac);
  }

  const gasLogger = new GasLogger({ resultsDir: RESULTS_DIR, runId: RUN_ID });

  const manifest = {
    run_id: RUN_ID,
    started_at: nowUtc(),
    ended_at: null,
    git_commit: null,
    rpc_url: CONFIG.rpcUrl,
    chain_id: network.chainId?.toString?.() || String(network.chainId),
    block_range: { start: null, end: null },
    scenarios_generated: 0,
    iterations_per_scenario: null,
    malicious_rate: CONFIG.maliciousRate,
    knobs: {
      target_ops: CONFIG.targetOps,
      max_scenarios: CONFIG.maxScenarios,
      mode_b_enabled: CONFIG.modeBEnabled,
      extra_block_lookahead: CONFIG.extraBlockLookahead,
      extra_block_wait_ms: CONFIG.extraBlockWaitMs,
      inter_op_delay_ms: CONFIG.interOpDelayMs,
      scenario_ids: CONFIG.scenarioIds,
      scenario_group: CONFIG.scenarioGroup || null,
      scenario_repeat: CONFIG.scenarioRepeat,
      disable_random_fill: CONFIG.disableRandomFill,
      only_mode_b: CONFIG.onlyModeB,
      include_setup_in_scenario: CONFIG.includeSetupInScenario,
    },
    logical_operation_counts: {},
    failures: [],
    signer_topups: [],
    mode_b_status: { enabled: CONFIG.modeBEnabled, available: false, reason: null },
    scenario_execution_plan: [],
    scenario_summary_file: "scenario_summary.csv",
  };
  if (preManifestFailures.length) {
    manifest.failures.push(...preManifestFailures);
  }

  try {
    manifest.git_commit = execSync("git rev-parse HEAD", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch (_err) {
    manifest.git_commit = null;
  }

  const pghStatus = await checkPgh(CONFIG.pghBase);
  if (!pghStatus.ok) {
    manifest.failures.push({ stage: "pgh_check", message: `PGH not reachable at ${CONFIG.pghBase}: ${pghStatus.body}` });
    manifest.ended_at = nowUtc();
    fs.writeFileSync(path.join(RESULTS_DIR, "run_manifest.json"), JSON.stringify(manifest, null, 2));
    console.error(`PGH not reachable at ${CONFIG.pghBase}. Start PGH and rerun.`);
    process.exit(1);
  }

  let modeBAvailable = false;
  if (CONFIG.modeBEnabled) {
    const pghBStatus = await checkPgh(CONFIG.pghBBase);
    if (pghBStatus.ok) {
      modeBAvailable = true;
      manifest.mode_b_status.available = true;
    } else {
      manifest.mode_b_status.available = false;
      manifest.mode_b_status.reason = `PGH-B not reachable at ${CONFIG.pghBBase}: ${pghBStatus.body}`;
    }
  }

  const excluded = new Set([owner.toLowerCase(), adminWallet.address.toLowerCase()]);
  if (pghWalletAddress) excluded.add(pghWalletAddress.toLowerCase());
  if (process.env.PGH_B_KEY) {
    try {
      const pghBAddr = new ethers.Wallet(process.env.PGH_B_KEY).address;
      excluded.add(pghBAddr.toLowerCase());
    } catch (_err) {
      // ignore malformed key
    }
  }
  if (process.env.PGH_B_ADDRESS) {
    excluded.add(process.env.PGH_B_ADDRESS.toLowerCase());
  }
  for (const addr of Object.keys(privateKeys)) {
    const lower = addr.toLowerCase();
    if (excluded.has(lower)) continue;
    try {
      const roleVal = await roleToken.getRole(addr);
      const roleStr = typeof roleVal === "object" && roleVal.toString ? roleVal.toString() : String(roleVal);
      if (roleStr === "1") {
        excluded.add(lower);
      }
    } catch (_err) {
      // ignore lookup failures for exclusion pre-pass
    }
  }
  const poolEntries = [];
  for (const [addr, pk] of Object.entries(privateKeys)) {
    const lower = addr.toLowerCase();
    if (excluded.has(lower)) continue;
    try {
      const roleVal = await roleToken.getRole(addr);
      const roleStr = typeof roleVal === "object" && roleVal.toString ? roleVal.toString() : String(roleVal);
      if (roleStr !== "1") {
        poolEntries.push([addr, pk]);
      }
    } catch (_err) {
      // If role lookup fails, still allow the account into the scenario pool.
      poolEntries.push([addr, pk]);
    }
  }
  const poolKeys = Object.fromEntries(
    poolEntries.length
      ? poolEntries
      : Object.entries(privateKeys).filter(([addr]) => !excluded.has(addr.toLowerCase()))
  );
  if (!Object.keys(poolKeys).length) {
    console.error("No usable accounts available after excluding admin/PGH keys.");
    process.exit(1);
  }
  const accountPool = new AccountPool(poolKeys, roleToken, adminWallet, judgeContract, provider);
  const knownPrivateKeys = new Map();
  for (const [addr, pk] of Object.entries(privateKeys)) {
    if (pk) knownPrivateKeys.set(addr.toLowerCase(), pk);
  }
  if (adminPk) {
    knownPrivateKeys.set(adminWallet.address.toLowerCase(), adminPk);
  }
  if (pghKey) {
    try {
      const addr = new ethers.Wallet(pghKey).address.toLowerCase();
      knownPrivateKeys.set(addr, pghKey);
    } catch (_err) {
      // ignore malformed pgh key
    }
  }
  if (pghBKey) {
    try {
      const addr = new ethers.Wallet(pghBKey).address.toLowerCase();
      knownPrivateKeys.set(addr, pghBKey);
    } catch (_err) {
      // ignore malformed pgh-b key
    }
  }

  const walletForAddress = (address) => {
    if (!address) return null;
    const pk = knownPrivateKeys.get(String(address).toLowerCase());
    if (!pk) return null;
    try {
      return new ethers.Wallet(pk, provider);
    } catch (_err) {
      return null;
    }
  };

  const LOCAL_SIGNER_MIN_BALANCE_WEI = ethers.parseEther(CONFIG.localSignerMinBalanceEth);
  const LOCAL_SIGNER_TOP_UP_WEI = ethers.parseEther(CONFIG.localSignerTopUpEth);

  const ensureLocallyManagedWalletFunds = async (wallet, label = "local signer") => {
    if (!wallet?.address) return false;
    if (wallet.address.toLowerCase() === adminWallet.address.toLowerCase()) return false;

    const balance = await provider.getBalance(wallet.address);
    if (balance >= LOCAL_SIGNER_MIN_BALANCE_WEI) return false;

    const transferValue = LOCAL_SIGNER_TOP_UP_WEI > LOCAL_SIGNER_MIN_BALANCE_WEI
      ? LOCAL_SIGNER_TOP_UP_WEI
      : LOCAL_SIGNER_MIN_BALANCE_WEI;

    const { receipt } = await sendWithNonce(adminWallet, (overrides) => adminWallet.sendTransaction({
      to: wallet.address,
      value: transferValue,
      ...overrides,
    }));
    updateBlockRange(receipt);
    manifest.signer_topups.push({
      target: wallet.address.toLowerCase(),
      label,
      previous_balance_eth: ethers.formatEther(balance),
      top_up_amount_eth: ethers.formatEther(transferValue),
    });
    return true;
  };

  const sendWithManagedFunds = async (wallet, sendFn, label = "local signer") => {
    await ensureLocallyManagedWalletFunds(wallet, label);
    try {
      return await sendWithNonce(wallet, sendFn);
    } catch (err) {
      const message = sanitizeError(err).toLowerCase();
      if (!message.includes("insufficient funds")) {
        throw err;
      }
      await ensureLocallyManagedWalletFunds(wallet, `${label} retry`);
      return sendWithNonce(wallet, sendFn);
    }
  };

  let tacContract = null;
  const deployTacIfNeeded = async (reason) => {
    try {
      const tacArtifact = loadDeploymentArtifact("TableAccessControlContract");
      const factory = new ethers.ContractFactory(tacArtifact.abi, tacArtifact.bytecode, adminWallet);
      const tx = await factory.deploy(
        addresses.roleBasedAccessControl,
        addresses.judgeContract,
        addresses.registerContract,
        adminWallet.address
      );
      const receipt = await tx.wait();
      const newAddress = await tx.getAddress();
      try {
        await sendWithNonce(adminWallet, (overrides) => roleToken.connect(adminWallet).assignAdminRole(adminWallet.address, newAddress, overrides));
      } catch (grantErr) {
        const msg = sanitizeError(grantErr).toLowerCase();
        if (!msg.includes("already has a role")) {
          manifest.failures.push({ stage: "tac_deploy", message: `assignAdminRole TAC failed: ${sanitizeError(grantErr)}` });
        }
      }
      addresses.tableAccessControlContract = newAddress;
      const deployedPath = process.env.EVAL_DEPLOYED_ADDRESSES
        ? path.resolve(process.env.EVAL_DEPLOYED_ADDRESSES)
        : path.join(ROOT, "tmp", "deployed-addresses.json");
      try {
        const deployedJson = loadJson(deployedPath);
        if (deployedJson.addresses) {
          deployedJson.addresses.tableAccessControlContract = newAddress;
        } else {
          deployedJson.tableAccessControlContract = newAddress;
        }
        fs.writeFileSync(deployedPath, JSON.stringify(deployedJson, null, 2));
      } catch (_err) {
        // ignore file update errors
      }
      contractRegistry.set(newAddress.toLowerCase(), { name: "TableAccessControlContract", iface: new ethers.Interface(abiTac) });
      return new ethers.Contract(newAddress, abiTac, provider);
    } catch (err) {
      manifest.failures.push({ stage: "tac_deploy", message: sanitizeError(err) });
      return null;
    } finally {
      // no-op
    }
  };

  if (abiTac) {
    if (addresses.tableAccessControlContract) {
      try {
        await ensureDeployed(provider, "TableAccessControlContract", addresses.tableAccessControlContract);
        tacContract = new ethers.Contract(addresses.tableAccessControlContract, abiTac, provider);
      } catch (_err) {
        tacContract = await deployTacIfNeeded("existing TAC not deployed");
      }
    } else {
      tacContract = await deployTacIfNeeded("TAC address missing");
    }
  }

  if (tacContract) {
    try {
      let ownerTac = await tacContract.owner();
      let tacOwnerWallet = null;
      if (ownerTac.toLowerCase() === adminWallet.address.toLowerCase()) {
        tacOwnerWallet = adminWallet;
      } else {
        const tacOwnerKey = privateKeys[ownerTac.toLowerCase()];
        if (tacOwnerKey) {
          tacOwnerWallet = new ethers.Wallet(tacOwnerKey, provider);
        }
      }

      if (!tacOwnerWallet) {
        tacContract = await deployTacIfNeeded(`TAC owner key not available for ${ownerTac}`);
        if (tacContract) {
          ownerTac = await tacContract.owner();
          tacOwnerWallet = adminWallet;
        }
      }

      if (tacOwnerWallet) {
        try {
          await sendWithNonce(adminWallet, (overrides) => roleToken.connect(adminWallet).assignAdminRole(adminWallet.address, tacContract.target || tacContract.address, overrides));
        } catch (grantErr) {
          const msg = sanitizeError(grantErr).toLowerCase();
          if (!msg.includes("already has a role")) {
            manifest.failures.push({ stage: "tac_setup", message: `assignAdminRole existing TAC failed: ${sanitizeError(grantErr)}` });
          }
        }
        await sendWithManagedFunds(tacOwnerWallet, (overrides) => tacContract.connect(tacOwnerWallet).policyAdd(3, "LocalResourceTable", "view", "allow", overrides), `TAC bootstrap owner ${tacOwnerWallet.address}`);
        await sendWithManagedFunds(tacOwnerWallet, (overrides) => tacContract.connect(tacOwnerWallet).policyAdd(4, "LocalResourceTable", "view", "allow", overrides), `TAC bootstrap owner ${tacOwnerWallet.address}`);
        await sendWithManagedFunds(tacOwnerWallet, (overrides) => tacContract.connect(tacOwnerWallet).policyAdd(2, "GlobalResourceTable", "view", "allow", overrides), `TAC bootstrap owner ${tacOwnerWallet.address}`);
        await sendWithManagedFunds(tacOwnerWallet, (overrides) => tacContract.connect(tacOwnerWallet).policyAdd(3, "LocalResourceTable", "edit", "allow", overrides), `TAC bootstrap owner ${tacOwnerWallet.address}`);
        await sendWithManagedFunds(tacOwnerWallet, (overrides) => tacContract.connect(tacOwnerWallet).policyAdd(4, "LocalResourceTable", "edit", "allow", overrides), `TAC bootstrap owner ${tacOwnerWallet.address}`);
        await sendWithManagedFunds(tacOwnerWallet, (overrides) => tacContract.connect(tacOwnerWallet).policyAdd(2, "GlobalResourceTable", "edit", "allow", overrides), `TAC bootstrap owner ${tacOwnerWallet.address}`);
        await sendWithManagedFunds(tacOwnerWallet, (overrides) => tacContract.connect(tacOwnerWallet).policyAdd(2, "GlobalResourceTable", "delete", "allow", overrides), `TAC bootstrap owner ${tacOwnerWallet.address}`);
        await sendWithManagedFunds(tacOwnerWallet, (overrides) => tacContract.connect(tacOwnerWallet).policyAdd(3, "LocalResourceTable", "delete", "allow", overrides), `TAC bootstrap owner ${tacOwnerWallet.address}`);
        await sendWithManagedFunds(tacOwnerWallet, (overrides) => tacContract.connect(tacOwnerWallet).policyAdd(4, "LocalResourceTable", "delete", "allow", overrides), `TAC bootstrap owner ${tacOwnerWallet.address}`);
      } else {
        manifest.failures.push({ stage: "tac_setup", message: `TAC owner key not available for ${ownerTac}` });
        tacContract = null;
      }
    } catch (err) {
      manifest.failures.push({ stage: "tac_setup", message: sanitizeError(err) });
      tacContract = null;
    }
  }

  const seenTxHashes = new Set();
  let actionCounter = 0;
  let totalOperations = 0;

  const counts = manifest.logical_operation_counts;
  const recordCounts = (logicalOperation, behavior, mode) => {
    if (!counts[logicalOperation]) {
      counts[logicalOperation] = { total: 0, benign: 0, malicious: 0, modes: {} };
    }
    counts[logicalOperation].total += 1;
    if (behavior === "benign") counts[logicalOperation].benign += 1;
    if (behavior === "malicious") counts[logicalOperation].malicious += 1;
    counts[logicalOperation].modes[mode] = (counts[logicalOperation].modes[mode] || 0) + 1;
  };

  const updateBlockRange = (receipt) => {
    if (!receipt || receipt.blockNumber === null || receipt.blockNumber === undefined) return;
    const bn = Number(receipt.blockNumber);
    if (manifest.block_range.start === null || bn < manifest.block_range.start) {
      manifest.block_range.start = bn;
    }
    if (manifest.block_range.end === null || bn > manifest.block_range.end) {
      manifest.block_range.end = bn;
    }
  };

  const resolveResource = (scenarioCtx, baseResource) => {
    const key = baseResource || "default";
    if (!scenarioCtx.resourceMap.has(key)) {
      const tag = scenarioCtx.resourceTag;
      const resource = baseResource ? `${baseResource}/${tag}` : `resource/${tag}`;
      scenarioCtx.resourceMap.set(key, resource);
    }
    return scenarioCtx.resourceMap.get(key);
  };

  const resolveMemberType = (scenarioCtx, baseMemberType) => {
    const raw = (baseMemberType || "type1").trim();
    if (raw.includes("{scenario_tag}")) {
      return raw.replaceAll("{scenario_tag}", scenarioCtx.resourceTag);
    }
    if (raw === "type1" || raw === "type2") {
      return `${raw}_${scenarioCtx.resourceTag}_${MEMBER_TYPE_RUN_SUFFIX}`;
    }
    return raw;
  };

  const getEspActorKeys = (scenario) => new Set(Array.isArray(scenario?.espActorKeys) ? scenario.espActorKeys : []);

  const formatEspActionNote = (action) => {
    const parts = [
      `ESP bridge ${action.endpoint || "unknown_endpoint"}`,
      action.action ? `action=${action.action}` : null,
      action.decision ? `decision=${action.decision}` : null,
      action.mac ? `mac=${action.mac}` : null,
      action.resource ? `resource=${action.resource}` : null,
    ].filter(Boolean);
    return parts.join(" ");
  };

  const waitForEspBridge = async (scenarioCtx) => {
    const started = Date.now();
    while (Date.now() - started < CONFIG.espStartupTimeoutMs) {
      const child = scenarioCtx.esp?.process || null;
      if (child && child.exitCode !== null) {
        throw new Error(`ESP bridge sandbox exited early with code ${child.exitCode}; see ${scenarioCtx.esp.logPath}`);
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await getJson(scenarioCtx.esp.baseUrl, "/devices");
        if (res.status === 200 && Array.isArray(res.body)) {
          return res.body;
        }
      } catch (_err) {
        // keep polling
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(CONFIG.espPollIntervalMs);
    }
    throw new Error(`Timed out waiting for ESP bridge sandbox at ${scenarioCtx.esp.baseUrl}`);
  };

  const sortEspDevices = (devices) => devices
    .slice()
    .sort((a, b) => {
      const timeA = parseEspDbTimestampMs(a?.last_seen) ?? 0;
      const timeB = parseEspDbTimestampMs(b?.last_seen) ?? 0;
      return timeB - timeA;
    });

  const chooseEspActors = (devices, requestedActorKeys = new Set()) => {
    const sorted = sortEspDevices(devices);
    const byMac = new Map(sorted.map((device) => [normalizeMac(device.mac), device]));
    const requestedRequestor = normalizeMac(CONFIG.espRequestorMac);
    const requestedTarget = normalizeMac(CONFIG.espTargetMac);

    let helper = null;
    let compromised = null;
    let target = null;

    if (!requestedRequestor && !requestedTarget && requestedActorKeys.has("helper_esp")) {
      target = sorted[0] || null;
      helper = sorted[1] || null;
      compromised = sorted[2] || null;
      if (!target || !helper || !compromised) {
        throw new Error("ESP bridge source database must contain at least three distinct devices for the staged PoisonIvy flow");
      }
    } else {
      compromised = requestedRequestor ? byMac.get(requestedRequestor) : sorted[0];
      if (!compromised) {
        throw new Error("ESP bridge source database does not contain any devices to use as actors");
      }

      if (requestedTarget) {
        target = byMac.get(requestedTarget) || null;
      } else {
        target = sorted.find((device) => normalizeMac(device.mac) !== normalizeMac(compromised.mac)) || null;
      }
      if (!target) {
        throw new Error("ESP bridge source database must contain at least two distinct devices");
      }
    }

    if (!compromised) {
      throw new Error("ESP bridge source database does not contain any devices to use as actors");
    }

    const pickedMacs = new Set([
      normalizeMac(compromised.mac),
      normalizeMac(target.mac),
    ]);

    if (requestedActorKeys.has("helper_esp")) {
      helper = helper || sorted.find((device) => !pickedMacs.has(normalizeMac(device.mac))) || null;
      if (!helper) {
        throw new Error("ESP bridge source database must contain at least three distinct devices for helper_esp");
      }
      pickedMacs.add(normalizeMac(helper.mac));
    }

    return {
      compromised,
      target,
      helper,
    };
  };

  const fetchEspChainActions = async (scenarioCtx, query = {}) => {
    const res = await getJson(scenarioCtx.esp.baseUrl, "/chain/actions", {
      query: {
        limit: CONFIG.espChainActionLimit,
        ...query,
      },
    });
    if (res.status !== 200 || !Array.isArray(res.body)) {
      throw new Error(`ESP /chain/actions failed: ${JSON.stringify(res.body)}`);
    }
    return res.body.slice().sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
  };

  const getLatestEspChainActionId = async (scenarioCtx) => {
    const rows = await fetchEspChainActions(scenarioCtx, { limit: 1 });
    return rows.length ? Number(rows[rows.length - 1].id || 0) : 0;
  };

  const describeEspChainActionTxs = async (chainActions) => {
    const txDetails = [];
    const seen = new Set();
    for (const action of chainActions) {
      const responseJson = action?.response_json && typeof action.response_json === "object"
        ? action.response_json
        : null;
      const contractAddress = responseJson?.contractAddress || responseJson?.contract_address || null;
      if (contractAddress) {
        addContract(contractAddress, "AccessControlContract", abiAccess);
      }

      const txHash = action?.tx_hash || null;
      if (!txHash || seen.has(txHash)) continue;
      seen.add(txHash);

      // eslint-disable-next-line no-await-in-loop
      const detail = await describeTx(provider, txHash, contractRegistry, formatEspActionNote(action));
      const minedAtMs = parseEspDbTimestampMs(action.timestamp);
      const durationMsRaw = Number(action.duration_ms || 0);
      const durationMs = Number.isFinite(durationMsRaw) ? Math.max(durationMsRaw, 0) : 0;
      detail.sentAtMs = minedAtMs !== null ? minedAtMs - durationMs : null;
      detail.minedAtMs = minedAtMs;
      txDetails.push(detail);
    }
    return txDetails;
  };

  const fetchEspSummaryRows = async (scenarioCtx) => {
    const res = await getJson(scenarioCtx.esp.baseUrl, "/chain/esp-summary");
    if (res.status !== 200 || !Array.isArray(res.body)) {
      throw new Error(`ESP /chain/esp-summary failed: ${JSON.stringify(res.body)}`);
    }
    return res.body;
  };

  const setEspActorAccount = (scenarioCtx, actorKey, row) => {
    if (!row?.subject_address) return null;
    const mac = normalizeMac(row.mac);
    const existing = scenarioCtx.accounts[actorKey] || {};
    const account = {
      ...existing,
      label: actorKey,
      address: row.subject_address,
      mac,
      esp_bridge_managed: true,
    };
    scenarioCtx.accounts[actorKey] = account;
    scenarioCtx.esp.actorAddresses[actorKey] = row.subject_address;
    return account;
  };

  const refreshEspActorAccounts = async (scenarioCtx) => {
    const rows = await fetchEspSummaryRows(scenarioCtx);
    const byMac = new Map(rows.map((row) => [normalizeMac(row.mac), row]));
    for (const [actorKey, mac] of Object.entries(scenarioCtx.esp.actorMacs || {})) {
      const row = byMac.get(normalizeMac(mac));
      if (row) setEspActorAccount(scenarioCtx, actorKey, row);
    }
    return rows;
  };

  const getEspMacForKey = (scenarioCtx, key) => {
    const mac = scenarioCtx.esp?.actorMacs?.[key];
    if (!mac) {
      throw new Error(`ESP actor MAC not initialized for key ${key}`);
    }
    return mac;
  };

  const buildTelemetryPayload = (scenarioCtx, op) => {
    const key = op.deviceKey || op.targetKey || op.requestorKey;
    const mac = getEspMacForKey(scenarioCtx, key);
    const baseDevice = scenarioCtx.esp.devicesByMac[normalizeMac(mac)] || {};
    const temperature = op.temperature !== undefined
      ? Number(op.temperature)
      : Number(baseDevice.temperature ?? 24.0) + CONFIG.espRefreshTemperatureDelta;
    const humidity = op.humidity !== undefined
      ? Number(op.humidity)
      : Number(baseDevice.humidity ?? 55.0) + CONFIG.espRefreshHumidityDelta;
    if (!Number.isFinite(temperature) || !Number.isFinite(humidity)) {
      throw new Error(`Invalid telemetry payload for ${key} (${mac})`);
    }
    return { mac, temperature, humidity };
  };

  const buildEspChainActionSummary = (chainActions) => {
    if (!chainActions.length) return "no chain actions recorded";
    return chainActions
      .map((row) => `${row.endpoint || "?"}:${row.action || "?"}:${row.decision || "?"}`)
      .join("; ");
  };

  const extractThreatCodesFromValue = (value) => {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        return String(item.code || item.name || "").trim();
      })
      .filter(Boolean);
  };

  const extractEspThreatCodes = (chainActions) => {
    const codes = new Set();
    for (const action of chainActions || []) {
      const responseJson = action?.response_json && typeof action.response_json === "object"
        ? action.response_json
        : null;
      const fromPgh = extractThreatCodesFromValue(responseJson?.pgh?.threats);
      const direct = extractThreatCodesFromValue(responseJson?.threats);
      for (const code of [...fromPgh, ...direct]) {
        codes.add(code);
      }
    }
    return Array.from(codes);
  };

  const formatEspThreatSummary = (threatCodes) => (
    Array.isArray(threatCodes) && threatCodes.length
      ? `threats=${threatCodes.join(",")}`
      : "threats=none"
  );

  const appendSegments = (...segments) => segments.filter(Boolean).join(". ");

  const buildEspTimingPoints = (response, txDetails) => {
    const sorted = (txDetails || []).slice().sort((a, b) => {
      const sentA = a.sentAtMs ?? Number.MAX_SAFE_INTEGER;
      const sentB = b.sentAtMs ?? Number.MAX_SAFE_INTEGER;
      return sentA - sentB;
    });
    return {
      requestSentMs: response?.timing?.startMs ?? null,
      requestReceivedMs: null,
      blockchainSubmitMs: sorted[0]?.sentAtMs ?? null,
      blockchainMinedMs: sorted.length ? sorted[sorted.length - 1].minedAtMs ?? null : null,
      responseReturnedMs: response?.timing?.endMs ?? null,
    };
  };

  const advanceChainPastJudgeBlock = async (address, minimumSeconds = 0) => {
    const extra = Math.max(0, Number(minimumSeconds || 0));
    if (!address || !judgeContract) {
      if (extra > 0) {
        await provider.send("evm_increaseTime", [extra]);
        await provider.send("evm_mine", []);
      }
      return extra;
    }

    const latestBlock = await provider.getBlock("latest");
    const nowTs = Number(latestBlock?.timestamp || Math.floor(Date.now() / 1000));
    let delta = extra;

    try {
      const blockingEndTime = await judgeContract.getBlockingEndTime(address);
      const endTs = Number(blockingEndTime?.toString?.() ?? blockingEndTime ?? 0);
      if (Number.isFinite(endTs) && endTs >= nowTs) {
        delta = Math.max(delta, (endTs - nowTs) + 1);
      }
    } catch (_err) {
      // Fall back to the caller-provided delta only.
    }

    if (delta > 0) {
      await provider.send("evm_increaseTime", [delta]);
      await provider.send("evm_mine", []);
    }
    return delta;
  };

  const ensureEspBridgeScenario = async (scenarioCtx, scenario) => {
    if (scenarioCtx.esp?.ready) return scenarioCtx.esp;
    if (!fs.existsSync(CONFIG.espSourceDb)) {
      throw new Error(`ESP source database not found: ${CONFIG.espSourceDb}`);
    }
    if (!fs.existsSync(CONFIG.espApiScript)) {
      throw new Error(`ESP API script not found: ${CONFIG.espApiScript}`);
    }

    const scenarioSlug = `${scenarioCtx.scenarioId}-${scenarioCtx.iteration}`.replace(/[^a-zA-Z0-9._-]/g, "_");
    const sandboxDir = path.join(CONFIG.espSandboxRoot, RUN_ID, scenarioSlug);
    fs.mkdirSync(sandboxDir, { recursive: true });

    const sandboxDb = path.join(sandboxDir, "esp_data.db");
    fs.copyFileSync(CONFIG.espSourceDb, sandboxDb);
    resetEspSandboxDb(CONFIG.espPythonBin, sandboxDb);
    reserveEspSandboxAccounts(
      CONFIG.espPythonBin,
      sandboxDb,
      [
        adminWallet.address,
        ...Object.entries(scenarioCtx.accounts)
          .filter(([key, account]) => !getEspActorKeys(scenario).has(key) && account?.address)
          .map(([, account]) => account.address),
      ]
    );

    const port = await findFreePort(CONFIG.espPortBase + Number(scenarioCtx.iteration || 0), CONFIG.espHost);
    const baseUrl = `http://${CONFIG.espHost}:${port}`;
    const logPath = path.join(sandboxDir, "esp_bridge.log");
    const logFd = fs.openSync(logPath, "a");
    const objectAddress = scenarioCtx.accounts.object?.address || "";
    const child = spawn(CONFIG.espPythonBin, [CONFIG.espApiScript], {
      cwd: ROOT,
      env: {
        ...process.env,
        ESP_DB_FILE: sandboxDb,
        ESP_API_HOST: CONFIG.espHost,
        ESP_API_PORT: String(port),
        PRIMARY_GROUP_ID: `eval-${scenarioCtx.iteration}-pgh-a`,
        PGH_API_BASE: CONFIG.pghBase,
        PGH_OBJECT_ADDRESS: objectAddress,
        PGH_DB_OBJECT_ADDRESS: objectAddress,
        PGH_ACC_TYPE: DEFAULT_ACC_TYPE,
        RPC_URL: CONFIG.rpcUrl,
        GANACHE_KEYS_PATH: keysPath,
        ALLOW_OFFLINE_IDENTITY: "0",
        AUTO_REGISTER_REQUESTOR: "1",
        PEER_GROUPS_JSON: "[]",
        ALLOWED_PEER_IPS_JSON: "[]",
      },
      stdio: ["ignore", logFd, logFd],
    });
    ACTIVE_CHILD_PROCESSES.add(child);

    scenarioCtx.esp = {
      ready: false,
      baseUrl,
      port,
      sandboxDir,
      sandboxDb,
      sourceDb: CONFIG.espSourceDb,
      logPath,
      logFd,
      process: child,
      actorMacs: {},
      actorAddresses: {},
      devicesByMac: {},
      usesCopiedDb: true,
    };

    child.once("exit", () => {
      ACTIVE_CHILD_PROCESSES.delete(child);
      try {
        fs.closeSync(logFd);
      } catch (_err) {
        // ignore repeated closes
      }
    });

    const devices = await waitForEspBridge(scenarioCtx);
    const espActorKeys = getEspActorKeys(scenario);
    const actors = chooseEspActors(devices, espActorKeys);
    scenarioCtx.esp.actorMacs.compromised_esp = normalizeMac(actors.compromised.mac);
    scenarioCtx.esp.actorMacs.target_esp = normalizeMac(actors.target.mac);
    if (actors.helper) {
      scenarioCtx.esp.actorMacs.helper_esp = normalizeMac(actors.helper.mac);
    }
    scenarioCtx.esp.devicesByMac = Object.fromEntries(
      devices.map((device) => [normalizeMac(device.mac), { ...device, mac: normalizeMac(device.mac) }])
    );

    for (const actorKey of espActorKeys) {
      const mac = scenarioCtx.esp.actorMacs[actorKey] || null;
      scenarioCtx.accounts[actorKey] = {
        ...(scenarioCtx.accounts[actorKey] || {}),
        label: actorKey,
        address: null,
        mac,
        esp_bridge_managed: true,
      };
    }

    scenarioCtx.esp.ready = true;
    return scenarioCtx.esp;
  };

  const stopEspBridgeScenario = async (scenarioCtx) => {
    const esp = scenarioCtx?.esp;
    if (!esp?.process) return;
    const child = esp.process;
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      const exited = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 1500);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!exited && child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch (_err) {
          // ignore kill race
        }
      }
    }
    ACTIVE_CHILD_PROCESSES.delete(child);
    try {
      if (esp.logFd !== undefined && esp.logFd !== null) {
        fs.closeSync(esp.logFd);
      }
    } catch (_err) {
      // ignore repeated closes
    }
  };

  const resolveAccessRoute = (scenarioCtx, op) => {
    if (scenarioCtx.mode === "pgh_pgh") {
      const target = op.target || "A";
      const baseUrl = target === "B" ? CONFIG.pghBBase : CONFIG.pghABase;
      const objectKey = op.objectKey || (target === "B" ? "pghB_object" : "pghA_object");
      const subjectKey = op.subjectKey || (target === "B" ? "pghB_subject" : "pghA_subject");
      const objectAccount = scenarioCtx.accounts[objectKey];
      const subjectAccount = scenarioCtx.accounts[subjectKey];
      if (!objectAccount || !subjectAccount) {
        throw new Error(`Missing accounts for access route target=${target} objectKey=${objectKey} subjectKey=${subjectKey}`);
      }
      return {
        targetKey: target,
        baseUrl,
        objectKey,
        subjectKey,
        objectAccount,
        subjectAccount,
      };
    }

    const targetKey = op.target || "A";
    const baseUrl = CONFIG.pghBase;
    const objectKey = op.objectKey || "object";
    const subjectKey = op.subjectKey || "subject";
    const objectAccount = scenarioCtx.accounts[objectKey];
    const subjectAccount = scenarioCtx.accounts[subjectKey];
    if (!objectAccount || !subjectAccount) {
      throw new Error(`Missing accounts for access route objectKey=${objectKey} subjectKey=${subjectKey}`);
    }
    return {
      targetKey,
      baseUrl,
      objectKey,
      subjectKey,
      objectAccount,
      subjectAccount,
    };
  };

  const inferPghFromAccountKey = (key, fallback) => {
    if (!key) return fallback;
    if (key.startsWith("pghA")) return "PGH_A";
    if (key.startsWith("pghB")) return "PGH_B";
    return fallback;
  };

  const fallbackActorForMode = (scenarioCtx) => {
    if (scenarioCtx.mode === "pgh_pgh") {
      return scenarioCtx.accounts.pghB_subject || scenarioCtx.accounts.pghA_subject || null;
    }
    return scenarioCtx.accounts.subject || null;
  };

  const ensureAccessContract = async (scenarioCtx, targetKey, baseUrl, objectAddr, subjectAddr) => {
    const cacheKey = `${targetKey}:${String(objectAddr).toLowerCase()}:${String(subjectAddr).toLowerCase()}`;
    if (!scenarioCtx.accessContracts[cacheKey]) {
      const existing = await registerContract.getAccessControlContract(objectAddr, subjectAddr, DEFAULT_ACC_TYPE);
      if (existing && existing !== ZERO_ADDRESS) {
        scenarioCtx.accessContracts[cacheKey] = existing;
        addContract(existing, "AccessControlContract", abiAccess);
        return { address: existing, deployTxHash: null, deployTiming: null };
      }
      const res = await postJson(baseUrl, "/deploy-contract", {
        objectAddress: objectAddr,
        subjectAddress: subjectAddr,
        accType: DEFAULT_ACC_TYPE,
      });
      if (res.status !== 200) {
        throw new Error(`deploy-contract failed: ${JSON.stringify(res.body)}`);
      }
      const contractAddress = res.body.contractAddress || res.body.contract_address || null;
      if (!contractAddress) {
        throw new Error("deploy-contract returned no contractAddress");
      }
      const txHash = extractTxHash(res.body);
      if (txHash) {
        const receipt = await provider.getTransactionReceipt(txHash);
        updateBlockRange(receipt);
      }
      scenarioCtx.accessContracts[cacheKey] = contractAddress;
      addContract(contractAddress, "AccessControlContract", abiAccess);
      return { address: contractAddress, deployTxHash: txHash || null, deployTiming: res.timing || null };
    }
    return { address: scenarioCtx.accessContracts[cacheKey], deployTxHash: null, deployTiming: null };
  };

  const logAction = async ({
    scenarioId,
    scenarioGroup,
    iteration,
    mode,
    logicalOperation,
    scenarioStage,
    behavior,
    measuredAs,
    outcome,
    outcomeReason,
    notes,
    txDetails,
    actionStartMs,
    actionEndMs,
    httpLatencyMs,
    scenarioStartMs,
    scenarioEndMs,
    networkMeta,
    timingPoints,
  }) => {
    const actionInstanceId = `${RUN_ID}-${String(actionCounter).padStart(6, "0")}`;
    actionCounter += 1;
    const correlationId = actionInstanceId;
    const net = networkMeta || {};
    const timing = timingPoints || {};

    const sortedTxs = (txDetails || []).slice().sort((a, b) => {
      const blockA = a.receipt?.blockNumber ?? 0;
      const blockB = b.receipt?.blockNumber ?? 0;
      if (blockA !== blockB) return blockA - blockB;
      const idxA = a.receipt?.transactionIndex ?? 0;
      const idxB = b.receipt?.transactionIndex ?? 0;
      return idxA - idxB;
    });

    let totalGas = 0n;
    let totalFee = 0n;
    let txCount = sortedTxs.length;
    const involvedContracts = new Set();
    const involvedFunctions = new Set();
    const judgeEventNames = new Set();
    const aggregatedJudgeMetrics = createJudgeMetrics();
    const startMs = actionStartMs ?? null;
    const endMs = actionEndMs ?? null;
    const actionStartUtc = startMs !== null ? msToUtc(startMs) : null;
    const actionEndUtc = endMs !== null ? msToUtc(endMs) : null;
    const actionDurationMs = startMs !== null && endMs !== null ? endMs - startMs : null;
    let earliestSentMs = null;
    let latestMinedMs = null;
    let outOfGasCount = 0;

    for (let i = 0; i < sortedTxs.length; i += 1) {
      const detail = sortedTxs[i];
      const gasUsed = detail.gasUsed ?? null;
      const effPrice = detail.effectiveGasPrice ?? null;
      const feePaid = detail.feePaidWei ?? null;
      if (gasUsed) totalGas += gasUsed;
      if (feePaid) totalFee += feePaid;
      if (detail.outOfGas) outOfGasCount += 1;

      involvedContracts.add(detail.contractName || "Unknown");
      involvedFunctions.add(detail.functionName || "unknown");
      for (const emittedContract of detail.emittedContracts || []) {
        if (emittedContract) involvedContracts.add(emittedContract);
      }
      for (const judgeEventName of detail.emittedJudgeEvents || []) {
        if (judgeEventName) judgeEventNames.add(judgeEventName);
      }
      mergeJudgeMetrics(aggregatedJudgeMetrics, detail.judgeMetrics);

      const sentMs = detail.sentAtMs ?? startMs ?? null;
      const minedMs = detail.minedAtMs ?? endMs ?? null;
      const txLatencyMs = sentMs !== null && minedMs !== null ? minedMs - sentMs : null;
      const txElapsedMs = startMs !== null && minedMs !== null ? minedMs - startMs : null;
      const outOfGasLatencyMs = detail.outOfGas && txLatencyMs !== null ? txLatencyMs : null;
      if (sentMs !== null) {
        if (earliestSentMs === null || sentMs < earliestSentMs) earliestSentMs = sentMs;
      }
      if (minedMs !== null) {
        if (latestMinedMs === null || minedMs > latestMinedMs) latestMinedMs = minedMs;
      }

      const requestSentMs = timing.requestSentMs ?? startMs ?? null;
      const requestReceivedMs = timing.requestReceivedMs
        ?? (requestSentMs !== null && httpLatencyMs !== null && httpLatencyMs !== undefined ? requestSentMs + httpLatencyMs : null);
      const pghForwardStartMs = timing.pghForwardStartMs ?? null;
      const pghForwardEndMs = timing.pghForwardEndMs ?? null;
      const blockchainSubmitMs = sentMs ?? timing.blockchainSubmitMs ?? earliestSentMs ?? null;
      const blockchainMinedMs = minedMs ?? timing.blockchainMinedMs ?? latestMinedMs ?? null;
      const responseReturnedMs = timing.responseReturnedMs ?? endMs ?? requestReceivedMs ?? null;
      const scenarioEndResolvedMs = scenarioEndMs ?? endMs ?? responseReturnedMs ?? null;
      const endToEndMs = diffMs(requestSentMs, responseReturnedMs);
      const blockchainConfirmMsDerived = diffMs(blockchainSubmitMs, blockchainMinedMs);
      const communicationBackAndForthMs = endToEndMs !== null
        ? Math.max(0, endToEndMs - (blockchainConfirmMsDerived || 0))
        : (httpLatencyMs ?? null);
      const txJudgeFields = formatJudgeMetrics(detail.judgeMetrics);

      gasLogger.logTx({
        timestamp_utc: nowUtc(),
        run_id: RUN_ID,
        scenario_id: scenarioId,
        scenario_group: scenarioGroup || "",
        iteration,
        mode,
        logical_operation: logicalOperation,
        scenario_stage: scenarioStage || "",
        behavior,
        action_instance_id: actionInstanceId,
        correlation_id: correlationId,
        request_method: net.requestMethod || "",
        endpoint_route: net.endpointRoute || "",
        source_actor: net.sourceActor || "",
        destination_actor: net.destinationActor || "",
        source_pgh: net.sourcePgh || "",
        destination_pgh: net.destinationPgh || "",
        request_sent_utc: requestSentMs !== null ? msToUtc(requestSentMs) : "",
        request_received_utc: requestReceivedMs !== null ? msToUtc(requestReceivedMs) : "",
        pgh_forward_start_utc: pghForwardStartMs !== null ? msToUtc(pghForwardStartMs) : "",
        pgh_forward_end_utc: pghForwardEndMs !== null ? msToUtc(pghForwardEndMs) : "",
        blockchain_submit_utc: blockchainSubmitMs !== null ? msToUtc(blockchainSubmitMs) : "",
        blockchain_mined_utc: blockchainMinedMs !== null ? msToUtc(blockchainMinedMs) : "",
        response_returned_utc: responseReturnedMs !== null ? msToUtc(responseReturnedMs) : "",
        communication_back_and_forth_ms: communicationBackAndForthMs !== null ? communicationBackAndForthMs : "",
        blockchain_processing_ms: blockchainConfirmMsDerived !== null ? blockchainConfirmMsDerived : "",
        tx_index: i + 1,
        contract_name: detail.contractName || "Unknown",
        function_name: detail.functionName || "unknown",
        from_account: detail.tx?.from || null,
        to_contract: detail.tx?.to || null,
        tx_hash: detail.tx?.hash || null,
        block_number: detail.receipt?.blockNumber ?? null,
        gas_used: bigintToString(gasUsed),
        gas_limit: bigintToString(detail.gasLimit ?? null),
        effective_gas_price: bigintToString(effPrice),
        fee_paid_wei: bigintToString(feePaid),
        status: detail.receipt?.status ?? null,
        revert_reason: detail.revertReason || null,
        out_of_gas: detail.outOfGas ? 1 : 0,
        ...txJudgeFields,
        zero_gas_reason: "",
        notes: detail.note || "",
        scenario_start_utc: scenarioStartMs !== null && scenarioStartMs !== undefined ? msToUtc(scenarioStartMs) : "",
        scenario_end_utc: scenarioEndResolvedMs !== null ? msToUtc(scenarioEndResolvedMs) : "",
        action_start_utc: actionStartUtc || "",
        action_end_utc: actionEndUtc || "",
        action_duration_ms: actionDurationMs !== null ? actionDurationMs : "",
        tx_sent_utc: sentMs !== null ? msToUtc(sentMs) : "",
        tx_mined_utc: minedMs !== null ? msToUtc(minedMs) : "",
      });

      if (detail.tx?.hash) {
        seenTxHashes.add(detail.tx.hash);
      }
      updateBlockRange(detail.receipt);
    }

    const requestSentMs = timing.requestSentMs ?? startMs ?? null;
    const requestReceivedMs = timing.requestReceivedMs
      ?? (requestSentMs !== null && httpLatencyMs !== null && httpLatencyMs !== undefined ? requestSentMs + httpLatencyMs : null);
    const pghForwardStartMs = timing.pghForwardStartMs ?? null;
    const pghForwardEndMs = timing.pghForwardEndMs ?? null;
    const blockchainSubmitMs = timing.blockchainSubmitMs ?? earliestSentMs ?? null;
    const blockchainMinedMs = timing.blockchainMinedMs ?? latestMinedMs ?? null;
    const responseReturnedMs = timing.responseReturnedMs ?? endMs ?? requestReceivedMs ?? null;
    const chainConfirmMs = diffMs(blockchainSubmitMs, blockchainMinedMs);
    const endToEndMs = diffMs(requestSentMs, responseReturnedMs);
    const communicationBackAndForthMs = endToEndMs !== null
      ? Math.max(0, endToEndMs - (chainConfirmMs || 0))
      : (httpLatencyMs ?? null);
    const scenarioEndResolvedMs = scenarioEndMs ?? endMs ?? responseReturnedMs ?? null;
    const totalScenarioElapsedMs = diffMs(scenarioStartMs, scenarioEndResolvedMs);
    const zeroGasReason = (txCount === 0 && totalGas === 0n)
      ? (outcomeReason || measuredAs || "no_onchain_tx")
      : "";

    const finalOutcomeReason = outOfGasCount > 0
      ? `${outcomeReason || "tx failed"}; out_of_gas_count=${outOfGasCount}`
      : (outcomeReason || "");
    let finalNotes = outOfGasCount > 0
      ? `${notes || ""} Out-of-gas transactions detected: ${outOfGasCount}. See tx rows for details.`
      : (notes || "");
    if (judgeEventNames.size) {
      const judgeNote = `Judge events observed in receipt logs: ${Array.from(judgeEventNames).join(",")}.`;
      finalNotes = finalNotes ? `${finalNotes} ${judgeNote}` : judgeNote;
    }
    if (aggregatedJudgeMetrics.penaltyEventCount > 0 || aggregatedJudgeMetrics.blockEventCount > 0 || aggregatedJudgeMetrics.rewardEventCount > 0) {
      const judgeSegments = [];
      if (aggregatedJudgeMetrics.penaltyEventCount > 0) {
        judgeSegments.push(`judge_penalties=${aggregatedJudgeMetrics.penaltyEventCount}`);
        judgeSegments.push(`judge_penalty_amount_total=${bigintToString(aggregatedJudgeMetrics.penaltyAmountTotal)}`);
      }
      if (aggregatedJudgeMetrics.blockEventCount > 0) {
        judgeSegments.push(`judge_blocks=${aggregatedJudgeMetrics.blockEventCount}`);
        if (aggregatedJudgeMetrics.latestBlockingEndTs !== null) {
          judgeSegments.push(`judge_block_until=${secToUtc(aggregatedJudgeMetrics.latestBlockingEndTs)}`);
        }
      }
      if (aggregatedJudgeMetrics.rewardEventCount > 0) {
        judgeSegments.push(`judge_rewards=${aggregatedJudgeMetrics.rewardEventCount}`);
        judgeSegments.push(`judge_reward_amount_total=${bigintToString(aggregatedJudgeMetrics.rewardAmountTotal)}`);
      }
      if (aggregatedJudgeMetrics.statusUpdates.size) {
        judgeSegments.push(`judge_status_updates=${Array.from(aggregatedJudgeMetrics.statusUpdates).join("|")}`);
      }
      if (aggregatedJudgeMetrics.penaltyReasons.size) {
        judgeSegments.push(`judge_penalty_reasons=${Array.from(aggregatedJudgeMetrics.penaltyReasons).join("|")}`);
      }
      finalNotes = finalNotes ? `${finalNotes} ${judgeSegments.join(". ")}.` : `${judgeSegments.join(". ")}.`;
    }
    const actionJudgeFields = formatJudgeMetrics(aggregatedJudgeMetrics);

    const actionRow = {
      timestamp_utc: nowUtc(),
      run_id: RUN_ID,
      scenario_id: scenarioId,
      scenario_group: scenarioGroup || "",
      iteration,
      mode,
      logical_operation: logicalOperation,
      scenario_stage: scenarioStage || "",
      behavior,
      action_instance_id: actionInstanceId,
      correlation_id: correlationId,
      request_method: net.requestMethod || "",
      endpoint_route: net.endpointRoute || "",
      source_actor: net.sourceActor || "",
      destination_actor: net.destinationActor || "",
      source_pgh: net.sourcePgh || "",
      destination_pgh: net.destinationPgh || "",
      tx_count: txCount,
      total_gas_used: bigintToString(totalGas),
      total_fee_paid_wei: bigintToString(totalFee),
      outcome: outcome || "unknown",
      outcome_reason: finalOutcomeReason,
      involved_contracts: Array.from(involvedContracts).join(","),
      involved_functions: Array.from(involvedFunctions).join(","),
      measured_as: measuredAs || (txCount === 0 ? "no_onchain_tx" : "onchain_tx"),
      out_of_gas_count: outOfGasCount,
      ...actionJudgeFields,
      zero_gas_reason: zeroGasReason,
      request_sent_utc: requestSentMs !== null ? msToUtc(requestSentMs) : "",
      request_received_utc: requestReceivedMs !== null ? msToUtc(requestReceivedMs) : "",
      pgh_forward_start_utc: pghForwardStartMs !== null ? msToUtc(pghForwardStartMs) : "",
      pgh_forward_end_utc: pghForwardEndMs !== null ? msToUtc(pghForwardEndMs) : "",
      blockchain_submit_utc: blockchainSubmitMs !== null ? msToUtc(blockchainSubmitMs) : "",
      blockchain_mined_utc: blockchainMinedMs !== null ? msToUtc(blockchainMinedMs) : "",
      response_returned_utc: responseReturnedMs !== null ? msToUtc(responseReturnedMs) : "",
      communication_back_and_forth_ms: communicationBackAndForthMs !== null ? communicationBackAndForthMs : "",
      blockchain_processing_ms: chainConfirmMs !== null ? chainConfirmMs : "",
      scenario_start_utc: scenarioStartMs !== null && scenarioStartMs !== undefined ? msToUtc(scenarioStartMs) : "",
      scenario_end_utc: scenarioEndResolvedMs !== null ? msToUtc(scenarioEndResolvedMs) : "",
      total_scenario_elapsed_ms: totalScenarioElapsedMs !== null ? totalScenarioElapsedMs : "",
      notes: finalNotes,
      action_start_utc: actionStartUtc || "",
      action_end_utc: actionEndUtc || "",
      action_duration_ms: actionDurationMs !== null ? actionDurationMs : "",
    };

    gasLogger.logAction(actionRow);

    recordCounts(logicalOperation, behavior, mode);
    totalOperations += 1;
    return {
      ...actionRow,
      total_gas_bigint: totalGas,
      total_fee_bigint: totalFee,
      involved_contracts_set: involvedContracts,
      involved_functions_set: involvedFunctions,
      judge_metrics: aggregatedJudgeMetrics,
    };
  };

  const executeRoleAssignment = async (scenarioCtx, op, baseUrl, account) => {
    const actionStartMs = Date.now();
    const endpointRoute = "/register-device";
    const memberType = resolveMemberType(scenarioCtx, op.memberType || "type1");
    const payload = {
      deviceAddress: account.address,
      name: `${op.actor || "device"}-${scenarioCtx.scenarioId}-${scenarioCtx.iteration}`,
      memberType,
    };
    const res = await postJsonWithRetry(baseUrl, endpointRoute, payload, { attempts: 3, retryDelayMs: 400 });
    const txHash = extractTxHash(res.body);
    const txs = [];
    if (txHash) {
      const detail = await describeTx(provider, txHash, contractRegistry, `PGH registered ${account.address} as ${payload.memberType} via assignRole.`);
      detail.sentAtMs = res.timing?.startMs ?? null;
      detail.minedAtMs = res.timing?.endMs ?? null;
      txs.push(detail);
    }
    const outcome = res.status === 200 ? "success" : "denied";
    const outcomeReason = res.status === 200 ? "role assigned" : (res.body?.message || JSON.stringify(res.body));
    const notes = op.behavior === "malicious"
      ? `Duplicate registration attempt for ${account.address}. PGH detected existing role and returned ${res.status}; no on-chain tx when rejected.`
      : (res.status === 200
        ? `PGH registered ${account.address} (${payload.name}) into memberType ${payload.memberType}.`
        : `Role assignment failed for ${account.address} (${payload.name}); PGH returned ${res.status} after ${res.attempts || 1} attempt(s).`);

    const sourcePgh = baseUrl === CONFIG.pghBBase ? "PGH_B" : "PGH_A";
    const nowMs = Date.now();
    const actionRow = await logAction({
      scenarioId: scenarioCtx.scenarioId,
      scenarioGroup: scenarioCtx.scenarioGroup,
      iteration: scenarioCtx.iteration,
      mode: scenarioCtx.mode,
      logicalOperation: "Role Assignment",
      scenarioStage: op.stage || "",
      behavior: op.behavior,
      measuredAs: txHash ? "onchain_tx" : "no_onchain_tx",
      outcome,
      outcomeReason,
      notes,
      txDetails: txs,
      actionStartMs,
      actionEndMs: Date.now(),
      httpLatencyMs: res.timing?.latencyMs ?? null,
      scenarioStartMs: scenarioCtx.scenarioStartMs,
      scenarioEndMs: nowMs,
      networkMeta: {
        requestMethod: "POST",
        endpointRoute,
        sourceActor: account.address,
        destinationActor: payload.deviceAddress,
        sourcePgh,
        destinationPgh: sourcePgh,
      },
      timingPoints: {
        requestSentMs: res.timing?.startMs ?? actionStartMs,
        requestReceivedMs: res.timing?.endMs ?? nowMs,
        blockchainSubmitMs: txs[0]?.sentAtMs ?? null,
        blockchainMinedMs: txs[0]?.minedAtMs ?? null,
        responseReturnedMs: res.timing?.endMs ?? nowMs,
      },
    });
    if (res.status !== 200 && op.behavior !== "malicious") {
      manifest.failures.push({
        scenario_id: scenarioCtx.scenarioId,
        iteration: scenarioCtx.iteration,
        logical_operation: "Role Assignment",
        message: `register-device failed: ${JSON.stringify(res.body)}`,
      });
    }
    return actionRow;
  };

  const executePolicyAdd = async (scenarioCtx, op, targetKey, baseUrl, objectAddr, subjectAddr, subjectAccount, actorOverride) => {
    const actionStartMs = Date.now();
    const resource = resolveResource(scenarioCtx, op.resource);
    const permission = op.permission || "allow";
    const action = op.action || "view";

    const { address: accessAddr, deployTxHash, deployTiming } = await ensureAccessContract(scenarioCtx, targetKey, baseUrl, objectAddr, subjectAddr);

    if (op.behavior === "benign") {
      const res = await postJsonWithRetry(baseUrl, "/policies", {
        objectAddress: objectAddr,
        subjectAddress: subjectAddr,
        accType: DEFAULT_ACC_TYPE,
        resource,
        action,
        permission,
      }, { attempts: 3, retryDelayMs: 450 });
      const txHash = extractTxHash(res.body);
      const txs = [];
      if (deployTxHash) {
        const deployDetail = await describeTx(provider, deployTxHash, contractRegistry, `Deployed AccessControlContract for ${subjectAddr} -> ${objectAddr} (${DEFAULT_ACC_TYPE}).`);
        deployDetail.sentAtMs = deployTiming?.startMs ?? null;
        deployDetail.minedAtMs = deployTiming?.endMs ?? null;
        txs.push(deployDetail);
      }
      if (txHash) {
        const detail = await describeTx(provider, txHash, contractRegistry, `PGH added policy ${permission} for ${resource}:${action}.`);
        detail.sentAtMs = res.timing?.startMs ?? null;
        detail.minedAtMs = res.timing?.endMs ?? null;
        txs.push(detail);
      }
      const outcome = res.status === 200 ? "success" : "denied";
      const outcomeReason = res.status === 200 ? "policy added" : (res.body?.message || JSON.stringify(res.body));
      const notes = `Policy add via PGH on AccessControlContract ${accessAddr}. Resource=${resource}, action=${action}, permission=${permission}. attempts=${res.attempts || 1}.`;
      const sourcePgh = baseUrl === CONFIG.pghBBase ? "PGH_B" : "PGH_A";
      const requestSentMs = Math.min(
        deployTiming?.startMs ?? Number.MAX_SAFE_INTEGER,
        res.timing?.startMs ?? Number.MAX_SAFE_INTEGER,
        actionStartMs
      );
      const requestReceivedMs = Math.max(
        deployTiming?.endMs ?? 0,
        res.timing?.endMs ?? 0
      );
      const deploySent = txs.find((txd) => (txd.note || "").startsWith("Deployed AccessControlContract"))?.sentAtMs ?? null;
      const deployMined = txs.find((txd) => (txd.note || "").startsWith("Deployed AccessControlContract"))?.minedAtMs ?? null;
      const policySent = txs.find((txd) => (txd.note || "").startsWith("PGH added policy"))?.sentAtMs ?? null;
      const policyMined = txs.find((txd) => (txd.note || "").startsWith("PGH added policy"))?.minedAtMs ?? null;
      const blockchainSubmitMs = deploySent ?? policySent ?? null;
      const blockchainMinedMs = policyMined ?? deployMined ?? null;

      const actionRow = await logAction({
        scenarioId: scenarioCtx.scenarioId,
        scenarioGroup: scenarioCtx.scenarioGroup,
        iteration: scenarioCtx.iteration,
        mode: scenarioCtx.mode,
        logicalOperation: "Policy Add",
        scenarioStage: op.stage || "",
        behavior: op.behavior,
        measuredAs: txs.length ? "onchain_tx" : "no_onchain_tx",
        outcome,
        outcomeReason,
        notes,
        txDetails: txs,
        actionStartMs,
        actionEndMs: Date.now(),
        httpLatencyMs: (deployTiming?.latencyMs || 0) + (res.timing?.latencyMs || 0),
        scenarioStartMs: scenarioCtx.scenarioStartMs,
        scenarioEndMs: Date.now(),
        networkMeta: {
          requestMethod: "POST",
          endpointRoute: deployTiming ? "/deploy-contract -> /policies" : "/policies",
          sourceActor: objectAddr,
          destinationActor: subjectAddr,
          sourcePgh,
          destinationPgh: sourcePgh,
        },
        timingPoints: {
          requestSentMs,
          requestReceivedMs,
          blockchainSubmitMs,
          blockchainMinedMs,
          responseReturnedMs: requestReceivedMs,
        },
      });
      return actionRow;
    } else {
      const actorAccount = actorOverride || subjectAccount;
      const actorWallet = new ethers.Wallet(actorAccount.privateKey, provider);
      const accessContract = new ethers.Contract(accessAddr, abiAccess, actorWallet);
      const { tx, receipt, sentAtMs, minedAtMs } = await sendWithManagedFunds(
        actorWallet,
        (overrides) => accessContract.policyAdd(resource, action, permission, overrides),
        `policyAdd signer ${actorWallet.address}`
      );
      const txs = [];
      if (deployTxHash) {
        const deployDetail = await describeTx(provider, deployTxHash, contractRegistry, `Deployed AccessControlContract for ${subjectAddr} -> ${objectAddr} (${DEFAULT_ACC_TYPE}).`);
        deployDetail.sentAtMs = deployTiming?.startMs ?? null;
        deployDetail.minedAtMs = deployTiming?.endMs ?? null;
        txs.push(deployDetail);
      }
      const detail = await describeTx(provider, tx.hash, contractRegistry, `Unauthorized policy add attempt by ${actorAccount.address}. onlyCreator path penalized.`);
      detail.sentAtMs = sentAtMs ?? null;
      detail.minedAtMs = minedAtMs ?? null;
      txs.push(detail);
      const outcome = "penalized";
      const outcomeReason = "onlyCreator unauthorized policy add";
      const notes = `Non-creator ${actorAccount.address} attempted policyAdd on ${accessAddr}. Contract emitted malicious activity and returned without adding policy.`;
      const sourcePgh = baseUrl === CONFIG.pghBBase ? "PGH_B" : "PGH_A";
      const requestSentMs = deployTiming?.startMs ?? actionStartMs;
      const requestReceivedMs = deployTiming?.endMs ?? Date.now();

      const actionRow = await logAction({
        scenarioId: scenarioCtx.scenarioId,
        scenarioGroup: scenarioCtx.scenarioGroup,
        iteration: scenarioCtx.iteration,
        mode: scenarioCtx.mode,
        logicalOperation: "Policy Add",
        scenarioStage: op.stage || "",
        behavior: op.behavior,
        measuredAs: "onchain_tx",
        outcome,
        outcomeReason,
        notes,
        txDetails: txs,
        actionStartMs,
        actionEndMs: Date.now(),
        httpLatencyMs: deployTiming?.latencyMs ?? null,
        scenarioStartMs: scenarioCtx.scenarioStartMs,
        scenarioEndMs: Date.now(),
        networkMeta: {
          requestMethod: deployTiming ? "POST+RPC" : "RPC",
          endpointRoute: deployTiming ? "/deploy-contract -> direct.policyAdd" : "direct.policyAdd",
          sourceActor: actorAccount.address,
          destinationActor: accessAddr,
          sourcePgh,
          destinationPgh: sourcePgh,
        },
        timingPoints: {
          requestSentMs,
          requestReceivedMs,
          blockchainSubmitMs: detail.sentAtMs ?? null,
          blockchainMinedMs: detail.minedAtMs ?? null,
          responseReturnedMs: Date.now(),
        },
      });
      updateBlockRange(receipt);
      return actionRow;
    }
  };

  const executeAccessContractDirectOperation = async (scenarioCtx, op) => {
    const actionStartMs = Date.now();
    const route = resolveAccessRoute(scenarioCtx, op);
    const { targetKey, baseUrl, objectAccount, subjectAccount } = route;
    const resource = resolveResource(scenarioCtx, op.resource);
    const action = op.action || "view";
    const permission = op.permission || "allow";
    const policyId = Number(op.policyId || 0);
    const judgeAddress = op.judgeAddress || addresses.judgeContract;
    const { address: accessAddr, deployTxHash, deployTiming } = await ensureAccessContract(
      scenarioCtx,
      targetKey,
      baseUrl,
      objectAccount.address,
      subjectAccount.address
    );
    const accessContract = new ethers.Contract(accessAddr, abiAccess, provider);
    let actor = null;
    let actorWallet = null;
    const creatorAddress = await accessContract.creator();
    const creatorWallet = walletForAddress(creatorAddress);
    const objectMatchesCreator = objectAccount?.address
      && String(objectAccount.address).toLowerCase() === String(creatorAddress).toLowerCase();

    if (op.behavior === "benign") {
      if (op.actorKey && scenarioCtx.accounts[op.actorKey]) {
        actor = scenarioCtx.accounts[op.actorKey];
        actorWallet = new ethers.Wallet(actor.privateKey, provider);
      } else if (creatorWallet) {
        actor = { address: creatorAddress };
        actorWallet = creatorWallet;
      } else if (String(adminWallet.address).toLowerCase() === String(creatorAddress).toLowerCase()) {
        actor = { address: adminWallet.address };
        actorWallet = adminWallet;
      } else if (objectMatchesCreator && objectAccount?.privateKey) {
        actor = objectAccount;
        actorWallet = new ethers.Wallet(objectAccount.privateKey, provider);
      } else {
        throw new Error(`No local signer available for AccessControlContract creator ${creatorAddress}`);
      }
    } else {
      actor = (op.actorKey && scenarioCtx.accounts[op.actorKey]) || fallbackActorForMode(scenarioCtx) || subjectAccount;
      actorWallet = new ethers.Wallet(actor.privateKey, provider);
    }

    const txs = [];
    if (deployTxHash) {
      const deployDetail = await describeTx(provider, deployTxHash, contractRegistry, `Deployed AccessControlContract for ${subjectAccount.address} -> ${objectAccount.address} (${DEFAULT_ACC_TYPE}).`);
      deployDetail.sentAtMs = deployTiming?.startMs ?? null;
      deployDetail.minedAtMs = deployTiming?.endMs ?? null;
      txs.push(deployDetail);
    }

    let callDescription = "";
    let endpointRoute = "";
    let submitFn;
    if (op.op === "Policy Update") {
      callDescription = `policyUpdate(${policyId}, ${resource}, ${action}, ${permission})`;
      endpointRoute = "direct.policyUpdate";
      submitFn = (overrides) => accessContract.connect(actorWallet).policyUpdate(policyId, resource, action, permission, overrides);
    } else if (op.op === "Policy Delete") {
      callDescription = `policyDelete(${policyId})`;
      endpointRoute = "direct.policyDelete";
      submitFn = (overrides) => accessContract.connect(actorWallet).policyDelete(policyId, overrides);
    } else if (op.op === "Access Contract Deactivate") {
      callDescription = "deactivateContract()";
      endpointRoute = "direct.deactivateContract";
      submitFn = (overrides) => accessContract.connect(actorWallet).deactivateContract(overrides);
    } else if (op.op === "Access Contract Activate") {
      callDescription = "activateContract()";
      endpointRoute = "direct.activateContract";
      submitFn = (overrides) => accessContract.connect(actorWallet).activateContract(overrides);
    } else if (op.op === "Access Contract Set Judge") {
      callDescription = `setJudgeContract(${judgeAddress})`;
      endpointRoute = "direct.setJudgeContract";
      submitFn = (overrides) => accessContract.connect(actorWallet).setJudgeContract(judgeAddress, overrides);
    } else {
      throw new Error(`Unsupported access-contract direct operation: ${op.op}`);
    }

    const { tx, receipt, sentAtMs, minedAtMs } = await sendWithManagedFunds(
      actorWallet,
      submitFn,
      `${op.op} signer ${actorWallet.address}`
    );
    const detail = await describeTx(
      provider,
      tx.hash,
      contractRegistry,
      `${callDescription} executed on AccessControlContract ${accessAddr} by ${actor?.address || actorWallet.address}.`
    );
    detail.sentAtMs = sentAtMs ?? null;
    detail.minedAtMs = minedAtMs ?? null;
    txs.push(detail);

    const succeeded = receipt?.status === 1;
    const benignExpected = op.behavior === "benign";
    const creatorMatch = actorWallet?.address?.toLowerCase() === String(creatorAddress).toLowerCase();
    const authorizedExpectation = benignExpected && creatorMatch;
    const outcome = succeeded ? (authorizedExpectation ? "success" : "penalized") : (benignExpected ? "failed" : "denied");
    const outcomeReason = succeeded
      ? (authorizedExpectation ? "state updated by direct call" : "malicious/unauthorized path executed")
      : (detail.revertReason || "transaction reverted");
    const notes = benignExpected
      ? `Direct AccessControlContract call ${callDescription} executed to expand contract-function coverage without changing architecture. signer_is_creator=${creatorMatch}.`
      : `Malicious direct call ${callDescription} executed by ${actor?.address || actorWallet.address} to capture unauthorized or vulnerable path behavior.`;
    const sourcePgh = route.baseUrl === CONFIG.pghBBase ? "PGH_B" : "PGH_A";

    const actionRow = await logAction({
      scenarioId: scenarioCtx.scenarioId,
      scenarioGroup: scenarioCtx.scenarioGroup,
      iteration: scenarioCtx.iteration,
      mode: scenarioCtx.mode,
      logicalOperation: op.op,
      scenarioStage: op.stage || "",
      behavior: op.behavior || "benign",
      measuredAs: "onchain_tx",
      outcome,
      outcomeReason,
      notes,
      txDetails: txs,
      actionStartMs,
      actionEndMs: Date.now(),
      httpLatencyMs: deployTiming?.latencyMs ?? null,
      scenarioStartMs: scenarioCtx.scenarioStartMs,
      scenarioEndMs: Date.now(),
      networkMeta: {
        requestMethod: deployTxHash ? "POST+RPC" : "RPC",
        endpointRoute: deployTxHash ? "/deploy-contract -> direct.accessContract" : endpointRoute,
        sourceActor: actor?.address || actorWallet.address,
        destinationActor: accessAddr,
        sourcePgh,
        destinationPgh: sourcePgh,
      },
      timingPoints: {
        requestSentMs: deployTiming?.startMs ?? sentAtMs ?? actionStartMs,
        requestReceivedMs: deployTiming?.endMs ?? null,
        blockchainSubmitMs: txs[0]?.sentAtMs ?? sentAtMs ?? null,
        blockchainMinedMs: txs[txs.length - 1]?.minedAtMs ?? minedAtMs ?? null,
        responseReturnedMs: txs[txs.length - 1]?.minedAtMs ?? minedAtMs ?? Date.now(),
      },
    });
    updateBlockRange(receipt);
    return actionRow;
  };

  const executeRoleAdminOperation = async (scenarioCtx, op) => {
    const actionStartMs = Date.now();
    const txs = [];
    let actorWallet = adminWallet;
    let actorAddress = adminWallet.address;
    if (op.behavior === "malicious") {
      const actor = (op.actorKey && scenarioCtx.accounts[op.actorKey]) || fallbackActorForMode(scenarioCtx);
      if (!actor) {
        throw new Error("No actor available for malicious role operation");
      }
      actorWallet = new ethers.Wallet(actor.privateKey, provider);
      actorAddress = actor.address;
    }

    const account1 = op.account1Key ? scenarioCtx.accounts[op.account1Key] : null;
    const account2 = op.account2Key ? scenarioCtx.accounts[op.account2Key] : null;
    const targetAccount = op.targetKey ? scenarioCtx.accounts[op.targetKey] : null;
    const amount = Number(op.amount || 1);
    const newStatus = op.status || "BENIGN";

    let endpointRoute = "";
    let callDescription = "";
    let submitFn;
    if (op.op === "Role Swap") {
      if (!account1 || !account2) {
        throw new Error("Role Swap requires account1Key and account2Key");
      }
      endpointRoute = "direct.roleBased.swapRole";
      callDescription = `swapRole(${account1.address}, ${account2.address})`;
      submitFn = (overrides) => roleBased.connect(actorWallet).swapRole(account1.address, account2.address, overrides);
    } else if (op.op === "Role Revoke") {
      if (!targetAccount) {
        throw new Error("Role Revoke requires targetKey");
      }
      endpointRoute = "direct.roleBased.revokeRole";
      callDescription = `revokeRole(${targetAccount.address})`;
      submitFn = (overrides) => roleBased.connect(actorWallet).revokeRole(targetAccount.address, overrides);
    } else if (op.op === "Role Status Update") {
      if (!targetAccount) {
        throw new Error("Role Status Update requires targetKey");
      }
      endpointRoute = "direct.roleBased.updateMemberStatus";
      callDescription = `updateMemberStatus(${targetAccount.address}, ${newStatus})`;
      submitFn = (overrides) => roleBased.connect(actorWallet).updateMemberStatus(targetAccount.address, newStatus, overrides);
    } else if (op.op === "Role Penalize") {
      if (!targetAccount) {
        throw new Error("Role Penalize requires targetKey");
      }
      endpointRoute = "direct.roleBased.penalizeMember";
      callDescription = `penalizeMember(${targetAccount.address}, ${amount})`;
      submitFn = (overrides) => roleBased.connect(actorWallet).penalizeMember(targetAccount.address, amount, overrides);
    } else if (op.op === "Role Reward") {
      if (!targetAccount) {
        throw new Error("Role Reward requires targetKey");
      }
      endpointRoute = "direct.roleBased.rewardMember";
      callDescription = `rewardMember(${targetAccount.address}, ${amount})`;
      submitFn = (overrides) => roleBased.connect(actorWallet).rewardMember(targetAccount.address, amount, overrides);
    } else {
      throw new Error(`Unsupported role operation ${op.op}`);
    }

    const { tx, receipt, sentAtMs, minedAtMs } = await sendWithManagedFunds(
      actorWallet,
      submitFn,
      `${op.op} signer ${actorAddress}`
    );
    const detail = await describeTx(
      provider,
      tx.hash,
      contractRegistry,
      `RoleBasedAccessControl ${callDescription} called by ${actorAddress}.`
    );
    detail.sentAtMs = sentAtMs ?? null;
    detail.minedAtMs = minedAtMs ?? null;
    txs.push(detail);

    const succeeded = receipt?.status === 1;
    const outcome = succeeded
      ? (op.behavior === "benign" ? "success" : "penalized")
      : (op.behavior === "benign" ? "failed" : "denied");
    const outcomeReason = succeeded
      ? "role-management state transition executed"
      : (detail.revertReason || "transaction reverted");
    const notes = op.behavior === "benign"
      ? `Admin role-management operation ${callDescription} executed to cover RoleBasedAccessControl write path.`
      : `Unauthorized role-management attempt ${callDescription} by ${actorAddress} captured for malicious-path gas/timing.`;

    const actionRow = await logAction({
      scenarioId: scenarioCtx.scenarioId,
      scenarioGroup: scenarioCtx.scenarioGroup,
      iteration: scenarioCtx.iteration,
      mode: scenarioCtx.mode,
      logicalOperation: op.op,
      scenarioStage: op.stage || "",
      behavior: op.behavior || "benign",
      measuredAs: "onchain_tx",
      outcome,
      outcomeReason,
      notes,
      txDetails: txs,
      actionStartMs,
      actionEndMs: Date.now(),
      httpLatencyMs: null,
      scenarioStartMs: scenarioCtx.scenarioStartMs,
      scenarioEndMs: Date.now(),
      networkMeta: {
        requestMethod: "RPC",
        endpointRoute,
        sourceActor: actorAddress,
        destinationActor: addresses.roleBasedAccessControl,
        sourcePgh: scenarioCtx.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
        destinationPgh: scenarioCtx.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
      },
      timingPoints: {
        requestSentMs: sentAtMs ?? actionStartMs,
        blockchainSubmitMs: sentAtMs ?? null,
        blockchainMinedMs: minedAtMs ?? null,
        responseReturnedMs: minedAtMs ?? Date.now(),
      },
    });
    updateBlockRange(receipt);
    return actionRow;
  };

  const executeRegisterSetJudgeOperation = async (scenarioCtx, op) => {
    const actionStartMs = Date.now();
    const txs = [];
    const desiredJudge = op.judgeAddress || addresses.judgeContract;
    let actorWallet = null;
    let actorAddress = null;
    const registerOwner = await registerContract.owner();

    if (op.behavior === "benign") {
      actorWallet = walletForAddress(registerOwner) || (registerOwner.toLowerCase() === adminWallet.address.toLowerCase() ? adminWallet : null);
      actorAddress = actorWallet?.address || registerOwner;
    } else {
      const actor = (op.actorKey && scenarioCtx.accounts[op.actorKey]) || fallbackActorForMode(scenarioCtx);
      if (!actor) {
        throw new Error("No actor available for Register Set Judge Contract malicious path");
      }
      actorWallet = new ethers.Wallet(actor.privateKey, provider);
      actorAddress = actor.address;
    }

    if (!actorWallet) {
      return logAction({
        scenarioId: scenarioCtx.scenarioId,
        scenarioGroup: scenarioCtx.scenarioGroup,
        iteration: scenarioCtx.iteration,
        mode: scenarioCtx.mode,
        logicalOperation: op.op,
        scenarioStage: op.stage || "",
        behavior: op.behavior || "benign",
        measuredAs: "no_onchain_tx",
        outcome: "unavailable",
        outcomeReason: `owner wallet unavailable for RegisterContract owner ${registerOwner}`,
        notes: "Skipped RegisterContract.setJudgeContractAddress because owner private key is unavailable in local key registry.",
        txDetails: [],
        actionStartMs,
        actionEndMs: Date.now(),
        httpLatencyMs: null,
        scenarioStartMs: scenarioCtx.scenarioStartMs,
        scenarioEndMs: Date.now(),
        networkMeta: {
          requestMethod: "RPC",
          endpointRoute: "direct.register.setJudgeContractAddress",
          sourceActor: actorAddress || "",
          destinationActor: addresses.registerContract,
          sourcePgh: scenarioCtx.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
          destinationPgh: scenarioCtx.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
        },
        timingPoints: {
          requestSentMs: actionStartMs,
          responseReturnedMs: Date.now(),
        },
      });
    }

    const { tx, receipt, sentAtMs, minedAtMs } = await sendWithManagedFunds(
      actorWallet,
      (overrides) => registerContract.connect(actorWallet).setJudgeContractAddress(desiredJudge, overrides),
      `RegisterContract.setJudgeContractAddress signer ${actorAddress}`
    );
    const detail = await describeTx(
      provider,
      tx.hash,
      contractRegistry,
      `RegisterContract.setJudgeContractAddress(${desiredJudge}) called by ${actorAddress}.`
    );
    detail.sentAtMs = sentAtMs ?? null;
    detail.minedAtMs = minedAtMs ?? null;
    txs.push(detail);

    const succeeded = receipt?.status === 1;
    const outcome = succeeded
      ? (op.behavior === "benign" ? "success" : "penalized")
      : (op.behavior === "benign" ? "failed" : "denied");
    const outcomeReason = succeeded
      ? "register contract judge pointer updated"
      : (detail.revertReason || "transaction reverted");
    const notes = op.behavior === "benign"
      ? "Owner-level RegisterContract path executed to include setJudgeContractAddress in dataset coverage."
      : "Unauthorized RegisterContract.setJudgeContractAddress attempt captured for threat-path gas/timing.";

    const actionRow = await logAction({
      scenarioId: scenarioCtx.scenarioId,
      scenarioGroup: scenarioCtx.scenarioGroup,
      iteration: scenarioCtx.iteration,
      mode: scenarioCtx.mode,
      logicalOperation: op.op,
      scenarioStage: op.stage || "",
      behavior: op.behavior || "benign",
      measuredAs: "onchain_tx",
      outcome,
      outcomeReason,
      notes,
      txDetails: txs,
      actionStartMs,
      actionEndMs: Date.now(),
      httpLatencyMs: null,
      scenarioStartMs: scenarioCtx.scenarioStartMs,
      scenarioEndMs: Date.now(),
      networkMeta: {
        requestMethod: "RPC",
        endpointRoute: "direct.register.setJudgeContractAddress",
        sourceActor: actorAddress,
        destinationActor: addresses.registerContract,
        sourcePgh: scenarioCtx.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
        destinationPgh: scenarioCtx.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
      },
      timingPoints: {
        requestSentMs: sentAtMs ?? actionStartMs,
        blockchainSubmitMs: sentAtMs ?? null,
        blockchainMinedMs: minedAtMs ?? null,
        responseReturnedMs: minedAtMs ?? Date.now(),
      },
    });
    updateBlockRange(receipt);
    return actionRow;
  };

  const parseTacRequestId = (receipt) => {
    if (!receipt || !tacContract) return null;
    const tacAddress = (tacContract.target || tacContract.address || "").toLowerCase();
    for (const log of receipt.logs || []) {
      if (!log.address || log.address.toLowerCase() !== tacAddress) continue;
      try {
        const parsed = tacContract.interface.parseLog(log);
        if (parsed.name === "AccessRequestCreated") {
          return parsed.args[0];
        }
      } catch (_err) {
        // ignore non-TAC logs
      }
    }
    return null;
  };

  const executeTablePolicyOperation = async (scenarioCtx, op) => {
    const actionStartMs = Date.now();
    if (!tacContract) {
      return logAction({
        scenarioId: scenarioCtx.scenarioId,
        scenarioGroup: scenarioCtx.scenarioGroup,
        iteration: scenarioCtx.iteration,
        mode: scenarioCtx.mode,
        logicalOperation: op.op,
        scenarioStage: op.stage || "",
        behavior: op.behavior || "benign",
        measuredAs: "no_onchain_tx",
        outcome: "unavailable",
        outcomeReason: "TableAccessControlContract missing",
        notes: "Skipped TAC policy operation because TableAccessControlContract is unavailable.",
        txDetails: [],
        actionStartMs,
        actionEndMs: Date.now(),
        httpLatencyMs: null,
        scenarioStartMs: scenarioCtx.scenarioStartMs,
        scenarioEndMs: Date.now(),
        networkMeta: {
          requestMethod: "RPC",
          endpointRoute: "direct.tac.policy",
          sourceActor: "",
          destinationActor: "",
          sourcePgh: scenarioCtx.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
          destinationPgh: scenarioCtx.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
        },
        timingPoints: {
          requestSentMs: actionStartMs,
          responseReturnedMs: Date.now(),
        },
      });
    }

    const tacOwner = await tacContract.owner();
    const ownerWallet = walletForAddress(tacOwner) || (tacOwner.toLowerCase() === adminWallet.address.toLowerCase() ? adminWallet : null);
    if (!ownerWallet) {
      return logAction({
        scenarioId: scenarioCtx.scenarioId,
        scenarioGroup: scenarioCtx.scenarioGroup,
        iteration: scenarioCtx.iteration,
        mode: scenarioCtx.mode,
        logicalOperation: op.op,
        scenarioStage: op.stage || "",
        behavior: op.behavior || "benign",
        measuredAs: "no_onchain_tx",
        outcome: "unavailable",
        outcomeReason: `TAC owner key unavailable for ${tacOwner}`,
        notes: "Skipped TAC owner-only operation because owner private key is unavailable.",
        txDetails: [],
        actionStartMs,
        actionEndMs: Date.now(),
        httpLatencyMs: null,
        scenarioStartMs: scenarioCtx.scenarioStartMs,
        scenarioEndMs: Date.now(),
        networkMeta: {
          requestMethod: "RPC",
          endpointRoute: "direct.tac.policy",
          sourceActor: tacOwner,
          destinationActor: tacContract.target || tacContract.address,
          sourcePgh: scenarioCtx.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
          destinationPgh: scenarioCtx.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
        },
        timingPoints: {
          requestSentMs: actionStartMs,
          responseReturnedMs: Date.now(),
        },
      });
    }

    const txs = [];
    const resource = op.resource || "LocalResourceTable";
    const action = op.action || "view";
    const permission = op.permission || "allow";
    const policyId = Number(op.policyId || 0);
    const role = Number(op.role || 3);

    let endpointRoute = "";
    let callDescription = "";
    let submitFn;
    if (op.op === "Table Policy Update") {
      endpointRoute = "direct.tac.policyUpdate";
      callDescription = `policyUpdate(${policyId}, ${role}, ${resource}, ${action}, ${permission})`;
      submitFn = (overrides) => tacContract.connect(ownerWallet).policyUpdate(policyId, role, resource, action, permission, overrides);
    } else if (op.op === "Table Policy Delete") {
      endpointRoute = "direct.tac.policyDelete";
      callDescription = `policyDelete(${policyId})`;
      submitFn = (overrides) => tacContract.connect(ownerWallet).policyDelete(policyId, overrides);
    } else {
      throw new Error(`Unsupported table policy operation ${op.op}`);
    }

    const { tx, receipt, sentAtMs, minedAtMs } = await sendWithManagedFunds(
      ownerWallet,
      submitFn,
      `TAC owner signer ${ownerWallet.address}`
    );
    const detail = await describeTx(provider, tx.hash, contractRegistry, `TableAccessControlContract ${callDescription} by owner ${ownerWallet.address}.`);
    detail.sentAtMs = sentAtMs ?? null;
    detail.minedAtMs = minedAtMs ?? null;
    txs.push(detail);

    const succeeded = receipt?.status === 1;
    const actionRow = await logAction({
      scenarioId: scenarioCtx.scenarioId,
      scenarioGroup: scenarioCtx.scenarioGroup,
      iteration: scenarioCtx.iteration,
      mode: scenarioCtx.mode,
      logicalOperation: op.op,
      scenarioStage: op.stage || "",
      behavior: op.behavior || "benign",
      measuredAs: "onchain_tx",
      outcome: succeeded ? "success" : "failed",
      outcomeReason: succeeded ? "table policy state updated" : (detail.revertReason || "transaction reverted"),
      notes: `Owner-level TAC policy operation ${callDescription} executed for function-surface coverage.`,
      txDetails: txs,
      actionStartMs,
      actionEndMs: Date.now(),
      httpLatencyMs: null,
      scenarioStartMs: scenarioCtx.scenarioStartMs,
      scenarioEndMs: Date.now(),
      networkMeta: {
        requestMethod: "RPC",
        endpointRoute,
        sourceActor: ownerWallet.address,
        destinationActor: tacContract.target || tacContract.address,
        sourcePgh: scenarioCtx.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
        destinationPgh: scenarioCtx.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
      },
      timingPoints: {
        requestSentMs: sentAtMs ?? actionStartMs,
        blockchainSubmitMs: sentAtMs ?? null,
        blockchainMinedMs: minedAtMs ?? null,
        responseReturnedMs: minedAtMs ?? Date.now(),
      },
    });
    updateBlockRange(receipt);
    return actionRow;
  };

  const executeTableMutationOperation = async (scenarioCtx, op) => {
    const actionStartMs = Date.now();
    if (!tacContract) {
      return logAction({
        scenarioId: scenarioCtx.scenarioId,
        scenarioGroup: scenarioCtx.scenarioGroup,
        iteration: scenarioCtx.iteration,
        mode: scenarioCtx.mode,
        logicalOperation: op.op,
        scenarioStage: op.stage || "",
        behavior: op.behavior || "benign",
        measuredAs: "no_onchain_tx",
        outcome: "unavailable",
        outcomeReason: "TableAccessControlContract missing",
        notes: "Skipped table mutation operation because TAC is unavailable.",
        txDetails: [],
        actionStartMs,
        actionEndMs: Date.now(),
        httpLatencyMs: null,
        scenarioStartMs: scenarioCtx.scenarioStartMs,
        scenarioEndMs: Date.now(),
        networkMeta: {
          requestMethod: "RPC",
          endpointRoute: "direct.tac.mutation",
          sourceActor: "",
          destinationActor: "",
          sourcePgh: scenarioCtx.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
          destinationPgh: scenarioCtx.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
        },
        timingPoints: {
          requestSentMs: actionStartMs,
          responseReturnedMs: Date.now(),
        },
      });
    }

    const txs = [];
    const scope = op.scope || (op.op.includes("Global") ? "global" : "local");
    const mutationAction = op.mutationAction
      || (op.op.includes("Edit") ? "edit" : "delete");
    const resource = scope === "global" ? "GlobalResourceTable" : "LocalResourceTable";
    const requesterKey = op.requesterKey || (scope === "global" ? "object" : "subject");
    const requesterAccount = scenarioCtx.accounts[requesterKey] || fallbackActorForMode(scenarioCtx);
    if (!requesterAccount) {
      throw new Error(`No requester account available for ${op.op}`);
    }
    const requesterWallet = new ethers.Wallet(requesterAccount.privateKey, provider);
    const tacRequester = tacContract.connect(requesterWallet);

    const { tx: createTx, receipt: createReceipt, sentAtMs: createSentMs, minedAtMs: createMinedMs } = await sendWithManagedFunds(
      requesterWallet,
      (overrides) => tacRequester.createAccessRequest(resource, mutationAction, overrides),
      `TAC requester ${requesterAccount.address}`
    );
    const createDetail = await describeTx(
      provider,
      createTx.hash,
      contractRegistry,
      `createAccessRequest(${resource}, ${mutationAction}) by ${requesterAccount.address}.`
    );
    createDetail.sentAtMs = createSentMs ?? null;
    createDetail.minedAtMs = createMinedMs ?? null;
    txs.push(createDetail);
    updateBlockRange(createReceipt);

    const requestId = parseTacRequestId(createReceipt);
    const approverAccounts = [];
    if (Array.isArray(op.approverKeys)) {
      for (const key of op.approverKeys) {
        if (scenarioCtx.accounts[key]) approverAccounts.push(scenarioCtx.accounts[key]);
      }
    } else if (op.behavior === "benign") {
      if (scope === "global") {
        if (scenarioCtx.accounts.primary2) approverAccounts.push(scenarioCtx.accounts.primary2);
      } else if (scenarioCtx.accounts.object) {
        approverAccounts.push(scenarioCtx.accounts.object);
      }
    }

    if (op.behavior === "benign" && requestId !== null && approverAccounts.length) {
      for (const approver of approverAccounts) {
        const approverWallet = new ethers.Wallet(approver.privateKey, provider);
        const tacApprover = tacContract.connect(approverWallet);
        const { tx: approveTx, receipt: approveReceipt, sentAtMs: approveSentMs, minedAtMs: approveMinedMs } = await sendWithManagedFunds(
          approverWallet,
          (overrides) => tacApprover.handleAccessRequest(requestId, true, overrides),
          `TAC approver ${approver.address}`
        );
        const approveDetail = await describeTx(
          provider,
          approveTx.hash,
          contractRegistry,
          `handleAccessRequest(${requestId}, true) by ${approver.address}.`
        );
        approveDetail.sentAtMs = approveSentMs ?? null;
        approveDetail.minedAtMs = approveMinedMs ?? null;
        txs.push(approveDetail);
        updateBlockRange(approveReceipt);
      }
    }

    const account1 = op.account1Key ? scenarioCtx.accounts[op.account1Key] : null;
    const account2 = op.account2Key ? scenarioCtx.accounts[op.account2Key] : null;
    const target = op.targetAccountKey ? scenarioCtx.accounts[op.targetAccountKey] : null;
    let endpointRoute = "";
    let callDescription = "";
    let submitMutation;
    if (op.op === "Table Edit Local Resource") {
      if (!account1 || !account2) throw new Error("Table Edit Local Resource requires account1Key and account2Key");
      endpointRoute = "direct.tac.editLocalResourceTable";
      callDescription = `editLocalResourceTable(${account1.address}, ${account2.address})`;
      submitMutation = (overrides) => tacRequester.editLocalResourceTable(account1.address, account2.address, overrides);
    } else if (op.op === "Table Edit Global Resource") {
      if (!account1 || !account2) throw new Error("Table Edit Global Resource requires account1Key and account2Key");
      endpointRoute = "direct.tac.editGlobalResourceTable";
      callDescription = `editGlobalResourceTable(${account1.address}, ${account2.address})`;
      submitMutation = (overrides) => tacRequester.editGlobalResourceTable(account1.address, account2.address, overrides);
    } else if (op.op === "Table Delete Local Resource") {
      if (!target) throw new Error("Table Delete Local Resource requires targetAccountKey");
      endpointRoute = "direct.tac.deleteLocalResourceTable";
      callDescription = `deleteLocalResourceTable(${target.address})`;
      submitMutation = (overrides) => tacRequester.deleteLocalResourceTable(target.address, overrides);
    } else if (op.op === "Table Delete Global Resource") {
      if (!target) throw new Error("Table Delete Global Resource requires targetAccountKey");
      endpointRoute = "direct.tac.deleteGlobalResourceTable";
      callDescription = `deleteGlobalResourceTable(${target.address})`;
      submitMutation = (overrides) => tacRequester.deleteGlobalResourceTable(target.address, overrides);
    } else {
      throw new Error(`Unsupported table mutation operation ${op.op}`);
    }

    const { tx: mutationTx, receipt: mutationReceipt, sentAtMs: mutationSentMs, minedAtMs: mutationMinedMs } = await sendWithManagedFunds(
      requesterWallet,
      submitMutation,
      `TAC mutation signer ${requesterAccount.address}`
    );
    const mutationDetail = await describeTx(
      provider,
      mutationTx.hash,
      contractRegistry,
      `${callDescription} by ${requesterAccount.address} after access request ${requestId === null ? "unknown" : requestId.toString()}.`
    );
    mutationDetail.sentAtMs = mutationSentMs ?? null;
    mutationDetail.minedAtMs = mutationMinedMs ?? null;
    txs.push(mutationDetail);
    updateBlockRange(mutationReceipt);

    const finalReceipt = txs[txs.length - 1]?.receipt || null;
    const succeeded = finalReceipt?.status === 1;
    const outcome = succeeded
      ? (op.behavior === "benign" ? "success" : "penalized")
      : (op.behavior === "benign" ? "failed" : "denied");
    const outcomeReason = succeeded
      ? (op.behavior === "benign" ? "table mutation path completed" : "malicious table mutation path executed")
      : (mutationDetail.revertReason || "transaction reverted");
    const notes = op.behavior === "benign"
      ? `Table mutation workflow executed as a logical action: request -> approvals -> ${callDescription}. Total gas sums every transaction in this chain.`
      : `Malicious table mutation workflow executed to capture unauthorized/quorum/penalty behavior. Includes request and mutation transactions.`;

    const firstTx = txs[0];
    const lastTx = txs[txs.length - 1];
    return logAction({
      scenarioId: scenarioCtx.scenarioId,
      scenarioGroup: scenarioCtx.scenarioGroup,
      iteration: scenarioCtx.iteration,
      mode: scenarioCtx.mode,
      logicalOperation: op.op,
      scenarioStage: op.stage || "",
      behavior: op.behavior || "benign",
      measuredAs: "onchain_tx",
      outcome,
      outcomeReason,
      notes,
      txDetails: txs,
      actionStartMs,
      actionEndMs: Date.now(),
      httpLatencyMs: null,
      scenarioStartMs: scenarioCtx.scenarioStartMs,
      scenarioEndMs: Date.now(),
      networkMeta: {
        requestMethod: "RPC",
        endpointRoute,
        sourceActor: requesterAccount.address,
        destinationActor: tacContract.target || tacContract.address,
        sourcePgh: scenarioCtx.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
        destinationPgh: scenarioCtx.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
      },
      timingPoints: {
        requestSentMs: firstTx?.sentAtMs ?? actionStartMs,
        blockchainSubmitMs: firstTx?.sentAtMs ?? null,
        blockchainMinedMs: lastTx?.minedAtMs ?? null,
        responseReturnedMs: lastTx?.minedAtMs ?? Date.now(),
      },
    });
  };

  const executeAccessControl = async (scenarioCtx, op, baseUrl, objectAddr, subjectAccount, flowMeta) => {
    const actionStartMs = Date.now();
    const endpointRoute = "/evaluate-access";
    const resource = resolveResource(scenarioCtx, op.resource);
    const action = op.action || "view";
    const startBlock = await provider.getBlockNumber();
    const res = await postJson(baseUrl, endpointRoute, {
      subjectAddress: subjectAccount.address,
      objectAddress: objectAddr,
      accType: DEFAULT_ACC_TYPE,
      resource,
      action,
      logOnChain: true,
      subjectPrivateKey: subjectAccount.privateKey,
    });
    const txHash = extractTxHash(res.body);
    const txs = [];
    if (txHash) {
      const detail = await describeTx(provider, txHash, contractRegistry, `Subject ${subjectAccount.address} logged accessControl(${resource}, ${action}) on-chain.`);
      detail.sentAtMs = res.timing?.startMs ?? null;
      detail.minedAtMs = res.timing?.endMs ?? null;
      txs.push(detail);
    }

    let endBlock = await provider.getBlockNumber();
    if (txHash && txs[0]?.receipt?.blockNumber !== undefined) {
      const target = txs[0].receipt.blockNumber + CONFIG.extraBlockLookahead;
      endBlock = await waitForBlock(provider, target, CONFIG.extraBlockWaitMs);
    }

    const extraHashes = await collectExtraTxs(provider, {
      startBlock,
      endBlock,
      knownTxHashes: new Set(txHash ? [txHash] : []),
      seenTxHashes,
      toAddresses: new Set([addresses.judgeContract.toLowerCase()]),
    });

    for (const hash of extraHashes) {
      const detail = await describeTx(provider, hash, contractRegistry, "PGH auto-response via JudgeContract after threat assessment.");
      txs.push(detail);
    }

    const allowed = res.body?.allowed;
    const threats = res.body?.threats || [];
    const threatCodes = Array.isArray(threats) ? threats.map((t) => t?.code || t?.name || "").filter(Boolean) : [];
    const penaltyIntentDetected = threatCodes.some((code) => code === "DATA_TAMPERING" || code === "DISRUPTION_OF_SERVICE");
    const outcome = allowed
      ? "allowed"
      : ((extraHashes.length > 0 || (op.behavior === "malicious" && penaltyIntentDetected)) ? "penalized" : "denied");
    const outcomeReason = allowed ? "policy allow" : (Array.isArray(threats) && threats.length ? `threats: ${threats.map(t => t.code || t.name).join("|")}` : "policy denied");
    const notes = `AccessControl ${action} on ${resource} via PGH (logOnChain=true). allowed=${allowed}. threats=${Array.isArray(threats) ? threats.map(t => t.code || t.name).join(",") : "n/a"}. Extra judge txs=${extraHashes.length}. Total gas is sum of listed txs.`;
    const sourcePgh = flowMeta?.sourcePgh || (baseUrl === CONFIG.pghBBase ? "PGH_B" : "PGH_A");
    const destinationPgh = flowMeta?.destinationPgh || sourcePgh;

    const actionRow = await logAction({
      scenarioId: scenarioCtx.scenarioId,
      scenarioGroup: scenarioCtx.scenarioGroup,
      iteration: scenarioCtx.iteration,
      mode: scenarioCtx.mode,
      logicalOperation: op.behavior === "benign" ? "Access Control without Misbehavior" : "Access Control with Misbehavior",
      scenarioStage: op.stage || "",
      behavior: op.behavior,
      measuredAs: txHash ? "onchain_tx" : "no_onchain_tx",
      outcome,
      outcomeReason,
      notes,
      txDetails: txs,
      actionStartMs,
      actionEndMs: Date.now(),
      httpLatencyMs: res.timing?.latencyMs ?? null,
      scenarioStartMs: scenarioCtx.scenarioStartMs,
      scenarioEndMs: Date.now(),
      networkMeta: {
        requestMethod: "POST",
        endpointRoute,
        sourceActor: subjectAccount.address,
        destinationActor: objectAddr,
        sourcePgh,
        destinationPgh,
      },
      timingPoints: {
        requestSentMs: res.timing?.startMs ?? actionStartMs,
        requestReceivedMs: res.timing?.endMs ?? Date.now(),
        pghForwardStartMs: scenarioCtx.mode === "pgh_pgh" ? res.timing?.startMs ?? null : null,
        pghForwardEndMs: scenarioCtx.mode === "pgh_pgh" ? res.timing?.endMs ?? null : null,
        blockchainSubmitMs: txs[0]?.sentAtMs ?? null,
        blockchainMinedMs: txs[txs.length - 1]?.minedAtMs ?? null,
        responseReturnedMs: res.timing?.endMs ?? Date.now(),
      },
    });
    return actionRow;
  };

  const executeCreateTableAccessRequest = async (scenarioCtx, op, requesterAccount, approverAccounts) => {
    const actionStartMs = Date.now();
    if (!tacContract) {
      const notes = "TableAccessControlContract unavailable; no on-chain tx executed.";
      const actionRow = await logAction({
        scenarioId: scenarioCtx.scenarioId,
        scenarioGroup: scenarioCtx.scenarioGroup,
        iteration: scenarioCtx.iteration,
        mode: scenarioCtx.mode,
        logicalOperation: op.behavior === "malicious" ? "Create Table Access Request with Misbehavior" : "Create Table Access Request",
        scenarioStage: op.stage || "",
        behavior: op.behavior,
        measuredAs: "no_onchain_tx",
        outcome: "unavailable",
        outcomeReason: "TableAccessControlContract missing",
        notes,
        txDetails: [],
        actionStartMs,
        actionEndMs: Date.now(),
        httpLatencyMs: null,
        scenarioStartMs: scenarioCtx.scenarioStartMs,
        scenarioEndMs: Date.now(),
        networkMeta: {
          requestMethod: "RPC",
          endpointRoute: "direct.createAccessRequest",
          sourceActor: requesterAccount.address,
          destinationActor: tacContract?.target || tacContract?.address || "",
          sourcePgh: scenarioCtx.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
          destinationPgh: scenarioCtx.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
        },
        timingPoints: {
          requestSentMs: actionStartMs,
          responseReturnedMs: Date.now(),
        },
      });
      return actionRow;
    }

    const txs = [];
    const resource = op.resource;
    const action = op.action;
    const requesterWallet = new ethers.Wallet(requesterAccount.privateKey, provider);
    const tacRequester = tacContract.connect(requesterWallet);
    const { tx, receipt, sentAtMs, minedAtMs } = await sendWithManagedFunds(
      requesterWallet,
      (overrides) => tacRequester.createAccessRequest(resource, action, overrides),
      `TAC request signer ${requesterAccount.address}`
    );
    const detail = await describeTx(provider, tx.hash, contractRegistry, `createAccessRequest(${resource}, ${action}) by ${requesterAccount.address}.`);
    detail.sentAtMs = sentAtMs ?? null;
    detail.minedAtMs = minedAtMs ?? null;
    txs.push(detail);

    let requestId = null;
    const tacAddress = (tacContract.target || tacContract.address || "").toLowerCase();
    for (const log of receipt.logs || []) {
      if (log.address && log.address.toLowerCase() !== tacAddress) continue;
      try {
        const parsed = tacContract.interface.parseLog(log);
        if (parsed.name === "AccessRequestCreated") {
          requestId = parsed.args[0];
          break;
        }
      } catch (_err) {
        // ignore unrelated logs
      }
    }

    let approvalsPerformed = 0;
    if (op.behavior === "benign" && requestId !== null && approverAccounts && approverAccounts.length) {
      for (const approver of approverAccounts) {
        const approverWallet = new ethers.Wallet(approver.privateKey, provider);
        const tacApprover = tacContract.connect(approverWallet);
        const { tx: txApprove, receipt: recApprove, sentAtMs: approveSentMs, minedAtMs: approveMinedMs } = await sendWithManagedFunds(
          approverWallet,
          (overrides) => tacApprover.handleAccessRequest(requestId, true, overrides),
          `TAC approval signer ${approver.address}`
        );
        const approveDetail = await describeTx(provider, txApprove.hash, contractRegistry, `handleAccessRequest(${requestId}, true) by ${approver.address}.`);
        approveDetail.sentAtMs = approveSentMs ?? null;
        approveDetail.minedAtMs = approveMinedMs ?? null;
        txs.push(approveDetail);
        approvalsPerformed += 1;
        updateBlockRange(recApprove);
      }
    }

    const outcome = op.behavior === "benign" ? (requestId !== null ? "approved" : "partial") : "penalized";
    const outcomeReason = op.behavior === "benign"
      ? (requestId !== null ? "request approved" : "requestId missing; approvals skipped")
      : "unauthorized request path";
    const notes = op.behavior === "benign"
      ? `Access request created for ${resource}:${action} by ${requesterAccount.address}. Approvals=${approvalsPerformed}. Total gas sums create + approvals.`
      : `Unauthorized access request for ${resource}:${action} by ${requesterAccount.address}. Contract reported malicious activity; no approval performed.`;
    const firstTx = txs[0];
    const lastTx = txs[txs.length - 1];

    const actionRow = await logAction({
      scenarioId: scenarioCtx.scenarioId,
      scenarioGroup: scenarioCtx.scenarioGroup,
      iteration: scenarioCtx.iteration,
      mode: scenarioCtx.mode,
      logicalOperation: op.behavior === "malicious" ? "Create Table Access Request with Misbehavior" : "Create Table Access Request",
      scenarioStage: op.stage || "",
      behavior: op.behavior,
      measuredAs: "onchain_tx",
      outcome,
      outcomeReason,
      notes,
      txDetails: txs,
      actionStartMs,
      actionEndMs: Date.now(),
      httpLatencyMs: null,
      scenarioStartMs: scenarioCtx.scenarioStartMs,
      scenarioEndMs: Date.now(),
      networkMeta: {
        requestMethod: "RPC",
        endpointRoute: "direct.createAccessRequest",
        sourceActor: requesterAccount.address,
        destinationActor: tacContract.target || tacContract.address,
        sourcePgh: scenarioCtx.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
        destinationPgh: scenarioCtx.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
      },
      timingPoints: {
        requestSentMs: firstTx?.sentAtMs ?? actionStartMs,
        blockchainSubmitMs: firstTx?.sentAtMs ?? null,
        blockchainMinedMs: lastTx?.minedAtMs ?? null,
        responseReturnedMs: lastTx?.minedAtMs ?? Date.now(),
      },
    });
    return actionRow;
  };

  const executeViewResourceTable = async (scenarioCtx, op, viewerAccount) => {
    const actionStartMs = Date.now();
    if (!tacContract) {
      const notes = "TableAccessControlContract unavailable; no on-chain tx executed.";
      const actionRow = await logAction({
        scenarioId: scenarioCtx.scenarioId,
        scenarioGroup: scenarioCtx.scenarioGroup,
        iteration: scenarioCtx.iteration,
        mode: scenarioCtx.mode,
        logicalOperation: op.scope === "global" ? "View Global Resource Table" : "View Local Resource Table",
        scenarioStage: op.stage || "",
        behavior: op.behavior,
        measuredAs: "no_onchain_tx",
        outcome: "unavailable",
        outcomeReason: "TableAccessControlContract missing",
        notes,
        txDetails: [],
        actionStartMs,
        actionEndMs: Date.now(),
        httpLatencyMs: null,
        scenarioStartMs: scenarioCtx.scenarioStartMs,
        scenarioEndMs: Date.now(),
        networkMeta: {
          requestMethod: "RPC",
          endpointRoute: op.scope === "global" ? "direct.viewGlobalResourceTable" : "direct.viewLocalResourceTable",
          sourceActor: viewerAccount.address,
          destinationActor: tacContract?.target || tacContract?.address || "",
          sourcePgh: scenarioCtx.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
          destinationPgh: scenarioCtx.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
        },
        timingPoints: {
          requestSentMs: actionStartMs,
          responseReturnedMs: Date.now(),
        },
      });
      return actionRow;
    }

    const viewerWallet = new ethers.Wallet(viewerAccount.privateKey, provider);
    const tacViewer = tacContract.connect(viewerWallet);
    let tx;
    let receipt;
    let sentAtMs;
    let minedAtMs;
    if (op.scope === "global") {
      ({ tx, receipt, sentAtMs, minedAtMs } = await sendWithManagedFunds(
        viewerWallet,
        (overrides) => tacViewer.viewGlobalResourceTable(overrides),
        `TAC viewer ${viewerAccount.address}`
      ));
    } else {
      ({ tx, receipt, sentAtMs, minedAtMs } = await sendWithManagedFunds(
        viewerWallet,
        (overrides) => tacViewer.viewLocalResourceTable(overrides),
        `TAC viewer ${viewerAccount.address}`
      ));
    }
    const detail = await describeTx(provider, tx.hash, contractRegistry, `${op.scope} table view by ${viewerAccount.address}.`);
    detail.sentAtMs = sentAtMs ?? null;
    detail.minedAtMs = minedAtMs ?? null;

    const outcome = op.behavior === "benign" ? "success" : "denied";
    const outcomeReason = op.behavior === "benign" ? "approved request" : "no approved request";
    const notes = op.behavior === "benign"
      ? `Viewer ${viewerAccount.address} accessed ${op.scope} resource table after approved request.`
      : `Viewer ${viewerAccount.address} attempted ${op.scope} table view without approval; malicious path triggered.`;

    const actionRow = await logAction({
      scenarioId: scenarioCtx.scenarioId,
      scenarioGroup: scenarioCtx.scenarioGroup,
      iteration: scenarioCtx.iteration,
      mode: scenarioCtx.mode,
      logicalOperation: op.scope === "global" ? "View Global Resource Table" : "View Local Resource Table",
      scenarioStage: op.stage || "",
      behavior: op.behavior,
      measuredAs: "onchain_tx",
      outcome,
      outcomeReason,
      notes,
      txDetails: [detail],
      actionStartMs,
      actionEndMs: Date.now(),
      httpLatencyMs: null,
      scenarioStartMs: scenarioCtx.scenarioStartMs,
      scenarioEndMs: Date.now(),
      networkMeta: {
        requestMethod: "RPC",
        endpointRoute: op.scope === "global" ? "direct.viewGlobalResourceTable" : "direct.viewLocalResourceTable",
        sourceActor: viewerAccount.address,
        destinationActor: tacContract.target || tacContract.address,
        sourcePgh: scenarioCtx.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
        destinationPgh: scenarioCtx.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
      },
      timingPoints: {
        requestSentMs: sentAtMs ?? actionStartMs,
        blockchainSubmitMs: sentAtMs ?? null,
        blockchainMinedMs: minedAtMs ?? null,
        responseReturnedMs: minedAtMs ?? Date.now(),
      },
    });
    updateBlockRange(receipt);
    return actionRow;
  };

  const harvestEspActionEffects = async (scenarioCtx, markerId, options = {}) => {
    if (CONFIG.espActionSettleMs > 0) {
      await sleep(CONFIG.espActionSettleMs);
    }
    const chainActions = (await fetchEspChainActions(scenarioCtx)).filter((row) => Number(row.id || 0) > Number(markerId || 0));
    const txDetails = await describeEspChainActionTxs(chainActions);
    const threatCodes = extractEspThreatCodes(chainActions);
    const knownTxHashes = new Set(
      txDetails
        .map((detail) => detail?.tx?.hash || null)
        .filter(Boolean)
    );
    let extraJudgeCount = 0;

    const startBlock = Number(options.startBlock ?? -1);
    const receiptBlocks = txDetails
      .map((detail) => Number(detail?.receipt?.blockNumber))
      .filter((value) => Number.isFinite(value));
    if ((receiptBlocks.length || startBlock >= 0) && addresses.judgeContract) {
      const fromBlock = receiptBlocks.length
        ? Math.min(...receiptBlocks, startBlock >= 0 ? startBlock : Number.MAX_SAFE_INTEGER)
        : startBlock;
      let endBlock = await provider.getBlockNumber();
      if (receiptBlocks.length) {
        const target = Math.max(...receiptBlocks) + CONFIG.extraBlockLookahead;
        endBlock = await waitForBlock(provider, target, CONFIG.extraBlockWaitMs);
      }
      if (fromBlock >= 0 && endBlock >= fromBlock) {
        const extraHashes = await collectExtraTxs(provider, {
          startBlock: fromBlock,
          endBlock,
          knownTxHashes,
          seenTxHashes,
          toAddresses: new Set([addresses.judgeContract.toLowerCase()]),
        });
        for (const hash of extraHashes) {
          // eslint-disable-next-line no-await-in-loop
          const detail = await describeTx(provider, hash, contractRegistry, "PGH auto-response via JudgeContract after ESP bridge threat assessment.");
          txDetails.push(detail);
        }
        extraJudgeCount = extraHashes.length;
      }
    }
    for (const detail of txDetails) {
      updateBlockRange(detail.receipt);
    }
    return { chainActions, txDetails, threatCodes, extraJudgeCount };
  };

  const buildEspTimingPointsFromResponses = (responses, txDetails) => {
    const valid = (responses || []).filter(Boolean);
    const first = valid.length ? valid[0] : null;
    const last = valid.length ? valid[valid.length - 1] : null;
    return {
      requestSentMs: first?.timing?.startMs ?? null,
      requestReceivedMs: null,
      blockchainSubmitMs: txDetails.length
        ? txDetails
          .map((detail) => detail?.sentAtMs ?? null)
          .filter((value) => value !== null && value !== undefined)
          .sort((a, b) => a - b)[0] ?? null
        : null,
      blockchainMinedMs: txDetails.length
        ? txDetails
          .map((detail) => detail?.minedAtMs ?? null)
          .filter((value) => value !== null && value !== undefined)
          .sort((a, b) => b - a)[0] ?? null
        : null,
      responseReturnedMs: last?.timing?.endMs ?? null,
    };
  };

  const buildEspAccessNote = ({
    resourceKind,
    requestorMac,
    targetMac,
    responses,
    chainActions,
    threatCodes,
    extraJudgeCount = 0,
  }) => {
    const responseSummary = (responses || [])
      .map((entry) => `${entry.kind || resourceKind}:${entry.response?.status ?? "?"}`)
      .join(",");
    return appendSegments(
      `ESP bridge ${resourceKind} access from ${requestorMac} to ${targetMac} responses=[${responseSummary || "none"}]`,
      `Chain actions: ${buildEspChainActionSummary(chainActions)}`,
      formatEspThreatSummary(threatCodes),
      `extra_judge_txs=${extraJudgeCount}`
    );
  };

  const executeEspTelemetryBootstrap = async (scenarioCtx, op) => {
    const actionStartMs = Date.now();
    const payload = buildTelemetryPayload(scenarioCtx, op);
    const deviceKey = op.deviceKey || op.targetKey || op.requestorKey;
    const markerId = await getLatestEspChainActionId(scenarioCtx);
    const startBlock = await provider.getBlockNumber();
    const res = await requestJson("POST", scenarioCtx.esp.baseUrl, "/data", { body: payload });
    const { chainActions, txDetails, threatCodes, extraJudgeCount } = await harvestEspActionEffects(scenarioCtx, markerId, { startBlock });
    scenarioCtx.esp.devicesByMac[normalizeMac(payload.mac)] = {
      ...(scenarioCtx.esp.devicesByMac[normalizeMac(payload.mac)] || {}),
      mac: normalizeMac(payload.mac),
      temperature: payload.temperature,
      humidity: payload.humidity,
    };
    await refreshEspActorAccounts(scenarioCtx);
    const actorAccount = scenarioCtx.accounts[deviceKey];
    if (!actorAccount?.address) {
      throw new Error(`ESP bootstrap did not produce a blockchain identity for ${deviceKey} (${payload.mac})`);
    }

    const outcome = res.status === 200 ? "success" : "failed";
    const outcomeReason = appendSegments(
      res.status === 200
        ? "telemetry stored and blockchain bootstrap path executed"
        : gatewayMessage(res.body),
      formatEspThreatSummary(threatCodes),
      `extra_judge_txs=${extraJudgeCount}`
    );
    const notes = appendSegments(
      `Sandboxed ESP bridge posted telemetry for ${payload.mac}`,
      `Chain actions: ${buildEspChainActionSummary(chainActions)}`,
      `Original database left untouched; sandbox copy at ${scenarioCtx.esp.sandboxDb}`,
      formatEspThreatSummary(threatCodes),
      `extra_judge_txs=${extraJudgeCount}`
    );

    return logAction({
      scenarioId: scenarioCtx.scenarioId,
      scenarioGroup: scenarioCtx.scenarioGroup,
      iteration: scenarioCtx.iteration,
      mode: scenarioCtx.mode,
      logicalOperation: "ESP Telemetry Bootstrap",
      scenarioStage: op.stage || "",
      behavior: op.behavior || "benign",
      measuredAs: txDetails.length ? "onchain_tx" : "no_onchain_tx",
      outcome,
      outcomeReason,
      notes,
      txDetails,
      actionStartMs,
      actionEndMs: res.timing?.endMs ?? Date.now(),
      httpLatencyMs: res.timing?.latencyMs ?? null,
      scenarioStartMs: scenarioCtx.scenarioStartMs,
      scenarioEndMs: Date.now(),
      networkMeta: {
        requestMethod: "POST",
        endpointRoute: "/data",
        sourceActor: payload.mac,
        destinationActor: payload.mac,
        sourcePgh: "PGH_A",
        destinationPgh: "PGH_A",
      },
      timingPoints: buildEspTimingPoints(res, txDetails),
    });
  };

  const executeEspDeviceEnumeration = async (scenarioCtx, op) => {
    const actionStartMs = Date.now();
    const markerId = await getLatestEspChainActionId(scenarioCtx);
    const res = await getJson(scenarioCtx.esp.baseUrl, "/devices");
    const { chainActions, txDetails, threatCodes, extraJudgeCount } = await harvestEspActionEffects(scenarioCtx, markerId);
    if (res.status === 200 && Array.isArray(res.body)) {
      scenarioCtx.esp.devicesByMac = Object.fromEntries(
        res.body.map((device) => [normalizeMac(device.mac), { ...device, mac: normalizeMac(device.mac) }])
      );
    }
    const compromisedMac = getEspMacForKey(scenarioCtx, op.requestorKey || "compromised_esp");
    const targetMac = getEspMacForKey(scenarioCtx, "target_esp");
    const notes = appendSegments(
      `Compromised ESP bridge actor enumerated ${Array.isArray(res.body) ? res.body.length : 0} device entries`,
      `Selected requestor=${compromisedMac}, target=${targetMac}`,
      `Chain actions after enumeration: ${buildEspChainActionSummary(chainActions)}`,
      formatEspThreatSummary(threatCodes),
      `extra_judge_txs=${extraJudgeCount}`
    );
    return logAction({
      scenarioId: scenarioCtx.scenarioId,
      scenarioGroup: scenarioCtx.scenarioGroup,
      iteration: scenarioCtx.iteration,
      mode: scenarioCtx.mode,
      logicalOperation: "ESP Device Enumeration",
      scenarioStage: op.stage || "",
      behavior: op.behavior || "malicious",
      measuredAs: txDetails.length ? "onchain_tx" : "no_onchain_tx",
      outcome: res.status === 200 ? "success" : "failed",
      outcomeReason: appendSegments(
        res.status === 200 ? "device inventory returned" : gatewayMessage(res.body),
        formatEspThreatSummary(threatCodes),
        `extra_judge_txs=${extraJudgeCount}`
      ),
      notes,
      txDetails,
      actionStartMs,
      actionEndMs: res.timing?.endMs ?? Date.now(),
      httpLatencyMs: res.timing?.latencyMs ?? null,
      scenarioStartMs: scenarioCtx.scenarioStartMs,
      scenarioEndMs: Date.now(),
      networkMeta: {
        requestMethod: "GET",
        endpointRoute: "/devices",
        sourceActor: compromisedMac,
        destinationActor: "esp_bridge_device_inventory",
        sourcePgh: "PGH_A",
        destinationPgh: "PGH_A",
      },
      timingPoints: buildEspTimingPoints(res, txDetails),
    });
  };

  const executeEspDataSpoofing = async (scenarioCtx, op) => {
    const actionStartMs = Date.now();
    const payload = buildTelemetryPayload(scenarioCtx, op);
    const markerId = await getLatestEspChainActionId(scenarioCtx);
    const startBlock = await provider.getBlockNumber();
    const res = await requestJson("POST", scenarioCtx.esp.baseUrl, "/data", { body: payload });
    const { chainActions, txDetails, threatCodes, extraJudgeCount } = await harvestEspActionEffects(scenarioCtx, markerId, { startBlock });
    scenarioCtx.esp.devicesByMac[normalizeMac(payload.mac)] = {
      ...(scenarioCtx.esp.devicesByMac[normalizeMac(payload.mac)] || {}),
      mac: normalizeMac(payload.mac),
      temperature: payload.temperature,
      humidity: payload.humidity,
    };
    await refreshEspActorAccounts(scenarioCtx);
    const spoofedByKey = op.spoofedByKey || "compromised_esp";
    const spoofedByMac = getEspMacForKey(scenarioCtx, spoofedByKey);
    const notes = appendSegments(
      `Spoofed telemetry was injected for ${payload.mac} by the PoisonIvy-style bridge path attributed to ${spoofedByMac}`,
      `Payload temp=${payload.temperature}, humidity=${payload.humidity}`,
      `Chain actions: ${buildEspChainActionSummary(chainActions)}`,
      formatEspThreatSummary(threatCodes),
      `extra_judge_txs=${extraJudgeCount}`
    );
    return logAction({
      scenarioId: scenarioCtx.scenarioId,
      scenarioGroup: scenarioCtx.scenarioGroup,
      iteration: scenarioCtx.iteration,
      mode: scenarioCtx.mode,
      logicalOperation: "ESP Data Spoofing",
      scenarioStage: op.stage || "",
      behavior: op.behavior || "malicious",
      measuredAs: txDetails.length ? "onchain_tx" : "no_onchain_tx",
      outcome: res.status === 200 ? "success" : "failed",
      outcomeReason: appendSegments(
        res.status === 200 ? "spoofed telemetry accepted by bridge" : gatewayMessage(res.body),
        formatEspThreatSummary(threatCodes),
        `extra_judge_txs=${extraJudgeCount}`
      ),
      notes,
      txDetails,
      actionStartMs,
      actionEndMs: res.timing?.endMs ?? Date.now(),
      httpLatencyMs: res.timing?.latencyMs ?? null,
      scenarioStartMs: scenarioCtx.scenarioStartMs,
      scenarioEndMs: Date.now(),
      networkMeta: {
        requestMethod: "POST",
        endpointRoute: "/data",
        sourceActor: spoofedByMac,
        destinationActor: payload.mac,
        sourcePgh: "PGH_A",
        destinationPgh: "PGH_A",
      },
      timingPoints: buildEspTimingPoints(res, txDetails),
    });
  };

  const executeEspReadAccess = async (scenarioCtx, op, resourceKind) => {
    const actionStartMs = Date.now();
    const requestorKey = op.requestorKey || "compromised_esp";
    const targetKey = op.targetKey || requestorKey;
    const requestorMac = getEspMacForKey(scenarioCtx, requestorKey);
    const targetMac = getEspMacForKey(scenarioCtx, targetKey);
    let preflightAdvanceSeconds = 0;

    if (op.waitForRequestorUnblock) {
      const requestorAddress = scenarioCtx.accounts[requestorKey]?.address || null;
      preflightAdvanceSeconds = await advanceChainPastJudgeBlock(requestorAddress, Number(op.preAdvanceSeconds || 0));
    } else if (op.preAdvanceSeconds) {
      preflightAdvanceSeconds = await advanceChainPastJudgeBlock(null, Number(op.preAdvanceSeconds || 0));
    }

    const endpointRoute = resourceKind === "status" ? `/status/${targetMac}` : `/temps/${targetMac}`;
    const logicalOperation = op.op;
    const markerId = await getLatestEspChainActionId(scenarioCtx);
    const startBlock = await provider.getBlockNumber();
    const res = await getJson(scenarioCtx.esp.baseUrl, endpointRoute, {
      headers: {
        "X-Requestor-MAC": requestorMac,
      },
    });
    const { chainActions, txDetails, threatCodes, extraJudgeCount } = await harvestEspActionEffects(scenarioCtx, markerId, { startBlock });

    let outcome = "failed";
    if (res.status === 200) outcome = "success";
    else if (res.status === 403) outcome = "denied";
    else if (res.status === 404) outcome = "unavailable";
    const responses = [{ kind: resourceKind, response: res }];
    const notes = buildEspAccessNote({
      resourceKind,
      requestorMac,
      targetMac,
      responses,
      chainActions,
      threatCodes,
      extraJudgeCount,
    });
    const notesWithAdvance = preflightAdvanceSeconds > 0
      ? appendSegments(notes, `chain_time_advanced_seconds=${preflightAdvanceSeconds}`)
      : notes;

    return logAction({
      scenarioId: scenarioCtx.scenarioId,
      scenarioGroup: scenarioCtx.scenarioGroup,
      iteration: scenarioCtx.iteration,
      mode: scenarioCtx.mode,
      logicalOperation,
      scenarioStage: op.stage || "",
      behavior: op.behavior || "benign",
      measuredAs: txDetails.length ? "onchain_tx" : "no_onchain_tx",
      outcome,
      outcomeReason: appendSegments(
        res.status === 200
          ? `${resourceKind} data returned`
          : (gatewayMessage(res.body) || `${resourceKind} request failed`),
        formatEspThreatSummary(threatCodes),
        `extra_judge_txs=${extraJudgeCount}`
      ),
      notes: notesWithAdvance,
      txDetails,
      actionStartMs,
      actionEndMs: res.timing?.endMs ?? Date.now(),
      httpLatencyMs: res.timing?.latencyMs ?? null,
      scenarioStartMs: scenarioCtx.scenarioStartMs,
      scenarioEndMs: Date.now(),
      networkMeta: {
        requestMethod: "GET",
        endpointRoute,
        sourceActor: requestorMac,
        destinationActor: targetMac,
        sourcePgh: "PGH_A",
        destinationPgh: "PGH_A",
      },
      timingPoints: buildEspTimingPoints(res, txDetails),
    });
  };

  const executeEspRepeatedAccessBurst = async (scenarioCtx, op) => {
    const actionStartMs = Date.now();
    const requestorKey = op.requestorKey || "compromised_esp";
    const targetKey = op.targetKey || "target_esp";
    const requestorMac = getEspMacForKey(scenarioCtx, requestorKey);
    const targetMac = getEspMacForKey(scenarioCtx, targetKey);
    const requestorAddress = scenarioCtx.accounts[requestorKey]?.address || null;
    const pattern = Array.isArray(op.pattern) && op.pattern.length ? op.pattern : ["status", "temps"];
    const attemptCount = Math.max(2, Number(op.attemptCount || op.repeat || op.maxAttempts || 16));
    const untilJudgeState = String(op.untilJudgeState || "").trim().toLowerCase();
    const markerId = await getLatestEspChainActionId(scenarioCtx);
    const startBlock = await provider.getBlockNumber();
    const responses = [];
    let stopReason = "";

    for (let index = 0; index < attemptCount; index += 1) {
      const kind = pattern[index % pattern.length] === "temps" ? "temps" : "status";
      const endpointRoute = kind === "status" ? `/status/${targetMac}` : `/temps/${targetMac}`;
      // eslint-disable-next-line no-await-in-loop
      const response = await getJson(scenarioCtx.esp.baseUrl, endpointRoute, {
        headers: {
          "X-Requestor-MAC": requestorMac,
        },
      });
      responses.push({ kind, endpointRoute, response });

      let judgeAfter = response?.body?.judgeStateAfter || null;
      let containment = response?.body?.containment || null;
      let gatewayAfter = response?.body?.gatewayStateAfter || null;
      if (untilJudgeState && requestorAddress) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const memberSecurity = await getJson(CONFIG.pghApiBase, `/member-security/${requestorAddress}`);
          if (memberSecurity.status === 200 && memberSecurity.body) {
            judgeAfter = judgeAfter || memberSecurity.body.judgeState || null;
            containment = containment || memberSecurity.body.containment || null;
            gatewayAfter = gatewayAfter || memberSecurity.body.gatewayState || null;
          }
        } catch (_err) {
          // fall back to the bridge response if PGH security state is temporarily unavailable
        }
      }
      if (untilJudgeState === "temporary_quarantine" && (judgeAfter?.temporaryQuarantineActive || Boolean(gatewayAfter?.quarantineUntil))) {
        stopReason = "temporary_quarantine_reached";
        break;
      }
      if (untilJudgeState === "permanent_revocation" && (judgeAfter?.permanentRevoked || containment?.permanentRevoked || gatewayAfter?.permanentRevoked)) {
        stopReason = "permanent_revocation_reached";
        break;
      }
    }

    const { chainActions, txDetails, threatCodes, extraJudgeCount } = await harvestEspActionEffects(scenarioCtx, markerId, { startBlock });
    const statuses = responses.map((entry) => entry.response.status);
    const deniedCount = statuses.filter((status) => status === 403).length;
    const successCount = statuses.filter((status) => status === 200).length;
    const attemptsMade = responses.length;
    const outcome = successCount === 0 && deniedCount === statuses.length
      ? "denied"
      : (successCount === statuses.length ? "success" : "failed");
    const notes = buildEspAccessNote({
      resourceKind: "alternating_burst",
      requestorMac,
      targetMac,
      responses,
      chainActions,
      threatCodes,
      extraJudgeCount,
    });

    return logAction({
      scenarioId: scenarioCtx.scenarioId,
      scenarioGroup: scenarioCtx.scenarioGroup,
      iteration: scenarioCtx.iteration,
      mode: scenarioCtx.mode,
      logicalOperation: op.op,
      scenarioStage: op.stage || "",
      behavior: op.behavior || "malicious",
      measuredAs: txDetails.length ? "onchain_tx" : "no_onchain_tx",
      outcome,
      outcomeReason: appendSegments(
        `burst_attempts=${attemptsMade}`,
        stopReason ? `stop_reason=${stopReason}` : "",
        `denied=${deniedCount}`,
        `allowed=${successCount}`,
        formatEspThreatSummary(threatCodes),
        `extra_judge_txs=${extraJudgeCount}`
      ),
      notes,
      txDetails,
      actionStartMs,
      actionEndMs: responses.length ? responses[responses.length - 1].response.timing?.endMs ?? Date.now() : Date.now(),
      httpLatencyMs: responses.reduce((sum, entry) => sum + (entry.response.timing?.latencyMs ?? 0), 0),
      scenarioStartMs: scenarioCtx.scenarioStartMs,
      scenarioEndMs: Date.now(),
      networkMeta: {
        requestMethod: "GETxN",
        endpointRoute: `burst:${pattern.join("->")}`,
        sourceActor: requestorMac,
        destinationActor: targetMac,
        sourcePgh: "PGH_A",
        destinationPgh: "PGH_A",
      },
      timingPoints: buildEspTimingPointsFromResponses(responses.map((entry) => entry.response), txDetails),
    });
  };

  const executeEspLocalApprovalAbuse = async (scenarioCtx, op) => {
    const actionStartMs = Date.now();
    const requestorMac = getEspMacForKey(scenarioCtx, op.requestorKey || "compromised_esp");
    const targetMac = getEspMacForKey(scenarioCtx, op.targetKey || "target_esp");
    const markerId = await getLatestEspChainActionId(scenarioCtx);
    const startBlock = await provider.getBlockNumber();
    const res = await requestJson("POST", scenarioCtx.esp.baseUrl, "/approve-access", {
      body: {
        requestor_mac: requestorMac,
        requestor_ip: "127.0.0.1",
        target_mac: targetMac,
      },
    });
    const { chainActions, txDetails, threatCodes, extraJudgeCount } = await harvestEspActionEffects(scenarioCtx, markerId, { startBlock });
    const notes = appendSegments(
      `Localhost approval abuse granted controller-side access for ${requestorMac} -> ${targetMac}`,
      "The local access_grants row is not required for the attack result because the security-relevant effect is the blockchain policy insertion via the bridge",
      `Chain actions: ${buildEspChainActionSummary(chainActions)}`,
      formatEspThreatSummary(threatCodes),
      `extra_judge_txs=${extraJudgeCount}`
    );
    return logAction({
      scenarioId: scenarioCtx.scenarioId,
      scenarioGroup: scenarioCtx.scenarioGroup,
      iteration: scenarioCtx.iteration,
      mode: scenarioCtx.mode,
      logicalOperation: "ESP Local Approval Abuse",
      scenarioStage: op.stage || "",
      behavior: op.behavior || "malicious",
      measuredAs: txDetails.length ? "onchain_tx" : "no_onchain_tx",
      outcome: res.status === 200 ? "success" : "failed",
      outcomeReason: appendSegments(
        res.status === 200
          ? "bridge wrote blockchain allow policies for lateral access"
          : gatewayMessage(res.body),
        formatEspThreatSummary(threatCodes),
        `extra_judge_txs=${extraJudgeCount}`
      ),
      notes,
      txDetails,
      actionStartMs,
      actionEndMs: res.timing?.endMs ?? Date.now(),
      httpLatencyMs: res.timing?.latencyMs ?? null,
      scenarioStartMs: scenarioCtx.scenarioStartMs,
      scenarioEndMs: Date.now(),
      networkMeta: {
        requestMethod: "POST",
        endpointRoute: "/approve-access",
        sourceActor: requestorMac,
        destinationActor: targetMac,
        sourcePgh: "PGH_A",
        destinationPgh: "PGH_A",
      },
      timingPoints: buildEspTimingPoints(res, txDetails),
    });
  };

  const buildScenarioContext = async (scenario, iteration) => {
    const scenarioCtx = {
      scenarioId: scenario.id,
      scenarioGroup: scenario.group || "",
      iteration,
      mode: scenario.mode,
      resourceTag: `${scenario.id}-${iteration}`,
      resourceMap: new Map(),
      accessContracts: {},
      accounts: {},
      scenarioStartMs: Date.now(),
      actionRows: [],
    };

    const exclude = new Set();
    const espActorKeys = getEspActorKeys(scenario);

    const alloc = async (key) => {
      const acc = await accountPool.getFresh(key, exclude);
      exclude.add(acc.address.toLowerCase());
      scenarioCtx.accounts[key] = acc;
    };

    if (scenario.mode === "pgh_blockchain") {
      await alloc("object");
      await alloc("subject");
      const needsPrimary2 = scenario.operations.some((op) =>
        op.actor === "primary2" ||
        op.requesterKey === "primary2" ||
        op.viewerKey === "primary2" ||
        op.subjectKey === "primary2" ||
        op.objectKey === "primary2" ||
        (Array.isArray(op.approverKeys) && op.approverKeys.includes("primary2")) ||
        op.scope === "global"
      );
      if (needsPrimary2) await alloc("primary2");
      const extraKeys = new Set();
      for (const op of scenario.operations) {
        if (op.actor) extraKeys.add(op.actor);
        if (op.actorKey) extraKeys.add(op.actorKey);
        if (op.requesterKey) extraKeys.add(op.requesterKey);
        if (op.viewerKey) extraKeys.add(op.viewerKey);
        if (op.subjectKey) extraKeys.add(op.subjectKey);
        if (op.objectKey) extraKeys.add(op.objectKey);
        if (op.account1Key) extraKeys.add(op.account1Key);
        if (op.account2Key) extraKeys.add(op.account2Key);
        if (op.targetAccountKey) extraKeys.add(op.targetAccountKey);
      }
      for (const key of extraKeys) {
        if (espActorKeys.has(key)) continue;
        if (!scenarioCtx.accounts[key]) {
          await alloc(key);
        }
      }
      if (scenario.operations.some((op) => op.behavior === "malicious" && (op.op === "View Local Resource Table" || op.op === "View Global Resource Table"))) {
        if (!scenarioCtx.accounts.attacker) {
          await alloc("attacker");
        }
      }
    } else if (scenario.mode === "pgh_pgh") {
      await alloc("pghA_object");
      await alloc("pghA_subject");
      await alloc("pghB_object");
      await alloc("pghB_subject");
      const extraKeys = new Set();
      for (const op of scenario.operations) {
        if (op.actor) extraKeys.add(op.actor);
        if (op.actorKey) extraKeys.add(op.actorKey);
        if (op.requesterKey) extraKeys.add(op.requesterKey);
        if (op.viewerKey) extraKeys.add(op.viewerKey);
        if (op.subjectKey) extraKeys.add(op.subjectKey);
        if (op.objectKey) extraKeys.add(op.objectKey);
        if (op.account1Key) extraKeys.add(op.account1Key);
        if (op.account2Key) extraKeys.add(op.account2Key);
        if (op.targetAccountKey) extraKeys.add(op.targetAccountKey);
        if (Array.isArray(op.approverKeys)) {
          for (const key of op.approverKeys) extraKeys.add(key);
        }
      }
      for (const key of extraKeys) {
        if (espActorKeys.has(key)) continue;
        if (!scenarioCtx.accounts[key]) {
          await alloc(key);
        }
      }
    }

    return scenarioCtx;
  };

  const summarizeScenario = (scenarioCtx, scenario, iteration, scenarioEndMs) => {
    const actionRows = scenarioCtx.actionRows || [];
    let totalTxs = 0;
    let totalGas = 0n;
    let totalFee = 0n;
    let totalCommunicationBackAndForthMs = 0;
    let totalBlockchainProcessingMs = 0;
    let hasFailed = false;
    let hasUnavailable = false;
    let hasThreatLikeOutcome = false;
    let judgeTriggered = false;
    let tableAccessUsed = false;
    let multiTx = false;
    const involvedContracts = new Set();
    const involvedFunctions = new Set();
    const pghs = new Set();
    const scenarioJudgeMetrics = createJudgeMetrics();

    for (const row of actionRows) {
      const txCount = Number(row.tx_count || 0);
      totalTxs += txCount;
      if (txCount > 1) multiTx = true;
      const gas = toBigIntSafe(row.total_gas_used);
      const fee = toBigIntSafe(row.total_fee_paid_wei);
      if (gas !== null) totalGas += gas;
      if (fee !== null) totalFee += fee;

      const comm = Number(row.communication_back_and_forth_ms || 0);
      const chain = Number(row.blockchain_processing_ms || 0);
      if (!Number.isNaN(comm)) totalCommunicationBackAndForthMs += comm;
      if (!Number.isNaN(chain)) totalBlockchainProcessingMs += chain;

      const contracts = (row.involved_contracts || "").split(",").map((v) => v.trim()).filter(Boolean);
      const functions = (row.involved_functions || "").split(",").map((v) => v.trim()).filter(Boolean);
      for (const c of contracts) involvedContracts.add(c);
      for (const f of functions) involvedFunctions.add(f);
      mergeJudgeMetrics(scenarioJudgeMetrics, row.judge_metrics);

      if (contracts.includes("JudgeContract") || (row.judge_metrics && row.judge_metrics.eventNames && row.judge_metrics.eventNames.size > 0)) {
        judgeTriggered = true;
      }
      if ((row.logical_operation || "").includes("Table")) tableAccessUsed = true;
      if (row.source_pgh) pghs.add(row.source_pgh);
      if (row.destination_pgh) pghs.add(row.destination_pgh);

      if (row.outcome === "failed") hasFailed = true;
      if (row.outcome === "unavailable") hasUnavailable = true;
      if (row.outcome === "penalized" || row.outcome === "denied") hasThreatLikeOutcome = true;
    }

    const overallOutcome = hasFailed
      ? "failed"
      : (hasUnavailable ? "partial_unavailable" : (hasThreatLikeOutcome ? "completed_with_threats" : "success"));
    const crossPgh = scenario.mode === "pgh_pgh" || pghs.size > 1;
    const totalScenarioElapsedMs = diffMs(scenarioCtx.scenarioStartMs, scenarioEndMs);
    const narrativeSummary = `${scenario.description} Actions=${actionRows.length}, txs=${totalTxs}, gas=${totalGas.toString()}, outcome=${overallOutcome}.`;
    const scenarioJudgeFields = formatJudgeMetrics(scenarioJudgeMetrics);

    return {
      timestamp_utc: nowUtc(),
      run_id: RUN_ID,
      scenario_id: scenario.id,
      scenario_group: scenario.group || "",
      iteration,
      mode: scenario.mode,
      scenario_start_utc: msToUtc(scenarioCtx.scenarioStartMs),
      scenario_end_utc: msToUtc(scenarioEndMs),
      total_scenario_elapsed_ms: totalScenarioElapsedMs !== null ? totalScenarioElapsedMs : "",
      total_actions: actionRows.length,
      total_txs: totalTxs,
      total_gas: totalGas.toString(),
      total_fee: totalFee.toString(),
      total_communication_back_and_forth_ms: totalCommunicationBackAndForthMs,
      total_blockchain_processing_ms: totalBlockchainProcessingMs,
      involved_contracts: Array.from(involvedContracts).join(","),
      involved_functions: Array.from(involvedFunctions).join(","),
      pghs_involved: Array.from(pghs).join(","),
      whether_cross_pgh: crossPgh ? 1 : 0,
      whether_judge_triggered: judgeTriggered ? 1 : 0,
      ...scenarioJudgeFields,
      whether_table_access_used: tableAccessUsed ? 1 : 0,
      whether_multi_tx: multiTx ? 1 : 0,
      overall_outcome: overallOutcome,
      narrative_summary: narrativeSummary,
    };
  };

  const runScenario = async (scenario, iteration) => {
    const scenarioCtx = await buildScenarioContext(scenario, iteration);
    scenarioCtx.scenarioStartMs = Date.now();
    const operations = (scenario.operations || []).filter((op) => CONFIG.includeSetupInScenario || !op.setup);
    try {
      if (scenarioUsesEspBridge(scenario)) {
        await ensureEspBridgeScenario(scenarioCtx, scenario);
      }

      for (const baseOp of operations) {
        const repeatTotal = Math.max(1, Number(baseOp.repeat || 1));
        for (let repeatIndex = 1; repeatIndex <= repeatTotal; repeatIndex += 1) {
          const op = repeatTotal > 1 ? { ...baseOp, repeatIndex, repeatTotal } : baseOp;
          const opStartMs = Date.now();
          try {
            if (CONFIG.interOpDelayMs) {
              await sleep(CONFIG.interOpDelayMs);
            }

            let actionRow = null;
            if (op.op === "Role Assignment") {
              const actorKey = op.actor || "subject";
              const account = scenarioCtx.accounts[actorKey] || scenarioCtx.accounts.subject;
              const baseUrl = scenarioCtx.mode === "pgh_pgh"
                ? (actorKey.startsWith("pghB") ? CONFIG.pghBBase : CONFIG.pghABase)
                : CONFIG.pghBase;
              actionRow = await executeRoleAssignment(scenarioCtx, op, baseUrl, account);
            } else if (op.op === "ESP Telemetry Bootstrap") {
              actionRow = await executeEspTelemetryBootstrap(scenarioCtx, op);
            } else if (op.op === "ESP Device Enumeration") {
              actionRow = await executeEspDeviceEnumeration(scenarioCtx, op);
            } else if (op.op === "ESP Data Spoofing") {
              actionRow = await executeEspDataSpoofing(scenarioCtx, op);
            } else if (
              op.op === "ESP Status Access without Misbehavior"
              || op.op === "ESP Status Access with Misbehavior"
              || op.op === "ESP Status Access after Approval Abuse"
              || op.op === "ESP Status Access after Recovery"
            ) {
              actionRow = await executeEspReadAccess(scenarioCtx, op, "status");
            } else if (op.op === "ESP Temps Access without Misbehavior" || op.op === "ESP Temps Access with Misbehavior") {
              actionRow = await executeEspReadAccess(scenarioCtx, op, "temps");
            } else if (op.op === "ESP Repeated Access Burst with Misbehavior") {
              actionRow = await executeEspRepeatedAccessBurst(scenarioCtx, op);
            } else if (op.op === "ESP Local Approval Abuse") {
              actionRow = await executeEspLocalApprovalAbuse(scenarioCtx, op);
            } else if (op.op === "Policy Add") {
              const route = resolveAccessRoute(scenarioCtx, op);
              if (scenarioCtx.mode === "pgh_pgh") {
                actionRow = await executePolicyAdd(
                  scenarioCtx,
                  op,
                  route.targetKey,
                  route.baseUrl,
                  route.objectAccount.address,
                  route.subjectAccount.address,
                  route.subjectAccount
                );
              } else {
                const actorOverride = op.behavior === "malicious"
                  ? (scenarioCtx.accounts[op.actorKey] || scenarioCtx.accounts.attacker_policy || scenarioCtx.accounts.attacker)
                  : null;
                actionRow = await executePolicyAdd(
                  scenarioCtx,
                  op,
                  route.targetKey,
                  route.baseUrl,
                  route.objectAccount.address,
                  route.subjectAccount.address,
                  route.subjectAccount,
                  actorOverride
                );
              }
            } else if (
              op.op === "Policy Update"
              || op.op === "Policy Delete"
              || op.op === "Access Contract Deactivate"
              || op.op === "Access Contract Activate"
              || op.op === "Access Contract Set Judge"
            ) {
              actionRow = await executeAccessContractDirectOperation(scenarioCtx, op);
            } else if (op.op === "Access Control without Misbehavior" || op.op === "Access Control with Misbehavior") {
              const route = resolveAccessRoute(scenarioCtx, op);
              if (scenarioCtx.mode === "pgh_pgh") {
                const defaultSourcePgh = route.baseUrl === CONFIG.pghABase ? "PGH_B" : "PGH_A";
                const defaultDestinationPgh = route.baseUrl === CONFIG.pghABase ? "PGH_A" : "PGH_B";
                actionRow = await executeAccessControl(
                  scenarioCtx,
                  op,
                  route.baseUrl,
                  route.objectAccount.address,
                  route.subjectAccount,
                  {
                    sourcePgh: inferPghFromAccountKey(route.subjectKey, defaultSourcePgh),
                    destinationPgh: inferPghFromAccountKey(route.objectKey, defaultDestinationPgh),
                  }
                );
              } else {
                actionRow = await executeAccessControl(scenarioCtx, op, route.baseUrl, route.objectAccount.address, route.subjectAccount, {
                  sourcePgh: "PGH_A",
                  destinationPgh: "PGH_A",
                });
              }
            } else if (op.op === "Create Table Access Request" || op.op === "Create Table Access Request with Misbehavior") {
              const scope = op.scope || "local";
              const requesterKey = op.requesterKey || (scope === "global" ? "object" : "subject");
              const requester = scenarioCtx.accounts[requesterKey] || scenarioCtx.accounts.subject;
              const approvers = [];
              if (Array.isArray(op.approverKeys) && op.approverKeys.length) {
                for (const key of op.approverKeys) {
                  if (scenarioCtx.accounts[key]) approvers.push(scenarioCtx.accounts[key]);
                }
              } else if (op.behavior === "benign") {
                if (scope === "local" && scenarioCtx.accounts.object) approvers.push(scenarioCtx.accounts.object);
                if (scope === "global" && scenarioCtx.accounts.primary2) approvers.push(scenarioCtx.accounts.primary2);
              }
              actionRow = await executeCreateTableAccessRequest(scenarioCtx, op, requester, approvers);
            } else if (op.op === "View Local Resource Table" || op.op === "View Global Resource Table") {
              const scope = op.scope || (op.op.includes("Global") ? "global" : "local");
              let viewer;
              if (op.viewerKey && scenarioCtx.accounts[op.viewerKey]) {
                viewer = scenarioCtx.accounts[op.viewerKey];
              } else if (op.behavior === "benign") {
                viewer = scope === "global" ? (scenarioCtx.accounts.object || scenarioCtx.accounts.pghA_object) : (scenarioCtx.accounts.subject || scenarioCtx.accounts.pghA_subject);
              } else {
                viewer = scenarioCtx.accounts.attacker || scenarioCtx.accounts.subject || scenarioCtx.accounts.pghB_subject;
              }
              actionRow = await executeViewResourceTable(scenarioCtx, { ...op, scope }, viewer);
            } else if (
              op.op === "Table Edit Local Resource"
              || op.op === "Table Edit Global Resource"
              || op.op === "Table Delete Local Resource"
              || op.op === "Table Delete Global Resource"
            ) {
              actionRow = await executeTableMutationOperation(scenarioCtx, op);
            } else if (op.op === "Table Policy Update" || op.op === "Table Policy Delete") {
              actionRow = await executeTablePolicyOperation(scenarioCtx, op);
            } else if (
              op.op === "Role Swap"
              || op.op === "Role Revoke"
              || op.op === "Role Status Update"
              || op.op === "Role Penalize"
              || op.op === "Role Reward"
            ) {
              actionRow = await executeRoleAdminOperation(scenarioCtx, op);
            } else if (op.op === "Register Set Judge Contract") {
              actionRow = await executeRegisterSetJudgeOperation(scenarioCtx, op);
            }

            if (actionRow) {
              scenarioCtx.actionRows.push(actionRow);
            }
          } catch (err) {
            manifest.failures.push({
              scenario_id: scenario.id,
              iteration,
              logical_operation: op.op,
              message: sanitizeError(err),
            });
            const failedRow = await logAction({
              scenarioId: scenario.id,
              scenarioGroup: scenario.group || "",
              iteration,
              mode: scenario.mode,
              logicalOperation: op.op,
              scenarioStage: op.stage || "",
              behavior: op.behavior || "benign",
              measuredAs: "no_onchain_tx",
              outcome: "failed",
              outcomeReason: sanitizeError(err),
              notes: `Operation failed before completion: ${sanitizeError(err)}`,
              txDetails: [],
              actionStartMs: opStartMs,
              actionEndMs: Date.now(),
              httpLatencyMs: null,
              scenarioStartMs: scenarioCtx.scenarioStartMs,
              scenarioEndMs: Date.now(),
              networkMeta: {
                requestMethod: "N/A",
                endpointRoute: "operation_failed_before_call",
                sourceActor: "",
                destinationActor: "",
                sourcePgh: scenario.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
                destinationPgh: scenario.mode === "pgh_pgh" ? "PGH_FEDERATED" : "PGH_A",
              },
              timingPoints: {
                requestSentMs: opStartMs,
                responseReturnedMs: Date.now(),
              },
            });
            scenarioCtx.actionRows.push(failedRow);
          }
        }
      }

      const scenarioEndMs = Date.now();
      const scenarioRow = summarizeScenario(scenarioCtx, scenario, iteration, scenarioEndMs);
      gasLogger.logScenario(scenarioRow);
      return scenarioRow;
    } finally {
      if (scenarioUsesEspBridge(scenario)) {
        await stopEspBridgeScenario(scenarioCtx);
      }
    }
  };

  const library = buildScenarioLibrary({
    includeModeB: modeBAvailable,
    includeSetup: CONFIG.includeSetupInScenario,
  });
  let allScenarios = (library.scenarios || library.pool || []).slice();
  if (CONFIG.onlyModeB) {
    allScenarios = allScenarios.filter((scenario) => scenario.mode === "pgh_pgh");
  }
  const scenarioById = new Map(allScenarios.map((scenario) => [scenario.id, scenario]));
  const explicitSelection = CONFIG.scenarioIds.length > 0 || Boolean(CONFIG.scenarioGroup);
  const disableRandomFill = CONFIG.disableRandomFill || explicitSelection;

  if (!allScenarios.length) {
    manifest.failures.push({ stage: "scenario_selection", message: "No scenarios available for current mode constraints" });
    manifest.ended_at = nowUtc();
    gasLogger.close();
    fs.writeFileSync(path.join(RESULTS_DIR, "run_manifest.json"), JSON.stringify(manifest, null, 2));
    console.error("No scenarios available for execution.");
    process.exit(1);
  }

  let selectedScenarios = [];
  if (CONFIG.scenarioIds.length) {
    for (const id of CONFIG.scenarioIds) {
      const scenario = scenarioById.get(id);
      if (!scenario) {
        manifest.failures.push({ stage: "scenario_selection", message: `Unknown scenario_id: ${id}` });
      } else {
        selectedScenarios.push(scenario);
      }
    }
  } else if (CONFIG.scenarioGroup) {
    selectedScenarios = allScenarios.filter((scenario) => scenario.group === CONFIG.scenarioGroup);
  } else if (Array.isArray(library.defaultScenarioIds) && library.defaultScenarioIds.length) {
    selectedScenarios = library.defaultScenarioIds
      .map((id) => scenarioById.get(id))
      .filter(Boolean);
  } else if (library.mandatory) {
    selectedScenarios = [library.mandatory];
  }
  if (!selectedScenarios.length) {
    selectedScenarios = [allScenarios[0]];
  }

  const executionQueue = [];
  for (const scenario of selectedScenarios) {
    for (let repeat = 0; repeat < CONFIG.scenarioRepeat; repeat += 1) {
      executionQueue.push(scenario);
    }
  }
  if (modeBAvailable && CONFIG.forceModeB && !executionQueue.some((scenario) => scenario.mode === "pgh_pgh")) {
    const modeBScenario = allScenarios.find((scenario) => scenario.mode === "pgh_pgh");
    if (modeBScenario) executionQueue.push(modeBScenario);
  }
  manifest.scenario_execution_plan = executionQueue.map((scenario, index) => ({
    order: index,
    scenario_id: scenario.id,
    scenario_group: scenario.group || "",
    mode: scenario.mode,
  }));

  const scenarioRows = [];
  let scenarioRuns = 0;
  for (const scenario of executionQueue) {
    if (scenarioRuns >= CONFIG.maxScenarios) break;
    const row = await runScenario(scenario, scenarioRuns);
    scenarioRows.push(row);
    scenarioRuns += 1;
  }

  if (CONFIG.minimal) {
    manifest.scenarios_generated = scenarioRuns;
    manifest.iterations_per_scenario = "minimal";
    manifest.total_operations = totalOperations;
    manifest.ended_at = nowUtc();
    gasLogger.close();
    fs.writeFileSync(path.join(RESULTS_DIR, "scenario_summary.json"), JSON.stringify(scenarioRows, null, 2));
    fs.writeFileSync(path.join(RESULTS_DIR, "run_manifest.json"), JSON.stringify(manifest, null, 2));
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const snapshotDir = path.join(ROOT, `thesis result sim${stamp}`);
    try {
      fs.mkdirSync(snapshotDir, { recursive: true });
      for (const file of ["gas_tx_level.csv", "gas_action_level.csv", "scenario_summary.csv", "scenario_summary.json", "run_manifest.json"]) {
        const src = path.join(RESULTS_DIR, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(snapshotDir, file));
        }
      }
    } catch (_err) {
      // ignore snapshot errors
    }
    console.log(`Evaluation complete (minimal). Results in ${RESULTS_DIR}`);
    return;
  }

  const benignPool = allScenarios.filter((s) => !s.operations.some((op) => op.behavior === "malicious"));
  const maliciousPool = allScenarios.filter((s) => s.operations.some((op) => op.behavior === "malicious"));

  while (!disableRandomFill && totalOperations < CONFIG.targetOps && scenarioRuns < CONFIG.maxScenarios) {
    const useMalicious = Math.random() < CONFIG.maliciousRate && maliciousPool.length;
    const candidates = useMalicious ? maliciousPool : (benignPool.length ? benignPool : allScenarios);
    const totalWeight = candidates.reduce((sum, s) => sum + (s.weight || 1), 0);
    let pick = Math.random() * totalWeight;
    let selected = candidates[0];
    for (const scenario of candidates) {
      pick -= scenario.weight || 1;
      if (pick <= 0) {
        selected = scenario;
        break;
      }
    }
    const row = await runScenario(selected, scenarioRuns);
    scenarioRows.push(row);
    scenarioRuns += 1;
  }

  manifest.scenarios_generated = scenarioRuns;
  manifest.iterations_per_scenario = CONFIG.scenarioRepeat > 1 ? CONFIG.scenarioRepeat : "variable";
  manifest.total_operations = totalOperations;
  manifest.ended_at = nowUtc();

  gasLogger.close();
  fs.writeFileSync(path.join(RESULTS_DIR, "scenario_summary.json"), JSON.stringify(scenarioRows, null, 2));
  fs.writeFileSync(path.join(RESULTS_DIR, "run_manifest.json"), JSON.stringify(manifest, null, 2));

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const snapshotDir = path.join(ROOT, `thesis result sim${stamp}`);
  try {
    fs.mkdirSync(snapshotDir, { recursive: true });
    for (const file of ["gas_tx_level.csv", "gas_action_level.csv", "scenario_summary.csv", "scenario_summary.json", "run_manifest.json"]) {
      const src = path.join(RESULTS_DIR, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(snapshotDir, file));
      }
    }
  } catch (_err) {
    // ignore snapshot errors
  }

  console.log(`Evaluation complete. Results in ${RESULTS_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
