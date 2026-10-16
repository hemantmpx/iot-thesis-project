# `run-pgh-suite.sh`

**Where it lives:** `iot/pi/scripts/run-pgh-suite.sh`

## What it is (simple version)
This script is a **clean PGH‑focused demo**.
It picks clean (unused) addresses, restarts PGH with a safe key,
then runs the PGH simulation and collector.

## What it actually does
1. Finds an **admin key** and two **Role.NONE** addresses.
2. Updates `.env` with a safe `PRIMARY_HEAD_KEY`.
3. Revokes roles if needed to free clean addresses.
4. Restarts the PGH service.
5. Runs **`run-all-via-pgh.js`** in strict success mode.
6. Runs **collector** to produce structured logs.
7. Writes a **metrics snapshot**.

## When to use it
Use this when you want a **clean PGH run** and don’t care about the full chain or cross‑PGH tests.

## Outputs
- `pgh-sim-<timestamp>.json`
- collector folder under `iot/pi/results/<timestamp>/`
- `metrics-run-pgh-suite-<timestamp>.txt`

## How to run it
```bash
iot/pi/scripts/run-pgh-suite.sh
```

## Smart contracts used
- RoleToken: finds the owner/admin key, revokes roles, and grants ADMIN to the PGH key.
- RoleBasedAccessControl, AccessControlFactory, RegisterContract, AccessControlContract, JudgeContract: used indirectly via run-all-via-pgh.js and collector.
