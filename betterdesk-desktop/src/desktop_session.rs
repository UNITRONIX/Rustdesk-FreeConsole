//! Bidirectional desktop-session state machine.
//!
//! The transport is intentionally independent from Flutter: the same runtime
//! handles an operator session and an incoming session. Flutter consumes the
//! resulting CDAP events through the native bridge.

use anyhow::Result;

use crate::{
    desktop::{self, DesktopInput, DesktopStart},
    windows_media::{self, EncodedFrame, MonitorInfo},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopSessionState {
    Starting,
    Active,
    Ending,
    Ended,
}

pub struct DesktopSessionRuntime {
    pub session_id: String,
    pub state: DesktopSessionState,
    pub view_only: bool,
    pub quality: u8,
    pub fps: u8,
    pub monitors: Vec<MonitorInfo>,
}

impl DesktopSessionRuntime {
    pub fn start(request: DesktopStart) -> Result<Self> {
        if request.session_id.trim().is_empty() {
            anyhow::bail!("desktop session id is required");
        }
        if request.width == 0 || request.height == 0 {
            anyhow::bail!("desktop session dimensions are invalid");
        }
        Ok(Self {
            session_id: request.session_id,
            state: DesktopSessionState::Active,
            view_only: request.view_only,
            quality: request.quality.clamp(1, 100),
            fps: request.fps.clamp(1, 60),
            monitors: windows_media::monitors(),
        })
    }

    pub fn capture_frame(&self) -> Result<EncodedFrame> {
        if self.state != DesktopSessionState::Active {
            anyhow::bail!("desktop session is not active");
        }
        windows_media::capture_primary_jpeg(self.quality)
    }

    pub fn frame_message(&self) -> Result<crate::cdap::CdapMessage> {
        let frame = self.capture_frame()?;
        desktop::frame(
            &self.session_id,
            frame.format,
            frame.width,
            frame.height,
            &frame.data,
        )
    }

    pub fn apply_input(&self, input: &DesktopInput) -> Result<()> {
        if self.view_only {
            anyhow::bail!("view-only desktop session rejects input");
        }
        if input.session_id != self.session_id {
            anyhow::bail!("input session id does not match");
        }
        windows_media::inject_input(input)
    }

    pub fn resize(&mut self, width: u32, height: u32) -> Result<()> {
        if width == 0 || height == 0 {
            anyhow::bail!("desktop resize dimensions are invalid");
        }
        Ok(())
    }

    pub fn end(&mut self) {
        self.state = DesktopSessionState::Ended;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_only_sessions_reject_input_before_platform_calls() {
        let session = DesktopSessionRuntime::start(DesktopStart {
            session_id: "desk-1".to_owned(),
            width: 1280,
            height: 720,
            quality: 70,
            fps: 30,
            codecs: vec!["jpeg".to_owned()],
            capabilities: vec!["screen_view".to_owned()],
            view_only: true,
        })
        .unwrap();
        let input = DesktopInput {
            session_id: "desk-1".to_owned(),
            input_type: "mouse_move".to_owned(),
            x: Some(1),
            y: Some(1),
            button: None,
            key: None,
            code: None,
            text: None,
            modifiers: vec![],
            delta_x: None,
            delta_y: None,
            pressed: None,
        };
        assert!(session.apply_input(&input).is_err());
    }
}
