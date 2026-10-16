# PoisonIvy ESP Bridge Scenario

## Scenario ID

- `threat_during_after_poison_ivy_esp_bridge_compromise_01`

## Purpose

This scenario implements a PoisonIvy-style enterprise IoT bridge compromise using the repo's existing ESP bridge and blockchain access-control stack.

It is designed to prove all of the following in one deterministic evaluation path:

- ESP-facing attack surface is exercised through the bridge APIs
- blockchain access control remains the enforcement layer
- access decisions and policy changes are real on-chain transactions
- recovery is also real on-chain governance / contract state change
- results land in the same CSV outputs as the other thesis scenarios

This is not a real hardware exploit and not the Windows PoisonIvy RAT. It is a controller-trust-abuse emulation using the bridge, the copied ESP database snapshot, PGH, and the existing contracts.

## Non-Negotiable Constraints

The implementation preserves these constraints:

- no changes to the original `esp_api_project/esp_data.db`
- the original database is only used as the source snapshot
- blockchain interaction is real, not mocked
- logging still goes through `describeTx()` and `logAction()`
- output still lands in:
  - `results/gas_tx_level.csv`
  - `results/gas_action_level.csv`
  - `results/scenario_summary.csv`
  - `results/scenario_summary.json`
  - `results/run_manifest.json`

## Files Changed

### Scenario definition

- `eval/scenario_library.js`

### Runner support

- `eval/runner.js`

### ESP bridge sandboxing

- `esp_api_project/esp_api_2waycomm.py`

### Logical operation map

- `eval/op_mapping.json`

## High-Level Architecture

The scenario uses this split:

- attack surface: ESP bridge + copied ESP DB snapshot
- blockchain enforcement: PGH + `AccessControlContract` + `JudgeContract` + role / register contracts
- evidence collection: bridge `chain_actions` + runner `describeTx()` + standard gas logger

That means the runner does not invent tx hashes. It harvests the hashes emitted by the bridge after the bridge talks to PGH.

## How The Runner Preserves The Original ESP Database

The runner now launches a temporary ESP bridge sandbox for ESP-backed scenarios.

Flow:

1. Read source DB:
   - `esp_api_project/esp_data.db`
2. Create a scenario sandbox directory:
   - `tmp/esp_eval/<run_id>/<scenario_id>-<iteration>/`
3. Copy the DB to:
   - `tmp/esp_eval/<run_id>/<scenario_id>-<iteration>/esp_data.db`
4. Start `esp_api_project/esp_api_2waycomm.py` with:
   - `ESP_DB_FILE=<sandbox-copy>`
   - `ESP_API_HOST=127.0.0.1`
   - `ESP_API_PORT=<ephemeral-port>`
   - `PGH_API_BASE=<your-running-pgh-a>`
   - `PGH_OBJECT_ADDRESS=<eval object address>`
   - `PGH_DB_OBJECT_ADDRESS=<same object address>`
   - `RPC_URL=<your chain>`
   - `GANACHE_KEYS_PATH=tmp/ganache-keys.json`
   - `ALLOW_OFFLINE_IDENTITY=0`
5. Run the scenario against the sandbox bridge only
6. Shut the bridge down after the scenario

Result:

- original DB remains untouched
- copied DB is mutated during the emulation
- bridge log is written inside the sandbox directory

## Exact Blockchain-Level Scenario Flow

The scenario now follows this logical flow.

### Step 1. ESP Telemetry Bootstrap

Operation labels:

- `ESP Telemetry Bootstrap`
- `ESP Telemetry Bootstrap`

Endpoint:

- `POST /data`

Targets:

- compromised ESP MAC
- target ESP MAC

Purpose:

- refresh both devices in the copied ESP DB
- ensure each device has a blockchain identity if missing
- ensure each device has an ACC if missing
- ensure default policies exist if missing

Expected blockchain interactions:

- `/register-device`
- `/deploy-contract`
- `/policies`

Expected outputs:

- tx rows for register / deploy / policy adds
- action row for each bootstrap call
- scenario summary accumulation

