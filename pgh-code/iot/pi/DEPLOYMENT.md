# Raspberry Pi Deployment Guide (Primary Group Head)

This guide separates what runs on your **laptop** (Ganache, contract bootstrap, backend/frontend) from what runs on each **Raspberry Pi** (primary group head gateway).

## End-to-End Simulation Overview

You can run fully automated simulations that exercise all contracts (RoleToken, RoleBasedAccessControl, Register, AccessControlFactory/AccessControlContract, Judge), plus ESP ingestion/access logging. Outputs include on-chain tx hashes, events, and JSON telemetry for demos.

## What Runs Where (Code Split)

**Laptop / Server**
- Ganache (chain): `npx ganache --wallet.totalAccounts 25 --wallet.accountKeysPath tmp/ganache-keys.json --chain.chainId 1337`
- Contract bootstrap: `npm run bootstrap` (root of Access_Control_Mechanism-main)
- Optional backend/frontend (from `blockchain-access-control-main`)
- Optional Truffle console for on-chain inspection

**Raspberry Pi (per primary group head)**
- Primary-head gateway only: `iot/pi/primary_head.js` (`npm --prefix iot/pi start`)
- Optional validation scripts: `iot/pi/harness.js`, `iot/pi/collect.js`, `iot/pi/collect-extended.js`
- You do *not* run bootstrap or Ganache on the Pi (unless you deliberately host the chain there)

## Files to Copy to Each Pi

From the laptop after running `npm run bootstrap`:
1. `tmp/deployed-addresses.json`
2. `tmp/bootstrap-config.json`
3. `tmp/ganache-keys.json` (or just the private key you assign to that Pi)
4. `iot/abis/` (entire folder)

## Configure the Pi (`iot/pi/.env`)

Set these on each Pi (edit `iot/pi/.env`):
```
RPC_URL=http://<laptop-ip>:8545           # Ganache endpoint
PRIMARY_HEAD_KEY=<private key for this Pi wallet>
ROLE_TOKEN_ADDRESS=<from deployed-addresses.json>
ROLE_BASED_ADDRESS=<from deployed-addresses.json>
ACCESS_FACTORY_ADDRESS=<from deployed-addresses.json>
REGISTER_ADDRESS=<from deployed-addresses.json>
JUDGE_ADDRESS=<from deployed-addresses.json>
# Optional: ADMIN_KEY=<admin private key> to allow collectors to auto-fix roles
```

### Auto-generate per-Pi env files (from laptop)

Use the template `iot/pi/.env.template` and the helper `scripts/gen-env.sh`:
```bash
# After npm run bootstrap (so tmp/deployed-addresses.json is fresh)
chmod +x scripts/gen-env.sh
scripts/gen-env.sh pgha 0x<privkey-for-PGH-A>
scripts.gen-env.sh pghb 0x<privkey-for-PGH-B>
```
This writes:
- `iot/pi/.env.pgha`
- `iot/pi/.env.pghb`

Copy the appropriate file to each Pi as `iot/pi/.env`.

## Install & Run on the Pi

```bash
# On the Pi
npm --prefix iot/pi install
npm --prefix iot/pi start
```

## One-Command Prep + Run (recommended)

Use the automation script to validate prerequisites, refresh `.env`, restart PGH, and run the full suite:

```bash
iot/pi/scripts/prep-and-run.sh --rpc-url http://<laptop-ip>:8545
```

Useful modes:
```bash
# Only validate prerequisites
iot/pi/scripts/prep-and-run.sh --check-only

# Prep only (refresh .env, restart PGH)
iot/pi/scripts/prep-and-run.sh --rpc-url http://<laptop-ip>:8545 --prep-only
```

## Script Audit (overlaps + safe ordering)

If you want clean runs and clear reports, pick **one** entry-point suite and avoid stacking suites in the same session. Per-script guides live in `docs/scripts/README.md` and `docs/scripts/<script>.md`.

### Entry-point suites (do not stack these)
- `iot/pi/scripts/prep-and-run.sh`  
  Runs `setup-pi.sh`, restarts PGH, then runs `run-all-reports.sh`.
- `iot/pi/scripts/run-all-reports.sh`  
  Starts PGH if needed, then runs: full-chain sim, PGH sim, attack sim, collector, TAC (if deployed), cross-PGH (if both PGHs up).
- `iot/pi/scripts/run-everything.sh`  
  Runs the core sims (full-chain, PGH sim, attack, collector) but does **not** start PGH.
