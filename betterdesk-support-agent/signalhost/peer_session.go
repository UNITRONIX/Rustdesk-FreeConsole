package signalhost

import (
	"net"
	"time"

	pb "github.com/unitronix/betterdesk-server/proto"
	"google.golang.org/protobuf/proto"
)

// peerSession wraps a relay TCP connection with optional RustDesk secretbox encryption.
type peerSession struct {
	conn      net.Conn
	encrypted bool
	box       *secretBoxStream
}

func newPeerSession(conn net.Conn) *peerSession {
	return &peerSession{conn: conn}
}

func (ps *peerSession) enableEncryption(key [32]byte) {
	ps.box = newSecretBoxStream(key)
	ps.encrypted = true
}

func (ps *peerSession) write(msg *pb.Message) error {
	data, err := proto.Marshal(msg)
	if err != nil {
		return err
	}
	if ps.encrypted {
		data, err = ps.box.encrypt(data)
		if err != nil {
			return err
		}
	}
	return writePeerFrame(ps.conn, data)
}

func (ps *peerSession) read(timeout time.Duration) (*pb.Message, error) {
	raw, err := readPeerFrame(ps.conn, timeout)
	if err != nil {
		return nil, err
	}
	if ps.encrypted {
		raw, err = ps.box.decrypt(raw)
		if err != nil {
			return nil, err
		}
	}
	out := &pb.Message{}
	if err := proto.Unmarshal(raw, out); err != nil {
		return nil, err
	}
	return out, nil
}

func (ps *peerSession) readRaw(timeout time.Duration) ([]byte, error) {
	raw, err := readPeerFrame(ps.conn, timeout)
	if err != nil {
		return nil, err
	}
	if ps.encrypted {
		return ps.box.decrypt(raw)
	}
	return raw, nil
}
