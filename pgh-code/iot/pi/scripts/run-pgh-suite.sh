#!/usr/bin/env bash
# Clean PGH-only suite: pick Role.NONE object/subject, ensure admin key matches RoleToken owner, restart PGH, run PGH sim (success-only), and collector.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$ROOT"

PGH_API_BASE="${PGH_API_BASE:-http://127.0.0.1:8080}"
ENV_FILE="$ROOT/iot/pi/.env"
KEYS_FILE="$ROOT/tmp/ganache-keys.json"
DEPLOYED="$ROOT/tmp/deployed-addresses.json"
ROLE_ABI="$ROOT/iot/abis/RoleToken.json"
METRICS_URL="${METRICS_URL:-$PGH_API_BASE/metrics}"
RUN_TS="$(date -Iseconds | tr ':' '-')"
RUN_DIR="$ROOT/iot/pi/results/run-pgh-suite-${RUN_TS}"
mkdir -p "$RUN_DIR"

# Determine admin key from RoleToken owner, and pick fixed object/subject (env overrides) or Role.NONE (reclaiming if needed)
pick_all() {
  node -e "const fs=require('fs');const ethers=require('./iot/pi/node_modules/ethers');const keys=JSON.parse(fs.readFileSync('$KEYS_FILE','utf8')).private_keys;const deployed=JSON.parse(fs.readFileSync('$DEPLOYED','utf8')).addresses;const roleAbi=JSON.parse(fs.readFileSync('$ROLE_ABI','utf8')).abi;const prov=new ethers.JsonRpcProvider(process.env.RPC_URL||'http://127.0.0.1:8545');const envObj=process.env.FIXED_OBJECT;const envSub=process.env.FIXED_SUBJECT;(async()=>{const role=new ethers.Contract(deployed.roleToken,roleAbi,prov);const owner=await role.owner();const adminPk=keys[owner.toLowerCase()];if(!adminPk){console.error('Admin key not found for owner',owner);process.exit(1);}const adminWallet=new ethers.Wallet(adminPk,prov);async function roleOf(a){try{return (await role.getRole(a)).toString();}catch{return null;}}async function nonceOf(a){try{return await prov.getTransactionCount(a);}catch{return 1e9;}}async function ensureNone(a){const r=await roleOf(a);if(r && r!=='0' && r!=='1'){try{const tx=await role.connect(adminWallet).revokeRole(a);await tx.wait();}catch(e){/* ignore */}}}if(envObj && envSub){await ensureNone(envObj);await ensureNone(envSub);console.log(JSON.stringify({pk:adminPk,object:envObj,subject:envSub}));return;}let none=[];for(const a of Object.keys(keys)){const r=await roleOf(a);if(r==='0') none.push(a);}if(none.length<2){for(const a of Object.keys(keys)){if(a.toLowerCase()===owner.toLowerCase()) continue;const r=await roleOf(a);if(r && r!=='0' && r!=='1'){try{const tx=await role.connect(adminWallet).revokeRole(a);await tx.wait();const rn=await roleOf(a);if(rn==='0') none.push(a);if(none.length>=2) break;}catch(e){continue;}}}}none=[...new Set(none)];if(none.length<2){console.error('Not enough Role.NONE addresses even after revoke');process.exit(1);}none = (await Promise.all(none.map(async a=>({addr:a,nonce:await nonceOf(a)})))).sort((a,b)=>a.nonce-b.nonce);console.log(JSON.stringify({pk:adminPk,object:none[0].addr,subject:none[1].addr}));})();"
}

SEL="$(pick_all)"
NEW_PK="$(echo "$SEL" | jq -r '.pk')"
FIXED_OBJECT="$(echo "$SEL" | jq -r '.object')"
FIXED_SUBJECT="$(echo "$SEL" | jq -r '.subject')"
export FIXED_OBJECT FIXED_SUBJECT

revoke_if_needed() {
  node -e "const fs=require('fs');const ethers=require('./iot/pi/node_modules/ethers');const keys=JSON.parse(fs.readFileSync('$KEYS_FILE','utf8')).private_keys;const deployed=JSON.parse(fs.readFileSync('$DEPLOYED','utf8')).addresses;const roleAbi=JSON.parse(fs.readFileSync('$ROLE_ABI','utf8')).abi;const prov=new ethers.JsonRpcProvider(process.env.RPC_URL||'http://127.0.0.1:8545');(async()=>{const role=new ethers.Contract(deployed.roleToken,roleAbi,prov);const admin=new ethers.Wallet('$NEW_PK',prov);async function roleOf(a){try{return (await role.getRole(a)).toString();}catch{return null;}}for(const a of ['$FIXED_OBJECT','$FIXED_SUBJECT']){const r=await roleOf(a);if(r && r!=='0' && r!=='1'){try{const tx=await role.connect(admin).revokeRole(a);await tx.wait();}catch(e){console.error('revoke failed',a,e.message);}}} })();"
}

update_env() {
  local key="$1"
  local file="$2"
  local tmp=$(mktemp)
  awk -v k="$key" '
    /^PRIMARY_HEAD_KEY=/ {print "PRIMARY_HEAD_KEY=" k; next}
    /^ADMIN_KEY=/ {print "ADMIN_KEY=" k; next}
    {print}
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

echo "Using admin key: $NEW_PK"
echo "Using fixed object: $FIXED_OBJECT"
echo "Using fixed subject: $FIXED_SUBJECT"
update_env "$NEW_PK" "$ENV_FILE"

echo "Revoking roles for fixed object/subject if needed..."
revoke_if_needed

echo "Restarting PGH..."
pkill -f primary_head || true
npm --prefix iot/pi start >/tmp/pgh.log 2>&1 &
sleep 3

echo "Running PGH sim (strict success)..."
STRICT_SUCCESS=1 PGH_API_BASE="$PGH_API_BASE" node iot/pi/scripts/run-all-via-pgh.js

echo "Running collector..."
iot/pi/scripts/run-collector-auto.sh

echo "Done. Check iot/pi/results/ for outputs."
SUITE_METRICS="$RUN_DIR/metrics.txt"
if curl -s -m 3 "$METRICS_URL" >"$SUITE_METRICS"; then
  echo "Wrote metrics snapshot: $SUITE_METRICS"
else
  echo "metrics unavailable from $METRICS_URL" >"$SUITE_METRICS"
fi

echo "Run log directory: $RUN_DIR"
