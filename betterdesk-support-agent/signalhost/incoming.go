package signalhost

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net"
	"time"

	bdagent "github.com/unitronix/betterdesk-agent/agent"
	"github.com/unitronix/betterdesk-server/codec"
	pb "github.com/unitronix/betterdesk-server/proto"
	"google.golang.org/protobuf/proto"
)

func (h *Host) handleIncomingRelay(relayServer, uuid string) {
	addr := relayServer
	if !hasPort(addr) {
		addr = net.JoinHostPort(addr, "21117")
	}
	if h.cfg.RelayAddr != "" && relayServer == "" {
		addr = h.cfg.RelayAddr
	}

	conn, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		log.Printf("[signalhost] relay dial: %v", err)
		return
	}
	defer conn.Close()

	req := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RequestRelay{
			RequestRelay: &pb.RequestRelay{
				Id:   h.cfg.DeviceID,
				Uuid: uuid,
			},
		},
	}
	if err := codec.WriteRawProto(conn, req); err != nil {
		log.Printf("[signalhost] RequestRelay: %v", err)
		return
	}

	// Relay confirmation (optional)
	if _, err := codec.ReadRawBytes(conn, 5*time.Second); err != nil {
		log.Printf("[signalhost] relay confirm: %v", err)
	}

	if err := h.runPeerSession(conn); err != nil {
		log.Printf("[signalhost] session ended: %v", err)
	}
}

func hasPort(hostport string) bool {
	_, port, err := net.SplitHostPort(hostport)
	return err == nil && port != ""
}

func (h *Host) runPeerSession(conn net.Conn) error {
	// SignedId with ephemeral X25519 placeholder (64 zero sig + IdPk)
	idPk := &pb.IdPk{Id: h.cfg.DeviceID, Pk: make([]byte, 32)}
	idPkBytes, _ := proto.Marshal(idPk)
	signed := append(make([]byte, 64), idPkBytes...)
	msg := &pb.Message{Union: &pb.Message_SignedId{SignedId: &pb.SignedId{Id: signed}}}
	if err := writePeerMessage(conn, msg); err != nil {
		return err
	}

	salt := randomToken()
	challenge := randomToken()
	if err := writePeerMessage(conn, &pb.Message{Union: &pb.Message_Hash{Hash: &pb.Hash{Salt: salt, Challenge: challenge}}}); err != nil {
		return err
	}

	frame, err := readPeerMessage(conn)
	if err != nil {
		return err
	}
	login := frame.GetLoginRequest()
	if login == nil {
		return fmt.Errorf("expected LoginRequest")
	}

	operator := login.GetMyName()
	if operator == "" {
		operator = login.GetMyId()
	}

	pw := ""
	if h.cfg.Password != nil {
		pw = h.cfg.Password()
	}
	unattended := h.cfg.Unattended != nil && h.cfg.Unattended()

	if pw != "" && !unattended {
		expected := hashPassword(pw, salt, challenge)
		if !bytes.Equal(login.GetPassword(), expected[:]) {
			_ = writePeerMessage(conn, &pb.Message{Union: &pb.Message_LoginResponse{LoginResponse: &pb.LoginResponse{
				Union: &pb.LoginResponse_Error{Error: "Wrong Password"},
			}}})
			return fmt.Errorf("wrong password")
		}
	}

	if !unattended && h.cfg.Consent != nil {
		if !h.cfg.Consent(operator) {
			_ = writePeerMessage(conn, &pb.Message{Union: &pb.Message_LoginResponse{LoginResponse: &pb.LoginResponse{
				Union: &pb.LoginResponse_Error{Error: "Connection denied"},
			}}})
			return fmt.Errorf("consent denied")
		}
	}

	if h.cfg.OnSession != nil {
		h.cfg.OnSession(true, operator)
		defer h.cfg.OnSession(false, operator)
	}

	peerInfo := &pb.PeerInfo{
		Username: "user",
		Hostname: h.cfg.DeviceID,
		Platform: "linux",
		Version:  "1",
	}
	if err := writePeerMessage(conn, &pb.Message{Union: &pb.Message_LoginResponse{LoginResponse: &pb.LoginResponse{
		Union: &pb.LoginResponse_PeerInfo{PeerInfo: peerInfo},
	}}}); err != nil {
		return err
	}

	return h.streamScreenshots(conn)
}

func (h *Host) streamScreenshots(conn net.Conn) error {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	var pts int64
	for range ticker.C {
		jpeg, err := bdagent.CaptureScreenshotJPEG()
		if err != nil || len(jpeg) == 0 {
			continue
		}
		vf := &pb.Message{Union: &pb.Message_VideoFrame{VideoFrame: &pb.VideoFrame{
			Display: 0,
			Union: &pb.VideoFrame_Vp9S{Vp9S: &pb.EncodedVideoFrames{
				Frames: []*pb.EncodedVideoFrame{{Data: jpeg, Key: true, Pts: pts}},
			}},
		}}}
		if err := writePeerMessage(conn, vf); err != nil {
			return err
		}
		pts++
	}
	return nil
}

func writePeerMessage(conn net.Conn, msg *pb.Message) error {
	data, err := proto.Marshal(msg)
	if err != nil {
		return err
	}
	return codec.WriteRawBytes(conn, data)
}

func readPeerMessage(conn net.Conn) (*pb.Message, error) {
	data, err := codec.ReadRawBytes(conn, 60*time.Second)
	if err != nil {
		return nil, err
	}
	out := &pb.Message{}
	if err := proto.Unmarshal(data, out); err != nil {
		return nil, err
	}
	return out, nil
}

func randomToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// DrainPeerInput reads and ignores input events until connection closes.
func DrainPeerInput(conn net.Conn) {
	for {
		if _, err := readPeerMessage(conn); err != nil {
			if err != io.EOF {
				return
			}
			return
		}
	}
}
