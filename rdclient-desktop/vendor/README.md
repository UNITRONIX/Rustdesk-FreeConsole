# Vendored crates

## `wry/`

Patched copy of [wry](https://github.com/tauri-apps/wry) used via `[patch.crates-io]` in `src-tauri/Cargo.toml`.

**Change:** `src/webkitgtk/web_context.rs` sets `TLSErrorsPolicy::Ignore` on the WebKit WebContext so RdClient can load operator panels over **HTTP**, **self-signed HTTPS**, or **HTTPS with an incomplete chain** (common on LAN installs). Disable with `BETTERDESK_TLS_STRICT=1`.

Upstream issue context: [tauri#7175](https://github.com/tauri-apps/tauri/issues/7175), [tauri#4039](https://github.com/tauri-apps/tauri/issues/4039).

When upstream wry/Tauri expose a supported API for operator TLS policy, this vendor copy can be removed.
