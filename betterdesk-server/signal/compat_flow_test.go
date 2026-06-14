package signal

import (
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/unitronix/betterdesk-server/codec"
	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/peer"
	pb "github.com/unitronix/betterdesk-server/proto"
	"github.com/unitronix/betterdesk-server/relay"
)

// TestSignalRelayWireFlow verifies signal relay assignment plus hbbr byte relay
// without changing the RustDesk wire protocol (no RelayResponse after pairing).
func TestSignalRelayWireFlow(t *testing.T) {
	cfgRelay := config.DefaultConfig()
	ln, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatalf("listen relay: %v", err)
	}
	relayPort := ln.Addr().(*net.TCPAddr).Port
	ln.Close()

	cfgRelay.RelayPort = relayPort
	relaySrv := relay.New(cfgRelay)
	if err := relaySrv.Start(t.Context()); err != nil {
		t.Fatalf("relay Start: %v", err)
	}
	defer relaySrv.Stop()

	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	srv.cfg.RelayServers = fmt.Sprintf("127.0.0.1:%d", relayPort)
	srv.localIP.Store("127.0.0.1")

	relayUUID := "compat-flow-relay-uuid-001"
	srv.peers.Put(&peer.Entry{
		ID:         "COMPATGT",
		ConnType:   peer.ConnTCP,
		LastReg:    time.Now(),
		StatusTier: peer.StatusOnline,
	})

	resp := srv.handleRequestRelayTCP(&pb.RequestRelay{
		Id:   "COMPATGT",
		Uuid: relayUUID,
	}, udpAddr("127.0.0.1", 52002))
	if resp == nil {
		t.Fatal("handleRequestRelayTCP returned nil")
	}
	rr := resp.GetRelayResponse()
	if rr == nil {
		t.Fatalf("expected RelayResponse, got %+v", resp)
	}
	if rr.Uuid != relayUUID {
		t.Fatalf("relay uuid = %q, want %q", rr.Uuid, relayUUID)
	}

	relayAddr := fmt.Sprintf("127.0.0.1:%d", relayPort)
	connA, err := net.DialTimeout("tcp", relayAddr, 5*time.Second)
	if err != nil {
		t.Fatalf("dial relay A: %v", err)
	}
	defer connA.Close()
	connB, err := net.DialTimeout("tcp", relayAddr, 5*time.Second)
	if err != nil {
		t.Fatalf("dial relay B: %v", err)
	}
	defer connB.Close()

	reqA := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RequestRelay{
			RequestRelay: &pb.RequestRelay{Uuid: relayUUID, Id: "COMPATGT"},
		},
	}
	reqB := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RequestRelay{
			RequestRelay: &pb.RequestRelay{Uuid: relayUUID, Id: "COMPATINIT"},
		},
	}
	if err := codec.WriteRawProto(connA, reqA); err != nil {
		t.Fatalf("write relay A: %v", err)
	}
	if err := codec.WriteRawProto(connB, reqB); err != nil {
		t.Fatalf("write relay B: %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if relaySrv.ActiveSessions.Load() >= 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if relaySrv.ActiveSessions.Load() != 1 {
		t.Fatalf("relay pairing did not complete, active sessions = %d", relaySrv.ActiveSessions.Load())
	}

	payload := []byte("compat-flow-payload")
	connA.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if _, err := connA.Write(payload); err != nil {
		t.Fatalf("write payload: %v", err)
	}

	buf := make([]byte, len(payload))
	connB.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, err := connB.Read(buf)
	if err != nil {
		t.Fatalf("read payload: %v", err)
	}
	if string(buf[:n]) != string(payload) {
		t.Fatalf("payload = %q, want %q", buf[:n], payload)
	}
}
