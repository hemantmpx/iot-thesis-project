import os
import json
import sqlite3
import secrets
import subprocess
import threading
from flask import Flask, request, jsonify
from datetime import datetime, timedelta
from flask_cors import CORS
import requests  

app = Flask(__name__)
CORS(app)

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ESP_API_HOST = os.environ.get("ESP_API_HOST", "0.0.0.0")
ESP_API_PORT = int(os.environ.get("ESP_API_PORT", "5000"))
DB_FILE = os.environ.get(
    "ESP_DB_FILE",
    os.path.abspath(os.path.join(os.path.dirname(__file__), "esp_data.db")),
)

#  Primary Group Head (PGH) Configuration


# Give each Raspberry Pi a unique group ID.
# Example:
#   On Pi A: PRIMARY_GROUP_ID = "pgh-a"
#   On Pi B: PRIMARY_GROUP_ID = "pgh-b"
PRIMARY_GROUP_ID = os.environ.get("PRIMARY_GROUP_ID", "pgh-a")

# Configure peer primary group heads here.
# Each dict: { "id": "<peer_group_id>", "base_url": "http://<peer_ip>:5000" }
# Example on Pi A (talking to Pi B):
# PEER_GROUPS = [
#     {"id": "pgh-b", "base_url": "http://192.168.4.51:5000"}
# ]
try:
    PEER_GROUPS = json.loads(os.environ.get("PEER_GROUPS_JSON", "[]"))
except Exception:
    PEER_GROUPS = []

# Optional: restrict which peer IPs can hit peer endpoints.
# If empty, all IPs are allowed for peer calls.
try:
    ALLOWED_PEER_IPS = json.loads(os.environ.get("ALLOWED_PEER_IPS_JSON", "[]"))
except Exception:
    ALLOWED_PEER_IPS = []

#  Blockchain / PGH integration
PGH_API_BASE = os.environ.get("PGH_API_BASE", "http://localhost:8080")
PGH_OBJECT_ADDRESS = os.environ.get("PGH_OBJECT_ADDRESS")  # required to deploy ACCs
PGH_ACC_TYPE = os.environ.get("PGH_ACC_TYPE", "sensor")
RPC_URL = os.environ.get("RPC_URL")
PGH_ACTION_VIEW = "view"
PGH_ACTION_COMPARE = os.environ.get("PGH_ACTION_COMPARE", "compare")
PGH_DB_OBJECT_ADDRESS = os.environ.get("PGH_DB_OBJECT_ADDRESS", PGH_OBJECT_ADDRESS)
PGH_RESOURCE_STATUS_TEMPLATE = os.environ.get("PGH_RESOURCE_STATUS_TEMPLATE", "device/{mac}/status")
PGH_RESOURCE_TEMPS_TEMPLATE = os.environ.get("PGH_RESOURCE_TEMPS_TEMPLATE", "device/{mac}/temps")
PGH_ALERT_THRESHOLD = float(os.environ.get("PGH_ALERT_THRESHOLD", "30"))
AUTO_REGISTER_REQUESTOR = os.environ.get("AUTO_REGISTER_REQUESTOR", "1") != "0"
ALLOW_OFFLINE_IDENTITY = os.environ.get("ALLOW_OFFLINE_IDENTITY", "1") != "0"
GANACHE_KEYS_PATH = os.environ.get(
    "GANACHE_KEYS_PATH",
    os.path.abspath(os.path.join(ROOT_DIR, "tmp", "ganache-keys.json")),
)
PGH_HTTP_TIMEOUT = 10
DEMO_LOG_DIR = os.environ.get(
    "DEMO_LOG_DIR",
    os.path.abspath(os.path.join(ROOT_DIR, "iot", "pi", "results", "demo-telemetry")),
)

# Simulation orchestration (UI-driven)
SIM_RESULTS_DIR = os.path.abspath(os.path.join(ROOT_DIR, "iot", "pi", "results"))
SIM_SCRIPTS = {
    "full-chain-sim": {
        "cmd": ["node", os.path.join(ROOT_DIR, "iot", "pi", "scripts", "full-chain-sim.js")],
        "cwd": ROOT_DIR,
    },
    "run-all-on-pi": {
        "cmd": ["node", os.path.join(ROOT_DIR, "iot", "pi", "scripts", "run-all-on-pi.js")],
        "cwd": ROOT_DIR,
    },
    "run-all-via-pgh": {
        "cmd": ["node", os.path.join(ROOT_DIR, "iot", "pi", "scripts", "run-all-via-pgh.js")],
        "cwd": ROOT_DIR,
    },
    "run-attack-scenarios": {
        "cmd": ["bash", os.path.join(ROOT_DIR, "iot", "pi", "scripts", "run-attack-scenarios.sh")],
        "cwd": ROOT_DIR,
    },
    "run-collector-auto": {
        "cmd": ["bash", os.path.join(ROOT_DIR, "iot", "pi", "scripts", "run-collector-auto.sh")],
        "cwd": ROOT_DIR,
    },
    "run-full-suite-with-tac": {
        "cmd": ["node", os.path.join(ROOT_DIR, "iot", "pi", "scripts", "run-full-suite-with-tac.js")],
        "cwd": ROOT_DIR,
    },
    "run-cross-pgh": {
        "cmd": ["node", os.path.join(ROOT_DIR, "iot", "pi", "scripts", "run-cross-pgh.js")],
        "cwd": ROOT_DIR,
    },
    "run-cross-pgh-attack": {
        "cmd": ["node", os.path.join(ROOT_DIR, "iot", "pi", "scripts", "run-cross-pgh-attack.js")],
        "cwd": ROOT_DIR,
    },
    "run-all-reports": {
        "cmd": ["bash", os.path.join(ROOT_DIR, "iot", "pi", "scripts", "run-all-reports.sh")],
        "cwd": ROOT_DIR,
    },
    "run-everything": {
        "cmd": ["bash", os.path.join(ROOT_DIR, "iot", "pi", "scripts", "run-everything.sh")],
        "cwd": ROOT_DIR,
    },
    "run-pgh-suite": {
        "cmd": ["bash", os.path.join(ROOT_DIR, "iot", "pi", "scripts", "run-pgh-suite.sh")],
        "cwd": ROOT_DIR,
    },
}

#  Initialize database with required tables

