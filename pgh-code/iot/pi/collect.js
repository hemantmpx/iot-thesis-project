#!/usr/bin/env node
/**
 * Collector script: runs a fixed interaction sequence against the primary-head API
 * and writes all responses to a timestamped folder for thesis artifacts.
 *
 * Configure via env:
 *   COLLECT_API=http://localhost:8080
 *   COLLECT_SUBJECT=0x...   (required, must have Role.NONE before running)
 *   COLLECT_MEMBER_TYPE=type1
 *   COLLECT_RESOURCE=sensor/temp
 *   COLLECT_ACC_TYPE=sensor
 *   COLLECT_ACTION_ALLOW=view
 *   COLLECT_ACTION_DENY=edit
 *
 * Outputs:
 *   results/<timestamp>/register.json
 *   results/<timestamp>/deploy.json
 *   results/<timestamp>/policy.json
 *   results/<timestamp>/evaluate-allow.json
 *   results/<timestamp>/evaluate-deny.json
 *   results/<timestamp>/status-before.json
 *   results/<timestamp>/status-after.json
 *   results/<timestamp>/metrics.txt
 */

const fs = require("fs");
const path = require("path");

const API_BASE = process.env.COLLECT_API || "http://localhost:8080";
const SUBJECT = process.env.COLLECT_SUBJECT;
const MEMBER_TYPE = process.env.COLLECT_MEMBER_TYPE || "type1";
const RESOURCE = process.env.COLLECT_RESOURCE || "sensor/temp";
const ACC_TYPE = process.env.COLLECT_ACC_TYPE || "sensor";
const ACTION_ALLOW = process.env.COLLECT_ACTION_ALLOW || "view";
const ACTION_DENY = process.env.COLLECT_ACTION_DENY || "edit";

if (!SUBJECT) {
  console.error("COLLECT_SUBJECT env var is required (an unused Ganache address).");
  process.exit(1);
}

const bootstrapPath = path.join(__dirname, "..", "..", "tmp", "bootstrap-config.json");
if (!fs.existsSync(bootstrapPath)) {
  console.error(`bootstrap-config.json not found at ${bootstrapPath}. Run npm run bootstrap first.`);
  process.exit(1);
}

const bootstrap = JSON.parse(fs.readFileSync(bootstrapPath, "utf8"));
const OBJECT = bootstrap.objectAddress;

const headers = { "Content-Type": "application/json" };
const resultsDir = path.join(__dirname, "results", new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(resultsDir, { recursive: true });

async function writeFile(name, data) {
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
    throw new Error(`${pathname} failed (${res.status}): ${text}`);
  }
  return body;
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

async function main() {
  console.log(`Collecting with object=${OBJECT}, subject=${SUBJECT}, API=${API_BASE}`);

  const statusBefore = await get("/status");
  await writeFile("status-before.json", statusBefore);

  const register = await post("/register-device", {
    deviceAddress: SUBJECT,
    name: "collector-subject",
    memberType: MEMBER_TYPE,
  });
  await writeFile("register.json", register);

  const deploy = await post("/deploy-contract", {
    objectAddress: OBJECT,
    subjectAddress: SUBJECT,
    accType: ACC_TYPE,
  });
  await writeFile("deploy.json", deploy);

  const policy = await post("/policies", {
    objectAddress: OBJECT,
    subjectAddress: SUBJECT,
    accType: ACC_TYPE,
    resource: RESOURCE,
    action: ACTION_ALLOW,
    permission: "allow",
  });
  await writeFile("policy.json", policy);

  const evalAllow = await post("/evaluate-access", {
    objectAddress: OBJECT,
    subjectAddress: SUBJECT,
    accType: ACC_TYPE,
    resource: RESOURCE,
    action: ACTION_ALLOW,
  });
  await writeFile("evaluate-allow.json", evalAllow);

  const evalDeny = await post("/evaluate-access", {
    objectAddress: OBJECT,
    subjectAddress: SUBJECT,
    accType: ACC_TYPE,
    resource: RESOURCE,
    action: ACTION_DENY,
  });
  await writeFile("evaluate-deny.json", evalDeny);

  const statusAfter = await get("/status");
  await writeFile("status-after.json", statusAfter);

  const metrics = await get("/metrics");
  await writeFile("metrics.txt", metrics);

  console.log("✅ Collection complete. Artifacts in:", resultsDir);
}

main().catch((err) => {
  console.error("Collection failed:", err.message || err);
  process.exit(1);
});
