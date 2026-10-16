#!/usr/bin/env bash
set -euo pipefail

# Demo helper:
# - Seeds two ESP MACs with data on the local ESP API
# - Shows same-PGH access (MAC_A -> MAC_B) by granting access locally
# - Shows inter-PGH style access by simulating a peer request (peer_id + remote MAC)
# Requires ESP API running (default http://localhost:5000)

API_BASE="${API_BASE:-http://localhost:5000}"
MAC_A="${MAC_A:-AA:BB:CC:DD:EE:01}"
MAC_B="${MAC_B:-AA:BB:CC:DD:EE:02}"
PEER_GROUP_ID="${PEER_GROUP_ID:-pgh-remote}"
REMOTE_MAC="${REMOTE_MAC:-AA:BB:CC:DD:EE:99}"

echo "ESP API: $API_BASE"
echo "MAC_A (requestor): $MAC_A"
echo "MAC_B (target):    $MAC_B"
echo "Peer simulation: group=$PEER_GROUP_ID, remote_mac=$REMOTE_MAC"

post_data() {
  local mac=$1
  local temp=$2
  local hum=$3
  curl -s -o /dev/null -w "%{http_code}" -X POST "$API_BASE/data" \
    -H "Content-Type: application/json" \
    -d "{\"mac\":\"$mac\",\"temperature\":$temp,\"humidity\":$hum}"
}

echo "Seeding data for MAC_A and MAC_B..."
post_data "$MAC_A" 23.5 50.0 >/dev/null
post_data "$MAC_B" 24.0 55.0 >/dev/null
echo "Seed done."

echo "Granting same-PGH access (MAC_A -> MAC_B) for 24h..."
curl -s "$API_BASE/approve-access" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "{\"requestor_mac\":\"$MAC_A\",\"requestor_ip\":\"127.0.0.1\",\"target_mac\":\"$MAC_B\"}" \
  >/dev/null

echo "Checking status of MAC_B as MAC_A..."
curl -s -D - -H "X-Requestor-MAC: $MAC_A" "$API_BASE/status/$MAC_B"
echo

echo "Simulating peer PGH request (remote PGH asks for MAC_B on behalf of $REMOTE_MAC)..."
curl -s "$API_BASE/peer/incoming-request" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "{\"peer_group_id\":\"$PEER_GROUP_ID\",\"requestor_mac\":\"$REMOTE_MAC\",\"target_mac\":\"$MAC_B\"}" \
  >/dev/null

echo "Approving peer PGH request (localhost-only endpoint)..."
curl -s "$API_BASE/peer/approve-access" \
  -X POST \
  -H "Content-Type: application/json" \
  -d "{\"peer_group_id\":\"$PEER_GROUP_ID\",\"requestor_mac\":\"$REMOTE_MAC\",\"target_mac\":\"$MAC_B\"}" \
  >/dev/null

echo "Checking status of MAC_B as remote PGH (peer headers)..."
curl -s -D - \
  -H "X-Requestor-Group: $PEER_GROUP_ID" \
  -H "X-Requestor-MAC: $REMOTE_MAC" \
  "$API_BASE/status/$MAC_B"
echo

echo "Done. Inspect esp_api_project/esp_data.db for state, and PGH demo logs/metrics for on-chain logging."
