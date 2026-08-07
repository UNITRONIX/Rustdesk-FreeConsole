package relay

import (
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/unitronix/betterdesk-server/codec"
	"github.com/unitronix/betterdesk-server/config"
	pb "github.com/unitronix/betterdesk-server/proto"
)

func waitRelayPairing(t *testing.T, srv *Server) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if srv.ActiveSessions.Load() >= 1 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("relay pairing did not complete within 3s, active sessions = %d", srv.ActiveSessions.Load())
}

func authorizeTestRelayPair(t *testing.T, uuid string) {
	t.Helper()
	if !AuthorizeRelayPair(uuid, "test-initiator", "test-target") {
		t.Fatalf("authorize relay UUID %q", uuid)
	}
}

func TestStandaloneCompatibilityAcceptsUUIDWithoutLocalTicket(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.RelayRequireTickets = false
	srv := New(cfg)

	if !srv.claimRelayTicket("standalone-uuid") || !srv.claimRelayTicket("standalone-uuid") {
		t.Fatal("standalone relay must accept both sides without a process-local signal ticket")
	}
}

func TestRelayRejectsUUIDWithoutTicketByDefault(t *testing.T) {
	srv := New(config.DefaultConfig())
	if srv.claimRelayTicket("unknown-default-uuid") {
		t.Fatal("all-in-one relay accepted a UUID without a signal-issued ticket")
	}
}

func TestRelayPairing(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.RelayPort = 0 // let OS pick a free port

	// We need to manually listen to get the actual port
	ln, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()

	cfg.RelayPort = port
	srv := New(cfg)

	ctx, cancel := t.Context(), func() {} // Go 1.21+ t.Context()
	_ = cancel

	// We can't use t.Context() on older Go — use context.Background
	if err := srv.Start(ctx); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer srv.Stop()

	uuid := "test-session-uuid-123"
	authorizeTestRelayPair(t, uuid)

	// Connect side A
	connA, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 5*time.Second)
	if err != nil {
		t.Fatalf("dial A: %v", err)
	}
	defer connA.Close()

	// Connect side B
	connB, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 5*time.Second)
	if err != nil {
		t.Fatalf("dial B: %v", err)
	}
	defer connB.Close()

	// Send RequestRelay from side A
	reqA := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RequestRelay{
			RequestRelay: &pb.RequestRelay{
				Uuid: uuid,
				Id:   "PEER_B",
			},
		},
	}
	if err := codec.WriteRawProto(connA, reqA); err != nil {
		t.Fatalf("write A: %v", err)
	}

	// Send RequestRelay from side B with same UUID
	reqB := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RequestRelay{
			RequestRelay: &pb.RequestRelay{
				Uuid: uuid,
				Id:   "PEER_A",
			},
		},
	}
	if err := codec.WriteRawProto(connB, reqB); err != nil {
		t.Fatalf("write B: %v", err)
	}

	// Wait for pairing to complete. The relay server does NOT send
	// RelayResponse confirmation — it immediately starts transparent
	// bidirectional byte copy after pairing (sending RelayResponse would
	// break the E2E encryption handshake in production).
	waitRelayPairing(t, srv)

	// Test bidirectional data relay (no confirmation message expected)
	testData := []byte("Hello from A to B!")
	connA.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, err = connA.Write(testData)
	if err != nil {
		t.Fatalf("write data A->B: %v", err)
	}

	buf := make([]byte, 1024)
	connB.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, err := connB.Read(buf)
	if err != nil {
		t.Fatalf("read data B: %v", err)
	}
	if string(buf[:n]) != string(testData) {
		t.Errorf("data mismatch: got %q, want %q", buf[:n], testData)
	}

	// Test reverse direction
	reverseData := []byte("Reply from B to A!")
	connB.SetWriteDeadline(time.Now().Add(5 * time.Second))
	connB.Write(reverseData)

	connA.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, err = connA.Read(buf)
	if err != nil {
		t.Fatalf("read data A: %v", err)
	}
	if string(buf[:n]) != string(reverseData) {
		t.Errorf("reverse data mismatch: got %q, want %q", buf[:n], reverseData)
	}

	// Verify stats
	if srv.ActiveSessions.Load() != 1 {
		t.Errorf("active sessions: got %d, want 1", srv.ActiveSessions.Load())
	}
	if srv.TotalRelayed.Load() != 1 {
		t.Errorf("total relayed: got %d, want 1", srv.TotalRelayed.Load())
	}
}

func TestRelaySimultaneousPairing(t *testing.T) {
	cfg := config.DefaultConfig()
	ln, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()

	cfg.RelayPort = port
	srv := New(cfg)
	if err := srv.Start(t.Context()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer srv.Stop()

	uuid := "simul-pair-uuid-789"
	authorizeTestRelayPair(t, uuid)
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	dialAndRequest := func(id string) net.Conn {
		conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
		if err != nil {
			t.Fatalf("dial %s: %v", id, err)
		}
		req := &pb.RendezvousMessage{
			Union: &pb.RendezvousMessage_RequestRelay{
				RequestRelay: &pb.RequestRelay{Uuid: uuid, Id: id},
			},
		}
		if err := codec.WriteRawProto(conn, req); err != nil {
			t.Fatalf("write %s: %v", id, err)
		}
		return conn
	}

	done := make(chan net.Conn, 2)
	go func() { done <- dialAndRequest("PEER_A") }()
	go func() { done <- dialAndRequest("PEER_B") }()

	connA := <-done
	connB := <-done
	defer connA.Close()
	defer connB.Close()

	waitRelayPairing(t, srv)
}

func TestRelayRejectsUnknownUUID(t *testing.T) {
	cfg := config.DefaultConfig()
	ln, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()

	cfg.RelayPort = port
	srv := New(cfg)
	if err := srv.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()

	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := codec.WriteRawProto(conn, &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RequestRelay{
			RequestRelay: &pb.RequestRelay{Uuid: "unknown-relay-uuid"},
		},
	}); err != nil {
		t.Fatal(err)
	}

	time.Sleep(100 * time.Millisecond)
	if srv.ActiveSessions.Load() != 0 || srv.TotalRelayed.Load() != 0 {
		t.Fatalf("unknown UUID must not create a session: active=%d total=%d",
			srv.ActiveSessions.Load(), srv.TotalRelayed.Load())
	}
}

func TestRelayHealthCheck(t *testing.T) {
	cfg := config.DefaultConfig()
	ln, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()

	cfg.RelayPort = port
	srv := New(cfg)
	if err := srv.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()

	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	// Send health check
	hc := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_Hc{
			Hc: &pb.HealthCheck{Token: "relay-test-123"},
		},
	}
	codec.WriteRawProto(conn, hc)

	resp, err := codec.ReadRawProto(conn, 5*time.Second)
	if err != nil {
		t.Fatalf("read HC response: %v", err)
	}
	if resp.GetHc() == nil || resp.GetHc().Token != "relay-test-123" {
		t.Error("expected health check response with matching token")
	}
}