def init_db():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()

    # Logs table
    c.execute("""
        CREATE TABLE IF NOT EXISTS logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT,
            mac TEXT,
            temperature REAL,
            humidity REAL,
            alert_sent INTEGER DEFAULT 0
        )
    """)

    # Devices table
    c.execute("""
        CREATE TABLE IF NOT EXISTS devices (
            mac TEXT PRIMARY KEY,
            last_seen TEXT,
            temperature REAL,
            humidity REAL
        )
    """)

    # Approvals table (per device, for dashboard approvals)
    c.execute("""
        CREATE TABLE IF NOT EXISTS approvals (
            mac TEXT PRIMARY KEY,
            requested_at TEXT,
            approved INTEGER DEFAULT 0,
            approved_at TEXT
        )
    """)

    # Access grants table (per requester_mac + ip + target_mac)
    c.execute("""
        CREATE TABLE IF NOT EXISTS access_grants (
            requestor_mac TEXT,
            requestor_ip TEXT,
            target_mac TEXT,
            approved_at TEXT,
            PRIMARY KEY (requestor_mac, requestor_ip, target_mac)
        )
    """)

    # Peer access requests between primary group heads
    # One PGH asking another to allow its ESP32 member to access a target MAC.
    c.execute("""
        CREATE TABLE IF NOT EXISTS peer_access_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            peer_group_id TEXT,      -- ID of the remote group head (caller)
            peer_ip TEXT,            -- IP of the remote group head (caller)
            requestor_mac TEXT,      -- ESP32 MAC under the remote group
            target_mac TEXT,         -- MAC under THIS group being requested
            requested_at TEXT,
            approved INTEGER DEFAULT 0,
            approved_at TEXT
        )
    """)

    # Cross-group data transfers (e.g. "<mac> shared delta")
    c.execute("""
        CREATE TABLE IF NOT EXISTS peer_transfers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_group_id TEXT,
            to_group_id TEXT,
            from_mac TEXT,
            to_mac TEXT,
            delta_value REAL,
            message TEXT,
            created_at TEXT
        )
    """)

    # Blockchain identity mapping: maps ESP MAC -> subject address/private key/contract
    c.execute("""
        CREATE TABLE IF NOT EXISTS blockchain_identities (
            mac TEXT PRIMARY KEY,
            subject_address TEXT,
            private_key TEXT,
            contract_address TEXT,
            member_type TEXT,
            created_at TEXT
        )
    """)

    # Contract binding cache: object+subject+accType -> ACC address
    c.execute("""
        CREATE TABLE IF NOT EXISTS contract_bindings (
            object_address TEXT,
            subject_address TEXT,
            acc_type TEXT,
            acc_address TEXT,
            created_at TEXT,
            updated_at TEXT,
            PRIMARY KEY (object_address, subject_address, acc_type)
        )
    """)

    # Chain action log (register/deploy/policy/evaluate)
    c.execute("""
        CREATE TABLE IF NOT EXISTS chain_actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT,
            mac TEXT,
            subject_address TEXT,
            object_address TEXT,
            acc_type TEXT,
            resource TEXT,
            action TEXT,
            decision TEXT,
            endpoint TEXT,
            tx_hash TEXT,
            status_code INTEGER,
            response_json TEXT,
            error TEXT,
            duration_ms INTEGER,
            request_bytes INTEGER,
            response_bytes INTEGER,
            gas_used TEXT,
            gas_cost_wei TEXT
        )
    """)

    # PGH status snapshots for token balances + adjustments over time
    c.execute("""
        CREATE TABLE IF NOT EXISTS chain_status_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT,
            pgh_base TEXT,
            status_json TEXT
        )
    """)

    # Simulation runs launched from the UI
    c.execute("""
        CREATE TABLE IF NOT EXISTS simulation_runs (
            id TEXT PRIMARY KEY,
            script_key TEXT,
            status TEXT,
            started_at TEXT,
            finished_at TEXT,
            exit_code INTEGER,
            log_path TEXT,
            result_hint TEXT
        )
    """)

    # Ensure new columns exist when upgrading an existing DB
    def ensure_column(table, column, col_type):
        c.execute(f"PRAGMA table_info({table})")
        cols = {row[1] for row in c.fetchall()}
        if column not in cols:
            c.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")

    ensure_column("chain_actions", "duration_ms", "INTEGER")
    ensure_column("chain_actions", "request_bytes", "INTEGER")
    ensure_column("chain_actions", "response_bytes", "INTEGER")
    ensure_column("chain_actions", "gas_used", "TEXT")
    ensure_column("chain_actions", "gas_cost_wei", "TEXT")

    conn.commit()
    conn.close()

#  Helpers

def insert_log(mac, temp, hum):
    """
    Insert one reading into logs and update devices (latest status),
    and auto-approve the device for itself.
    """
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    alert_flag = 1 if temp > PGH_ALERT_THRESHOLD else 0

    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()

    # Insert into logs
    c.execute("""
        INSERT INTO logs (timestamp, mac, temperature, humidity, alert_sent)
        VALUES (?, ?, ?, ?, ?)
    """, (timestamp, mac, temp, hum, alert_flag))

    # Update devices table (latest status)
    c.execute("""
        INSERT INTO devices (mac, last_seen, temperature, humidity)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(mac) DO UPDATE SET
            last_seen=excluded.last_seen,
            temperature=excluded.temperature,
            humidity=excluded.humidity
    """, (mac, timestamp, temp, hum))

    # Auto-approve the device for itself (self-owner logic)
    c.execute("""
        INSERT OR IGNORE INTO approvals (mac, requested_at, approved, approved_at)
        VALUES (?, ?, 1, ?)
    """, (mac, timestamp, timestamp))

    conn.commit()
    conn.close()


def is_mac_approved(mac):
    """
    Check if a MAC has a dashboard approval that is still valid (24 hours).
    """
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT approved_at FROM approvals WHERE mac = ? AND approved = 1", (mac,))
    row = c.fetchone()
    conn.close()
    if row and row[0]:
        approved_at = datetime.strptime(row[0], "%Y-%m-%d %H:%M:%S")
        return datetime.now() - approved_at < timedelta(hours=24)
    return False


def is_access_allowed(requestor_mac, requestor_ip, target_mac):
    """
    Granular access: device A (requestor_mac, requestor_ip) to device B (target_mac).
    """
    if requestor_mac == target_mac:
        return True

    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("""
        SELECT approved_at FROM access_grants
        WHERE requestor_mac=? AND requestor_ip=? AND target_mac=?
    """, (requestor_mac, requestor_ip, target_mac))
    row = c.fetchone()
    conn.close()

    if row and row[0]:
        approved_at = datetime.strptime(row[0], "%Y-%m-%d %H:%M:%S")
        return datetime.now() - approved_at < timedelta(hours=24)
    return False


def get_peer_by_id(peer_group_id):
    for p in PEER_GROUPS:
        if p.get("id") == peer_group_id:
            return p
    return None


def is_peer_ip_allowed(ip):
    """
    Optional restriction for which IPs may call peer endpoints.
    """
    if not ALLOWED_PEER_IPS:
        return True
    return ip in ALLOWED_PEER_IPS


def is_peer_request_approved(peer_group_id, requestor_mac, target_mac):
    """
    Check if a remote PGH (peer_group_id) + ESP32 MAC has an approved access
    to target_mac within the last 24 hours.
    """
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("""
        SELECT approved_at FROM peer_access_requests
        WHERE peer_group_id = ? AND requestor_mac = ? AND target_mac = ? AND approved = 1
        ORDER BY approved_at DESC LIMIT 1
    """, (peer_group_id, requestor_mac, target_mac))
    row = c.fetchone()
    conn.close()
    if row and row[0]:
        approved_at = datetime.strptime(row[0], "%Y-%m-%d %H:%M:%S")
        return datetime.now() - approved_at < timedelta(hours=24)
    return False


def resource_for(mac, kind):
    if kind == "status":
        return PGH_RESOURCE_STATUS_TEMPLATE.format(mac=mac)
    if kind == "temps":
        return PGH_RESOURCE_TEMPS_TEMPLATE.format(mac=mac)
    return kind


