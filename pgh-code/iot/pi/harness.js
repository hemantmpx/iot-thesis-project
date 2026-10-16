#!/usr/bin/env node
/**
 * Minimal integration harness that exercises the primary-head APIs end-to-end
 * using a supplied subject address and the bootstrap object address.
 *
 * Usage:
 *   HARNESS_SUBJECT=0x... HARNESS_API=http://localhost:8080 node harness.js
 *
 * Flow:
 *   - register-device (memberType type1)
 *   - deploy-contract (sensor ACC)
 *   - add policy sensor/temp:view=allow
 *   - evaluate-access allowed (view)
 *   - evaluate-access denied (edit)
 */
const fs = require("fs");
const path = require("path");

const API_BASE = process.env.HARNESS_API || "http://localhost:8080";
const SUBJECT = process.env.HARNESS_SUBJECT;
const MEMBER_TYPE = process.env.HARNESS_MEMBER_TYPE || "type1";
const RESOURCE = process.env.HARNESS_RESOURCE || "sensor/temp";
const ACC_TYPE = process.env.HARNESS_ACC_TYPE || "sensor";
const ACTION_ALLOW = process.env.HARNESS_ACTION_ALLOW || "view";
const ACTION_DENY = process.env.HARNESS_ACTION_DENY || "edit";

if (!SUBJECT) {
  console.error("HARNESS_SUBJECT env var is required (a Ganache address with Role.NONE).");
  process.exit(1);
}

const bootstrapPath = path.join(__dirname, "..", "tmp", "bootstrap-config.json");
if (!fs.existsSync(bootstrapPath)) {
  console.error(`bootstrap-config.json not found at ${bootstrapPath}. Run npm run bootstrap first.`);
  process.exit(1);
}

const bootstrap = JSON.parse(fs.readFileSync(bootstrapPath, "utf8"));
const OBJECT = bootstrap.objectAddress;

const headers = { "Content-Type": "application/json" };

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
    throw new Error(`${pathname} failed (${res.status}): ${text}`);
  }
  return body;
}

async function main() {
  console.log(`Using object=${OBJECT}, subject=${SUBJECT}, API=${API_BASE}`);

  console.log("\n1) Register subject...");
  const reg = await post("/register-device", {
    deviceAddress: SUBJECT,
    name: "harness-subject",
    memberType: MEMBER_TYPE,
  });
  console.log(reg);

  console.log("\n2) Deploy ACC...");
  const dep = await post("/deploy-contract", {
    objectAddress: OBJECT,
    subjectAddress: SUBJECT,
    accType: ACC_TYPE,
  });
  console.log(dep);

  console.log("\n3) Add policy...");
  const pol = await post("/policies", {
    objectAddress: OBJECT,
    subjectAddress: SUBJECT,
    accType: ACC_TYPE,
    resource: RESOURCE,
    action: ACTION_ALLOW,
    permission: "allow",
  });
  console.log(pol);

  console.log("\n4) Evaluate allowed action...");
  const evalAllow = await post("/evaluate-access", {
    objectAddress: OBJECT,
    subjectAddress: SUBJECT,
    accType: ACC_TYPE,
    resource: RESOURCE,
    action: ACTION_ALLOW,
  });
  console.log(evalAllow);

  console.log("\n5) Evaluate denied action...");
  const evalDeny = await post("/evaluate-access", {
    objectAddress: OBJECT,
    subjectAddress: SUBJECT,
    accType: ACC_TYPE,
    resource: RESOURCE,
    action: ACTION_DENY,
  });
  console.log(evalDeny);

  console.log("\n✅ Harness run complete.");
}

main().catch((err) => {
  console.error("Harness run failed:", err.message || err);
  process.exit(1);
});
