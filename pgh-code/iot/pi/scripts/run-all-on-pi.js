#!/usr/bin/env node
/**
 * One-shot on-Pi simulation using all contracts (no PGH endpoints):
 * - Validates contract addresses exist (RoleToken, RoleBased, Factory, Register, Judge)
 * - Picks Role.NONE addresses from tmp/ganache-keys.json for object/subject
 * - Registers object/subject (same memberType)
 * - Deploys ACC via factory + Register
 * - Adds allow(view) + deny(edit) policies
 * - Executes accessControl txs (allow, too-frequent, tamper) from the subject
 * - Captures tx hashes, gas, roles, judge blocking; writes iot/pi/results/run-all-<timestamp>.json
 *
 * Prereqs:
 * - Ganache running (RPC_URL in iot/pi/.env points to it)
 * - tmp/deployed-addresses.json and tmp/ganache-keys.json are in sync with the chain
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("../node_modules/ethers");
require("../node_modules/dotenv").config({ path: path.join(__dirname, "..", ".env") });

const deployed = require(path.join(__dirname, "..", "..", "..", "tmp", "deployed-addresses.json"));
const keysPath = path.join(__dirname, "..", "..", "..", "tmp", "ganache-keys.json");
const keysRaw = JSON.parse(fs.readFileSync(keysPath, "utf8"));
const privateKeys = keysRaw.private_keys || {};
const abiDir = path.join(__dirname, "..", "..", "abis");
const abiRoleToken = require(path.join(abiDir, "RoleToken.json")).abi;
const abiRoleBased = require(path.join(abiDir, "RoleBasedAccessControl.json")).abi;
const abiFactory = require(path.join(abiDir, "AccessControlFactory.json")).abi;
const abiRegister = require(path.join(abiDir, "RegisterContract.json")).abi;
const abiAcc = require(path.join(abiDir, "AccessControlContract.json")).abi;
const abiJudge = require(path.join(abiDir, "JudgeContract.json")).abi;

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error("RPC_URL not set in iot/pi/.env");
  process.exit(1);
}
const METRICS_URL = process.env.METRICS_URL || "http://127.0.0.1:8080/metrics";
const provider = new ethers.JsonRpcProvider(RPC_URL);

function walletFor(addr) {
  const pk = privateKeys[addr.toLowerCase()];
  if (!pk) return null;
  return new ethers.Wallet(pk, provider);
}

async function ensureCode(address, name) {
  const code = await provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${name} not deployed at ${address}`);
}

async function pickRoleNone(count, roleToken) {
  const picks = [];
  for (const [addr, pk] of Object.entries(privateKeys)) {
    if (picks.length >= count) break;
    try {
      const role = await roleToken.getRole(addr);
      if (role.toString() === "0") picks.push({ address: addr, privateKey: pk });
    } catch (e) {
      continue;
    }
  }
  if (picks.length < count) throw new Error("Not enough Role.NONE addresses");
  return picks;
}

async function main() {
  const out = { steps: [], errors: [] };
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(__dirname, "..", "results", `run-all-on-pi-${ts}`);
  fs.mkdirSync(runDir, { recursive: true });
  const outFile = path.join(runDir, "report.json");
  const metricsFile = path.join(runDir, "metrics.txt");

  await ensureCode(deployed.addresses.roleToken, "RoleToken");
  await ensureCode(deployed.addresses.roleBasedAccessControl, "RoleBasedAccessControl");
  await ensureCode(deployed.addresses.accessControlFactory, "AccessControlFactory");
  await ensureCode(deployed.addresses.registerContract, "RegisterContract");
  await ensureCode(deployed.addresses.judgeContract, "JudgeContract");

  const roleToken = new ethers.Contract(deployed.addresses.roleToken, abiRoleToken, provider);
  const roleBased = new ethers.Contract(deployed.addresses.roleBasedAccessControl, abiRoleBased, provider);
  const factory = new ethers.Contract(deployed.addresses.accessControlFactory, abiFactory, provider);
  const register = new ethers.Contract(deployed.addresses.registerContract, abiRegister, provider);
  const judge = new ethers.Contract(deployed.addresses.judgeContract, abiJudge, provider);

  const ownerAddr = await roleToken.owner();
  const adminPk = process.env.ADMIN_KEY ? process.env.ADMIN_KEY.trim() : null;
  const envPk = process.env.PRIMARY_HEAD_KEY ? process.env.PRIMARY_HEAD_KEY.trim() : null;
  const envWallet = adminPk
    ? new ethers.Wallet(adminPk, provider)
    : envPk
    ? new ethers.Wallet(envPk, provider)
    : null;
  const ownerWallet = envWallet || walletFor(ownerAddr);
  if (!ownerWallet) throw new Error(`No private key for owner ${ownerAddr}; set PRIMARY_HEAD_KEY or use a ganache key that owns RoleToken.`);
  out.owner = ownerWallet.address;

  const [object, subjectA, subjectB] = await pickRoleNone(3, roleToken);
  out.object = object.address;
  out.subject = subjectA.address;
  out.extraSubject = subjectB.address;
  const memberType = "type1";

  async function reg(addr, name) {
    const tx = await roleBased.connect(ownerWallet).assignRole(addr, name, memberType);
    const rec = await tx.wait();
    out.steps.push({ action: "registerRole", addr, memberType, txHash: rec.hash });
  }
  try { await reg(object.address, "object"); } catch (e) { out.errors.push(`register object: ${e.message}`); }
  try { await reg(subjectA.address, "subjectA"); } catch (e) { out.errors.push(`register subjectA: ${e.message}`); }
  try { await reg(subjectB.address, "subjectB"); } catch (e) { out.errors.push(`register subjectB: ${e.message}`); }

  // Deploy ACC for subjectA/object/type sensor
  let accAddr = await register.getAccessControlContract(object.address, subjectA.address, "sensor");
  if (!accAddr || accAddr === ethers.ZeroAddress) {
    const tx = await factory.connect(ownerWallet).deployAccessControlContract(object.address, subjectA.address, "sensor");
    const rec = await tx.wait();
    accAddr = await register.getAccessControlContract(object.address, subjectA.address, "sensor");
    out.steps.push({ action: "deployAcc", txHash: rec.hash, accAddr });
  } else {
    out.steps.push({ action: "deployAcc", note: "exists", accAddr });
  }
  const acc = new ethers.Contract(accAddr, abiAcc, ownerWallet);

  // Policies
  const p1 = await acc.policyAdd("sensor/temp", "view", "allow");
  out.steps.push({ action: "policyAdd", resource: "sensor/temp", act: "view", perm: "allow", txHash: (await p1.wait()).hash });
  const p2 = await acc.policyAdd("sensor/temp", "edit", "deny");
  out.steps.push({ action: "policyAdd", resource: "sensor/temp", act: "edit", perm: "deny", txHash: (await p2.wait()).hash });

  // Access calls from subjectA
  const subjWallet = new ethers.Wallet(subjectA.privateKey, provider);
  async function callAccess(action) {
    try {
      const tx = await acc.connect(subjWallet).accessControl("sensor/temp", action);
      const rec = await tx.wait();
      out.steps.push({ action: "accessControl", act: action, txHash: rec.hash, gasUsed: rec.gasUsed.toString() });
    } catch (e) {
      out.errors.push(`access ${action}: ${e.message}`);
    }
  }
  await callAccess("view");
  await callAccess("view"); // too-frequent check
  await callAccess("edit"); // tamper/deny

  // Roles and judge blocking
  async function roleOf(addr) {
    try { return (await roleToken.getRole(addr)).toString(); } catch { return "err"; }
  }
  out.roles = {
    object: await roleOf(object.address),
    subjectA: await roleOf(subjectA.address),
    subjectB: await roleOf(subjectB.address),
    owner: await roleOf(ownerAddr),
  };
  try {
    const blk = await judge.getBlockingEndTime(subjectA.address);
    out.judgeBlocking = blk.toString();
  } catch (e) {
    out.errors.push(`judge blocking: ${e.message}`);
  }

  // Best-effort metrics snapshot (PGH may or may not be running)
  try {
    const res = await fetch(METRICS_URL);
    const text = await res.text();
    fs.writeFileSync(metricsFile, text, "utf8");
    out.metricsSnapshotPath = metricsFile;
  } catch (err) {
    fs.writeFileSync(metricsFile, `metrics unavailable: ${err.message || err}`, "utf8");
    out.metricsSnapshotPath = metricsFile;
  }

  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), "utf8");
  console.log(`Run complete. See ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
