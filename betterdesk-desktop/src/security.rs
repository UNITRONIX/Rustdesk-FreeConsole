use std::path::Path;

use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingScope {
    User,
    Session,
    Machine,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrivilegedOperation {
    ChangeServerEndpoint,
    ChangeServerKey,
    ConfigureUnattendedAccess,
    ConfigureAutostart,
    ConfigureService,
    ConfigureSystemProxy,
    InstallUpdate,
}

impl PrivilegedOperation {
    pub fn scope(self) -> SettingScope {
        SettingScope::Machine
    }

    pub fn audit_name(self) -> &'static str {
        match self {
            Self::ChangeServerEndpoint => "change_server_endpoint",
            Self::ChangeServerKey => "change_server_key",
            Self::ConfigureUnattendedAccess => "configure_unattended_access",
            Self::ConfigureAutostart => "configure_autostart",
            Self::ConfigureService => "configure_service",
            Self::ConfigureSystemProxy => "configure_system_proxy",
            Self::InstallUpdate => "install_update",
        }
    }
}

#[derive(Debug, Error)]
pub enum SecurityError {
    #[error("operation is not allowed by the privileged helper")]
    OperationNotAllowed,
    #[error("path is outside the permitted root")]
    PathOutsideRoot,
    #[error("secret store error: {0}")]
    SecretStore(String),
}

pub fn require_admin(operation: PrivilegedOperation, confirmed: bool) -> Result<(), SecurityError> {
    if operation.scope() != SettingScope::Machine || confirmed {
        Ok(())
    } else {
        Err(SecurityError::OperationNotAllowed)
    }
}

pub fn validate_relative_path(root: &Path, requested: &Path) -> Result<(), SecurityError> {
    let root = root
        .canonicalize()
        .map_err(|_| SecurityError::PathOutsideRoot)?;
    let requested = requested
        .canonicalize()
        .map_err(|_| SecurityError::PathOutsideRoot)?;
    if requested.starts_with(root) {
        Ok(())
    } else {
        Err(SecurityError::PathOutsideRoot)
    }
}

/// Store a credential using the operating system's credential provider.
///
/// The keyring backend can be unavailable on minimal Linux installations; in
/// that case callers must surface a setup error instead of falling back to a
/// plaintext file.
pub fn store_secret(service: &str, account: &str, secret: &str) -> Result<(), SecurityError> {
    let entry = keyring::Entry::new(service, account)
        .map_err(|error| SecurityError::SecretStore(error.to_string()))?;
    entry
        .set_password(secret)
        .map_err(|error| SecurityError::SecretStore(error.to_string()))
}

pub fn read_secret(service: &str, account: &str) -> Result<Option<String>, SecurityError> {
    let entry = keyring::Entry::new(service, account)
        .map_err(|error| SecurityError::SecretStore(error.to_string()))?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(SecurityError::SecretStore(error.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn machine_operation_requires_confirmation() {
        assert!(require_admin(PrivilegedOperation::ConfigureAutostart, false).is_err());
        assert!(require_admin(PrivilegedOperation::ConfigureAutostart, true).is_ok());
    }

    #[test]
    fn operation_names_are_stable_for_audit() {
        assert_eq!(
            PrivilegedOperation::ChangeServerKey.audit_name(),
            "change_server_key"
        );
    }
}
