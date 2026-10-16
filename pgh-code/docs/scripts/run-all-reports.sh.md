# `run-all-reports.sh`

**Where it lives:** `iot/pi/scripts/run-all-reports.sh`

## What it is (simple version)
This script is the **full report generator**.
It runs every major simulation in order and saves all outputs.
Think of it like a full exam where every part is graded and logged.

## What it actually does
1. **Ensures PGH is running** (starts it if needed).
2. Runs the **full on‑chain simulation** (no PGH).
3. Runs the **PGH simulation** (clean success mode).
4. Runs **attack/tamper scenarios** through PGH.
5. Runs the **collector** (extended scripted flow).
6. Runs the **Table Access Control (TAC)** suite if deployed.
7. Runs **cross‑PGH** simulation if two PGHs are reachable.
8. Writes a **Prometheus metrics snapshot** at the end.

## When to use it
Use this when you want **everything** in one folder:
- full‑chain report
- PGH report
- attack report
- collector logs
- TAC report (if available)
- optional cross‑PGH report

## Inputs it needs
- PGH API reachable (defaults to `http://127.0.0.1:8080`)
- `tmp/deployed-addresses.json`, `tmp/ganache-keys.json`, `iot/abis/*`

## Outputs
- Many JSON reports under `iot/pi/results/`
- Metrics snapshot: `metrics-suite-<timestamp>.txt`

## How to run it
```bash
iot/pi/scripts/run-all-reports.sh
```

You can override endpoints:
```bash
PGH_API_BASE=http://<pgh-ip>:8080 iot/pi/scripts/run-all-reports.sh
```

## Smart contracts used
- RoleToken: used by setup/PGH flows to manage roles and balances.
- RoleBasedAccessControl: device registration (assignRole) via PGH or direct scripts.
- AccessControlFactory: ACC deployment via PGH or direct scripts.
- RegisterContract: maps object+subject+accType to ACCs.
- AccessControlContract: policy and accessControl evaluation.
- JudgeContract: rewards/penalties and blocking.
- TableAccessControlContract: only if deployed and TAC suite runs.
