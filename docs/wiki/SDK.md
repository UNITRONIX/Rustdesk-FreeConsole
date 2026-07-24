# SDK

BetterDesk provides **Python** and **Node.js** SDKs for building **CDAP agents and bridges** that connect to the Go server CDAP gateway (port **21122**).

---

## Architecture

```
Your application
      │
      ▼
 CDAPBridge (SDK)  ── WebSocket ──►  Go server :21122/cdap
      │                                    │
      Widgets / metrics / commands         ▼
                                    Web Console (CDAP pages)
```

---

## Python SDK

**Package:** `betterdesk-cdap` · **Requires:** Python 3.8+

```bash
pip install betterdesk-cdap
```

```python
from betterdesk_cdap import CDAPBridge, Widget

bridge = CDAPBridge(
    server="ws://your-server:21122/cdap",
    api_key="your-api-key",
    device_id="SENSOR-001",
    device_name="Temperature Sensor",
    device_type="sensor",
)

bridge.add_widget(Widget.gauge("temperature", "Temperature", unit="°C", min=-20, max=50))
bridge.add_widget(Widget.toggle("heater", "Heater"))

@bridge.on_command("heater")
async def on_heater(action, params):
    return {"success": True}

bridge.set_value("temperature", 22.5)
await bridge.connect()
```

Source: [sdks/python/](https://github.com/UNITRONIX/BetterDesk/tree/main/sdks/python)

---

## Node.js SDK

**Package:** `betterdesk-cdap` · **Requires:** Node.js 18+

```bash
npm install betterdesk-cdap
```

```javascript
const { CDAPBridge, Widget } = require('betterdesk-cdap');

const bridge = new CDAPBridge({
  server: 'ws://your-server:21122/cdap',
  apiKey: 'your-api-key',
  deviceId: 'SENSOR-001',
  deviceName: 'Temperature Sensor',
  deviceType: 'sensor',
});

bridge.addWidget(Widget.gauge('temperature', 'Temperature', { unit: '°C' }));
bridge.setValue('temperature', 22.5);
bridge.connect();
```

Source: [sdks/nodejs/](https://github.com/UNITRONIX/BetterDesk/tree/main/sdks/nodejs)

---

## Key concepts

| Concept | Description |
|---------|-------------|
| **CDAPBridge** | WebSocket client — auth, heartbeat, reconnect |
| **Widget** | UI element rendered in panel (gauge, toggle, button, …) |
| **Manifest** | Device capabilities sent on connect |
| **Command** | Panel → device action with response |

Enable CDAP on the server: `-cdap` flag or `CDAP_ENABLED=Y`.

---

## Reference bridges

Pre-built protocol bridges in the repo:

| Bridge | Protocol |
|--------|----------|
| `bridges/modbus/` | Modbus TCP/RTU |
| `bridges/snmp/` | SNMP v2c/v3 |
| `bridges/rest-webhook/` | REST polling + webhooks |

---

## See also

- [[CDAP]] — wire protocol and gateway
- [[Web Console|Web-Console]] — CDAP Studio and device pages
- [SDK overview](https://github.com/UNITRONIX/BetterDesk/blob/main/docs/sdk/OVERVIEW.md)
