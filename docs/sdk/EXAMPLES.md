# SDK Integration Examples

## Modbus TCP Bridge (Python)

Monitors PLC registers and exposes them as CDAP widgets.

```python
# bridges/modbus/bridge.py
import asyncio, os
from betterdesk_cdap import CDAPBridge, Widget

class ModbusBridge(CDAPBridge):
    def __init__(self, config):
        super().__init__(
            server_url=config["server_url"],
            device_id=config["device_id"],
            device_name=config["device_name"],
            device_type="modbus_plc",
            api_key=config["api_key"]
        )
        self.plc_host = config["plc_host"]
        self.plc_port = config.get("plc_port", 502)
        self.registers = config["registers"]

        for reg in self.registers:
            self.add_widget(Widget.gauge(
                reg["widget_id"], reg["label"],
                group=reg.get("group", "Registers"),
                unit=reg.get("unit", ""),
                min_val=reg.get("min", 0),
                max_val=reg.get("max", 65535)
            ))

    async def collect_metrics(self):
        from pymodbus.client import AsyncModbusTcpClient
        async with AsyncModbusTcpClient(self.plc_host, port=self.plc_port) as client:
            values = {}
            for reg in self.registers:
                result = await client.read_holding_registers(reg["address"], count=reg.get("count", 1))
                if not result.isError():
                    values[reg["widget_id"]] = result.registers[0]
            return values
```

## SNMP Monitor (Python)

Polls SNMP OIDs from network devices.

```python
# bridges/snmp/bridge.py
import asyncio
from betterdesk_cdap import CDAPBridge, Widget

class SNMPBridge(CDAPBridge):
    def __init__(self, config):
        super().__init__(
            server_url=config["server_url"],
            device_id=f"SNMP-{config['target_ip'].replace('.', '-')}",
            device_name=config["device_name"],
            device_type="network_device",
            api_key=config["api_key"]
        )
        self.target_ip = config["target_ip"]
        self.community = config.get("community", "public")
        self.oids = config["oids"]

        for oid_cfg in self.oids:
            self.add_widget(Widget.text(oid_cfg["widget_id"], oid_cfg["label"],
                                         group=oid_cfg.get("group", "SNMP")))

    async def collect_metrics(self):
        from pysnmp.hlapi.v3arch.asyncio import (
            get_cmd, SnmpEngine, CommunityData, UdpTransportTarget,
            ContextData, ObjectType, ObjectIdentity,
        )
        values = {}
        for oid_cfg in self.oids:
            target = await UdpTransportTarget.create((self.target_ip, 161))
            err_ind, err_status, _, var_binds = await get_cmd(
                SnmpEngine(), CommunityData(self.community),
                target, ContextData(),
                ObjectType(ObjectIdentity(oid_cfg["oid"]))
            )
            if not err_ind and not err_status:
                values[oid_cfg["widget_id"]] = str(var_binds[0][1])
        return values
```

## REST Poller (Node.js)

Periodically fetches data from a REST API.

```javascript
// bridges/rest-webhook/bridge.js
const { CDAPBridge, Widget } = require('betterdesk-cdap');

const bridge = new CDAPBridge({
    serverUrl: process.env.CDAP_SERVER,
    deviceId: 'REST-API-001',
    deviceName: 'External API Monitor',
    deviceType: 'rest_poller',
    apiKey: process.env.CDAP_API_KEY,
    heartbeatSec: 30
});

bridge.addWidget(Widget.gauge('response_time', 'Response Time', {
    group: 'Performance', unit: 'ms', max: 5000, danger: 3000, warning: 1000
}));
bridge.addWidget(Widget.led('health', 'API Health', { group: 'Status' }));
bridge.addWidget(Widget.text('last_check', 'Last Check', { group: 'Info' }));

bridge.on('collectMetrics', async () => {
    const start = Date.now();
    try {
        const resp = await fetch('https://api.example.com/health');
        const elapsed = Date.now() - start;
        return {
            response_time: elapsed,
            health: resp.ok,
            last_check: new Date().toISOString()
        };
    } catch {
        return { response_time: 0, health: false, last_check: new Date().toISOString() };
    }
});

bridge.connect();
```

## Multi-Device Bridge Pattern

One bridge process managing multiple hardware devices:

```python
import asyncio
from betterdesk_cdap import CDAPBridge, Widget

async def main():
    bridges = []
    for sensor in load_sensor_config():
        bridge = SensorBridge(sensor)
        bridges.append(bridge.run())

    await asyncio.gather(*bridges)

asyncio.run(main())
```

Each bridge instance gets its own WebSocket connection and device identity.
