# Go-server centralization (help-request + chat)

Plan: docs/GO_SERVER_CENTRALIZATION_PLAN_2026-05-31.md (Workstreams A-E, Phases 1-5).
Goal: agent talks ONLY to Go (CDAP :21122 + REST on Go `-api-port`, default **21121**), panel = read proxy.  
(See [betterdesk-api-port-consolidation.md](./betterdesk-api-port-consolidation.md) — older notes referenced :21114 before API consolidation.)

## Status (Phase 3 done)
- P1: db/help_requests_{sqlite,postgres}.go, HelpRequest model, GetDeviceOrgID. CDAP handlers handleHelpRequest/handleChatMessage in cdap/handler.go. DONE.
- P2: Go REST help endpoints (api/help_handlers.go), cdap SendChatToDevice. DONE.
- P3: Node panel read-proxy. DONE + builds clean. betterdeskApi.js +5 fns (listHelpRequests, acknowledge/resolveHelpRequest, getChatHistory, sendChatMessage) + apiClient exported. bd-api.routes.js: removed local Maps, all help/chat/notif endpoints proxy to Go.
- P4 (DONE): agent hardening. The Tauri client now rejects remote plaintext CDAP by default (`enforce_tls=true`) and uses strict HTTP/TLS certificate validation by default. `BETTERDESK_ALLOW_INVALID_TLS=1` and an explicit plaintext opt-out are development-only compatibility escape hatches. Certificate pinning remains available for private PKI/self-signed deployments. The Go gateway supports `CDAP_TLS_REQUIRED=Y` for TLS-only CDAP operation; use it with `wss://` after clients are migrated. IPC = stdin/stdout Stdio::piped() pipes (NOT TCP) — already secure.
- P5 (TODO): remove agent-client HTTP path (commands.rs/registration.rs send_console_json), remove agent-facing /api/bd/help-request + /api/bd/chat/send, tests, docs/i18n. TLS policy hardening is now separate: Tauri certificate validation is strict by default and remote plaintext CDAP is rejected by default; `BETTERDESK_ALLOW_INVALID_TLS=1` and explicit plaintext opt-out remain development-only escape hatches.

## Key facts
- Go events.Event JSON = {type, timestamp, data:{...}} — Data is NESTED under `data`, NOT flattened. Read event.data.X.
- events filter: single EventType, "" = all events. No comma-separated. For multi-type subscribe with no filter + client-side switch.
- Panel has NO server-side socket.io. Frontend POLLS (help-requests.js, notif-center.js fallback). So NO fan-out service needed for Phase 3 — read-proxy on poll endpoints suffices. Old `io.emit` refs in bd-api.routes were referencing undefined `io` (latent bug, now removed).
- BUILD: terminal cwd already inside betterdesk-server/. Run `go build ./...` WITHOUT cd. No output = success.
- POST /api/help/requests gated by PermChatAccess (panel API key auth, not anonymous).
- Status mapping: Go acknowledged<->panel accepted; Go int id<->panel String(id); Go RFC3339 created_at<->panel ms (Date.parse).
