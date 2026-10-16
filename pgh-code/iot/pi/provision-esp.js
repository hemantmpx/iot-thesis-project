#!/usr/bin/env node
/**
 * Provision an ESP device against the on-chain access control:
 * - register the device address
 * - deploy (or reuse) its AccessControlContract
 * - grant the ACC admin role
 * - add a starter policy
 * - emit a config blob for the ESP + dashboard
 *
 * Env:
 *   RPC_URL (optional, default http://127.0.0.1:8545)
 *   PRIMARY_HEAD_KEY (admin signer)
 *   ESP_PRIVATE_KEY or ESP_SUBJECT_ADDRESS
 *   ESP_OBJECT_ADDRESS (optional, defaults to bootstrap-config.json objectAddress)
 *   ESP_ACC_TYPE (optional, defaults to bootstrap-config accType or "sensor")
 *   ESP_MEMBER_TYPE (optional, defaults to accType)
 *   ESP_RESOURCE / ESP_ACTION / ESP_PERMISSION (optional, defaults to bootstrap policy or sensor/temp, view, allow)
 *   PGH_API_URL (optional, defaults to http://localhost:8080)
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const deployedAddresses = require(path.join(__dirname, "..", "..", "tmp", "deployed-addresses.json"));
const bootstrapPath = path.join(__dirname, "..", "..", "tmp", "bootstrap-config.json");
const bootstrap = fs.existsSync(bootstrapPath) ? JSON.parse(fs.readFileSync(bootstrapPath, "utf8")) : {};

function fail(message) {
  console.error(message);
  process.exit(1);
}

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const provider = new ethers.JsonRpcProvider(RPC_URL);

if (!process.env.PRIMARY_HEAD_KEY) {
  fail("PRIMARY_HEAD_KEY is required to provision ESP devices.");
}
const adminWallet = new ethers.Wallet(process.env.PRIMARY_HEAD_KEY, provider);

const subjectKey = process.env.ESP_PRIVATE_KEY;
const subjectAddress = subjectKey ? new ethers.Wallet(subjectKey).address : process.env.ESP_SUBJECT_ADDRESS;
if (!subjectAddress) {
  fail("Set ESP_PRIVATE_KEY or ESP_SUBJECT_ADDRESS to identify the ESP.");
}

const objectAddress = process.env.ESP_OBJECT_ADDRESS || bootstrap.objectAddress;
if (!objectAddress) {
  fail("Set ESP_OBJECT_ADDRESS or ensure tmp/bootstrap-config.json includes objectAddress.");
}

const accType = process.env.ESP_ACC_TYPE || bootstrap.accType || "sensor";
const memberType = process.env.ESP_MEMBER_TYPE || accType;
const resource = process.env.ESP_RESOURCE || (bootstrap.policy ? bootstrap.policy.resource : null) || "sensor/temp";
const action = process.env.ESP_ACTION || (bootstrap.policy ? bootstrap.policy.action : null) || "view";
const permission = process.env.ESP_PERMISSION || (bootstrap.policy ? bootstrap.policy.permission : null) || "allow";
const apiUrl = process.env.PGH_API_URL || "http://localhost:8080";

const roleBased = new ethers.Contract(
  deployedAddresses.addresses.roleBasedAccessControl,
  require(path.join(__dirname, "..", "abis", "RoleBasedAccessControl.json")).abi,
  adminWallet
);
const factory = new ethers.Contract(
  deployedAddresses.addresses.accessControlFactory,
  require(path.join(__dirname, "..", "abis", "AccessControlFactory.json")).abi,
  adminWallet
);
const register = new ethers.Contract(
  deployedAddresses.addresses.registerContract,
  require(path.join(__dirname, "..", "abis", "RegisterContract.json")).abi,
  adminWallet
);
const roleToken = new ethers.Contract(
  deployedAddresses.addresses.roleToken,
  require(path.join(__dirname, "..", "abis", "RoleToken.json")).abi,
  adminWallet
);
const accessControlAbi = require(path.join(__dirname, "..", "abis", "AccessControlContract.json")).abi;

async function main() {
  const summary = {
    subjectAddress,
    objectAddress,
    accType,
    memberType,
    apiUrl,
    tx: {},
  };

  console.log("Provisioning ESP device");
  console.log({ subjectAddress, objectAddress, accType, memberType, resource, action, permission, apiUrl });

  // Register device role
  try {
    const tx = await roleBased.assignRole(subjectAddress, "esp-device", memberType);
    const receipt = await tx.wait();
    summary.tx.register = receipt.hash;
    console.log(`✔ registered device (tx ${receipt.hash})`);
  } catch (err) {
    const msg = err?.message || "";
    if (msg.includes("Member already has a role")) {
      summary.tx.register = "skipped_existing_role";
      console.log("ℹ device already registered; skipping assignRole");
    } else {
      throw err;
    }
  }

  // Deploy or reuse ACC
  let contractAddress = await register.getAccessControlContract(objectAddress, subjectAddress, accType);
  if (!contractAddress || contractAddress === ZERO_ADDRESS) {
    const tx = await factory.deployAccessControlContract(objectAddress, subjectAddress, accType);
    const receipt = await tx.wait();
    summary.tx.deploy = receipt.hash;
    contractAddress = await register.getAccessControlContract(objectAddress, subjectAddress, accType);
    console.log(`✔ ACC deployed at ${contractAddress} (tx ${receipt.hash})`);
  } else {
    summary.tx.deploy = "skipped_existing_acc";
    console.log(`ℹ ACC already exists at ${contractAddress}`);
  }

  // Grant ACC admin role
  try {
    const tx = await roleToken.assignAdminRole(adminWallet.address, contractAddress);
    const receipt = await tx.wait();
    summary.tx.accAdminGrant = receipt.hash;
    console.log(`✔ ACC admin granted (tx ${receipt.hash})`);
  } catch (err) {
    const msg = err?.message || "";
    if (msg.includes("Member already has a role")) {
      summary.tx.accAdminGrant = "skipped_existing_admin";
      console.log("ℹ ACC already has admin role; skipping");
    } else {
      throw err;
    }
  }

  // Add starter policy
  try {
    const acc = new ethers.Contract(contractAddress, accessControlAbi, adminWallet);
    const tx = await acc.policyAdd(resource, action, permission);
    const receipt = await tx.wait();
    summary.tx.policyAdd = receipt.hash;
    console.log(`✔ policy added (${resource} ${action} -> ${permission}) (tx ${receipt.hash})`);
  } catch (err) {
    const msg = err?.message || "";
    if (msg.toLowerCase().includes("revert") && msg.toLowerCase().includes("already")) {
      summary.tx.policyAdd = "skipped_existing_policy";
      console.log("ℹ policy already exists; skipping");
    } else {
      throw err;
    }
  }

  // Emit config file
  const outDir = path.join(__dirname, "provisioned");
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `esp-${subjectAddress.slice(-6)}.json`);
  const output = {
    apiUrl,
    objectAddress,
    subjectAddress,
    accType,
    memberType,
    contractAddress,
    policy: { resource, action, permission },
    tx: summary.tx,
    espConfig: {
      apiUrl,
      deviceAddress: subjectAddress,
      objectAddress,
      accType,
      resource,
      action,
    },
    dashboardConfig: {
      apiUrl,
      contractAddress,
      objectAddress,
      subjectAddress,
      accType,
    },
  };
  fs.writeFileSync(file, JSON.stringify(output, null, 2), "utf8");
  console.log(`✔ wrote config ${file}`);
  console.log("Done.");
}

main().catch((err) => {
  console.error("Provision failed:", err?.message || err);
  process.exit(1);
});
