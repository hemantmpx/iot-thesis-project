# `prep-and-run.sh`

**Where it lives:** `iot/pi/scripts/prep-and-run.sh`

## What it is (simple version)
This is the **one‑button “do everything safely”** script.
It checks your files, fixes the environment, restarts the gateway,
and then runs the full simulation suite.

## What it actually does
1. **Checks required files** (`tmp/*.json`, ABIs, `.env`).
2. **Checks the chain is reachable** (Ganache RPC must respond).
3. **Installs Node dependencies** if needed.
4. **Runs `setup-pi.sh`** to update `.env` and split keys.
5. **Verifies keys are different** (`ADMIN_KEY` ≠ `PRIMARY_HEAD_KEY`).
6. **Restarts PGH** and waits for `/status` to become available.
7. **Runs `run-all-reports.sh`** (full simulation suite).

## When to use it
Use this when you want a **repeatable, clean run** without remembering all steps.
It is also good for demos or thesis runs.

## How to run it
```bash
iot/pi/scripts/prep-and-run.sh --rpc-url http://<laptop-ip>:8545
```

Useful modes:
```bash
# Only check prerequisites
iot/pi/scripts/prep-and-run.sh --check-only

# Prep only (env + PGH restart), no simulations
iot/pi/scripts/prep-and-run.sh --rpc-url http://<laptop-ip>:8545 --prep-only
```

## Outputs / side effects
- Updates `.env` via `setup-pi.sh`
- Restarts PGH
- Runs `run-all-reports.sh` and produces results under `iot/pi/results/`

## Smart contracts used
- RoleToken: via setup-pi.sh to find the owner and grant ADMIN to the PGH key.
- RoleBasedAccessControl, AccessControlFactory, RegisterContract, AccessControlContract, JudgeContract: used indirectly via run-all-reports.sh and PGH endpoints.
