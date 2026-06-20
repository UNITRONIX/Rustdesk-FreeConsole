// Show console window only when --console flag is NOT present.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(all(windows, not(debug_assertions)))]
    if std::env::args().any(|a| a == "--console") {
        unsafe {
            windows_sys::Win32::System::Console::AttachConsole(
                windows_sys::Win32::System::Console::ATTACH_PARENT_PROCESS,
            );
        }
    }

    betterdesk_agent_client_lib::run();
}
