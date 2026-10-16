#!/usr/bin/env bash
set -euo pipefail

# Full gateway/contract attack simulation:
# - Picks unused Role.NONE addresses for object/subject (from tmp/ganache-keys.json)
# - Registers object/subject via PGH
# - Deploys ACC, adds allow (view) and deny (edit) policies
# - Executes allow, too-frequent, and tamper/deny evaluations
# - Writes a JSON report under iot/pi/results/attacks-<timestamp>.json

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
API_BASE="${API_BASE:-http://localhost:8080}"
TIMESTAMP="$(date -Iseconds | tr ':' '-')"
OUT_DIR="$ROOT/iot/pi/results/run-attack-scenarios-${TIMESTAMP}"
OUT_FILE="$OUT_DIR/report.json"
METRICS_URL="${METRICS_URL:-$API_BASE/metrics}"
RETRY="${RETRY:-0}"

cd "$ROOT"

if [[ ! -f iot/pi/.env ]]; then
  echo "Missing iot/pi/.env" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
export NODE_PATH="$ROOT/iot/pi/node_modules"

read_addresses() {
  node --input-type=commonjs - <<'NODE'
const fs = require("fs");
const path = require("path");
const { ethers } = require("./iot/pi/node_modules/ethers");
require("./iot/pi/node_modules/dotenv").config({ path: path.join("iot", "pi", ".env") });

const deployedPath = path.resolve("tmp", "deployed-addresses.json");
const keysPath = path.resolve("tmp", "ganache-keys.json");
const deployed = require(deployedPath);
const keysRaw = JSON.parse(fs.readFileSync(keysPath, "utf8"));
const roleTokenAbi = require("./iot/abis/RoleToken.json").abi;
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const roleToken = new ethers.Contract(deployed.addresses.roleToken, roleTokenAbi, provider);

async function pick(count) {
  const picks = [];
  for (const addr of Object.keys(keysRaw.private_keys || {})) {
    if (picks.length >= count) break;
    try {
      const role = await roleToken.getRole(addr);
      if (role.toString() === "0") picks.push(addr);
    } catch (_e) {
      continue;
    }
  }
  return picks;
}

pick(2).then((p) => {
  if (p.length < 2) {
    console.error("Not enough Role.NONE addresses available.");
    process.exit(1);
  }
  const [object, subject] = p;
  console.log(JSON.stringify({ object, subject }));
});
NODE
}

PICKS_JSON="$(read_addresses)"
OBJECT_ADDRESS="$(printf '%s' "$PICKS_JSON" | python -c 'import sys,json; print(json.load(sys.stdin)["object"])')"
SUBJECT_ADDRESS="$(printf '%s' "$PICKS_JSON" | python -c 'import sys,json; print(json.load(sys.stdin)["subject"])')"

echo "Object:  $OBJECT_ADDRESS"
echo "Subject: $SUBJECT_ADDRESS"

log_json() {
  local key="$1"; shift
  local value="$1"; shift
  echo "\"$key\": $value," >>"$OUT_FILE.tmp"
}

run_curl() {
  local name="$1"; shift
  local payload="$1"; shift
  local resp
  resp=$(curl -s -w "\n%{http_code}" -X POST "$API_BASE/$name" -H "Content-Type: application/json" -d "$payload")
  local body status
  body="$(printf "%s" "$resp" | head -n -1)"
  status="$(printf "%s" "$resp" | tail -n 1)"
  echo "[$name] HTTP $status"
  printf '  %s\n' "$body"
  log_json "$name" "$(printf '%s' "$body" | python - <<'PY'
import json, sys
data = sys.stdin.read()
try:
    print(json.dumps(json.loads(data)))
except Exception:
    print(json.dumps(data))
PY
)"
}

write_metrics() {
  local out="$OUT_DIR/metrics.txt"
  if curl -s -m 3 "$METRICS_URL" >"$out"; then
    echo "Wrote metrics snapshot: $out"
  else
    echo "metrics unavailable from $METRICS_URL" >"$out"
  fi
}

