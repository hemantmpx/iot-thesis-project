#!/usr/bin/env python3
"""
Generate thesis-ready SVG figures for a Poison Ivy run from actual result data.

The script reads:
- gas_action_level.csv
- gas_tx_level.csv
- scenario_summary.json
- optional ESP sandbox SQLite database for Judge state evolution

It then writes SVG figures into a dedicated output directory.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable
from xml.sax.saxutils import escape


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle-dir", required=True, help="Result bundle directory for a single run")
    parser.add_argument("--esp-db", help="Optional ESP sandbox database path for state-evolution figure")
    parser.add_argument("--output-dir", help="Optional output directory; defaults to <bundle-dir>/figures")
    return parser.parse_args()


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def read_summary(path: Path) -> dict:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, list):
        return payload[0]
    return payload


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    normalized = value.replace("Z", "+00:00")
    return datetime.fromisoformat(normalized)


def format_int(value: int | float | str | None) -> str:
    if value in (None, ""):
        return "-"
    if isinstance(value, str):
        try:
            if "." in value:
                value = float(value)
            else:
                value = int(value)
        except ValueError:
            return value
    if isinstance(value, float):
        return f"{value:,.0f}"
    return f"{int(value):,}"


def format_ms(value: int | float | str | None) -> str:
    if value in (None, ""):
        return "-"
    millis = float(value)
    if millis >= 1000:
        return f"{millis / 1000:.2f}s"
    return f"{millis:.0f} ms"


def format_eth_approx(wei: str | int | None) -> str:
    if wei in (None, ""):
        return "-"
    value = int(wei)
    return f"{value / 10**18:.6f} ETH"


def short_addr(value: str | None) -> str:
    if not value:
        return "-"
    if len(value) <= 14:
        return value
    return f"{value[:8]}...{value[-6:]}"


def stage_label(stage: str) -> str:
    return stage.replace("_", " ").title()


def op_label(name: str) -> str:
    return name.replace("ESP ", "").replace(" with Misbehavior", "").replace(" without Misbehavior", "")


def write_svg(path: Path, body: str, width: int, height: int) -> None:
    payload = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" font-family="Georgia, Times New Roman, serif">'
        f"<rect width='100%' height='100%' fill='#fbfaf6'/>"
        f"{body}</svg>"
    )
    path.write_text(payload, encoding="utf-8")


def svg_text(x: float, y: float, text: str, size: int = 16, fill: str = "#1f2328",
             weight: str = "normal", anchor: str = "start") -> str:
    return (
        f"<text x='{x:.1f}' y='{y:.1f}' font-size='{size}' fill='{fill}' "
        f"font-weight='{weight}' text-anchor='{anchor}'>{escape(text)}</text>"
    )


def svg_line(x1: float, y1: float, x2: float, y2: float, stroke: str = "#d0d7de",
             width: float = 1.0, dash: str | None = None) -> str:
    dash_attr = f" stroke-dasharray='{dash}'" if dash else ""
    return (
        f"<line x1='{x1:.1f}' y1='{y1:.1f}' x2='{x2:.1f}' y2='{y2:.1f}' "
        f"stroke='{stroke}' stroke-width='{width}'{dash_attr}/>"
    )


def svg_rect(x: float, y: float, w: float, h: float, fill: str, stroke: str = "none",
             stroke_width: float = 0, rx: float = 0) -> str:
    return (
        f"<rect x='{x:.1f}' y='{y:.1f}' width='{w:.1f}' height='{h:.1f}' "
        f"fill='{fill}' stroke='{stroke}' stroke-width='{stroke_width}' rx='{rx}'/>"
    )


def svg_circle(cx: float, cy: float, r: float, fill: str, stroke: str = "none",
               stroke_width: float = 0) -> str:
    return (
        f"<circle cx='{cx:.1f}' cy='{cy:.1f}' r='{r:.1f}' fill='{fill}' "
        f"stroke='{stroke}' stroke-width='{stroke_width}'/>"
    )


def svg_polyline(points: Iterable[tuple[float, float]], stroke: str, width: float = 2.5,
                 fill: str = "none") -> str:
    pts = " ".join(f"{x:.1f},{y:.1f}" for x, y in points)
    return f"<polyline points='{pts}' fill='{fill}' stroke='{stroke}' stroke-width='{width}'/>"


OUTCOME_COLORS = {
    "success": "#2a7f62",
    "denied": "#b14545",
    "failed": "#8a5a00",
    "unavailable": "#6b7280",
}


CONTRACT_COLORS = {
    "RoleBasedAccessControl": "#7c5cff",
    "RoleToken": "#3b82f6",
    "AccessControlFactory": "#14b8a6",
    "AccessControlContract": "#ef4444",
    "RegisterContract": "#f59e0b",
    "JudgeContract": "#111827",
}


@dataclass
class AccessState:
    sequence: int
    endpoint_id: int
    allowed: bool
    denial_reason: str | None
    wave_index: int
    budget: int
    blocked_count: int
    quarantined: bool
    permanently_revoked: bool
    stage_label: str


def load_access_states(db_path: Path) -> list[AccessState]:
    if not db_path.exists():
        return []
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, response_json FROM chain_actions WHERE endpoint='/evaluate-access' ORDER BY id"
    ).fetchall()
    conn.close()

    states: list[AccessState] = []
    for seq, row in enumerate(rows, start=1):
        try:
            payload = json.loads(row["response_json"]) if row["response_json"] else {}
        except json.JSONDecodeError:
            continue
        pgh = payload.get("pgh") if isinstance(payload, dict) else None
        if not isinstance(pgh, dict):
            continue
        judge_after = pgh.get("judgeStateAfter") or {}
        states.append(
            AccessState(
                sequence=seq,
                endpoint_id=int(row["id"]),
                allowed=bool(pgh.get("allowed")),
                denial_reason=pgh.get("denialReason"),
                wave_index=int(judge_after.get("waveIndex") or 0),
                budget=int(judge_after.get("securityTokenBudget") or 0),
                blocked_count=int(judge_after.get("blockedAttemptCountInWave") or 0),
                quarantined=bool(judge_after.get("temporaryQuarantineActive")),
                permanently_revoked=bool(judge_after.get("permanentRevoked")),
                stage_label="Allow" if pgh.get("allowed") else str(pgh.get("denialReason") or "Denied"),
            )
        )
    return states


def build_action_timeline(actions: list[dict[str, str]], summary: dict) -> tuple[str, int, int]:
    width = 1800
    row_h = 54
    top = 120
    left = 340
    chart_w = 1320
    height = top + row_h * len(actions) + 120

    start = parse_iso(summary["scenario_start_utc"])
    end = parse_iso(summary["scenario_end_utc"])
    total_ms = max(1.0, (end - start).total_seconds() * 1000) if start and end else 1.0

    body = []
    body.append(svg_text(64, 52, "Figure 1. Poison Ivy Action Timeline", 30, weight="bold"))
    body.append(svg_text(
        64, 80,
        f"Actual run {summary['run_id']} on {summary['scenario_end_utc']} | outcome: {summary['overall_outcome']}",
        16, fill="#4b5563"
    ))

    # Legend
    lx = 1320
    ly = 52
    for idx, (name, color) in enumerate([("success", OUTCOME_COLORS["success"]),
                                         ("denied", OUTCOME_COLORS["denied"])]):
        body.append(svg_rect(lx + idx * 130, ly - 15, 18, 18, color, rx=3))
        body.append(svg_text(lx + 24 + idx * 130, ly, name.title(), 14))

    # Axis
    body.append(svg_line(left, top - 25, left, top + row_h * len(actions), "#9ca3af", 1.2))
    body.append(svg_line(left, top + row_h * len(actions), left + chart_w, top + row_h * len(actions), "#9ca3af", 1.2))

    tick_count = 6
    for idx in range(tick_count + 1):
        frac = idx / tick_count
        x = left + frac * chart_w
        body.append(svg_line(x, top - 25, x, top + row_h * len(actions), "#e5e7eb", 1.0, "4 4"))
        body.append(svg_text(x, top + row_h * len(actions) + 24, f"{(total_ms * frac)/1000:.0f}s", 13, "#6b7280", anchor="middle"))

    for idx, row in enumerate(actions):
        y = top + idx * row_h
        body.append(svg_line(left, y + row_h - 10, left + chart_w, y + row_h - 10, "#f0ede6", 1.0))
        stage = stage_label(row["scenario_stage"])
        label = f"{idx + 1}. {stage}"
        op = op_label(row["logical_operation"])
        body.append(svg_text(22, y + 18, label, 15, weight="bold"))
        body.append(svg_text(22, y + 37, op, 13, "#4b5563"))
        body.append(svg_text(250, y + 28, f"tx={row['tx_count']}", 13, "#6b7280", anchor="end"))

        action_start = parse_iso(row["action_start_utc"])
        duration = float(row["action_duration_ms"] or 0)
        relative = max(0.0, (action_start - start).total_seconds() * 1000) if action_start and start else 0.0
        x = left + (relative / total_ms) * chart_w
        w = max(8.0, (duration / total_ms) * chart_w)
        color = OUTCOME_COLORS.get(row["outcome"], "#6b7280")
        body.append(svg_rect(x, y + 6, w, 22, color, stroke="#111827", stroke_width=0.6, rx=5))
        body.append(svg_text(x + 8, y + 22, format_ms(duration), 12, "#ffffff"))
        reason = row["outcome_reason"] or ""
        if "temporary_quarantine_reached" in reason:
            body.append(svg_text(left + chart_w + 10, y + 21, "temporary quarantine reached", 12, "#b14545"))
        elif "permanent_revocation_reached" in reason:
            body.append(svg_text(left + chart_w + 10, y + 21, "permanent revocation reached", 12, "#7f1d1d"))
        elif row["judge_reward_event_count"] not in ("", "0"):
            body.append(svg_text(left + chart_w + 10, y + 21, "benign recovery reward applied", 12, "#2a7f62"))

    return "".join(body), width, height


def build_transaction_figure(txs: list[dict[str, str]], summary: dict) -> tuple[str, int, int]:
    width = 1900
    height = 980
    left = 90
    right = 70
    top = 120
    bottom = 220
    chart_w = width - left - right
    chart_h = height - top - bottom
    max_gas = max(int(row["gas_used"] or 0) for row in txs) or 1

    body = []
    body.append(svg_text(64, 52, "Figure 2. Transaction-Level Blockchain Effects", 30, weight="bold"))
    body.append(svg_text(
        64, 80,
        "Bars show gas used per blockchain transaction. Labels identify the contract/function that handled the operation.",
        16, fill="#4b5563"
    ))

    # Legend
    lx = 1200
    ly = 50
    for idx, contract in enumerate(["RoleBasedAccessControl", "AccessControlFactory", "AccessControlContract"]):
        color = CONTRACT_COLORS[contract]
        body.append(svg_rect(lx, ly + idx * 24 - 13, 18, 18, color, rx=3))
        body.append(svg_text(lx + 24, ly + idx * 24, contract, 13))

    body.append(svg_line(left, top, left, top + chart_h, "#9ca3af", 1.2))
    body.append(svg_line(left, top + chart_h, left + chart_w, top + chart_h, "#9ca3af", 1.2))

    for tick in range(6):
        frac = tick / 5
        y = top + chart_h - frac * chart_h
        body.append(svg_line(left, y, left + chart_w, y, "#ece7df", 1.0, "4 4"))
        body.append(svg_text(left - 10, y + 5, format_int(max_gas * frac), 12, "#6b7280", anchor="end"))

    bar_gap = 10
    bar_w = max(18.0, (chart_w - bar_gap * (len(txs) - 1)) / len(txs))
    notable_labels = {
        "MemberBlocked": "quarantine",
        "PermanentRevocationTriggered": "permanent revoke",
        "RewardIssued": "recovery",
    }

    for idx, row in enumerate(txs):
        gas = int(row["gas_used"] or 0)
        x = left + idx * (bar_w + bar_gap)
        h = (gas / max_gas) * chart_h
        y = top + chart_h - h
        contract = row["contract_name"]
        color = CONTRACT_COLORS.get(contract, "#6b7280")
        judge_events = row["judge_event_names"] or ""
        outline = "#111827" if judge_events else "none"
        body.append(svg_rect(x, y, bar_w, h, color, stroke=outline, stroke_width=1.1, rx=3))
        body.append(svg_text(x + bar_w / 2, top + chart_h + 22, str(idx + 1), 11, "#4b5563", anchor="middle"))
        body.append(svg_text(x + bar_w / 2, top + chart_h + 40, row["scenario_stage"].replace("_", "\n"), 10, "#6b7280", anchor="middle"))

        short_fn = row["function_name"]
        body.append(
            f"<text x='{x + bar_w / 2:.1f}' y='{y - 8:.1f}' font-size='10' fill='#1f2328' text-anchor='middle' "
            f"transform='rotate(-55 {x + bar_w / 2:.1f},{y - 8:.1f})'>{escape(short_fn)}</text>"
        )
        for key, label in notable_labels.items():
            if key in judge_events:
                body.append(svg_text(x + bar_w / 2, y - 24, label, 10, "#7f1d1d", weight="bold", anchor="middle"))
                break

    body.append(svg_text(64, height - 90, f"Total blockchain transactions: {summary['total_txs']}", 16, weight="bold"))
    body.append(svg_text(64, height - 62, f"Total gas consumed: {format_int(summary['total_gas'])}", 16))
    body.append(svg_text(64, height - 34, "Judge-related transactions are outlined and annotated above the bars.", 14, "#4b5563"))

    return "".join(body), width, height


def build_summary_dashboard(summary: dict) -> tuple[str, int, int]:
    width = 1600
    height = 900
    body = []
    body.append(svg_text(64, 52, "Figure 3. Scenario Summary Dashboard", 30, weight="bold"))
    body.append(svg_text(
        64, 80,
        f"Single-run summary for {summary['scenario_id']} ({summary['run_id']})",
        16, fill="#4b5563"
    ))

    cards = [
        ("Outcome", summary["overall_outcome"], "#e8f5ef"),
        ("Actions", format_int(summary["total_actions"]), "#eef4ff"),
        ("Transactions", format_int(summary["total_txs"]), "#eef4ff"),
        ("Total Gas", format_int(summary["total_gas"]), "#fff4e8"),
        ("Penalty Total", format_int(summary["judge_penalty_amount_total"]), "#fdecec"),
        ("Reward Total", format_int(summary["judge_reward_amount_total"]), "#e8f5ef"),
        ("Block Events", format_int(summary["judge_block_event_count"]), "#fff4e8"),
        ("Judge Triggered", "Yes" if int(summary["whether_judge_triggered"]) else "No", "#eef4ff"),
    ]

    card_w = 320
    card_h = 124
    start_x = 64
    start_y = 128
    gap_x = 28
    gap_y = 24
    for idx, (title, value, fill) in enumerate(cards):
        row = idx // 4
        col = idx % 4
        x = start_x + col * (card_w + gap_x)
        y = start_y + row * (card_h + gap_y)
        body.append(svg_rect(x, y, card_w, card_h, fill, stroke="#d6d3cb", stroke_width=1, rx=16))
        body.append(svg_text(x + 22, y + 34, title, 18, "#4b5563", weight="bold"))
        body.append(svg_text(x + 22, y + 80, str(value), 30, "#111827", weight="bold"))

    body.append(svg_rect(64, 430, 1470, 350, "#fffdf8", stroke="#d6d3cb", stroke_width=1, rx=18))
    body.append(svg_text(90, 470, "Interpretation of the Recorded Security Response", 24, weight="bold"))
    lines = [
        f"The scenario completed in {format_ms(summary['total_scenario_elapsed_ms'])} and remained entirely within PGH_A.",
        f"Judge emitted {format_int(summary['judge_penalty_event_count'])} penalty events and {format_int(summary['judge_reward_event_count'])} recovery reward events.",
        f"The final recorded Judge event set includes: {summary['judge_event_names']}.",
        f"Penalty reasons observed in this run were: {summary['judge_penalty_reasons']}.",
        f"The latest quarantine/block end recorded by Judge was {summary['judge_latest_blocking_end_utc']}.",
        f"Total fee paid for the scenario was approximately {format_eth_approx(summary['total_fee'])}.",
        f"Involved contracts: {summary['involved_contracts']}.",
    ]
    y = 510
    for line in lines:
        body.append(svg_text(92, y, line, 17))
        y += 38

    return "".join(body), width, height


def build_state_evolution(states: list[AccessState], summary: dict) -> tuple[str, int, int]:
    width = 1800
    height = 980
    left = 100
    right = 60
    top = 120
    chart_h = 420
    chart_w = width - left - right
    base_y = top + chart_h

    body = []
    body.append(svg_text(64, 52, "Figure 4. Security-State Evolution Across the Attack Waves", 30, weight="bold"))
    body.append(svg_text(
        64, 80,
        "State trace reconstructed from actual /evaluate-access records captured by the ESP bridge sandbox database.",
        16, fill="#4b5563"
    ))

    body.append(svg_line(left, top, left, base_y, "#9ca3af", 1.2))
    body.append(svg_line(left, base_y, left + chart_w, base_y, "#9ca3af", 1.2))
    for tick in range(6):
        frac = tick / 5
        y = base_y - frac * chart_h
        body.append(svg_line(left, y, left + chart_w, y, "#ece7df", 1.0, "4 4"))
        body.append(svg_text(left - 10, y + 5, str(int(100 * frac)), 12, "#6b7280", anchor="end"))
    body.append(svg_text(left - 42, top - 10, "Security budget", 14, "#4b5563"))

    if not states:
        body.append(svg_text(64, 180, "No state-evolution data available.", 18, "#7f1d1d"))
        return "".join(body), width, height

    step_w = chart_w / max(1, len(states) - 1)
    points = []
    for idx, state in enumerate(states):
        x = left + idx * step_w
        y = base_y - (max(0, min(100, state.budget)) / 100.0) * chart_h
        points.append((x, y))
    body.append(svg_polyline(points, "#1d4ed8", 3.0))

    for idx, state in enumerate(states):
        x, y = points[idx]
        if state.allowed:
            fill = "#2a7f62"
        elif state.permanently_revoked:
            fill = "#5b0f0f"
        elif state.quarantined:
            fill = "#b14545"
        else:
            fill = "#ef4444"
        body.append(svg_circle(x, y, 8, fill, stroke="#ffffff", stroke_width=2))
        body.append(svg_text(x, base_y + 28, str(state.sequence), 12, "#4b5563", anchor="middle"))
        body.append(svg_text(x, base_y + 48, f"W{state.wave_index}", 11, "#6b7280", anchor="middle"))
        if state.quarantined:
            body.append(svg_text(x, y - 16, "quarantine", 11, "#7f1d1d", weight="bold", anchor="middle"))
        if state.permanently_revoked:
            body.append(svg_text(x, y - 16, "permanent revoke", 11, "#5b0f0f", weight="bold", anchor="middle"))

    # Event table
    table_y = 600
    body.append(svg_rect(64, table_y, 1670, 300, "#fffdf8", stroke="#d6d3cb", stroke_width=1, rx=16))
    body.append(svg_text(90, table_y + 34, "Per-access Judge state after each evaluated request", 22, weight="bold"))
    headers = ["Seq", "Decision", "Reason", "Wave", "Budget", "Blocked Count", "Quarantined", "Permanent"]
    cols = [90, 160, 340, 760, 860, 980, 1180, 1360]
    for x, header in zip(cols, headers):
        body.append(svg_text(x, table_y + 70, header, 15, "#4b5563", weight="bold"))
    body.append(svg_line(90, table_y + 80, 1650, table_y + 80, "#d6d3cb", 1))

    for idx, state in enumerate(states[:13]):
        y = table_y + 112 + idx * 22
        decision = "ALLOW" if state.allowed else "DENY"
        reason = state.denial_reason or "-"
        body.append(svg_text(cols[0], y, str(state.sequence), 13))
        body.append(svg_text(cols[1], y, decision, 13, "#2a7f62" if state.allowed else "#b14545", weight="bold"))
        body.append(svg_text(cols[2], y, reason[:42], 13))
        body.append(svg_text(cols[3], y, str(state.wave_index), 13))
        body.append(svg_text(cols[4], y, str(state.budget), 13))
        body.append(svg_text(cols[5], y, str(state.blocked_count), 13))
        body.append(svg_text(cols[6], y, "Yes" if state.quarantined else "No", 13))
        body.append(svg_text(cols[7], y, "Yes" if state.permanently_revoked else "No", 13))

    return "".join(body), width, height


def write_readme(output_dir: Path, bundle_dir: Path, esp_db: Path | None, summary: dict) -> None:
    lines = [
        "# Poison Ivy Figures",
        "",
        f"Run ID: `{summary['run_id']}`",
        f"Scenario ID: `{summary['scenario_id']}`",
        f"RPC URL: `{json.loads((bundle_dir / 'run_manifest.json').read_text(encoding='utf-8'))['rpc_url']}`",
        "",
        "These figures were generated from actual run artifacts, not synthetic values.",
        "",
        "## Data Sources",
        f"- `{bundle_dir / 'gas_action_level.csv'}`",
        f"- `{bundle_dir / 'gas_tx_level.csv'}`",
        f"- `{bundle_dir / 'scenario_summary.json'}`",
    ]
    if esp_db:
        lines.append(f"- `{esp_db}`")
    lines.extend(
        [
            "",
            "## Files",
            "- `figure_01_action_timeline.svg`: action-level timeline for the full scenario",
            "- `figure_02_transaction_effects.svg`: per-transaction gas/effect plot",
            "- `figure_03_summary_dashboard.svg`: run-level summary dashboard",
            "- `figure_04_security_state_evolution.svg`: Judge budget and wave-state evolution per evaluated request",
        ]
    )
    (output_dir / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    args = parse_args()
    bundle_dir = Path(args.bundle_dir).resolve()
    output_dir = Path(args.output_dir).resolve() if args.output_dir else (bundle_dir / "figures")
    output_dir.mkdir(parents=True, exist_ok=True)

    actions = read_csv(bundle_dir / "gas_action_level.csv")
    txs = read_csv(bundle_dir / "gas_tx_level.csv")
    summary = read_summary(bundle_dir / "scenario_summary.json")
    esp_db = Path(args.esp_db).resolve() if args.esp_db else None
    states = load_access_states(esp_db) if esp_db else []

    timeline_svg, w, h = build_action_timeline(actions, summary)
    write_svg(output_dir / "figure_01_action_timeline.svg", timeline_svg, w, h)

    tx_svg, w, h = build_transaction_figure(txs, summary)
    write_svg(output_dir / "figure_02_transaction_effects.svg", tx_svg, w, h)

    dashboard_svg, w, h = build_summary_dashboard(summary)
    write_svg(output_dir / "figure_03_summary_dashboard.svg", dashboard_svg, w, h)

    state_svg, w, h = build_state_evolution(states, summary)
    write_svg(output_dir / "figure_04_security_state_evolution.svg", state_svg, w, h)

    write_readme(output_dir, bundle_dir, esp_db, summary)
    print(output_dir)


if __name__ == "__main__":
    main()
