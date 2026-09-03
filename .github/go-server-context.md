# BetterDesk Go Server — Clean-Room Implementation Context

> This file is automatically included in every Copilot conversation context.
> It contains the complete specification for building a clean-room RustDesk-compatible server in Go.

---

## 🎯 Project Goal

Build a **clean-room** signal + relay server in **Go** that is 100% compatible with existing
RustDesk clients (desktop, mobile, web) but completely independent of the AGPL-3.0 RustDesk
server codebase. The result is a single binary called **`betterdesk-server`** that replaces
both `hbbs` (signal) and `hbbr` (relay).

### Legal Basis

- Do not infer the provenance or copyright status of `.proto` files from their
  protocol role or file headers. Existing schemas are subject to the provenance
  gate in `docs/important/support-agent-provenance.md`.
- Do not copy external source, generated artifacts, comments, or test fixtures.
  Implement only from BetterDesk-owned specifications and independently
  authored black-box test vectors.
- Do not make clean-room or relicensing claims in code, documentation, or
  release notes until the provenance register has been reviewed.

---

## 📊 Current Status

| ID | Task | Status | Notes |
|----|------|--------|-------|
| 0.1 | Create Go project skeleton (`betterdesk-server/`) | ✅ done | `go mod init`, folder structure |
| 0.2 | Compile protobuf → Go structs | ✅ done | `rendezvous.pb.go` + `message.pb.go` (12K LOC) |
| 0.3 | Implement AddrMangle (encode/decode) | ✅ done | `crypto/addr_mangle.go` + tests |
| 0.4 | Implement framing codec (TCP) | ✅ done | `codec/` — 2-byte BE length prefix + protobuf |
| 0.5 | Implement Ed25519 key management | ✅ done | `crypto/keys.go` + `crypto/secure.go` (NaCl) |
| 0.6 | Implement UDP signal listener (port 21116) | ✅ done | `signal/server.go` — RegisterPeer, PunchHole, etc. |
| 0.7 | Implement TCP signal listener (port 21116) | ✅ done | `signal/server.go` — NaCl key exchange + fallback |
| 0.8 | Implement NAT test listener (port 21115) | ✅ done | `signal/handler.go` — TestNatRequest/Response |
| 0.9 | Implement WebSocket signal (port 21118) | ✅ done | `signal/ws.go` — coder/websocket |
| 0.10 | Implement relay (TCP port 21117) | ✅ done | `relay/server.go` — UUID pairing + io.Copy |
| 0.11 | Implement relay WebSocket (port 21119) | ✅ done | `relay/ws.go` — websocket relay |
| 0.12 | Implement HTTP API (port 21114) | ✅ done | `api/server.go` + `api/auth_handlers.go` (1493 LOC) |
| 0.13 | Implement SQLite database layer | ✅ done | `db/sqlite.go` (702 LOC) — full `Database` interface |
| 0.14 | Implement peer map (in-memory) | ✅ done | `peer/map.go` (469 LOC) — concurrent with heartbeat |
| 0.15 | Implement ban system | ✅ done | Checked at registration, relay, and API |
| 0.16 | Implement ID change | ✅ done | `RegisterPk.old_id` + API endpoint + history |
| 0.17 | Implement bandwidth limiting | ✅ done | `ratelimit/bandwidth.go` — token bucket |
| 0.18 | Implement blacklist/blocklist | ✅ done | `security/blocklist.go` — IP/ID/CIDR |
| 0.19 | Integration tests with real RustDesk client | ✅ done | Desktop + web client tested |
| 0.20 | Cross-compile (Linux amd64, arm64, Windows) | ✅ done | development builds available |

### Phase 2 — Security & Protocol Hardening (NEW)

| ID | Task | Status | Notes |
|----|------|--------|-------|
| 1.1 | **H1**: Validate `new_id` in change-id API | ✅ done | `peerIDRegexp` check added in `api/server.go` |
| 1.2 | **H3**: Rate-limit on `/api/auth/login/2fa` | ✅ done | `loginLimiter.Allow(clientIP)` + audit log |
| 1.3 | **H4**: Short TTL for partial 2FA token | ✅ done | `GenerateWithTTL()` 5min in `auth/jwt.go` |
| 1.4 | **M1**: Escape `%`/`_` in SQL LIKE patterns | ✅ done | `ESCAPE '\'` clause in `db/sqlite.go` |
| 1.5 | **M4**: Rate-limit TCP signal connections | ✅ done | `limiter.Allow(host)` in `serveTCP()` |
| 1.6 | **M6**: Validate config key names | ✅ done | `configKeyRegexp` in `api/server.go` |
| 1.7 | **M8**: `ConfigUpdate` in `TestNatResponse` | ✅ done | `Cu` field with relay/rendezvous servers |
| 1.8 | **M2**: TTL for `tcpPunchConns` sync.Map | ✅ done | 2min TTL + 10K cap + cleanup goroutine |
| 1.9 | **M3**: WebSocket origin validation | ✅ done | `WS_ALLOWED_ORIGINS` env var + `OriginPatterns` |
| 1.10 | **M7**: Relay idle timeout | ✅ done | `idleTimeoutConn` wrapper extending deadline on R/W |

