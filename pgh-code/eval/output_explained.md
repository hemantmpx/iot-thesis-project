# Evaluation Output Explained (Current Version)

This document explains the outputs produced by the thesis evaluation runner in plain language.

It is intentionally explicit so you can use it directly for thesis methodology and appendix text.

---

## What changed in this version

This version intentionally keeps **only two derived timing metrics** for analysis:

1. `communication_back_and_forth_ms`  
2. `blockchain_processing_ms`

All other derived latency metrics were removed from CSV outputs to keep timing interpretation focused and unambiguous.

---

## Output files

Each run writes these files under `results/`, then copies them into a snapshot folder:

- `gas_tx_level.csv` — one row per blockchain transaction.
- `gas_action_level.csv` — one row per logical action (sum/summary of tx rows in that action).
- `scenario_summary.csv` and `scenario_summary.json` — one row/object per scenario execution.
- `run_manifest.json` — run metadata and execution health.

---

## Core interpretation model

Think in three layers:

1. **Transaction layer**: exact on-chain facts (`gas_used`, `status`, `tx_hash`, etc.).
2. **Action layer**: logical operation totals (`tx_count`, `total_gas_used`, `outcome`, etc.).
3. **Scenario layer**: full narrative totals (all actions in one scenario id).

The join key between tx and action layers is `action_instance_id`.

---

## Timing model (only two metrics)

### 1) `blockchain_processing_ms`

**Meaning:** how long the blockchain part took for the action.

**Computation:**
- `blockchain_processing_ms = blockchain_mined_utc - blockchain_submit_utc`
- If there is no blockchain submission for the action, this is blank/zero-like depending on context.

**Interpretation:**
- High values mean chain confirmation/mining is the dominant bottleneck.
- This metric is your clean on-chain processing latency.

### 2) `communication_back_and_forth_ms`

**Meaning:** total non-blockchain communication/coordination time visible to the action.

**Computation:**
- First compute end-to-end action interval:  
  `end_to_end = response_returned_utc - request_sent_utc`
- Then remove chain time:  
  `communication_back_and_forth_ms = max(0, end_to_end - blockchain_processing_ms)`
- If chain timestamps are absent but HTTP timing exists, HTTP timing is used as fallback.

**Interpretation:**
- This is the off-chain + messaging + request/response overhead portion.
- In federated mode this includes PGH-to-PGH + API back-and-forth components.

---

## Outcome semantics (important for threat scenarios)

- `success`: operation path completed successfully.
- `allowed`: access-control decision was allow.
- `approved`: table-access request approval path completed.
- `denied`: operation was blocked/rejected (often expected in malicious scenarios).
- `penalized`: malicious path triggered penalty/judge-oriented handling path.
- `partial`: operation started but did not complete full intended chain.
- `failed`: execution failure (runtime/operation error), not expected behavior.

**Key point:** In threat scenarios, many `denied` rows are valid and expected.  
`failed` is the value that indicates runner/operation failure.

---

## File-by-file metric definitions

---

# 1) `gas_tx_level.csv` (transaction-level)

One row = one blockchain transaction.

## Identity and grouping

### `timestamp_utc`
UTC time when this row was logged.

### `run_id`
Unique id for the whole evaluation run.

### `scenario_id`
Scenario template id (e.g., `threat_tampering_01`).

### `scenario_group`
Scenario group (`normal`, `timing`, `threat`).

### `iteration`
Scenario iteration number within run.

### `mode`
Execution mode (`pgh_blockchain` or `pgh_pgh`).

### `logical_operation`
Logical action label this tx belongs to.

### `behavior`
`benign` or `malicious` tag for the parent action.

### `action_instance_id`
Unique id of the parent action instance.

### `correlation_id`
Correlation id for tracing (aligned with action instance).

## Communication context

### `request_method`
Method used in parent flow (`POST`, `RPC`, etc.).

### `endpoint_route`
Endpoint/route label used by parent flow.

### `source_actor`
Initiating actor address/context.

### `destination_actor`
Target actor/contract context.

### `source_pgh`
Logical source PGH label.

### `destination_pgh`
Logical destination PGH label.

## Timestamps used for timing decomposition

### `request_sent_utc`
When request was sent.

### `request_received_utc`
When response-side receive/return point was captured.

### `pgh_forward_start_utc`
PGH forwarding start timestamp (federated path).

