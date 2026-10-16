#!/usr/bin/env bash
set -euo pipefail

# Auto-run collect:extended with a subject that currently has no role.
# Picks the first ganache key with Role.NONE, then runs the collector using
# PRIMARY_HEAD_KEY/ADMIN_KEY from iot/pi/.env.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Script lives at repo/iot/pi/scripts -> repo root is three levels up
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$ROOT"
export ROOT
METRICS_URL="${METRICS_URL:-http://localhost:8080/metrics}"
RUN_TS="$(date -Iseconds | tr ':' '-')"
RUN_DIR="$ROOT/iot/pi/results/run-collector-auto-${RUN_TS}"
mkdir -p "$RUN_DIR"

if [[ ! -f iot/pi/.env ]]; then
  echo "Missing iot/pi/.env" >&2
  exit 1
fi

export NODE_PATH="$ROOT/iot/pi/node_modules"

read_subject_and_object() {
  node --input-type=commonjs - <<'NODE'
const fs = require("fs");
const path = require("path");
const { ethers } = require("./iot/pi/node_modules/ethers");
require("./iot/pi/node_modules/dotenv").config({ path: path.join("iot", "pi", ".env") });

const deployedPath = path.resolve(process.cwd(), "tmp", "deployed-addresses.json");
const keysPath = path.resolve(process.cwd(), "tmp", "ganache-keys.json");
const deployed = require(deployedPath);
const keysRaw = JSON.parse(fs.readFileSync(keysPath, "utf8"));
const roleTokenAbi = require("./iot/abis/RoleToken.json").abi;

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const roleToken = new ethers.Contract(deployed.addresses.roleToken, roleTokenAbi, provider);

async function main() {
  const entries = Object.entries(keysRaw.private_keys || {});
  let subject = null;
  let object = null;
  for (const [addr, pk] of entries) {
    const role = await roleToken.getRole(addr);
    if (role.toString() === "0") {
      if (!subject) {
        subject = { address: addr, privateKey: pk };
        continue;
      }
      if (!object) {
        object = { address: addr, privateKey: pk };
        break;
      }
    }
  }
  if (!subject || !object) {
    console.error("Not enough unused (Role.NONE) addresses found in tmp/ganache-keys.json");
    process.exit(1);
  }
  console.log(JSON.stringify({ subject, object }));
}
main();
NODE
}

PICKS_JSON="$(read_subject_and_object)"
SUBJECT_ADDRESS="$(printf '%s' "$PICKS_JSON" | python -c 'import json,sys; print(json.load(sys.stdin)["subject"]["address"])')"
OBJECT_ADDRESS="$(printf '%s' "$PICKS_JSON" | python -c 'import json,sys; print(json.load(sys.stdin)["object"]["address"])')"
export OBJECT_ADDRESS

# Load PRIMARY_HEAD_KEY/ADMIN_KEY from .env
PRIMARY_HEAD_KEY="$(grep -E '^PRIMARY_HEAD_KEY=' iot/pi/.env | cut -d= -f2-)"
ADMIN_KEY="$(grep -E '^ADMIN_KEY=' iot/pi/.env | cut -d= -f2-)"

if [[ -z "${PRIMARY_HEAD_KEY}" || -z "${ADMIN_KEY}" ]]; then
  echo "Missing PRIMARY_HEAD_KEY or ADMIN_KEY in iot/pi/.env" >&2
  exit 1
fi

echo "Using COLLECT_SUBJECT=${SUBJECT_ADDRESS}"
echo "Using OBJECT_ADDRESS=${OBJECT_ADDRESS}"

python - <<'PY'
import json, os, sys
root = os.environ.get("ROOT") or os.getcwd()
cfg_path = os.path.join(root, "tmp", "bootstrap-config.json")
obj_addr = os.environ.get("OBJECT_ADDRESS")
if not obj_addr:
    sys.exit(0)
try:
    with open(cfg_path, "r") as fh:
        data = json.load(fh)
except Exception:
    data = {}
data["objectAddress"] = obj_addr
with open(cfg_path, "w") as fh:
    json.dump(data, fh, indent=2)
