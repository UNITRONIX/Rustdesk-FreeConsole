#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    rdclient_desktop_lib::linux_display::init();

    rdclient_desktop_lib::run();
}