### Phase 3 — TLS Everywhere ✅ COMPLETED 2026-02-28

| ID | Task | Status | Notes |
|----|------|--------|-------|
| 2.1 | TLS for TCP signal (:21116) | ✅ done | `DualModeListener` auto-detects plain vs TLS |
| 2.2 | TLS for TCP relay (:21117) | ✅ done | Same `DualModeListener` pattern |
| 2.3 | WSS for signal + relay | ✅ done | `ListenAndServeTLS` with shared `LoadTLSConfig` |
| 2.4 | Auto-detect plain/TLS on same port | ✅ done | First-byte `0x16` detection (`peekedConn`) |
| 2.5 | Config flags + env vars | ✅ done | `--tls-signal`, `--tls-relay` + `TLS_SIGNAL=Y`, `TLS_RELAY=Y` |

### Phase 4 — PostgreSQL Integration (NEW)

| ID | Task | Status | Notes |
|----|------|--------|-------|
| 3.1 | `db/postgres.go` implementation | ⬜ todo | Full `Database` interface via `pgx/v5` |
| 3.2 | `db/open.go` dispatcher | ⬜ todo | Detect `postgres://` DSN |
| 3.3 | Connection pooling (`pgxpool`) | ⬜ todo | Configurable max conns |
| 3.4 | PostgreSQL schema + types | ⬜ todo | BOOLEAN, BYTEA, TIMESTAMPTZ |
| 3.5 | `LISTEN/NOTIFY` events | ⬜ todo | Real-time push between instances |
| 3.6 | Integration tests | ⬜ todo | PostgreSQL backend tests |

### Phase 5 — Migration Tool (NEW)

| ID | Task | Status | Notes |
|----|------|--------|-------|
| 4.1 | `tools/migrate/main.go` | ⬜ todo | CLI migration binary |
| 4.2 | Original RustDesk → BetterDesk | ⬜ todo | `peer` → `peers` schema mapping |
| 4.3 | BetterDesk SQLite → PostgreSQL | ⬜ todo | Full schema migration |
| 4.4 | Node.js tables migration | ⬜ todo | address_books, groups, sysinfo |
| 4.5 | Reverse: PG → SQLite | ⬜ todo | Downgrade/testing |
| 4.6 | ALL-IN-ONE script integration | ⬜ todo | betterdesk.sh / .ps1 |

---

## 🏗️ Architecture — Single Binary

```
betterdesk-server [--port 21116] [--relay-port 21117] [--api-port 21114] [--key <base64>]

Modes (all run by default in a single process):
  --mode=all       ← default, runs signal + relay + api in one process
  --mode=signal    ← only signal server (hbbs equivalent)
  --mode=relay     ← only relay server (hbbr equivalent)
```

### Why single binary is possible and better:

1. **RustDesk has two binaries for historical reasons** — hbbs and hbbr are separate
   processes because they were originally separate Rust crates. There is no technical
   requirement for this separation.
2. **Go goroutines** make it trivial to run multiple listeners in one process — each
   listener (UDP, TCP, WS, relay) runs in its own goroutine.
3. **Shared state** — signal server needs to tell clients which relay to use. In a single
   binary, this is just a reference to a struct; in two binaries, you need IPC or config.
4. **Simpler deployment** — one binary, one systemd service, one Docker container.
5. **Optional separation** — the `--mode` flag still allows running signal-only or
   relay-only for large-scale deployments with separate relay nodes.

### Folder Structure