- `iot/pi/scripts/run-pgh-suite.sh`  
  Picks admin key from RoleToken owner, overwrites `ADMIN_KEY` in `.env`, restarts PGH, then runs PGH sim + collector.

### Building-block scripts (safe alone, but overlap work)
- `iot/pi/scripts/full-chain-sim.js` and `iot/pi/scripts/run-all-on-pi.js` both do direct on-chain flows without PGH. Use one or the other.
- `iot/pi/scripts/run-all-via-pgh.js` already registers + deploys + sets policies. If you run `run-collector-auto.sh` or `run-attack-scenarios.sh` right after, you are repeating those actions with new addresses.
- `iot/pi/scripts/run-collector-auto.sh` and `iot/pi/scripts/run-attack-scenarios.sh` both call `register-device`, `deploy-contract`, and `policies`. Re-running is fine but consumes nonces and creates new ACCs.

### PGH lifecycle overlaps
- `setup-pi.sh`, `prep-and-run.sh`, and `run-pgh-suite.sh` **write** `.env`. After any of these, restart PGH so it reloads keys and addresses.
- If you already have a stable, running PGH and do **not** want restarts, prefer `run-everything.sh`.

## Recommended script order (pick the flow you need)

### 0) Required once per fresh chain (laptop)
1. Start Ganache.
2. `npm run bootstrap`.
3. Copy `tmp/deployed-addresses.json`, `tmp/bootstrap-config.json`, `tmp/ganache-keys.json`, `iot/abis/` to the Pi.
4. Set `iot/pi/.env` (or run `iot/pi/scripts/setup-pi.sh`).

### 1) Full automation on the Pi (recommended)
```
iot/pi/scripts/prep-and-run.sh --rpc-url http://<laptop-ip>:8545
```
This is the one-command "prep + run everything" flow. See `docs/scripts/prep-and-run.sh.md`.

### 2) Full report suite (PGH auto-start)
```
iot/pi/scripts/run-all-reports.sh
```
Use this if `.env` is already correct and you want the broadest report set. See `docs/scripts/run-all-reports.sh.md`.

### 3) PGH-only flow (clean keys + PGH sim + collector)
```
iot/pi/scripts/run-pgh-suite.sh
```
This overwrites `ADMIN_KEY` in `.env` to match the RoleToken owner and restarts PGH. See `docs/scripts/run-pgh-suite.sh.md`.

### 4) On-chain only (no PGH)
Pick one:
```
node iot/pi/scripts/full-chain-sim.js
node iot/pi/scripts/run-all-on-pi.js
```
See `docs/scripts/full-chain-sim.js.md` and `docs/scripts/run-all-on-pi.js.md`.

### 5) Targeted runs (pick what you need)
- Attack scenarios: `iot/pi/scripts/run-attack-scenarios.sh`  
  Guide: `docs/scripts/run-attack-scenarios.sh.md`
- Collector: `iot/pi/scripts/run-collector-auto.sh`  
  Guide: `docs/scripts/run-collector-auto.sh.md`
- TAC suite (only if `tableAccessControlContract` exists):  
  `node iot/pi/scripts/run-full-suite-with-tac.js`  
  Guide: `docs/scripts/run-full-suite-with-tac.js.md`
- Cross-PGH suite (requires two PGHs reachable):  
  `node iot/pi/scripts/run-cross-pgh.js`  
  Guide: `docs/scripts/run-cross-pgh.js.md`
- ESP demo (requires PGH + ESP API running):  
  `esp_api_project/scripts/demo-esp-access.sh`  
  Guide: `docs/scripts/demo-esp-access.sh.md`

## (Optional) Run the Extended Collector on the Pi

```bash
# COLLECT_SUBJECT can be any address; the script will revoke existing roles if ADMIN_KEY is provided
COLLECT_SUBJECT=0x<address> ADMIN_KEY=<admin-key> PRIMARY_HEAD_KEY=<pi-key> npm --prefix iot/pi run collect:extended
```

Outputs will be written under `iot/pi/results/<timestamp>/`.

## Full Simulation (all contracts)

### 0) Prereqs (chain & contracts)
- Start Ganache with keys:
  ```bash
  npx ganache --wallet.totalAccounts 25 --wallet.accountKeysPath tmp/ganache-keys.json --chain.chainId 1337
  ```
- Bootstrap contracts:
  ```bash
  npm run bootstrap
  ```
