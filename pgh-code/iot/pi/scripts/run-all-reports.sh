#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PGH_API_BASE="${PGH_API_BASE:-http://127.0.0.1:8080}"
PGH_A_BASE="${PGH_A_BASE:-http://127.0.0.1:8080}"
PGH_B_BASE="${PGH_B_BASE:-http://127.0.0.1:8081}"
METRICS_URL="${METRICS_URL:-$PGH_API_BASE/metrics}"
RUN_TS="$(date -Iseconds | tr ':' '-')"
RUN_DIR="$ROOT/iot/pi/results/run-all-reports-${RUN_TS}"
mkdir -p "$RUN_DIR"

require_pgh() {
  local base="$1"
  curl -fsS "$base/status" >/dev/null 2>&1
}

start_pgh() {
  echo "Starting PGH..."
  pkill -f primary_head >/dev/null 2>&1 || true
  npm --prefix "$ROOT/iot/pi" start >/tmp/pgh.log 2>&1 &
  local start_ts
  start_ts=$(date +%s)
  while true; do
    if require_pgh "$PGH_API_BASE"; then
      echo "PGH ready at $PGH_API_BASE"
      return 0
    fi
    if (( $(date +%s) - start_ts > 25 )); then
      echo "PGH did not become ready. Check /tmp/pgh.log" >&2
      return 1
    fi
    sleep 1
  done
}

cd "$ROOT"

mkdir -p "$ROOT/iot/pi/results"

if ! require_pgh "$PGH_API_BASE"; then
  start_pgh
fi

echo "=== Full-chain sim (direct on-chain, no PGH) ==="
node iot/pi/scripts/full-chain-sim.js

echo "=== PGH-driven sim ==="
STRICT_SUCCESS=1 PGH_API_BASE="$PGH_API_BASE" node iot/pi/scripts/run-all-via-pgh.js

echo "=== Attack scenarios ==="
API_BASE="$PGH_API_BASE" iot/pi/scripts/run-attack-scenarios.sh

echo "=== Collector ==="
iot/pi/scripts/run-collector-auto.sh

if node -e "const d=require('./tmp/deployed-addresses.json').addresses; process.exit(d.tableAccessControlContract?0:1)"; then
  echo "=== Full suite with TAC ==="
  STRICT_SUCCESS=1 PGH_API_BASE="$PGH_API_BASE" node iot/pi/scripts/run-full-suite-with-tac.js
else
  echo "Skipping TAC suite: tableAccessControlContract missing in tmp/deployed-addresses.json"
fi

if require_pgh "$PGH_A_BASE" && require_pgh "$PGH_B_BASE"; then
  echo "=== Cross-PGH suite ==="
  PGH_A_BASE="$PGH_A_BASE" PGH_B_BASE="$PGH_B_BASE" node iot/pi/scripts/run-cross-pgh.js
else
  echo "Skipping cross-PGH suite: both PGH_A_BASE and PGH_B_BASE must be reachable."
fi

echo "All report scripts complete. See iot/pi/results/"
SUITE_METRICS="$RUN_DIR/metrics-suite.txt"
if curl -s -m 3 "$METRICS_URL" >"$SUITE_METRICS"; then
  echo "Wrote suite metrics snapshot: $SUITE_METRICS"
else
  echo "metrics unavailable from $METRICS_URL" >"$SUITE_METRICS"
fi

echo "Suite log directory: $RUN_DIR"
