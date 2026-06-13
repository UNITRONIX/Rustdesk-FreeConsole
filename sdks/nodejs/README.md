# BetterDesk CDAP — Node.js SDK

Node.js SDK for the **Connected Device Automation Protocol (CDAP)** used by
BetterDesk server. Build custom bridges, IoT gateways, or automation agents
that expose widgets and handle commands through the BetterDesk web panel.

## Installation

```bash
npm install betterdesk-cdap
# or from local path
npm install ./sdks/nodejs
```

## Quick Start

```js
const { CDAPBridge, gauge, toggle } = require('betterdesk-cdap');

const bridge = new CDAPBridge({
  server: 'ws://your-betterdesk-server:21122/cdap',
  apiKey: 'YOUR_API_KEY',
  deviceName: 'Room Sensor',
  deviceType: 'sensor',
  bridgeName: 'room-sensor',
});

// Define widgets
bridge
  .addWidget(gauge('temperature', 'Temperature', { unit: '°C', min: -10, max: 50 }))
  .addWidget(toggle('heater', 'Heater'));

// Handle commands
bridge.onCommand('heater', ({ value }) => {
  console.log('Heater toggled to', value);
  return value; // returned value becomes new widget state
});

// Events
bridge.on('connected', () => console.log('Connected'));
bridge.on('registered', () => console.log('Registered'));
bridge.on('error', (err) => console.error(err));

// Start (blocks — reconnects automatically)
bridge.run();

// Push state changes at any time
setInterval(() => {
  bridge.updateState('temperature', 20 + Math.random() * 5);
}, 5000);
```

## Async Command Handlers

Handlers can return promises:

```js
bridge.onCommand('restart', async ({ params }) => {
  await someAsyncOperation(params);
  return true;
});
```

## API Reference

### `new CDAPBridge(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `server` | `string` | — | WebSocket URL (`ws://host:21122/cdap`) |
| `authMethod` | `string` | `'api_key'` | `api_key` / `device_token` / `user_password` |
| `apiKey` | `string` | `''` | API key (when `authMethod='api_key'`) |
| `deviceToken` | `string` | `''` | Device token |
| `username` | `string` | `''` | Username |
| `password` | `string` | `''` | Password |
| `deviceId` | `string` | `''` | Device ID (auto-assigned if empty) |
| `deviceName` | `string` | hostname | Display name |
| `deviceType` | `string` | `'bridge'` | Device type |
| `bridgeName` | `string` | `''` | Bridge identifier |
| `bridgeVersion` | `string` | `'1.0.0'` | Bridge version |
| `heartbeatSec` | `number` | `15` | Heartbeat interval (seconds) |
| `reconnectSec` | `number` | `5` | Initial reconnect delay |
| `maxReconnect` | `number` | `120` | Maximum reconnect delay |

### Methods

| Method | Description |
|--------|-------------|
| `addWidget(widget)` | Add a widget to the manifest |
| `onCommand(widgetId, handler)` | Register command handler for a widget |
| `updateState(widgetId, value)` | Push a single state update to server |
| `bulkUpdate({ id: value })` | Push multiple state updates |
| `fireAlert(id, severity, msg, details?)` | Fire an alert |
| `resolveAlert(id)` | Resolve a fired alert |
| `sendLog(level, msg, data?)` | Send a log entry |
| `run()` | Start (async, reconnects automatically) |
| `stop()` | Stop the bridge |

### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | — | WebSocket connected |
| `disconnected` | `{ code, reason }` | WebSocket closed |
| `registered` | payload | Registration confirmed |
| `command` | payload | Command received |
| `error` | `Error` | Error occurred |
| `message` | `{ type, payload }` | Any raw message |

### Widget Helpers

```js
const { gauge, toggle, button, textWidget, led, slider, select, chart, table } = require('betterdesk-cdap');
```

All helpers accept `(id, label, opts?)` and return a `Widget` object.

## Requirements

- Node.js >= 18.0.0
- BetterDesk server with CDAP enabled (port 21122)

## License

AGPL-3.0
