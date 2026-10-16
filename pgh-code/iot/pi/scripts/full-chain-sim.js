#!/usr/bin/env node
/**
 * Full chain simulation using all contracts:
 * - Picks unused wallets (Role.NONE) for object/subjects
 * - Registers roles via RoleBasedAccessControl
 * - Deploys ACC via AccessControlFactory
 * - Adds allow/deny policies
 * - Executes on-chain accessControl txs (allow, too-frequent, tamper/deny)
 * - Captures tx hashes, events, balances, token adjustments
 * - Writes results to iot/pi/results/full-sim-<timestamp>.json
 *
 * Prereqs:
 * - Ganache running with tmp/ganache-keys.json
 * - Contracts bootstrapped (tmp/deployed-addresses.json up to date)
 * - RPC_URL in iot/pi/.env reachable
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("../node_modules/ethers");
require("../node_modules/dotenv").config({ path: path.join(__dirname, "..", ".env") });

const deployed = require(path.join(__dirname, "..", "..", "..", "tmp", "deployed-addresses.json"));
const keysPath = path.join(__dirname, "..", "..", "..", "tmp", "ganache-keys.json");
const keysRaw = JSON.parse(fs.readFileSync(keysPath, "utf8"));
const privateKeys = keysRaw.private_keys || {};

const abiBaseDir = path.join(__dirname, "..", "..", "abis");
const abiRoleToken = require(path.join(abiBaseDir, "RoleToken.json")).abi;
const abiRoleBased = require(path.join(abiBaseDir, "RoleBasedAccessControl.json")).abi;
const abiFactory = require(path.join(abiBaseDir, "AccessControlFactory.json")).abi;
const abiRegister = require(path.join(abiBaseDir, "RegisterContract.json")).abi;
const abiAcc = require(path.join(abiBaseDir, "AccessControlContract.json")).abi;
const abiJudge = require(path.join(abiBaseDir, "JudgeContract.json")).abi;

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error("RPC_URL is not set in iot/pi/.env");
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
  if (!code || code === "0x") {
    throw new Error(`${name} not deployed at ${address} (code length ${code?.length || 0})`);
  }
}

async function pickUnused(count) {
  const roleToken = new ethers.Contract(deployed.addresses.roleToken, abiRoleToken, provider);
  const picks = [];
  for (const [addr, pk] of Object.entries(privateKeys)) {
    if (picks.length >= count) break;
    try {
      const role = await roleToken.getRole(addr);
      if (role.toString() === "0") {
        picks.push({ address: addr, privateKey: pk });
      }
    } catch (err) {
      // skip bad addresses
    }
  }
  return picks;
}

async function main() {
  const out = { steps: [], errors: [] };
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(__dirname, "..", "results", `full-chain-sim-${now}`);
  fs.mkdirSync(runDir, { recursive: true });
  const outFile = path.join(runDir, "report.json");
  const metricsFile = path.join(runDir, "metrics.txt");

  // Sanity: ensure contracts exist at expected addresses
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

  async function isAdmin(wallet) {
    try {
      const r = await roleToken.getRole(wallet.address);
      return r.toString() === "1"; // RoleToken.Role.ADMIN
    } catch {
      return false;
    }
  }

  let ownerWallet = envWallet || walletFor(ownerAddr);
  if (!(ownerWallet && (await isAdmin(ownerWallet)))) {
    const fallback = walletFor(ownerAddr);
    if (fallback && (await isAdmin(fallback))) {
      ownerWallet = fallback;
    }
  }
  if (!(ownerWallet && (await isAdmin(ownerWallet)))) {
    throw new Error(`No admin wallet available. Ensure PRIMARY_HEAD_KEY or ganache keys include the RoleToken owner/admin.`);
  }
  out.owner = ownerWallet.address;

  // Pick object + two subjects with Role.NONE
  const picks = await pickUnused(3);
  if (picks.length < 3) throw new Error("Not enough unused addresses (Role.NONE) in ganache-keys.json");
  const [object, subjectA, subjectB] = picks;
  out.object = object.address;
  out.subjectA = subjectA.address;
  out.subjectB = subjectB.address;

  const memberType = "type1";

  // Register roles via RoleBased (onlyAdmin)
  async function registerRole(addr, name) {
    const tx = await roleBased.connect(ownerWallet).assignRole(addr, name, memberType);
    const rec = await tx.wait();
    out.steps.push({ action: "registerRole", addr, memberType, txHash: rec.hash });
    // verify
    const role = await roleToken.getRole(addr);
    if (role.toString() === "0") {
      throw new Error(`registerRole failed for ${addr}; still Role.NONE`);
    }
  }
  try { await registerRole(object.address, "object"); } catch (e) { out.errors.push(`object register: ${e.message}`); }
  try { await registerRole(subjectA.address, "subjectA"); } catch (e) { out.errors.push(`subjectA register: ${e.message}`); }
  try { await registerRole(subjectB.address, "subjectB"); } catch (e) { out.errors.push(`subjectB register: ${e.message}`); }

  // Deploy ACC for subjectA/object/type1
  let accAddr = await register.getAccessControlContract(object.address, subjectA.address, "sensor");
  try {
    if (!accAddr || accAddr === ethers.ZeroAddress) {
      const tx = await factory.connect(ownerWallet).deployAccessControlContract(object.address, subjectA.address, "sensor");
      const rec = await tx.wait();
      accAddr = await register.getAccessControlContract(object.address, subjectA.address, "sensor");
      out.steps.push({ action: "deployAcc", txHash: rec.hash, accAddr });
    } else {
      out.steps.push({ action: "deployAcc", note: "exists", accAddr });
    }
  } catch (e) {
    out.errors.push(`deployAcc: ${e.message || e}`);
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2), "utf8");
    console.log(`Full simulation aborted at deploy. See ${outFile}`);
    return;
  }
  const acc = new ethers.Contract(accAddr, abiAcc, ownerWallet);

  // Policies: allow view, deny edit
  const pol1 = await acc.policyAdd("sensor/temp", "view", "allow");
  out.steps.push({ action: "policyAdd", resource: "sensor/temp", act: "view", perm: "allow", txHash: (await pol1.wait()).hash });
  const pol2 = await acc.policyAdd("sensor/temp", "edit", "deny");
  out.steps.push({ action: "policyAdd", resource: "sensor/temp", act: "edit", perm: "deny", txHash: (await pol2.wait()).hash });

  // Access txs from subjectA wallet
  const subjWallet = new ethers.Wallet(subjectA.privateKey, provider);
  async function accessTx(action) {
    try {
      const tx = await acc.connect(subjWallet).accessControl("sensor/temp", action);
      const rec = await tx.wait();
      out.steps.push({ action: "accessControl", act: action, txHash: rec.hash, gasUsed: rec.gasUsed.toString() });
    } catch (err) {
      out.errors.push(`accessControl ${action}: ${err.message || err}`);
    }
  }

  await accessTx("view"); // allowed
  // too frequent: call twice quickly
  await accessTx("view");
  // tamper/deny
  await accessTx("edit");

  // Pull balances/roles and judge blocking info
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
    const blkEnd = await judge.getBlockingEndTime(subjectA.address);
    out.judgeBlocking = blkEnd.toString();
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
  console.log(`Full simulation complete. See ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
