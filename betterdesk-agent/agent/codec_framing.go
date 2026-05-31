package agent

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"log"
)

// ── Encoded-stream framing ──────────────────────────────────────────────────
//
// Image codecs (mjpeg/webp) emit one self-contained still per frame; video
// codecs (h264/vp9/av1) emit a continuous elementary stream that must be split
// into access units before each can be forwarded as one WebSocket message.
//
// Each reader calls onFrame(payload, keyframe) for every decodable unit. The
// streamer prepends the binary frame header (session ID + a 1-byte flag for
// video codecs) and sends it.
//
// These parsers are intentionally conservative and tuned for the agent's own
// encoder settings (single slice per picture, no B-frames, fixed short GOP).
// They are not general-purpose demuxers.

// readImageFrames dispatches to the correct still-image splitter.
func readImageFrames(ctx context.Context, r io.Reader, codec string, onFrame func(frame []byte)) {
	switch codec {
	case CodecWebP:
		readWebPFrames(ctx, r, onFrame)
	default:
		readJPEGFrames(ctx, r, onFrame)
	}
}

// readWebPFrames splits a stream of concatenated WebP files (image2pipe with
// libwebp). A WebP file is a RIFF container: 'RIFF' + uint32LE payloadSize +
// 'WEBP' + payload. The full file length is 8 + payloadSize.
func readWebPFrames(ctx context.Context, r io.Reader, onFrame func([]byte)) {
	buf := make([]byte, 0, 256*1024)
	tmp := make([]byte, 32768)
	riff := []byte("RIFF")

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		n, readErr := r.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}

		for {
			start := bytes.Index(buf, riff)
			if start < 0 {
				if len(buf) > 12 {
					buf = buf[len(buf)-4:] // keep a possible partial 'RIFF'
				}
				break
			}
			if start > 0 {
				buf = buf[start:]
				start = 0
			}
			if len(buf) < 12 {
				break // need the RIFF/size/WEBP header
			}
			if !bytes.Equal(buf[8:12], []byte("WEBP")) {
				// False positive 'RIFF' — drop one byte and resync.
				buf = buf[4:]
				continue
			}
			payloadSize := int(binary.LittleEndian.Uint32(buf[4:8]))
			total := 8 + payloadSize
			if total <= 0 || total > 32*1024*1024 {
				buf = buf[4:] // corrupt size — resync
				continue
			}
			if len(buf) < total {
				break // incomplete file
			}
			frame := make([]byte, total)
			copy(frame, buf[:total])
			onFrame(frame)
			buf = buf[total:]
		}

		if readErr == io.EOF {
			return
		}
		if readErr != nil {
			log.Printf("[desktop] webp read error: %v", readErr)
			return
		}
		if len(buf) > 48*1024*1024 {
			buf = buf[:0]
		}
	}
}

// ── H.264 Annex-B ───────────────────────────────────────────────────────────

// readAnnexBFrames splits an H.264 Annex-B elementary stream into access units.
// Tuned for the agent's encode (single slice per picture, no B-frames): every
// VCL NAL (type 1 = non-IDR, type 5 = IDR) terminates one access unit. Leading
// parameter-set / SEI NALs (7,8,6) are attached to the AU they precede so the
// WebCodecs decoder receives in-band SPS/PPS with each keyframe.
func readAnnexBFrames(ctx context.Context, r io.Reader, onFrame func(au []byte, keyframe bool)) {
	buf := make([]byte, 0, 512*1024)
	tmp := make([]byte, 65536)

	// au accumulates the NAL units of the current access unit.
	var au []byte
	auHasVCL := false
	auIsKey := false

	flush := func() {
		if len(au) > 0 && auHasVCL {
			out := make([]byte, len(au))
			copy(out, au)
			onFrame(out, auIsKey)
		}
		au = au[:0]
		auHasVCL = false
		auIsKey = false
	}

	for {
		select {
		case <-ctx.Done():
			flush()
			return
		default:
		}

		n, readErr := r.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}

		// Extract complete NAL units. A NAL starts at a 3- or 4-byte start code
		// and ends at the next start code. We only consume a NAL once the NEXT
		// start code is visible so the unit is guaranteed complete.
		for {
			s := indexStartCode(buf, 0)
			if s < 0 {
				break
			}
			scLen := startCodeLen(buf, s)
			next := indexStartCode(buf, s+scLen)
			if next < 0 {
				// No following start code yet — keep from s for next read.
				if s > 0 {
					buf = buf[s:]
				}
				break
			}
			nal := buf[s:next] // includes its own leading start code
			nalType := byte(0)
			if s+scLen < next {
				nalType = nal[scLen] & 0x1F
			}
			switch nalType {
			case 1: // non-IDR slice → completes a delta AU
				if auHasVCL {
					flush()
				}
				au = append(au, nal...)
				auHasVCL = true
			case 5: // IDR slice → completes a key AU
				if auHasVCL {
					flush()
				}
				au = append(au, nal...)
				auHasVCL = true
				auIsKey = true
			case 7, 8, 6: // SPS, PPS, SEI → prefix for the next AU (key)
				if auHasVCL {
					flush()
				}
				au = append(au, nal...)
				if nalType == 7 {
					auIsKey = true
				}
			default:
				au = append(au, nal...)
			}
			buf = buf[next:]
		}

		if readErr == io.EOF {
			flush()
			return
		}
		if readErr != nil {
			log.Printf("[desktop] h264 read error: %v", readErr)
			flush()
			return
		}
		if len(buf) > 32*1024*1024 {
			buf = buf[:0]
		}
	}
}

