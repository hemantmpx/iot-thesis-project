# `run-cross-pgh-attack.js`

**Where it lives:** `iot/pi/scripts/run-cross-pgh-attack.js`

## What it is (simple version)
This script is a **full, detailed "PGH-A attacks PGH-B" simulation**.
It sets up attackers on PGH-A, a victim object on PGH-B, runs a normal access
first, then runs **tampering** and **brute-force** attempts, and finally writes a
very verbose report (JSON + Markdown) that explains everything that happened.

## What it actually does (step by step)
1. **Checks readiness**
   It pings both PGH-A and PGH-B (`/status` + `/metrics`) before it starts.
2. **Chooses fresh addresses**
   It picks clean (Role.NONE) addresses for:
   - `objectA` (home object on PGH-A)
   - `attacker1` and `attacker2` (attackers from PGH-A)
   - `objectB` (victim object on PGH-B)
3. **Registers on PGH-A**
   It registers `objectA`, `attacker1`, and `attacker2` on PGH-A.
4. **Baseline ACC on PGH-A**
   It deploys an ACC for `objectA` + `attacker1`, adds an allow-view policy,
   and executes a **baseline view** (normal access on the home PGH).
5. **Registers on PGH-B**
   It registers `objectB`, `attacker1`, and `attacker2` on PGH-B.
6. **Deploys access contracts on PGH-B**
   It creates a contract for each attacker and the victim object.
7. **Adds policies**
   - attacker1: **allow view**, **deny edit**
   - attacker2: **deny view** (so repeated requests are unauthorized)
8. **Runs the attack flow**
   - PGH-B: attacker1 does a **normal view** (baseline success)
   - PGH-B: attacker1 tries **edit** (tamper attempt -> denial + penalty)
   - PGH-B: attacker2 spams **view** multiple times (triggers "too many attempts")
9. **Captures everything**
   - Tx hashes, gas used, contract addresses, and decoded events
   - Judge penalties/rewards
   - RoleToken balance changes
   - Prometheus snapshots before + after
   - Demo logs written by PGH

## When to use it
Use this when you want a **single script** to produce a **full cross-PGH attack report**
that shows *exactly* how the contracts and the gateway responded.

## Output
Creates a dedicated run folder:
- `iot/pi/results/run-cross-pgh-attack-<timestamp>/`
  - `report.json` (full verbose report)
  - `summary.md` (human-readable summary)
  - metrics snapshots for PGH-A and PGH-B (pre and post)

## How to run it
```bash
PGH_A_BASE=http://127.0.0.1:8080 \
PGH_B_BASE=http://127.0.0.1:8081 \
node iot/pi/scripts/run-cross-pgh-attack.js
```

## Useful options
```bash
# Only check readiness (no on-chain actions)
node iot/pi/scripts/run-cross-pgh-attack.js --check-only

# Change brute-force attempts (default = 6)
ATTACK_ATTEMPTS=10 node iot/pi/scripts/run-cross-pgh-attack.js

# Disable on-chain logging
LOG_ON_CHAIN=0 node iot/pi/scripts/run-cross-pgh-attack.js
```

## Smart contracts used
- RoleBasedAccessControl: registers attacker/object roles on both PGHs.
- AccessControlFactory: deploys ACCs for baseline and attack paths.
- RegisterContract: resolves ACC addresses for evaluate calls.
- AccessControlContract: policy storage and accessControl evaluation.
- JudgeContract: penalties/rewards and blocking history in the report.
- RoleToken: token balances and transfers captured for the report.
