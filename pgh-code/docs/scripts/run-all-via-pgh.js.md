# `run-all-via-pgh.js`

**Where it lives:** `iot/pi/scripts/run-all-via-pgh.js`

## What it is (narrative overview)
Think of the Primary Group Head (PGH) as the “gatekeeper” for your IoT cluster. Instead of you talking directly to the blockchain, you ask the PGH to do it on your behalf. This script is a complete, guided tour of that workflow. It registers a device, deploys an access‑control contract, adds policies, then asks the PGH to evaluate access decisions and optionally log them on‑chain. It also collects metrics so you can see how the PGH behaved.

If you were explaining it to an undergrad: **this script is the “lab practical”** where you watch a server (PGH) orchestrate the blockchain steps end‑to‑end, including access control decisions and their consequences.

## What it does, step by step (in plain language)
1. **Loads the chain + key context.**
   - Reads `tmp/ganache-keys.json` to get a list of wallets.
   - Uses `RoleToken.getRole(address)` to find wallets that are still **Role.NONE** (unused).
   - Picks one unused wallet as the **object** (the protected resource) and one as the **subject** (the caller).

2. **(Optional) Rotates the PGH signing key.**
   - If `AUTO_ROTATE_PGH_KEY=1` is set, or if a nonce error is detected, it swaps the PGH key to a fresh wallet and restarts PGH.
   - This is meant to avoid “nonce too low / nonce mismatch” errors when the same key is reused across runs.

3. **Registers the object and subject.**
   - Calls `POST /register-device` twice (once for object, once for subject).
   - PGH uses the **RoleBasedAccessControl** contract to give each address a role (member type).
   - This puts the addresses into the “known members” set on‑chain.

4. **Deploys an access‑control contract (ACC).**
   - Calls `POST /deploy-contract` with the object, subject, and access‑control type (e.g., `sensor`).
   - PGH uses the **AccessControlFactory** contract to deploy a new **AccessControlContract**.
   - The **RegisterContract** stores or resolves the ACC address for this subject/object pair.

5. **Adds policies to that ACC.**
   - Calls `POST /policies` to add:
     - a **view allow** policy, and
     - (unless `STRICT_SUCCESS=1`) an **edit deny** policy.
   - These policies are stored **inside the AccessControlContract**.

6. **Evaluates access decisions (and optionally logs on‑chain).**
   - Calls `POST /evaluate-access` using the subject’s private key, so PGH can actually **send the access transaction** on‑chain.
   - In normal mode, it performs:
     1) `view` (allowed)
     2) `view` again (too frequent)
     3) `edit` (denied / tamper)
   - In `STRICT_SUCCESS=1` mode, it only performs a single `view`.
   - The **Threat Model** runs after each evaluation, and PGH may call the **JudgeContract** to reward or penalize the subject.

7. **Captures status + metrics.**
   - Fetches `/status` from PGH (token balances, last contract, etc.).
   - Captures a Prometheus metrics snapshot from `/metrics`.

8. **Writes results into a run folder.**
   - Creates `iot/pi/results/run-all-via-pgh-<timestamp>/`.
   - Writes `report.json` plus metrics snapshots.

## Why you sometimes see “errors” that are expected
- **“Member is blocked”** during `evaluate edit` is normal when you are intentionally simulating a deny/tamper case.
- If you want a “clean, all‑green” run, use:
  ```bash
  STRICT_SUCCESS=1 node iot/pi/scripts/run-all-via-pgh.js
  ```

## Inputs / environment
- `PGH_API_BASE` (default `http://localhost:8080`)
- `RPC_URL` (from `iot/pi/.env`)
- `STRICT_SUCCESS=1` to skip the deny/tamper phase
- `AUTO_ROTATE_PGH_KEY=1` to allow auto key rotation on nonce problems

## Output (where results go now)
- `iot/pi/results/run-all-via-pgh-<timestamp>/report.json`
- `iot/pi/results/run-all-via-pgh-<timestamp>/metrics-pgh-sim-<timestamp>.txt`

## How to run it
```bash
PGH_API_BASE=http://127.0.0.1:8080 node iot/pi/scripts/run-all-via-pgh.js
```

## Smart contracts used (what each one does here)
### 1) **RoleBasedAccessControl**
**Purpose:** Put devices into the system by assigning them roles.
- Endpoint: `/register-device`
- On‑chain call: `assignRole(deviceAddress, name, memberType)`
- Why it matters: the device must have a role before any access control can work.

### 2) **AccessControlFactory**
**Purpose:** Deploy a new AccessControlContract for a subject/object pair.
- Endpoint: `/deploy-contract`
- On‑chain call: `deployAccessControlContract(objectAddress, subjectAddress, accType)`
- Why it matters: it creates the contract that will actually store policies and evaluate access.

### 3) **RegisterContract**
**Purpose:** Look up the ACC that belongs to a subject/object pair.
- Used by PGH during deploy and evaluate.
- On‑chain call: `getAccessControlContract(object, subject, accType)`
- Why it matters: it connects a request to the correct AccessControlContract.

### 4) **AccessControlContract**
**Purpose:** Store policies and enforce them.
- Endpoint: `/policies` adds rules like “view allowed” or “edit denied”.
- Endpoint: `/evaluate-access` runs `accessControl(resource, action)`.
- Why it matters: this is the contract that says yes/no for each access request.

### 5) **JudgeContract**
**Purpose:** Apply rewards or penalties based on threat analysis.
- Triggered after access evaluations by the Threat Model.
- Example on‑chain calls: `reportNonPenalizeMisbehavior`, `reportMaliciousActivity`.
- Why it matters: this is where token incentives or penalties happen.

### 6) **RoleToken**
**Purpose:** Track roles and token balances for members.
- Used by PGH for role checks and `/status` token balance reporting.
- Why it matters: this is how you see “who has how many tokens”.

## Troubleshooting quick notes
- **Nonce errors:** Usually means a stale PGH process or key reuse. Restart PGH and Ganache.
- **Not an Admin:** Your `PRIMARY_HEAD_KEY` is not the RoleToken owner/admin.
- **Member blocked:** Expected in non‑strict mode; it’s part of the attack/deny simulation.
