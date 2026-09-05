package codec

import (
	"bytes"
	"net"
	"testing"
	"time"

	pb "github.com/unitronix/betterdesk-server/proto"
	"google.golang.org/protobuf/proto"
)

// testConn is a simple in-memory net.Conn backed by a bytes.Buffer for testing.
type testConn struct {
	readBuf  *bytes.Buffer
	writeBuf *bytes.Buffer
}

func newTestConn() *testConn {
	return &testConn{
		readBuf:  &bytes.Buffer{},
		writeBuf: &bytes.Buffer{},
	}
}

func (c *testConn) Read(b []byte) (int, error)         { return c.readBuf.Read(b) }
func (c *testConn) Write(b []byte) (int, error)        { return c.writeBuf.Write(b) }
func (c *testConn) Close() error                       { return nil }
func (c *testConn) LocalAddr() net.Addr                { return &net.TCPAddr{} }
func (c *testConn) RemoteAddr() net.Addr               { return &net.TCPAddr{} }
func (c *testConn) SetDeadline(t time.Time) error      { return nil }
func (c *testConn) SetReadDeadline(t time.Time) error  { return nil }
func (c *testConn) SetWriteDeadline(t time.Time) error { return nil }

func TestWriteReadFrameRoundTrip(t *testing.T) {
	conn := newTestConn()

	// Create a RegisterPeer message
	msg := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RegisterPeer{
			RegisterPeer: &pb.RegisterPeer{
				Id:     "TEST12345",
				Serial: 42,
			},
		},
	}

	// Write to buffer
	if err := WriteFrame(conn, msg); err != nil {
		t.Fatalf("WriteFrame error: %v", err)
	}

	// Move written data to read buffer for reading back
	conn.readBuf = bytes.NewBuffer(conn.writeBuf.Bytes())

	// Read back
	decoded, err := ReadFrame(conn, 0)
	if err != nil {
		t.Fatalf("ReadFrame error: %v", err)
	}

	rp := decoded.GetRegisterPeer()
	if rp == nil {
		t.Fatal("expected RegisterPeer, got nil")
	}
	if rp.Id != "TEST12345" {
		t.Errorf("id mismatch: got %q, want %q", rp.Id, "TEST12345")
	}
	if rp.Serial != 42 {
		t.Errorf("serial mismatch: got %d, want %d", rp.Serial, 42)
	}
}

func TestFrameHeaderFormat(t *testing.T) {
	conn := newTestConn()

	msg := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RegisterPeer{
			RegisterPeer: &pb.RegisterPeer{Id: "A"},
		},
	}

	if err := WriteFrame(conn, msg); err != nil {
		t.Fatalf("WriteFrame error: %v", err)
	}

	data := conn.writeBuf.Bytes()
	if len(data) < 1 {
		t.Fatalf("frame too short: %d bytes", len(data))
	}

	// First byte bottom 2 bits => header length - 1
	headLen := int(data[0]&0x03) + 1

	// Read LE uint of headLen bytes and shift right 2 for payload length
	var n uint32
	switch headLen {
	case 1:
		n = uint32(data[0])
	case 2:
		n = uint32(data[0]) | uint32(data[1])<<8
	case 3:
		n = uint32(data[0]) | uint32(data[1])<<8 | uint32(data[2])<<16
	case 4:
		n = uint32(data[0]) | uint32(data[1])<<8 | uint32(data[2])<<16 | uint32(data[3])<<24
	}
	payloadLen := int(n >> 2)

	actualPayload := len(data) - headLen
	if payloadLen != actualPayload {
		t.Errorf("header says payload=%d, actual=%d (headLen=%d, totalFrame=%d)",
			payloadLen, actualPayload, headLen, len(data))
	}
}