- Update `iot/pi/.env` with addresses from `tmp/deployed-addresses.json` (roleToken, roleBased, factory, register, judge), set `RPC_URL`, `PRIMARY_HEAD_KEY`, `ADMIN_KEY`. Optionally set `DEFAULT_OBJECT_ADDRESS` to a Role.NONE address from `tmp/ganache-keys.json`.
- Restart PGH: `npm --prefix iot/pi start`
- Register your object with a memberType (so factory check passes):
  ```bash
  curl -X POST http://localhost:8080/register-device \
    -H 'Content-Type: application/json' \
    -d '{"deviceAddress":"<DEFAULT_OBJECT_ADDRESS>","name":"object","memberType":"type1"}'
  ```

### 1) Full-chain simulation script (no hardware needed)
From repo root:
```bash
node iot/pi/scripts/full-chain-sim.js
```
What it does:
- Picks unused Role.NONE wallets for object + two subjects (from `tmp/ganache-keys.json`).
- Registers them via RoleBasedAccessControl.
- Deploys an ACC via AccessControlFactory/Register.
- Adds allow (view) and deny (edit) policies.
- Executes on-chain `accessControl` txs (allow, too-frequent, tamper) using the subject’s wallet; Judge handles rewards/penalties.
- Captures tx hashes, roles, Judge blocking info; writes to `iot/pi/results/full-sim-<timestamp>.json`.

### 2) Collector (scripted gateway exercise)
- Auto-pick subject/object (Role.NONE), register object, run extended flow:
  ```bash
  iot/pi/scripts/run-collector-auto.sh
  ```
- Outputs: `iot/pi/results/<timestamp>/` (register/deploy/policies/evals), PGH demo logs in `iot/pi/results/demo-telemetry/`.

### 3) ESP ingestion + access (with or without hardware)
- Start ESP API:
  ```bash
  export PGH_API_BASE=http://<pgh-ip>:8080
  export PGH_OBJECT_ADDRESS=<object from tmp/deployed-addresses.json or your default>
  export PGH_ACC_TYPE=sensor
  python esp_api_project/esp_api_2waycomm.py
  ```
- Simulate an ESP sending data:
  ```bash
  curl -X POST http://<esp-api-ip>:5000/data \
    -H 'Content-Type: application/json' \
    -d '{"mac":"AA:BB:CC:DD:EE:01","temperature":23.5,"humidity":50.0}'
  ```
  (ESP API auto-assigns a chain identity, registers, deploys ACC, adds policies best-effort.)
- Check status/temps (logs on-chain via PGH):
  ```bash
  curl -H "X-Requestor-MAC: AA:BB:CC:DD:EE:01" http://<esp-api-ip>:5000/status/AA:BB:CC:DD:EE:01
  curl -H "X-Requestor-MAC: AA:BB:CC:DD:EE:01" http://<esp-api-ip>:5000/temps/AA:BB:CC:DD:EE:01
  ```
- Same-PGH + peer simulation:
  ```bash
  esp_api_project/scripts/demo-esp-access.sh
  ```
  Seeds two MACs, grants same-PGH access, simulates peer PGH request/approval, checks peer access.

### 4) Dashboard (optional)
- From `esp32-dashboard`:
  ```bash
  npm install
  npm run dev
  ```
  Set `VITE_API_BASE_URL=http://<esp-api-ip>:5000` if not same-origin. The “PGH / Chain” tab shows PGH status, metrics, demo logs; other tabs show devices/logs/alerts.

### 5) Outputs and where to look
- PGH demo logs (deploy/policy/evaluate with tx hashes): `iot/pi/results/demo-telemetry/`
- Full-chain sim report: `iot/pi/results/full-sim-<timestamp>.json`
- Collector runs: `iot/pi/results/<timestamp>/`
- ESP telemetry (when using `/esp/evaluate`): `iot/pi/results/esp-telemetry/`
- PGH status/metrics: `/status`, `/metrics` (or dashboard PGH tab)
- Chain events: inspect ACC addresses from deploy responses; events include `AccessControlChecked` and Judge penalties/rewards.
- Attack simulation report: `iot/pi/results/attacks-<timestamp>.json` (register, deploy, policies, allow/too-frequent/tamper evals) with API responses captured.
- On-Pi one-shot report: `iot/pi/results/run-all-<timestamp>.json` (registers object/subjects, deploys ACC, adds policies, runs access txs; includes tx hashes/gas/roles/Judge blocking).

