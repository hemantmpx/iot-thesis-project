# `full-chain-sim.js`

**Where it lives:** `iot/pi/scripts/full-chain-sim.js`

## What it is (simple version)
This is the **deepest on‑chain simulation**.
It touches every core contract (RoleToken, RoleBased, Factory, Register, Judge)
without using the PGH API.

## What it actually does
1. Verifies contracts exist on the chain.
2. Picks **three** unused addresses (object + two subjects).
3. Registers roles for all three.
4. Deploys an Access Control Contract for one subject.
5. Adds allow/deny policies.
6. Executes accessControl transactions.
7. Reads roles and Judge blocking status.
8. Writes a **metrics snapshot** (best effort).

## When to use it
Use this when you want a **pure blockchain report** without the gateway.

## Output
- `iot/pi/results/full-sim-<timestamp>.json`
- `iot/pi/results/metrics-full-sim-<timestamp>.txt`

## How to run it
```bash
node iot/pi/scripts/full-chain-sim.js
```

## Smart contracts used
- RoleBasedAccessControl: assigns roles for object/subjects (register step).
- AccessControlFactory: deploys new AccessControlContract instances.
- RegisterContract: resolves object+subject+accType to ACC addresses.
- AccessControlContract: stores policies and runs accessControl calls.
- JudgeContract: applies rewards/penalties and exposes block state.
- RoleToken: reads roles/balances and helps pick Role.NONE addresses.
