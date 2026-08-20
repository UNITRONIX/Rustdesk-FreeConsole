//! Bounded audio-session packets.
//!
//! Device audio capture/output is negotiated by the peer. The core validates
//! packet size and codec metadata before passing it to the RustDesk or CDAP
//! transport.

use anyhow::Result;

pub const MAX_AUDIO_FRAME_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioFrame {
    pub codec: String,
    pub sample_rate: u32,
    pub channels: u8,
    pub data: Vec<u8>,
}

impl AudioFrame {
    pub fn validate(&self) -> Result<()> {
        if !matches!(self.codec.as_str(), "opus" | "pcm") {
            anyhow::bail!("unsupported audio codec");
        }
        if !(8_000..=192_000).contains(&self.sample_rate) {
            anyhow::bail!("audio sample rate is outside the supported range");
        }
        if !(1..=2).contains(&self.channels) {
            anyhow::bail!("audio channel count is invalid");
        }
        if self.data.len() > MAX_AUDIO_FRAME_BYTES {
            anyhow::bail!("audio frame is too large");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_frame_contract_rejects_oversized_data() {
        let frame = AudioFrame {
            codec: "opus".to_owned(),
            sample_rate: 48_000,
            channels: 2,
            data: vec![0; MAX_AUDIO_FRAME_BYTES + 1],
        };
        assert!(frame.validate().is_err());
    }
}
