package relay

import (
	"context"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/unitronix/betterdesk-server/codec"
	"github.com/unitronix/betterdesk-server/config"
	pb "github.com/unitronix/betterdesk-server/proto"
	"google.golang.org/protobuf/proto"
)

func TestWSRelayHealthCheck(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.RelayPort = 29400

	srv := New(cfg)
	ctx := t.Context()
	if err := srv.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	time.Sleep(200 * time.Millisecond)

	// Connect to WS relay port (relay port + 2 = 29402)
	wsURL := fmt.Sprintf("ws://127.0.0.1:%d/", cfg.WSRelayPort())
	ws, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("WS dial: %v", err)
	}
	defer ws.CloseNow()

	// Send health check
	hc := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_Hc{
			Hc: &pb.HealthCheck{Token: "relay-ws-test"},
		},
	}
	data, _ := proto.Marshal(hc)
	ws.Write(ctx, websocket.MessageBinary, data)

	// Read response
	_, respData, err := ws.Read(ctx)
	if err != nil {
		t.Fatalf("WS read: %v", err)
	}

	resp := &pb.RendezvousMessage{}
	proto.Unmarshal(respData, resp)

	if resp.GetHc() == nil || resp.GetHc().Token != "relay-ws-test" {
		t.Errorf("unexpected response: %v", resp)
	}
}

func TestWSRelayPairing(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.RelayPort = 29500

	srv := New(cfg)
	ctx := t.Context()
	if err := srv.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	time.Sleep(200 * time.Millisecond)

	uuid := "ws-relay-test-uuid-456"
	wsURL := fmt.Sprintf("ws://127.0.0.1:%d/", cfg.WSRelayPort())

	// Connect first side
	ws1, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("WS dial 1: %v", err)
	}
	defer ws1.CloseNow()

	// Send RequestRelay from first side
	rr := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RequestRelay{
			RequestRelay: &pb.RequestRelay{Uuid: uuid},
		},
	}
	data, _ := proto.Marshal(rr)
	ws1.Write(ctx, websocket.MessageBinary, data)

	// Small delay before second connection
	time.Sleep(50 * time.Millisecond)

	// Connect second side
	ws2, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("WS dial 2: %v", err)
	}
	defer ws2.CloseNow()

	// Send RequestRelay from second side with same UUID
	ws2.Write(ctx, websocket.MessageBinary, data)

	// Verify the connection pair was established (no RelayResponse from server —
	// clients expect peer SignedId next; see startRelay comment).
	time.Sleep(300 * time.Millisecond)

	if srv.TotalRelayed.Load() < 1 {
		t.Errorf("expected at least 1 relay session, got %d", srv.TotalRelayed.Load())
	}
}

// TestWSRelayLargeMessagePreserved ensures payloads larger than io.Copy's default
// buffer (~32 KiB) stay as a single WebSocket message after relay (#293).
func TestWSRelayLargeMessagePreserved(t *testing.T) {
	cfg := config.DefaultConfig()
	ln, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()

	cfg.RelayPort = port
	srv := New(cfg)
	ctx := t.Context()
	if err := srv.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	time.Sleep(200 * time.Millisecond)

	uuid := "ws-relay-large-msg-293"
	wsURL := fmt.Sprintf("ws://127.0.0.1:%d/", cfg.WSRelayPort())

	ws1, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("WS dial 1: %v", err)
	}
	defer ws1.CloseNow()
	ws1.SetReadLimit(MaxWSRelayMessage)

	rr := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RequestRelay{
			RequestRelay: &pb.RequestRelay{Uuid: uuid},
		},
	}
	reqData, _ := proto.Marshal(rr)
	if err := ws1.Write(ctx, websocket.MessageBinary, reqData); err != nil {
		t.Fatalf("WS1 RequestRelay: %v", err)
	}
	time.Sleep(50 * time.Millisecond)

	ws2, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("WS dial 2: %v", err)
	}
	defer ws2.CloseNow()
	ws2.SetReadLimit(MaxWSRelayMessage)
	if err := ws2.Write(ctx, websocket.MessageBinary, reqData); err != nil {
		t.Fatalf("WS2 RequestRelay: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for srv.TotalRelayed.Load() < 1 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if srv.TotalRelayed.Load() < 1 {
		t.Fatal("relay pair not established")
	}

	const payloadSize = 100 * 1024 // well above 32 KiB io.Copy default buffer
	payload := make([]byte, payloadSize)
	for i := range payload {
		payload[i] = byte(i % 251)
	}

	if err := ws1.Write(ctx, websocket.MessageBinary, payload); err != nil {
		t.Fatalf("send large payload: %v", err)
	}

	readCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	typ, got, err := ws2.Read(readCtx)
	if err != nil {
		t.Fatalf("recv large payload: %v", err)
	}
	if typ != websocket.MessageBinary {
		t.Fatalf("message type = %v, want binary", typ)
	}
	if len(got) != payloadSize {
		t.Fatalf("payload len = %d, want %d (message was split or truncated)", len(got), payloadSize)
	}
	for i := range payload {
		if got[i] != payload[i] {
			t.Fatalf("payload mismatch at byte %d", i)
		}
	}
}