### Gas, timing, tokens, penalties
- PGH `/metrics` (Prometheus): tx duration histograms (`primary_group_head_tx_duration_seconds`), gas histograms (`tx_gas_used`), HTTP timings, request counts, access decision counts.
- PGH demo logs: tx hashes; you can look up gas/time per tx via your RPC; threat findings include `tokenAdjustment` (rewards/penalties).
- Full-chain sim report (`full-sim-*.json`): tx hashes/steps (deploy, policies, accessControl), Judge blocking info; query your RPC by tx hash for gas/time.
- Attack sim report (`attacks-*.json`): API responses; combine with `/metrics` and demo logs for timing/gas/token deltas.
- On-Pi one-shot report (`run-all-*.json`): registers object/subjects, deploys ACC, adds policies, runs access txs (allow/too-frequent/tamper), records tx hashes, gas used, roles, Judge blocking.
- RoleToken balances and Judge state: query on-chain by tx hash; PGH `/status` shows recent token adjustments and tracked balances.

### 6) Common pitfalls
- ACC deploy fails: ensure `.env` matches `tmp/deployed-addresses.json`, object has a role (e.g., type1), and RPC is reachable.
- Role shows UNKNOWN: register the subject via `/register-device` so RoleToken shows a non-NONE role.
- Nonce errors: avoid sharing the same key between PGH and admin scripts. Use `setup-pi.sh` or `prep-and-run.sh` to ensure `PRIMARY_HEAD_KEY` and `ADMIN_KEY` are different and the PGH key has ADMIN role.

### Quick reset of PGH signer to avoid nonce clashes
If you keep seeing `the tx doesn't have the correct nonce` from PGH:
1) Use the automated setup to pick a dedicated PGH key and grant it ADMIN:
```
iot/pi/scripts/setup-pi.sh --rpc-url http://<laptop-ip>:8545 --write-defaults
```
2) Restart PGH so it reads the updated `.env`:
```
pkill -f '[p]rimary_head.js' || true
npm --prefix iot/pi start
```
3) Re-run the sim:
```
iot/pi/scripts/run-all-via-pgh.js
```

## Nonce Issue (Report)

See `iot/pi/NONCE_REPORT.md` for a high-level explanation of the nonce error we encountered and the fix (separate admin/PGH keys + reset flow).

## ESP / IoT Bridge

- The gateway now exposes `/esp/evaluate` for lightweight devices. Payload:
  ```json
  {
    "deviceAddress": "0x<subject>",
    "resource": "sensor/temp",
    "action": "view",
    "objectAddress": "0x<optional overrides default>",
    "accType": "sensor",
    "telemetry": { "temp": 22.5 },
    "logOnChain": true,
    "subjectPrivateKey": "0x<subject-key-if-logOnChain>"
  }
  ```
- Defaults: `objectAddress` falls back to `DEFAULT_OBJECT_ADDRESS` (env or `tmp/bootstrap-config.json`), `accType` falls back to `DEFAULT_ACC_TYPE` (env or `bootstrap-config.json`).
- Telemetry blobs are stored under `iot/pi/results/esp-telemetry/` and logged as `esp_evaluate` events; access decisions still run through on-chain ACCs.

### Demo Telemetry

- The gateway writes demo-friendly logs to `iot/pi/results/demo-telemetry/` for key operations (register, deploy, policies, evaluate, esp/evaluate). Set `DEMO_LOG_DIR` to override the path.
- Use these files to showcase requests, decisions, threats, and tx hashes without scraping stdout.
- Optional on-chain logging of access decisions: include `logOnChain: true` and `subjectPrivateKey` in the request to `/evaluate-access` or `/esp/evaluate`. The gateway will send a real transaction to the ACC (emitting `AccessControlChecked`) and returns `txHash` in the response. Leave `logOnChain` false for read-only simulation.

## Provision ESP Devices from the Pi

Use the helper to register a device, deploy its ACC, add a starter policy, and emit a config blob for firmware/dashboard:
```bash
ESP_PRIVATE_KEY=0x<esp-privkey> \
ESP_OBJECT_ADDRESS=0x<object> \
PGH_API_URL=http://<pgh-ip>:8080 \
npm --prefix iot/pi run provision:esp
```
Outputs land in `iot/pi/provisioned/esp-<suffix>.json` with:
- ESP config (`apiUrl`, `deviceAddress`, `objectAddress`, `accType`, `resource`, `action`)
- Contract address and tx hashes (register/deploy/policy)
- Dashboard hints (API URL + contract/subject/object)

## Multi-Pi Setup

- Assign a unique `PRIMARY_HEAD_KEY` (wallet) to each Pi (use different entries from `tmp/ganache-keys.json`).
- All Pis share the same `RPC_URL` and contract addresses from `deployed-addresses.json`.
- Start a gateway instance on each Pi with its own `.env`.

## Laptop Startup Sequence (once per fresh chain)

