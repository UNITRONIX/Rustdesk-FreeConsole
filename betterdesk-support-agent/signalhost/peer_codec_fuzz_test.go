package signalhost

import (
	"bytes"
	"net"
	"testing"
	"time"
)

const maxPeerFrameFuzzInput = 64 * 1024

type fuzzPeerConn struct {
	reader *bytes.Reader
}

func newFuzzPeerConn(data []byte) *fuzzPeerConn {
	return &fuzzPeerConn{reader: bytes.NewReader(data)}
}

func (c *fuzzPeerConn) Read(p []byte) (int, error)       { return c.reader.Read(p) }
func (c *fuzzPeerConn) Write(p []byte) (int, error)      { return len(p), nil }
func (c *fuzzPeerConn) Close() error                     { return nil }
func (c *fuzzPeerConn) LocalAddr() net.Addr              { return fuzzPeerAddr("local") }
func (c *fuzzPeerConn) RemoteAddr() net.Addr             { return fuzzPeerAddr("remote") }
func (c *fuzzPeerConn) SetDeadline(time.Time) error      { return nil }
func (c *fuzzPeerConn) SetReadDeadline(time.Time) error  { return nil }
func (c *fuzzPeerConn) SetWriteDeadline(time.Time) error { return nil }

type fuzzPeerAddr string

func (a fuzzPeerAddr) Network() string { return "fuzz" }
func (a fuzzPeerAddr) String() string  { return string(a) }

// FuzzPeerFrameFraming exercises both malformed peer headers and bounded,
// well-framed payloads without allowing a fuzz case to request a large buffer.
func FuzzPeerFrameFraming(f *testing.F) {
	f.Add([]byte{})
	f.Add([]byte{0x04, 'a'})
	f.Add([]byte{0xff, 0xff, 0xff, 0xff})
	f.Add(append(encodePeerHeader(3), []byte("abc")...))

	f.Fuzz(func(t *testing.T, raw []byte) {
		if len(raw) > maxPeerFrameFuzzInput {
			t.Skip()
		}

		// Exercise arbitrary headers only when the declared payload is small
		// enough for a bounded fuzz run. Oversized headers are still parsed.
		if _, payloadLen, err := readPeerHeader(newFuzzPeerConn(raw)); err == nil && payloadLen <= maxPeerFrameFuzzInput {
			_, _ = readPeerFrame(newFuzzPeerConn(raw), 0)
		}

		// A known-valid framing must round-trip the exact payload.
		wire := append(encodePeerHeader(len(raw)), raw...)
		got, err := readPeerFrame(newFuzzPeerConn(wire), 0)
		if len(raw) == 0 {
			if err == nil {
				t.Fatal("zero-length peer frame was accepted")
			}
			return
		}
		if err != nil {
			t.Fatalf("read valid peer frame: %v", err)
		}
		if !bytes.Equal(got, raw) {
			t.Fatalf("peer frame payload mismatch: got %d bytes, want %d", len(got), len(raw))
		}
	})
}
