//! Settings lock — tamper resistance for agent configuration.
//!
//! When enabled, non-administrator users cannot change security-sensitive
//! settings unless they supply the operator master password (verified against
//! a bcrypt hash stored locally or pushed from the server).

use anyhow::{anyhow, Result};
use bcrypt::{hash, verify, DEFAULT_COST};
use serde::{Deserialize, Serialize};

/// Persisted settings-lock state in agent-config.json.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SettingsLock {
    /// When true, sensitive settings require OS admin or master password.
    #[serde(default)]
    pub enabled: bool,
    /// bcrypt hash of the operator master password. Never expose to frontend.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub master_password_hash: String,
}

impl SettingsLock {
    pub fn is_locked(&self) -> bool {
        self.enabled && !self.master_password_hash.is_empty()
    }

    pub fn set_master_password(&mut self, password: &str) -> Result<()> {
        let trimmed = password.trim();
        if trimmed.len() < 8 {
            return Err(anyhow!("master password must be at least 8 characters"));
        }
        self.master_password_hash = hash(trimmed, DEFAULT_COST)?;
        self.enabled = true;
        Ok(())
    }

    pub fn verify_unlock(&self, password: &str) -> bool {
        if self.master_password_hash.is_empty() {
            return false;
        }
        verify(password, &self.master_password_hash).unwrap_or(false)
    }

    pub fn disable_with_password(&mut self, password: &str) -> Result<()> {
        if !self.verify_unlock(password) {
            return Err(anyhow!("incorrect master password"));
        }
        self.enabled = false;
        self.master_password_hash.clear();
        Ok(())
    }
}

/// Returns true when the caller may change security-sensitive settings.
pub fn may_change_settings(is_os_admin: bool, lock: &SettingsLock, unlock_password: Option<&str>) -> bool {
    if !lock.is_locked() {
        return true;
    }
    if is_os_admin {
        return true;
    }
    if let Some(pw) = unlock_password {
        return lock.verify_unlock(pw);
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_requires_password_or_admin() {
        let mut lock = SettingsLock::default();
        lock.set_master_password("test-password-1").unwrap();
        assert!(lock.is_locked());
        assert!(!may_change_settings(false, &lock, None));
        assert!(may_change_settings(true, &lock, None));
        assert!(may_change_settings(false, &lock, Some("test-password-1")));
    }
}
