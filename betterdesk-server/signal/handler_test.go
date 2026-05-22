package signal

import (
	"bytes"
	"net"
	"path/filepath"
	"testing"
	"time"

	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/peer"
	pb "github.com/unitronix/betterdesk-server/proto"
	"github.com/unitronix/betterdesk-server/ratelimit"
)

func newTestSignalServer(t *testing.T, mode string) (*Server, db.Database) {
	t.Helper()

	database, err := db.OpenSQLite(filepath.Join(t.TempDir(), "signal-test.db"))
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	if err := database.Migrate(); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	t.Cleanup(func() { database.Close() })

	cfg := config.DefaultConfig()
	cfg.EnrollmentMode = mode
	return New(cfg, nil, database), database
}

func registerPkResult(resp *pb.RendezvousMessage) pb.RegisterPkResponse_Result {
	if resp == nil || resp.GetRegisterPkResponse() == nil {
		return pb.RegisterPkResponse_SERVER_ERROR
	}
	return resp.GetRegisterPkResponse().GetResult()
}

func newRegisterPk(peerID string) *pb.RegisterPk {
	return &pb.RegisterPk{
		Id:   peerID,
		Uuid: []byte("test-uuid-" + peerID),
		Pk:   bytes.Repeat([]byte{0x42}, 32),
	}
}

func udpAddr(ip string, port int) *net.UDPAddr {
	return &net.UDPAddr{IP: net.ParseIP(ip), Port: port}
}

func TestProcessRegisterPkManagedRejectsUnknownPeer(t *testing.T) {
	srv, database := newTestSignalServer(t, config.EnrollmentModeManaged)

	resp := srv.processRegisterPk(newRegisterPk("NEWPK1"), "203.0.113.10:50123")
	if got := registerPkResult(resp); got != pb.RegisterPkResponse_NOT_SUPPORT {
		t.Fatalf("RegisterPk result = %v, want %v", got, pb.RegisterPkResponse_NOT_SUPPORT)
	}

	peer, err := database.GetPeer("NEWPK1")
	if err != nil {
		t.Fatalf("GetPeer: %v", err)
	}
	if peer != nil {
		t.Fatalf("unknown peer was persisted: %+v", peer)
	}
	if entry := srv.peers.Get("NEWPK1"); entry != nil {
		t.Fatalf("unknown peer remained in memory: %+v", entry)
	}
}

func TestHandleRegisterPeerWSManagedRejectsUnknownPeer(t *testing.T) {
	srv, database := newTestSignalServer(t, config.EnrollmentModeManaged)

	resp := srv.handleRegisterPeerWS(&pb.RegisterPeer{Id: "WSDENY1", Serial: 1}, "203.0.113.11:51234")
	if resp != nil {
		t.Fatalf("handleRegisterPeerWS returned response for rejected peer: %+v", resp)
	}
	if entry := srv.peers.Get("WSDENY1"); entry != nil {
		t.Fatalf("unknown WS peer remained in memory: %+v", entry)
	}
	peer, err := database.GetPeer("WSDENY1")
	if err != nil {
		t.Fatalf("GetPeer: %v", err)
	}
	if peer != nil {
		t.Fatalf("unknown WS peer was persisted: %+v", peer)
	}
}

func TestRegistrationLimiterUsesPeerScopedBucket(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	limiter := ratelimit.NewIPLimiter(2, time.Minute, time.Minute)
	t.Cleanup(limiter.Stop)
	srv.SetRateLimiter(limiter)

	clientHost := "172.29.1.20"
	if !srv.allowRegistration(clientHost, "PROXYA1", true) {
		t.Fatal("first registration for PROXYA1 should be allowed")
	}
	if !srv.allowRegistration(clientHost, "PROXYA1", true) {
		t.Fatal("second registration for PROXYA1 should be allowed")
	}
	if srv.allowRegistration(clientHost, "PROXYA1", true) {
		t.Fatal("third registration for the same peer should be rate limited")
	}
	if !srv.allowRegistration(clientHost, "PROXYB1", true) {
		t.Fatal("different peer behind the same proxy should use a separate registration bucket")
	}
}

func TestRegistrationLimiterKeepsUnknownPeersIPScoped(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	limiter := ratelimit.NewIPLimiter(2, time.Minute, time.Minute)
	t.Cleanup(limiter.Stop)
	srv.SetRateLimiter(limiter)

	clientHost := "172.29.1.36"
	if !srv.allowRegistration(clientHost, "NEWAAA1", false) {
		t.Fatal("first unknown peer registration should be allowed")
	}
	if !srv.allowRegistration(clientHost, "NEWBBB1", false) {
		t.Fatal("second unknown peer registration should be allowed")
	}
	if srv.allowRegistration(clientHost, "NEWCCC1", false) {
		t.Fatal("third unknown peer behind the same proxy should be IP rate limited")
	}
}

func TestSignalConnectionLimiterDoesNotConsumeRegistrationBucket(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	limiter := ratelimit.NewIPLimiter(1, time.Minute, time.Minute)
	t.Cleanup(limiter.Stop)
	srv.SetRateLimiter(limiter)

	clientHost := "172.29.1.44"
	if !srv.allowSignalConnection(clientHost) {
		t.Fatal("first TCP signal connection should be allowed")
	}
	if srv.allowSignalConnection(clientHost) {
		t.Fatal("second TCP signal connection should be rate limited")
	}
	if !srv.allowRegistration(clientHost, "PROXYC1", true) {
		t.Fatal("TCP connection limit should not consume the registration bucket")
	}
}

