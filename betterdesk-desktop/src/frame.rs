use thiserror::Error;

pub const MAX_FRAME_SIZE: usize = 64 * 1024 * 1024;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum FrameError {
    #[error("frame payload is too large")]
    TooLarge,
    #[error("frame header is truncated")]
    TruncatedHeader,
    #[error("frame payload is truncated")]
    TruncatedPayload,
}

pub fn encode(payload: &[u8]) -> Result<Vec<u8>, FrameError> {
    if payload.len() > MAX_FRAME_SIZE || payload.len() > 0x3fff_ffff {
        return Err(FrameError::TooLarge);
    }

    let length = payload.len() as u32;
    let header_len = if length <= 0x3f {
        1
    } else if length <= 0x3fff {
        2
    } else if length <= 0x3f_ffff {
        3
    } else {
        4
    };

    let encoded = (length << 2) | (header_len - 1) as u32;
    let mut output = Vec::with_capacity(header_len + payload.len());
    output.extend_from_slice(&encoded.to_le_bytes()[..header_len]);
    output.extend_from_slice(payload);
    Ok(output)
}

pub struct Decoder {
    buffer: Vec<u8>,
}

impl Default for Decoder {
    fn default() -> Self {
        Self::new()
    }
}

impl Decoder {
    pub fn new() -> Self {
        Self { buffer: Vec::new() }
    }

    pub fn reset(&mut self) {
        self.buffer.clear();
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<Vec<u8>>, FrameError> {
        self.buffer.extend_from_slice(bytes);
        let mut frames = Vec::new();
        let mut offset = 0;

        while offset < self.buffer.len() {
            let first = self.buffer[offset];
            let header_len = (first & 0x03) as usize + 1;
            if self.buffer.len() - offset < header_len {
                break;
            }

            let mut encoded = 0_u32;
            for index in 0..header_len {
                encoded |= u32::from(self.buffer[offset + index]) << (index * 8);
            }
            let payload_len = (encoded >> 2) as usize;
            if payload_len > MAX_FRAME_SIZE {
                self.reset();
                return Err(FrameError::TooLarge);
            }

            let frame_len = header_len + payload_len;
            if self.buffer.len() - offset < frame_len {
                break;
            }
            frames.push(self.buffer[offset + header_len..offset + frame_len].to_vec());
            offset += frame_len;
        }

        if offset > 0 {
            self.buffer.drain(..offset);
        }
        if self.buffer.len() > MAX_FRAME_SIZE + 4 {
            self.reset();
            return Err(FrameError::TruncatedPayload);
        }
        Ok(frames)
    }

    pub fn buffered_len(&self) -> usize {
        self.buffer.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_boundary_lengths() {
        for length in [0, 1, 63, 64, 16_383, 16_384, 4_194_303, 4_194_304] {
            let payload = vec![0xA5; length];
            let encoded = encode(&payload).unwrap();
            let mut decoder = Decoder::new();
            let frames = decoder.feed(&encoded).unwrap();
            assert_eq!(frames, vec![payload], "length={length}");
        }
    }

    #[test]
    fn partial_frames_are_reassembled() {
        let encoded = encode(b"betterdesk").unwrap();
        let mut decoder = Decoder::new();
        assert!(decoder.feed(&encoded[..1]).unwrap().is_empty());
        assert_eq!(
            decoder.feed(&encoded[1..]).unwrap(),
            vec![b"betterdesk".to_vec()]
        );
    }

    #[test]
    fn oversized_payload_is_rejected() {
        let encoded = (((MAX_FRAME_SIZE as u32 + 1) << 2) | 3).to_le_bytes();
        let mut decoder = Decoder::new();
        assert_eq!(decoder.feed(&encoded).unwrap_err(), FrameError::TooLarge);
    }
}