### Step 2. Benign Self Access

Operation label:

- `ESP Status Access without Misbehavior`

Endpoint:

- `GET /status/<compromised_mac>`

Purpose:

- establish a clean baseline
- prove the compromised identity can perform legitimate self-access
- trigger real blockchain access evaluation through the bridge path

Expected blockchain interaction:

- `AccessControlContract.accessControl(resource, action)`

Expected result:

- allowed

Implementation note:

- the evaluation runner advances local Ganache time past any active Judge block before this validation step
- this preserves the intended narrative:
  - denied burst first
  - malicious blockchain policy insertion second
  - successful post-abuse access third
- the action log records this as `chain_time_advanced_seconds=<n>`

### Step 3. Unauthorized Lateral Status Access

Operation label:

- `ESP Status Access with Misbehavior`

Endpoint:

- `GET /status/<target_mac>`

Purpose:

- attempt unauthorized lateral status read
- prove blockchain access control denies before approval abuse

Expected blockchain interaction:

- `AccessControlContract.accessControl(target_status_resource, view)`
- optional `JudgeContract` activity if triggered by the threat model

Expected result:

- denied

### Step 4. Unauthorized Temperature Access

Operation label:

- `ESP Temps Access with Misbehavior`

Endpoint:

- `GET /temps/<target_mac>`

Purpose:

- attempt unauthorized lateral temperature read
- generate another blockchain-backed denied access decision before the burst phase

Expected blockchain interaction:

- `AccessControlContract.accessControl(target_temps_resource, view)`
- optional `JudgeContract` activity if triggered

Expected result:

- denied

### Step 5. Repeated Malicious Burst

Operation label:

- `ESP Repeated Access Burst with Misbehavior`

Endpoint pattern:

- alternating `GET /status/<target_mac>` and `GET /temps/<target_mac>`

Current configuration:

- `attemptCount = 16`
- pattern = `status -> temps -> status -> temps ...`

Purpose:

- generate >15 denied requests before approval abuse
- preserve threat-model counters before any successful access can reset them
- create DoS-like evidence using the real ESP bridge -> PGH -> contract path

Expected blockchain interaction:

- repeated `AccessControlContract.accessControl(...)`
- possible `JudgeContract` response transactions harvested from the chain

Expected result:

- denied requests dominate the burst
- threat codes such as `TOO_MANY_ACCESS_ATTEMPTS` and `DISRUPTION_OF_SERVICE` may appear depending on runtime state

### Step 6. ESP Local Approval Abuse

Operation label:

- `ESP Local Approval Abuse`

Endpoint:

- `POST /approve-access`

Purpose:

- simulate a compromised controller-side integration component
- abuse localhost-only approval capability
- force blockchain allow policies for the compromised subject against the target resources

Expected blockchain interaction:

- bridge `grant_access_policy()`
- PGH `/policies`
- on-chain `AccessControlContract.policyAdd(...)`

Expected result:

- allow policies created on-chain

### Step 7. Post-Abuse Successful Access

Operation label:

- `ESP Status Access after Approval Abuse`

Endpoint:

- `GET /status/<target_mac>`

Purpose:

- retry the same lateral access path after malicious approval abuse
- prove blockchain policy state has changed

Expected blockchain interaction:

- `AccessControlContract.accessControl(target_status_resource, view)`

Expected result:

- allowed

### Step 8. Recovery — Mark Malicious

Operation label:

- `Role Status Update`

Purpose:

- mark the compromised blockchain identity as `MALICIOUS`

Expected blockchain interaction:

- role status update transaction

Expected result:

- subject status changed to `MALICIOUS`

### Step 9. Recovery — Penalize

Operation label:

- `Role Penalize`

Purpose:

- apply governance-level punishment to the compromised identity

Expected blockchain interaction:

- `RoleBasedAccessControl.penalizeMember(...)`

Expected result:

- subject penalized

### Step 10. Recovery — Deactivate Access Contract

Operation label:

- `Access Contract Deactivate`

Purpose:

- technically shut down the compromised subject's ACC path
- prevent existing policy grants from continuing to operate

