#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const IOT_PI_DIR = path.join(ROOT, "iot", "pi");

try {
  require(path.join(IOT_PI_DIR, "node_modules", "dotenv")).config({ path: path.join(IOT_PI_DIR, ".env") });
} catch (_err) {
  // fall through; process.env may already be populated
}

const { ethers } = require(path.join(IOT_PI_DIR, "node_modules", "ethers"));

async function main() {
  const deployed = JSON.parse(fs.readFileSync(path.join(ROOT, "tmp", "deployed-addresses.json"), "utf8"));
  const addresses = deployed.addresses || deployed;
  const keysRaw = JSON.parse(fs.readFileSync(path.join(ROOT, "tmp", "ganache-keys.json"), "utf8"));
  const privateKeys = keysRaw.private_keys || {};

  const abiRoleToken = JSON.parse(fs.readFileSync(path.join(ROOT, "informational", "contracts", "artifacts", "RoleToken.json"), "utf8")).abi;
  const abiRoleBased = JSON.parse(fs.readFileSync(path.join(ROOT, "informational", "contracts", "artifacts", "RoleBasedAccessControl.json"), "utf8")).abi;

  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const adminWallet = new ethers.Wallet(process.env.ADMIN_KEY, provider);
  const roleToken = new ethers.Contract(addresses.roleToken, abiRoleToken, provider);
  const roleBased = new ethers.Contract(addresses.roleBasedAccessControl, abiRoleBased, adminWallet);

  const owner = (await roleToken.owner()).toLowerCase();
  const adminAddress = adminWallet.address.toLowerCase();
  const pghAddress = process.env.PRIMARY_HEAD_KEY ? new ethers.Wallet(process.env.PRIMARY_HEAD_KEY).address.toLowerCase() : null;

  const excluded = new Set([owner, adminAddress]);
  if (pghAddress) excluded.add(pghAddress);

  const summary = {
    owner,
    admin: adminAddress,
    pgh: pghAddress,
    checked: 0,
    revoked: 0,
    skipped_none: 0,
    skipped_admin: 0,
    errors: [],
  };

  for (const addr of Object.keys(privateKeys)) {
    const lower = addr.toLowerCase();
    if (excluded.has(lower)) {
      summary.skipped_admin += 1;
      continue;
    }
    summary.checked += 1;
    try {
      const roleVal = await roleToken.getRole(addr);
      const roleStr = roleVal.toString();
      if (roleStr === "0" || roleStr === "1") {
        summary.skipped_none += 1;
        continue;
      }
      const tx = await roleBased.revokeRole(addr);
      await tx.wait();
      summary.revoked += 1;
    } catch (err) {
      summary.errors.push({
        address: lower,
        message: err && err.message ? err.message : String(err),
      });
    }
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
