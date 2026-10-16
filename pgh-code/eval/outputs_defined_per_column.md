# Output Columns Defined Per CSV

This document defines every column currently written by the evaluation runner for:

- `gas_action_level.csv`
- `gas_tx_level.csv`

The definitions below match the live schema in [gas_logger.js](/home/mpxhemant/thesis/eval/gas_logger.js).

## Scope

- `gas_action_level.csv` has one row per logical action.
- `gas_tx_level.csv` has one row per on-chain transaction that belongs to an action.
- The safest join key between the two files is `action_instance_id`.
- In the current runner, `correlation_id` is set equal to `action_instance_id`.

## Timing Semantics

These two metrics are the main timing outputs used across both files:

- `blockchain_processing_ms`
  Formula: `blockchain_mined_utc - blockchain_submit_utc`
  Meaning: on-chain submit-to-mined delay.

- `communication_back_and_forth_ms`
  Formula: `max(0, (response_returned_utc - request_sent_utc) - blockchain_processing_ms)`
  Meaning: off-chain time visible in the measured path after subtracting chain wait.
  This is not pure packet latency. It can include client-side wait, PGH processing, forwarding, and coordination overhead outside the chain-confirm interval.

Important blank-value rule:

- A timestamp field may be blank when that step did not exist in the executed path.
- `pgh_forward_start_utc` and `pgh_forward_end_utc` are usually blank for non-federated local paths.
- `zero_gas_reason` is only meaningful for action rows with no on-chain transaction.

## `gas_action_level.csv`

One row = one logical action, possibly backed by zero, one, or many transactions.