```
betterdesk-server/
├── main.go                    # Entry point, flag parsing, mode selection
├── go.mod
├── go.sum
├── proto/                     # Generated Go protobuf code
│   ├── rendezvous.pb.go
│   └── message.pb.go
├── signal/                    # Signal server (hbbs equivalent)
│   ├── server.go              # UDP/TCP/WS listeners, main loop
│   ├── handler.go             # Message handlers (RegisterPeer, PunchHole, etc.)
│   ├── nat.go                 # NAT test (port 21115)
│   └── online.go              # OnlineRequest/Response handler
├── relay/                     # Relay server (hbbr equivalent)
│   ├── server.go              # TCP/WS listeners
│   ├── pair.go                # UUID-based stream pairing
│   ├── bandwidth.go           # Rate limiting (per-conn + total)
│   └── blacklist.go           # IP blacklist/blocklist
├── api/                       # HTTP REST API (port 21114)
│   ├── server.go              # Router setup
│   ├── handlers.go            # Endpoint handlers
│   └── middleware.go          # API key auth, CORS
├── crypto/                    # Cryptographic utilities
│   ├── keys.go                # Ed25519 key generation, loading, signing
│   └── addr_mangle.go         # AddrMangle encode/decode
├── codec/                     # Wire protocol
│   ├── framing.go             # TCP framing (2-byte BE length + protobuf)
│   └── ws.go                  # WebSocket adapter
├── db/                        # Database layer
│   ├── sqlite.go              # SQLite operations (modernc.org/sqlite or mattn/go-sqlite3)
│   ├── models.go              # Peer, Config structs
│   └── migrations.go          # Schema creation + migrations
├── peer/                      # Peer management
│   ├── map.go                 # Concurrent peer map (sync.RWMutex)
│   ├── status.go              # Online/offline/degraded/critical tracking
│   └── ban.go                 # Device ban logic
└── config/                    # Configuration
    ├── config.go              # CLI flags, env vars, defaults
    └── constants.go           # Timeouts, ports, limits
```

---

## 📡 Protocol Specification (from .proto files)

### Package: `hbb`

All messages use protobuf3 with package name `hbb`.

### rendezvous.proto — Complete Message List

```protobuf
// RendezvousMessage is the top-level envelope for ALL signal communication
message RendezvousMessage {
  oneof union {
    RegisterPeer           register_peer            = 6;
    RegisterPeerResponse   register_peer_response   = 7;
    PunchHoleRequest       punch_hole_request       = 8;
    PunchHole              punch_hole               = 9;
    PunchHoleSent          punch_hole_sent          = 10;
    PunchHoleResponse      punch_hole_response      = 11;
    FetchLocalAddr         fetch_local_addr         = 12;
    LocalAddr              local_addr               = 13;
    ConfigUpdate           configure_update         = 14;
    RegisterPk             register_pk              = 15;
    RegisterPkResponse     register_pk_response     = 16;
    SoftwareUpdate         software_update          = 17;
    RequestRelay           request_relay            = 18;
    RelayResponse          relay_response           = 19;
    TestNatRequest         test_nat_request         = 20;
    TestNatResponse        test_nat_response        = 21;
    PeerDiscovery          peer_discovery           = 22;
    OnlineRequest          online_request           = 23;
    OnlineResponse         online_response          = 24;
    KeyExchange            key_exchange             = 25;
    HealthCheck            hc                       = 26;
  }
}
```

### Key Messages Detail

