# BetterDesk CDAP Python SDK

Build CDAP device bridges in Python for IoT sensors, industrial equipment, and automation systems.

## Installation

```bash
pip install betterdesk-cdap
# or from source
pip install -e sdks/python/
```

## Quick Start

```python
import asyncio
from betterdesk_cdap import CDAPBridge, gauge, toggle, button

# Create bridge
bridge = CDAPBridge(
    server="ws://203.0.113.10:21122/cdap",
    auth_method="api_key",
    api_key="your-api-key",
    device_name="Temperature Sensor",
    device_type="iot",
    tags=["factory-floor", "zone-a"],
)

# Define widgets
temp = bridge.add_widget(gauge("temp", "Temperature", unit="°C", max_val=50, warning_high=40))
humidity = bridge.add_widget(gauge("humidity", "Humidity", unit="%", max_val=100))
heater = bridge.add_widget(toggle("heater", "Heater", group="Controls"))
reboot = bridge.add_widget(button("reboot", "Reboot Device", confirm=True, icon="restart_alt"))

# Handle commands
@bridge.on_command("heater")
async def handle_heater(action, value, **kw):
    if action == "set":
        set_heater(value)  # your hardware control
        return {"new_state": value}

@bridge.on_command("reboot")
async def handle_reboot(action, **kw):
    if action == "trigger":
        os.system("reboot")
        return "rebooting"

# Run (blocks forever with auto-reconnect)
bridge.run()
```

## Async Usage

```python
async def main():
    bridge = CDAPBridge(server="ws://host:21122/cdap", api_key="key")
    bridge.add_widget(gauge("temp", "Temperature", unit="°C", max_val=100))

    @bridge.on_command("temp")
    async def handle(action, value, **kw):
        return {"ok": True}

    # Start bridge in background
    task = asyncio.create_task(bridge._run_forever())

    # Push state updates from your sensor loop
    while True:
        temp_value = read_sensor()
        await bridge.update_state("temp", temp_value)
        await asyncio.sleep(5)

asyncio.run(main())
```

## API Reference

### CDAPBridge

| Method | Description |
|--------|-------------|
| `add_widget(widget)` | Register a widget for the manifest |
| `on_command(widget_id)` | Decorator to handle commands |
| `update_state(widget_id, value)` | Push widget state update |
| `bulk_update(updates)` | Push multiple state updates |
| `fire_alert(alert_id, severity, message)` | Fire an alert |
| `resolve_alert(alert_id)` | Resolve an alert |
| `send_log(level, message)` | Send a log entry |
| `run()` | Blocking main loop |
| `stop()` | Signal shutdown |

### Widget Helpers

| Helper | Type | Key Options |
|--------|------|-------------|
| `gauge(id, label)` | Gauge | `unit`, `min_val`, `max_val`, `warning_high` |
| `toggle(id, label)` | Toggle | `value` |
| `button(id, label)` | Button | `icon`, `confirm`, `cooldown` |
| `text_widget(id, label)` | Text | `readonly`, `value` |
| `led(id, label)` | LED | `value` |
| `slider(id, label)` | Slider | `min_val`, `max_val`, `step` |
| `select(id, label)` | Select | `options` |
| `chart(id, label)` | Chart | `chart_type`, `points`, `series` |
| `table(id, label)` | Table | `columns`, `max_rows`, `sortable` |

## Requirements

- Python 3.9+
- `websockets >= 12.0`
