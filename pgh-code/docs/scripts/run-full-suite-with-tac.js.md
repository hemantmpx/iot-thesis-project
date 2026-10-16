# `run-full-suite-with-tac.js`

**Where it lives:** `iot/pi/scripts/run-full-suite-with-tac.js`

## What it is (simple version)
This is the **PGH simulation plus Table Access Control (TAC)** demo.
It shows normal sensor access *and* the special table‑based access flow.

## What it actually does
1. Picks clean object + subject addresses.
2. Registers them via PGH.
3. Deploys ACC and adds allow/deny policies.
4. Runs the usual evaluate steps.
5. Uses the TAC contract to:
   - add a policy for regular members
   - create an access request
   - approve that request
   - read the local resource table
6. Writes a **metrics snapshot**.

## When to use it
Use this when you want to demonstrate **Table Access Control** in addition to normal ACC.

## Output
- `iot/pi/results/full-suite-tac-<timestamp>.json`
- `iot/pi/results/metrics-full-suite-tac-<timestamp>.txt`

## How to run it
```bash
PGH_API_BASE=http://127.0.0.1:8080 node iot/pi/scripts/run-full-suite-with-tac.js
```

## Smart contracts used
- RoleBasedAccessControl: registers device roles via PGH.
- AccessControlFactory: deploys ACC via PGH.
- RegisterContract: resolves ACC addresses for policy/evaluate.
- AccessControlContract: normal ACC policy + accessControl checks.
- TableAccessControlContract: table-based policy, request, approve, and table reads.
- JudgeContract: penalties/rewards when threats are detected.
- RoleToken: role checks and balances in PGH status.