| Column | Meaning | Typical values / notes |
| --- | --- | --- |
| `timestamp_utc` | UTC time when the action row was written to the CSV. | ISO-8601 timestamp. |
| `run_id` | Unique identifier for the evaluation run that produced the row. | Same across all rows from one runner execution. |
| `scenario_id` | Exact scenario identifier from the scenario library. | Example: `threat_during_after_privilege_escalation_01`. |
| `scenario_group` | Higher-level scenario family. | Common values: `normal`, `threat`, `timing`, `scalability`. |
| `iteration` | Scenario execution index within the run. | Zero-based integer stored as CSV text. |
| `mode` | Execution topology used for the action. | `pgh_blockchain` or `pgh_pgh`. |
| `logical_operation` | Human-readable label for the logical action. | Example: `Role Assignment`, `Create Table Access Request`. |
| `scenario_stage` | Stage label inside the scenario flow. | Example: `attack_setup`, `during_attack`, `post_attack_recovery`, `scalability_measurement`. |
| `behavior` | Security label for the action. | `benign` or `malicious`. |
| `action_instance_id` | Unique identifier for this action row. | Best key for joining action rows to tx rows. |
| `correlation_id` | Trace correlation key for the action. | In the current runner this is the same value as `action_instance_id`. |
| `request_method` | Transport or invocation method used by the parent flow. | Often `POST` for PGH API calls or a direct/internal label for contract paths. |
| `endpoint_route` | Endpoint or direct-call label associated with the action. | Example: `/register-device`, `direct.createAccessRequest`. |
| `source_actor` | Initiating actor for the action. | Often an address, role-holder address, or initiating service context. |
| `destination_actor` | Intended target actor or contract for the action. | Often a contract address, subject address, or target resource context. |
| `source_pgh` | Logical source PGH label for the action path. | Example: `PGH_A`, `PGH_B`, `PGH_FEDERATED`. |
| `destination_pgh` | Logical destination PGH label for the action path. | Blank only if the path did not need that distinction. |
| `tx_count` | Number of tx rows linked to this action. | `0` means the action had no on-chain transaction. |
| `total_gas_used` | Sum of `gas_used` across all tx rows in the action. | Stored in gas units. |
| `total_fee_paid_wei` | Sum of `fee_paid_wei` across all tx rows in the action. | Stored in wei. |
| `outcome` | Final action result class assigned by the runner. | Examples: `success`, `denied`, `approved`, `partial`, `penalized`, `failed`. |
| `outcome_reason` | Short explanation for why `outcome` was assigned. | Good for thesis interpretation; do not treat as a strict enum. |
| `involved_contracts` | Comma-separated set of contracts touched by this action's txs. | Deduplicated at action level. |
| `involved_functions` | Comma-separated set of functions touched by this action's txs. | Deduplicated at action level. |
| `measured_as` | Declares whether the action was measured via on-chain execution or as a no-tx path. | Current runner uses `onchain_tx` or `no_onchain_tx`. |
| `out_of_gas_count` | Count of tx rows inside this action that were classified as out-of-gas. | Normally `0` in a healthy run. |
| `judge_event_names` | Comma-separated JudgeContract event names observed across all txs linked to this action. | Typical values: `StatusUpdated`, `Penalized`, `MemberBlocked`, `RewardIssued`. Blank when no Judge event was emitted in this action. |
| `judge_affected_members` | Comma-separated addresses that appeared as the affected member in Judge events for this action. | Usually the subject that triggered the access decision or penalty. |
| `judge_status_updates` | Comma-separated status values emitted by JudgeContract during this action. | Typical values: `SUSPICIOUS`, `MALICIOUS`, `BENIGN`. Blank when no Judge status update occurred. |
| `judge_penalty_event_count` | Number of `Penalized` Judge events emitted during this action. | `0` means no Judge penalty event was emitted for this logical step. |
| `judge_penalty_amount_total` | Sum of penalty-token amounts emitted by JudgeContract for this action. | Blank when no Judge penalty event occurred. Stored in raw token units returned by the contract. |
| `judge_penalty_reasons` | Comma-separated Judge penalty/block reasons observed during this action. | Examples: `Unauthorized access attempt`, `Too frequent access`, `Tampering with data`. |
| `judge_block_event_count` | Number of `MemberBlocked` Judge events emitted during this action. | Useful for seeing whether the step caused an actual temporary block, not just a status change. |
| `judge_latest_blocking_end_utc` | Latest block-until timestamp emitted by JudgeContract for this action. | Blank when no blocking event occurred. |
| `judge_reward_event_count` | Number of `RewardIssued` Judge events emitted during this action. | Usually appears on benign paths if the reward threshold was met. |
| `judge_reward_amount_total` | Sum of reward-token amounts emitted by JudgeContract for this action. | Blank when no reward event occurred. |
| `zero_gas_reason` | Explanation for zero-gas actions. | Set when `tx_count = 0` and `total_gas_used = 0`; otherwise blank. |
| `request_sent_utc` | Time when the action request left the measured caller. | Blank if the action had no request-style boundary. |
| `request_received_utc` | Time when the response-side receive/return point was captured for the action. | Can be derived by the runner when only HTTP latency is available. |
| `pgh_forward_start_utc` | Time when PGH-to-PGH forwarding started. | Usually only populated on federated paths. |
| `pgh_forward_end_utc` | Time when PGH-to-PGH forwarding ended. | Usually only populated on federated paths. |
| `blockchain_submit_utc` | Action-level anchor for chain submission. | Usually the earliest tx send time for the action. |
| `blockchain_mined_utc` | Action-level anchor for chain completion. | Usually the latest tx mined time for the action. |
| `response_returned_utc` | Time when the final action response returned to the measured caller. | Blank if there was no request/response boundary. |
| `communication_back_and_forth_ms` | Off-chain visible time for the action after subtracting chain-confirm time. | Not pure network-only latency. |
| `blockchain_processing_ms` | Action-level submit-to-mined interval. | Derived from `blockchain_submit_utc` and `blockchain_mined_utc`. |
| `scenario_start_utc` | UTC start time of the scenario that contains this action. | Same scenario-level anchor reused across sibling action rows. |
| `scenario_end_utc` | UTC end time of the scenario at the point the row was logged. | Filled from the resolved scenario end anchor. |
| `total_scenario_elapsed_ms` | Wall-clock elapsed time of the full scenario. | Useful for scenario-level aggregation from action rows. |
| `notes` | Free-text narrative describing what happened in the action. | Helpful for thesis writing; not stable for grouping. |
| `action_start_utc` | UTC start time of the action itself. | Action-local wall-clock anchor. |
| `action_end_utc` | UTC end time of the action itself. | Action-local wall-clock end. |
| `action_duration_ms` | Wall-clock duration of the action. | `action_end_utc - action_start_utc` when both exist. |

## `gas_tx_level.csv`

One row = one on-chain transaction that belongs to an action.

