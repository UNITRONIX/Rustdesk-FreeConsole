# BetterDesk CDAP — Reference Bridges

This directory contains ready-to-use bridge implementations that connect
external systems to BetterDesk via the CDAP protocol. Each bridge uses
the **Python SDK** (`sdks/python/`) and can be deployed as a standalone
service alongside BetterDesk server.

## Available Bridges

| Bridge | Directory | Protocol | Use Case |
|--------|-----------|----------|----------|
| **Modbus** | `modbus/` | Modbus TCP / RTU | PLCs, VFDs, power meters, industrial I/O |
| **SNMP** | `snmp/` | SNMP v2c / v3 | Network switches, routers, UPS, printers |
| **REST Webhook** | `rest-webhook/` | HTTP REST | Home automation (HA, OpenHAB), cloud APIs |

## Architecture

```
External Device/API
       │
       ▼
┌──────────────┐
│  Bridge      │ ← polls/subscribes to external system
│  (Python)    │ ← pushes state updates to CDAP
│              │ ← receives commands from CDAP → writes to external system
└──────┬───────┘
       │ WebSocket (CDAP)
       ▼
┌──────────────┐
│ BetterDesk   │
│ CDAP Gateway │
│ (:21122)     │
└──────────────┘
```

## Quick Start

```bash
# 1. Install Python SDK
cd sdks/python
pip install -e .

# 2. Install bridge dependencies
cd bridges/modbus
pip install -r requirements.txt

# 3. Copy and edit config
cp config.example.json config.json
# edit config.json with your server URL, API key, and device addresses

# 4. Run
python bridge_modbus.py --config config.json
```

## Creating a Custom Bridge

Use the Python SDK directly:

```python
from betterdesk_cdap import CDAPBridge, gauge, toggle

bridge = CDAPBridge(
    server="ws://your-server:21122/cdap",
    api_key="YOUR_KEY",
    device_name="My Custom Bridge",
    device_type="bridge",
)

bridge.add_widget(gauge("sensor1", "Temperature", unit="°C", max_val=50))

@bridge.on_command("relay1")
async def handle_relay(action, value, **kw):
    # Write to your external system here
    return value

bridge.run()
```

See the [Python SDK README](../sdks/python/README.md) and
[Node.js SDK README](../sdks/nodejs/README.md) for full API reference.

## Configuration

All bridges use a shared configuration pattern:

```json
{
  "cdap": {
    "server": "ws://203.0.113.10:21122/cdap",
    "api_key": "YOUR_API_KEY",
    "device_name": "Bridge Name",
    "device_type": "bridge",
    "heartbeat_sec": 15
  },
  "bridge_specific_options": { }
}
```

## Deployment

Each bridge can run as:
- **systemd service** (Linux) — see `install/` in each bridge directory
- **Docker container** — `docker run` with mounted `config.json`
- **Screen/tmux session** — for testing

## License

AGPL-3.0
