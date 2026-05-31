# Go Server Centralization & Agent Hardening Plan (2026-05-31)

> **Status: PLAN ONLY — not yet implemented.**
> Goal: make the Go server the single source of truth and processing center; reduce
> the attack surface by removing the redundant agent → Node.js channel; persist
> help-requests and full chat history in the database; and harden the agent client
> against hijacking by a rogue process or a rogue server.

---

## 1. Motivation

A code audit confirmed two problems raised by the project owner:

1. **The agent client uses two independent connectivity channels**, which doubles
   the attack surface and caused a real production bug (the HTTP→HTTPS `301`
   redirect on the Node.js panel silently broke help-request delivery).

   | Channel | Initiator | Target | Protocol | Auth |
   |---|---|---|---|---|
   | CDAP | Go sidecar (`betterdesk-agent`) | **Go server** `:21122/cdap` | WebSocket JSON | `device_token` |
   | Help / Chat | Tauri client (Rust) | **Node.js panel** `:5000/5443` | HTTP POST | `X-Device-Id` |

2. **help-request and chat are not persisted.** In the Node.js panel they live only
   in RAM (`helpRequests = new Map()`, `chatHistory = new Map()`) and are lost on
   restart. The Go server already has durable chat storage that is unused by the agent.

### What already exists in Go (reuse, do not rebuild)

- `db/sqlite.go` + `db/postgres.go`: table `chat_messages` (+ indexes), `chat_groups`.
- `db.ChatMessage` model; `SaveChatMessage`, `GetChatHistory`, `GetChatHistoryBefore`.
- `api/chat_handlers.go`: `GET /api/chat/history/{conv}`, `POST /api/chat/messages`,
  `/api/chat/read`, `/api/chat/unread`, `/api/chat/contacts`, group endpoints —
  all gated by `PermChatAccess` (RBAC).
- `cdap/gateway.go` message loop with `device_token` auth (`cdap/auth.go`).
- `events.Bus` pub/sub for real-time fan-out.
- `cdap/crypto.go`: authenticated encryption for E2E media channels.

### What is missing

- No `help_requests` table or handlers anywhere in Go or the sidecar.
- No agent → Go path for help/chat (agent only posts to Node.js).
- Sidecar has **no server-identity verification** beyond default CA chain; `ws://`
  is permitted; **no certificate / public-key pinning**.

---

## 2. Target Architecture

```
                 ┌──────────────────────────────────────────────┐
                 │                 Go server                     │
                 │  (single source of truth + processing core)   │
                 │                                               │
   CDAP  ws/wss  │  :21122  cdap.Gateway ── help_request / chat  │
 ┌──────────────┼─────────►  message types  ──► DB + events.Bus  │
 │              │                                   │            │
 │  Agent       │  :21114  REST API ── /api/help/* ─┤            │
 │  (sidecar +  │           /api/chat/*  (RBAC)     │            │
 │   Tauri)     │                                   ▼            │
 │              │                          SQLite / PostgreSQL   │
 └──────────────┘                          (durable history)     │
                 │                                   ▲            │
                 └───────────────────────────────────┼───────────┘
                                                     │ read-only proxy
                                          ┌──────────┴───────────┐
                                          │   Node.js panel       │
                                          │  GUI only — proxies   │
                                          │  to Go, fans out to   │
                                          │  operators via WS     │
                                          └──────────────────────┘
```

**Principle:** the agent communicates **only with the Go server** (CDAP `:21122`
and/or REST `:21114`). The Node.js panel never receives data directly from agents;
it reads from Go and pushes to operator browsers via socket.io.

### Chosen transport for help/chat: **CDAP message types (preferred)**

Route help-request and chat through the **existing authenticated CDAP WebSocket**
that the sidecar already holds open. This means:

- **One channel** for the agent (the CDAP socket), satisfying the security goal.
- Reuses `device_token` auth, rate limiting, and the planned channel hardening.
- No new public HTTP endpoint on the agent side → smaller attack surface.

The Tauri client reaches the sidecar via a small local IPC (stdin/stdout line
protocol already used for `DESKTOP_STOP` / `CONSENT_*`, or a localhost loopback).

> **Fallback (only if CDAP IPC proves too invasive):** REST to Go `:21114`
> (`POST /api/help/request`, `POST /api/chat/messages`) authenticated with
> `device_token`, mirroring the existing `/api/heartbeat` + `/api/sysinfo` pattern.
> Still removes the Node.js channel, still HTTP but to the real backend. Decide at
> the start of Workstream A after a 1-day spike on Tauri↔sidecar IPC.

---

## 3. Workstreams & Task List

### Workstream A — Help Request → Go server + DB

