# `run-collector-auto.sh`

**Where it lives:** `iot/pi/scripts/run-collector-auto.sh`

## What it is (simple version)
This script **automates the collector**.
It finds clean addresses, updates the bootstrap config,
then runs the extended collector and saves outputs.

## What it actually does
1. Picks **Role.NONE** subject + object from Ganache keys.
2. Updates `tmp/bootstrap-config.json` with the chosen object.
3. Registers the object so ACC deploys cleanly.
4. Runs `collect-extended.js` (register → deploy → policy → evaluate).
5. If it fails due to nonce errors, it **rotates the PGH key** and retries once.
6. Writes a **metrics snapshot** into the latest results folder.

## When to use it
Use this when you want a **clean collector output** without manual input.

## Output
- Folder: `iot/pi/results/<timestamp>/`
- Metrics snapshot: `<timestamp>/metrics-snapshot.txt`

## How to run it
```bash
iot/pi/scripts/run-collector-auto.sh
```

## Smart contracts used
- RoleBasedAccessControl: registers subject/object via PGH.
- AccessControlFactory: deploys ACC for the collector flow.
- RegisterContract: resolves ACC address for policies/evaluate.
- AccessControlContract: stores policies and evaluates access.
- JudgeContract: applies rewards/penalties when threats fire.
- RoleToken: role checks and balances in PGH status.
