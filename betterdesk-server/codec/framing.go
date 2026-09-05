// Package codec provides wire protocol encoding/decoding for the BetterDesk server.
//
// RustDesk wire protocol framing (hbb_common::bytes_codec::BytesCodec):
//   - TCP: variable-length header (1-4 bytes) + protobuf payload
//     Header encoding: bottom 2 bits of byte[0] = (header_length - 1)
//     Remaining bits (little-endian uint >> 2) = payload length
//   - UDP: raw protobuf (no framing)
//   - WebSocket: raw protobuf per WS binary message (WS handles framing)
package codec

import (
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"time"

	pb "github.com/unitronix/betterdesk-server/proto"
	"google.golang.org/protobuf/proto"
)

const (
	// MaxFrameSize is the maximum allowed frame size for rendezvous/control
	// messages (64 KB). RustDesk control messages are typically small.
	MaxFrameSize = 64 * 1024

	// MaxPeerFrameSize is the maximum BytesCodec payload for peer relay data
	// (video / clipboard). Matches relay MaxWSRelayMessage and support-agent
	// MaxPeerFrameSize (16 MiB). Used by TCP↔WS mixed relay bridging (#397).
	MaxPeerFrameSize = 16 * 1024 * 1024

	// HeaderSize is the size of the legacy TCP frame header (2 bytes).
	// Used only by internal framed communication, not RustDesk protocol.
	HeaderSize = 2
)

// ---- RustDesk Variable-Length Frame Codec ----
// hbb_common/src/bytes_codec.rs uses a variable-length header:
//   bottom 2 bits of byte[0] = (header_length - 1)
//   remaining bits (LE uint, shifted right by 2) = payload length
//
//   1 byte header:  payload ≤ 63 B         (0x3F)
//   2 byte header:  payload ≤ 16383 B      (0x3FFF)
//   3 byte header:  payload ≤ 4194303 B    (0x3FFFFF)
//   4 byte header:  payload ≤ 1073741823 B (0x3FFFFFFF)

// encodeHeader builds the variable-length header for a given payload size.
func encodeHeader(payloadLen int) []byte {
	if payloadLen <= 0x3F {
		return []byte{byte(payloadLen << 2)}
	}
	if payloadLen <= 0x3FFF {
		val := uint16(payloadLen<<2) | 0x01
		buf := make([]byte, 2)
		binary.LittleEndian.PutUint16(buf, val)
		return buf
	}
	if payloadLen <= 0x3FFFFF {
		val := uint32(payloadLen<<2) | 0x02
		buf := make([]byte, 3)
		buf[0] = byte(val)
		buf[1] = byte(val >> 8)
		buf[2] = byte(val >> 16)
		return buf
	}
	val := uint32(payloadLen<<2) | 0x03
	buf := make([]byte, 4)
	binary.LittleEndian.PutUint32(buf, val)
	return buf
}

// readHeader reads the variable-length header from a TCP connection and returns
// the header length and payload length.
func readHeader(conn net.Conn) (headerLen int, payloadLen int, err error) {
	// Read first byte to determine header size
	var first [1]byte
	if _, err := io.ReadFull(conn, first[:]); err != nil {
		return 0, 0, fmt.Errorf("codec: read first byte: %w", err)
	}

	headLen := int(first[0]&0x03) + 1
	var n uint32

	switch headLen {
	case 1:
		n = uint32(first[0])
	case 2:
		var second [1]byte
		if _, err := io.ReadFull(conn, second[:]); err != nil {
			return 0, 0, fmt.Errorf("codec: read header byte 2: %w", err)
		}
		n = uint32(first[0]) | uint32(second[0])<<8
	case 3:
		var rest [2]byte
		if _, err := io.ReadFull(conn, rest[:]); err != nil {
			return 0, 0, fmt.Errorf("codec: read header bytes 2-3: %w", err)
		}
		n = uint32(first[0]) | uint32(rest[0])<<8 | uint32(rest[1])<<16
	case 4:
		var rest [3]byte
		if _, err := io.ReadFull(conn, rest[:]); err != nil {
			return 0, 0, fmt.Errorf("codec: read header bytes 2-4: %w", err)
		}
		n = uint32(first[0]) | uint32(rest[0])<<8 | uint32(rest[1])<<16 | uint32(rest[2])<<24
	}

	payloadLen = int(n >> 2)
	return headLen, payloadLen, nil
}

// ReadRawProto reads a variable-length-framed protobuf message from a TCP connection.
// This matches RustDesk's hbb_common::bytes_codec::BytesCodec format.
func ReadRawProto(conn net.Conn, timeout time.Duration) (*pb.RendezvousMessage, error) {
	if timeout > 0 {
		if err := conn.SetReadDeadline(time.Now().Add(timeout)); err != nil {
			return nil, fmt.Errorf("codec: set deadline error: %w", err)
		}
		defer conn.SetReadDeadline(time.Time{})
	}

	_, payloadLen, err := readHeader(conn)
	if err != nil {
		return nil, err
	}

	if payloadLen == 0 {
		return nil, fmt.Errorf("codec: zero-length payload")
	}
	if payloadLen > MaxFrameSize {
		return nil, fmt.Errorf("codec: payload too large (%d > %d)", payloadLen, MaxFrameSize)
	}

	payload := make([]byte, payloadLen)
	if _, err := io.ReadFull(conn, payload); err != nil {
		return nil, fmt.Errorf("codec: read payload error: %w", err)
	}

	msg := &pb.RendezvousMessage{}
	if err := proto.Unmarshal(payload, msg); err != nil {
		return nil, fmt.Errorf("codec: unmarshal error (%d bytes): %w", payloadLen, err)
	}
	return msg, nil
}

