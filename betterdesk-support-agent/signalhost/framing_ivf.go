package signalhost

import (
	"context"
	"encoding/binary"
	"io"
	"log"
)

func readIVFFrames(ctx context.Context, r io.Reader, wire string, onFrame func(frame []byte, keyframe bool)) {
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
				if readErr != nil {
					return
				}
				continue
			}
			if string(buf[0:4]) != "DKIF" {
				log.Printf("[signalhost] ivf: missing DKIF signature")
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
			if size <= 0 || size > 32*1024*1024 {
				log.Printf("[signalhost] ivf: bad frame size %d", size)
				return
			}
			if len(buf) < 12+size {
				break
			}
			payload := buf[12 : 12+size]
			frame := make([]byte, size)
			copy(frame, payload)
			onFrame(frame, isIVFKeyframe(wire, frame))
			buf = buf[12+size:]
		}

		if readErr != nil {
			return
		}
	}
}

func isIVFKeyframe(wire string, frame []byte) bool {
	switch wire {
	case wireVP9:
		return vp9IsKeyframe(frame)
	case wireVP8:
		return vp8IsKeyframe(frame)
	case wireAV1:
		return av1IsKeyframe(frame)
	default:
		return false
	}
}

func vp9IsKeyframe(f []byte) bool {
	if len(f) < 1 {
		return false
	}
	b := f[0]
	if (b >> 6) != 0b10 {
		return false
	}
	profile := (b >> 4) & 0x3
	bit := 4
	if profile == 3 {
		bit++
	}
	showExisting := (b >> (7 - bit)) & 1
	bit++
	if showExisting == 1 {
		return false
	}
	if bit > 7 {
		return false
	}
	frameType := (b >> (7 - bit)) & 1
	return frameType == 0
}

func vp8IsKeyframe(f []byte) bool {
	if len(f) < 1 {
		return false
	}
	return (f[0] & 1) == 0
}

func av1IsKeyframe(f []byte) bool {
	// Conservative: treat OBU_FRAME / FRAME_HEADER with show_frame and key type.
	// AV1 bit parsing is dense; many encoders put keyframes as first bit clear
	// in temporal delimiter sequences. Prefer false negatives over false keys.
	if len(f) < 2 {
		return false
	}
	// OBU type in first byte bits 3-6 (when forbidden bit is 0).
	obuType := (f[0] >> 3) & 0x0F
	// 1 = OBU_SEQUENCE_HEADER often precedes key; 3/6 = frame headers.
	return obuType == 1 || obuType == 3 || obuType == 6
}
