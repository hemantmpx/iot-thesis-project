#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$ROOT/iot/pi/.env"
ENV_TEMPLATE="$ROOT/iot/pi/.env.template"
DEPLOYED="$ROOT/tmp/deployed-addresses.json"
BOOTSTRAP="$ROOT/tmp/bootstrap-config.json"
KEYS="$ROOT/tmp/ganache-keys.json"
ABI_ROLE_TOKEN="$ROOT/iot/abis/RoleToken.json"
CONFIG_DIR="$ROOT/config"
SECURITY_MATRIX="$CONFIG_DIR/securityMatrix.json"
THREAT_CATALOG="$CONFIG_DIR/threatCatalog.json"

RPC_URL=""
PRIMARY_HEAD_KEY=""
ADMIN_KEY=""
NO_INSTALL=0
WRITE_DEFAULTS=0
CHECK_ONLY=0

usage() {
  cat <<USAGE
Usage: $0 [options]

Options:
  --rpc-url <url>       Set RPC_URL in iot/pi/.env
  --pgh-key <key>       Set PRIMARY_HEAD_KEY in iot/pi/.env
  --admin-key <key>     Set ADMIN_KEY in iot/pi/.env
  --no-install          Do not run npm install if node_modules are missing
  --write-defaults      Create default config/securityMatrix.json and threatCatalog.json if missing
  --check-only          Only verify requirements; do not modify files
  -h, --help            Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rpc-url) RPC_URL="$2"; shift 2;;
    --pgh-key) PRIMARY_HEAD_KEY="$2"; shift 2;;
    --admin-key) ADMIN_KEY="$2"; shift 2;;
    --no-install) NO_INSTALL=1; shift;;
    --write-defaults) WRITE_DEFAULTS=1; shift;;
    --check-only) CHECK_ONLY=1; shift;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown option: $1" >&2; usage; exit 1;;
  esac
done

missing=()
required_files=(
  "$DEPLOYED"
  "$BOOTSTRAP"
  "$KEYS"
  "$ABI_ROLE_TOKEN"
)

for f in "${required_files[@]}"; do
  if [[ ! -f "$f" ]]; then
    missing+=("$f")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Missing required files:" >&2
  for f in "${missing[@]}"; do echo "  - $f" >&2; done
  exit 1
fi

if [[ ! -d "$ROOT/iot/abis" ]]; then
  echo "Missing iot/abis directory" >&2
  exit 1
fi

if [[ ! -d "$CONFIG_DIR" ]]; then
  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    echo "Missing config directory: $CONFIG_DIR" >&2
    exit 1
  fi
  mkdir -p "$CONFIG_DIR"
fi

if [[ ! -f "$SECURITY_MATRIX" || ! -f "$THREAT_CATALOG" ]]; then
  if [[ "$WRITE_DEFAULTS" -eq 1 && "$CHECK_ONLY" -eq 0 ]]; then
    if [[ ! -f "$SECURITY_MATRIX" ]]; then
      cat <<'JSON' > "$SECURITY_MATRIX"
{
  "roles": {
    "ADMIN": {
      "localResourceTable": ["view", "edit", "delete", "create"],
      "globalResourceTable": ["view", "edit", "delete", "create"]
    },
    "PRIMARY_GROUP_HEAD": {
      "localResourceTable": ["view", "edit", "create"],
      "globalResourceTable": ["view", "edit", "create"]
    },
    "SECONDARY_GROUP_HEAD": {
      "localResourceTable": ["view", "edit"],
      "globalResourceTable": ["view", "edit"]
    },
    "REGULAR_MEMBER": {
      "localResourceTable": ["view"],
      "globalResourceTable": ["view"]
    },
    "UNKNOWN": {
      "localResourceTable": [],
      "globalResourceTable": []
    }
  }
}
JSON
    fi

    if [[ ! -f "$THREAT_CATALOG" ]]; then
      cat <<'JSON' > "$THREAT_CATALOG"
{
  "events": [
    { "code": "UNAUTHORIZED_ACCESS", "name": "Unauthorized access", "severity": "high", "stride": "elevation of privilege", "response": "deny", "autoResponse": { "type": "warn" }, "tokenAdjustment": -1 },
    { "code": "DATA_TAMPERING", "name": "Data tampering", "severity": "high", "stride": "tampering", "response": "deny", "autoResponse": { "type": "suspend" }, "tokenAdjustment": -5 },
    { "code": "TOO_MANY_ACCESS_ATTEMPTS", "name": "Too many attempts", "severity": "medium", "stride": "dos", "response": "rate-limit", "autoResponse": { "type": "warn" }, "tokenAdjustment": -1 },
    { "code": "DISRUPTION_OF_SERVICE", "name": "Possible DoS", "severity": "high", "stride": "dos", "response": "block", "autoResponse": { "type": "ban" }, "tokenAdjustment": -10 },
    { "code": "SUCCESSFUL_ACCESS", "name": "Successful access", "severity": "info", "stride": "n/a", "response": "allow", "autoResponse": { "type": "reward" }, "tokenAdjustment": 1 },
    { "code": "MISREPRESENTATION_OF_IDENTITY", "name": "Duplicate registration", "severity": "medium", "stride": "spoofing", "response": "deny", "autoResponse": { "type": "warn" }, "tokenAdjustment": -2 }
  ]
}
JSON
    fi
  else
    echo "Missing threat model configs: $SECURITY_MATRIX and/or $THREAT_CATALOG" >&2
    echo "Run with --write-defaults to create defaults." >&2
    exit 1
  fi
