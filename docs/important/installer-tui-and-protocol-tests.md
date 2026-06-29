# betterdesk.sh — TUI menu + protocol tests + diag DB fix (2026)

## Added functions
- `tui_available()` — true only when TTY on stdin+stdout and BETTERDESK_CLASSIC_MENU!=1.
- `tui_select "title" "subtitle" item...` — pure-bash arrow-key menu. Items use `label\tdesc`. Result in global `TUI_RESULT` (0-based index). Returns 0=selected, 2=cancel(q/Esc/0), 1=unavailable. Hides cursor, `_tui_restore` on exit/INT/TERM.
- `read_effective_console_setting(key)` — runtime value from systemd `Environment=` (overrides `.env`).
- `apply_console_protocol_mode(http|https)` — syncs `.env` + `betterdesk-console.service` for protocol toggle (#219).
- `deploy_ssl_material_to_rustdesk_dir()` — copies TLS cert/key into `$RUSTDESK_PATH/ssl/betterdesk.{crt,key}` (not symlinks); tracks `LE_CERT_LIVE_DIR` for certbot renew (#219).
- `install_le_certbot_renew_hook()` — deploy hook re-copies renewed LE certs then restarts services.
- `maybe_repair_le_ssl_symlinks()` — auto-fixes legacy LE symlink installs when `ensure_betterdesk_console_user` runs.
- `ensure_console_tls_material_readable()` — on update/repair/toggle restart, re-copies LE material when HTTPS is enabled but the console user cannot read the TLS key (#219).
- `_wait_for_http_code()` — retry helper used by `run_protocol_tests()` so post-restart checks wait for Node boot (#219).
- `linux-ensure-console-user.js` → `repairLetsEncryptSslMaterial()` — same LE redeploy during Settings → Updates (#219); resolves live dir from `LE_CERT_LIVE_DIR`, cert paths, or `LE_CERT_DOMAIN`.
- `sync_go_server_signal_relay_tls()` / `clear_go_server_signal_relay_tls()` — shared Go server TLS patching for menus **C** and **T**.
- `do_configure_ssl` (menu **C**) — unified with `apply_console_protocol_mode` + cert deploy/repair (#219); no separate sed-only `.env` path.
- `resolve_panel_http_port()` / `resolve_panel_https_port()` / `resolve_panel_health_port()` — HTTPS mode health checks use `HTTPS_PORT` (5443), not `PORT` (5000 redirect listener).
- `run_protocol_tests()` — post-config checks: services active, TLS key readable by `betterdesk` user, panel on correct scheme/port, optional HTTP→HTTPS redirect, Go API HTTP on :21114, Client API on :21121 with matching TLS mode, signal/relay listeners, cert validity+expiry+SAN, live TLS handshake on :21116; prints effective runtime config at end.

## main() menu
- Uses `menu_labels[]` (label\tdesc) + `menu_actions[]` (tokens 1..9 L C T M B S 0) mapped 1:1 to existing case dispatch. TUI when available, else classic show_menu numeric fallback.

## Diagnostics DB fix (do_diagnostics ~line 4149)
- Root cause: checked `[ -f "$DB_PATH" ]` FIRST → stale sqlite file masked active PostgreSQL.
- Fix: read DB_TYPE from $CONSOLE_PATH/.env first (also checks -db postgres:// in betterdesk-server.service), branch postgres vs sqlite. Mirrors print_status()/detect_installation() pattern.

## do_toggle_protocol HTTPS branch
- Cert choice: 1=keep existing (auto-repairs LE symlinks), 2=self-signed (RSA4096+SAN), 3=Let's Encrypt (certbot standalone + **copy** to `$RUSTDESK_PATH/ssl/` + deploy renew hook), 4=custom paths (validates X.509). Calls `apply_console_protocol_mode` + `run_protocol_tests` after restart.

## do_configure_ssl (menu C)
- All branches (LE, custom, self-signed, disable, Enterprise) use the same helpers as Protocol Toggle: `deploy_ssl_material_to_rustdesk_dir`, `apply_console_protocol_mode`, `sync_go_server_signal_relay_tls`, `ensure_console_tls_material_readable` on restart (#219).

## Invariant kept
- Go API :21114 always HTTP. Only -tls-signal/-tls-relay + -tls-cert/-tls-key for TLS. Never -tls-api/-force-https.

NOT yet mirrored to betterdesk.ps1 / betterdesk-docker.sh.
