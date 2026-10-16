#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$ROOT/iot/pi/.env"
DEPLOYED="$ROOT/tmp/deployed-addresses.json"
BOOTSTRAP="$ROOT/tmp/bootstrap-config.json"
KEYS="$ROOT/tmp/ganache-keys.json"
ABI_ROLE_TOKEN="$ROOT/iot/abis/RoleToken.json"

RPC_URL=""
CHECK_ONLY=0
PREP_ONLY=0
NO_INSTALL=0
SKIP_SETUP=0

usage() {
  cat <<USAGE
Usage: $0 [options]

Options:
  --rpc-url <url>     RPC URL to Ganache (overrides .env)
  --check-only        Only check prerequisites; do not modify or run
  --prep-only         Run setup + PGH restart; do not run simulations
  --no-install        Skip npm install even if deps missing
  --skip-setup        Do not call setup-pi.sh (only validate .env)
  -h, --help          Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rpc-url) RPC_URL="$2"; shift 2;;
    --check-only) CHECK_ONLY=1; shift;;
    --prep-only) PREP_ONLY=1; shift;;
    --no-install) NO_INSTALL=1; shift;;
    --skip-setup) SKIP_SETUP=1; shift;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown option: $1" >&2; usage; exit 1;;
  esac
done

req_files=(
  "$DEPLOYED"
  "$BOOTSTRAP"
  "$KEYS"
  "$ABI_ROLE_TOKEN"
)

missing=()
for f in "${req_files[@]}"; do
  if [[ ! -f "$f" ]]; then
    missing+=("$f")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Missing required files:" >&2
  for f in "${missing[@]}"; do echo "  - $f" >&2; done
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE; run iot/pi/scripts/setup-pi.sh first." >&2
  exit 1
fi

if [[ -z "$RPC_URL" ]]; then
  RPC_URL="$(grep -E '^RPC_URL=' "$ENV_FILE" | cut -d= -f2- || true)"
fi
if [[ -z "$RPC_URL" ]]; then
  echo "RPC_URL not set. Use --rpc-url or set it in $ENV_FILE" >&2
  exit 1
fi

# Check RPC reachable
if ! curl -s -m 2 -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  "$RPC_URL" >/dev/null; then
  echo "Ganache RPC not reachable at $RPC_URL. Start Ganache on the laptop." >&2
  exit 1
fi

if [[ "$NO_INSTALL" -eq 0 ]]; then
  if [[ ! -d "$ROOT/iot/pi/node_modules/ethers" ]]; then
    echo "Installing iot/pi dependencies..."
    npm --prefix "$ROOT/iot/pi" install
  fi
fi

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  echo "Checks OK."
  exit 0
fi

if [[ "$SKIP_SETUP" -eq 0 ]]; then
  "$ROOT/iot/pi/scripts/setup-pi.sh" --rpc-url "$RPC_URL" --write-defaults
fi

# Validate .env keys differ
ADMIN_KEY="$(grep -E '^ADMIN_KEY=' "$ENV_FILE" | cut -d= -f2- || true)"
PGH_KEY="$(grep -E '^PRIMARY_HEAD_KEY=' "$ENV_FILE" | cut -d= -f2- || true)"
if [[ -z "$ADMIN_KEY" || -z "$PGH_KEY" ]]; then
  echo "ADMIN_KEY or PRIMARY_HEAD_KEY missing in $ENV_FILE" >&2
  exit 1
fi
if [[ "$ADMIN_KEY" == "$PGH_KEY" ]]; then
  echo "ADMIN_KEY and PRIMARY_HEAD_KEY are the same. Re-run setup-pi.sh to split keys." >&2
  exit 1
fi

# Restart PGH
pkill -f '[p]rimary_head.js' >/dev/null 2>&1 || true
npm --prefix "$ROOT/iot/pi" start >/tmp/pgh.log 2>&1 &

# Wait for PGH
start_ts=$(date +%s)
while true; do
  if curl -s -m 2 "http://127.0.0.1:8080/status" >/dev/null; then
    break
  fi
  if (( $(date +%s) - start_ts > 25 )); then
    echo "PGH did not become ready. Check /tmp/pgh.log" >&2
    exit 1
  fi
  sleep 1
done

if [[ "$PREP_ONLY" -eq 1 ]]; then
  echo "Prep complete."
  exit 0
fi

# Run the full suite
"$ROOT/iot/pi/scripts/run-all-reports.sh"