fi

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    echo "Missing iot/pi/.env" >&2
    exit 1
  fi
  if [[ -f "$ENV_TEMPLATE" ]]; then
    cp "$ENV_TEMPLATE" "$ENV_FILE"
  else
    touch "$ENV_FILE"
  fi
fi

if [[ "$NO_INSTALL" -eq 0 ]]; then
  if [[ ! -d "$ROOT/iot/pi/node_modules/ethers" ]]; then
    echo "Installing iot/pi dependencies..."
    npm --prefix "$ROOT/iot/pi" install
  fi
fi

if [[ ! -d "$ROOT/iot/pi/node_modules/ethers" ]]; then
  echo "Missing iot/pi/node_modules/ethers. Run npm --prefix iot/pi install." >&2
  exit 1
fi

if [[ -z "$RPC_URL" ]]; then
  RPC_URL="$(grep -E '^RPC_URL=' "$ENV_FILE" | cut -d= -f2- || true)"
fi

if [[ -z "$RPC_URL" ]]; then
  echo "RPC_URL not set. Provide --rpc-url or set RPC_URL in iot/pi/.env" >&2
  exit 1
fi

if [[ -z "$ADMIN_KEY" ]]; then
  echo "Resolving admin key from RoleToken owner..."
  KEY_JSON=$(node --input-type=commonjs - <<NODE
const fs = require('fs');
const path = require('path');
const { ethers } = require(path.join('$ROOT','iot','pi','node_modules','ethers'));
require(path.join('$ROOT','iot','pi','node_modules','dotenv')).config({ path: path.join('$ROOT','iot','pi','.env') });
const rpc = process.env.RPC_URL || '$RPC_URL';
const deployed = JSON.parse(fs.readFileSync('$DEPLOYED','utf8'));
const keys = JSON.parse(fs.readFileSync('$KEYS','utf8')).private_keys || {};
const roleAbi = require('$ABI_ROLE_TOKEN').abi;
(async () => {
  const provider = new ethers.JsonRpcProvider(rpc);
  const roleToken = new ethers.Contract(deployed.addresses.roleToken, roleAbi, provider);
  const owner = await roleToken.owner();
  const pk = keys[owner.toLowerCase()];
  if (!pk) {
    console.error('Admin key not found for owner', owner);
    process.exit(1);
  }
  console.log(JSON.stringify({ owner, pk }));
})();
NODE
)
  ADMIN_KEY="$(printf '%s' "$KEY_JSON" | python -c 'import json,sys; print(json.load(sys.stdin)["pk"])')"
fi

if [[ -z "$PRIMARY_HEAD_KEY" ]]; then
  echo "Selecting a dedicated PGH key (different from admin)..."
  PRIMARY_HEAD_KEY="$(node --input-type=commonjs - <<NODE