1. Start Ganache on laptop.
2. `npm run bootstrap` on laptop.
3. (Optional) start backend/frontend if needed.
4. Copy files to Pis and configure `.env`.
5. Start gateways on Pis.

## Quick Start (clean slate, everything)

1) Chain and contracts
- Start Ganache: `npx ganache --wallet.totalAccounts 25 --wallet.accountKeysPath tmp/ganache-keys.json --chain.chainId 1337`
- Bootstrap: `npm run bootstrap`
- Copy `tmp/deployed-addresses.json`, `tmp/bootstrap-config.json`, `tmp/ganache-keys.json`, `iot/abis/` to the Pi.

2) PGH on Pi
- Edit `iot/pi/.env` with RPC_URL and addresses from `tmp/deployed-addresses.json`; set `PRIMARY_HEAD_KEY` (and `ADMIN_KEY` if desired); optionally set `DEFAULT_OBJECT_ADDRESS` to a Role.NONE address from `tmp/ganache-keys.json`.
- Start: `npm --prefix iot/pi start`
- Register the object (ensure factory check passes):
  ```bash
  curl -X POST http://localhost:8080/register-device \
    -H 'Content-Type: application/json' \
    -d '{"deviceAddress":"<DEFAULT_OBJECT_ADDRESS>","name":"object","memberType":"type1"}'
  ```

3) ESP API (optional, for IoT ingestion)
- Env:
  ```
  export PGH_API_BASE=http://<pgh-ip>:8080
  export PGH_OBJECT_ADDRESS=<object from deployed-addresses.json or DEFAULT_OBJECT_ADDRESS>
  export PGH_ACC_TYPE=sensor
  ```
- Run: `python esp_api_project/esp_api_2waycomm.py`

4) Scripts you can run
- Full chain sim (all contracts, on-chain txs): `node iot/pi/scripts/full-chain-sim.js`
- Collector (gateway flow, off-chain eval): `iot/pi/scripts/run-collector-auto.sh`
- Attack scenarios (too-frequent, tamper): `iot/pi/scripts/run-attack-scenarios.sh`
- ESP access demo (same-PGH + peer): `esp_api_project/scripts/demo-esp-access.sh`
- One-shot on-Pi (registers, deploys ACC, adds policies, runs access txs; no PGH endpoints required): `node iot/pi/scripts/run-all-on-pi.js`

5) Dashboard (optional)
- `cd esp32-dashboard && npm install && npm run dev`
- If needed, `VITE_API_BASE_URL=http://<esp-api-ip>:5000` before `npm run dev`.
- PGH / Chain tab shows PGH status, metrics, and demo logs; other tabs show devices/logs/alerts.

## What You Get (outputs & data)
- `iot/pi/results/full-sim-<timestamp>.json`: tx hashes/steps for register → deploy ACC → policies → accessControl (allow/too-frequent/tamper), Judge blocking info.
- `iot/pi/results/<timestamp>/`: collector outputs (register/deploy/policies/evals).
- `iot/pi/results/attacks-<timestamp>.json`: attack sim API responses (allow/too-frequent/tamper).
- `iot/pi/results/demo-telemetry/`: per-op JSON logs from the gateway (tx hashes, threats, tokenAdjustment).
- `iot/pi/results/esp-telemetry/`: ESP telemetry payloads (when using `/esp/evaluate` with telemetry).
- PGH `/status`: recentEvents, threat counts, recent token adjustments, balances for tracked accounts.
- PGH `/metrics`: Prometheus counters and histograms (HTTP/tx timings, gas buckets, access decisions).
- Chain events: ACC emits `AccessControlChecked`; Judge emits penalties/rewards. Use tx hashes from the logs/reports to query gas used and timestamps via your RPC.

## Common Pitfalls (and fixes)
- ACC deploy reverts: verify `.env` matches `tmp/deployed-addresses.json`, ensure the object has a role (e.g., register it as type1), and RPC_URL is reachable.
- Role shows UNKNOWN: register the subject via `/register-device` so RoleToken returns a non-NONE role.
- Nonce errors: restart Ganache (fresh chain) and rerun `npm run bootstrap`, then restart PGH.
- Timeouts: ensure Ganache is running and `RPC_URL` points to the correct host:port.

## Notes

- Do **not** rerun `npm run bootstrap` on the Pi unless Ganache is running on that Pi. Bootstrap is done on the laptop where the chain lives.
- If Ganache restarts, rerun `npm run bootstrap` on the laptop and recopy `deployed-addresses.json`/`.env` values to each Pi. Restart gateways afterwards.
