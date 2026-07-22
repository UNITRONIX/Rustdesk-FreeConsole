package signal

import (
	"crypto/ed25519"
	"crypto/rand"
	"net"
	"testing"
	"time"

	"github.com/unitronix/betterdesk-server/codec"
	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/crypto"
	pb "github.com/unitronix/betterdesk-server/proto"
	"golang.org/x/crypto/nacl/box"
	"golang.org/x/crypto/nacl/secretbox"
	"google.golang.org/protobuf/proto"
)

func TestHandleMessageHttpProxyRequestRejected(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	msg := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_HttpProxyRequest{
			HttpProxyRequest: &pb.HttpProxyRequest{
				Method: "POST",
				Path:   "/api/login",
				Body:   []byte(`{}`),
			},
		},
	}
	resp := srv.handleMessage(msg, udpAddr("203.0.113.10", 52001))
	if resp == nil {
		t.Fatal("expected HttpProxyResponse, got nil")
	}
	hr := resp.GetHttpProxyResponse()
	if hr == nil {
		t.Fatalf("expected HttpProxyResponse union, got %T", resp.Union)
	}
	if hr.GetError() != "not supported" {
		t.Fatalf("error = %q, want %q", hr.GetError(), "not supported")
	}
}

func TestLogAndCheckKeepAliveHttpProxyAndPunch(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)

	httpMsg := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_HttpProxyRequest{
			HttpProxyRequest: &pb.HttpProxyRequest{Method: "GET", Path: "/api/ab"},
		},
	}
	if srv.logAndCheckKeepAlive(httpMsg, "203.0.113.10:52001", true) {
		t.Fatal("HttpProxyRequest must not keep TCP punch connection alive")
	}

	punchMsg := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_PunchHoleRequest{
			PunchHoleRequest: &pb.PunchHoleRequest{Id: "TARGET01"},
		},
	}
	if !srv.logAndCheckKeepAlive(punchMsg, "203.0.113.10:52001", true) {
		t.Fatal("PunchHoleRequest must keep TCP connection alive")
	}

	relayMsg := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RequestRelay{
			RequestRelay: &pb.RequestRelay{Id: "TARGET01", Uuid: "uuid-1"},
		},
	}
	if !srv.logAndCheckKeepAlive(relayMsg, "203.0.113.10:52001", true) {
		t.Fatal("RequestRelay must keep TCP connection alive")
	}
}

func TestHandleEmptyOrUnknownUnion(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)

	empty := &pb.RendezvousMessage{}
	skip, closeConn := srv.handleEmptyOrUnknownUnion(empty, "203.0.113.10:1", true)
	if !skip || closeConn {
		t.Fatalf("empty Union: skip=%v close=%v, want skip=true close=false", skip, closeConn)
	}

	full := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_HttpProxyRequest{
			HttpProxyRequest: &pb.HttpProxyRequest{Method: "GET", Path: "/x"},
		},
	}
	raw, err := proto.Marshal(full)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	nums := unknownProtobufFieldNumbers(raw)
	if len(nums) == 0 || nums[0] != 27 {
		t.Fatalf("unknownProtobufFieldNumbers(%x) = %v, want leading field 27", raw, nums)
	}

	skip, closeConn = srv.handleEmptyOrUnknownUnion(full, "203.0.113.10:1", true)
	if skip || closeConn {
		t.Fatalf("typed HttpProxyRequest: skip=%v close=%v, want both false", skip, closeConn)
	}

	// Schema-drift simulation: unknown bytes only (Union stays nil).
	drift := &pb.RendezvousMessage{}
	drift.ProtoReflect().SetUnknown(raw)
	skip, closeConn = srv.handleEmptyOrUnknownUnion(drift, "203.0.113.10:1", true)
	if !skip || !closeConn {
		t.Fatalf("unknown fields: skip=%v close=%v, want skip=true close=true", skip, closeConn)
	}
}

func TestHttpProxyRequestDecodesAfterSchemaSync(t *testing.T) {
	// Regression for #296: field 27 must populate Union, not leave it nil.
	msg := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_HttpProxyRequest{
			HttpProxyRequest: &pb.HttpProxyRequest{
				Method: "POST",
				Path:   "/api/login",
				Headers: []*pb.HeaderEntry{
					{Name: "Content-Type", Value: "application/json"},
				},
				Body: []byte(`{"user":"a"}`),
			},
		},
	}
	data, err := proto.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	decoded := &pb.RendezvousMessage{}
	if err := proto.Unmarshal(data, decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded.GetHttpProxyRequest() == nil {
		t.Fatalf("Union=%T, want HttpProxyRequest (schema drift would yield nil)", decoded.Union)
	}
	if decoded.GetHttpProxyRequest().GetPath() != "/api/login" {
		t.Fatalf("path = %q", decoded.GetHttpProxyRequest().GetPath())
	}
}

