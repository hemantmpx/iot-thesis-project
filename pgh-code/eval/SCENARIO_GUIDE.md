# Thesis Scenario-Centric Evaluation Guide

## 1) Architecture (preserved)

- Main orchestrator: `eval/runner.js`
- Scenario templates: `eval/scenario_library.js`
- Operation mapping: `eval/op_mapping.json`
- CSV logger: `eval/gas_logger.js`
- Existing PGH endpoints reused:
  - `POST /register-device`
  - `POST /deploy-contract`
  - `POST /policies`
  - `POST /evaluate-access`
  - `GET /status`

No re-architecture was introduced; the runner still drives existing PGH + contract flows.

## 2) Added smart-contract call coverage

The previous revision focused mainly on:
- role assignment
- policy add
- access evaluation
- TAC request/view paths

This revision adds direct coverage for additional relevant on-chain write paths:

- `AccessControlContract`
  - `policyUpdate`
  - `policyDelete`
  - `setJudgeContract`
  - `deactivateContract`
  - `activateContract`

- `RoleBasedAccessControl`
  - `swapRole`
  - `revokeRole`
  - `updateMemberStatus`
  - `penalizeMember`
  - `rewardMember`

- `RegisterContract`
  - `setJudgeContractAddress`

- `TableAccessControlContract`
  - `editLocalResourceTable`
  - `editGlobalResourceTable`
  - `deleteLocalResourceTable`
  - `deleteGlobalResourceTable`
  - `policyUpdate`
  - `policyDelete`

These calls are logged in the same tx-level/action-level schema with timing decomposition.

## 3) Scenario IDs

### Normal
- `normal_rich_federated_success_01` (cross-PGH canonical benign path)
- `normal_rich_federated_success_02` (expanded local contract-surface coverage)

### Timing
- `timing_breakdown_cross_pgh_01`
- `timing_breakdown_multi_call_01` (now includes policy lifecycle + access-contract lifecycle)

### Threat
- `threat_privilege_escalation_01` (expanded with registry/role/access-contract abuse attempts)
- `threat_unauthorized_access_01`
- `threat_tampering_01` (expanded with malicious policy/table mutation attempts)
- `threat_too_frequent_access_01`
- `threat_dos_like_pattern_01`
- `threat_during_after_privilege_escalation_01`
- `threat_during_after_unauthorized_access_01`
- `threat_during_after_tampering_01`
- `threat_during_after_too_frequent_access_01`
- `threat_during_after_poison_ivy_esp_bridge_compromise_01`

### Scalability
- `scalability_grt_request_scaling_05_01`
- `scalability_grt_request_scaling_15_01`
- `scalability_grt_request_scaling_45_01`

## 4) Mandatory operations preserved

The required thesis labels remain unchanged and are still emitted exactly:
- `Policy Add`
- `Access Control without Misbehavior`
- `Access Control with Misbehavior`
- `Role Assignment`
- `Create Table Access Request`
- `Create Table Access Request with Misbehavior`
- `View Local Resource Table`
- `View Global Resource Table`

## 5) Timing and correlation fields

### `gas_tx_level.csv`
- Correlation/network fields: `scenario_id`, `scenario_group`, `scenario_stage`, `action_instance_id`, `correlation_id`, `endpoint_route`, `request_method`, `source_actor`, `destination_actor`, `source_pgh`, `destination_pgh`
- Timestamps:
  - `request_sent_utc`
  - `request_received_utc`
  - `pgh_forward_start_utc`
  - `pgh_forward_end_utc`
  - `blockchain_submit_utc`
  - `blockchain_mined_utc`
  - `response_returned_utc`
  - `tx_sent_utc`
  - `tx_mined_utc`
- Derived timings actually emitted by the current runner:
  - `communication_back_and_forth_ms`
  - `blockchain_processing_ms`

### `gas_action_level.csv`
- Includes per-action totals, `scenario_stage`, outcomes, zero-gas reasoning, and the same two timing metrics.

### `scenario_summary.csv` / `scenario_summary.json`
- Per-scenario aggregate gas, fee, tx count, timing totals, contract/function coverage, and outcome flags.

## 6) Execution controls

- `EVAL_SCENARIO_IDS=id1,id2,...`
- `EVAL_SCENARIO_GROUP=normal|timing|threat|scalability`
- `EVAL_SCENARIO_REPEAT=N`
- `EVAL_DISABLE_RANDOM_FILL=1`
- `EVAL_ONLY_MODE_B=1`
- `EVAL_INCLUDE_SETUP_IN_SCENARIO=0|1`

## 7) Command examples

Run expanded normal contract coverage once:
```bash
EVAL_SCENARIO_IDS=normal_rich_federated_success_02 EVAL_DISABLE_RANDOM_FILL=1 ./scripts/run_eval.sh
```

Run all threat scenarios, deterministic:
```bash
EVAL_SCENARIO_GROUP=threat EVAL_DISABLE_RANDOM_FILL=1 ./scripts/run_eval.sh
```

Run only the new during/after attack scenarios:
```bash
EVAL_SCENARIO_IDS=threat_during_after_privilege_escalation_01,threat_during_after_unauthorized_access_01,threat_during_after_tampering_01,threat_during_after_too_frequent_access_01,threat_during_after_poison_ivy_esp_bridge_compromise_01 EVAL_DISABLE_RANDOM_FILL=1 ./scripts/run_eval.sh
```

Run the scalability scenarios:
```bash
EVAL_SCENARIO_GROUP=scalability EVAL_DISABLE_RANDOM_FILL=1 ./scripts/run_eval.sh
```

Run one timing scenario repeatedly:
```bash
EVAL_SCENARIO_IDS=timing_breakdown_multi_call_01 EVAL_SCENARIO_REPEAT=10 EVAL_DISABLE_RANDOM_FILL=1 ./scripts/run_eval.sh
```

## 8) ESP-Bridge PoisonIvy Scenario

- The PoisonIvy ESP scenario uses a copied ESP bridge database and an ephemeral Flask bridge sandbox.
- The original `esp_api_project/esp_data.db` is used only as the source snapshot.
- Scenario document: `eval/POISON_IVY_ESP_BRIDGE_SCENARIO.md`
- Optional actor overrides:
  - `EVAL_ESP_REQUESTOR_MAC=<existing-mac-from-source-db>`
  - `EVAL_ESP_TARGET_MAC=<existing-mac-from-source-db>`