def record_chain_action(
    mac,
    subject_address,
    object_address,
    acc_type,
    resource,
    action,
    decision,
    endpoint,
    status_code=None,
    response_json=None,
    error=None,
    tx_hash=None,
    duration_ms=None,
    request_bytes=None,
    response_bytes=None,
    gas_used=None,
    gas_cost_wei=None,
):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute(
        """
        INSERT INTO chain_actions
        (timestamp, mac, subject_address, object_address, acc_type, resource, action, decision, endpoint, tx_hash, status_code, response_json, error, duration_ms, request_bytes, response_bytes, gas_used, gas_cost_wei)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            ts,
            mac,
            subject_address,
            object_address,
            acc_type,
            resource,
            action,
            decision,
            endpoint,
            tx_hash,
            status_code,
            json.dumps(response_json) if response_json is not None else None,
            error,
            duration_ms,
            request_bytes,
            response_bytes,
            gas_used,
            gas_cost_wei,
        ),
    )
    conn.commit()
    conn.close()


def record_contract_binding(object_address, subject_address, acc_type, acc_address):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute(
        """
        INSERT INTO contract_bindings (object_address, subject_address, acc_type, acc_address, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(object_address, subject_address, acc_type)
        DO UPDATE SET acc_address=excluded.acc_address, updated_at=excluded.updated_at
        """,
        (object_address, subject_address, acc_type, acc_address, ts, ts),
    )
    conn.commit()
    conn.close()


def record_pgh_status_snapshot():
    if not PGH_API_BASE:
        return
    try:
        resp = requests.get(f"{PGH_API_BASE}/status", timeout=PGH_HTTP_TIMEOUT)
        resp.raise_for_status()
        status_json = resp.json()
    except Exception as e:
        status_json = {"error": str(e)}
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute(
        """
        INSERT INTO chain_status_snapshots (timestamp, pgh_base, status_json)
        VALUES (?, ?, ?)
        """,
        (ts, PGH_API_BASE, json.dumps(status_json)),
    )
    conn.commit()
    conn.close()


def rpc_call(method, params):
    if not RPC_URL:
        return None
    try:
        payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        resp = requests.post(RPC_URL, json=payload, timeout=PGH_HTTP_TIMEOUT)
        resp.raise_for_status()
        body = resp.json()
        return body.get("result")
    except Exception:
        return None


def get_tx_metrics(tx_hash):
    if not tx_hash:
        return None
    receipt = rpc_call("eth_getTransactionReceipt", [tx_hash])
    if not receipt:
        return None
    gas_used_hex = receipt.get("gasUsed")
    gas_price_hex = receipt.get("effectiveGasPrice") or receipt.get("gasPrice")
    gas_used = int(gas_used_hex, 16) if gas_used_hex else None
    gas_price = int(gas_price_hex, 16) if gas_price_hex else None
    gas_cost = gas_used * gas_price if gas_used is not None and gas_price is not None else None
    return {
        "gas_used": str(gas_used) if gas_used is not None else None,
        "gas_cost_wei": str(gas_cost) if gas_cost is not None else None,
    }


def insert_simulation_run(run_id, script_key, log_path):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute(
        """
        INSERT INTO simulation_runs (id, script_key, status, started_at, log_path)
        VALUES (?, ?, ?, ?, ?)
        """,
        (run_id, script_key, "running", ts, log_path),
    )
    conn.commit()
    conn.close()


def update_simulation_run(run_id, status, exit_code=None, result_hint=None):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute(
        """
        UPDATE simulation_runs
        SET status = ?, finished_at = ?, exit_code = ?, result_hint = ?
        WHERE id = ?
        """,
        (status, ts, exit_code, result_hint, run_id),
    )
    conn.commit()
    conn.close()


def run_simulation_async(script_key, env_overrides=None):
    if script_key not in SIM_SCRIPTS:
        return None, "unknown script"

    config = SIM_SCRIPTS[script_key]
    run_id = secrets.token_hex(8)
    run_ts = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    run_dir = os.path.join(SIM_RESULTS_DIR, f"ui-run-{script_key}-{run_ts}")
    os.makedirs(run_dir, exist_ok=True)
    log_path = os.path.join(run_dir, "run.log")

    env = os.environ.copy()
    if env_overrides:
        for k, v in env_overrides.items():
            env[str(k)] = str(v)

    insert_simulation_run(run_id, script_key, log_path)

    def target():
        with open(log_path, "w", encoding="utf-8") as log_file:
            proc = subprocess.Popen(
                config["cmd"],
                cwd=config.get("cwd", ROOT_DIR),
                env=env,
                stdout=log_file,
                stderr=subprocess.STDOUT,
            )
            code = proc.wait()
            status = "ok" if code == 0 else "error"
            update_simulation_run(run_id, status, exit_code=code, result_hint=run_dir)

    thread = threading.Thread(target=target, daemon=True)
    thread.start()
    return run_id, None

#  Blockchain helpers

def load_ganache_keys():
    if not os.path.exists(GANACHE_KEYS_PATH):
        return []
    with open(GANACHE_KEYS_PATH, "r", encoding="utf-8") as f:
        raw = json.load(f)
    items = list((raw.get("private_keys") or {}).items())
    # items is list of (address, privateKey)
    return [(addr.lower(), pk) for addr, pk in items]


def get_identity(mac):
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("SELECT * FROM blockchain_identities WHERE mac = ?", (mac,))
    row = c.fetchone()
    conn.close()
    return dict(row) if row else None


def save_identity(mac, subject_address, private_key, contract_address=None, member_type=None):
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("""
        INSERT INTO blockchain_identities (mac, subject_address, private_key, contract_address, member_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(mac) DO UPDATE SET
            subject_address=excluded.subject_address,
            private_key=excluded.private_key,
            contract_address=COALESCE(excluded.contract_address, blockchain_identities.contract_address),
            member_type=COALESCE(excluded.member_type, blockchain_identities.member_type)
    """, (mac, subject_address, private_key, contract_address, member_type, now))
    conn.commit()
    conn.close()


def pick_unused_wallet():
    keys = load_ganache_keys()
    if not keys:
        return None
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT subject_address FROM blockchain_identities")
    used = {row[0].lower() for row in c.fetchall()}
    conn.close()
    for addr, pk in keys:
        if addr not in used:
            return addr, pk
    return None


def register_device_on_chain(subject_address, mac, member_type):
    if not PGH_API_BASE:
        return False, {"error": "PGH_API_BASE not set"}
    payload = {"deviceAddress": subject_address, "name": mac, "memberType": member_type}
    try:
        started = datetime.now()
        resp = requests.post(
            f"{PGH_API_BASE}/register-device",
            json=payload,
            timeout=PGH_HTTP_TIMEOUT,
        )
        duration_ms = int((datetime.now() - started).total_seconds() * 1000)
        body = None
        try:
            body = resp.json()
        except Exception:
            body = {"raw": resp.text}
        req_bytes = len(json.dumps(payload).encode("utf-8"))
        resp_bytes = len(resp.content or b"")
        tx_hash = body.get("txHash") if isinstance(body, dict) else None
        tx_metrics = get_tx_metrics(tx_hash) if tx_hash else None
        record_chain_action(
            mac=mac,
            subject_address=subject_address,
            object_address=PGH_DB_OBJECT_ADDRESS,
            acc_type=PGH_ACC_TYPE,
            resource=None,
            action="register",
            decision="ok" if resp.status_code == 200 else "error",
            endpoint="/register-device",
            status_code=resp.status_code,
            response_json=body,
            tx_hash=tx_hash,
            duration_ms=duration_ms,
            request_bytes=req_bytes,
            response_bytes=resp_bytes,
            gas_used=tx_metrics.get("gas_used") if tx_metrics else None,
            gas_cost_wei=tx_metrics.get("gas_cost_wei") if tx_metrics else None,
        )
        return resp.status_code == 200, body
    except Exception as e:
        record_chain_action(
            mac=mac,
            subject_address=subject_address,
            object_address=PGH_DB_OBJECT_ADDRESS,
            acc_type=PGH_ACC_TYPE,
            resource=None,
            action="register",
            decision="error",
            endpoint="/register-device",
            status_code=None,
            response_json=None,
            error=str(e),
        )
        return False, {"error": str(e)}


def ensure_blockchain_identity(mac):
    """
    Ensure a MAC has a blockchain subject address + privkey, and is registered as a member.
    """
    ident = get_identity(mac)
    if ident and ident.get("subject_address"):
        return ident
    keys = load_ganache_keys()
    if not keys:
        return None

    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT subject_address FROM blockchain_identities")
    used = {row[0].lower() for row in c.fetchall()}
    conn.close()

    for addr, pk in keys:
        if addr in used:
            continue
        ok, body = register_device_on_chain(addr, mac, PGH_ACC_TYPE)
        if ok:
            save_identity(mac, addr, pk, member_type=PGH_ACC_TYPE)
            return get_identity(mac)
        # If device already has a role, try next key
        if isinstance(body, dict) and "message" in body and "already has a role" in str(body.get("message", "")).lower():
            continue

    if ALLOW_OFFLINE_IDENTITY:
        picked = pick_unused_wallet()
        if not picked:
            return None
        subject_address, private_key = picked
        record_chain_action(
            mac=mac,
            subject_address=subject_address,
            object_address=PGH_DB_OBJECT_ADDRESS,
            acc_type=PGH_ACC_TYPE,
            resource=None,
            action="register",
            decision="offline",
            endpoint="/register-device",
            status_code=None,
            response_json=None,
            error="registration failed; stored identity offline",
        )
        save_identity(mac, subject_address, private_key, member_type=PGH_ACC_TYPE)
        return get_identity(mac)

    return None


def ensure_contract_and_policy(mac, resource_names, object_address=None):
    """
    Ensure ACC is deployed for subject/object and a basic allow policy exists for given resources.
    resource_names: list of (resource, action)
    """
    object_address = object_address or PGH_DB_OBJECT_ADDRESS
    if not object_address:
        return None
    ident = ensure_blockchain_identity(mac)
    if not ident:
        return None
    subject_address = ident["subject_address"]
    contract_address = ident.get("contract_address")

    # Deploy ACC
    if not contract_address:
        try:
            started = datetime.now()
            resp = requests.post(
                f"{PGH_API_BASE}/deploy-contract",
                json={
                    "objectAddress": object_address,
                    "subjectAddress": subject_address,
                    "accType": PGH_ACC_TYPE,
                },
                timeout=PGH_HTTP_TIMEOUT,
            )
            duration_ms = int((datetime.now() - started).total_seconds() * 1000)
            body = None
            try:
                body = resp.json()
            except Exception:
                body = {"raw": resp.text}
            contract_address = None
            if resp.status_code == 200:
                contract_address = body.get("contractAddress") or body.get("contract_address")
            if contract_address:
                save_identity(mac, subject_address, ident["private_key"], contract_address=contract_address, member_type=PGH_ACC_TYPE)
                record_contract_binding(object_address, subject_address, PGH_ACC_TYPE, contract_address)
            req_bytes = len(json.dumps({
                "objectAddress": object_address,
                "subjectAddress": subject_address,
                "accType": PGH_ACC_TYPE,
            }).encode("utf-8"))
            resp_bytes = len(resp.content or b"")
            tx_hash = body.get("txHash") if isinstance(body, dict) else None
            tx_metrics = get_tx_metrics(tx_hash) if tx_hash else None
            record_chain_action(
                mac=mac,
                subject_address=subject_address,
                object_address=object_address,
                acc_type=PGH_ACC_TYPE,
                resource=None,
                action="deploy",
                decision="ok" if resp.status_code == 200 else "error",
                endpoint="/deploy-contract",
                status_code=resp.status_code,
                response_json=body,
                tx_hash=tx_hash,
                duration_ms=duration_ms,
                request_bytes=req_bytes,
                response_bytes=resp_bytes,
                gas_used=tx_metrics.get("gas_used") if tx_metrics else None,
                gas_cost_wei=tx_metrics.get("gas_cost_wei") if tx_metrics else None,
            )
        except Exception:
            record_chain_action(
                mac=mac,
                subject_address=subject_address,
                object_address=object_address,
                acc_type=PGH_ACC_TYPE,
                resource=None,
                action="deploy",
                decision="error",
                endpoint="/deploy-contract",
                status_code=None,
                response_json=None,
                error="deploy failed",
            )
            pass

    if not contract_address:
        return ident

    # Add allow policies for provided resources
    for res, action in resource_names:
        try:
            started = datetime.now()
            resp = requests.post(
                f"{PGH_API_BASE}/policies",
                json={
                    "objectAddress": object_address,
                    "subjectAddress": subject_address,
                    "accType": PGH_ACC_TYPE,
                    "resource": res,
                    "action": action,
                    "permission": "allow",
                },
                timeout=PGH_HTTP_TIMEOUT,
            )
            duration_ms = int((datetime.now() - started).total_seconds() * 1000)
            body = None
            try:
                body = resp.json()
            except Exception:
                body = {"raw": resp.text}
            req_bytes = len(json.dumps({
                "objectAddress": object_address,
                "subjectAddress": subject_address,
                "accType": PGH_ACC_TYPE,
                "resource": res,
                "action": action,
                "permission": "allow",
            }).encode("utf-8"))
            resp_bytes = len(resp.content or b"")
            tx_hash = body.get("txHash") if isinstance(body, dict) else None
            tx_metrics = get_tx_metrics(tx_hash) if tx_hash else None
            record_chain_action(
                mac=mac,
                subject_address=subject_address,
                object_address=object_address,
                acc_type=PGH_ACC_TYPE,
                resource=res,
                action=f"policy_allow:{action}",
                decision="ok" if resp.status_code == 200 else "error",
                endpoint="/policies",
                status_code=resp.status_code,
                response_json=body,
                tx_hash=tx_hash,
                duration_ms=duration_ms,
                request_bytes=req_bytes,
                response_bytes=resp_bytes,
                gas_used=tx_metrics.get("gas_used") if tx_metrics else None,
                gas_cost_wei=tx_metrics.get("gas_cost_wei") if tx_metrics else None,
            )
        except Exception:
            record_chain_action(
                mac=mac,
                subject_address=subject_address,
                object_address=object_address,
                acc_type=PGH_ACC_TYPE,
                resource=res,
                action=f"policy_allow:{action}",
                decision="error",
                endpoint="/policies",
                status_code=None,
                response_json=None,
                error="policy add failed",
            )
            # best effort
            continue

    return get_identity(mac)


def grant_access_policy(requestor_mac, target_mac):
    """
    Grant on-chain allow policies for a requestor to view a target's status/temps.
    """
    if not requestor_mac or not target_mac:
        return
    object_address = PGH_DB_OBJECT_ADDRESS
    if not object_address:
        return
    ident = ensure_blockchain_identity(requestor_mac)
    if not ident:
        return
    subject_address = ident["subject_address"]

    # Ensure ACC exists (no auto policy here)
    ensure_contract_and_policy(requestor_mac, [], object_address=object_address)

    resources = [
        (resource_for(target_mac, "status"), PGH_ACTION_VIEW),
        (resource_for(target_mac, "temps"), PGH_ACTION_VIEW),
    ]
    for res, action in resources:
        try:
            started = datetime.now()
            resp = requests.post(
                f"{PGH_API_BASE}/policies",
                json={
                    "objectAddress": object_address,
                    "subjectAddress": subject_address,
                    "accType": PGH_ACC_TYPE,
                    "resource": res,
                    "action": action,
                    "permission": "allow",
                },
                timeout=PGH_HTTP_TIMEOUT,
            )
            duration_ms = int((datetime.now() - started).total_seconds() * 1000)
            body = None
            try:
                body = resp.json()
            except Exception:
                body = {"raw": resp.text}
            req_bytes = len(json.dumps({
                "objectAddress": object_address,
                "subjectAddress": subject_address,
                "accType": PGH_ACC_TYPE,
                "resource": res,
                "action": action,
                "permission": "allow",
            }).encode("utf-8"))
            resp_bytes = len(resp.content or b"")
            tx_hash = body.get("txHash") if isinstance(body, dict) else None
            tx_metrics = get_tx_metrics(tx_hash) if tx_hash else None
            record_chain_action(
                mac=requestor_mac,
                subject_address=subject_address,
                object_address=object_address,
                acc_type=PGH_ACC_TYPE,
                resource=res,
                action=f"policy_allow:{action}",
                decision="ok" if resp.status_code == 200 else "error",
                endpoint="/policies",
                status_code=resp.status_code,
                response_json=body,
                tx_hash=tx_hash,
                duration_ms=duration_ms,
                request_bytes=req_bytes,
                response_bytes=resp_bytes,
                gas_used=tx_metrics.get("gas_used") if tx_metrics else None,
                gas_cost_wei=tx_metrics.get("gas_cost_wei") if tx_metrics else None,
            )
        except Exception as e:
            record_chain_action(
                mac=requestor_mac,
                subject_address=subject_address,
                object_address=object_address,
                acc_type=PGH_ACC_TYPE,
                resource=res,
                action=f"policy_allow:{action}",
                decision="error",
                endpoint="/policies",
                status_code=None,
                response_json=None,
                error=str(e),
            )
            continue

    record_pgh_status_snapshot()


def log_access_decision(requestor_mac, target_mac, resource_kind, action, local_allowed):
    """
    Log an access decision on-chain (allow or deny) and persist it locally.
    """
    if not requestor_mac:
        return
    if not PGH_DB_OBJECT_ADDRESS:
        return

    ident = ensure_blockchain_identity(requestor_mac) if AUTO_REGISTER_REQUESTOR else get_identity(requestor_mac)
    if not ident or not ident.get("private_key"):
        return

    # Ensure the ACC exists for subject/object; do not auto-allow policies here
    ensure_contract_and_policy(requestor_mac, [], object_address=PGH_DB_OBJECT_ADDRESS)

    resource = resource_for(target_mac, resource_kind)
    payload = {
        "subjectAddress": ident["subject_address"],
        "objectAddress": PGH_DB_OBJECT_ADDRESS,
        "accType": PGH_ACC_TYPE,
        "resource": resource,
        "action": action,
        "logOnChain": True,
        "subjectPrivateKey": ident["private_key"],
    }

    try:
        started = datetime.now()
        resp = requests.post(f"{PGH_API_BASE}/evaluate-access", json=payload, timeout=PGH_HTTP_TIMEOUT)
        duration_ms = int((datetime.now() - started).total_seconds() * 1000)
        body = None
        try:
            body = resp.json()
        except Exception:
            body = {"raw": resp.text}
        decision = "allow" if isinstance(body, dict) and body.get("allowed") else "deny"
        req_bytes = len(json.dumps(payload).encode("utf-8"))
        resp_bytes = len(resp.content or b"")
        tx_hash = body.get("txHash") if isinstance(body, dict) else None
        tx_metrics = get_tx_metrics(tx_hash) if tx_hash else None
        record_chain_action(
            mac=requestor_mac,
            subject_address=ident["subject_address"],
            object_address=PGH_DB_OBJECT_ADDRESS,
            acc_type=PGH_ACC_TYPE,
            resource=resource,
            action=action,
            decision=decision,
            endpoint="/evaluate-access",
            status_code=resp.status_code,
            response_json={"local_allowed": local_allowed, "pgh": body},
            tx_hash=tx_hash,
            duration_ms=duration_ms,
            request_bytes=req_bytes,
            response_bytes=resp_bytes,
            gas_used=tx_metrics.get("gas_used") if tx_metrics else None,
            gas_cost_wei=tx_metrics.get("gas_cost_wei") if tx_metrics else None,
        )
    except Exception as e:
        record_chain_action(
            mac=requestor_mac,
            subject_address=ident["subject_address"],
            object_address=PGH_DB_OBJECT_ADDRESS,
            acc_type=PGH_ACC_TYPE,
            resource=resource,
            action=action,
            decision="error",
            endpoint="/evaluate-access",
            status_code=None,
            response_json=None,
            error=str(e),
        )
        return

    # Capture token history after each on-chain evaluation
    record_pgh_status_snapshot()

    return decision if "decision" in locals() else None


def log_compare_on_chain(subject_mac, target_mac):
    log_access_decision(subject_mac, target_mac, "temps", PGH_ACTION_COMPARE, True)


# =====================================================
#  PGH proxy endpoints (for dashboard)
# =====================================================

@app.route("/pgh/status", methods=["GET"])
def pgh_status():
    try:
        resp = requests.get(f"{PGH_API_BASE}/status", timeout=PGH_HTTP_TIMEOUT)
        resp.raise_for_status()
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 502


@app.route("/pgh/metrics", methods=["GET"])
def pgh_metrics():
    try:
        resp = requests.get(f"{PGH_API_BASE}/metrics", timeout=PGH_HTTP_TIMEOUT)
        resp.raise_for_status()
        return resp.text, resp.status_code, {"Content-Type": "text/plain"}
    except Exception as e:
        return jsonify({"error": str(e)}), 502


@app.route("/pgh/peers", methods=["GET"])
def pgh_peers():
    try:
        resp = requests.get(f"{PGH_API_BASE}/ui/peers", timeout=PGH_HTTP_TIMEOUT)
        resp.raise_for_status()
        return jsonify(resp.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 502


@app.route("/pgh/demo-logs", methods=["GET"])
def pgh_demo_logs():
    if not os.path.isdir(DEMO_LOG_DIR):
        return jsonify([])
    files = [f for f in os.listdir(DEMO_LOG_DIR) if f.endswith(".json")]
    files = sorted(files, key=lambda f: os.path.getmtime(os.path.join(DEMO_LOG_DIR, f)), reverse=True)[:50]
    out = []
    for fname in files:
        fpath = os.path.join(DEMO_LOG_DIR, fname)
        try:
            with open(fpath, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            out.append({"file": fname, **data})
        except Exception:
            continue
    return jsonify(out)


@app.route("/chain/actions", methods=["GET"])
def chain_actions():
    limit = int(request.args.get("limit", 50))
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute(
        """
        SELECT * FROM chain_actions
        ORDER BY id DESC
        LIMIT ?
        """,
        (limit,),
    )
    rows = [dict(r) for r in c.fetchall()]
    conn.close()
    # decode JSON fields where possible
    for row in rows:
        if row.get("response_json"):
            try:
                row["response_json"] = json.loads(row["response_json"])
            except Exception:
                pass
    return jsonify(rows), 200


@app.route("/chain/bindings", methods=["GET"])
def chain_bindings():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute(
        """
        SELECT * FROM contract_bindings
        ORDER BY updated_at DESC
        LIMIT 200
        """
    )
    rows = [dict(r) for r in c.fetchall()]
    conn.close()
    return jsonify(rows), 200


@app.route("/chain/status-snapshots", methods=["GET"])
def chain_status_snapshots():
    limit = int(request.args.get("limit", 20))
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute(
        """
        SELECT * FROM chain_status_snapshots
        ORDER BY id DESC
        LIMIT ?
        """,
        (limit,),
    )
    rows = [dict(r) for r in c.fetchall()]
    conn.close()
    for row in rows:
        if row.get("status_json"):
            try:
                row["status_json"] = json.loads(row["status_json"])
            except Exception:
                pass
    return jsonify(rows), 200


@app.route("/chain/esp-summary", methods=["GET"])
def chain_esp_summary():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()

    c.execute("SELECT mac, last_seen, temperature, humidity FROM devices ORDER BY last_seen DESC")
    devices = [dict(r) for r in c.fetchall()]

    c.execute("SELECT mac, subject_address FROM blockchain_identities")
    identities = {r["mac"]: r["subject_address"] for r in c.fetchall()}

    # Latest chain action per mac
    c.execute("SELECT * FROM chain_actions ORDER BY id DESC")
    last_actions = {}
    for row in c.fetchall():
        mac = row["mac"]
        if not mac or mac in last_actions:
            continue
        last_actions[mac] = dict(row)

    # Latest status snapshot for balances
    c.execute("SELECT status_json FROM chain_status_snapshots ORDER BY id DESC LIMIT 1")
    row = c.fetchone()
    balances = {}
    if row and row["status_json"]:
        try:
            status_json = json.loads(row["status_json"])
            for entry in status_json.get("accountBalances", []) or []:
                addr = entry.get("address", "").lower()
                if addr:
                    balances[addr] = entry.get("balance")
        except Exception:
            pass
    conn.close()

    out = []
    for dev in devices:
        mac = dev.get("mac")
        subject = identities.get(mac)
        action = last_actions.get(mac, {})
        balance = balances.get(subject.lower(), None) if subject else None
        out.append({
            "mac": mac,
            "subject_address": subject,
            "last_seen": dev.get("last_seen"),
            "temperature": dev.get("temperature"),
            "humidity": dev.get("humidity"),
            "last_chain_action": action.get("action"),
            "last_chain_decision": action.get("decision"),
            "last_chain_timestamp": action.get("timestamp"),
            "last_chain_tx": action.get("tx_hash"),
            "token_balance": balance,
        })

    return jsonify(out), 200


@app.route("/simulations/list", methods=["GET"])
def simulations_list():
    out = []
    for key, cfg in SIM_SCRIPTS.items():
        out.append({
            "key": key,
            "command": " ".join(cfg.get("cmd", [])),
            "cwd": cfg.get("cwd", ROOT_DIR),
        })
    return jsonify(out), 200


@app.route("/simulations/run", methods=["POST"])
def simulations_run():
    if not request.is_json:
        return jsonify({"error": "JSON body required"}), 400
    data = request.get_json()
    script_key = data.get("script")
    env_overrides = data.get("env") or {}
    # Allow only a safe subset of env keys
    safe_env = {}
    for k in ["PGH_API_BASE", "PGH_A_BASE", "PGH_B_BASE", "RPC_URL", "METRICS_URL"]:
        if k in env_overrides:
            safe_env[k] = env_overrides[k]
    run_id, err = run_simulation_async(script_key, env_overrides=safe_env)
    if err:
        return jsonify({"error": err}), 400
    return jsonify({"status": "started", "run_id": run_id}), 200


@app.route("/simulations/runs", methods=["GET"])
def simulations_runs():
    limit = int(request.args.get("limit", 20))
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute(
        """
        SELECT * FROM simulation_runs
        ORDER BY started_at DESC
        LIMIT ?
        """,
        (limit,),
    )
    rows = [dict(r) for r in c.fetchall()]
    conn.close()
    return jsonify(rows), 200


@app.route("/simulations/runs/<run_id>", methods=["GET"])
def simulations_run_detail(run_id):
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("SELECT * FROM simulation_runs WHERE id = ?", (run_id,))
    row = c.fetchone()
    conn.close()
    if not row:
        return jsonify({"error": "run not found"}), 404
    data = dict(row)
    log_path = data.get("log_path")
    if log_path and os.path.exists(log_path):
        with open(log_path, "r", encoding="utf-8") as fh:
            data["log_tail"] = fh.read()[-8000:]
    return jsonify(data), 200

#  Routes

@app.route("/")
def index():
    return "<h2>✅ ESP32 Flask API is Running (PGH-enabled)</h2>", 200

@app.route("/favicon.ico")
def favicon():
    return "", 204

#  Endpoint: Receive ESP32 data
@app.route("/data", methods=["POST"])
def receive_data():
    if not request.is_json:
        return jsonify({"error": "Content-Type must be application/json"}), 400

    data = request.get_json()
    mac = data.get("mac", "UNKNOWN")
    temp = data.get("temperature")
    hum = data.get("humidity")

    try:
        temp = float(temp)
        hum = float(hum)
    except (TypeError, ValueError):
        return jsonify({"error": "temperature and humidity must be valid numbers"}), 400

    # Ensure the device exists on-chain and has default allow policies (best-effort)
    try:
        ensure_contract_and_policy(
            mac,
            [
                (resource_for(mac, "status"), PGH_ACTION_VIEW),
                (resource_for(mac, "temps"), PGH_ACTION_VIEW),
                (resource_for(mac, "temps"), PGH_ACTION_COMPARE),
            ],
            object_address=PGH_DB_OBJECT_ADDRESS,
        )
    except Exception:
        pass

    insert_log(mac, temp, hum)

    if temp > PGH_ALERT_THRESHOLD:
        try:
            log_compare_on_chain(mac, mac)
        except Exception:
            pass

    alert = "🔥 Temperature Exceeded!" if temp > PGH_ALERT_THRESHOLD else None
    return jsonify({"status": "stored", "mac": mac, "alert": alert}), 200

#  Devices and logs
@app.route("/devices", methods=["GET"])
def list_devices():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("SELECT * FROM devices")
    rows = [dict(row) for row in c.fetchall()]
    conn.close()
    return jsonify(rows), 200


@app.route("/logs/<mac>", methods=["GET"])
def logs_for_device(mac):
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("SELECT * FROM logs WHERE mac=? ORDER BY id DESC LIMIT 20", (mac,))
    rows = [dict(row) for row in c.fetchall()]
    conn.close()
    return jsonify(rows), 200

#  Status and temperature endpoints (with access control)

@app.route("/status/<mac>", methods=["GET"])
def status_for_device(mac):
    requestor_mac = request.headers.get("X-Requestor-MAC", "")
    requestor_group = request.headers.get("X-Requestor-Group", "")
    requestor_ip = request.remote_addr

    allowed = False
    access_granted_via_blockchain = False

    # 1) Self access
    if requestor_mac == mac:
        allowed = True
    # 2) Local approval systems (dashboard approval or granular access)
    elif is_mac_approved(mac) or is_access_allowed(requestor_mac, requestor_ip, mac):
        allowed = True
    # 3) Cross-group PGH logic: remote PGH calling on behalf of its ESP32
    elif requestor_group and is_peer_request_approved(requestor_group, requestor_mac, mac):
        allowed = True

    subject_mac = requestor_mac or mac

    if not allowed:
        try:
            chain_decision = log_access_decision(subject_mac, mac, "status", PGH_ACTION_VIEW, False)
            if chain_decision == "allow":
                allowed = True
                access_granted_via_blockchain = True
        except Exception:
            pass
        if not allowed:
            return jsonify({"error": "Access not approved"}), 403

    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("SELECT * FROM devices WHERE mac=?", (mac,))
    row = c.fetchone()
    conn.close()

    if not row:
        return jsonify({"error": "Device not found"}), 404

    last_seen_time = datetime.strptime(row["last_seen"], "%Y-%m-%d %H:%M:%S")
    is_active = (datetime.now() - last_seen_time) < timedelta(seconds=60)

    # Log access on-chain (best-effort)
    if not access_granted_via_blockchain:
        try:
            chain_decision = log_access_decision(subject_mac, mac, "status", PGH_ACTION_VIEW, True)
            if chain_decision == "deny":
                return jsonify({"error": "Access denied by blockchain"}), 403
        except Exception:
            pass

    return jsonify({
        "mac": row["mac"],
        "status": "active" if is_active else "inactive",
        "last_seen": row["last_seen"],
        "temperature": row["temperature"],
        "humidity": row["humidity"]
    }), 200


@app.route("/temps/<mac>", methods=["GET"])
def last_10_temps(mac):
    requestor_mac = request.headers.get("X-Requestor-MAC", "")
    requestor_group = request.headers.get("X-Requestor-Group", "")
    requestor_ip = request.remote_addr

    allowed = False
    access_granted_via_blockchain = False

    if requestor_mac == mac:
        allowed = True
    elif is_mac_approved(mac) or is_access_allowed(requestor_mac, requestor_ip, mac):
        allowed = True
    elif requestor_group and is_peer_request_approved(requestor_group, requestor_mac, mac):
        allowed = True

    subject_mac = requestor_mac or mac

    if not allowed:
        try:
            chain_decision = log_access_decision(subject_mac, mac, "temps", PGH_ACTION_VIEW, False)
            if chain_decision == "allow":
                allowed = True
                access_granted_via_blockchain = True
        except Exception:
            pass
        if not allowed:
            return jsonify({"error": "Access not approved"}), 403

    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("""
        SELECT temperature FROM logs
        WHERE mac = ?
        ORDER BY id DESC
        LIMIT 10
    """, (mac,))
    rows = c.fetchall()
    conn.close()

    temps = [row[0] for row in rows if row[0] is not None]
    temps.reverse()

    # Log access on-chain (best-effort)
    if not access_granted_via_blockchain:
        try:
            chain_decision = log_access_decision(subject_mac, mac, "temps", PGH_ACTION_VIEW, True)
            if chain_decision == "deny":
                return jsonify({"error": "Access denied by blockchain"}), 403
        except Exception:
            pass

    return jsonify({
        "mac": mac,
        "count": len(temps),
        "temperatures": temps
    }), 200


@app.route("/alerts/<mac>", methods=["GET"])
def get_alerts(mac):
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("""
        SELECT * FROM logs
        WHERE mac = ? AND alert_sent = 1
        ORDER BY timestamp DESC
        LIMIT 20
    """, (mac,))
    rows = [dict(row) for row in c.fetchall()]
    conn.close()
    return jsonify(rows), 200

#  Approval System (per-device dashboard approvals)
@app.route("/request-approval/<mac>", methods=["POST"])
def request_approval(mac):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # Auto-approve if it’s the same MAC
    requester_ip = request.remote_addr
    if "X-Requestor-MAC" in request.headers and request.headers["X-Requestor-MAC"] == mac:
        c.execute("""
            INSERT OR REPLACE INTO approvals (mac, requested_at, approved, approved_at)
            VALUES (?, ?, 1, ?)
        """, (mac, now, now))
    else:
        c.execute("""
            INSERT OR IGNORE INTO approvals (mac, requested_at, approved)
            VALUES (?, ?, 0)
        """, (mac, now))

    conn.commit()
    conn.close()
    return jsonify({"status": "approval requested", "mac": mac}), 200


@app.route("/approvals", methods=["GET"])
def get_pending_approvals():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("SELECT * FROM approvals WHERE approved = 0")
    rows = [dict(row) for row in c.fetchall()]
    conn.close()
    return jsonify(rows), 200


@app.route("/approve/<mac>", methods=["POST"])
def approve_mac(mac):
    # Restrict approval to localhost only
    if request.remote_addr not in ("127.0.0.1", "::1"):
        return jsonify({"error": "Approval allowed only from localhost"}), 403

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    try:
        c.execute("""
            INSERT OR IGNORE INTO approvals (mac, approved, approved_at)
            VALUES (?, 0, NULL)
        """, (mac,))
        c.execute("""
            UPDATE approvals SET approved = 1, approved_at = ? WHERE mac = ?
        """, (now, mac))
        conn.commit()
        return jsonify({"status": "MAC approved", "mac": mac, "approved_at": now}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        conn.close()


@app.route("/approval/<mac>", methods=["GET"])
def check_approval(mac):
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("SELECT approved, approved_at FROM approvals WHERE mac = ?", (mac,))
    row = c.fetchone()
    conn.close()
    if row:
        return jsonify(dict(row)), 200
    else:
        return jsonify({"approved": 0, "approved_at": None}), 200

#  Granular Access Control System (device-to-device)
@app.route("/approve-access", methods=["POST"])
def approve_access():
    # Restrict approval to localhost only
    if request.remote_addr not in ("127.0.0.1", "::1"):
        return jsonify({"error": "Access approval allowed only from localhost"}), 403

    data = request.get_json()
    requestor_mac = data.get("requestor_mac")
    requestor_ip = data.get("requestor_ip")
    target_mac = data.get("target_mac")

    if not requestor_mac or not requestor_ip or not target_mac:
        return jsonify({"error": "Missing fields"}), 400

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("""
        UPDATE access_grants SET approved_at = ?
        WHERE requestor_mac=? AND requestor_ip=? AND target_mac=?
    """, (now, requestor_mac, requestor_ip, target_mac))
    conn.commit()
    conn.close()

    # Grant on-chain policy for requestor -> target (view)
    try:
        grant_access_policy(requestor_mac, target_mac)
    except Exception:
        pass

    return jsonify({
        "status": "Access granted",
        "requestor_mac": requestor_mac,
        "target_mac": target_mac,
        "approved_at": now
    }), 200

#  PGH / Peer Group Head UI & Peer APIs

@app.route("/ui/peers", methods=["GET"])
def ui_peers():
    """
    Returns configured peer group heads for the UI or debugging.
    """
    return jsonify({
        "primary_group_id": PRIMARY_GROUP_ID,
        "peers": PEER_GROUPS
    }), 200


@app.route("/peer/incoming-request", methods=["POST"])
def peer_incoming_request():
    """
    Called by a remote primary group head when one of its ESP32 members
    wants to access a device under THIS group head.
    Body:
    {
      "peer_group_id": "pgh-a",
      "requestor_mac": "<MAC_UNDER_REMOTE>",
      "target_mac": "<MAC_UNDER_THIS_PI>"
    }
    """
    if not request.is_json:
        return jsonify({"error": "JSON required"}), 400

    data = request.get_json()
    peer_group_id = data.get("peer_group_id")
    requestor_mac = data.get("requestor_mac")
    target_mac = data.get("target_mac")

    if not peer_group_id or not requestor_mac or not target_mac:
        return jsonify({"error": "peer_group_id, requestor_mac, and target_mac are required"}), 400

    peer_ip = request.remote_addr
    if not is_peer_ip_allowed(peer_ip):
        return jsonify({"error": "Peer IP not allowed"}), 403

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("""
        INSERT INTO peer_access_requests (peer_group_id, peer_ip, requestor_mac, target_mac, requested_at, approved)
        VALUES (?, ?, ?, ?, ?, 0)
    """, (peer_group_id, peer_ip, requestor_mac, target_mac, now))
    conn.commit()
    conn.close()

    return jsonify({"status": "ok", "message": "request stored"}), 200


@app.route("/ui/peer/incoming-requests", methods=["GET"])
def ui_peer_incoming_requests():
    """
    Returns peer access requests for this PGH for UI display.
    """
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("""
        SELECT * FROM peer_access_requests
        ORDER BY requested_at DESC
        LIMIT 100
    """)
    rows = [dict(r) for r in c.fetchall()]
    conn.close()
    return jsonify(rows), 200


@app.route("/peer/approve-access", methods=["POST"])
def peer_approve_access():
    """
    Approve a peer access request (PGH-level).
    Called from the local dashboard UI only (localhost).
    Body:
    {
      "peer_group_id": "...",
      "requestor_mac": "...",
      "target_mac": "..."
    }
    """
    if request.remote_addr not in ("127.0.0.1", "::1"):
        return jsonify({"error": "Peer access approval allowed only from localhost"}), 403

    if not request.is_json:
        return jsonify({"error": "JSON body required"}), 400

    data = request.get_json()
    peer_group_id = data.get("peer_group_id")
    requestor_mac = data.get("requestor_mac")
    target_mac = data.get("target_mac")

    if not peer_group_id or not requestor_mac or not target_mac:
        return jsonify({"error": "peer_group_id, requestor_mac, target_mac required"}), 400

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("""
        UPDATE peer_access_requests
        SET approved = 1, approved_at = ?
        WHERE peer_group_id = ? AND requestor_mac = ? AND target_mac = ?
    """, (now, peer_group_id, requestor_mac, target_mac))
    conn.commit()
    conn.close()

    # Optional: map remote requestor to on-chain policy (best-effort)
    try:
        grant_access_policy(requestor_mac, target_mac)
    except Exception:
        pass

    return jsonify({
        "status": "approved",
        "peer_group_id": peer_group_id,
        "requestor_mac": requestor_mac,
        "target_mac": target_mac,
        "approved_at": now
    }), 200


@app.route("/peer/data-transfer", methods=["POST"])
def peer_data_transfer():
    """
    Remote group head sends a data transfer message, e.g:
    {
      "from_group_id": "pgh-a",
      "to_group_id": "pgh-b",
      "from_mac": "AA:BB:CC:DD:EE:FF",
      "to_mac": "11:22:33:44:55:66",
      "delta_value": 3.5,
      "message": "AA:BB... shared data..."
    }
    """
    if not request.is_json:
        return jsonify({"error": "JSON body required"}), 400

    data = request.get_json()
    from_group_id = data.get("from_group_id")
    to_group_id = data.get("to_group_id")
    from_mac = data.get("from_mac")
    to_mac = data.get("to_mac")
    delta_value = data.get("delta_value")
    message = data.get("message", "")

    if not from_group_id or not to_group_id or not from_mac or not to_mac:
        return jsonify({"error": "Missing from_group_id, to_group_id, from_mac, to_mac"}), 400

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("""
        INSERT INTO peer_transfers (from_group_id, to_group_id, from_mac, to_mac, delta_value, message, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (from_group_id, to_group_id, from_mac, to_mac, delta_value, message, now))
    conn.commit()
    conn.close()

    return jsonify({"status": "stored"}), 200


@app.route("/ui/transfers/incoming", methods=["GET"])
def ui_transfers_incoming():
    """
    Incoming transfer messages for devices under THIS primary group head.
    """
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("""
        SELECT * FROM peer_transfers
        WHERE to_group_id = ?
        ORDER BY created_at DESC
        LIMIT 100
    """, (PRIMARY_GROUP_ID,))
    rows = [dict(r) for r in c.fetchall()]
    conn.close()
    return jsonify(rows), 200


@app.route("/ui/transfers/outgoing", methods=["GET"])
def ui_transfers_outgoing():
    """
    Outgoing transfer messages sent from THIS primary group head.
    """
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("""
        SELECT * FROM peer_transfers
        WHERE from_group_id = ?
        ORDER BY created_at DESC
        LIMIT 100
    """, (PRIMARY_GROUP_ID,))
    rows = [dict(r) for r in c.fetchall()]
    conn.close()
    return jsonify(rows), 200

#  Entry point
if __name__ == "__main__":
    init_db()
    print(f"Flask ESP32 API (PGH={PRIMARY_GROUP_ID}) running on http://{ESP_API_HOST}:{ESP_API_PORT} using DB {DB_FILE}")
    app.run(host=ESP_API_HOST, port=ESP_API_PORT)
