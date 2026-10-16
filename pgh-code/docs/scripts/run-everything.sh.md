# `run-everything.sh`

**Where it lives:** `iot/pi/scripts/run-everything.sh`

## What it is (simple version)
This is a **shorter “do a full demo” script**.
It runs the main simulations but skips extra checks and cross‑PGH.

## What it actually does
1. Runs **full‑chain simulation** (direct on chain).
2. Runs **PGH simulation** (via PGH API).
3. Runs **attack scenarios**.
4. Runs the **collector** (extended flow).
5. Writes a **metrics snapshot** at the end.

## When to use it
Use this when you want a **fast end‑to‑end demo** without extra checks.

## Outputs
- Simulation outputs under `iot/pi/results/`
- `metrics-run-everything-<timestamp>.txt`

## How to run it
```bash
iot/pi/scripts/run-everything.sh
```

## Smart contracts used
- RoleToken: used by setup/PGH flows to manage roles and balances.
- RoleBasedAccessControl: device registration via PGH or direct scripts.
- AccessControlFactory: ACC deployment via PGH or direct scripts.
- RegisterContract: maps object+subject+accType to ACCs.
- AccessControlContract: policy and accessControl evaluation.
- JudgeContract: rewards/penalties and blocking.
