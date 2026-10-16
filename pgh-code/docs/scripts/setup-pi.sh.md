# `setup-pi.sh`

**Where it lives:** `iot/pi/scripts/setup-pi.sh`

## What it is (simple version)
Think of this script as the “teacher who prepares the classroom.”
It checks that all the important files are in place, fills in your `.env`, picks safe keys,
adds missing config files if needed, and makes sure the Pi is ready to run simulations.

## What it actually does
1. **Checks required files** are present (contract addresses, bootstrap config, Ganache keys, ABIs).
2. **Creates the `config/` files** (`securityMatrix.json`, `threatCatalog.json`) if missing (optional).
3. **Ensures `iot/pi/.env` exists** (uses `.env.template` if needed).
4. **Installs dependencies** (`npm --prefix iot/pi install`) if they are missing.
5. **Finds the admin key** (the RoleToken owner) and **chooses a different PGH key**.
6. **Writes all contract addresses** into `.env` (RoleToken, RoleBased, Factory, Register, Judge).
7. **Grants ADMIN role to the PGH key** so the PGH can deploy and manage contracts.
8. Creates `iot/pi/results/` if missing.

## Why this matters
Many “nonce” errors happen when the PGH and admin scripts use the **same key**.
This script prevents that by ensuring:
- `ADMIN_KEY` and `PRIMARY_HEAD_KEY` are **different**
- the PGH key is **trusted (ADMIN)** on-chain

## Inputs it uses
- `tmp/deployed-addresses.json`
- `tmp/bootstrap-config.json`
- `tmp/ganache-keys.json`
- `iot/abis/*.json`
- optional flags:
  - `--rpc-url`
  - `--pgh-key`
  - `--admin-key`
  - `--write-defaults`

## Outputs / side effects
- Updates **`iot/pi/.env`** with keys and addresses
- Creates `config/securityMatrix.json` and `config/threatCatalog.json` (optional)
- Ensures `iot/pi/results/` exists

## How to run it
```bash
iot/pi/scripts/setup-pi.sh --rpc-url http://<laptop-ip>:8545 --write-defaults
```

If you only want to **check** files without changes:
```bash
iot/pi/scripts/setup-pi.sh --check-only
```

## Smart contracts used
- RoleToken: identifies the owner/admin key and grants ADMIN to the PGH key.
- RoleBasedAccessControl, AccessControlFactory, RegisterContract, JudgeContract: addresses are written into .env (no direct transactions here).