```protobuf
// Client registers its presence (heartbeat) — sent via UDP every ~12s
message RegisterPeer { string id = 1; int32 serial = 2; }
message RegisterPeerResponse { bool request_pk = 2; }

// Client registers its public key (first time or key rotation)
message RegisterPk {
  string id = 1;
  bytes uuid = 2;        // Device UUID (unique per installation)
  bytes pk = 3;           // Ed25519 public key (32 bytes)
  string old_id = 4;     // If set → ID change request (old_id → id)
  bool no_register_device = 5;
}
message RegisterPkResponse {
  enum Result { OK=0; UUID_MISMATCH=2; ID_EXISTS=3; TOO_FREQUENT=4;
                INVALID_ID_FORMAT=5; NOT_SUPPORT=6; SERVER_ERROR=7; }
  Result result = 1;
  int32 keep_alive = 2;  // Suggested heartbeat interval in seconds
}

// Hole punching flow
message PunchHoleRequest {
  string id = 1;          // Target peer ID
  NatType nat_type = 2;
  string licence_key = 3; // Must match server key
  ConnType conn_type = 4;
  string token = 5;
  string version = 6;
  int32 udp_port = 7;
  bool force_relay = 8;
  int32 upnp_port = 9;
  bytes socket_addr_v6 = 10;
}

// Server sends to TARGET peer: "someone wants to connect, here's their addr"
message PunchHole {
  bytes socket_addr = 1;     // Requester's mangled address
  string relay_server = 2;   // Fallback relay address
  NatType nat_type = 3;
  int32 udp_port = 4;
  bool force_relay = 5;
  int32 upnp_port = 6;
  bytes socket_addr_v6 = 7;
  ControlPermissions control_permissions = 8;
}

// Server sends to REQUESTER: "target's addr for direct punch"
message PunchHoleSent {
  bytes socket_addr = 1;     // Target's mangled address
  string id = 2;
  string relay_server = 3;
  NatType nat_type = 4;
  string version = 5;
  int32 upnp_port = 6;
  bytes socket_addr_v6 = 7;
}

// Target responds to requester with result
message PunchHoleResponse {
  bytes socket_addr = 1;
  bytes pk = 2;              // Target's public key
  enum Failure { ID_NOT_EXIST=0; OFFLINE=2; LICENSE_MISMATCH=3; LICENSE_OVERUSE=4; }
  Failure failure = 3;
  string relay_server = 4;
  oneof union { NatType nat_type = 5; bool is_local = 6; }
  string other_failure = 7;
  int32 feedback = 8;
  bool is_udp = 9;
  int32 upnp_port = 10;
  bytes socket_addr_v6 = 11;
}

// Relay request (when direct connection fails)
message RequestRelay {
  string id = 1;             // Target peer ID
  string uuid = 2;           // Session UUID for pairing
  bytes socket_addr = 3;
  string relay_server = 4;
  bool secure = 5;
  string licence_key = 6;
  ConnType conn_type = 7;
  string token = 8;
  ControlPermissions control_permissions = 9;
}

message RelayResponse {
  bytes socket_addr = 1;
  string uuid = 2;
  string relay_server = 3;
  oneof union { string id = 4; bytes pk = 5; }
  string refuse_reason = 6;
  string version = 7;
  int32 feedback = 9;
  bytes socket_addr_v6 = 10;
  int32 upnp_port = 11;
}

// NAT type detection
enum NatType { UNKNOWN_NAT=0; ASYMMETRIC=1; SYMMETRIC=2; }
message TestNatRequest { int32 serial = 1; }
message TestNatResponse { int32 port = 1; ConfigUpdate cu = 2; }

// Online status check (TCP port 21115)
message OnlineRequest { string id = 1; repeated string peers = 2; }
message OnlineResponse { bytes states = 1; } // Bitmask: 2 bits per peer

// Connection types
enum ConnType { DEFAULT_CONN=0; FILE_TRANSFER=1; PORT_FORWARD=2; RDP=3; VIEW_CAMERA=4; TERMINAL=5; }

// Health check
message HealthCheck { string token = 1; }
```

### message.proto — Key Messages (for relay)

The relay doesn't parse message.proto content — it just forwards raw bytes.
The only message from message.proto the signal server needs:

```protobuf
message IdPk { string id = 1; bytes pk = 2; }
```

This is signed by the server's Ed25519 key and sent as the public key proof.

---

## 🔌 Port Layout

| Port | Protocol | Service | Go Listener |
|------|----------|---------|-------------|
| 21114 | HTTP | REST API | `net/http` or `gin`/`chi` |
| 21115 | TCP | NAT test + OnlineRequest | `net.Listen("tcp", ":21115")` |
| 21116 | UDP | Main signal (RegisterPeer, PunchHole) | `net.ListenPacket("udp", ":21116")` |
| 21116 | TCP | TCP signal fallback | `net.Listen("tcp", ":21116")` |
| 21117 | TCP | Relay (bidirectional stream) | `net.Listen("tcp", ":21117")` |
| 21118 | WS | WebSocket signal (port = 21116 + 2) | `gorilla/websocket` or `nhooyr/websocket` |
| 21119 | WS | WebSocket relay (port = 21117 + 2) | same library |

**NOTE:** UDP and TCP can share port 21116 because they are different protocols.

---

## 🔐 Cryptography

### Ed25519 Key Management

```
Server startup:
  1. Check for existing keypair file (id_ed25519, id_ed25519.pub)
  2. If not found → generate new keypair: crypto/ed25519.GenerateKey()
  3. Store private key as base64 (64 bytes = 32 seed + 32 public)
  4. Public key = last 32 bytes of private key → base64 encode → this is the "key" string

Signing IdPk:
  1. Serialize IdPk{id, pk} to protobuf bytes
  2. Sign with ed25519.Sign(privateKey, serialized)
  3. Store signature — sent to connecting peers as proof
```

