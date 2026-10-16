# `demo-esp-access.sh`

**Where it lives:** `esp_api_project/scripts/demo-esp-access.sh`

## What it is (simple version)
This script is a **mini demo** for the Flask ESP API.
It creates fake sensor data and shows how access approvals work.

## What it actually does
1. Sends two fake sensor readings for **MAC_A** and **MAC_B**.
2. Grants same‑PGH access (MAC_A can read MAC_B).
3. Shows MAC_A requesting MAC_B status.
4. Simulates a **peer PGH request** (remote group).
5. Approves that peer request and checks access again.

## When to use it
Use this when you want to quickly show **ESP data + access approvals** without real hardware.

## Output
- Prints HTTP responses to your terminal.
- Updates `esp_api_project/esp_data.db`.

## How to run it
```bash
API_BASE=http://localhost:5000 esp_api_project/scripts/demo-esp-access.sh
```

## Smart contracts used
- RoleBasedAccessControl: registers device roles through the PGH/ESP API.
- AccessControlFactory: deploys ACCs when the ESP API provisions a device.
- RegisterContract: stores the object+subject+accType -> ACC mapping used by PGH.
- AccessControlContract: stores policies and evaluates access decisions.
- JudgeContract: applies rewards/penalties when threats are detected.
- RoleToken: tracks roles and token balances reported by PGH status.
