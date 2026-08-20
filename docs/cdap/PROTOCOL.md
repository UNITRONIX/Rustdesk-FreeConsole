# CDAP Protocol Specification

> Version 0.4.0 — BetterDesk Desktop desktop-session interoperability
>
> The Go implementation in `betterdesk-server/cdap` is the normative wire
> contract. This document describes the public subset used by native clients.

## Transport

- **WebSocket** on port `21122`, path `/cdap`
- Subprotocol: `cdap-v1`
- Text frames: JSON messages
- Binary frames: desktop media uses a 64-byte NUL-padded session ID followed by
  the encoded payload. Do not use the legacy 1-byte prefix for desktop frames.

## Authentication

```json
{
  "type": "auth",
  "device_id": "CDAP-6A9A5452",
  "method": "api_key",
  "token": "your-api-key-here",
  "protocol_version": "0.3.0"
}
```

Server responds with:

```json
{
  "type": "auth_result",
  "success": true,
  "server_version": "3.0.0"
}
```

### Auth Methods
| Method | Credentials field |
|--------|-------------------|
| `api_key` | API key string |
| `device_token` | Device-specific token |
| `user_password` | `"username:password"` |

## Manifest Registration

After auth, the device sends a `register` message containing its manifest:

```json
{
  "type": "register",
  "manifest": {
    "manifest_version": "1.0",
    "device": {
      "name": "BetterDesk Desktop",
      "type": "desktop",
      "vendor": "BetterDesk"
    },
    "capabilities": [
      "remote_desktop", "keyboard_input", "mouse_input",
      "multi_monitor", "clipboard", "file_transfer", "audio"
    ],
    "widgets": [
    {
      "id": "sys_cpu",
      "type": "gauge",
      "label": "CPU Usage",
      "group": "System",
      "unit": "%",
      "min": 0,
      "max": 100,
      "danger": 90,
      "warning": 70
    },
    {
      "id": "sys_memory",
      "type": "gauge",
      "label": "Memory Usage",
      "group": "System",
      "unit": "%",
      "min": 0,
      "max": 100
    },
    {
      "id": "reboot_btn",
      "type": "button",
      "label": "Reboot",
      "group": "Actions",
      "command": "system_reboot",
      "confirm": true
    }
  ],
    "heartbeat_interval": 15
  }
}
```

## Message Types

### Agent → Server

| Type | Description | Payload |
|------|-------------|---------|
| `auth` | Authentication request | `device_id`, `method`, `token` or `username` + `password` |
| `register` | Device manifest + widgets | `manifest: {...}` |
| `heartbeat` | Periodic health check | `metrics: { cpu, memory, disk }`, `widget_values: {...}` |
| `state_update` | Single widget value change | `widget_id`, `value` |
| `bulk_update` | Multiple widget values | `values: { widget_id: value, ... }` |
| `command_response` | Command execution result | `command_id`, `success`, `result`, `error` |
| `terminal_output` | Terminal PTY output | `session_id`, `data` (base64) |
| `terminal_end` | Terminal session ended | `session_id`, `exit_code` |
| `file_list_response` | Directory listing | `request_id`, `entries: [{ name, size, is_dir, modified }]` |
| `file_read_response` | File content chunk | `request_id`, `data` (base64), `offset`, `total` |
| `file_write_response` | Write confirmation | `request_id`, `success`, `bytes_written` |
| `file_delete_response` | Delete confirmation | `request_id`, `success` |
| `clipboard_update` | Clipboard content from device | `format`, `data` |
| `audio_frame` | Audio data | `codec`, `data` (base64), `timestamp`, `sequence` |
| `audio_end` | Audio session ended | `session_id` |
| `cursor_update` | Cursor image data | `format`, `width`, `height`, `hotspot_x`, `hotspot_y`, `data` |
| `codec_answer` | Codec negotiation response | `codec`, `parameters` |
| `monitor_list` | Available monitors | `monitors: [{ id, name, width, height, primary }]` |
| `key_exchange` | Encryption key relay | `public_key`, `algorithm` |
| `alert` | Device-initiated alert | `severity`, `message`, `source` |
| `pong` | Keepalive response | — |

### Server → Agent

| Type | Description | Payload |
|------|-------------|---------|
| `auth_result` | Auth result | `success`, `error`, `session_token?` |
| `command` | Execute command | `command_id`, `command`, `args` |
| `terminal_start` | Start terminal session | `session_id`, `shell`, `cols`, `rows` |
| `terminal_input` | Terminal input data | `session_id`, `data` (base64) |
| `terminal_resize` | Resize terminal | `session_id`, `cols`, `rows` |
| `terminal_kill` | Kill terminal session | `session_id` |
| `file_list` | Request directory listing | `request_id`, `path` |
| `file_read` | Request file content | `request_id`, `path`, `offset`, `length` |
| `file_write` | Write file content | `request_id`, `path`, `data` (base64), `offset` |
| `file_delete` | Delete file/directory | `request_id`, `path` |
| `clipboard_set` | Set device clipboard | `format`, `data` |
| `screenshot_capture` | Request screenshot | `request_id` |
| `state_request` | Request current state | — |
| `config_update` | Push config changes | `config: {...}` |
| `alert_ack` | Acknowledge alert | `alert_id` |
| `codec_offer` | Codec negotiation offer | `codecs: [...]` |
| `monitor_select` | Select active monitor | `monitor_id` |
| `keyframe_request` | Request video keyframe | — |
| `quality_report` | Quality metrics from browser | `bandwidth_kb`, `latency_ms`, `frame_loss`, `fps` |
| `ping` | Keepalive request | — |

## Desktop Session

`desktop_start` is sent to the authenticated device and includes
`session_id`, `width`, `height`, `quality`, `fps`, `codecs`, and optional
`view_only`. The device returns `desktop_frame` JSON messages with a base64
JPEG for compatibility clients, or the binary fast path described above.

The server forwards `desktop_input`, `desktop_resize`, `clipboard_set`,
`file_*`, and `audio_input` to the device. The device may return
`clipboard_update`, `file_*_response`, `audio_frame`, `desktop_meta`,
`monitor_list`, and `desktop_end`. File access must remain bounded to an
operator-approved root; a client must reject arbitrary host paths.

## Widget Types

| Type | Fields | Description |
|------|--------|-------------|
| `gauge` | `min`, `max`, `unit`, `danger`, `warning` | Horizontal bar gauge |
| `toggle` | `on_command`, `off_command` | On/off switch |
| `button` | `command`, `confirm` | Action button |
| `led` | `on_color`, `off_color` | Status LED indicator |
| `text` | — | Read-only text display |
| `slider` | `min`, `max`, `step`, `command` | Adjustable slider |
| `select` | `options`, `command` | Dropdown selector |
| `chart` | `max_points` | Time-series bar chart |

## Error Handling

Error messages use the `error` type:

```json
{
  "type": "error",
  "code": "AUTH_FAILED",
  "message": "Invalid API key"
}
```

| Code | Description |
|------|-------------|
| `AUTH_FAILED` | Authentication failure |
| `INVALID_MESSAGE` | Malformed message |
| `UNKNOWN_COMMAND` | Unrecognized command |
| `RATE_LIMITED` | Too many messages |
| `SESSION_EXPIRED` | Session timed out |

## Keepalive

Server sends `ping` every 30 seconds. Agent must respond with `pong` within 10 seconds or connection is closed.
