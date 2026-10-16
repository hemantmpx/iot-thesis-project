# `run-cross-pgh.js`

**Where it lives:** `iot/pi/scripts/run-cross-pgh.js`

## What it is (simple version)
This script simulates **two PGHs talking to each other**.
It shows what happens when a subject from PGH‑B asks to access data in PGH‑A (and vice‑versa).

## What it actually does
1. Finds 4 clean addresses (object + subject for each PGH).
2. Registers and deploys ACCs on **PGH‑A** and **PGH‑B**.
3. Adds allow policies in both PGHs.
4. Executes **cross‑PGH evaluate** calls both ways.
5. Writes metrics snapshots for **each PGH**.

## When to use it
Use this when you have **two PGH instances** running (e.g., ports 8080 and 8081).

## Output
- `iot/pi/results/cross-pgh-<timestamp>.json`
- `iot/pi/results/metrics-cross-pgh-A-<timestamp>.txt`
- `iot/pi/results/metrics-cross-pgh-B-<timestamp>.txt`

## How to run it
```bash
PGH_A_BASE=http://127.0.0.1:8080 PGH_B_BASE=http://127.0.0.1:8081 node iot/pi/scripts/run-cross-pgh.js
```

## Smart contracts used
- RoleBasedAccessControl: registers devices on PGH-A and PGH-B.
- AccessControlFactory: deploys ACCs on both PGHs.
- RegisterContract: resolves ACCs for cross-PGH evaluate calls.
- AccessControlContract: evaluates access for cross-PGH requests.
- JudgeContract: applies rewards/penalties for detected threats.
- RoleToken: role checks and balances in each PGH status.
