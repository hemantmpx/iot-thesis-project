# Evaluation Runner

Scenario-centric thesis evaluation runner using existing PGH + contract architecture.

The runner now includes extended contract-surface coverage operations (policy lifecycle, access-contract lifecycle, role lifecycle, register config path, and TAC mutation/policy lifecycle) in addition to the mandatory 8 thesis logical operations.

## Entry points
- Main orchestrator: `eval/runner.js`
- Scenario templates: `eval/scenario_library.js`
- Logging: `eval/gas_logger.js`
- Operation mapping: `eval/op_mapping.json`
- Wrapper command: `./scripts/run_eval.sh`

## Outputs
- `results/gas_tx_level.csv`
- `results/gas_action_level.csv`
- `results/scenario_summary.csv`
- `results/scenario_summary.json`
- `results/run_manifest.json`

## Scenario execution controls

- `EVAL_SCENARIO_IDS=id1,id2,...` run deterministic list
- `EVAL_SCENARIO_GROUP=normal|timing|threat|scalability` run group
- `EVAL_SCENARIO_REPEAT=N` repeat selected scenarios
- `EVAL_DISABLE_RANDOM_FILL=1` disable legacy random fill
- `EVAL_ONLY_MODE_B=1` restrict to cross-PGH scenarios
- `EVAL_INCLUDE_SETUP_IN_SCENARIO=0` skip setup-tagged operations

If `EVAL_SCENARIO_IDS` or `EVAL_SCENARIO_GROUP` is set, explicit scenarios are executed in deterministic order.

## Example commands

Run one rich normal scenario:
```bash
EVAL_SCENARIO_IDS=normal_rich_federated_success_01 EVAL_DISABLE_RANDOM_FILL=1 ./scripts/run_eval.sh
```

Run the expanded contract-coverage normal scenario:
```bash
EVAL_SCENARIO_IDS=normal_rich_federated_success_02 EVAL_DISABLE_RANDOM_FILL=1 ./scripts/run_eval.sh
```

Run timing scenarios with 10 repetitions:
```bash
EVAL_SCENARIO_GROUP=timing EVAL_SCENARIO_REPEAT=10 EVAL_DISABLE_RANDOM_FILL=1 ./scripts/run_eval.sh
```

Run threat scenarios:
```bash
EVAL_SCENARIO_GROUP=threat EVAL_DISABLE_RANDOM_FILL=1 ./scripts/run_eval.sh
```

Run the new during/after attack scenarios only:
```bash
EVAL_SCENARIO_IDS=threat_during_after_privilege_escalation_01,threat_during_after_unauthorized_access_01,threat_during_after_tampering_01,threat_during_after_too_frequent_access_01,threat_during_after_poison_ivy_esp_bridge_compromise_01 EVAL_DISABLE_RANDOM_FILL=1 ./scripts/run_eval.sh
```

Run the scalability scenarios:
```bash
EVAL_SCENARIO_GROUP=scalability EVAL_DISABLE_RANDOM_FILL=1 ./scripts/run_eval.sh
```

## CSV schema highlights

### `gas_tx_level.csv`
Includes scenario metadata (`scenario_id`, `scenario_group`, `scenario_stage`, `action_instance_id`, `correlation_id`), network metadata (`request_method`, `endpoint_route`, `source_actor`, `destination_actor`, `source_pgh`, `destination_pgh`), timing anchors (`request_sent_utc`, `pgh_forward_start_utc`, `blockchain_submit_utc`, `response_returned_utc`), **two derived timing metrics only** (`communication_back_and_forth_ms`, `blockchain_processing_ms`), and tx gas fields (`gas_used`, `gas_limit`, `effective_gas_price`, `fee_paid_wei`, `status`, `revert_reason`, `out_of_gas`).

### `gas_action_level.csv`
Adds per-action totals with `scenario_stage`, zero-gas reasoning (`zero_gas_reason`), and network-correlation fields for Wireshark comparison. Timing output is intentionally reduced to the same two metrics: `communication_back_and_forth_ms` and `blockchain_processing_ms`.

### `scenario_summary.csv`
One row per executed scenario iteration with:
- total actions / txs / gas / fee
- total communication back-and-forth / blockchain processing timing
- involved contracts/functions
- cross-PGH and judge-trigger flags
- overall scenario outcome and narrative summary

## Detailed design docs

See `eval/SCENARIO_GUIDE.md` for:
- architecture inspection summary
- full function classification across contracts
- scenario IDs and groups
- stage/function mapping
- command recipes

See `eval/POISON_IVY_ESP_BRIDGE_SCENARIO.md` for:
- the ESP-backed PoisonIvy scenario design
- sandboxed copied-database execution details
- exact blockchain integration path and validation steps
