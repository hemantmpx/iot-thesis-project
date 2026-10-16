#!/usr/bin/env node
/**
 * Full simulation via PGH endpoints (single source of truth):
 * - Picks Role.NONE object/subject addresses from tmp/ganache-keys.json (checks RoleToken on RPC_URL)
 * - Registers both (type1) via /register-device
 * - Deploys ACC via /deploy-contract
 * - Adds allow(view) + deny(edit) policies via /policies
 * - Executes evaluate-access (view, too-frequent view, edit) with logOnChain using subject's private key
 * - Captures responses and PGH /status; writes iot/pi/results/run-all-via-pgh-<timestamp>/report.json
 *
 * Prereqs:
 * - Ganache running and bootstrapped (tmp/deployed-addresses.json matches chain)
 * - PGH running on API_BASE (default http://localhost:8080)
 * - iot/pi/.env has RPC_URL and admin keys (PGH uses PRIMARY_HEAD_KEY/ADMIN_KEY)
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("../node_modules/ethers");
const { spawn, execSync } = require("child_process");
require("../node_modules/dotenv").config({ path: path.join(__dirname, "..", ".env") });

const API_BASE = process.env.PGH_API_BASE || "http://localhost:8080";
const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error("RPC_URL is not set in iot/pi/.env");
  process.exit(1);
}

const deployed = require(path.join(__dirname, "..", "..", "..", "tmp", "deployed-addresses.json"));
const keysPath = path.join(__dirname, "..", "..", "..", "tmp", "ganache-keys.json");
const keysRaw = JSON.parse(fs.readFileSync(keysPath, "utf8"));
const privateKeys = keysRaw.private_keys || {};
const roleTokenAbi = require(path.join(__dirname, "..", "..", "abis", "RoleToken.json")).abi;
const provider = new ethers.JsonRpcProvider(RPC_URL);
const roleToken = new ethers.Contract(deployed.addresses.roleToken, roleTokenAbi, provider);
const envPath = path.join(__dirname, "..", ".env");
const METRICS_URL = process.env.METRICS_URL || `${API_BASE}/metrics`;

function fromEnv(name) {
  const v = process.env[name];
  return v ? v.trim() : null;
}

async function pickAddresses() {
  const fixedObj = fromEnv("FIXED_OBJECT");
  const fixedSubj = fromEnv("FIXED_SUBJECT");
  const out = [];
  if (fixedObj && privateKeys[fixedObj.toLowerCase()]) {
    out.push({ address: fixedObj, privateKey: privateKeys[fixedObj.toLowerCase()] });
  }
  if (fixedSubj && privateKeys[fixedSubj.toLowerCase()]) {
    out.push({ address: fixedSubj, privateKey: privateKeys[fixedSubj.toLowerCase()] });
  }
  if (out.length === 2) return out;

  const picks = [];
  for (const [addr, pk] of Object.entries(privateKeys)) {
    if (picks.length >= 2) break;
    try {
      const role = await roleToken.getRole(addr);
      if (role.toString() === "0") picks.push({ address: addr, privateKey: pk });
    } catch (_e) {
      continue;
    }
  }
  if (picks.length < 2) throw new Error("Not enough Role.NONE addresses available");
  return picks;
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

function setEnvKey(envContent, key, value) {
  const lines = envContent.split(/\r?\n/);
  let found = false;
  const updated = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) updated.push(`${key}=${value}`);
  return updated.join("\n");
}

async function waitForPghReady(base, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${base}/status`);
      if (r.ok) return true;
    } catch (_e) {
      // keep trying
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`PGH not reachable at ${base} after ${timeoutMs}ms`);
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

async function findFreshKey(exclude) {
  const entries = Object.values(privateKeys)
    .map((pk) => ({ pk }));
  const scored = [];
  for (const e of entries) {
    if (e.pk === exclude) continue;
    const wallet = new ethers.Wallet(e.pk);
    try {
      const nonce = await provider.getTransactionCount(wallet.address);
      scored.push({ pk: e.pk, nonce });
    } catch (_e) {
      continue;
    }
  }
  scored.sort((a, b) => a.nonce - b.nonce);
  return scored[0]?.pk || null;
}

async function rotateKeyAndRestart(force = false) {
  if (!force && process.env.AUTO_ROTATE_PGH_KEY !== "1") return;

  const envRaw = fs.readFileSync(envPath, "utf8");
  const currentKey =
    (envRaw.match(/PRIMARY_HEAD_KEY=([^\n\r]+)/) || [null, null])[1] ||
    process.env.PRIMARY_HEAD_KEY;

  const replacement = await findFreshKey(currentKey);
  if (!replacement) {
    console.warn("AUTO_ROTATE_PGH_KEY=1 set but no alternate key found; skipping rotation");
    return;
  }

  let nextEnv = setEnvKey(envRaw, "PRIMARY_HEAD_KEY", replacement);
  fs.writeFileSync(envPath, nextEnv, "utf8");
  console.log("Rotated PRIMARY_HEAD_KEY in .env for PGH; ensuring admin role and restarting PGH...");

  try {
    const adminKey =
      (envRaw.match(/ADMIN_KEY=([^\n\r]+)/) || [null, null])[1] ||
      process.env.ADMIN_KEY;
    if (adminKey) {
      const roleAbi = require(path.join(__dirname, "..", "..", "abis", "RoleToken.json")).abi;
      const deployed = require(path.join(__dirname, "..", "..", "..", "tmp", "deployed-addresses.json"));
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      const adminWallet = new ethers.Wallet(adminKey, provider);
      const roleToken = new ethers.Contract(deployed.addresses.roleToken, roleAbi, adminWallet);
      const pghAddr = new ethers.Wallet(replacement).address;
      const role = await roleToken.getRole(pghAddr);
      if (role.toString() !== "1") {
        const owner = await roleToken.owner();
        const tx = await roleToken.assignAdminRole(owner, pghAddr);
        await tx.wait();
      }
    }
  } catch (_e) {
    // ignore admin grant errors
  }

  try {
    execSync("pkill -f primary_head || true", {
      cwd: path.join(__dirname, "..", "..", ".."),
      stdio: "ignore",
    });
  } catch (_e) {
    // ignore
  }

  const p = spawn(
    "npm",
    ["--prefix", "iot/pi", "start"],
    {
      cwd: path.join(__dirname, "..", "..", ".."),
      detached: true,
      stdio: "ignore",
    }
  );
  p.unref();
  await waitForPghReady(API_BASE);
}

async function runFlow() {
  // Optional rotation; if you want to stick to a single admin key, leave AUTO_ROTATE_PGH_KEY unset.
  await rotateKeyAndRestart(false);

  const [object, subject] = await pickAddresses();
  const memberType = "type1";
  const accType = "sensor";
  const resource = "sensor/temp";
  const out = {
    objectAddress: object.address,
    subjectAddress: subject.address,
    steps: [],
    errors: [],
    metrics: [],
  };

  async function timedPost(label, path, payload) {
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
            gasCostWei = rcpt.gasUsed * eff;
          }
        }
      } catch (_e) {
        // ignore receipt errors
      }
    }
    out.metrics.push({
      step: label,
      status: res.status,
      txHash,
      durationMs,
      gasUsed,
      gasCostWei: gasCostWei ? gasCostWei.toString() : null,
    });
    return res;
  }

  // register object and subject
  for (const [addr, name] of [
    [object.address, "object"],
    [subject.address, "subject"],
  ]) {
    const r = await timedPost(`register-${name}`, "/register-device", {
      deviceAddress: addr,
      name,
      memberType,
    });
    out.steps.push({ action: "register-device", addr, status: r.status, body: r.body });
    if (r.status !== 200) out.errors.push(`register ${name}: ${JSON.stringify(r.body)}`);
  }

  // deploy ACC
  const dep = await timedPost("deploy-contract", "/deploy-contract", {
    objectAddress: object.address,
    subjectAddress: subject.address,
    accType,
  });
  out.steps.push({ action: "deploy-contract", status: dep.status, body: dep.body });
  if (dep.status !== 200) out.errors.push(`deploy: ${JSON.stringify(dep.body)}`);
  const accAddr = dep.body.contractAddress || dep.body.contract_address || null;

  // policies
  const polAllow = await timedPost("policy-allow", "/policies", {
    objectAddress: object.address,
    subjectAddress: subject.address,
    accType,
    resource,
    action: "view",
    permission: "allow",
  });
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
    });
    out.steps.push({ action: "policy-add", act: "edit", status: polDeny.status, body: polDeny.body });
    if (polDeny.status !== 200) out.errors.push(`policy edit: ${JSON.stringify(polDeny.body)}`);
  }

  // evaluations (allow, too-frequent, tamper) with logOnChain
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
    });
    out.steps.push({ action: "evaluate-access", act, status: ev.status, body: ev.body });
    if (ev.status !== 200) out.errors.push(`evaluate ${act}: ${JSON.stringify(ev.body)}`);
  }

  // status snapshot
  const statusRes = await fetch(`${API_BASE}/status`);
  out.status = statusRes.ok ? await statusRes.json() : await statusRes.text();

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(__dirname, "..", "results", `run-all-via-pgh-${ts}`);
  fs.mkdirSync(runDir, { recursive: true });
  const outPath = path.join(runDir, "report.json");
  out.metricsSnapshotPath = await writeMetrics("pgh-sim", runDir);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
  console.log(`PGH-driven sim complete. See ${outPath}`);
  if (accAddr) console.log(`ACC: ${accAddr}`);
  if (out.errors.length) {
    console.log("Errors:", out.errors);
  }

  return { out, outPath };
}

async function main() {
  let rotated = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { out } = await runFlow();
      const nonceInErrors = (out.errors || []).some((e) => /nonce/i.test(e));
      if (nonceInErrors && !rotated) {
        console.log("Nonce issue detected in responses; rotating key and retrying...");
        await rotateKeyAndRestart(true);
        rotated = true;
        continue;
      }
      return;
    } catch (err) {
      if (!rotated && /nonce/i.test(err.message || "")) {
        console.log("Nonce exception detected; rotating key and retrying...");
        await rotateKeyAndRestart(true);
        rotated = true;
        continue;
      }
      console.error(err);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
