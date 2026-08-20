# BetterDesk Desktop architecture

## Boundaries

`betterdesk-desktop` has three independently testable layers:

```text
Flutter UI
    │
    │ stable FFI/API boundary
    ▼
Owned Rust core
    ├── configuration and credential policy
    ├── protobuf and framed transport
    ├── RustDesk-compatible rendezvous/relay adapter
    ├── BetterDesk CDAP adapter
    ├── CDAP incoming desktop service (capture/input/media loop)
    ├── session state and capability negotiation
    ├── Windows capture/input and bounded media/file channels
    └── platform helper boundary
```

The UI does not parse remote protocol frames or implement elevation. The Rust
core validates and owns those operations. The CDAP desktop service handles
incoming `desktop_start`, input, resize, clipboard, audio, and session-end
messages, and emits bounded JPEG frames on the negotiated cadence. The Windows
boundary captures the primary desktop and injects only validated mouse and
keyboard events; file-transfer paths are constrained to an approved root.

## Session transport selection

The operator chooses a peer ID and the client probes the configured BetterDesk
server. The direct Go API is `:21114`; `:21121` is a legacy Node compatibility
proxy; native CDAP is `:21122`; RustDesk WebSocket signal/relay are `:21118`
and `:21119`. A RustDesk-compatible peer uses the rendezvous/relay adapter. A
BetterDesk native device uses the CDAP adapter. Both adapters expose the same
session state model to the UI. The API probe prefers HTTPS, falls back to
explicitly configured HTTP, and for a host without a scheme tries HTTPS before
the compatibility ports `80`, `21114`, and `21121`; an explicit HTTPS failure
is never silently downgraded:

```text
idle → connecting → authenticating → connected
  └──────────────→ failed
connected → reconnecting → connected
connected → disconnected
```

Capabilities are negotiated rather than assumed. A toolbar action is enabled
only when the active transport and peer advertise that capability. CDAP
registration uses the server's `register` envelope and includes
`remote_desktop`, `clipboard`, `file_transfer`, `audio`, and `multi_monitor`.
RustDesk registration uses `RegisterPk`; its relay remains opaque and does not
decode media.

## Device registration lifecycle

Saving configuration creates the durable identity, but the client sends
`RegisterPk` when the connection test is run. The Rust core performs this
asynchronously over the TLS-enabled RustDesk signal WebSocket and exposes the
result to Flutter:

```text
test connection
    └── RegisterPk(id, stable UUID, Ed25519 public key)
          ├── open    → peer row is persisted immediately
          ├── managed → pending_device_<id> is queued for approval
          └── locked  → rejected unless a valid enrollment token is bound
```

The panel's LAN `/api/bd/register-request` queue is a separate legacy
registration mechanism. A RustDesk-compatible `RegisterPk` request must not be
expected to appear there; in `open` mode it should appear directly in the
server's peer/device list.

## Wire protocol boundary

The protobuf schemas and the BetterDesk CDAP envelope are the interoperability
contract. The generated Rust
types are built from the repository-owned files in
`betterdesk-server/protos/`. The Rust core owns:

- bounded variable-length frame parsing;
- maximum frame/message limits;
- timeout and reconnect policy;
- endpoint and certificate policy;
- serialization and deserialization.

The implementation does not import RustDesk crates, source code, assets or
runtime binaries.

## UI performance

Frame decode and network I/O run outside the Flutter UI isolate. UI events are
coalesced before crossing the bridge. Session statistics are sampled at most
once per second, while input events are rate-limited and bounded. A session
can continue heartbeat/reconnect in tray mode without keeping a remote canvas
window open.

## Privileged operations

The UI requests a named operation from the Rust core. The core checks the
allowlist and invokes a platform-specific helper only for:

- machine-wide endpoint/key changes;
- unattended access and service configuration;
- system proxy and autostart/service changes;
- installation of updates.

The helper receives structured arguments, never a shell command, and returns a
typed result. The client itself remains unelevated.
