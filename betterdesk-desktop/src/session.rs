use std::time::Duration;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::transport::{SessionSnapshot, SessionState};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TransportKind {
    RustDesk,
    Cdap,
}

impl TransportKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::RustDesk => "RustDesk-compatible",
            Self::Cdap => "BetterDesk CDAP",
        }
    }
}

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("invalid state transition from {from:?} to {to:?}")]
    InvalidTransition {
        from: SessionState,
        to: SessionState,
    },
}

pub struct SessionManager {
    snapshot: SessionSnapshot,
    transport: Option<TransportKind>,
    retry_attempt: u32,
}

impl SessionManager {
    pub fn new(peer_id: impl Into<String>) -> Self {
        Self {
            snapshot: SessionSnapshot::idle(peer_id),
            transport: None,
            retry_attempt: 0,
        }
    }

    pub fn snapshot(&self) -> &SessionSnapshot {
        &self.snapshot
    }

    pub fn begin(&mut self, transport: TransportKind) -> Result<(), SessionError> {
        self.transition(SessionState::Connecting)?;
        self.transport = Some(transport);
        self.snapshot.transport = transport.label().to_owned();
        self.snapshot.capabilities.clear();
        self.retry_attempt = 0;
        Ok(())
    }

    pub fn authenticate(&mut self) -> Result<(), SessionError> {
        self.transition(SessionState::Authenticating)
    }

    pub fn connected(&mut self, capabilities: Vec<String>) -> Result<(), SessionError> {
        self.transition(SessionState::Connected)?;
        self.snapshot.capabilities = capabilities;
        self.retry_attempt = 0;
        Ok(())
    }

    pub fn reconnecting(&mut self) -> Result<Duration, SessionError> {
        self.transition(SessionState::Reconnecting)?;
        self.retry_attempt = self.retry_attempt.saturating_add(1);
        let seconds = 1_u64 << self.retry_attempt.min(5);
        Ok(Duration::from_secs(seconds.min(30)))
    }

    pub fn disconnected(&mut self) -> Result<(), SessionError> {
        self.transition(SessionState::Disconnected)
    }

    pub fn failed(&mut self) -> Result<(), SessionError> {
        self.transition(SessionState::Failed)
    }

    pub fn reset(&mut self) -> Result<(), SessionError> {
        self.transition(SessionState::Idle)?;
        self.transport = None;
        self.snapshot.transport.clear();
        self.snapshot.capabilities.clear();
        self.snapshot.latency_ms = None;
        self.retry_attempt = 0;
        Ok(())
    }

    fn transition(&mut self, next: SessionState) -> Result<(), SessionError> {
        let allowed = matches!(
            (self.snapshot.state, next),
            (SessionState::Idle, SessionState::Connecting)
                | (SessionState::Connecting, SessionState::Authenticating)
                | (SessionState::Connecting, SessionState::Failed)
                | (SessionState::Authenticating, SessionState::Connected)
                | (SessionState::Authenticating, SessionState::Failed)
                | (SessionState::Connected, SessionState::Reconnecting)
                | (SessionState::Connected, SessionState::Disconnected)
                | (SessionState::Reconnecting, SessionState::Connected)
                | (SessionState::Reconnecting, SessionState::Failed)
                | (SessionState::Failed, SessionState::Connecting)
                | (SessionState::Disconnected, SessionState::Connecting)
                | (SessionState::Disconnected, SessionState::Idle)
                | (SessionState::Failed, SessionState::Idle)
                | (SessionState::Connected, SessionState::Idle)
        );
        if !allowed {
            return Err(SessionError::InvalidTransition {
                from: self.snapshot.state,
                to: next,
            });
        }
        self.snapshot.state = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_backoff_is_bounded() {
        let mut session = SessionManager::new("BD-1");
        session.begin(TransportKind::RustDesk).unwrap();
        session.authenticate().unwrap();
        session.connected(vec!["video".into()]).unwrap();
        for _ in 0..10 {
            let delay = session.reconnecting().unwrap();
            assert!(delay <= Duration::from_secs(30));
            session.failed().unwrap();
            session.begin(TransportKind::RustDesk).unwrap();
            session.authenticate().unwrap();
            session.connected(Vec::new()).unwrap();
        }
    }

    #[test]
    fn invalid_transition_is_rejected() {
        let mut session = SessionManager::new("BD-1");
        assert!(session.connected(Vec::new()).is_err());
    }
}