| Column | Meaning | Typical values / notes |
| --- | --- | --- |
| `timestamp_utc` | UTC time when the tx row was written to the CSV. | ISO-8601 timestamp. |
| `run_id` | Unique identifier for the evaluation run that produced the row. | Same across all rows from one runner execution. |
| `scenario_id` | Exact scenario identifier from the scenario library. | Same meaning as action-level. |
| `scenario_group` | Higher-level scenario family. | Same meaning as action-level. |
| `iteration` | Scenario execution index within the run. | Zero-based integer stored as CSV text. |
| `mode` | Execution topology used for the parent action. | `pgh_blockchain` or `pgh_pgh`. |
| `logical_operation` | Human-readable label for the parent logical action. | Same label as the linked action row. |
| `scenario_stage` | Stage label inside the scenario flow. | Same label as the linked action row. |
| `behavior` | Security label for the parent action. | `benign` or `malicious`. |
| `action_instance_id` | Identifier of the parent action row. | Primary join key back to `gas_action_level.csv`. |
| `correlation_id` | Trace correlation key for the tx row. | In the current runner this matches `action_instance_id`. |
| `request_method` | Transport or invocation method used by the parent flow. | Copied from the action context. |
| `endpoint_route` | Endpoint or direct-call label associated with the parent flow. | Copied from the action context. |
| `source_actor` | Initiating actor for the parent action. | Copied from the action context. |
| `destination_actor` | Intended target actor or contract for the parent action. | Copied from the action context. |
| `source_pgh` | Logical source PGH label for the parent path. | Copied from the action context. |
| `destination_pgh` | Logical destination PGH label for the parent path. | Copied from the action context. |
| `request_sent_utc` | Request send anchor for the parent action context. | Shared across tx rows of the same action. |
| `request_received_utc` | Request receive/return anchor for the parent action context. | Shared across tx rows of the same action. |
| `pgh_forward_start_utc` | Forward-start anchor for federated paths. | Shared across tx rows of the same action. |
| `pgh_forward_end_utc` | Forward-end anchor for federated paths. | Shared across tx rows of the same action. |
| `blockchain_submit_utc` | Chain submit anchor used for this tx row's timing decomposition. | Usually equal to `tx_sent_utc`. |
| `blockchain_mined_utc` | Chain mined anchor used for this tx row's timing decomposition. | Usually equal to `tx_mined_utc`. |
| `response_returned_utc` | Final response-return anchor for the parent action. | Shared across tx rows of the same action when available. |
| `communication_back_and_forth_ms` | Off-chain visible time attributed to this tx context after subtracting chain-confirm time. | Not pure wire latency. |
| `blockchain_processing_ms` | Tx-context submit-to-mined interval. | Derived from `blockchain_submit_utc` and `blockchain_mined_utc`. |
| `tx_index` | Position of this transaction within the parent action. | Starts at `1` and increases per action. |
| `contract_name` | Decoded destination contract name. | Derived from the destination address registry. |
| `function_name` | Decoded contract function name. | Derived from the tx calldata if decoding succeeds; otherwise `unknown`. |
| `from_account` | Sender address of the transaction. | EOA that signed and submitted the tx. |
| `to_contract` | Destination contract address of the transaction. | Blank only for contract-creation txs. |
| `tx_hash` | Transaction hash. | Unique on-chain identifier for the tx. |
| `block_number` | Block number in which the tx was mined. | Blank if the tx was not mined, which is unusual in current outputs. |
| `gas_used` | Actual gas consumed according to the receipt. | This is how much computational work the transaction really ended up using. Stored in gas units. |
| `gas_limit` | Maximum amount of gas the sender allowed this transaction to consume. | Think of this as a safety cap, not the final amount paid. Stored in gas units. |
| `effective_gas_price` | Final per-gas price used for the fee calculation. | Usually from the receipt. |
| `fee_paid_wei` | Final tx fee in wei. | Computed as `gas_used * effective_gas_price`. |
| `status` | EVM receipt status. | `1` = success, `0` = failed/reverted. |
| `revert_reason` | Revert reason or error text if the runner could recover it. | May contain `missing revert data` when the node cannot decode a reason. |
| `out_of_gas` | Runner classification for out-of-gas. | `1` when `status = 0` and `gas_used >= gas_limit`; otherwise `0`. |
| `judge_event_names` | Comma-separated JudgeContract event names emitted inside this transaction's receipt logs. | Present even when Judge was called internally by another contract rather than via a separate top-level transaction. |
| `judge_affected_members` | Comma-separated affected member addresses decoded from Judge events in this tx. | Usually one address, but stored as a set-friendly CSV field. |
| `judge_status_updates` | Comma-separated status values emitted by JudgeContract in this tx. | Typical values: `SUSPICIOUS`, `MALICIOUS`, `BENIGN`. |
| `judge_penalty_event_count` | Number of `Penalized` Judge events emitted in this tx. | `0` means the tx did not emit a Judge penalty event. |
| `judge_penalty_amount_total` | Sum of Judge penalty amounts emitted in this tx. | Blank when no penalty event occurred. |
| `judge_penalty_reasons` | Comma-separated penalty/block reasons decoded from Judge events in this tx. | Useful for per-tx threat interpretation. |
| `judge_block_event_count` | Number of `MemberBlocked` Judge events emitted in this tx. | A non-zero value means the tx caused a Judge-enforced temporary block. |
| `judge_latest_blocking_end_utc` | Latest block-until timestamp decoded from Judge events in this tx. | Blank when no block event occurred. |
| `judge_reward_event_count` | Number of `RewardIssued` Judge events emitted in this tx. | `0` when no reward event occurred. |
| `judge_reward_amount_total` | Sum of Judge reward amounts emitted in this tx. | Blank when no reward event occurred. |
| `zero_gas_reason` | Reserved field for zero-gas tx cases. | In the current runner this tx-level field is written as blank. |
| `notes` | Free-text narrative explaining why this tx occurred. | Useful for manual interpretation. |
| `scenario_start_utc` | UTC start time of the scenario that contains this tx. | Same scenario-level anchor reused across sibling tx rows. |
| `scenario_end_utc` | UTC end time of the scenario at the point the row was logged. | Filled from the resolved scenario end anchor. |
| `action_start_utc` | UTC start time of the parent action. | Shared with the linked action row. |
| `action_end_utc` | UTC end time of the parent action. | Shared with the linked action row. |
| `action_duration_ms` | Wall-clock duration of the parent action. | Shared with the linked action row. |
| `tx_sent_utc` | Timestamp captured immediately before the tx was submitted. | Best per-tx send anchor. |
| `tx_mined_utc` | Timestamp captured immediately after the tx receipt was observed. | Best per-tx mined anchor. |

