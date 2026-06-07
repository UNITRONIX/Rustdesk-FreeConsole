package signalhost

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net"
	"runtime"
	"time"

	pb "github.com/unitronix/betterdesk-server/proto"
	"github.com/unitronix/betterdesk-server/codec"
	"google.golang.org/protobuf/proto"
)

const (
	loginErr2FARequired = "2FA Required"
	publicKeyWait       = 1500 * time.Millisecond
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

	skipRelayConfirm(conn)

	if err := h.runPeerSession(conn); err != nil {
		log.Printf("[signalhost] session ended: %v", err)
	}
}

func skipRelayConfirm(conn net.Conn) {
	raw, err := readPeerFrame(conn, 2*time.Second)
	if err != nil {
		return
	}
	rdz := &pb.RendezvousMessage{}
	if err := proto.Unmarshal(raw, rdz); err != nil {
		log.Printf("[signalhost] relay first frame not rendezvous (len=%d)", len(raw))
		return
	}
	if rdz.GetRelayResponse() != nil {
		log.Printf("[signalhost] skipped relay confirmation")
	}
}

func hasPort(hostport string) bool {
	_, port, err := net.SplitHostPort(hostport)
	return err == nil && port != ""
}

func (h *Host) runPeerSession(conn net.Conn) error {
	ephemeral, err := generateEphemeralKeyPair()
	if err != nil {
		return err
	}

	ps := newPeerSession(conn)

	signedID, err := buildSignedID(h.cfg.DeviceID, ephemeral.public)
	if err != nil {
		return err
	}
	if err := ps.write(signedID); err != nil {
		return err
	}
	log.Printf("[signalhost] sent SignedId (device=%s)", h.cfg.DeviceID)

	// RustDesk initiators send PublicKey; RDClient waits for plaintext Hash.
	if err := h.waitPublicKey(ps, ephemeral); err != nil {
		log.Printf("[signalhost] plaintext relay mode: %v", err)
	}

	salt := randomToken()
	challenge := randomToken()
	if err := ps.write(&pb.Message{Union: &pb.Message_Hash{Hash: &pb.Hash{Salt: salt, Challenge: challenge}}}); err != nil {
		return err
	}

	frame, err := ps.read(60 * time.Second)
	if err != nil {
		return err
	}
	login := frame.GetLoginRequest()
	if login == nil {
		return fmt.Errorf("expected LoginRequest, got %T", frame.GetUnion())
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

	if pw != "" {
		expected := hashPassword(pw, salt, challenge)
		if !bytes.Equal(login.GetPassword(), expected[:]) {
			_ = ps.write(&pb.Message{Union: &pb.Message_LoginResponse{LoginResponse: &pb.LoginResponse{
				Union: &pb.LoginResponse_Error{Error: "Wrong Password"},
			}}})
			return fmt.Errorf("wrong password")
		}
	}

	if h.cfg.TOTPEnabled != nil && h.cfg.TOTPEnabled() {
		if err := ps.write(&pb.Message{Union: &pb.Message_LoginResponse{LoginResponse: &pb.LoginResponse{
			Union: &pb.LoginResponse_Error{Error: loginErr2FARequired},
		}}}); err != nil {
			return err
		}
		authFrame, err := ps.read(60 * time.Second)
		if err != nil {
			return err
		}
		auth2fa := authFrame.GetAuth_2Fa()
		if auth2fa == nil || h.cfg.TOTPVerify == nil || !h.cfg.TOTPVerify(auth2fa.GetCode()) {
			_ = ps.write(&pb.Message{Union: &pb.Message_LoginResponse{LoginResponse: &pb.LoginResponse{
				Union: &pb.LoginResponse_Error{Error: "Wrong 2FA code"},
			}}})
			return fmt.Errorf("wrong 2fa code")
		}
	}

	if !unattended && h.cfg.Consent != nil {
		if !h.cfg.Consent(operator) {
			_ = ps.write(&pb.Message{Union: &pb.Message_LoginResponse{LoginResponse: &pb.LoginResponse{
				Union: &pb.LoginResponse_Error{Error: "Connection denied"},
			}}})
			return fmt.Errorf("consent denied")
		}
	}

	if h.cfg.OnSession != nil {
		h.cfg.OnSession(true, operator)
		defer h.cfg.OnSession(false, operator)
	}

	peerInfo, _, _ := buildPeerInfo(h.cfg.DeviceID)
	if err := ps.write(&pb.Message{Union: &pb.Message_LoginResponse{LoginResponse: &pb.LoginResponse{
		Union: &pb.LoginResponse_PeerInfo{PeerInfo: peerInfo},
	}}}); err != nil {
		return err
	}
	log.Printf("[signalhost] authenticated operator=%s encrypted=%v platform=%s", operator, ps.encrypted, runtime.GOOS)

	return h.streamSession(ps)
}

func (h *Host) waitPublicKey(ps *peerSession, ephemeral ephemeralKeyPair) error {
	raw, err := readPeerFrame(ps.conn, publicKeyWait)
	if err != nil {
		if err == io.EOF {
			return fmt.Errorf("connection closed before PublicKey")
		}
		return err
	}

	msg := &pb.Message{}
	if err := proto.Unmarshal(raw, msg); err != nil {
		return fmt.Errorf("decode while waiting PublicKey: %w", err)
	}
	pk := msg.GetPublicKey()
	if pk == nil {
		return fmt.Errorf("first peer frame was not PublicKey")
	}
	theirPK := pk.GetAsymmetricValue()
	sealed := pk.GetSymmetricValue()
	symKey, err := openPublicKey(ephemeral, theirPK, sealed)
	if err != nil {
		return err
	}
	ps.enableEncryption(symKey)
	log.Printf("[signalhost] RustDesk encryption enabled (peer pk %d bytes)", len(theirPK))
	return nil
}

func randomToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
