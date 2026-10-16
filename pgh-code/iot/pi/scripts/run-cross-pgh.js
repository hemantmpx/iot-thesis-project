#!/usr/bin/env node
/**
 * Cross-PGH automation with on-chain logging:
 * - Uses RoleToken owner as admin signer (from ganache-keys.json)
 * - Reclaims Role.NONE addresses for each PGH (object/subject)
 * - Registers object/subject (type1) on each PGH
 * - Deploys ACC (sensor) and adds allow(view) policy on each PGH
 * - Evaluates cross-PGH access both ways with logOnChain=true using subject private keys
 * - Captures metrics (duration, txHash, gasUsed, gasCostWei) per step
 * - Writes to iot/pi/results/run-cross-pgh-<timestamp>/report.json
 *
 * Env vars:
 *  RPC_URL=http://<ganache>
 *  PGH_A_BASE=http://127.0.0.1:8080   (default)
 *  PGH_B_BASE=http://127.0.0.1:8081   (default)
 *  AUTO_ROTATE_PGH_KEY ignored here; we always use admin owner key
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("../node_modules/ethers");
require("../node_modules/dotenv").config({ path: path.join(__dirname, "..", ".env") });

const RPC_URL = process.env.RPC_URL;
const PGH_A = process.env.PGH_A_BASE || "http://127.0.0.1:8080";
const PGH_B = process.env.PGH_B_BASE || "http://127.0.0.1:8081";
const METRICS_A_URL = process.env.METRICS_A_URL || `${PGH_A}/metrics`;
const METRICS_B_URL = process.env.METRICS_B_URL || `${PGH_B}/metrics`;
if (!RPC_URL) {
  console.error("RPC_URL is required");
  process.exit(1);
}

const deployed = require(path.join(__dirname, "..", "..", "..", "tmp", "deployed-addresses.json"));
const keysPath = path.join(__dirname, "..", "..", "..", "tmp", "ganache-keys.json");
const keysRaw = JSON.parse(fs.readFileSync(keysPath, "utf8"));
const privateKeys = keysRaw.private_keys || {};
const abiDir = path.join(__dirname, "..", "..", "abis");
const roleTokenAbi = require(path.join(abiDir, "RoleToken.json")).abi;

const provider = new ethers.JsonRpcProvider(RPC_URL);
const roleToken = new ethers.Contract(deployed.addresses.roleToken, roleTokenAbi, provider);

async function findAdminWallet() {
  const owner = await roleToken.owner();
  const pk = privateKeys[owner.toLowerCase()];
  if (!pk) throw new Error(`Admin key not found for owner ${owner}`);
  return new ethers.Wallet(pk, provider);
}

async function roleOf(addr) {
  try {
    return (await roleToken.getRole(addr)).toString();
  } catch {
    return null;
  }
}

async function ensureNone(addr, adminWallet) {
  const r = await roleOf(addr);
  if (r && r !== "0" && r !== "1") {
    try {
      const tx = await roleToken.connect(adminWallet).revokeRole(addr);
      await tx.wait();
    } catch (_e) {
      // ignore
    }
  }
}

async function pickPair(adminWallet) {
  const none = [];
  for (const a of Object.keys(privateKeys)) {
    if ((await roleOf(a)) === "0") none.push(a);
    if (none.length >= 4) break;
  }
  if (none.length < 4) {
    for (const a of Object.keys(privateKeys)) {
      if (a.toLowerCase() === adminWallet.address.toLowerCase()) continue;
      const r = await roleOf(a);
      if (r && r !== "0" && r !== "1") {
        await ensureNone(a, adminWallet);
        if ((await roleOf(a)) === "0") none.push(a);
        if (none.length >= 4) break;
      }
    }
  }
  if (none.length < 4) throw new Error("Not enough Role.NONE addresses for two PGHs");
  const [objA, subjA, objB, subjB] = none;
  return {
    A: { object: objA, subject: subjA },
    B: { object: objB, subject: subjB },
  };
}

async function postJson(base, pathname, payload) {
  const res = await fetch(`${base}${pathname}`, {
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
  return { status: res.status, body };
}

async function timedPost(label, base, path, payload, metrics) {
  const start = Date.now();
  const res = await postJson(base, path, payload);
  const durationMs = Date.now() - start;
  const txHash =
    res.body?.txHash ||
    res.body?.tx_hash ||
    res.body?.txhash ||
    res.body?.transactionHash ||
    res.body?.deployTxHash ||
    null;
  let gasUsed = null;
  let gasCostWei = null;
  if (txHash) {
    try {
      const rcpt = await provider.getTransactionReceipt(txHash);
      if (rcpt) {
        gasUsed = rcpt.gasUsed?.toString?.() || null;
        const eff = rcpt.effectiveGasPrice;
        if (eff && rcpt.gasUsed) {
          gasCostWei = (rcpt.gasUsed * eff).toString();
        }
      }
    } catch (_) {
      // ignore
    }
  }
  metrics.push({ step: label, status: res.status, txHash, durationMs, gasUsed, gasCostWei });
  return res;
}

async function writeMetrics(url, tag, runDir) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(runDir, `metrics-${tag}-${ts}.txt`);
  try {
    const res = await fetch(url);
    const text = await res.text();
    fs.writeFileSync(outPath, text, "utf8");
  } catch (err) {
    fs.writeFileSync(outPath, `metrics unavailable: ${err.message || err}`, "utf8");
  }
  return outPath;
}

async function runFor(baseLabel, baseUrl, object, subject, metrics, errors) {
  const accType = "sensor";
  const resource = "sensor/temp";
  // register
  for (const [addr, name] of [
    [object.address, "object"],
    [subject.address, "subject"],
  ]) {
    const r = await timedPost(`${baseLabel}-register-${name}`, baseUrl, "/register-device", {
      deviceAddress: addr,
      name,
      memberType: "type1",
    }, metrics);
    if (r.status !== 200) errors.push(`register ${baseLabel} ${name}: ${JSON.stringify(r.body)}`);
  }
  // deploy
  const dep = await timedPost(`${baseLabel}-deploy`, baseUrl, "/deploy-contract", {
    objectAddress: object.address,
    subjectAddress: subject.address,
    accType,
  }, metrics);
  let accAddr = dep.body?.contractAddress || dep.body?.contract_address || null;
  if (dep.status !== 200) errors.push(`deploy ${baseLabel}: ${JSON.stringify(dep.body)}`);
  // policy allow
  const pol = await timedPost(`${baseLabel}-policy-allow`, baseUrl, "/policies", {
    objectAddress: object.address,
    subjectAddress: subject.address,
    accType,
    resource,
    action: "view",
    permission: "allow",
  }, metrics);
  if (pol.status !== 200) errors.push(`policy ${baseLabel}: ${JSON.stringify(pol.body)}`);
  return accAddr;
}

async function main() {
  const out = { steps: [], errors: [], metrics: [] };
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(__dirname, "..", "results", `run-cross-pgh-${ts}`);
  fs.mkdirSync(runDir, { recursive: true });
  const outPath = path.join(runDir, "report.json");

  const admin = await findAdminWallet();
  const pair = await pickPair(admin);

  const objA = { address: pair.A.object, privateKey: privateKeys[pair.A.object.toLowerCase()] };
  const subjA = { address: pair.A.subject, privateKey: privateKeys[pair.A.subject.toLowerCase()] };
  const objB = { address: pair.B.object, privateKey: privateKeys[pair.B.object.toLowerCase()] };
  const subjB = { address: pair.B.subject, privateKey: privateKeys[pair.B.subject.toLowerCase()] };

  // PGH A
  const accA = await runFor("A", PGH_A, objA, subjA, out.metrics, out.errors);
  // PGH B
  const accB = await runFor("B", PGH_B, objB, subjB, out.metrics, out.errors);

  // Cross evaluate: B subject -> A object
  const evalBA = await timedPost("eval-B-on-A", PGH_A, "/evaluate-access", {
    subjectAddress: subjB.address,
    objectAddress: objA.address,
    accType: "sensor",
    resource: "sensor/temp",
    action: "view",
    logOnChain: true,
    subjectPrivateKey: subjB.privateKey,
  }, out.metrics);
  out.steps.push({ action: "eval-B-on-A", status: evalBA.status, body: evalBA.body });
  if (evalBA.status !== 200) out.errors.push(`eval B->A: ${JSON.stringify(evalBA.body)}`);

  // Cross evaluate: A subject -> B object
  const evalAB = await timedPost("eval-A-on-B", PGH_B, "/evaluate-access", {
    subjectAddress: subjA.address,
    objectAddress: objB.address,
    accType: "sensor",
    resource: "sensor/temp",
    action: "view",
    logOnChain: true,
    subjectPrivateKey: subjA.privateKey,
  }, out.metrics);
  out.steps.push({ action: "eval-A-on-B", status: evalAB.status, body: evalAB.body });
  if (evalAB.status !== 200) out.errors.push(`eval A->B: ${JSON.stringify(evalAB.body)}`);

  out.metricsSnapshotA = await writeMetrics(METRICS_A_URL, "cross-pgh-A", runDir);
  out.metricsSnapshotB = await writeMetrics(METRICS_B_URL, "cross-pgh-B", runDir);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
  console.log(`Cross-PGH suite complete. See ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
