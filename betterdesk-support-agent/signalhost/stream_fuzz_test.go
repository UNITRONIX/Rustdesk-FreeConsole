package signalhost

import (
	"bytes"
	"context"
	"testing"
)

const maxAnnexBFuzzInput = 128 * 1024

// FuzzAnnexBFraming checks that malformed H.264 Annex-B input cannot panic or
// make the bounded stream splitter emit a frame larger than its input.
func FuzzAnnexBFraming(f *testing.F) {
	f.Add([]byte{})
	f.Add([]byte{
		0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f,
		0x00, 0x00, 0x01, 0x65, 0x88, 0x84,
		0x00, 0x00, 0x01, 0x61, 0x9a,
	})

	f.Fuzz(func(t *testing.T, data []byte) {
		if len(data) > maxAnnexBFuzzInput {
			t.Skip()
		}

		readAnnexBFrames(context.Background(), bytes.NewReader(data), func(au []byte, _ bool) {
			if len(au) > len(data) {
				t.Fatalf("Annex-B frame length = %d, input length = %d", len(au), len(data))
			}
		})
	})
}