// indexStartCode returns the index of the next Annex-B start code (00 00 01 or
// 00 00 00 01) at or after off, or -1.
func indexStartCode(b []byte, off int) int {
	for i := off; i+3 <= len(b); i++ {
		if b[i] == 0 && b[i+1] == 0 {
			if b[i+2] == 1 {
				return i
			}
			if i+4 <= len(b) && b[i+2] == 0 && b[i+3] == 1 {
				return i
			}
		}
	}
	return -1
}

// startCodeLen returns 3 or 4 for the start code at index s.
func startCodeLen(b []byte, s int) int {
	if s+3 < len(b) && b[s+2] == 0 && b[s+3] == 1 {
		return 4
	}
	return 3
}

// ── IVF (VP9 / AV1) ─────────────────────────────────────────────────────────

// readIVFFrames parses an IVF container. The 32-byte file header is skipped,
// then each frame is a 12-byte header (uint32LE size + uint64LE timestamp)
// followed by the raw VP9/AV1 frame. Keyframe detection is codec-specific.
func readIVFFrames(ctx context.Context, r io.Reader, codec string, onFrame func(frame []byte, keyframe bool)) {
	buf := make([]byte, 0, 512*1024)
	tmp := make([]byte, 65536)
	headerSkipped := false

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		n, readErr := r.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}

		if !headerSkipped {
			if len(buf) < 32 {
				goto readNext
			}
			// Sanity: file header signature is 'DKIF'.
			if !bytes.Equal(buf[0:4], []byte("DKIF")) {
				log.Printf("[desktop] ivf: missing DKIF signature")
				return
			}
			buf = buf[32:]
			headerSkipped = true
		}

		for {
			if len(buf) < 12 {
				break
			}
			size := int(binary.LittleEndian.Uint32(buf[0:4]))
			if size < 0 || size > 32*1024*1024 {
				log.Printf("[desktop] ivf: bad frame size %d", size)
				return
			}
			if len(buf) < 12+size {
				break // incomplete frame
			}
			payload := buf[12 : 12+size]
			frame := make([]byte, size)
			copy(frame, payload)
			key := isVideoKeyframe(codec, frame)
			onFrame(frame, key)
			buf = buf[12+size:]
		}

	readNext:
		if readErr == io.EOF {
			return
		}
		if readErr != nil {
			log.Printf("[desktop] ivf read error: %v", readErr)
			return
		}
	}
}

// isVideoKeyframe inspects a raw VP9/AV1 frame to decide whether it is a key
// frame. Conservative: when in doubt it returns false (delta); the encoder's
// fixed GOP guarantees a real keyframe arrives at least once per GOP, and the
// operator decoder waits for the first key chunk before configuring.
func isVideoKeyframe(codec string, frame []byte) bool {
	switch codec {
	case CodecVP9:
		return vp9IsKeyframe(frame)
	case CodecAV1:
		return av1IsKeyframe(frame)
	}
	return false
}

// vp9IsKeyframe parses the VP9 uncompressed header (spec 6.2):
//   frame_marker (2)=0b10, profile_low (1), profile_high (1),
//   [reserved if profile==3], show_existing_frame (1),
//   if !show_existing_frame: frame_type (1) where 0 = KEY_FRAME.
func vp9IsKeyframe(f []byte) bool {
	if len(f) < 1 {
		return false
	}
	br := bitReader{data: f}
	if br.read(2) != 0b10 { // frame_marker
		return false
	}
	pLow := br.read(1)
	pHigh := br.read(1)
	if (pHigh<<1|pLow) == 3 {
		br.read(1) // reserved_zero
	}
	if br.read(1) == 1 { // show_existing_frame
		return false
	}
	return br.read(1) == 0 // frame_type: 0 = key
}

// av1IsKeyframe treats the presence of an OBU_SEQUENCE_HEADER (type 1) in the
// temporal unit as a keyframe marker. With the agent's forced-GOP realtime
// encode the sequence header is emitted together with every key frame, so this
// is a reliable proxy without full OBU frame-header parsing.
func av1IsKeyframe(f []byte) bool {
	i := 0
	for i < len(f) {
		if i >= len(f) {
			break
		}
		hdr := f[i]
		obuType := (hdr >> 3) & 0x0F
		extFlag := (hdr >> 2) & 0x01
		hasSize := (hdr >> 1) & 0x01
		i++
		if extFlag == 1 {
			i++ // extension header byte
		}
		var size int
		if hasSize == 1 {
			v, read := readLeb128(f[i:])
			if read == 0 {
				break
			}
			size = int(v)
			i += read
		} else {
			size = len(f) - i
		}
		if obuType == 1 { // OBU_SEQUENCE_HEADER
			return true
		}
		i += size
	}
	return false
}

// readLeb128 reads an unsigned LEB128 value; returns (value, bytesRead).
func readLeb128(b []byte) (uint64, int) {
	var v uint64
	for i := 0; i < len(b) && i < 8; i++ {
		v |= uint64(b[i]&0x7F) << (7 * i)
		if b[i]&0x80 == 0 {
			return v, i + 1
		}
	}
	return 0, 0
}

// bitReader is a minimal MSB-first bit reader for the small header parses above.
type bitReader struct {
	data []byte
	pos  int // bit position
}

func (b *bitReader) read(n int) uint32 {
	var v uint32
	for i := 0; i < n; i++ {
		bytePos := b.pos >> 3
		if bytePos >= len(b.data) {
			b.pos++
			v <<= 1
			continue
		}
		bit := (b.data[bytePos] >> (7 - uint(b.pos&7))) & 1
		v = (v << 1) | uint32(bit)
		b.pos++
	}
	return v
}