func TestMixedWSAndTCPRelayPreservesFraming(t *testing.T) {
	cfg := config.DefaultConfig()
	ln, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()

	cfg.RelayPort = port
	srv := New(cfg)
	ctx := t.Context()
	if err := srv.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	time.Sleep(200 * time.Millisecond)

	uuid := "mixed-transport-uuid-290"
	wsURL := fmt.Sprintf("ws://127.0.0.1:%d/", cfg.WSRelayPort())

	// First peer: WebSocket RequestRelay.
	ws, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("WS dial: %v", err)
	}
	defer ws.CloseNow()

	rr := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RequestRelay{
			RequestRelay: &pb.RequestRelay{Uuid: uuid},
		},
	}
	data, _ := proto.Marshal(rr)
	if err := ws.Write(ctx, websocket.MessageBinary, data); err != nil {
		t.Fatalf("WS write: %v", err)
	}
	// Second peer: native TCP RequestRelay with the same UUID.
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 5*time.Second)
	if err != nil {
		t.Fatalf("TCP dial: %v", err)
	}
	defer conn.Close()
	if err := codec.WriteRawProto(conn, &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RequestRelay{
			RequestRelay: &pb.RequestRelay{Uuid: uuid},
		},
	}); err != nil {
		t.Fatalf("TCP write: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for srv.TotalRelayed.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if srv.TotalRelayed.Load() == 0 {
		t.Fatal("mixed relay pair was not established")
	}

	// Native TCP -> WebSocket: remove the BytesCodec header and preserve one
	// complete WebSocket binary message.
	fromTCP := []byte("signed-id-over-framed-tcp")
	if err := codec.WriteRelayFrame(conn, fromTCP); err != nil {
		t.Fatalf("TCP framed write: %v", err)
	}
	readCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	typ, gotWS, err := ws.Read(readCtx)
	if err != nil {
		t.Fatalf("WS read after TCP frame: %v", err)
	}
	if typ != websocket.MessageBinary || string(gotWS) != string(fromTCP) {
		t.Fatalf("TCP->WS mismatch: type=%v got=%q want=%q", typ, gotWS, fromTCP)
	}

	// WebSocket -> native TCP: add exactly one RustDesk BytesCodec header.
	fromWS := []byte("public-key-over-websocket")
	if err := ws.Write(ctx, websocket.MessageBinary, fromWS); err != nil {
		t.Fatalf("WS data write: %v", err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatalf("TCP deadline: %v", err)
	}
	gotTCP, err := codec.ReadRelayFrame(conn)
	if err != nil {
		t.Fatalf("TCP framed read after WS message: %v", err)
	}
	if string(gotTCP) != string(fromWS) {
		t.Fatalf("WS->TCP mismatch: got=%q want=%q", gotTCP, fromWS)
	}

	// Ending the TCP side must produce a standards-compliant WS close frame.
	conn.Close()
	closeCtx, closeCancel := context.WithTimeout(ctx, 5*time.Second)
	defer closeCancel()
	_, _, err = ws.Read(closeCtx)
	if status := websocket.CloseStatus(err); status != websocket.StatusNormalClosure {
		t.Fatalf("WS close status=%v, err=%v; want normal closure", status, err)
	}
}
