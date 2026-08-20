//! BetterDesk CDAP remote-desktop contract.
//!
//! These messages are deliberately small and explicit. The server forwards
//! them between authenticated peers; it does not decode screen or audio data.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};

use crate::cdap::{CdapMessage, MAX_MESSAGE_BYTES};

pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopStart {
    pub session_id: String,
    pub width: u32,
    pub height: u32,
    pub quality: u8,
    pub fps: u8,
    pub codecs: Vec<String>,
    pub capabilities: Vec<String>,
    pub view_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopInput {
    pub session_id: String,
    #[serde(rename = "type")]
    pub input_type: String,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub button: Option<u8>,
    pub key: Option<String>,
    pub code: Option<String>,
    pub text: Option<String>,
    pub modifiers: Vec<String>,
    pub delta_x: Option<i32>,
    pub delta_y: Option<i32>,
    pub pressed: Option<bool>,
}

fn message<T: Serialize>(message_type: &str, payload: T) -> CdapMessage {
    CdapMessage {
        message_type: message_type.to_owned(),
        payload: serde_json::to_value(payload).expect("desktop payload is serializable"),
    }
}

pub fn start(request: DesktopStart) -> CdapMessage {
    message("desktop_start", request)
}

pub fn frame(
    session_id: &str,
    format: &str,
    width: u32,
    height: u32,
    encoded_frame: &[u8],
) -> anyhow::Result<CdapMessage> {
    if encoded_frame.len() > MAX_FRAME_BYTES {
        anyhow::bail!("desktop frame is too large");
    }
    Ok(message(
        "desktop_frame",
        serde_json::json!({
            "session_id": session_id,
            "format": format,
            "width": width,
            "height": height,
            "data": STANDARD.encode(encoded_frame),
            "timestamp": chrono_like_timestamp(),
        }),
    ))
}

pub fn input(input: DesktopInput) -> CdapMessage {
    message("desktop_input", input)
}

pub fn resize(session_id: &str, width: u32, height: u32) -> CdapMessage {
    message(
        "desktop_resize",
        serde_json::json!({"session_id": session_id, "width": width, "height": height}),
    )
}

pub fn clipboard(session_id: &str, format: &str, data: &str) -> anyhow::Result<CdapMessage> {
    if data.len() > MAX_MESSAGE_BYTES {
        anyhow::bail!("clipboard payload is too large");
    }
    Ok(message(
        "clipboard_set",
        serde_json::json!({"session_id": session_id, "format": format, "data": data}),
    ))
}

pub fn file_request(
    session_id: &str,
    request_type: &str,
    payload: serde_json::Value,
) -> CdapMessage {
    let mut payload = payload;
    if let Some(object) = payload.as_object_mut() {
        object.insert("session_id".to_owned(), serde_json::json!(session_id));
    }
    message(request_type, payload)
}

pub fn audio_frame(
    session_id: &str,
    codec: &str,
    encoded_audio: &[u8],
    timestamp: i64,
) -> anyhow::Result<CdapMessage> {
    if encoded_audio.len() > MAX_FRAME_BYTES {
        anyhow::bail!("audio frame is too large");
    }
    Ok(message(
        "audio_frame",
        serde_json::json!({
            "session_id": session_id,
            "codec": codec,
            "data": STANDARD.encode(encoded_audio),
            "timestamp": timestamp,
        }),
    ))
}

fn chrono_like_timestamp() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_is_bounded_and_base64_encoded() {
        let frame = frame("desk-1", "jpeg", 1920, 1080, &[1, 2, 3]).unwrap();
        assert_eq!(frame.message_type, "desktop_frame");
        assert_eq!(frame.payload["data"], "AQID");
    }

    #[test]
    fn input_contract_supports_keyboard_and_pointer_fields() {
        let input = input(DesktopInput {
            session_id: "desk-1".to_owned(),
            input_type: "mouse_move".to_owned(),
            x: Some(10),
            y: Some(20),
            button: None,
            key: None,
            code: None,
            text: None,
            modifiers: vec![],
            delta_x: None,
            delta_y: None,
            pressed: None,
        });
        assert_eq!(input.payload["type"], "mouse_move");
        assert_eq!(input.payload["x"], 10);
    }
}
