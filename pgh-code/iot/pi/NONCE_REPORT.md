# Nonce Issue Report (High-Level)

## Summary
We saw repeated transaction failures like:
- `the tx doesn't have the correct nonce`
- `insufficient funds` or `could not decode result data` as follow-on failures

At a high level, the **nonce** is the transaction counter for an account on the chain. If two processes submit transactions using the *same* account, they race and Ganache rejects one of them with a nonce mismatch.

## What happened
The Primary Group Head (PGH) and the automation scripts were **sharing the same signer key**:
- `PRIMARY_HEAD_KEY` (PGH signer)
- `ADMIN_KEY` (admin signer used by scripts)

When both were the same key, the PGH and scripts sent transactions in parallel. Ganache then rejected some txs with:
```
the tx doesn't have the correct nonce
```

Even after restarting Ganache, the error returned because the **same key was still used concurrently**, so nonces continued to collide.

## Why the errors cascaded
Once a transaction failed:
- deployments returned `BAD_DATA` when the contract address was missing,
- policy and evaluate calls failed because no ACC existed,
- later steps reported 404/500 or decode errors.

So the root cause was the **shared signer**, not the ACC logic itself.

## Fix (What we changed)
1. **Separate keys:**
   - `ADMIN_KEY` = RoleToken owner (admin)
   - `PRIMARY_HEAD_KEY` = different funded key for the PGH

2. **Grant ADMIN role to the PGH key** so it can deploy and write:
   - done automatically by `iot/pi/scripts/setup-pi.sh`

3. **Restart PGH** so it loads the updated `.env`.

4. **Run the suite again** (now with non-conflicting signers).

## Stable, repeatable flow
Use the new automation script:
```
iot/pi/scripts/prep-and-run.sh --rpc-url http://<laptop-ip>:8545
```
It:
- checks RPC + required files
- refreshes `.env`
- ensures keys are split
- grants admin role to the PGH key
- restarts PGH
- runs the full suite

## How to confirm it’s fixed
- `ADMIN_KEY` and `PRIMARY_HEAD_KEY` in `iot/pi/.env` are **different**.
- PGH is reachable on `/status`.
- `run-all-reports.sh` completes and writes new result files under `iot/pi/results/`.

## If the issue returns
- Ensure Ganache is actually fresh (no `--db`, old process fully stopped).
- Re-run `setup-pi.sh` to re-split keys and re-grant admin.
- Restart PGH and re-run the suite.
