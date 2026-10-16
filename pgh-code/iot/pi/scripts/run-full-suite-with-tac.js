#!/usr/bin/env node
/**
 * Full suite including TableAccessControl:
 * - Uses admin signer (RoleToken owner) and fixed/reclaimed Role.NONE object/subject
 * - Registers object/subject (type1) via PGH
 * - Deploys ACC, adds allow (view) and deny (edit) policies
 * - Evaluates view/edit (strict success uses only view)
 * - Adds TAC policy for Regular member to view LocalResourceTable
 * - Subject creates access request for LocalResourceTable; PrimaryHead approves; Subject views table
 * - Captures metrics (duration, txHash, gasUsed, gasCostWei) for all txs
 * - Writes result to iot/pi/results/run-full-suite-with-tac-<timestamp>/report.json
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("../node_modules/ethers");
require("../node_modules/dotenv").config({ path: path.join(__dirname, "..", ".env") });

const API_BASE = process.env.PGH_API_BASE || "http://127.0.0.1:8080";
const METRICS_URL = process.env.METRICS_URL || `${API_BASE}/metrics`;
const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error("RPC_URL is not set");
  process.exit(1);
}

const deployed = require(path.join(__dirname, "..", "..", "..", "tmp", "deployed-addresses.json"));
const keysPath = path.join(__dirname, "..", "..", "..", "tmp", "ganache-keys.json");
const keysRaw = JSON.parse(fs.readFileSync(keysPath, "utf8"));
const privateKeys = keysRaw.private_keys || {};

const abiDir = path.join(__dirname, "..", "..", "abis");
const roleTokenAbi = require(path.join(abiDir, "RoleToken.json")).abi;
let tacAbi;
const tacLocal = path.join(abiDir, "TableAccessControlContract.json");
const tacFallback = path.join(__dirname, "..", "..", "..", "informational", "contracts", "artifacts", "TableAccessControlContract.json");
if (fs.existsSync(tacLocal)) {
  tacAbi = require(tacLocal).abi;
} else {
  tacAbi = require(tacFallback).abi;
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const roleToken = new ethers.Contract(deployed.addresses.roleToken, roleTokenAbi, provider);
const tac = new ethers.Contract(deployed.addresses.tableAccessControlContract, tacAbi, provider);

function fromEnv(name) {
  const v = process.env[name];
  return v ? v.trim() : null;
}

async function findAdminWallet() {
  const owner = await roleToken.owner();
  const pk = privateKeys[owner.toLowerCase()];
  if (!pk) throw new Error(`Admin key for owner ${owner} not found in ganache-keys.json`);
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
    } catch (_) {
      // ignore
    }
  }
}

async function pickObjectSubject(adminWallet) {
  const envObj = fromEnv("FIXED_OBJECT");
  const envSub = fromEnv("FIXED_SUBJECT");
  const selected = [];
  if (envObj && privateKeys[envObj.toLowerCase()]) selected.push(envObj);
  if (envSub && privateKeys[envSub.toLowerCase()]) selected.push(envSub);
  if (selected.length === 2) {
    await ensureNone(selected[0], adminWallet);
    await ensureNone(selected[1], adminWallet);
    return [
      { address: selected[0], privateKey: privateKeys[selected[0].toLowerCase()] },
      { address: selected[1], privateKey: privateKeys[selected[1].toLowerCase()] },
    ];
  }
  const none = [];
  for (const a of Object.keys(privateKeys)) {
    const r = await roleOf(a);
    if (r === "0") none.push(a);
  }
  if (none.length < 2) {
    for (const a of Object.keys(privateKeys)) {
      if (a.toLowerCase() === adminWallet.address.toLowerCase()) continue;
      const r = await roleOf(a);
      if (r && r !== "0" && r !== "1") {
        await ensureNone(a, adminWallet);
        if ((await roleOf(a)) === "0") none.push(a);
        if (none.length >= 2) break;
      }
    }
  }
  if (none.length < 2) throw new Error("Not enough Role.NONE addresses available");
  return [
    { address: none[0], privateKey: privateKeys[none[0].toLowerCase()] },
    { address: none[1], privateKey: privateKeys[none[1].toLowerCase()] },
  ];
}

async function postJson(pathname, payload) {
  const res = await fetch(`${API_BASE}${pathname}`, {
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

async function timedTx(label, fnSend, outMetrics) {
  const start = Date.now();
  const rec = await fnSend();
  const durationMs = Date.now() - start;
  const gasUsed = rec.gasUsed?.toString?.() || null;
  let gasCostWei = null;
  if (rec.gasUsed && rec.gasPrice) {
    gasCostWei = (rec.gasUsed * rec.gasPrice).toString();
  } else if (rec.effectiveGasPrice && rec.gasUsed) {
    gasCostWei = (rec.gasUsed * rec.effectiveGasPrice).toString();
  }
  outMetrics.push({
    step: label,
    txHash: rec.hash,
    durationMs,
    gasUsed,
    gasCostWei,
  });
  return rec;
}

async function timedPost(label, path, payload, outMetrics) {
  const start = Date.now();
  const res = await postJson(path, payload);
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
  outMetrics.push({ step: label, status: res.status, txHash, durationMs, gasUsed, gasCostWei });
  return res;
}

async function writeMetrics(tag, runDir) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(runDir, `metrics-${tag}-${ts}.txt`);
  try {
    const res = await fetch(METRICS_URL);
    const text = await res.text();
    fs.writeFileSync(outPath, text, "utf8");
  } catch (err) {
    fs.writeFileSync(outPath, `metrics unavailable: ${err.message || err}`, "utf8");
  }
  return outPath;
}

async function main() {
  const out = { steps: [], errors: [], metrics: [] };
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(__dirname, "..", "results", `run-full-suite-with-tac-${ts}`);
  fs.mkdirSync(runDir, { recursive: true });
  const outPath = path.join(runDir, "report.json");

  const adminWallet = await findAdminWallet();
  const [object, subject] = await pickObjectSubject(adminWallet);
  const objWallet = new ethers.Wallet(object.privateKey, provider);
  const subjWallet = new ethers.Wallet(subject.privateKey, provider);
  const memberType = "type1";
  const accType = "sensor";
  const resource = "sensor/temp";

  // Register object first (to become PGH), then subject
  for (const [addr, name] of [
    [object.address, "object"],
    [subject.address, "subject"],
  ]) {
    const r = await timedPost(`register-${name}`, "/register-device", {
      deviceAddress: addr,
      name,
      memberType,
    }, out.metrics);
    out.steps.push({ action: "register-device", addr, status: r.status, body: r.body });
    if (r.status !== 200) out.errors.push(`register ${name}: ${JSON.stringify(r.body)}`);
  }

  // Deploy ACC via PGH
  const dep = await timedPost("deploy-contract", "/deploy-contract", {
    objectAddress: object.address,
    subjectAddress: subject.address,
    accType,
  }, out.metrics);
  out.steps.push({ action: "deploy-contract", status: dep.status, body: dep.body });
  if (dep.status !== 200) out.errors.push(`deploy: ${JSON.stringify(dep.body)}`);

  // Policies
  const polAllow = await timedPost("policy-allow", "/policies", {
    objectAddress: object.address,
    subjectAddress: subject.address,
    accType,
    resource,
    action: "view",
    permission: "allow",
  }, out.metrics);
  out.steps.push({ action: "policy-add", act: "view", status: polAllow.status, body: polAllow.body });
  if (polAllow.status !== 200) out.errors.push(`policy view: ${JSON.stringify(polAllow.body)}`);

  if (process.env.STRICT_SUCCESS !== "1") {
    const polDeny = await timedPost("policy-deny", "/policies", {
      objectAddress: object.address,
      subjectAddress: subject.address,
      accType,
      resource,
      action: "edit",
      permission: "deny",
    }, out.metrics);
    out.steps.push({ action: "policy-add", act: "edit", status: polDeny.status, body: polDeny.body });
    if (polDeny.status !== 200) out.errors.push(`policy edit: ${JSON.stringify(polDeny.body)}`);
  }

  // Evaluations
  const evalActs = process.env.STRICT_SUCCESS === "1" ? ["view"] : ["view", "view", "edit"];
  for (const act of evalActs) {
    const ev = await timedPost(`evaluate-${act}`, "/evaluate-access", {
      subjectAddress: subject.address,
      objectAddress: object.address,
      accType,
      resource,
      action: act,
      logOnChain: true,
      subjectPrivateKey: subject.privateKey,
    }, out.metrics);
    out.steps.push({ action: "evaluate-access", act, status: ev.status, body: ev.body });
    if (ev.status !== 200) out.errors.push(`evaluate ${act}: ${JSON.stringify(ev.body)}`);
  }

  // TableAccessControl: add policy, create/approve request, view local table
  try {
    const ownerOfTac = await tac.owner();
    if (ownerOfTac.toLowerCase() !== adminWallet.address.toLowerCase()) {
      out.errors.push("tac owner mismatch; skipping TAC steps");
    } else {
      // Add policy for Regular Member to view LocalResourceTable (RoleToken.Role.REGULAR_MEMBER = 4)
      await timedTx("tac-policy-regular-view-local", () =>
        tac.connect(adminWallet).policyAdd(4, "LocalResourceTable", "view", "allow"), out.metrics);

      // Subject creates access request
      await timedTx("tac-create-request-local-view", () =>
        tac.connect(subjWallet).createAccessRequest("LocalResourceTable", "view"), out.metrics);

      // Object (PGH/primary head) approves
      await timedTx("tac-approve-request-local", () =>
        tac.connect(objWallet).handleAccessRequest(0, true), out.metrics);

      // Subject views local table
      const start = Date.now();
      await tac.connect(subjWallet).viewLocalResourceTable();
      out.metrics.push({ step: "tac-view-local", status: 200, durationMs: Date.now() - start });
      out.steps.push({ action: "tac-local-view", status: 200 });
    }
  } catch (e) {
    out.errors.push(`tac: ${e.message || e}`);
  }

  out.metricsSnapshotPath = await writeMetrics("full-suite-tac", runDir);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
  console.log(`Full suite with TAC complete. See ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
