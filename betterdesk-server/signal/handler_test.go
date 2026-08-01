package signal

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/events"
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

	pending, err := database.GetConfig("pending_device_NEWPK1")
	if err != nil {
		t.Fatalf("GetConfig pending: %v", err)
	}
	if pending == "" {
		t.Fatal("managed mode should queue unknown peer in pending_device_NEWPK1")
	}
}

func TestProcessRegisterPkLockedDoesNotQueueUnknownPeer(t *testing.T) {
	srv, database := newTestSignalServer(t, config.EnrollmentModeLocked)

	resp := srv.processRegisterPk(newRegisterPk("LOCKPK1"), "203.0.113.10:50123")
	if got := registerPkResult(resp); got != pb.RegisterPkResponse_NOT_SUPPORT {
		t.Fatalf("RegisterPk result = %v, want %v", got, pb.RegisterPkResponse_NOT_SUPPORT)
	}

	pending, err := database.GetConfig("pending_device_LOCKPK1")
	if err != nil {
		t.Fatalf("GetConfig pending: %v", err)
	}
	if pending != "" {
		t.Fatalf("locked mode must not create pending queue, got: %s", pending)
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

func TestHandleRegisterPeerWSRejectsSoftDeletedPeer(t *testing.T) {
	srv, database := newTestSignalServer(t, config.EnrollmentModeManaged)

	if err := database.UpsertPeer(&db.Peer{ID: "WSDEL1", Status: "OFFLINE", IP: "10.0.0.1"}); err != nil {
		t.Fatal(err)
	}
	if err := database.DeletePeer("WSDEL1"); err != nil {
		t.Fatal(err)
	}

	resp := srv.handleRegisterPeerWS(&pb.RegisterPeer{Id: "WSDEL1", Serial: 1}, "203.0.113.12:51234")
	if resp != nil {
		t.Fatalf("handleRegisterPeerWS should reject soft-deleted peer, got: %+v", resp)
	}
	if entry := srv.peers.Get("WSDEL1"); entry != nil {
		t.Fatalf("soft-deleted WS peer must not enter memory map: %+v", entry)
	}
	peer, err := database.GetPeer("WSDEL1")
	if err != nil {
		t.Fatalf("GetPeer: %v", err)
	}
	if peer != nil {
		t.Fatal("soft-deleted peer must remain invisible to GetPeer")
	}
}

func TestHandleRegisterPeerWSRejectsSoftDeletedHeartbeat(t *testing.T) {
	srv, database := newTestSignalServer(t, config.EnrollmentModeOpen)

	if err := database.UpsertPeer(&db.Peer{ID: "WSHB1", Status: "ONLINE", IP: "10.0.0.2"}); err != nil {
		t.Fatal(err)
	}
	srv.peers.Put(&peer.Entry{
		ID:       "WSHB1",
		IP:       "203.0.113.13:51234",
		Serial:   1,
		ConnType: peer.ConnWS,
		LastReg:  time.Now(),
	})
	if err := database.DeletePeer("WSHB1"); err != nil {
		t.Fatal(err)
	}

	resp := srv.handleRegisterPeerWS(&pb.RegisterPeer{Id: "WSHB1", Serial: 2}, "203.0.113.13:51234")
	if resp != nil {
		t.Fatalf("heartbeat for soft-deleted peer should be rejected, got: %+v", resp)
	}
}

func TestRegistrationLimiterSkipsKnownPeerHeartbeats(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	limiter := ratelimit.NewIPLimiter(2, time.Minute, time.Minute)
	t.Cleanup(limiter.Stop)
	srv.SetRateLimiter(limiter)

	clientHost := "172.29.1.20"
	for i := 0; i < 10; i++ {
		if !srv.allowRegistration(clientHost, "PROXYA1", true) {
			t.Fatalf("known peer heartbeat %d must not be rate limited", i+1)
		}
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

func TestProcessIDChangeSoftDeletedTargetReturnsIDExists(t *testing.T) {
	srv, database := newTestSignalServer(t, config.EnrollmentModeOpen)

	if err := database.UpsertPeer(&db.Peer{ID: "OLD213", Status: "ONLINE"}); err != nil {
		t.Fatal(err)
	}
	if err := database.UpsertPeer(&db.Peer{ID: "MACPRO", Status: "OFFLINE"}); err != nil {
		t.Fatal(err)
	}
	if err := database.DeletePeer("MACPRO"); err != nil {
		t.Fatal(err)
	}

	msg := newRegisterPk("MACPRO")
	msg.OldId = "OLD213"
	resp := srv.processIDChange(msg)
	if got := registerPkResult(resp); got != pb.RegisterPkResponse_ID_EXISTS {
		t.Fatalf("ID change result = %v, want %v", got, pb.RegisterPkResponse_ID_EXISTS)
	}
}

func TestProcessIDChangeRejectsInvalidNewID(t *testing.T) {
	srv, database := newTestSignalServer(t, config.EnrollmentModeOpen)

	if err := database.UpsertPeer(&db.Peer{ID: "OLD213", Status: "ONLINE"}); err != nil {
		t.Fatal(err)
	}

	msg := newRegisterPk("bad/id")
	msg.OldId = "OLD213"
	resp := srv.processIDChange(msg)
	if got := registerPkResult(resp); got != pb.RegisterPkResponse_NOT_SUPPORT {
		t.Fatalf("ID change result = %v, want %v", got, pb.RegisterPkResponse_NOT_SUPPORT)
	}

	if peer, err := database.GetPeer("OLD213"); err != nil {
		t.Fatal(err)
	} else if peer == nil {
		t.Fatal("OLD213 should remain active after rejected invalid target ID")
	}
	if entry := srv.peers.Get("bad/id"); entry != nil {
		t.Fatalf("invalid target ID must not enter memory map: %+v", entry)
	}
}

func TestProcessIDChangeRejectsSoftDeletedSource(t *testing.T) {
	srv, database := newTestSignalServer(t, config.EnrollmentModeOpen)

	if err := database.UpsertPeer(&db.Peer{ID: "MACPRO", Status: "OFFLINE"}); err != nil {
		t.Fatal(err)
	}
	if err := database.DeletePeer("MACPRO"); err != nil {
		t.Fatal(err)
	}

	msg := newRegisterPk("MACPRO1")
	msg.OldId = "MACPRO"
	resp := srv.processIDChange(msg)
	if got := registerPkResult(resp); got != pb.RegisterPkResponse_NOT_SUPPORT {
		t.Fatalf("ID change result = %v, want %v", got, pb.RegisterPkResponse_NOT_SUPPORT)
	}

	state, err := database.GetPeerIDState("MACPRO")
	if err != nil {
		t.Fatal(err)
	}
	if state != db.PeerIDSoftDeleted {
		t.Fatalf("MACPRO state = %s, want %s", state, db.PeerIDSoftDeleted)
	}
	state, err = database.GetPeerIDState("MACPRO1")
	if err != nil {
		t.Fatal(err)
	}
	if state != db.PeerIDMissing {
		t.Fatalf("MACPRO1 state = %s, want %s", state, db.PeerIDMissing)
	}
}

func TestProcessIDChangeRejectsPKMismatch(t *testing.T) {
	srv, database := newTestSignalServer(t, config.EnrollmentModeOpen)

	if err := database.UpsertPeer(&db.Peer{
		ID:     "OLD213",
		Status: "ONLINE",
		PK:     bytes.Repeat([]byte{0x99}, 32),
	}); err != nil {
		t.Fatal(err)
	}

	msg := newRegisterPk("NEW213")
	msg.OldId = "OLD213"
	resp := srv.processIDChange(msg)
	if got := registerPkResult(resp); got != pb.RegisterPkResponse_NOT_SUPPORT {
		t.Fatalf("ID change result = %v, want %v", got, pb.RegisterPkResponse_NOT_SUPPORT)
	}

	if peer, err := database.GetPeer("OLD213"); err != nil {
		t.Fatal(err)
	} else if peer == nil {
		t.Fatal("OLD213 should remain active after rejected ID change")
	}
}

func TestProcessIDChangeSuccessEmptyPK(t *testing.T) {
	srv, database := newTestSignalServer(t, config.EnrollmentModeOpen)

	storedPK := bytes.Repeat([]byte{0x42}, 32)
	if err := database.UpsertPeer(&db.Peer{
		ID:     "MACPRO1",
		Status: "ONLINE",
		PK:     storedPK,
		UUID:   "aabbccddeeff00112233445566778899",
	}); err != nil {
		t.Fatal(err)
	}

	msg := &pb.RegisterPk{
		Id:    "MACPRO",
		OldId: "MACPRO1",
		Uuid:  []byte("machine-uid-bytes"),
	}
	resp := srv.processIDChange(msg)
	if got := registerPkResult(resp); got != pb.RegisterPkResponse_OK {
		t.Fatalf("ID change result = %v, want %v", got, pb.RegisterPkResponse_OK)
	}

	peer, err := database.GetPeer("MACPRO")
	if err != nil || peer == nil {
		t.Fatalf("GetPeer MACPRO: %v %+v", err, peer)
	}
	if len(peer.PK) != 32 || !bytes.Equal(peer.PK, storedPK) {
		t.Fatalf("PK not preserved: len=%d", len(peer.PK))
	}
	if old, _ := database.GetPeer("MACPRO1"); old != nil {
		t.Fatalf("MACPRO1 should be removed after ID change: %+v", old)
	}
}

func TestProcessIDChangeRejectsWrongPKWhenPKSent(t *testing.T) {
	srv, database := newTestSignalServer(t, config.EnrollmentModeOpen)

	if err := database.UpsertPeer(&db.Peer{
		ID:     "OLD213",
		Status: "ONLINE",
		PK:     bytes.Repeat([]byte{0x99}, 32),
	}); err != nil {
		t.Fatal(err)
	}

	msg := newRegisterPk("NEW213")
	msg.OldId = "OLD213"
	msg.Pk = bytes.Repeat([]byte{0x42}, 32)
	resp := srv.processIDChange(msg)
	if got := registerPkResult(resp); got != pb.RegisterPkResponse_NOT_SUPPORT {
		t.Fatalf("ID change result = %v, want %v", got, pb.RegisterPkResponse_NOT_SUPPORT)
	}
}

func TestResolveRegistrationPeerIDRedirectsSameDevice(t *testing.T) {
	srv, database := newTestSignalServer(t, config.EnrollmentModeOpen)

	if err := database.UpsertPeer(&db.Peer{
		ID:     "MACPRO1",
		Status: "ONLINE",
		IP:     "203.0.113.50",
		PK:     bytes.Repeat([]byte{0x42}, 32),
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.ChangePeerID("MACPRO1", "MACPRO2", "panel"); err != nil {
		t.Fatal(err)
	}

	effective, ok := srv.resolveRegistrationPeerID("MACPRO1", "203.0.113.50", nil, nil)
	if !ok || effective != "MACPRO2" {
		t.Fatalf("resolveRegistrationPeerID same IP = (%q, %v), want (MACPRO2, true)", effective, ok)
	}
	effective, ok = srv.resolveRegistrationPeerID("MACPRO1", "198.51.100.99", nil, nil)
	if ok {
		t.Fatalf("resolveRegistrationPeerID different IP = (%q, %v), want reject", effective, ok)
	}
}

func TestTCPIDChangeEmptyPKRustDesk147(t *testing.T) {
	srv, database := newTestSignalServer(t, config.EnrollmentModeOpen)

	storedPK := bytes.Repeat([]byte{0x42}, 32)
	if err := database.UpsertPeer(&db.Peer{
		ID:     "MACPRO1",
		Status: "ONLINE",
		PK:     storedPK,
		IP:     "203.0.113.10",
	}); err != nil {
		t.Fatal(err)
	}

	fakeAddr, err := net.ResolveTCPAddr("tcp", "203.0.113.10:50123")
	if err != nil {
		t.Fatal(err)
	}

	resp := srv.handleRegisterPkTCP(&pb.RegisterPk{
		OldId: "MACPRO1",
		Id:    "MACPRO",
		Uuid:  []byte("machine-uid-bytes"),
	}, fakeAddr)
	if got := registerPkResult(resp); got != pb.RegisterPkResponse_OK {
		t.Fatalf("TCP ID change result = %v, want OK", got)
	}

	peer, err := database.GetPeer("MACPRO")
	if err != nil || peer == nil {
		t.Fatalf("GetPeer MACPRO: %v %+v", err, peer)
	}
	if !bytes.Equal(peer.PK, storedPK) {
		t.Fatal("stored PK should be preserved when client omits pk")
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
	// Same public IP as target — FindByIP resolves the registered peer (#302 gate).
	srv.peers.Put(&peer.Entry{
		ID:         "INIT121",
		UDPAddr:    udpAddr("203.0.113.44", 51000),
		ConnType:   peer.ConnTCP,
		LastReg:    time.Now(),
		StatusTier: peer.StatusOnline,
	})

	resp := srv.handleRequestRelayTCP(&pb.RequestRelay{
		Id:          "TARGET121",
		Uuid:        "issue-121-relay-uuid",
		RelayServer: "10.0.0.20:21117",
	}, udpAddr("203.0.113.44", 51000), peer.ConnTCP)

	rr := resp.GetRelayResponse()
	if rr == nil {
		t.Fatalf("expected RelayResponse, got %+v", resp)
	}
	if rr.RefuseReason != "" {
		t.Fatalf("unexpected RefuseReason %q", rr.RefuseReason)
	}
	if rr.RelayServer != "198.51.100.20:21117" {
		t.Fatalf("relay = %q, want public relay", rr.RelayServer)
	}
}

func TestHandleRequestRelayTCPProtocolMismatch(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	srv.localIP.Store("198.51.100.20")

	srv.peers.Put(&peer.Entry{
		ID:         "NATIVETGT",
		UDPAddr:    udpAddr("203.0.113.50", 52000),
		ConnType:   peer.ConnTCP,
		LastReg:    time.Now(),
		StatusTier: peer.StatusOnline,
	})
	srv.peers.Put(&peer.Entry{
		ID:         "WSINIT01",
		UDPAddr:    udpAddr("198.51.100.30", 51000),
		ConnType:   peer.ConnWS,
		LastReg:    time.Now(),
		StatusTier: peer.StatusOnline,
	})

	resp := srv.handleRequestRelayTCP(&pb.RequestRelay{
		Id:   "NATIVETGT",
		Uuid: "issue-290-mismatch-uuid",
	}, udpAddr("198.51.100.30", 51000), peer.ConnWS)

	rr := resp.GetRelayResponse()
	if rr == nil {
		t.Fatalf("expected RelayResponse, got %+v", resp)
	}
	if rr.RefuseReason != refuseRelayProtocolMismatch {
		t.Fatalf("RefuseReason = %q, want %q", rr.RefuseReason, refuseRelayProtocolMismatch)
	}
}

func TestHandleRequestRelayTCPMatchingWSAllowed(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	srv.localIP.Store("198.51.100.20")

	srv.peers.Put(&peer.Entry{
		ID:         "WSTARGET",
		UDPAddr:    udpAddr("203.0.113.60", 52000),
		ConnType:   peer.ConnWS,
		LastReg:    time.Now(),
		StatusTier: peer.StatusOnline,
	})
	srv.peers.Put(&peer.Entry{
		ID:         "WSINIT02",
		UDPAddr:    udpAddr("198.51.100.40", 51000),
		ConnType:   peer.ConnWS,
		LastReg:    time.Now(),
		StatusTier: peer.StatusOnline,
	})

	resp := srv.handleRequestRelayTCP(&pb.RequestRelay{
		Id:   "WSTARGET",
		Uuid: "issue-290-match-uuid",
	}, udpAddr("198.51.100.40", 51000), peer.ConnWS)

	rr := resp.GetRelayResponse()
	if rr == nil {
		t.Fatalf("expected RelayResponse, got %+v", resp)
	}
	if rr.RefuseReason != "" {
		t.Fatalf("unexpected RefuseReason %q", rr.RefuseReason)
	}
	if rr.Uuid != "issue-290-match-uuid" {
		t.Fatalf("uuid = %q", rr.Uuid)
	}
}

func TestRelayTransportMismatchHelper(t *testing.T) {
	cases := []struct {
		a, b peer.ConnType
		want bool
	}{
		{peer.ConnWS, peer.ConnTCP, true},
		{peer.ConnWS, peer.ConnUDP, true},
		{peer.ConnTCP, peer.ConnWS, true},
		{peer.ConnUDP, peer.ConnWS, true},
		{peer.ConnWS, peer.ConnWS, false},
		{peer.ConnTCP, peer.ConnUDP, false},
		{peer.ConnTCP, peer.ConnTCP, false},
		{peer.ConnUDP, peer.ConnUDP, false},
	}
	for _, tc := range cases {
		if got := relayTransportMismatch(tc.a, tc.b); got != tc.want {
			t.Errorf("relayTransportMismatch(%s, %s) = %v, want %v", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestCancelPunchFallback(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	srv.cfg.P2PFirst = true
	srv.cfg.P2PFallbackMs = 300

	fired := false
	srv.schedulePunchFallback("203.0.113.10:50000", func() { fired = true })
	if !srv.cancelPunchFallback("203.0.113.10:50000") {
		t.Fatal("expected cancelPunchFallback to succeed")
	}
	time.Sleep(400 * time.Millisecond)
	if fired {
		t.Fatal("fallback timer should not fire after cancel")
	}
}

func TestOrgPolicyForcesRelayOnPunchHole(t *testing.T) {
	srv, database := newTestSignalServer(t, config.EnrollmentModeOpen)
	if err := database.CreateOrganization(&db.Organization{ID: "orgp2p", Name: "P2P Org"}); err != nil {
		t.Fatalf("CreateOrganization: %v", err)
	}
	if err := database.SetOrgSetting("orgp2p", "policy_network", `{"block_direct_p2p":true}`); err != nil {
		t.Fatalf("SetOrgSetting: %v", err)
	}
	if err := database.AssignDeviceToOrg(&db.OrgDevice{OrgID: "orgp2p", DeviceID: "TARGETP2P"}); err != nil {
		t.Fatalf("AssignDeviceToOrg: %v", err)
	}

	srv.peers.Put(&peer.Entry{
		ID:         "TARGETP2P",
		UDPAddr:    udpAddr("203.0.113.50", 52000),
		LastReg:    time.Now(),
		StatusTier: peer.StatusOnline,
		PK:         bytes.Repeat([]byte{0x11}, 32),
	})

	initiator := udpAddr("198.51.100.30", 51000)
	srv.peers.Put(&peer.Entry{
		ID:         "INITP2P",
		UDPAddr:    initiator,
		LastReg:    time.Now(),
		StatusTier: peer.StatusOnline,
	})

	if !srv.shouldForceRelayForPeers("INITP2P", "TARGETP2P") {
		t.Fatal("org block_direct_p2p should force relay")
	}
}

func TestPublishPeerOnlineEmitsEvent(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)

	sub := srv.eventBus.Subscribe(events.EventPeerOnline)
	defer srv.eventBus.Unsubscribe(sub)

	srv.publishPeerOnline("PEERON1")

	select {
	case evt := <-sub.Ch:
		if evt.Type != events.EventPeerOnline {
			t.Fatalf("event type = %s, want %s", evt.Type, events.EventPeerOnline)
		}
		if evt.Data["id"] != "PEERON1" {
			t.Fatalf("event id = %q, want PEERON1", evt.Data["id"])
		}
		if evt.Data["status"] != "online" {
			t.Fatalf("event status = %q, want online", evt.Data["status"])
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for peer_online event")
	}
}

func putOnlinePeer(srv *Server, id, ip string, port int, connType peer.ConnType) {
	srv.peers.Put(&peer.Entry{
		ID:         id,
		UDPAddr:    udpAddr(ip, port),
		IP:         udpAddr(ip, port).String(),
		ConnType:   connType,
		LastReg:    time.Now(),
		StatusTier: peer.StatusOnline,
	})
}

func TestAnonymousInitiatorPunchHoleRejected(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	putOnlinePeer(srv, "TGTANON1", "203.0.113.50", 52000, peer.ConnUDP)

	resp := srv.handlePunchHoleRequestTCP(&pb.PunchHoleRequest{Id: "TGTANON1"}, udpAddr("198.51.100.99", 51000))
	phr := resp.GetPunchHoleResponse()
	if phr == nil {
		t.Fatalf("expected PunchHoleResponse, got %+v", resp)
	}
	if phr.Failure != pb.PunchHoleResponse_ID_NOT_EXIST {
		t.Fatalf("Failure = %v, want ID_NOT_EXIST", phr.Failure)
	}
}

func TestAnonymousInitiatorRequestRelayRejected(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	putOnlinePeer(srv, "TGTANON2", "203.0.113.51", 52000, peer.ConnTCP)

	resp := srv.handleRequestRelayTCP(&pb.RequestRelay{
		Id:   "TGTANON2",
		Uuid: "anon-relay-uuid",
	}, udpAddr("198.51.100.98", 51000), peer.ConnTCP)
	rr := resp.GetRelayResponse()
	if rr == nil {
		t.Fatalf("expected RelayResponse, got %+v", resp)
	}
	if rr.RefuseReason != refuseInitiatorNotAuthorized {
		t.Fatalf("RefuseReason = %q, want %q", rr.RefuseReason, refuseInitiatorNotAuthorized)
	}
}

func TestManagedPendingInitiatorCannotPunchHole(t *testing.T) {
	srv, database := newTestSignalServer(t, config.EnrollmentModeManaged)
	putOnlinePeer(srv, "TGTPEND1", "203.0.113.60", 52000, peer.ConnUDP)
	// Simulate memory-only / pending peer (no approved DB row) — the #302 bypass case.
	putOnlinePeer(srv, "PENDINIT1", "198.51.100.70", 51000, peer.ConnUDP)
	if err := database.SetConfig("pending_device_PENDINIT1", `{"device_id":"PENDINIT1"}`); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}

	resp := srv.handlePunchHoleRequestTCP(&pb.PunchHoleRequest{Id: "TGTPEND1"}, udpAddr("198.51.100.70", 51000))
	phr := resp.GetPunchHoleResponse()
	if phr == nil {
		t.Fatalf("expected PunchHoleResponse, got %+v", resp)
	}
	if phr.Failure != pb.PunchHoleResponse_ID_NOT_EXIST {
		t.Fatalf("Failure = %v, want ID_NOT_EXIST (pending must not initiate)", phr.Failure)
	}
}

func TestManagedPendingInitiatorCannotRequestRelay(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeManaged)
	putOnlinePeer(srv, "TGTPEND2", "203.0.113.61", 52000, peer.ConnTCP)
	putOnlinePeer(srv, "PENDINIT2", "198.51.100.71", 51000, peer.ConnTCP)

	resp := srv.handleRequestRelayTCP(&pb.RequestRelay{
		Id:   "TGTPEND2",
		Uuid: "pending-relay-uuid",
	}, udpAddr("198.51.100.71", 51000), peer.ConnTCP)
	rr := resp.GetRelayResponse()
	if rr == nil {
		t.Fatalf("expected RelayResponse, got %+v", resp)
	}
	if rr.RefuseReason != refuseInitiatorNotAuthorized {
		t.Fatalf("RefuseReason = %q, want %q", rr.RefuseReason, refuseInitiatorNotAuthorized)
	}
}

func TestManagedApprovedInitiatorCanRequestRelay(t *testing.T) {
	srv, database := newTestSignalServer(t, config.EnrollmentModeManaged)
	if err := database.UpsertPeer(&db.Peer{ID: "APPRINIT1", Status: "ONLINE", IP: "198.51.100.72"}); err != nil {
		t.Fatalf("UpsertPeer initiator: %v", err)
	}
	putOnlinePeer(srv, "TGTAPPR1", "203.0.113.62", 52000, peer.ConnTCP)
	putOnlinePeer(srv, "APPRINIT1", "198.51.100.72", 51000, peer.ConnTCP)

	resp := srv.handleRequestRelayTCP(&pb.RequestRelay{
		Id:   "TGTAPPR1",
		Uuid: "approved-relay-uuid",
	}, udpAddr("198.51.100.72", 51000), peer.ConnTCP)
	rr := resp.GetRelayResponse()
	if rr == nil {
		t.Fatalf("expected RelayResponse, got %+v", resp)
	}
	if rr.RefuseReason != "" {
		t.Fatalf("approved initiator should not be refused, got %q", rr.RefuseReason)
	}
	if rr.Uuid != "approved-relay-uuid" {
		t.Fatalf("uuid = %q", rr.Uuid)
	}
}

func TestLockedInitiatorWithoutDBPeerRejected(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeLocked)
	putOnlinePeer(srv, "TGTLOCK1", "203.0.113.70", 52000, peer.ConnTCP)
	putOnlinePeer(srv, "LOCKINIT1", "198.51.100.80", 51000, peer.ConnTCP)

	resp := srv.handleRequestRelayTCP(&pb.RequestRelay{
		Id:   "TGTLOCK1",
		Uuid: "locked-relay-uuid",
	}, udpAddr("198.51.100.80", 51000), peer.ConnTCP)
	rr := resp.GetRelayResponse()
	if rr == nil {
		t.Fatalf("expected RelayResponse, got %+v", resp)
	}
	if rr.RefuseReason != refuseInitiatorNotAuthorized {
		t.Fatalf("RefuseReason = %q, want %q", rr.RefuseReason, refuseInitiatorNotAuthorized)
	}
}

func TestOpenRegisteredInitiatorCanRequestRelay(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	putOnlinePeer(srv, "TGTOPEN1", "203.0.113.80", 52000, peer.ConnTCP)
	putOnlinePeer(srv, "OPENINIT1", "198.51.100.90", 51000, peer.ConnTCP)

	resp := srv.handleRequestRelayTCP(&pb.RequestRelay{
		Id:   "TGTOPEN1",
		Uuid: "open-relay-uuid",
	}, udpAddr("198.51.100.90", 51000), peer.ConnTCP)
	rr := resp.GetRelayResponse()
	if rr == nil {
		t.Fatalf("expected RelayResponse, got %+v", resp)
	}
	if rr.RefuseReason != "" {
		t.Fatalf("unexpected RefuseReason %q", rr.RefuseReason)
	}
	if rr.Uuid != "open-relay-uuid" {
		t.Fatalf("uuid = %q", rr.Uuid)
	}
}

func TestPanelProxyLoopbackCanPunchHoleWithoutPeer(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeManaged)
	putOnlinePeer(srv, "TGTWEB1", "203.0.113.90", 52000, peer.ConnTCP)

	id, ok := srv.requireAuthorizedInitiator(udpAddr("127.0.0.1", 51000), "TGTWEB1", "")
	if !ok || id != panelWebRemoteInitiatorID {
		t.Fatalf("loopback panel proxy = (%q, %v), want (%q, true)", id, ok, panelWebRemoteInitiatorID)
	}

	// Web Remote: panel bridges from loopback; no RegisterPeer for the browser.
	// P2P-first may return nil while forwarding to the target; unauthorized always
	// returns PunchHoleResponse{Failure: ID_NOT_EXIST}.
	resp := srv.handlePunchHoleRequestTCP(&pb.PunchHoleRequest{Id: "TGTWEB1"}, udpAddr("127.0.0.1", 51000))
	if phr := resp.GetPunchHoleResponse(); phr != nil && phr.Failure == pb.PunchHoleResponse_ID_NOT_EXIST {
		t.Fatal("panel loopback PunchHole must not be refused as unauthorized")
	}
}

func TestPanelProxyLoopbackCanRequestRelayWithoutPeer(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeManaged)
	putOnlinePeer(srv, "TGTWEB2", "203.0.113.91", 52000, peer.ConnTCP)

	resp := srv.handleRequestRelayTCP(&pb.RequestRelay{
		Id:   "TGTWEB2",
		Uuid: "web-remote-relay-uuid",
	}, udpAddr("127.0.0.1", 51000), peer.ConnTCP)
	rr := resp.GetRelayResponse()
	if rr == nil {
		t.Fatalf("expected RelayResponse, got %+v", resp)
	}
	if rr.RefuseReason != "" {
		t.Fatalf("panel loopback relay refused: %q", rr.RefuseReason)
	}
	if rr.Uuid != "web-remote-relay-uuid" {
		t.Fatalf("uuid = %q", rr.Uuid)
	}
}

func TestPublicAnonymousInitiatorStillRejectedWithPanelAllowlist(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	putOnlinePeer(srv, "TGTPUB1", "203.0.113.92", 52000, peer.ConnTCP)

	id, ok := srv.requireAuthorizedInitiator(udpAddr("198.51.100.99", 51000), "TGTPUB1", "")
	if ok || id != "" {
		t.Fatalf("public anonymous = (%q, %v), want reject", id, ok)
	}

	resp := srv.handlePunchHoleRequestTCP(&pb.PunchHoleRequest{Id: "TGTPUB1"}, udpAddr("198.51.100.99", 51000))
	phr := resp.GetPunchHoleResponse()
	if phr == nil || phr.Failure != pb.PunchHoleResponse_ID_NOT_EXIST {
		t.Fatalf("public anonymous PunchHole should be unauthorized, got %+v", resp)
	}
}

func TestManagedPendingStillRejectedDespitePanelAllowlist(t *testing.T) {
	// Pending peer on a non-loopback IP must still be blocked (#302).
	srv, database := newTestSignalServer(t, config.EnrollmentModeManaged)
	putOnlinePeer(srv, "TGTPEND3", "203.0.113.93", 52000, peer.ConnUDP)
	putOnlinePeer(srv, "PENDINIT3", "198.51.100.73", 51000, peer.ConnUDP)
	if err := database.SetConfig("pending_device_PENDINIT3", `{"device_id":"PENDINIT3"}`); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}

	id, ok := srv.requireAuthorizedInitiator(udpAddr("198.51.100.73", 51000), "TGTPEND3", "")
	if ok {
		t.Fatalf("pending initiator must be rejected, got id=%q", id)
	}
}

func TestTCPRegisterPkBindsIPForViewerOnlyPunch(t *testing.T) {
	// #327: approved peer, no UDP heartbeat; TCP RegisterPk then PunchHole on same IP.
	srv, database := newTestSignalServer(t, config.EnrollmentModeOpen)
	if err := database.UpsertPeer(&db.Peer{ID: "VIEWINIT1", Status: "OFFLINE", IP: "198.51.100.40"}); err != nil {
		t.Fatalf("UpsertPeer: %v", err)
	}
	putOnlinePeer(srv, "TGTVIEW1", "203.0.113.40", 52000, peer.ConnTCP)

	resp := srv.processRegisterPk(&pb.RegisterPk{
		Id:   "VIEWINIT1",
		Uuid: []byte("view-uuid-1"),
		Pk:   []byte("view-pk-bytes-32!!!!!!!!!!!!!!!"),
	}, "198.51.100.40:51000")
	if got := registerPkResult(resp); got != pb.RegisterPkResponse_OK {
		t.Fatalf("RegisterPk = %v, want OK", got)
	}
	entry := srv.peers.Get("VIEWINIT1")
	if entry == nil || entry.IP == "" {
		t.Fatalf("expected IP-bound peer entry, got %#v", entry)
	}

	phr := srv.handlePunchHoleRequestTCP(&pb.PunchHoleRequest{Id: "TGTVIEW1"}, udpAddr("198.51.100.40", 51000))
	if phr != nil {
		if failure := phr.GetPunchHoleResponse(); failure != nil && failure.Failure == pb.PunchHoleResponse_ID_NOT_EXIST {
			t.Fatal("viewer-only TCP RegisterPk initiator must not be refused as unauthorized")
		}
	}
}

func TestManagedPendingWithDBRowStillRejected(t *testing.T) {
	// #302 residual: peer somehow in DB while still pending_device_* must not punch.
	srv, database := newTestSignalServer(t, config.EnrollmentModeManaged)
	putOnlinePeer(srv, "TGTPEND4", "203.0.113.94", 52000, peer.ConnUDP)
	putOnlinePeer(srv, "PENDINIT4", "198.51.100.74", 51000, peer.ConnUDP)
	if err := database.UpsertPeer(&db.Peer{ID: "PENDINIT4", Status: "ONLINE", IP: "198.51.100.74"}); err != nil {
		t.Fatalf("UpsertPeer: %v", err)
	}
	if err := database.SetConfig("pending_device_PENDINIT4", `{"device_id":"PENDINIT4"}`); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}

	id, ok := srv.requireAuthorizedInitiator(udpAddr("198.51.100.74", 51000), "TGTPEND4", "")
	if ok {
		t.Fatalf("pending+DB initiator must be rejected, got id=%q", id)
	}
}

func TestClientTokenAuthorizesViewerOnlyPunch(t *testing.T) {
	srv, database := newTestSignalServer(t, config.EnrollmentModeOpen)
	putOnlinePeer(srv, "TGTOK1", "203.0.113.95", 52000, peer.ConnTCP)

	user := &db.User{Username: "tokuser", PasswordHash: "hash", Role: "admin"}
	if err := database.CreateUser(user); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	token := strings.Repeat("ab", 32) // 64 hex chars
	sum := sha256.Sum256([]byte(token))
	hash := hex.EncodeToString(sum[:])
	if err := database.CreateClientSession(&db.ClientSession{
		TokenHash:  hash,
		UserID:     user.ID,
		ClientID:   "TOKINIT1",
		ClientUUID: "tok-uuid",
		ExpiresAt:  time.Now().UTC().Add(24 * time.Hour).Format("2006-01-02 15:04:05"),
		CreatedAt:  time.Now().UTC().Format("2006-01-02 15:04:05"),
	}); err != nil {
		t.Fatalf("CreateClientSession: %v", err)
	}

	id, ok := srv.requireAuthorizedInitiator(udpAddr("198.51.100.75", 51000), "TGTOK1", token)
	if !ok || id != "TOKINIT1" {
		t.Fatalf("token auth = (%q, %v), want TOKINIT1", id, ok)
	}

	// Managed: token alone without approved DB peer must fail.
	srv.cfg.EnrollmentMode = config.EnrollmentModeManaged
	id, ok = srv.requireAuthorizedInitiator(udpAddr("198.51.100.75", 51000), "TGTOK1", token)
	if ok {
		t.Fatalf("managed token without DB peer must fail, got %q", id)
	}
}
