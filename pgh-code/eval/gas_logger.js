const fs = require("fs");
const path = require("path");

const TX_HEADERS = [
  "timestamp_utc",
  "run_id",
  "scenario_id",
  "scenario_group",
  "iteration",
  "mode",
  "logical_operation",
  "scenario_stage",
  "behavior",
  "action_instance_id",
  "correlation_id",
  "request_method",
  "endpoint_route",
  "source_actor",
  "destination_actor",
  "source_pgh",
  "destination_pgh",
  "request_sent_utc",
  "request_received_utc",
  "pgh_forward_start_utc",
  "pgh_forward_end_utc",
  "blockchain_submit_utc",
  "blockchain_mined_utc",
  "response_returned_utc",
  "communication_back_and_forth_ms",
  "blockchain_processing_ms",
  "tx_index",
  "contract_name",
  "function_name",
  "from_account",
  "to_contract",
  "tx_hash",
  "block_number",
  "gas_used",
  "gas_limit",
  "effective_gas_price",
  "fee_paid_wei",
  "status",
  "revert_reason",
  "out_of_gas",
  "judge_event_names",
  "judge_affected_members",
  "judge_status_updates",
  "judge_penalty_event_count",
  "judge_penalty_amount_total",
  "judge_penalty_reasons",
  "judge_block_event_count",
  "judge_latest_blocking_end_utc",
  "judge_reward_event_count",
  "judge_reward_amount_total",
  "zero_gas_reason",
  "notes",
  "scenario_start_utc",
  "scenario_end_utc",
  "action_start_utc",
  "action_end_utc",
  "action_duration_ms",
  "tx_sent_utc",
  "tx_mined_utc",
];

const ACTION_HEADERS = [
  "timestamp_utc",
  "run_id",
  "scenario_id",
  "scenario_group",
  "iteration",
  "mode",
  "logical_operation",
  "scenario_stage",
  "behavior",
  "action_instance_id",
  "correlation_id",
  "request_method",
  "endpoint_route",
  "source_actor",
  "destination_actor",
  "source_pgh",
  "destination_pgh",
  "tx_count",
  "total_gas_used",
  "total_fee_paid_wei",
  "outcome",
  "outcome_reason",
  "involved_contracts",
  "involved_functions",
  "measured_as",
  "out_of_gas_count",
  "judge_event_names",
  "judge_affected_members",
  "judge_status_updates",
  "judge_penalty_event_count",
  "judge_penalty_amount_total",
  "judge_penalty_reasons",
  "judge_block_event_count",
  "judge_latest_blocking_end_utc",
  "judge_reward_event_count",
  "judge_reward_amount_total",
  "zero_gas_reason",
  "request_sent_utc",
  "request_received_utc",
  "pgh_forward_start_utc",
  "pgh_forward_end_utc",
  "blockchain_submit_utc",
  "blockchain_mined_utc",
  "response_returned_utc",
  "communication_back_and_forth_ms",
  "blockchain_processing_ms",
  "scenario_start_utc",
  "scenario_end_utc",
  "total_scenario_elapsed_ms",
  "notes",
  "action_start_utc",
  "action_end_utc",
  "action_duration_ms",
];

const SCENARIO_HEADERS = [
  "timestamp_utc",
  "run_id",
  "scenario_id",
  "scenario_group",
  "iteration",
  "mode",
  "scenario_start_utc",
  "scenario_end_utc",
  "total_scenario_elapsed_ms",
  "total_actions",
  "total_txs",
  "total_gas",
  "total_fee",
  "total_communication_back_and_forth_ms",
  "total_blockchain_processing_ms",
  "involved_contracts",
  "involved_functions",
  "pghs_involved",
  "whether_cross_pgh",
  "whether_judge_triggered",
  "judge_event_names",
  "judge_affected_members",
  "judge_status_updates",
  "judge_penalty_event_count",
  "judge_penalty_amount_total",
  "judge_penalty_reasons",
  "judge_block_event_count",
  "judge_latest_blocking_end_utc",
  "judge_reward_event_count",
  "judge_reward_amount_total",
  "whether_table_access_used",
  "whether_multi_tx",
  "overall_outcome",
  "narrative_summary",
];

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  let str = String(value);
  str = str.replace(/\r?\n/g, "\\n");
  if (/[",\n]/.test(str)) {
    str = `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatRow(headers, row) {
  const cells = headers.map((h) => csvEscape(row[h]));
  return `${cells.join(",")}\n`;
}

function needsHeader(filePath, headerLine) {
  if (!fs.existsSync(filePath)) return true;
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4096);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    if (!bytes) return true;
    const firstLine = buf.toString("utf8", 0, bytes).split(/\r?\n/)[0];
    return firstLine.trim() !== headerLine;
  } catch (_err) {
    return true;
  }
}

function rotateIfHeaderMismatch(filePath, headerLine) {
  if (!fs.existsSync(filePath)) return;
  if (!needsHeader(filePath, headerLine)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bakPath = `${filePath}.bak-${stamp}`;
  fs.renameSync(filePath, bakPath);
}

class GasLogger {
  constructor({ resultsDir, runId }) {
    this.resultsDir = resultsDir;
    this.runId = runId;
    this.txPath = path.join(resultsDir, "gas_tx_level.csv");
    this.actionPath = path.join(resultsDir, "gas_action_level.csv");
    this.scenarioPath = path.join(resultsDir, "scenario_summary.csv");

    const txHeader = TX_HEADERS.join(",");
    const actionHeader = ACTION_HEADERS.join(",");
    const scenarioHeader = SCENARIO_HEADERS.join(",");
    rotateIfHeaderMismatch(this.txPath, txHeader);
    rotateIfHeaderMismatch(this.actionPath, actionHeader);
    rotateIfHeaderMismatch(this.scenarioPath, scenarioHeader);

    this.txStream = fs.createWriteStream(this.txPath, { flags: "a" });
    this.actionStream = fs.createWriteStream(this.actionPath, { flags: "a" });
    this.scenarioStream = fs.createWriteStream(this.scenarioPath, { flags: "a" });
    if (needsHeader(this.txPath, txHeader)) {
      this.txStream.write(`${txHeader}\n`);
    }
    if (needsHeader(this.actionPath, actionHeader)) {
      this.actionStream.write(`${actionHeader}\n`);
    }
    if (needsHeader(this.scenarioPath, scenarioHeader)) {
      this.scenarioStream.write(`${scenarioHeader}\n`);
    }
  }

  logTx(row) {
    this.txStream.write(formatRow(TX_HEADERS, row));
  }

  logAction(row) {
    this.actionStream.write(formatRow(ACTION_HEADERS, row));
  }

  logScenario(row) {
    this.scenarioStream.write(formatRow(SCENARIO_HEADERS, row));
  }

  close() {
    this.txStream.end();
    this.actionStream.end();
    this.scenarioStream.end();
  }
}

module.exports = {
  GasLogger,
  TX_HEADERS,
  ACTION_HEADERS,
  SCENARIO_HEADERS,
};