const fs = require('fs');
const path = require('path');
const { ethers } = require(path.join('$ROOT','iot','pi','node_modules','ethers'));
const keys = JSON.parse(fs.readFileSync('$KEYS','utf8')).private_keys || {};
const provider = new ethers.JsonRpcProvider('$RPC_URL');
const adminPk = '$ADMIN_KEY'.trim();
const adminAddr = adminPk ? new ethers.Wallet(adminPk).address.toLowerCase() : '';
(async () => {
  const scored = [];
  for (const pk of Object.values(keys)) {
    try {
      const addr = new ethers.Wallet(pk).address.toLowerCase();
      if (addr === adminAddr) continue;
      const nonce = await provider.getTransactionCount(addr);
      scored.push({ pk, nonce });
    } catch (_e) {}
  }
  scored.sort((a, b) => a.nonce - b.nonce);
  if (!scored.length) process.exit(1);
  console.log(scored[0].pk);
})();
NODE
)"
  if [[ -z "$PRIMARY_HEAD_KEY" ]]; then
    echo "Failed to pick a dedicated PGH key; falling back to ADMIN_KEY" >&2
    PRIMARY_HEAD_KEY="$ADMIN_KEY"
  fi
fi

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  echo "Checks OK."
  exit 0
fi

update_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    local tmp
    tmp=$(mktemp)
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} {if ($1==k) {$2=v; print $1"="$2} else print}' "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
  else
    echo "${key}=${value}" >> "$ENV_FILE"
  fi
}

update_env "RPC_URL" "$RPC_URL"
update_env "PRIMARY_HEAD_KEY" "$PRIMARY_HEAD_KEY"
update_env "ADMIN_KEY" "$ADMIN_KEY"

node --input-type=commonjs - <<NODE
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('$DEPLOYED','utf8')).addresses || {};
const map = {
  ROLE_TOKEN_ADDRESS: data.roleToken,
  ROLE_BASED_ADDRESS: data.roleBasedAccessControl,
  ACCESS_FACTORY_ADDRESS: data.accessControlFactory,
  REGISTER_ADDRESS: data.registerContract,
  JUDGE_ADDRESS: data.judgeContract,
};
for (const [k, v] of Object.entries(map)) {
  if (!v) {
    console.error("Missing " + k + " in deployed-addresses.json");
    process.exit(1);
  }
}
NODE

update_env "ROLE_TOKEN_ADDRESS" "$(node -e "console.log(require('$DEPLOYED').addresses.roleToken)")"
update_env "ROLE_BASED_ADDRESS" "$(node -e "console.log(require('$DEPLOYED').addresses.roleBasedAccessControl)")"
update_env "ACCESS_FACTORY_ADDRESS" "$(node -e "console.log(require('$DEPLOYED').addresses.accessControlFactory)")"
update_env "REGISTER_ADDRESS" "$(node -e "console.log(require('$DEPLOYED').addresses.registerContract)")"
update_env "JUDGE_ADDRESS" "$(node -e "console.log(require('$DEPLOYED').addresses.judgeContract)")"

mkdir -p "$ROOT/iot/pi/results"

echo "Ensuring PGH key has ADMIN role..."
node --input-type=commonjs - <<NODE
const fs = require('fs');
const path = require('path');
const { ethers } = require(path.join('$ROOT','iot','pi','node_modules','ethers'));
require(path.join('$ROOT','iot','pi','node_modules','dotenv')).config({ path: path.join('$ROOT','iot','pi','.env') });
const rpc = process.env.RPC_URL;
const deployed = require('$DEPLOYED');
const roleAbi = require('$ABI_ROLE_TOKEN').abi;
const adminPk = process.env.ADMIN_KEY;
const pghPk = process.env.PRIMARY_HEAD_KEY;
if (!adminPk || !pghPk) process.exit(0);
const provider = new ethers.JsonRpcProvider(rpc);
const adminWallet = new ethers.Wallet(adminPk, provider);
const pghAddr = new ethers.Wallet(pghPk).address;
(async () => {
  const roleToken = new ethers.Contract(deployed.addresses.roleToken, roleAbi, adminWallet);
  const role = await roleToken.getRole(pghAddr);
  if (role.toString() === "1") return;
  const owner = await roleToken.owner();
  const tx = await roleToken.assignAdminRole(owner, pghAddr);
  await tx.wait();
  console.log("Granted ADMIN role to PGH key " + pghAddr);
})();
NODE

if node -e "const d=require('$DEPLOYED').addresses; process.exit(d.tableAccessControlContract?0:1)"; then
  echo "TableAccessControlContract present: $(node -e "console.log(require('$DEPLOYED').addresses.tableAccessControlContract)")"
else
  echo "Warning: tableAccessControlContract missing from deployed-addresses.json; TAC suite will be skipped." >&2
fi

echo "Setup complete. Updated $ENV_FILE."