// WriteRawProto writes a variable-length-framed protobuf message to a TCP connection.
// This matches RustDesk's hbb_common::bytes_codec::BytesCodec format.
func WriteRawProto(conn net.Conn, msg *pb.RendezvousMessage) error {
	data, err := proto.Marshal(msg)
	if err != nil {
		return fmt.Errorf("codec: marshal error: %w", err)
	}
	return WriteRawBytes(conn, data)
}

// WriteRawBytes writes raw bytes with variable-length header to a TCP connection.
// Payload size is capped at MaxFrameSize (control/rendezvous messages).
func WriteRawBytes(conn net.Conn, data []byte) error {
	return WriteRawBytesMax(conn, data, MaxFrameSize)
}

// WriteRawBytesMax writes raw bytes with a variable-length header, enforcing maxLen.
// Use MaxPeerFrameSize for mixed TCP↔WS peer relay bridging (#397).
func WriteRawBytesMax(conn net.Conn, data []byte, maxLen int) error {
	if maxLen <= 0 {
		maxLen = MaxFrameSize
	}
	if len(data) > maxLen {
		return fmt.Errorf("codec: data too large (%d > %d)", len(data), maxLen)
	}
	header := encodeHeader(len(data))
	frame := make([]byte, len(header)+len(data))
	copy(frame, header)
	copy(frame[len(header):], data)
	_, err := conn.Write(frame)
	return err
}

// ReadRawBytes reads a variable-length-framed raw byte payload from a TCP connection.
// Payload size is capped at MaxFrameSize (control/rendezvous messages).
func ReadRawBytes(conn net.Conn, timeout time.Duration) ([]byte, error) {
	return ReadRawBytesMax(conn, timeout, MaxFrameSize)
}

// ReadRawBytesMax reads a variable-length-framed raw byte payload, enforcing maxLen.
// Use MaxPeerFrameSize for mixed TCP↔WS peer relay bridging (#397).
func ReadRawBytesMax(conn net.Conn, timeout time.Duration, maxLen int) ([]byte, error) {
	if maxLen <= 0 {
		maxLen = MaxFrameSize
	}
	if timeout > 0 {
		if err := conn.SetReadDeadline(time.Now().Add(timeout)); err != nil {
			return nil, err
		}
		defer conn.SetReadDeadline(time.Time{})
	}

	_, payloadLen, err := readHeader(conn)
	if err != nil {
		return nil, err
	}

	if payloadLen == 0 {
		return nil, fmt.Errorf("codec: zero-length payload")
	}
	if payloadLen > maxLen {
		return nil, fmt.Errorf("codec: payload too large (%d > %d)", payloadLen, maxLen)
	}

	payload := make([]byte, payloadLen)
	if _, err := io.ReadFull(conn, payload); err != nil {
		return nil, err
	}
	return payload, nil
}

// WriteFrame writes a framed protobuf message using RustDesk variable-length codec.
// Alias for WriteRawProto for backward compatibility in tests.
func WriteFrame(conn net.Conn, msg *pb.RendezvousMessage) error {
	return WriteRawProto(conn, msg)
}

// ReadFrame reads a framed protobuf message using RustDesk variable-length codec.
// Alias for ReadRawProto for backward compatibility in tests.
func ReadFrame(conn net.Conn, timeout time.Duration) (*pb.RendezvousMessage, error) {
	return ReadRawProto(conn, timeout)
}

// WriteRawFrame writes raw bytes with variable-length header.
// Alias for WriteRawBytes for backward compatibility.
func WriteRawFrame(conn net.Conn, data []byte) error {
	return WriteRawBytes(conn, data)
}

// ReadRawFrame reads a variable-length-framed raw byte payload.
// Alias for ReadRawBytes for backward compatibility.
func ReadRawFrame(conn net.Conn, timeout time.Duration) ([]byte, error) {
	return ReadRawBytes(conn, timeout)
}

// EncodeUDP serializes a RendezvousMessage for UDP (no framing).
func EncodeUDP(msg *pb.RendezvousMessage) ([]byte, error) {
	return proto.Marshal(msg)
}

// DecodeUDP deserializes a RendezvousMessage from a UDP datagram.
func DecodeUDP(data []byte) (*pb.RendezvousMessage, error) {
	msg := &pb.RendezvousMessage{}
	if err := proto.Unmarshal(data, msg); err != nil {
		return nil, fmt.Errorf("codec: UDP unmarshal error: %w", err)
	}
	return msg, nil
}