Expected blockchain interaction:

- `AccessControlContract.deactivateContract()`

Expected result:

- ACC deactivated

### Step 11. Recovery — Revoke Role

Operation label:

- `Role Revoke`

Purpose:

- remove the compromised role assignment
- clean up the governance layer

Expected blockchain interaction:

- `RoleBasedAccessControl.revokeRole(...)`

Expected result:

- role removed

### Step 12. Final Validation Attempt

Operation label:

- `ESP Status Access after Recovery`

Endpoint:

- `GET /status/<target_mac>`

Purpose:

- retry the same lateral path after recovery
- prove recovery controls are effective

Expected blockchain interaction:

- `AccessControlContract.accessControl(target_status_resource, view)`
- optional `JudgeContract` tx if threat response fires again

Expected result:

- denied

## How Blockchain Interaction Is Captured

### Through `POST /data`

The bridge may trigger:

- `POST /register-device`
- `POST /deploy-contract`
- `POST /policies`

Each bridge-side action is written to `chain_actions` with any returned `tx_hash`.

### Through `GET /status/<mac>` and `GET /temps/<mac>`

The bridge calls `log_access_decision()`, which sends:

- `POST /evaluate-access`
- with `logOnChain: true`

PGH then runs real on-chain access evaluation in `iot/pi/primary_head.js`.

### Through `POST /approve-access`

The bridge calls `grant_access_policy()`, which sends:

- `POST /policies`

This changes real blockchain access-control state.

## How The Runner Produces Standard CSV Results

The runner uses the same pattern as the rest of the evaluation framework.

For each ESP-backed action:

1. record the current `/chain/actions` marker id
2. record the current chain block number
3. call the ESP bridge endpoint
4. fetch new `chain_actions` rows
5. extract any `tx_hash` values from those rows
6. call `describeTx()` for each tx hash
7. scan surrounding blocks for extra `JudgeContract` txs
8. append threat codes found in `response_json.pgh.threats`
9. pass all tx details into `logAction()`

This means the schema stays unchanged.

## Detailed Logging Improvements Implemented

The refined implementation now adds:

- dedicated logical labels for:
  - `ESP Temps Access with Misbehavior`
  - `ESP Repeated Access Burst with Misbehavior`
  - `ESP Status Access after Approval Abuse`
  - `ESP Status Access after Recovery`
- threat-code extraction from bridge `chain_actions.response_json`
- automatic capture of extra `JudgeContract` txs around ESP access-control evaluations
- explicit notes including:
  - response sequence
  - chain action summaries
  - threat codes
  - extra judge tx counts
  - sandbox DB path for bootstrap

## Supported Supplemental ESP Operations

The runner still supports these additional ESP logical operations if you want to build variants later:

- `ESP Device Enumeration`
- `ESP Data Spoofing`
- `ESP Temps Access without Misbehavior`

They are not part of the canonical 12-step PoisonIvy thesis scenario now, but the code remains available.

## How To Run The Emulation

### Prerequisites

You need all of these running or available first:

1. a local chain
2. deployed thesis contracts
3. `tmp/deployed-addresses.json`
4. `tmp/ganache-keys.json`
5. PGH A running and reachable
6. `iot/pi/.env` pointed at the same chain and deployed addresses

### Recommended local startup sequence

From repo root:

1. Start Ganache:

```bash
npx ganache --wallet.totalAccounts 25 --wallet.accountKeysPath tmp/ganache-keys.json --chain.chainId 1337 --server.host 127.0.0.1 --server.port 8545
```

2. Bootstrap contracts:

```bash
node eval/bootstrap_local_chain.js
```

3. Start PGH A:

```bash
npm --prefix iot/pi install
export RPC_URL=http://127.0.0.1:8545
export ROLE_TOKEN_ADDRESS=$(python3 - <<'PY'
import json
print(json.load(open('tmp/deployed-addresses.json'))['addresses']['roleToken'])
PY
)
export ROLE_BASED_ADDRESS=$(python3 - <<'PY'
import json
print(json.load(open('tmp/deployed-addresses.json'))['addresses']['roleBasedAccessControl'])
PY
)
export REGISTER_ADDRESS=$(python3 - <<'PY'
import json
print(json.load(open('tmp/deployed-addresses.json'))['addresses']['registerContract'])
PY
)
export JUDGE_ADDRESS=$(python3 - <<'PY'
import json
print(json.load(open('tmp/deployed-addresses.json'))['addresses']['judgeContract'])
PY
)
export ACCESS_FACTORY_ADDRESS=$(python3 - <<'PY'
import json
print(json.load(open('tmp/deployed-addresses.json'))['addresses']['accessControlFactory'])
PY
)
export PRIMARY_HEAD_KEY=$(python3 - <<'PY'
import json
keys=json.load(open('tmp/ganache-keys.json'))['private_keys']
print(next(iter(keys.values())))
PY
)
export ADMIN_KEY="$PRIMARY_HEAD_KEY"
export PORT=8080
npm --prefix iot/pi start
```

4. Confirm PGH A is up:

```bash
curl http://127.0.0.1:8080/status
```

### Run only the PoisonIvy scenario

```bash
RPC_URL=http://127.0.0.1:8545 \
PGH_API_BASE=http://127.0.0.1:8080 \
EVAL_SCENARIO_IDS=threat_during_after_poison_ivy_esp_bridge_compromise_01 \
EVAL_DISABLE_RANDOM_FILL=1 \
./scripts/run_eval.sh
```

### Pin the compromised and target MACs explicitly

Use this if you want deterministic actor selection from the source DB:

```bash
RPC_URL=http://127.0.0.1:8545 \
PGH_API_BASE=http://127.0.0.1:8080 \
EVAL_SCENARIO_IDS=threat_during_after_poison_ivy_esp_bridge_compromise_01 \
EVAL_DISABLE_RANDOM_FILL=1 \
EVAL_ESP_REQUESTOR_MAC=A0:DD:6C:B2:4F:58 \
EVAL_ESP_TARGET_MAC=44:1D:64:F7:6B:3C \
./scripts/run_eval.sh
```

### Useful optional knobs

```bash
EVAL_ESP_PORT_BASE=5100
EVAL_ESP_STARTUP_TIMEOUT_MS=20000
EVAL_ESP_CHAIN_ACTION_LIMIT=250
EVAL_ESP_ACTION_SETTLE_MS=125
EVAL_ESP_REFRESH_TEMP_DELTA=0.2
EVAL_ESP_REFRESH_HUMIDITY_DELTA=0.2
```

## Where To Inspect Results

### Main evaluation outputs

- `results/gas_tx_level.csv`
- `results/gas_action_level.csv`
- `results/scenario_summary.csv`
- `results/scenario_summary.json`
- `results/run_manifest.json`

### ESP sandbox artifacts

For each run, inspect:

- `tmp/esp_eval/<run_id>/<scenario_id>-<iteration>/esp_data.db`
- `tmp/esp_eval/<run_id>/<scenario_id>-<iteration>/esp_bridge.log`

These let you inspect the copied DB state and the bridge log without touching the original DB.

## Validation Performed

Validated locally:

- `node --check eval/runner.js`
- `python3 -m py_compile esp_api_project/esp_api_2waycomm.py`
- JSON validation for `eval/op_mapping.json`
- scenario library lookup for the PoisonIvy scenario id
- sandbox ESP bridge boot against a copied DB
- successful `/devices` response from the sandbox bridge

Not validated in-session:

- full live end-to-end run against a reachable PGH + chain stack

Reason:

- PGH A was not reachable on `http://127.0.0.1:8080` during the previous live-check attempt

## Bottom Line

The scenario now gives you a thesis-grade PoisonIvy-style emulation that:

- uses real ESP bridge endpoints
- uses real blockchain access-control evaluation
- captures policy abuse as real on-chain state change
- captures recovery as real on-chain containment
- keeps the original ESP database untouched
- emits detailed tx/action/scenario logs through the same evaluation pipeline as the rest of the repo
