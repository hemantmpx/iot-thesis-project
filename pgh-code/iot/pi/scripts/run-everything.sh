#!/usr/bin/env bash
# Run all simulations in one shot on the Pi.
# Prereqs: PGH running (or will start separately), .env configured, Ganache reachable via RPC_URL.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"   # repo root

# Use provided PGH_API_BASE or default to localhost:8080
export PGH_API_BASE="${PGH_API_BASE:-http://127.0.0.1:8080}"
METRICS_URL="${METRICS_URL:-$PGH_API_BASE/metrics}"
RUN_TS="$(date -Iseconds | tr ':' '-')"
RUN_DIR="$ROOT/iot/pi/results/run-everything-${RUN_TS}"
mkdir -p "$RUN_DIR"

echo "=== Running full-chain sim (on-chain, no PGH) ==="
(cd "$ROOT" && node iot/pi/scripts/full-chain-sim.js)

echo "=== Running PGH-driven sim (auto nonce rotation) ==="
(cd "$ROOT" && PGH_API_BASE="$PGH_API_BASE" node iot/pi/scripts/run-all-via-pgh.js)

echo "=== Running attack/threat scenarios via PGH ==="
(cd "$ROOT" && iot/pi/scripts/run-attack-scenarios.sh)

echo "=== Running collector (register->deploy->policies->eval + telemetry) ==="
(cd "$ROOT" && iot/pi/scripts/run-collector-auto.sh)

echo "All runs complete. Check iot/pi/results/ for outputs."
SUITE_METRICS="$RUN_DIR/metrics.txt"
if curl -s -m 3 "$METRICS_URL" >"$SUITE_METRICS"; then
  echo "Wrote metrics snapshot: $SUITE_METRICS"
else
  echo "metrics unavailable from $METRICS_URL" >"$SUITE_METRICS"
fi

echo "Run log directory: $RUN_DIR"
