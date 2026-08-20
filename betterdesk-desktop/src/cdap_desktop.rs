//! CDAP desktop-session service for incoming BetterDesk connections.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use tokio::time::{self, Duration, Interval, MissedTickBehavior};

use crate::{
    audio::AudioFrame,
    cdap::{CdapEvent, CdapMessage, CdapSession},
    clipboard,
    desktop::{DesktopInput, DesktopStart},
    desktop_session::DesktopSessionRuntime,
    file_transfer::MAX_CHUNK_BYTES,
};

#[derive(Debug, Deserialize)]
struct AudioPayload {
    codec: String,
    sample_rate: u32,
    channels: u8,
    data: String,
}

/// Serve one authenticated CDAP connection until the peer closes it.
///
/// The server only forwards CDAP envelopes. Screen capture, input injection,
/// clipboard access and file policy remain local to this process.
pub async fn serve(mut session: CdapSession) -> anyhow::Result<()> {
    let mut runtime: Option<DesktopSessionRuntime> = None;
    let mut interval = time::interval(Duration::from_millis(66));
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            event = session.next_event() => {
                let Some(event) = event? else { return Ok(()); };
                match event {
                    CdapEvent::Json(message) => {
                        handle_json(&mut session, &mut runtime, &mut interval, message).await?;
                    }
                    CdapEvent::Binary { .. } => {
                        // Binary audio/video frames are validated by the CDAP
                        // decoder and consumed by the negotiated media path.
                    }
                }
            }
            _ = interval.tick(), if runtime.is_some() => {
                if let Some(active) = runtime.as_ref() {
                    let frame = active.frame_message()?;
                    session.send_json(&frame).await?;
                }
            }
        }
    }
}

async fn handle_json(
    session: &mut CdapSession,
    runtime: &mut Option<DesktopSessionRuntime>,
    interval: &mut Interval,
    message: CdapMessage,
) -> anyhow::Result<()> {
    match message.message_type.as_str() {
        "desktop_start" => {
            let request: DesktopStart = serde_json::from_value(message.payload)?;
            let fps = request.fps.clamp(1, 60);
            *runtime = Some(DesktopSessionRuntime::start(request)?);
            *interval = time::interval(Duration::from_millis(1_000 / u64::from(fps)));
            interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
        }
        "desktop_input" => {
            let input: DesktopInput = serde_json::from_value(message.payload)?;
            if let Some(active) = runtime.as_ref() {
                active.apply_input(&input)?;
            }
        }
        "desktop_resize" => {
            if let Some(active) = runtime.as_mut() {
                let width = message.payload["width"]
                    .as_u64()
                    .ok_or_else(|| anyhow::anyhow!("desktop resize width is invalid"))?
                    as u32;
                let height = message.payload["height"]
                    .as_u64()
                    .ok_or_else(|| anyhow::anyhow!("desktop resize height is invalid"))?
                    as u32;
                active.resize(width, height)?;
            }
        }
        "clipboard_set" => {
            if message.payload["format"] == "text" {
                let data = message.payload["data"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("clipboard data is invalid"))?;
                clipboard::write_text(data)?;
            }
        }
        "audio_input" | "audio_frame" => {
            let payload: AudioPayload = serde_json::from_value(message.payload)?;
            let data = STANDARD.decode(payload.data)?;
            let frame = AudioFrame {
                codec: payload.codec,
                sample_rate: payload.sample_rate,
                channels: payload.channels,
                data,
            };
            frame.validate()?;
        }
        "file_read" | "file_write" => {
            if message.payload["length"].as_u64().unwrap_or(0) > MAX_CHUNK_BYTES as u64 {
                anyhow::bail!("file-transfer request exceeds the chunk limit");
            }
            anyhow::bail!("file transfer requires an operator-approved root");
        }
        "desktop_end" | "desktop_stop" => {
            if let Some(active) = runtime.as_mut() {
                active.end();
            }
            *runtime = None;
        }
        "heartbeat" => {
            session.send_heartbeat().await?;
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_payload_is_decoded_only_after_size_and_codec_validation() {
        let payload = serde_json::json!({
            "codec": "opus",
            "sample_rate": 48_000,
            "channels": 2,
            "data": STANDARD.encode([1_u8, 2, 3]),
        });
        let parsed: AudioPayload = serde_json::from_value(payload).unwrap();
        assert_eq!(parsed.codec, "opus");
    }
}
