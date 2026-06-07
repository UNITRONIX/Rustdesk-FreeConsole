package signalhost

import (
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"time"
)

// MaxPeerFrameSize matches RustDesk desktop clients (16 MiB video frames).
const MaxPeerFrameSize = 16 * 1024 * 1024

func writePeerFrame(conn net.Conn, data []byte) error {
	if len(data) > MaxPeerFrameSize {
		return fmt.Errorf("signalhost: frame too large (%d > %d)", len(data), MaxPeerFrameSize)
	}
	header := encodePeerHeader(len(data))
	frame := make([]byte, len(header)+len(data))
	copy(frame, header)
	copy(frame[len(header):], data)
	_, err := conn.Write(frame)
	return err
}

func readPeerFrame(conn net.Conn, timeout time.Duration) ([]byte, error) {
	if timeout > 0 {
		if err := conn.SetReadDeadline(time.Now().Add(timeout)); err != nil {
			return nil, err
		}
		defer conn.SetReadDeadline(time.Time{})
	}

	_, payloadLen, err := readPeerHeader(conn)
	if err != nil {
		return nil, err
	}
	if payloadLen == 0 {
		return nil, fmt.Errorf("signalhost: zero-length frame")
	}
	if payloadLen > MaxPeerFrameSize {
		return nil, fmt.Errorf("signalhost: frame too large (%d > %d)", payloadLen, MaxPeerFrameSize)
	}
	payload := make([]byte, payloadLen)
	if _, err := io.ReadFull(conn, payload); err != nil {
		return nil, err
	}
	return payload, nil
}

func encodePeerHeader(payloadLen int) []byte {
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
		return []byte{byte(val), byte(val >> 8), byte(val >> 16)}
	}
	val := uint32(payloadLen<<2) | 0x03
	buf := make([]byte, 4)
	binary.LittleEndian.PutUint32(buf, val)
	return buf
}

func readPeerHeader(conn net.Conn) (headerLen int, payloadLen int, err error) {
	var first [1]byte
	if _, err := io.ReadFull(conn, first[:]); err != nil {
		return 0, 0, err
	}
	headLen := int(first[0]&0x03) + 1
	var n uint32
	switch headLen {
	case 1:
		n = uint32(first[0])
	case 2:
		var second [1]byte
		if _, err := io.ReadFull(conn, second[:]); err != nil {
			return 0, 0, err
		}
		n = uint32(first[0]) | uint32(second[0])<<8
	case 3:
		var rest [2]byte
		if _, err := io.ReadFull(conn, rest[:]); err != nil {
			return 0, 0, err
		}
		n = uint32(first[0]) | uint32(rest[0])<<8 | uint32(rest[1])<<16
	case 4:
		var rest [3]byte
		if _, err := io.ReadFull(conn, rest[:]); err != nil {
			return 0, 0, err
		}
		n = uint32(first[0]) | uint32(rest[0])<<8 | uint32(rest[1])<<16 | uint32(rest[2])<<24
	}
	return headLen, int(n >> 2), nil
}