func TestSecureTCPHttpProxyRoundTrip(t *testing.T) {
	// End-to-end: KeyExchange → encrypted HttpProxyRequest → HttpProxyResponse error.
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	kp, err := crypto.GenerateKeyPair()
	if err != nil {
		t.Fatalf("GenerateKeyPair: %v", err)
	}
	srv.kp = kp

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	errCh := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			errCh <- err
			return
		}
		srv.handleTCPConn(conn)
		errCh <- nil
	}()

	client, err := net.DialTimeout("tcp", ln.Addr().String(), 3*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()

	// Read server KeyExchange
	keIn, err := codec.ReadRawProto(client, 5*time.Second)
	if err != nil {
		t.Fatalf("read KeyExchange: %v", err)
	}
	if keIn.GetKeyExchange() == nil || len(keIn.GetKeyExchange().GetKeys()) < 1 {
		t.Fatalf("expected server KeyExchange, got %T", keIn.Union)
	}
	signed := keIn.GetKeyExchange().GetKeys()[0]
	if len(signed) != 96 {
		t.Fatalf("signed pubkey len=%d, want 96", len(signed))
	}
	sig, serverCurvePubBytes := signed[:64], signed[64:]
	if !ed25519.Verify(srv.kp.PublicKey, serverCurvePubBytes, sig) {
		t.Fatal("server KeyExchange signature invalid")
	}
	var serverCurvePub [32]byte
	copy(serverCurvePub[:], serverCurvePubBytes)

	clientPub, clientPriv, err := box.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	var symKey [32]byte
	for i := range symKey {
		symKey[i] = byte(i + 1)
	}
	var zeroNonce [24]byte
	sealed := box.Seal(nil, symKey[:], &zeroNonce, &serverCurvePub, clientPriv)

	keOut := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_KeyExchange{
			KeyExchange: &pb.KeyExchange{
				Keys: [][]byte{clientPub[:], sealed},
			},
		},
	}
	if err := codec.WriteRawProto(client, keOut); err != nil {
		t.Fatalf("write client KeyExchange: %v", err)
	}

	// Send encrypted HttpProxyRequest (nonce=1)
	req := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_HttpProxyRequest{
			HttpProxyRequest: &pb.HttpProxyRequest{
				Method: "GET",
				Path:   "/api/current-user",
			},
		},
	}
	plain, err := proto.Marshal(req)
	if err != nil {
		t.Fatalf("marshal req: %v", err)
	}
	var sendNonce [24]byte
	sendNonce[0] = 1 // little-endian u64 = 1
	ct := secretbox.Seal(nil, plain, &sendNonce, &symKey)
	if err := codec.WriteRawBytes(client, ct); err != nil {
		t.Fatalf("write encrypted HttpProxyRequest: %v", err)
	}

	// Read encrypted HttpProxyResponse
	respCT, err := codec.ReadRawBytes(client, 5*time.Second)
	if err != nil {
		t.Fatalf("read response ciphertext: %v", err)
	}
	var recvNonce [24]byte
	recvNonce[0] = 1
	respPlain, ok := secretbox.Open(nil, respCT, &recvNonce, &symKey)
	if !ok {
		t.Fatal("decrypt response failed")
	}
	resp := &pb.RendezvousMessage{}
	if err := proto.Unmarshal(respPlain, resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	hr := resp.GetHttpProxyResponse()
	if hr == nil {
		t.Fatalf("expected HttpProxyResponse, got %T (would be nil Union before #296 fix)", resp.Union)
	}
	if hr.GetError() != "not supported" {
		t.Fatalf("error = %q", hr.GetError())
	}

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("server handleTCPConn: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server goroutine timeout")
	}
}

func TestUnknownFieldNumbersFromRaw(t *testing.T) {
	msg := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_HttpProxyRequest{
			HttpProxyRequest: &pb.HttpProxyRequest{Method: "GET", Path: "/"},
		},
	}
	raw, err := proto.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	nums := unknownProtobufFieldNumbers(raw)
	found := false
	for _, n := range nums {
		if n == 27 {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("field numbers %v missing 27", nums)
	}
}