### `pgh_forward_end_utc`
PGH forwarding end timestamp.

### `blockchain_submit_utc`
When blockchain submission started.

### `blockchain_mined_utc`
When blockchain confirmation/mining was observed.

### `response_returned_utc`
When final response returned to caller.

## The two timing metrics

### `communication_back_and_forth_ms`
Total off-chain communication/coordination time for this tx context.

### `blockchain_processing_ms`
Chain processing interval for this tx context.

## Transaction internals (gas/cost/finality)

### `tx_index`
Order of tx inside its parent action (`1..N`).

### `contract_name`
Decoded destination contract name.

### `function_name`
Decoded function name.

### `from_account`
Tx sender address.

### `to_contract`
Destination contract address.

### `tx_hash`
Transaction hash.

### `block_number`
Block number containing tx.

### `gas_used`
Actual gas consumed (from receipt).

### `gas_limit`
Gas limit set on tx.

### `effective_gas_price`
Per-gas price used for final fee.

### `fee_paid_wei`
`gas_used * effective_gas_price`.

### `status`
EVM tx status (`1` success, `0` reverted/failed).

### `revert_reason`
Revert reason text if available.

### `out_of_gas`
`1` if classified as out-of-gas; else `0`.

### `zero_gas_reason`
Reason text when no gas was consumed / no tx path.

## Human trace context

### `notes`
Narrative explanation for why this tx occurred.

### `scenario_start_utc`
Scenario start timestamp.

### `scenario_end_utc`
Scenario end timestamp.

### `action_start_utc`
Parent action start timestamp.

### `action_end_utc`
Parent action end timestamp.

### `action_duration_ms`
Action wall-clock duration.

### `tx_sent_utc`
Tx send timestamp.

### `tx_mined_utc`
Tx mined timestamp.

---

# 2) `gas_action_level.csv` (logical-action level)

One row = one logical action instance.

## Identity and context

These fields mirror tx-level semantics:

- `timestamp_utc`
- `run_id`
- `scenario_id`
- `scenario_group`
- `iteration`
- `mode`
- `logical_operation`
- `behavior`
- `action_instance_id`
- `correlation_id`
- `request_method`
- `endpoint_route`
- `source_actor`
- `destination_actor`
- `source_pgh`
- `destination_pgh`

## Action totals

### `tx_count`
Number of tx rows in this action.

### `total_gas_used`
Sum of `gas_used` for all tx in this action.

### `total_fee_paid_wei`
Sum of `fee_paid_wei` for all tx in this action.

## Result and coverage

### `outcome`
Action result class (`success`, `denied`, `penalized`, etc.).

### `outcome_reason`
Reason text explaining why that outcome was assigned.

### `involved_contracts`
Comma-separated set of contracts touched by action txs.

### `involved_functions`
Comma-separated set of functions touched by action txs.

### `measured_as`
How action was measured (`onchain_tx`, `no_onchain_tx`, etc.).

### `out_of_gas_count`
Count of out-of-gas tx inside this action.

### `zero_gas_reason`
Explanation when `tx_count=0` and gas is zero.

## Timing anchors

### `request_sent_utc`
Action request send time.

### `request_received_utc`
Action request receive/return time.

### `pgh_forward_start_utc`
Federated forward start.

### `pgh_forward_end_utc`
Federated forward end.

### `blockchain_submit_utc`
Action chain submit anchor.

### `blockchain_mined_utc`
Action chain mined anchor.

### `response_returned_utc`
Action response return anchor.

## The two timing metrics

### `communication_back_and_forth_ms`
Action-level off-chain communication + coordination time.

### `blockchain_processing_ms`
Action-level chain processing interval.

## Additional context

### `scenario_start_utc`
Scenario start for this action's scenario.

### `scenario_end_utc`
Scenario end timestamp observed when row was logged.

### `total_scenario_elapsed_ms`
Scenario elapsed time at that point.

### `notes`
Detailed narrative for thesis interpretation.

### `action_start_utc`
Action start timestamp.

### `action_end_utc`
Action end timestamp.

### `action_duration_ms`
Wall-clock action duration.

---

# 3) `scenario_summary.csv` / `scenario_summary.json` (scenario-level)

One row/object = one scenario execution.

### `timestamp_utc`
Row write time.

