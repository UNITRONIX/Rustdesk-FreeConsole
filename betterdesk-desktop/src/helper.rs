use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::security::PrivilegedOperation;

#[derive(Debug, Error)]
pub enum HelperError {
    #[error("helper operation is not allowlisted")]
    NotAllowlisted,
    #[error("helper payload is invalid")]
    InvalidPayload,
    #[error("helper payload is too large")]
    TooLarge,
    #[error("elevated helper is unavailable")]
    Unavailable,
    #[error("elevated helper did not authorize the operation")]
    AuthorizationFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HelperRequest {
    pub operation: String,
    pub payload: serde_json::Value,
}

impl HelperRequest {
    pub fn new(
        operation: PrivilegedOperation,
        payload: serde_json::Value,
    ) -> Result<Self, HelperError> {
        if payload.to_string().len() > 64 * 1024 {
            return Err(HelperError::TooLarge);
        }
        Ok(Self {
            operation: operation.audit_name().to_owned(),
            payload,
        })
    }

    pub fn encode_argument(&self) -> Result<String, HelperError> {
        let bytes = serde_json::to_vec(self).map_err(|_| HelperError::InvalidPayload)?;
        if bytes.len() > 64 * 1024 {
            return Err(HelperError::TooLarge);
        }
        Ok(STANDARD.encode(bytes))
    }

    pub fn decode_argument(value: &str) -> Result<Self, HelperError> {
        let bytes = STANDARD
            .decode(value)
            .map_err(|_| HelperError::InvalidPayload)?;
        if bytes.len() > 64 * 1024 {
            return Err(HelperError::TooLarge);
        }
        let request: Self =
            serde_json::from_slice(&bytes).map_err(|_| HelperError::InvalidPayload)?;
        if !allowlisted_name(&request.operation) {
            return Err(HelperError::NotAllowlisted);
        }
        Ok(request)
    }
}

pub fn allowlisted_name(name: &str) -> bool {
    [
        "change_server_endpoint",
        "change_server_key",
        "configure_unattended_access",
        "configure_autostart",
        "configure_service",
        "configure_system_proxy",
        "install_update",
    ]
    .contains(&name)
}

/// Return the fixed elevated helper command. No user-controlled executable or
/// shell expression is ever accepted.
pub fn command(request: &HelperRequest) -> Result<(&'static str, Vec<String>), HelperError> {
    if !allowlisted_name(&request.operation) {
        return Err(HelperError::NotAllowlisted);
    }
    let argument = request.encode_argument()?;
    #[cfg(windows)]
    {
        return Ok(("BetterDesk.Desktop.Helper.exe", vec![argument]));
    }
    #[cfg(unix)]
    {
        return Ok((
            "pkexec",
            vec![
                "/usr/lib/betterdesk/betterdesk-desktop-helper".to_owned(),
                argument,
            ],
        ));
    }
    #[allow(unreachable_code)]
    Err(HelperError::NotAllowlisted)
}

/// Ask the platform helper to authorize a machine-scoped operation.
///
/// On Windows this launches the helper with the `runas` verb, which triggers
/// UAC. The helper can only write a random, short-lived grant marker and
/// cannot execute an arbitrary command. Linux will use the same operation
/// contract once the polkit helper is installed.
pub fn request_authorization(operation: PrivilegedOperation) -> Result<(), HelperError> {
    #[cfg(windows)]
    {
        use std::{
            env, fs,
            os::windows::ffi::OsStrExt,
            process, thread,
            time::{Duration, SystemTime, UNIX_EPOCH},
        };

        use windows_sys::Win32::UI::Shell::ShellExecuteW;

        let nonce_bytes = {
            let mut bytes = [0_u8; 32];
            getrandom::fill(&mut bytes).map_err(|_| HelperError::AuthorizationFailed)?;
            bytes
        };
        let nonce = hex::encode(nonce_bytes);
        let marker = env::temp_dir().join(format!(
            "betterdesk-uac-{}-{}.grant",
            process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| HelperError::AuthorizationFailed)?
                .as_nanos()
        ));
        let executable = env::current_exe().map_err(|_| HelperError::Unavailable)?;
        let helper = executable
            .parent()
            .ok_or(HelperError::Unavailable)?
            .join("BetterDesk.Desktop.Helper.exe");
        if !helper.is_file() {
            return Err(HelperError::Unavailable);
        }

        let operation = operation.audit_name();
        let params = format!(
            "--authorize {} {} {}",
            quote_argument(operation),
            quote_argument(&marker.to_string_lossy()),
            quote_argument(&nonce),
        );
        let wide = |value: &std::ffi::OsStr| {
            value
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<u16>>()
        };
        let verb = wide(std::ffi::OsStr::new("runas"));
        let file = wide(helper.as_os_str());
        let params = wide(std::ffi::OsStr::new(&params));
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                file.as_ptr(),
                params.as_ptr(),
                std::ptr::null(),
                1,
            )
        };
        if (result as usize) <= 32 {
            return Err(HelperError::AuthorizationFailed);
        }

        for _ in 0..300 {
            if let Ok(grant) = fs::read_to_string(&marker) {
                let expected = format!("{operation}\n{nonce}\n");
                let _ = fs::remove_file(&marker);
                return if grant == expected {
                    Ok(())
                } else {
                    Err(HelperError::AuthorizationFailed)
                };
            }
            thread::sleep(Duration::from_millis(100));
        }
        let _ = fs::remove_file(&marker);
        Err(HelperError::AuthorizationFailed)
    }

    #[cfg(not(windows))]
    {
        let _ = operation;
        Err(HelperError::Unavailable)
    }
}

#[cfg(windows)]
fn quote_argument(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_requests_are_allowlisted_and_round_trip() {
        let request = HelperRequest::new(
            PrivilegedOperation::ConfigureAutostart,
            serde_json::json!({"enabled": true}),
        )
        .unwrap();
        let decoded = HelperRequest::decode_argument(&request.encode_argument().unwrap()).unwrap();
        assert_eq!(decoded, request);
    }

    #[test]
    fn arbitrary_helper_names_are_rejected() {
        let request = HelperRequest {
            operation: "run_shell".into(),
            payload: serde_json::json!({}),
        };
        assert!(command(&request).is_err());
    }
}
