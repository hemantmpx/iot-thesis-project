#!/usr/bin/env node
/**
 * Extended collector: mirrors key scenarios from AccessControlContract tests via the gateway.
 *
 * Env:
 *   COLLECT_API=http://localhost:8080
 *   COLLECT_SUBJECT=0x...            (required, Role.NONE before run)
 *   COLLECT_MEMBER_TYPE=type1
 *   COLLECT_RESOURCE=sensor/temp
 *   COLLECT_ACC_TYPE=sensor
 *   COLLECT_ACTION_ALLOW=view
 *   COLLECT_ACTION_DENY=edit
 *   COLLECT_FAIL_SUBJECT=0x...       (optional) will be registered with COLLECT_FAIL_MEMBER_TYPE and used to show deploy failure
 *   COLLECT_FAIL_MEMBER_TYPE=type2
 *
 * Steps:
 *   - status-before
 *   - register subject
 *   - deploy ACC (success)
 *   - policy allow
 *   - evaluate allow
 *   - too-frequent access (2 quick calls)
 *   - policy update to deny
 *   - evaluate unauthorized (view)
 *   - evaluate tamper (edit)
 *   - optional: register fail-subject (different type) and attempt deploy (expected error)
 *   - status-after, metrics
 *
 * Outputs: results/<timestamp>/* JSON and metrics.txt
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const { ethers } = require("ethers");

const API_BASE = process.env.COLLECT_API || "http://localhost:8080";
const SUBJECT = process.env.COLLECT_SUBJECT;
const MEMBER_TYPE = process.env.COLLECT_MEMBER_TYPE || "type1";
const RESOURCE = process.env.COLLECT_RESOURCE || "sensor/temp";
const ACC_TYPE = process.env.COLLECT_ACC_TYPE || "sensor";
const ACTION_ALLOW = process.env.COLLECT_ACTION_ALLOW || "view";
const ACTION_DENY = process.env.COLLECT_ACTION_DENY || "edit";
const FAIL_SUBJECT = process.env.COLLECT_FAIL_SUBJECT;
const FAIL_MEMBER_TYPE = process.env.COLLECT_FAIL_MEMBER_TYPE || "type2";

if (!SUBJECT) {
  console.error("COLLECT_SUBJECT is required.");
  process.exit(1);
}

const bootstrapPath = path.join(__dirname, "..", "..", "tmp", "bootstrap-config.json");
if (!fs.existsSync(bootstrapPath)) {
  console.error(`bootstrap-config.json not found. Run npm run bootstrap first.`);
  process.exit(1);
}

const bootstrap = JSON.parse(fs.readFileSync(bootstrapPath, "utf8"));
const OBJECT = bootstrap.objectAddress;
const headers = { "Content-Type": "application/json" };
const resultsDir =
  process.env.COLLECT_RESULTS_DIR ||
  process.env.RESULTS_DIR ||
  path.join(__dirname, "results", new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(resultsDir, { recursive: true });
const deployedAddresses = require(path.join(__dirname, "..", "..", "tmp", "deployed-addresses.json"));
const keysPath = path.join(__dirname, "..", "..", "tmp", "ganache-keys.json");

async function write(name, data) {
  const file = path.join(resultsDir, name);
  fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2), "utf8");
  console.log(`✔ wrote ${file}`);
}

async function post(pathname, payload) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw Object.assign(new Error(`${pathname} failed (${res.status})`), { status: res.status, body: text });
  }
  return body;
}

async function safePost(pathname, payload) {
  try {
    return await post(pathname, payload);
  } catch (err) {
    return { status: "error", message: err.body || err.message || String(err) };
  }
}

async function get(pathname) {
  const res = await fetch(`${API_BASE}${pathname}`);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`${pathname} failed (${res.status}): ${text}`);
  }
  return body;
}

async function getExistingAcc(objectAddress, subjectAddress, accType) {
  const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const registerAbi = require(path.join(__dirname, "..", "abis", "RegisterContract.json")).abi;
  const register = new ethers.Contract(deployedAddresses.addresses.registerContract, registerAbi, provider);
  return await register.getAccessControlContract(objectAddress, subjectAddress, accType);
}

function getAdminSigner(provider) {
  if (process.env.ADMIN_KEY) {
    return new ethers.Wallet(process.env.ADMIN_KEY, provider);
  }
  if (fs.existsSync(keysPath)) {
    const raw = JSON.parse(fs.readFileSync(keysPath, "utf8"));
    const firstKey = Object.values(raw.private_keys || {})[0];
    if (firstKey) {
      return new ethers.Wallet(firstKey, provider);
    }
  }
  throw new Error("Admin signer not found. Set ADMIN_KEY or ensure tmp/ganache-keys.json exists.");
}

async function ensureGatewayAndObjectRoles({ provider, gatewayAddr, objectAddr, memberType }) {
  const roleTokenAbi = require(path.join(__dirname, "..", "abis", "RoleToken.json")).abi;
  const roleToken = new ethers.Contract(deployedAddresses.addresses.roleToken, roleTokenAbi, provider);
  const adminSigner = getAdminSigner(provider);
  const roleTokenAdmin = roleToken.connect(adminSigner);

  // Ensure gateway is ADMIN
  const gatewayRole = await roleToken.getRole(gatewayAddr);
  if (gatewayRole.toString() !== "1") {
    try {
      const tx = await roleTokenAdmin.assignAdminRole(adminSigner.address, gatewayAddr);
      await tx.wait();
      console.log(`✔ gateway ${gatewayAddr} granted ADMIN`);
    } catch (err) {
      console.log(`ℹ gateway admin grant skipped: ${err.message || err}`);
    }
  }

  // Ensure object has the expected memberType
  const objectMember = await roleToken.getMember(objectAddr);
  const objectRole = await roleToken.getRole(objectAddr);
  if (objectRole.toString() === "1") {
    console.log(`ℹ object ${objectAddr} already ADMIN; skipping object role adjustment`);
    return;
  }
  const needsAssign = objectRole.toString() === "0" || objectMember.memberType !== memberType;
  if (needsAssign) {
    if (objectRole.toString() !== "0") {
      const txRevoke = await roleTokenAdmin.revokeRole(objectAddr);
      await txRevoke.wait();
    }
    const txAssign = await roleTokenAdmin.assignRole(objectAddr, "object-bootstrap", memberType);
    await txAssign.wait();
    console.log(`✔ object ${objectAddr} set to ${memberType}`);
  }
}

async function ensureSubjectCleared({ provider, subjectAddr }) {
  const roleTokenAbi = require(path.join(__dirname, "..", "abis", "RoleToken.json")).abi;
  const roleToken = new ethers.Contract(deployedAddresses.addresses.roleToken, roleTokenAbi, provider);
  const adminSigner = getAdminSigner(provider);
  const roleTokenAdmin = roleToken.connect(adminSigner);

  const subjectRole = await roleToken.getRole(subjectAddr);
  if (subjectRole.toString() !== "0") {
    try {
      const tx = await roleTokenAdmin.revokeRole(subjectAddr);
      await tx.wait();
      console.log(`✔ subject ${subjectAddr} revoked to NONE`);
    } catch (err) {
      console.log(`ℹ subject revoke skipped: ${err.message || err}`);
    }
  }
}

async function main() {
  console.log(`Object=${OBJECT}, Subject=${SUBJECT}, API=${API_BASE}`);

  // Preflight: make sure gateway signer is admin and object has the right memberType
  const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const gatewayAddr = new ethers.Wallet(process.env.PRIMARY_HEAD_KEY, provider).address;
  await ensureGatewayAndObjectRoles({ provider, gatewayAddr, objectAddr: OBJECT, memberType: MEMBER_TYPE });
   // Ensure subject has Role.NONE so registration won't revert
  await ensureSubjectCleared({ provider, subjectAddr: SUBJECT });

  await write("status-before.json", await get("/status"));

  await write("register.json", await post("/register-device", {
    deviceAddress: SUBJECT,
    name: "collector-subject",
    memberType: MEMBER_TYPE,
  }));

  let deployResult;
  try {
    deployResult = await post("/deploy-contract", {
      objectAddress: OBJECT,
      subjectAddress: SUBJECT,
      accType: ACC_TYPE,
    });
  } catch (err) {
    const existing = await getExistingAcc(OBJECT, SUBJECT, ACC_TYPE);
    if (existing && existing !== "0x0000000000000000000000000000000000000000") {
      deployResult = { status: "ok", note: "existing", contractAddress: existing };
    } else {
      throw err;
    }
  }
  await write("deploy.json", deployResult);

  await write("policy-allow.json", await post("/policies", {
    objectAddress: OBJECT,
    subjectAddress: SUBJECT,
    accType: ACC_TYPE,
    resource: RESOURCE,
    action: ACTION_ALLOW,
    permission: "allow",
  }));

  await write("eval-allow.json", await post("/evaluate-access", {
    objectAddress: OBJECT,
    subjectAddress: SUBJECT,
    accType: ACC_TYPE,
    resource: RESOURCE,
    action: ACTION_ALLOW,
  }));

  // Too frequent access: two quick calls
  const tf1 = await safePost("/evaluate-access", {
    objectAddress: OBJECT,
    subjectAddress: SUBJECT,
    accType: ACC_TYPE,
    resource: RESOURCE,
    action: ACTION_ALLOW,
  });
  const tf2 = await safePost("/evaluate-access", {
    objectAddress: OBJECT,
    subjectAddress: SUBJECT,
    accType: ACC_TYPE,
    resource: RESOURCE,
    action: ACTION_ALLOW,
  });
  await write("too-frequent-1.json", tf1);
  await write("too-frequent-2.json", tf2);

  // Update policy to deny
  await write("policy-deny.json", await post("/policies", {
    objectAddress: OBJECT,
    subjectAddress: SUBJECT,
    accType: ACC_TYPE,
    resource: RESOURCE,
    action: ACTION_ALLOW,
    permission: "deny",
  }));

  await write("eval-unauthorized.json", await post("/evaluate-access", {
    objectAddress: OBJECT,
    subjectAddress: SUBJECT,
    accType: ACC_TYPE,
    resource: RESOURCE,
    action: ACTION_ALLOW,
  }));

  await write("eval-tamper.json", await post("/evaluate-access", {
    objectAddress: OBJECT,
    subjectAddress: SUBJECT,
    accType: ACC_TYPE,
    resource: RESOURCE,
    action: ACTION_DENY,
  }));

  // Optional failing deploy between different types
  if (FAIL_SUBJECT) {
    const regFail = await safePost("/register-device", {
      deviceAddress: FAIL_SUBJECT,
      name: "collector-fail",
      memberType: FAIL_MEMBER_TYPE,
    });
    await write("register-fail.json", regFail);
    const depFail = await safePost("/deploy-contract", {
      objectAddress: OBJECT,
      subjectAddress: FAIL_SUBJECT,
      accType: ACC_TYPE,
    });
    await write("deploy-fail.json", depFail);
  }

  await write("status-after.json", await get("/status"));
  await write("metrics.txt", await get("/metrics"));

  console.log("✅ Extended collection complete. Files in:", resultsDir);
}

main().catch((err) => {
  console.error("Collection failed:", err.message || err);
  process.exit(1);
});