- [ ] **A1. DB schema.** Add `help_requests` table to `db/sqlite.go` and
  `db/postgres.go` (auto-migration): `id`, `device_id`, `hostname`, `org_id`,
  `message`, `status` (`pending`/`acknowledged`/`resolved`/`cancelled`),
  `created_at`, `updated_at`, `handled_by`. Indexes on `device_id`, `status`,
  `created_at`, `org_id`.
- [ ] **A2. DB model + methods.** `db.HelpRequest` struct; interface methods
  `CreateHelpRequest`, `UpdateHelpRequestStatus`, `ListHelpRequests(filter)`,
  `GetHelpRequest(id)`, `PruneHelpRequests(maxAge)` — implemented in both adapters.
- [ ] **A3. CDAP message type.** Add `help_request` case to `cdap/gateway.go`
  `messageLoop`; handler validates payload against the authenticated `DeviceConn.ID`
  (device cannot spoof another device's ID), writes to DB, publishes
  `events.EventHelpRequest`, audit-logs `help_request`.
- [ ] **A4. REST read API (for the panel).** `GET /api/help/requests` (RBAC
  `PermDeviceView` or new `PermHelpView`), `POST /api/help/requests/{id}/ack`,
  `/resolve` (operator), `GET /api/help/requests/{id}`. Data-scoped by org.
- [ ] **A5. Events.** New `events.EventHelpRequest` / `EventHelpRequestUpdated`
  so the Node.js panel can subscribe over the existing `/api/ws/events` bus.
- [ ] **A6. Org scoping.** Stamp `org_id` from the device's peer record so
  org-scoped operators only see their org's help-requests (reuse `peerOrgScopeCheck`).

### Workstream B — Chat → Go server + DB (reuse existing infra)

- [ ] **B1. CDAP `chat_message` type.** Add `chat_message` case to the CDAP
  message loop; handler maps `{content}` from the authenticated device into a
  `db.ChatMessage` (conversation = `device_id`, `from_id = device_id`,
  `from_name = device_name`), calls existing `SaveChatMessage`, publishes a chat
  event. Enforce the 4096-char limit already present in `handleChatSendMessage`.
- [ ] **B2. Operator → agent delivery.** When an operator sends a message to a
  device, persist via `SaveChatMessage` and push to the device over its CDAP
  socket (`sendMessage(... "chat_message" ...)`). The sidecar relays to the Tauri
  client over local IPC for display.
- [ ] **B3. History on connect.** On CDAP auth/manifest, the agent may request
  recent history; server returns via `GetChatHistory(device_id, N)`.
- [ ] **B4. Unread + receipts.** Reuse `/api/chat/read` + `handleChatUnread`;
  add CDAP `read_receipt` relay if the agent UI needs it.
- [ ] **B5. Retention policy.** Configurable max age / max rows; background prune
  task (mirrors the existing `peer_metrics` cleanup pattern).

### Workstream C — Node.js panel becomes a pure read proxy

- [ ] **C1. Remove the agent-facing write endpoints** `POST /api/bd/help-request`
  and `POST /api/bd/chat/send` from `web-nodejs/routes/bd-api.routes.js`
  (and the `identifyDevice` middleware usage for them). Keep them only as a
  deprecated shim during migration (feature-flagged), then delete.
- [ ] **C2. Replace in-memory `helpRequests` / `chatHistory` Maps** with reads
  from Go: panel calls `GET /api/help/requests` and `GET /api/chat/history/*`
  via the existing `betterdeskApi.js` client (server API key / operator JWT).
- [ ] **C3. Real-time fan-out.** Subscribe the panel to Go's event bus
  (`deviceStatusPush.js` pattern) for `help_request` / chat events and re-emit to
  operator browsers via socket.io (`io.emit('help-request' | 'chat-message')`).
  Browser-facing socket.io contract stays the same → no operator UI changes.
- [ ] **C4. Operator send path.** Operator "reply" in the panel calls Go
  `POST /api/chat/messages` (already exists) instead of the local Map.
- [ ] **C5. Audit.** Confirm all help/chat actions are logged by Go (single audit
  trail), remove duplicate Node.js `db.logAction` for these flows.

### Workstream D — Agent client hardening (anti-hijack, secure channel)

The agent must not be controllable by a rogue local process or a rogue/spoofed server.

- [ ] **D1. Enforce `wss://` in production.** Sidecar `config.go` currently only
  *warns* on `ws://`. Add a strict mode (default ON unless
  `BETTERDESK_ALLOW_PLAINTEXT=1`) that refuses to connect over `ws://` to a
  non-loopback host. Mirror the agent-client `strict_tls` gate.
- [ ] **D2. Server identity verification / pinning.** Today
  `websocket.Dial(ctx, cfg.Server, nil)` uses only the default CA chain. Add:
  - **Public-key / certificate pinning**: store the server's expected SPKI hash
    (or Ed25519 server pubkey, already exposed at `GET /api/server/pubkey`) in the
    agent config at enrollment; verify on every connect via a custom
    `*tls.Config{VerifyPeerCertificate: ...}` / `websocket.DialOptions.HTTPClient`.
  - **TOFU option** for self-signed deployments: pin on first enrollment, warn on
    change (like SSH known_hosts), surfaced in the agent UI.
- [ ] **D3. Mutual authentication of the control channel.** Beyond `device_token`,
  bind the session to the pinned server identity so a stolen token cannot be
  replayed against a different (attacker) server, and a spoofed server cannot
  accept the agent. Consider a challenge-response signed with the server's Ed25519
  key during CDAP auth (server proves identity, not just the agent).
- [ ] **D4. Token at rest.** Keep auth token in the OS keyring (already done in
  `config.rs::store_token_secure`); ensure the JSON-file fallback is last-resort
  and 0600-permission, and the device-token is never logged.
- [ ] **D5. Local IPC hardening (Tauri ↔ sidecar).** If help/chat go through the
  sidecar (preferred), the local IPC must not be hijackable: use stdin/stdout of
  the child process (already parent-owned) **not** an open localhost TCP port; if a
  loopback socket is unavoidable, bind `127.0.0.1` only + a per-launch shared
  secret. Reject any peer that is not the spawned child.
- [ ] **D6. Single-instance + process integrity.** Already single-instance via
  `tauri-plugin-single-instance`; document that the sidecar is spawned and owned by
  the Tauri parent (`SidecarManager`), never discoverable/attachable by third
  parties. Verify the sidecar binary path/signature before exec where feasible.
- [ ] **D7. Channel-level E2E for control (optional, phase 2).** Extend the
  existing `cdap/crypto.go` authenticated-encryption approach from media to the
  control channel for defense-in-depth on top of TLS.
- [ ] **D8. Replay / downgrade resistance.** Short-lived session tokens (CDAP
  already issues a JWT with expiry); reject downgrade to weaker auth methods;
  nonce/timestamp on sensitive control messages.

### Workstream E — Decommission & verification

- [ ] **E1. Remove the redundant transport.** After C is live, delete the
  agent-client `send_console_json` HTTP path and `format_console_url` (Node.js
  `:5000/5443` help/chat). Agent keeps only the CDAP socket (+ REST `:21114` for
  heartbeat/sysinfo that already exist).
- [ ] **E2. Migration / back-compat.** Provide a transition window where the panel
  shim still accepts old clients, with a deprecation log; document in ALL-IN-ONE
  scripts so upgrades don't break mixed fleets.
- [ ] **E3. Tests.** Go unit tests for help-request DB + handlers; CDAP message
  routing tests; Node.js proxy tests (mock Go); end-to-end: agent → Go → DB →
  panel → operator browser.
- [ ] **E4. Docs + i18n.** Update operator docs; any new agent UI strings go to
  `src/locales/{en,pl,zh-TW}.json`; any new panel strings to
  `web-nodejs/lang/{en,pl,zh}.json`.
- [ ] **E5. Installer/scripts.** Ensure new Go tables auto-migrate (no manual SQL);
  no new ports; confirm `betterdesk.sh` / `.ps1` / docker variants need no changes
  beyond rebuilding the Go binary.

---

## 4. Security Review Checklist (applied to every task)

- Input validation: device-supplied `device_id` must equal the authenticated
  `DeviceConn.ID` — never trust the body's `device_id` for routing/authorization.
- SQL: parameterized queries only; `LIKE` escapes `%`/`_`.
- RBAC: operator read/ack endpoints gated by permission; org data-scoping enforced.
- Rate limiting: reuse CDAP `IPLimiter`; add per-device help-request flood cap.
- Audit: every help/chat/ack action logged once, in Go.
- Secrets: device token only in keyring; never logged; TLS/pinning enforced.
- No new public attack surface on the agent; Node.js holds no agent-write routes.

---

## 5. Suggested Phasing

1. **Phase 1 (backend foundation):** A1–A3, B1 — Go DB + CDAP ingestion (no UI change).
2. **Phase 2 (read path):** A4–A6, B2–B5 — REST read APIs + events.
3. **Phase 3 (panel proxy):** C1–C5 — Node.js becomes pure proxy; operator UX unchanged.
4. **Phase 4 (agent security):** D1–D6 — wss enforcement, pinning, mutual auth, IPC.
5. **Phase 5 (cleanup):** E1–E5 — remove redundant channel, tests, docs, hardening D7–D8.

Each phase is independently shippable and on-machine testable before the next.

---

## 6. Open Decisions (to confirm before implementation)

- **A-vs-B transport:** CDAP message types (preferred) vs REST `:21114`. Spike
  Tauri↔sidecar IPC first; pick CDAP if the IPC is clean.
- **Pinning model:** strict CA + SPKI pin (managed deployments) vs TOFU
  (self-signed/LAN). Likely support both, selected at enrollment.
- **Retention:** default help-request / chat history retention window and row caps.
