# `run-all-on-pi.js`

**Where it lives:** `iot/pi/scripts/run-all-on-pi.js`

## What it is (simple version)
This script runs the whole flow **directly on the blockchain**,
without using the PGH API. Think of it as “talking to the chain yourself.”

## What it actually does
1. Checks that all core contracts are deployed.
2. Picks unused addresses (object + subject).
3. Registers roles on‑chain.
4. Deploys an Access Control Contract (ACC).
5. Adds allow/deny policies.
6. Executes accessControl transactions (allow, too frequent, tamper).
7. Records roles and judge blocking status.
8. Writes a **Prometheus snapshot** (best effort).

## When to use it
Use this when you want to test the **smart contracts only**,
without the PGH layer.

## Output
- `iot/pi/results/run-all-<timestamp>.json`
- `iot/pi/results/metrics-run-all-<timestamp>.txt`

## How to run it
```bash
node iot/pi/scripts/run-all-on-pi.js
```

## Smart contracts used
- RoleBasedAccessControl: assigns roles for object/subject.
- AccessControlFactory: deploys the AccessControlContract.
- RegisterContract: looks up the ACC for object/subject/accType.
- AccessControlContract: policy add and accessControl calls.
- JudgeContract: applies penalties/rewards and block status.
- RoleToken: reads roles/balances and helps pick Role.NONE addresses.
