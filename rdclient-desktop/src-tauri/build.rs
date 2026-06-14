fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "get_client_info",
                "get_server_url",
                "set_server_url",
                "open_session",
                "close_current_window",
            ]),
        ),
    )
    .expect("failed to run tauri build");
}