rotate_pgh_key() {
  echo "Rotating PGH key due to nonce error..."
  node --input-type=commonjs - <<'NODE'
const fs = require("fs");
const path = require("path");
const { ethers } = require("./iot/pi/node_modules/ethers");
require("./iot/pi/node_modules/dotenv").config({ path: path.join("iot", "pi", ".env") });

const keysPath = path.resolve("tmp", "ganache-keys.json");
const deployed = require("./tmp/deployed-addresses.json");
const roleAbi = require("./iot/abis/RoleToken.json").abi;
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const adminPk = process.env.ADMIN_KEY;
const currentPk = process.env.PRIMARY_HEAD_KEY;
  if (!adminPk) {
    console.error("ADMIN_KEY missing; cannot rotate safely.");
    process.exit(1);
  }
const keysRaw = JSON.parse(fs.readFileSync(keysPath, "utf8"));
const privateKeys = Object.values(keysRaw.private_keys || {});
const adminAddr = new ethers.Wallet(adminPk).address.toLowerCase();

(async () => {
  const scored = [];
  for (const pk of privateKeys) {
    try {
      const addr = new ethers.Wallet(pk).address.toLowerCase();
      if (addr === adminAddr) continue;
      if (currentPk && pk === currentPk) continue;
      const nonce = await provider.getTransactionCount(addr);
      scored.push({ pk, nonce });
    } catch (_e) {}
  }
  scored.sort((a, b) => a.nonce - b.nonce);
  if (!scored.length) process.exit(1);
  const newPk = scored[0].pk;

  const envPath = path.join("iot", "pi", ".env");
  const envRaw = fs.readFileSync(envPath, "utf8");
  const next = envRaw
    .split(/\r?\n/)
    .map((line) => (line.startsWith("PRIMARY_HEAD_KEY=") ? `PRIMARY_HEAD_KEY=${newPk}` : line))
    .join("\n");
  fs.writeFileSync(envPath, next, "utf8");

  const roleToken = new ethers.Contract(deployed.addresses.roleToken, roleAbi, new ethers.Wallet(adminPk, provider));
  const pghAddr = new ethers.Wallet(newPk).address;
  const role = await roleToken.getRole(pghAddr);
  if (role.toString() !== "1") {
    const owner = await roleToken.owner();
    const tx = await roleToken.assignAdminRole(owner, pghAddr);
    await tx.wait();
  }
})();
NODE
  pkill -f primary_head >/dev/null 2>&1 || true
  npm --prefix iot/pi start >/tmp/pgh.log 2>&1 &
  sleep 3
}

echo "{" >"$OUT_FILE.tmp"
log_json "objectAddress" "\"$OBJECT_ADDRESS\""
log_json "subjectAddress" "\"$SUBJECT_ADDRESS\""

run_curl "register-device" "{\"deviceAddress\":\"$OBJECT_ADDRESS\",\"name\":\"object\",\"memberType\":\"type1\"}"
run_curl "register-device" "{\"deviceAddress\":\"$SUBJECT_ADDRESS\",\"name\":\"subject\",\"memberType\":\"type1\"}"

DEPLOY_PAYLOAD="{\"objectAddress\":\"$OBJECT_ADDRESS\",\"subjectAddress\":\"$SUBJECT_ADDRESS\",\"accType\":\"sensor\"}"
DEPLOY_RESP=$(curl -s -w "\n%{http_code}" -X POST "$API_BASE/deploy-contract" -H "Content-Type: application/json" -d "$DEPLOY_PAYLOAD")
DEPLOY_BODY="$(printf "%s" "$DEPLOY_RESP" | head -n -1)"
DEPLOY_STATUS="$(printf "%s" "$DEPLOY_RESP" | tail -n 1)"
echo "[deploy-contract] HTTP $DEPLOY_STATUS"
printf '  %s\n' "$DEPLOY_BODY"
  log_json "deploy-contract" "$(printf '%s' "$DEPLOY_BODY" | python - <<'PY'
import json, sys
data = sys.stdin.read()
try:
    print(json.dumps(json.loads(data)))
except Exception:
    print(json.dumps(data))
PY
)"

if [[ "$DEPLOY_STATUS" != "200" && "$DEPLOY_BODY" == *"correct nonce"* ]]; then
  if [[ "$RETRY" -eq 0 ]]; then
    rotate_pgh_key
    RETRY=1 exec "$0"
  fi
fi

run_curl "policies" "{\"objectAddress\":\"$OBJECT_ADDRESS\",\"subjectAddress\":\"$SUBJECT_ADDRESS\",\"accType\":\"sensor\",\"resource\":\"sensor/temp\",\"action\":\"view\",\"permission\":\"allow\"}"
run_curl "policies" "{\"objectAddress\":\"$OBJECT_ADDRESS\",\"subjectAddress\":\"$SUBJECT_ADDRESS\",\"accType\":\"sensor\",\"resource\":\"sensor/temp\",\"action\":\"edit\",\"permission\":\"deny\"}"

run_curl "evaluate-access" "{\"subjectAddress\":\"$SUBJECT_ADDRESS\",\"objectAddress\":\"$OBJECT_ADDRESS\",\"accType\":\"sensor\",\"resource\":\"sensor/temp\",\"action\":\"view\"}"
run_curl "evaluate-access" "{\"subjectAddress\":\"$SUBJECT_ADDRESS\",\"objectAddress\":\"$OBJECT_ADDRESS\",\"accType\":\"sensor\",\"resource\":\"sensor/temp\",\"action\":\"view\"}"
run_curl "evaluate-access" "{\"subjectAddress\":\"$SUBJECT_ADDRESS\",\"objectAddress\":\"$OBJECT_ADDRESS\",\"accType\":\"sensor\",\"resource\":\"sensor/temp\",\"action\":\"edit\"}"

log_json "status" "$(curl -s "$API_BASE/status")"

# close JSON object cleanly
perl -0777 -pe 's/,\s*$/\n}/' "$OUT_FILE.tmp" >"$OUT_FILE"
rm -f "$OUT_FILE.tmp"
echo "Attack simulation complete. See $OUT_FILE"
write_metrics