### AddrMangle Format

```
Encode(ip, port):
  IPv4: [4 bytes IP] + [2 bytes port big-endian] = 6 bytes total
  IPv6: [16 bytes IP] + [2 bytes port big-endian] = 18 bytes total

Decode(bytes):
  len == 6  → IPv4: ip = bytes[0:4], port = binary.BigEndian.Uint16(bytes[4:6])
  len == 18 → IPv6: ip = bytes[0:16], port = binary.BigEndian.Uint16(bytes[16:18])

Go implementation:
  func Encode(addr net.UDPAddr) []byte
  func Decode(b []byte) net.UDPAddr
```

---

## 📦 Wire Protocol — Framing

### TCP Framing

```
Every TCP message is framed as:
  [2 bytes: payload length, big-endian] + [N bytes: protobuf-encoded RendezvousMessage]

Go:
  // Write
  binary.BigEndian.PutUint16(buf, uint16(len(payload)))
  conn.Write(buf)
  conn.Write(payload)

  // Read
  io.ReadFull(conn, buf[:2])
  length := binary.BigEndian.Uint16(buf)
  io.ReadFull(conn, payload[:length])
  proto.Unmarshal(payload, &msg)
```

### UDP (no framing)

```
One UDP datagram = one protobuf-encoded RendezvousMessage
No length prefix needed — datagram boundaries provide framing.
```

### WebSocket

```
One WS binary message = one protobuf-encoded RendezvousMessage
No additional framing — WS message boundaries provide framing.

Signal WS: port 21118 (signal_port + 2)
Relay WS:  port 21119 (relay_port + 2)
```

---

## 💾 Database Schema

```sql
CREATE TABLE IF NOT EXISTS peer (
    guid            BLOB     PRIMARY KEY NOT NULL,
    id              VARCHAR(100) NOT NULL,
    uuid            BLOB     NOT NULL,
    pk              BLOB     NOT NULL,
    created_at      DATETIME NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    user            BLOB,
    status          TINYINT,          -- 0=offline, 1=online
    note            VARCHAR(300),
    info            TEXT     NOT NULL, -- JSON: {"ip":"..."}
    previous_ids    TEXT     DEFAULT '',
    id_changed_at   TEXT     DEFAULT '',
    is_deleted      INTEGER  DEFAULT 0,
    is_banned       INTEGER  DEFAULT 0,
    last_online     TEXT
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS index_peer_id         ON peer (id);
CREATE INDEX IF NOT EXISTS        index_peer_user       ON peer (user);
CREATE INDEX IF NOT EXISTS        index_peer_created_at ON peer (created_at);
CREATE INDEX IF NOT EXISTS        index_peer_status     ON peer (status);
```

---

## 🔄 Signal Flow (step by step)

### 1. Device Registration

```
Client → Server (UDP 21116): RegisterPeer{id:"ABC123", serial:0}
Server → Client (UDP 21116): RegisterPeerResponse{request_pk: true/false}

If request_pk == true:
  Client → Server (UDP 21116): RegisterPk{id:"ABC123", uuid:<bytes>, pk:<32 bytes>}
  Server → Client (UDP 21116): RegisterPkResponse{result:OK, keep_alive:12}

Client repeats RegisterPeer every ~12 seconds (heartbeat).
If server doesn't receive heartbeat for REG_TIMEOUT (15s), peer is stale.
```

### 2. Connection Request (Hole Punching)

```
Initiator → Server (UDP 21116): PunchHoleRequest{id:"TARGET_ID", nat_type:..., licence_key:...}

Server checks:
  - Is TARGET_ID registered and online? If not → PunchHoleResponse{failure:OFFLINE}
  - Is TARGET_ID banned? If yes → PunchHoleResponse{failure:OFFLINE}
  - Does licence_key match? If not → PunchHoleResponse{failure:LICENSE_MISMATCH}

Server → Target (UDP 21116): PunchHole{
    socket_addr: AddrMangle(initiator_addr),
    relay_server: "relay.example.com:21117",
    nat_type: initiator_nat_type
}

Server → Initiator (UDP 21116): PunchHoleSent{
    socket_addr: AddrMangle(target_addr),
    id: "TARGET_ID",
    relay_server: "relay.example.com:21117",
    nat_type: target_nat_type
}

Both sides attempt direct UDP connection. If it fails → relay.
```

### 3. Relay Flow

