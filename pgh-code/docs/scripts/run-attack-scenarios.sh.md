# `run-attack-scenarios.sh`

**Where it lives:** `iot/pi/scripts/run-attack-scenarios.sh`

## What it is (simple version)
This script **acts like a “bad student”** to test the system’s defenses.
It runs allowed actions, too‑frequent actions, and tampering actions
and records how the system reacts.

## What it actually does
1. Picks a clean object + subject address.
2. Registers both with PGH.
3. Deploys an access control contract.
4. Adds allow (view) and deny (edit) policies.
5. Runs three evaluations:
   - allowed view
   - too‑frequent view
   - denied edit (tamper)
6. Writes a JSON report and a **metrics snapshot**.
7. If a nonce issue happens, it rotates the PGH key and retries once.

## When to use it
Use this when you want to show **threat detection and policy enforcement**.

## Output
- `iot/pi/results/attacks-<timestamp>.json`
- `iot/pi/results/metrics-attack-<timestamp>.txt`

## How to run it
```bash
iot/pi/scripts/run-attack-scenarios.sh
```

## Smart contracts used
- RoleBasedAccessControl: registers attacker and object via PGH.
- AccessControlFactory: deploys ACC via PGH.
- RegisterContract: resolves ACC address for policies/evaluate.
- AccessControlContract: runs allow/deny policies and access checks.
- JudgeContract: applies penalties for tamper/abuse threats.
- RoleToken: role checks and balances in PGH status.
