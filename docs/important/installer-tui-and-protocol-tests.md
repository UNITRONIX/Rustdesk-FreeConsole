# betterdesk.sh — TUI menu + protocol tests + diag DB fix (2026)

## Added functions
- `tui_available()` — true only when TTY on stdin+stdout and BETTERDESK_CLASSIC_MENU!=1.
- `tui_select "title" "subtitle" item...` — pure-bash arrow-key menu. Items use `label\tdesc`. Result in global `TUI_RESULT` (0-based index). Returns 0=selected, 2=cancel(q/Esc/0), 1=unavailable. Hides cursor, `_tui_restore` on exit/INT/TERM.
- `run_protocol_tests()` — post-config checks: services active, panel reachable (scheme/port from .env HTTPS_ENABLED), Go API HTTP on :21114 (invariant: must stay HTTP, warns on -tls-api/-force-https), signal/relay listeners, cert validity+expiry+SAN, live TLS handshake on :21116.

## main() menu
- Uses `menu_labels[]` (label\tdesc) + `menu_actions[]` (tokens 1..9 L C T M B S 0) mapped 1:1 to existing case dispatch. TUI when available, else classic show_menu numeric fallback.

## Diagnostics DB fix (do_diagnostics ~line 4149)
- Root cause: checked `[ -f "$DB_PATH" ]` FIRST → stale sqlite file masked active PostgreSQL.
- Fix: read DB_TYPE from $CONSOLE_PATH/.env first (also checks -db postgres:// in betterdesk-server.service), branch postgres vs sqlite. Mirrors print_status()/detect_installation() pattern.

## do_toggle_protocol HTTPS branch
- Now offers cert choice: 1=keep existing, 2=self-signed (RSA4096+SAN), 3=Let's Encrypt (certbot standalone + deploy renew hook), 4=custom paths (validates X.509). Calls run_protocol_tests after restart. do_configure_ssl also calls run_protocol_tests.

## Invariant kept
- Go API :21114 always HTTP. Only -tls-signal/-tls-relay + -tls-cert/-tls-key for TLS. Never -tls-api/-force-https.

NOT yet mirrored to betterdesk.ps1 / betterdesk-docker.sh.
