package agent

import (
	"bytes"
	"context"
	"testing"
)

const maxEncodedFrameFuzzInput = 128 * 1024

func TestAV1KeyframeReaderRejectsTruncatedExtensionHeader(t *testing.T) {
	if av1IsKeyframe([]byte{0x06}) {
		t.Fatal("truncated AV1 extension header was treated as a keyframe")
	}
}

// FuzzEncodedStreamFraming covers the bounded image, Annex-B, and IVF splitters
// together with the VP9/AV1 keyframe header readers used by the CDAP stream.
func FuzzEncodedStreamFraming(f *testing.F) {
	f.Add([]byte{})
	f.Add([]byte("RIFF\x04\x00\x00\x00WEBP"))
	f.Add([]byte{
		0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f,
		0x00, 0x00, 0x01, 0x65, 0x88, 0x84,
		0x00, 0x00, 0x01, 0x61, 0x9a,
	})
	f.Add(append([]byte("DKIF"), make([]byte, 28)...))
	f.Add([]byte{0x06}) // truncated AV1 OBU with extension and size flags

	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > maxEncodedFrameFuzzInput {
			t.Skip()
		}

		assertFrame := func(frame []byte) {
			if len(frame) > len(data) {
				t.Fatalf("frame length = %d, input length = %d", len(frame), len(data))
			}
		}
		ctx := context.Background()

		readImageFrames(ctx, bytes.NewReader(data), CodecMJPEG, assertFrame)
		readImageFrames(ctx, bytes.NewReader(data), CodecWebP, assertFrame)
		readAnnexBFrames(ctx, bytes.NewReader(data), func(frame []byte, _ bool) {
			assertFrame(frame)
		})
		readIVFFrames(ctx, bytes.NewReader(data), CodecVP9, func(frame []byte, _ bool) {
			assertFrame(frame)
		})
		readIVFFrames(ctx, bytes.NewReader(data), CodecAV1, func(frame []byte, _ bool) {
			assertFrame(frame)
		})
		_ = vp9IsKeyframe(data)
		_ = av1IsKeyframe(data)
	})
}