func TestRawFrameRoundTrip(t *testing.T) {
	conn := newTestConn()

	original := []byte("hello betterdesk relay data")
	if err := WriteRawFrame(conn, original); err != nil {
		t.Fatalf("WriteRawFrame error: %v", err)
	}

	conn.readBuf = bytes.NewBuffer(conn.writeBuf.Bytes())
	decoded, err := ReadRawFrame(conn, 0)
	if err != nil {
		t.Fatalf("ReadRawFrame error: %v", err)
	}

	if !bytes.Equal(decoded, original) {
		t.Errorf("data mismatch: got %v, want %v", decoded, original)
	}
}

func TestUDPRoundTrip(t *testing.T) {
	msg := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_PunchHoleRequest{
			PunchHoleRequest: &pb.PunchHoleRequest{
				Id:      "TARGET123",
				NatType: pb.NatType_ASYMMETRIC,
			},
		},
	}

	data, err := EncodeUDP(msg)
	if err != nil {
		t.Fatalf("EncodeUDP error: %v", err)
	}

	decoded, err := DecodeUDP(data)
	if err != nil {
		t.Fatalf("DecodeUDP error: %v", err)
	}

	phr := decoded.GetPunchHoleRequest()
	if phr == nil {
		t.Fatal("expected PunchHoleRequest, got nil")
	}
	if phr.Id != "TARGET123" {
		t.Errorf("id mismatch: got %q", phr.Id)
	}
	if phr.NatType != pb.NatType_ASYMMETRIC {
		t.Errorf("nat_type mismatch: got %v", phr.NatType)
	}
}

func TestFrameTooLarge(t *testing.T) {
	conn := newTestConn()

	// MaxFrameSize is 64KB which fits in uint16 (65535).
	// Use MaxFrameSize itself as the "large but valid" edge — the raw frame
	// reader checks > MaxFrameSize. Since MaxFrameSize == 64*1024 == 65536
	// and uint16 max is 65535, we cannot encode a value > MaxFrameSize in 2 bytes.
	// Instead, test with exactly MaxFrameSize (which equals 65536 and overflows uint16).
	// So we test WriteRawFrame with a payload that exceeds MaxFrameSize.
	bigPayload := make([]byte, MaxFrameSize+1)
	err := WriteRawFrame(conn, bigPayload)
	if err == nil {
		t.Error("expected error for oversized payload, got nil")
	}
}

func TestWriteReadRawBytesMaxPeerFrame(t *testing.T) {
	// Peer relay frames may exceed MaxFrameSize (64 KiB) but stay under MaxPeerFrameSize (#397).
	conn := newTestConn()
	payload := make([]byte, MaxFrameSize+1024)
	for i := range payload {
		payload[i] = byte(i % 251)
	}
	if err := WriteRawBytesMax(conn, payload, MaxPeerFrameSize); err != nil {
		t.Fatalf("WriteRawBytesMax: %v", err)
	}
	conn.readBuf = bytes.NewBuffer(conn.writeBuf.Bytes())
	got, err := ReadRawBytesMax(conn, 0, MaxPeerFrameSize)
	if err != nil {
		t.Fatalf("ReadRawBytesMax: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("round-trip mismatch: len got=%d want=%d", len(got), len(payload))
	}
	if err := WriteRawBytesMax(conn, make([]byte, MaxPeerFrameSize+1), MaxPeerFrameSize); err == nil {
		t.Fatal("expected error for payload above MaxPeerFrameSize")
	}
}

func TestZeroLengthFrame(t *testing.T) {
	conn := newTestConn()

	// Write a 1-byte header encoding zero payload length: (0 << 2) | 0x00 = 0x00
	conn.readBuf.Write([]byte{0x00})

	_, err := ReadFrame(conn, 0)
	if err == nil {
		t.Error("expected error for zero-length frame, got nil")
	}
}

func BenchmarkWriteFrame(b *testing.B) {
	conn := newTestConn()
	msg := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RegisterPeer{
			RegisterPeer: &pb.RegisterPeer{Id: "BENCH123", Serial: 1},
		},
	}
	for i := 0; i < b.N; i++ {
		conn.writeBuf.Reset()
		WriteFrame(conn, msg)
	}
}