func TestProcessRegisterPkManagedAllowsExistingPeer(t *testing.T) {
	srv, database := newTestSignalServer(t, config.EnrollmentModeManaged)

	if err := database.UpsertPeer(&db.Peer{ID: "KNOWN1", Status: "OFFLINE"}); err != nil {
		t.Fatalf("UpsertPeer: %v", err)
	}

	resp := srv.processRegisterPk(newRegisterPk("KNOWN1"), "203.0.113.10:50123")
	if got := registerPkResult(resp); got != pb.RegisterPkResponse_OK {
		t.Fatalf("RegisterPk result = %v, want %v", got, pb.RegisterPkResponse_OK)
	}

	peer, err := database.GetPeer("KNOWN1")
	if err != nil {
		t.Fatalf("GetPeer: %v", err)
	}
	if peer == nil || len(peer.PK) != 32 || peer.Status != "ONLINE" {
		t.Fatalf("existing peer was not updated correctly: %+v", peer)
	}
}

func TestProcessRegisterPkManagedAllowsTokenBoundPeer(t *testing.T) {
	srv, database := newTestSignalServer(t, config.EnrollmentModeManaged)

	token := &db.DeviceToken{
		Token:     "tokentest12345678",
		TokenHash: "token-hash-tokenpk1",
		Name:      "Token-bound stock peer",
		PeerID:    "TOKEN1",
		Status:    db.TokenStatusPending,
		MaxUses:   1,
	}
	if err := database.CreateDeviceToken(token); err != nil {
		t.Fatalf("CreateDeviceToken: %v", err)
	}

	resp := srv.processRegisterPk(newRegisterPk("TOKEN1"), "203.0.113.10:50123")
	if got := registerPkResult(resp); got != pb.RegisterPkResponse_OK {
		t.Fatalf("RegisterPk result = %v, want %v", got, pb.RegisterPkResponse_OK)
	}

	peer, err := database.GetPeer("TOKEN1")
	if err != nil {
		t.Fatalf("GetPeer: %v", err)
	}
	if peer == nil || len(peer.PK) != 32 {
		t.Fatalf("token-bound peer was not persisted with PK: %+v", peer)
	}
}

func TestSelectPeerRelayServerKeepsPublicRelayForSharedPublicIP(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	srv.localIP.Store("198.51.100.20")
	srv.lanIP.Store("10.0.0.20")

	relay, sameLAN, samePublic := srv.selectPeerRelayServer(
		"10.0.0.20:21117",
		udpAddr("203.0.113.44", 51000),
		udpAddr("203.0.113.44", 52000),
	)

	if relay != "198.51.100.20:21117" {
		t.Fatalf("relay = %q, want public relay", relay)
	}
	if sameLAN {
		t.Fatal("shared public IP must not be treated as LAN when SameNATRelay is enabled")
	}
	if !samePublic {
		t.Fatal("shared public IP hairpin flag was not set")
	}
}

func TestSelectPeerRelayServerUsesLANRelayForPrivateSubnet(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	srv.localIP.Store("198.51.100.20")
	srv.lanIP.Store("192.168.1.20")

	relay, sameLAN, samePublic := srv.selectPeerRelayServer(
		"198.51.100.20:21117",
		udpAddr("192.168.1.10", 51000),
		udpAddr("192.168.1.42", 52000),
	)

	if relay != "192.168.1.20:21117" {
		t.Fatalf("relay = %q, want LAN relay", relay)
	}
	if !sameLAN {
		t.Fatal("private same-subnet peers should use LAN relay")
	}
	if samePublic {
		t.Fatal("private same-subnet peers should not be marked as shared public IP")
	}
}

func TestSelectPeerRelayServerKeepsDefaultRelayWhenLANRelayOutsidePeerSubnet(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	srv.localIP.Store("198.51.100.20")
	srv.lanIP.Store("10.1.0.2")

	relay, sameLAN, samePublic := srv.selectPeerRelayServer(
		"198.51.100.20:21117",
		udpAddr("172.29.1.77", 51000),
		udpAddr("172.29.1.91", 52000),
	)

	if relay != "198.51.100.20:21117" {
		t.Fatalf("relay = %q, want configured/default relay", relay)
	}
	if !sameLAN {
		t.Fatal("private same-subnet peers should still be detected as LAN peers")
	}
	if samePublic {
		t.Fatal("private same-subnet peers should not be marked as shared public IP")
	}
}

func TestHandleRequestRelayTCPSamePublicIPIgnoresPrivateRelayHint(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	srv.localIP.Store("198.51.100.20")
	srv.lanIP.Store("10.0.0.20")

	srv.peers.Put(&peer.Entry{
		ID:         "TARGET121",
		UDPAddr:    udpAddr("203.0.113.44", 52000),
		ConnType:   peer.ConnTCP,
		LastReg:    time.Now(),
		StatusTier: peer.StatusOnline,
	})

	resp := srv.handleRequestRelayTCP(&pb.RequestRelay{
		Id:          "TARGET121",
		Uuid:        "issue-121-relay-uuid",
		RelayServer: "10.0.0.20:21117",
	}, udpAddr("203.0.113.44", 51000))

	rr := resp.GetRelayResponse()
	if rr == nil {
		t.Fatalf("expected RelayResponse, got %+v", resp)
	}
	if rr.RelayServer != "198.51.100.20:21117" {
		t.Fatalf("relay = %q, want public relay", rr.RelayServer)
	}
}
