package relay

import (
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

	// Both sides should receive RelayResponse confirmation via the net.Conn adapter.
	// Since websocket.NetConn wraps binary messages, the framed RelayResponse
	// arrives as codec.WriteRawFrame bytes. We just verify the connection pair
	// was established by checking stats.
	time.Sleep(300 * time.Millisecond)

	if srv.TotalRelayed.Load() < 1 {
		t.Errorf("expected at least 1 relay session, got %d", srv.TotalRelayed.Load())
	}
}

func TestRelayRejectsMixedTCPAndWS(t *testing.T) {
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

	// First peer: WebSocket RequestRelay
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
	time.Sleep(50 * time.Millisecond)

	// Second peer: native TCP RequestRelay with same UUID
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
	for time.Now().Before(deadline) {
		if srv.TotalRelayed.Load() > 0 {
			t.Fatal("mixed TCP/WS pair must not start a relay session")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if srv.ActiveSessions.Load() != 0 {
		t.Fatalf("active sessions = %d, want 0", srv.ActiveSessions.Load())
	}
}