```
Side A → Relay (TCP 21117): [framed] RequestRelay{uuid:"session-uuid-123", id:"TARGET_ID"}
  Relay stores connection in pending map with uuid as key, waits 30s

Side B → Relay (TCP 21117): [framed] RequestRelay{uuid:"session-uuid-123", id:"..."}
  Relay finds matching uuid → pair established

Relay enters bidirectional copy:
  Side A bytes → Side B
  Side B bytes → Side A

Relay does NOT parse message.proto content — it's an opaque byte pipe.
Connection closes when either side disconnects or idle timeout (30s).
```

### 4. NAT Test

```
Client → Server (TCP 21115): [framed] TestNatRequest{serial:0}
Server → Client (TCP 21115): [framed] TestNatResponse{port: <client's source port>}

Client compares observed port with local port to determine NAT type.
```

### 5. Online Status Check

```
Client → Server (TCP 21115): [framed] OnlineRequest{id:"me", peers:["A","B","C"]}
Server → Client (TCP 21115): [framed] OnlineResponse{states: <bytes>}

states is a bitmask: 2 bits per peer
  00 = offline
  01 = online
```

---

## ⚙️ Configuration (env vars + CLI flags)

| Env Var | CLI Flag | Default | Description |
|---------|----------|---------|-------------|
| `PORT` | `--port` | 21116 | Signal server port |
| `RELAY_PORT` | `--relay-port` | 21117 | Relay server port |
| `API_PORT` | `--api-port` | 21114 | HTTP API port |
| `KEY` | `--key` | (auto-gen) | Ed25519 private key (base64) |
| `DB_URL` | `--db` | `./db_v2.sqlite3` | SQLite database path |
| `MODE` | `--mode` | `all` | `all`, `signal`, `relay` |
| `REG_TIMEOUT` | - | 15000 | Registration timeout (ms) |
| `HEARTBEAT_INTERVAL_SECS` | - | 3 | Heartbeat check interval |
| `PEER_TIMEOUT_SECS` | - | 15 | Mark offline after N seconds |
| `ALWAYS_USE_RELAY` | - | `N` | Force relay for all connections |
| `TOTAL_BANDWIDTH` | - | 1024 | Total bandwidth limit (Mb/s) |
| `SINGLE_BANDWIDTH` | - | 16 | Per-connection bandwidth (Mb/s) |
| `LIMIT_SPEED` | - | 4 | Blacklisted speed limit (Mb/s) |
| `DOWNGRADE_THRESHOLD` | - | 0.66 | Bandwidth downgrade ratio |
| `RELAY_SERVERS` | `--relay-servers` | (self) | Comma-separated relay servers |
| `RENDEZVOUS_SERVERS` | `--rendezvous-servers` | (self) | Comma-separated signal servers |
| `MASK` | `--mask` | - | LAN mask (e.g. 192.168.0.0/24) |

---

## 📚 Go Dependencies

```go
// go.mod
module github.com/unitronix/betterdesk-server

go 1.22

require (
    google.golang.org/protobuf v1.34.0    // Protobuf runtime
    github.com/gorilla/websocket v1.5.3    // WebSocket support
    modernc.org/sqlite v1.29.0             // Pure Go SQLite (no CGO)
    // OR github.com/mattn/go-sqlite3       // CGO SQLite (faster)
    github.com/google/uuid v1.6.0          // UUID generation
)
```

### Why `modernc.org/sqlite` (pure Go)?
- No CGO required → trivial cross-compilation (`GOOS=linux GOARCH=arm64 go build`)
- Single static binary, no `.so`/`.dll` dependencies
- Performance is ~90% of CGO version, sufficient for our use case

---

## 🧪 Testing Strategy

### Unit Tests (per package)
```
crypto/          → TestAddrMangleIPv4, TestAddrMangleIPv6, TestKeyGeneration, TestSign
codec/           → TestFrameWrite, TestFrameRead, TestRoundTrip
signal/          → TestRegisterPeer, TestPunchHoleFlow, TestNatTest
relay/           → TestPairing, TestBandwidthLimit, TestBlacklist
db/              → TestInsertPeer, TestSetOnline, TestBanCheck, TestIDChange
api/             → TestHealthEndpoint, TestPeersEndpoint, TestAPIKeyAuth
```

### Integration Tests
```
1. Start betterdesk-server in test mode
2. Use Go test client that speaks the protobuf protocol
3. Test full flows: register → punch hole → relay → disconnect
4. Test with real RustDesk client binary (manual/CI)
```