print(f"Updated {cfg_path} objectAddress -> {obj_addr}")
PY

curl -s -X POST http://localhost:8080/register-device \
  -H 'Content-Type: application/json' \
  -d "{\"deviceAddress\":\"${OBJECT_ADDRESS}\",\"name\":\"collector-object\",\"memberType\":\"type1\"}" >/dev/null || true

echo "Running collector..."

rotate_key_and_restart() {
  local new_key
  new_key="$(node --input-type=commonjs - <<'NODE'
const fs = require("fs");
const path = require("path");
const { ethers } = require("./iot/pi/node_modules/ethers");
require("./iot/pi/node_modules/dotenv").config({ path: path.join("iot", "pi", ".env") });

const keysPath = path.resolve("tmp", "ganache-keys.json");
const keysRaw = JSON.parse(fs.readFileSync(keysPath, "utf8"));
const privateKeys = Object.values(keysRaw.private_keys || {});
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

(async () => {
  const scored = [];
  for (const pk of privateKeys) {
    try {
      const wallet = new ethers.Wallet(pk);
      const nonce = await provider.getTransactionCount(wallet.address);
      scored.push({ pk, nonce });
    } catch (_e) {
      // ignore
    }
  }
  scored.sort((a, b) => a.nonce - b.nonce);
  if (!scored.length) process.exit(1);
  console.log(scored[0].pk);
})();
NODE
)"
  if [[ -z "$new_key" ]]; then
    echo "Failed to pick a fresh key for rotation" >&2
    return 1
  fi
  local tmp
  tmp=$(mktemp)
  awk -v k="$new_key" '
    /^PRIMARY_HEAD_KEY=/ {print "PRIMARY_HEAD_KEY=" k; next}
    {print}
  ' iot/pi/.env > "$tmp"
  mv "$tmp" iot/pi/.env
  echo "Rotated PRIMARY_HEAD_KEY in iot/pi/.env; ensuring admin role + restarting PGH..."
  node --input-type=commonjs - <<'NODE'
const fs = require("fs");
const path = require("path");
const { ethers } = require("./iot/pi/node_modules/ethers");
require("./iot/pi/node_modules/dotenv").config({ path: path.join("iot", "pi", ".env") });
const deployed = require("./tmp/deployed-addresses.json");
const roleAbi = require("./iot/abis/RoleToken.json").abi;
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const adminPk = process.env.ADMIN_KEY;
const pghPk = process.env.PRIMARY_HEAD_KEY;
if (!adminPk || !pghPk) process.exit(0);
const adminWallet = new ethers.Wallet(adminPk, provider);
const pghAddr = new ethers.Wallet(pghPk).address;
(async () => {
  const roleToken = new ethers.Contract(deployed.addresses.roleToken, roleAbi, adminWallet);
  const role = await roleToken.getRole(pghAddr);
  if (role.toString() === "1") return;
  const owner = await roleToken.owner();
  const tx = await roleToken.assignAdminRole(owner, pghAddr);
  await tx.wait();
})();
NODE
  pkill -f primary_head >/dev/null 2>&1 || true
  npm --prefix iot/pi start >/tmp/pgh.log 2>&1 &
  sleep 3
  PRIMARY_HEAD_KEY="$new_key"
}

run_collector() {
  COLLECT_RESULTS_DIR="$RUN_DIR" \
  COLLECT_SUBJECT="$SUBJECT_ADDRESS" \
  ADMIN_KEY="$ADMIN_KEY" \
  PRIMARY_HEAD_KEY="$PRIMARY_HEAD_KEY" \
  npm --prefix iot/pi run collect:extended
}

write_metrics_snapshot() {
  local out="${RUN_DIR}/metrics.txt"
  if curl -s -m 3 "$METRICS_URL" >"$out"; then
    echo "Wrote metrics snapshot: $out"
  else
    echo "metrics unavailable from $METRICS_URL" >"$out"
  fi
}

if ! run_collector; then
  echo "Collector failed; rotating key and retrying once..."
  rotate_key_and_restart
  run_collector
fi

write_metrics_snapshot

echo "Collector run complete. See ${RUN_DIR} for outputs."
