//! Small, allowlisted elevated helper used only for UAC-gated operations.
//!
//! The helper never receives a shell command. It accepts an operation name,
//! writes a short-lived authorization result to a random marker in the
//! user's temporary directory, and exits.

use std::{env, fs, path::Path, process};

use betterdesk_desktop::helper::allowlisted_name;

fn main() {
    #[cfg(windows)]
    windows_main();

    #[cfg(not(windows))]
    {
        eprintln!("BetterDesk Desktop helper is only available on Windows.");
        process::exit(1);
    }
}

#[cfg(windows)]
fn windows_main() {
    let mut args = env::args().skip(1);
    let Some(command) = args.next() else {
        process::exit(2);
    };
    if command != "--authorize" {
        process::exit(2);
    }

    let (Some(operation), Some(marker), Some(nonce)) = (args.next(), args.next(), args.next())
    else {
        process::exit(2);
    };
    if !allowlisted_name(&operation) || !valid_marker_path(&marker) || nonce.len() < 32 {
        process::exit(3);
    }

    let value = format!("{operation}\n{nonce}\n");
    if fs::write(marker, value).is_err() {
        process::exit(4);
    }
}

#[cfg(windows)]
fn valid_marker_path(value: &str) -> bool {
    let path = Path::new(value);
    let Some(parent) = path.parent() else {
        return false;
    };
    let Ok(temp) = env::temp_dir().canonicalize() else {
        return false;
    };
    let Ok(parent) = parent.canonicalize() else {
        return false;
    };
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    parent == temp && name.starts_with("betterdesk-uac-") && name.ends_with(".grant")
}