---

## 🚀 Build & Deploy

### Build Commands

```bash
# Linux amd64
GOOS=linux GOARCH=amd64 go build -o betterdesk-server-linux-amd64 .

# Linux arm64
GOOS=linux GOARCH=arm64 go build -o betterdesk-server-linux-arm64 .

# Windows amd64
GOOS=windows GOARCH=amd64 go build -o betterdesk-server-windows-amd64.exe .

# With version info
go build -ldflags "-X main.Version=1.0.0 -X main.BuildDate=$(date -u +%Y-%m-%dT%H:%M:%SZ)" -o betterdesk-server .
```

### Systemd Service (replaces both hbbs + hbbr services)

```ini
[Unit]
Description=BetterDesk Server (Signal + Relay + API)
After=network.target

[Service]
Type=simple
ExecStart=/opt/betterdesk/betterdesk-server --port 21116 --relay-port 21117 --api-port 21114
WorkingDirectory=/opt/betterdesk
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

---

## 📋 Implementation Order (recommended)

### Phase 1: Foundation (Tasks 0.1–0.5)
1. **Project skeleton** — `go mod init`, folder structure, `main.go`
2. **Protobuf compilation** — generate Go code from `.proto` files
3. **AddrMangle** — encode/decode with unit tests
4. **Framing codec** — TCP read/write with length prefix
5. **Ed25519 keys** — generate, load, save, sign `IdPk`

### Phase 2: Signal Server (Tasks 0.6–0.9)
6. **UDP listener** — handle RegisterPeer, RegisterPk, PunchHoleRequest
7. **Peer map** — concurrent in-memory map with heartbeat tracking
8. **SQLite database** — peer table, CRUD, status tracking
9. **TCP signal** — same handlers, framed protocol
10. **NAT test** — port 21115, TestNatRequest/Response + OnlineRequest
11. **WebSocket signal** — port 21118, same handlers over WS

### Phase 3: Relay Server (Tasks 0.10–0.11)
12. **TCP relay** — UUID pairing, bidirectional copy, 30s timeout
13. **WS relay** — port 21119, same pairing logic
14. **Bandwidth limiting** — token bucket per-connection + global
15. **Blacklist/blocklist** — IP-based, file-loaded

### Phase 4: API & Features (Tasks 0.12–0.18)
16. **HTTP API** — all existing endpoints from BetterDesk
17. **Ban system** — integrated with signal + relay
18. **ID change** — with rate limiting and history
19. **Integration with web-nodejs** — replace Rust hbbs, keep Node.js console

### Phase 5: Production (Tasks 0.19–0.20)
20. **Full integration testing** with real RustDesk clients
21. **Cross-compilation** and release pipeline
22. **Update ALL-IN-ONE scripts** (`betterdesk.sh`, `betterdesk.ps1`) for Go binary

---

## ⚠️ Critical Implementation Notes

### 1. DO NOT copy Rust code
We implement from the protocol spec only. Reference the `.proto` files and the
port/flow documentation above, never the `.rs` source files.

### 2. RegisterPeer is the heartbeat
The client sends `RegisterPeer` via UDP every ~12 seconds. If we don't receive it
for `REG_TIMEOUT` (15s default), the peer is considered offline.

### 3. PunchHole is time-critical
The server must relay PunchHole messages with minimal latency. Both sides attempt
simultaneous UDP hole-punching. Delays > 500ms can cause failure.

### 4. Relay pairing uses UUID
Both sides of a relay connection send `RequestRelay{uuid:"same-uuid"}`. The relay
server pairs them by UUID. First connection waits up to 30 seconds for the second.

### 5. WebSocket is optional but important
Web clients (browser-based RustDesk) use WebSocket exclusively. Desktop clients
prefer UDP/TCP but fall back to WS.

### 6. Key compatibility
The server's Ed25519 keypair must be compatible with existing RustDesk clients.
The public key is base64-encoded and distributed to clients via the `key=` parameter.
Clients verify the server's signature on `IdPk` messages.

### 7. Database compatibility
Use the same SQLite schema as the current Rust server (`db_v2.sqlite3`) so the
Node.js web console (`web-nodejs/`) works without changes.

---

## 🔗 Integration with Existing BetterDesk Components

The Go server replaces ONLY the Rust binaries (`hbbs` + `hbbr`). Everything else stays:

| Component | Status | Notes |
|-----------|--------|-------|
| `web-nodejs/` | ✅ Unchanged | Reads `db_v2.sqlite3` + calls HTTP API on 21114 |
| `betterdesk.sh` | 🔧 Update needed | Download/install Go binary instead of Rust binaries |
| `betterdesk.ps1` | 🔧 Update needed | Same |
| `betterdesk-docker.sh` | 🔧 Update needed | Update Dockerfile for single binary |
| `Dockerfile.hbbs` | 🔄 Replace | Single `Dockerfile.server` for Go binary |
| `Dockerfile.hbbr` | 🔄 Remove | Not needed — single binary |
| `docker-compose.yml` | 🔧 Update needed | Single `server` service instead of `hbbs` + `hbbr` |

---

*Last updated: 2026-02-28*
*Author: GitHub Copilot*

---

## 🔍 Security Audit Findings (2026-02-28)

### HIGH

| ID | Issue | File | Fix | Status |
|----|-------|------|-----|--------|
| H1 | No validation of `new_id` in change-id API | `api/server.go:297-324` | `peerIDRegexp` check | ✅ Fixed |
| H2 | `FindByIP` fallback returns first peer behind NAT | `peer/map.go` / `signal/handler.go` | Outbound auth: exact `FindByAddr` / TCP session / token / panel proxy / `udp_port` hint / safe single-IP fallback; multi-peer → `initiator_ambiguous_same_nat` unless opt-in `ALLOW_SHARED_NAT_INITIATOR` (synthetic `shared-nat-initiator`, #399). RelayResponse uses pending UUID+initiator store — no multi-peer `FindByIP` delivery. | ✅ Fixed (auth + #399 forward) |
| H3 | No rate-limit on `/api/auth/login/2fa` | `api/auth_handlers.go:127-168` | `loginLimiter.Allow(clientIP)` + audit log | ✅ Fixed |
| H4 | Partial 2FA token has 24h TTL | `api/auth_handlers.go:104-111` | `GenerateWithTTL()` 5min | ✅ Fixed |

### MEDIUM

| ID | Issue | File | Fix | Status |
|----|-------|------|-----|--------|
| M1 | SQL LIKE without escaping `%`/`_` | `db/sqlite.go:329-338` | Escape before LIKE | ✅ Fixed |
| M2 | No TTL/max-size for `tcpPunchConns` | `signal/server.go:83` | 2min TTL + 10K cap + cleanup goroutine | ✅ Fixed |
| M3 | WebSocket accept without origin check | `signal/ws.go:49`, `relay/ws.go:46` | `WS_ALLOWED_ORIGINS` env var + `OriginPatterns` | ✅ Fixed |
| M4 | No rate-limit on TCP signal connections | `signal/server.go:224` | `limiter.Allow(host)` in `serveTCP()` | ✅ Fixed |
| M5 | Heartbeat debounce 60s — stale DB status | `signal/handler.go:151-154` | Acceptable trade-off | ⚠️ Won't fix |
| M6 | No validation of config key names | `api/server.go:348-370` | `configKeyRegexp` validation | ✅ Fixed |
| M7 | `io.Copy` relay without idle timeout | `relay/server.go:193-200` | `idleTimeoutConn` wrapper, 30s idle deadline | ✅ Fixed |
| M8 | No `ConfigUpdate` in `TestNatResponse` | `signal/handler.go:830-841` | `Cu` field with relay/rendezvous servers | ✅ Fixed |

### Encryption Assessment — CORRECT

| Aspect | Status |
|--------|--------|
| Ed25519 key generation + persistence | ✅ |
| Ed25519 → Curve25519 conversion | ✅ Matches libsodium |
| NaCl KeyExchange (signed 96-byte payload) | ✅ |
| NaCl secretbox (pre-increment nonce LE u64) | ✅ Matches RustDesk |
| Backward compatibility (non-KeyExchange clients) | ✅ |
| TLS for HTTP API | ✅ Optional via `--tls-cert`/`--tls-key` |
| TLS for signal/relay TCP | ✅ Dual-mode via `DualModeListener` (Phase 3) |
| WSS for signal/relay WS | ✅ `ListenAndServeTLS` with shared `LoadTLSConfig` (Phase 3) |

### Database Interface

The `Database` interface in `db/database.go` (25+ methods) is already designed for
multiple backends. PostgreSQL implementation needs `db/postgres.go` only.

Shared SQLite access between Go server and Node.js console works correctly — they
use different tables (Go: peers/users/api_keys, Node.js: address_books/device_groups/sysinfo).

