# BetterDesk CDAP — SDKs & Bridges

Software Development Kits and reference bridge implementations for the
**Connected Device Automation Protocol (CDAP)** used by BetterDesk server.

## SDKs

| SDK | Directory | Language | Status |
|-----|-----------|----------|--------|
| **Python** | [`sdks/python/`](sdks/python/) | Python 3.9+ | ✅ Stable |
| **Node.js** | [`sdks/nodejs/`](sdks/nodejs/) | Node.js 18+ | ✅ Stable |

## Reference Bridges

| Bridge | Directory | Protocol | Use Case |
|--------|-----------|----------|----------|
| **Modbus** | [`bridges/modbus/`](bridges/modbus/) | Modbus TCP/RTU | PLCs, VFDs, power meters |
| **SNMP** | [`bridges/snmp/`](bridges/snmp/) | SNMP v2c/v3 | Switches, routers, UPS |
| **REST/Webhook** | [`bridges/rest-webhook/`](bridges/rest-webhook/) | HTTP | Home Assistant, cloud APIs |

## Native Agent

The **BetterDesk Agent** is a standalone Go binary that runs on target devices,
providing system monitoring, terminal access, file browsing, screenshots, and
clipboard sync through CDAP.

| Component | Directory | Language |
|-----------|-----------|----------|
| **Agent** | [`betterdesk-agent/`](betterdesk-agent/) | Go 1.25+ |

## Quick Start

### Python Bridge

```bash
pip install ./sdks/python
pip install pymodbus  # for Modbus bridge
cd bridges/modbus
cp config.example.json config.json
python bridge_modbus.py -c config.json
```

### Node.js Bridge

```js
const { CDAPBridge, gauge, toggle } = require('./sdks/nodejs');

const bridge = new CDAPBridge({
  server: 'ws://your-server:21122/cdap',
  apiKey: 'KEY',
  deviceName: 'My Bridge',
});
bridge.addWidget(gauge('temp', 'Temperature'));
bridge.run();
```

### Go Agent

```bash
cd betterdesk-agent
go build -o betterdesk-agent .
./betterdesk-agent -server ws://your-server:21122/cdap -auth api_key -key YOUR_KEY
```

## CDAP Protocol Overview

CDAP uses WebSocket (port 21122) with JSON messages:

```
Device/Bridge → Server:
  auth → auth_result
  register → registered
  heartbeat → heartbeat_ack
  state_update (widget values)
  alert / alert_resolve
  log

Server → Device/Bridge:
  command (widget_id, action, value, params)
  terminal_start / terminal_data / terminal_resize
  file_list / file_read / file_write / file_delete
  clipboard_set
  desktop_start / desktop_input
```

Authentication methods: `api_key`, `device_token`, `user_password`.

## License

AGPL-3.0
