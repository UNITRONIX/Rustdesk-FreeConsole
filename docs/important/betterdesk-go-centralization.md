# Go-server centralization (help-request + chat)

Plan: docs/GO_SERVER_CENTRALIZATION_PLAN_2026-05-31.md (Workstreams A-E, Phases 1-5).
Goal: agent talks ONLY to Go (CDAP :21122 + REST on Go `-api-port`, default **21121**), panel = read proxy.  
(See [betterdesk-api-port-consolidation.md](./betterdesk-api-port-consolidation.md) — older notes referenced :21114 before API consolidation.)

## Status (Phase 3 done)
- P1: db/help_requests_{sqlite,postgres}.go, HelpRequest model, GetDeviceOrgID. CDAP handlers handleHelpRequest/handleChatMessage in cdap/handler.go. DONE.
- P2: Go REST help endpoints (api/help_handlers.go), cdap SendChatToDevice. DONE.
- P3: Node panel read-proxy. DONE + builds clean. betterdeskApi.js +5 fns (listHelpRequests, acknowledge/resolveHelpRequest, getChatHistory, sendChatMessage) + apiClient exported. bd-api.routes.js: removed local Maps, all help/chat/notif endpoints proxy to Go.
- P4 (DONE): agent hardening. betterdesk-agent/agent/config.go: +EnforceTLS/ServerCertPin/TLSInsecureSkipVerify fields, env vars BDAGENT_ENFORCE_TLS/BDAGENT_SERVER_CERT_PIN/BDAGENT_TLS_INSECURE, Validate enforces wss + 64-hex pin, normalizeCertPin helper. agent.go: dialOptions() builds tls.Config with SPKI pin via VerifyPeerCertificate + subtle.ConstantTimeCompare. Tauri propagation: config.rs AgentConfig.server_cert_pin (#[serde default]) + Default + to_sidecar_config; sidecar.rs SidecarConfig.server_cert_pin + GoAgentConfig.{enforce_tls,server_cert_pin} (is_false skip helper) + write_go_config: enforce_tls is EXPLICIT opt-in (cfg.enforce_tls, default false), NOT auto-derived from scheme — HTTP/ws:// always supported. Go agent Validate() only warns on ws:// (EnforceTLS opt-in). Go server CDAP/API TLS also opt-in (--tls-cdap/--tls-api). config.rs AgentConfig.enforce_tls (#[serde default] false). write_go_config logs warn! on ws:// to non-local host recommending wss. cargo check OK. IPC = stdin/stdout Stdio::piped() pipes (NOT TCP) — already secure.
- P5 (TODO): remove agent-client HTTP path (commands.rs/registration.rs send_console_json), remove agent-facing /api/bd/help-request + /api/bd/chat/send, tests, docs/i18n.

## Key facts
- Go events.Event JSON = {type, timestamp, data:{...}} — Data is NESTED under `data`, NOT flattened. Read event.data.X.
- events filter: single EventType, "" = all events. No comma-separated. For multi-type subscribe with no filter + client-side switch.
- Panel has NO server-side socket.io. Frontend POLLS (help-requests.js, notif-center.js fallback). So NO fan-out service needed for Phase 3 — read-proxy on poll endpoints suffices. Old `io.emit` refs in bd-api.routes were referencing undefined `io` (latent bug, now removed).
- BUILD: terminal cwd already inside betterdesk-server/. Run `go build ./...` WITHOUT cd. No output = success.
- POST /api/help/requests gated by PermChatAccess (panel API key auth, not anonymous).
- Status mapping: Go acknowledged<->panel accepted; Go int id<->panel String(id); Go RFC3339 created_at<->panel ms (Date.parse).