### `run_id`
Run id.

### `scenario_id`
Scenario identifier.

### `scenario_group`
Scenario category.

### `iteration`
Scenario iteration index.

### `mode`
Execution mode.

### `scenario_start_utc`
Scenario start time.

### `scenario_end_utc`
Scenario end time.

### `total_scenario_elapsed_ms`
Total wall-clock elapsed for scenario.

### `total_actions`
Number of action rows in scenario.

### `total_txs`
Number of tx rows in scenario.

### `total_gas`
Sum of action-level gas totals in scenario.

### `total_fee`
Sum of action-level fee totals in scenario.

### `total_communication_back_and_forth_ms`
Sum of action-level communication metric across scenario.

### `total_blockchain_processing_ms`
Sum of action-level blockchain processing metric across scenario.

### `involved_contracts`
Union of contracts touched in scenario.

### `involved_functions`
Union of functions touched in scenario.

### `pghs_involved`
Distinct PGHs involved in scenario.

### `whether_cross_pgh`
`1` if scenario involves cross-PGH flow; else `0`.

### `whether_judge_triggered`
`1` if Judge contract appears in involved contracts; else `0`.

### `whether_table_access_used`
`1` if table-access operations were involved.

### `whether_multi_tx`
`1` if any action had more than one tx.

### `overall_outcome`
Scenario-level synthesized outcome.

### `narrative_summary`
Auto-generated plain-language summary.

---

# 4) `run_manifest.json` (run metadata)

This is the execution metadata and health report for the whole run.

## Identity and environment

### `run_id`
Unique run identifier.

### `started_at`, `ended_at`
Run start/end UTC timestamps.

### `git_commit`
Commit hash (if detectable).

### `rpc_url`
RPC endpoint used.

### `chain_id`
Chain id used.

### `block_range.start`, `block_range.end`
Observed min/max block numbers touched in run.

## Run scope

### `scenarios_generated`
How many scenario executions completed.

### `iterations_per_scenario`
Iteration metadata.

### `malicious_rate`
Configured malicious ratio knob (relevant when random fill is used).

### `knobs`
Full run config knobs used (selection, repeat, mode settings, delays, etc.).

## Coverage and health

### `logical_operation_counts`
Counts per logical operation, including benign/malicious and mode splits.

### `failures`
Runner-level failures list. Empty means no recorded run-level failures.

### `mode_b_status`
Whether federated mode was enabled and reachable.

### `scenario_execution_plan`
Exact ordered scenario plan executed.

### `scenario_summary_file`
Scenario summary output file name.

### `total_operations`
Total action rows written in run.

---

## Threat-scenario interpretation guidance

For threat scenarios, frequent `denied` outcomes are usually **correct behavior** (system blocked malicious requests).

Use this quick logic:

- If `run_manifest.failures` is empty and `failed` outcomes are zero, the run is operationally healthy.
- `denied` + `penalized` are behavioral outcomes, not necessarily execution failures.
- `status=0` tx means on-chain revert path happened and was captured as data.

---

## Why the two timing metrics are enough

The two-metric model cleanly separates latency into:

1. **Communication overhead** (`communication_back_and_forth_ms`)  
   Everything off-chain/request-response/federation around chain submission.

2. **On-chain processing overhead** (`blockchain_processing_ms`)  
   Transaction confirmation interval.

This gives a direct decomposition for thesis plots/tables without over-fragmenting timing interpretation.

---

## Practical analysis workflow

1. Filter by `run_id` first.  
2. Use `gas_action_level.csv` for operation-level comparison.  
3. Use `gas_tx_level.csv` for exact per-function gas evidence.  
4. Use `scenario_summary.csv` for scenario narrative totals.  
5. Use `run_manifest.json` to confirm environment/selection/reproducibility.

---

## Quick formulas (reference)

- `fee_paid_wei = gas_used * effective_gas_price`
- `total_gas_used (action) = sum(gas_used over tx rows in action)`
- `total_fee_paid_wei (action) = sum(fee_paid_wei over tx rows in action)`
- `blockchain_processing_ms = blockchain_mined - blockchain_submit`
- `communication_back_and_forth_ms = max(0, (response_returned - request_sent) - blockchain_processing_ms)`

---

If needed, a second companion file can be generated for a specific `run_id` with row-by-row examples mapped to these definitions.