## `scenario_summary.csv` / `scenario_summary.json`

One row = one scenario iteration summary.

- The scenario summary now carries the same aggregated Judge side-effect fields:
  - `judge_event_names`
  - `judge_affected_members`
  - `judge_status_updates`
  - `judge_penalty_event_count`
  - `judge_penalty_amount_total`
  - `judge_penalty_reasons`
  - `judge_block_event_count`
  - `judge_latest_blocking_end_utc`
  - `judge_reward_event_count`
  - `judge_reward_amount_total`
- These are aggregated from the action rows of that scenario iteration.
- `whether_judge_triggered = 1` means at least one action in the scenario emitted JudgeContract events or otherwise surfaced Judge involvement through the shared logging path.

### Plain-English explanation of `gas_limit`

If you know nothing about blockchain, start with this:

Before a transaction runs, the sender must tell the blockchain:

- "I allow this transaction to use up to this much work."

That maximum allowed work is `gas_limit`.

So:

- `gas_limit` = the maximum work allowed
- `gas_used` = the work that was actually needed

The easiest real-world analogy is a budget cap.

Imagine you tell a worker:

- "Do this job, but do not use more than 500 units of effort."

Then one of two things happens:

1. The job needs only 300 units.
   Then it finishes successfully.

2. The job really needs 700 units.
   Then it cannot finish, because you only allowed 500.

That is exactly how `gas_limit` works.

Very important:

- `gas_limit` is not the same as the final cost.
- It is only the maximum allowed amount.

You usually pay based on `gas_used`, not the full limit.

So if:

- `gas_limit = 500000`
- `gas_used = 210000`

then the transaction was allowed to use up to `500000`, but it really used only `210000`.

That means:

- the transaction succeeded
- the actual fee is based on `210000`
- you did not pay as if it used all `500000`

Now the failure case:

If:

- `gas_limit = 100000`
- but the transaction really needs `140000`

then the transaction does not have enough room to finish.

What you will usually see:

- the transaction fails
- `out_of_gas = 1`
- `status = 0`
- `gas_used` is often very close to `gas_limit`

Why?

Because the transaction kept trying to run until it hit the maximum it was allowed to use.

So the simplest way to read these three fields together is:

- `gas_limit` = how much room the sender gave the transaction
- `gas_used` = how much room it actually consumed
- `out_of_gas` = whether the transaction crashed because that room was not enough

One last simple rule:

- a large `gas_limit` does not automatically mean the transaction was expensive
- a large `gas_used` is what tells you the transaction actually consumed a lot of work

For your CSV interpretation:

- use `gas_limit` to understand the allowed maximum
- use `gas_used` to understand the real cost/work
- use `out_of_gas` to detect that the limit was too small for that transaction

## Interpretation Notes

- If you want one row per logical step, use `gas_action_level.csv`.
- If you want exact contract/function/gas/finality details, use `gas_tx_level.csv`.
- If you want to see whether a specific step caused a Judge penalty, block, status change, or reward, start with the `judge_*` columns on `gas_action_level.csv` and then drill into `gas_tx_level.csv` using `action_instance_id`.
- Use `action_instance_id` to join the two layers.
- Treat `communication_back_and_forth_ms` as off-chain visible overhead, not as raw packet latency.
- Treat `blockchain_processing_ms` as the cleanest on-chain latency metric in the current runner.
- Treat `notes` and `outcome_reason` as explanatory text, not as stable machine categories.

## Current File Location

This definition file is intentionally stored beside the evaluation scripts in:

- [outputs_defined_per_column.md](/home/mpxhemant/thesis/eval/outputs_defined_per_column.md)
