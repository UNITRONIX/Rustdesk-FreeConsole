package signalhost

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net"
	"runtime"
	"strings"
	"time"

	"github.com/unitronix/betterdesk-server/codec"
	pb "github.com/unitronix/betterdesk-server/proto"
	"google.golang.org/protobuf/proto"
)

const (
	loginErr2FARequired = "2FA Required"
	publicKeyWait       = 1500 * time.Millisecond
)

func (h *Host) handleIncomingRelay(ctx context.Context, relayServer, uuid string) {
	if ctx.Err() != nil || !h.accessAllowed() {
		return
	}
	addr := relayServer
	if !hasPort(addr) {
		addr = net.JoinHostPort(addr, "21117")
	}
	if h.cfg.RelayAddr != "" && relayServer == "" {
		addr = h.cfg.RelayAddr
	}

	conn, err := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "tcp", addr)
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("[signalhost] relay dial: %v", err)
		}
		return
	}
	defer conn.Close()
	if !h.trackRelay(conn) {
		return
	}
	defer h.untrackRelay(conn)

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
	if !h.accessAllowed() {
		return fmt.Errorf("remote access disabled")
	}
	identity := h.hostIdentity()
	if identity == nil || len(identity.secretKey) == 0 {
		return fmt.Errorf("host identity is unavailable")
	}
	ephemeral, err := generateEphemeralKeyPair()
	if err != nil {
		return err
	}

	ps := newPeerSession(conn)

	signedID, err := buildSignedID(h.cfg.DeviceID, ephemeral.public, identity.secretKey)
	if err != nil {
		return err
	}
	if err := ps.write(signedID); err != nil {
		return err
	}
	log.Printf("[signalhost] sent SignedId (device=%s)", h.cfg.DeviceID)

	// A session must establish the authenticated encrypted channel before
	// credentials or desktop data are exchanged. There is no plaintext fallback.
	if err := h.waitPublicKey(ps, ephemeral); err != nil {
		return fmt.Errorf("authenticated key exchange: %w", err)
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
	if h.auth != nil && !h.auth.allow(operator) {
		_ = ps.write(&pb.Message{Union: &pb.Message_LoginResponse{LoginResponse: &pb.LoginResponse{
			Union: &pb.LoginResponse_Error{Error: "Too many authentication attempts"},
		}}})
		return fmt.Errorf("authentication temporarily locked")
	}

	pw := ""
	if h.cfg.Password != nil {
		pw = h.cfg.Password()
	}
	pw = strings.TrimSpace(pw)

	if pw == "" {
		_ = ps.write(&pb.Message{Union: &pb.Message_LoginResponse{LoginResponse: &pb.LoginResponse{
			Union: &pb.LoginResponse_Error{Error: "Access password unavailable"},
		}}})
		return fmt.Errorf("local access password is empty")
	}
	if !validLoginPassword(pw, salt, challenge, login.GetPassword()) {
		if h.auth != nil {
			h.auth.failure(operator)
		}
		_ = ps.write(&pb.Message{Union: &pb.Message_LoginResponse{LoginResponse: &pb.LoginResponse{
			Union: &pb.LoginResponse_Error{Error: "Wrong Password"},
		}}})
		return fmt.Errorf("wrong password")
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
			if h.auth != nil {
				h.auth.failure(operator)
			}
			_ = ps.write(&pb.Message{Union: &pb.Message_LoginResponse{LoginResponse: &pb.LoginResponse{
				Union: &pb.LoginResponse_Error{Error: "Wrong 2FA code"},
			}}})
			return fmt.Errorf("wrong 2fa code")
		}
	}
	if h.auth != nil {
		h.auth.success(operator)
	}

	if !h.accessAllowed() {
		_ = ps.write(&pb.Message{Union: &pb.Message_LoginResponse{LoginResponse: &pb.LoginResponse{
			Union: &pb.LoginResponse_Error{Error: "Remote access disabled"},
		}}})
		return fmt.Errorf("remote access disabled")
	}

	if !h.authorizesOperator(operator) {
		_ = ps.write(&pb.Message{Union: &pb.Message_LoginResponse{LoginResponse: &pb.LoginResponse{
			Union: &pb.LoginResponse_Error{Error: "Connection denied"},
		}}})
		return fmt.Errorf("consent denied")
	}
	if !h.accessAllowed() {
		_ = ps.write(&pb.Message{Union: &pb.Message_LoginResponse{LoginResponse: &pb.LoginResponse{
			Union: &pb.LoginResponse_Error{Error: "Remote access disabled"},
		}}})
		return fmt.Errorf("remote access disabled")
	}

	encoding := advertisedVideoEncoding()
	codec := negotiateVideoCodec(encoding, login.GetOption().GetSupportedDecoding())
	if codec == videoCodecNone {
		_ = ps.write(&pb.Message{Union: &pb.Message_LoginResponse{LoginResponse: &pb.LoginResponse{
			Union: &pb.LoginResponse_Error{Error: "No mutually supported desktop video codec"},
		}}})
		return fmt.Errorf("no mutually supported desktop video codec")
	}

	if h.cfg.OnSession != nil {
		h.cfg.OnSession(true, operator)
		defer h.cfg.OnSession(false, operator)
	}

	peerInfo, _, _ := buildPeerInfo(h.cfg.DeviceID, encoding)
	if err := ps.write(&pb.Message{Union: &pb.Message_LoginResponse{LoginResponse: &pb.LoginResponse{
		Union: &pb.LoginResponse_PeerInfo{PeerInfo: peerInfo},
	}}}); err != nil {
		return err
	}
	log.Printf("[signalhost] authenticated operator=%s encrypted=%v platform=%s codec=%s", operator, ps.encrypted, runtime.GOOS, codec)

	return h.streamSession(ps, codec, login.GetOption())
}

// authorizesOperator evaluates the current local policy immediately before a
// session starts. A non-unattended host must fail closed when no local consent
// callback is available; accepting the password alone would bypass supervised
// mode. Re-evaluating Unattended here also prevents a policy change during the
// login exchange from retaining an earlier unattended decision.
func (h *Host) authorizesOperator(operator string) bool {
	if h.cfg.Unattended != nil && h.cfg.Unattended() {
		return true
	}
	return h.cfg.Consent != nil && h.cfg.Consent(operator)
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

func validLoginPassword(password, salt, challenge string, provided []byte) bool {
	password = strings.TrimSpace(password)
	if password == "" {
		return false
	}
	expected := hashPassword(password, salt, challenge)
	return subtle.ConstantTimeCompare(provided, expected[:]) == 1
}
