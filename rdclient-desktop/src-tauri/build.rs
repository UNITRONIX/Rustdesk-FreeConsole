fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "get_client_info",
                "get_server_url",
                "get_config",
                "probe_server_url",
                "discover_servers",
                "set_server_url",
                "set_tls_strict",
                "set_ui_lang",
                "get_system_locale",
                "open_settings",
                "sign_out",
                "reset_client",
                "open_session",
                "close_current_window",
            ]),
        ),
    )
    .expect("failed to run tauri build");
}