func TestEncodeHeaderSizes(t *testing.T) {
	tests := []struct {
		payloadLen  int
		wantHeadLen int
	}{
		{0, 1},
		{1, 1},
		{63, 1},      // max for 1-byte header
		{64, 2},      // needs 2-byte header
		{16383, 2},   // max for 2-byte header
		{16384, 3},   // needs 3-byte header
		{4194303, 3}, // max for 3-byte header
		{4194304, 4}, // needs 4-byte header
	}

	for _, tt := range tests {
		hdr := encodeHeader(tt.payloadLen)
		if len(hdr) != tt.wantHeadLen {
			t.Errorf("encodeHeader(%d) = %d bytes, want %d bytes", tt.payloadLen, len(hdr), tt.wantHeadLen)
		}

		// Verify round-trip: decode header should give back the same payload length
		headLen := int(hdr[0]&0x03) + 1
		if headLen != tt.wantHeadLen {
			t.Errorf("decoded headLen=%d, want %d for payload=%d", headLen, tt.wantHeadLen, tt.payloadLen)
		}

		var n uint32
		switch headLen {
		case 1:
			n = uint32(hdr[0])
		case 2:
			n = uint32(hdr[0]) | uint32(hdr[1])<<8
		case 3:
			n = uint32(hdr[0]) | uint32(hdr[1])<<8 | uint32(hdr[2])<<16
		case 4:
			n = uint32(hdr[0]) | uint32(hdr[1])<<8 | uint32(hdr[2])<<16 | uint32(hdr[3])<<24
		}
		decoded := int(n >> 2)
		if decoded != tt.payloadLen {
			t.Errorf("encodeHeader(%d) round-trip: decoded=%d", tt.payloadLen, decoded)
		}
	}
}

func TestRealRustDeskHexDump(t *testing.T) {
	// Synthetic hex dump matching RustDesk 1.4.5 wire format:
	// PunchHoleRequest for target "123456789" with test public key
	// Build from protobuf instead of using captured traffic
	testPHR := &pb.PunchHoleRequest{
		Id:         "123456789",
		NatType:    pb.NatType_SYMMETRIC,
		LicenceKey: "dGVzdC1saWNlbmNlLWtleS1mb3ItdW5pdC10ZXN0cw==",
		Version:    "1.4.5",
	}
	testMsg := &pb.RendezvousMessage{}
	testMsg.Union = &pb.RendezvousMessage_PunchHoleRequest{PunchHoleRequest: testPHR}
	payload, err := proto.Marshal(testMsg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	// Encode with variable-length header (same as encodeHeader)
	pLen := len(payload)
	val := uint32(pLen << 2)
	var hdr []byte
	switch {
	case val <= 0xFF:
		hdr = []byte{byte(val)}
	case val <= 0xFFFF:
		hdr = []byte{byte(val | 0x01), byte(val >> 8)}
	default:
		hdr = []byte{byte(val | 0x02), byte(val >> 8), byte(val >> 16)}
	}
	hexBytes := append(hdr, payload...)

	conn := newTestConn()
	conn.readBuf = bytes.NewBuffer(hexBytes)

	msg, err := ReadRawProto(conn, 0)
	if err != nil {
		t.Fatalf("ReadRawProto error: %v", err)
	}

	phr := msg.GetPunchHoleRequest()
	if phr == nil {
		t.Fatal("expected PunchHoleRequest, got nil")
	}
	if phr.Id != "123456789" {
		t.Errorf("target id: got %q, want %q", phr.Id, "123456789")
	}
	if phr.NatType != pb.NatType_SYMMETRIC {
		t.Errorf("nat_type: got %v, want SYMMETRIC", phr.NatType)
	}
	if phr.Version != "1.4.5" {
		t.Errorf("version: got %q, want %q", phr.Version, "1.4.5")
	}
	if phr.LicenceKey != "dGVzdC1saWNlbmNlLWtleS1mb3ItdW5pdC10ZXN0cw==" {
		t.Errorf("licence_key: got %q", phr.LicenceKey)
	}
}
