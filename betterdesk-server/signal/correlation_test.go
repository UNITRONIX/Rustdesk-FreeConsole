package signal

import (
	"net"
	"testing"
	"time"

	"github.com/unitronix/betterdesk-server/config"
	cryptopkg "github.com/unitronix/betterdesk-server/crypto"
	"github.com/unitronix/betterdesk-server/peer"
	pb "github.com/unitronix/betterdesk-server/proto"
	"github.com/unitronix/betterdesk-server/relay"
)

func TestPendingRelayUUIDIsolatedByInitiatorEndpoint(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	target := "CORRTARGET1"
	initiatorA := udpAddr("198.51.100.201", 51001)
	initiatorB := udpAddr("198.51.100.201", 51002)

	srv.storePendingUUID(target, initiatorA, "corr-session-a", "CORRINITA")
	srv.storePendingUUID(target, initiatorB, "corr-session-b", "CORRINITB")

	if got := srv.getPendingUUID(target, initiatorA); got != "corr-session-a" {
		t.Fatalf("pending UUID A = %q, want corr-session-a", got)
	}
	if got := srv.getPendingUUID(target, initiatorB); got != "corr-session-b" {
		t.Fatalf("pending UUID B = %q, want corr-session-b", got)
	}
}

func TestRelayResponseRejectsUnexpectedTargetSource(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	targetAddr := udpAddr("203.0.113.201", 52001)
	initiatorAddr := udpAddr("198.51.100.201", 51001)
	srv.peers.Put(&peer.Entry{
		ID:         "CORRTARGET2",
		UDPAddr:    targetAddr,
		ConnType:   peer.ConnTCP,
		LastReg:    time.Now(),
		StatusTier: peer.StatusOnline,
	})
	srv.peers.Put(&peer.Entry{
		ID:         "CORRINIT2",
		UDPAddr:    initiatorAddr,
		ConnType:   peer.ConnTCP,
		LastReg:    time.Now(),
		StatusTier: peer.StatusOnline,
	})

	const relayUUID = "corr-unexpected-source-uuid"
	srv.handleRelayResponseForward(&pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RelayResponse{
			RelayResponse: &pb.RelayResponse{
				SocketAddr: cryptopkg.EncodeAddr(initiatorAddr),
				Uuid:       relayUUID,
				Union:      &pb.RelayResponse_Id{Id: "CORRTARGET2"},
			},
		},
	}, udpAddr("203.0.113.202", 52002))

	if relay.ClaimRelayPair(relayUUID) {
		t.Fatal("unexpected target source must not mint a relay ticket")
	}
}

func TestEmptyRelayResponseUUIDUsesMatchingInitiatorSession(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	targetAddr := udpAddr("203.0.113.203", 52003)
	initiatorA := udpAddr("198.51.100.203", 51003)
	initiatorB := udpAddr("198.51.100.203", 51004)
	srv.peers.Put(&peer.Entry{
		ID:         "CORRTARGET3",
		UDPAddr:    targetAddr,
		ConnType:   peer.ConnTCP,
		LastReg:    time.Now(),
		StatusTier: peer.StatusOnline,
	})
	srv.peers.Put(&peer.Entry{
		ID:         "CORRINIT3A",
		UDPAddr:    initiatorA,
		ConnType:   peer.ConnTCP,
		LastReg:    time.Now(),
		StatusTier: peer.StatusOnline,
	})
	srv.peers.Put(&peer.Entry{
		ID:         "CORRINIT3B",
		UDPAddr:    initiatorB,
		ConnType:   peer.ConnTCP,
		LastReg:    time.Now(),
		StatusTier: peer.StatusOnline,
	})

	srv.storePendingUUID("CORRTARGET3", initiatorA, "corr-empty-session-a", "CORRINIT3A")
	srv.storePendingUUID("CORRTARGET3", initiatorB, "corr-empty-session-b", "CORRINIT3B")
	srv.handleRelayResponseForward(&pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RelayResponse{
			RelayResponse: &pb.RelayResponse{
				SocketAddr: cryptopkg.EncodeAddr(initiatorB),
				Union:      &pb.RelayResponse_Id{Id: "CORRTARGET3"},
			},
		},
	}, targetAddr)

	if !relay.ClaimRelayPair("corr-empty-session-b") {
		t.Fatal("matching initiator session should be authorized")
	}
	if relay.ClaimRelayPair("corr-empty-session-a") {
		t.Fatal("parallel initiator session must not be authorized by response B")
	}
}

func TestRelayResponseForwardUsesPendingInitiatorOnSharedNAT(t *testing.T) {
	// #399: multi-peer shared NAT must resolve initiator from pending store,
	// not CountByIP / FindByIP.
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	sharedIP := "203.0.113.88"
	initiatorAddr := udpAddr(sharedIP, 50783)
	otherAddr := udpAddr(sharedIP, 64215)
	targetAddr := udpAddr("198.51.100.88", 58002)
	putOnlinePeer(srv, "OFFICE_INIT", sharedIP, initiatorAddr.Port, peer.ConnUDP)
	putOnlinePeer(srv, "OFFICE_OTHER", sharedIP, otherAddr.Port, peer.ConnUDP)
	putOnlinePeer(srv, "EXT_TARGET", targetAddr.IP.String(), targetAddr.Port, peer.ConnUDP)

	client, server := net.Pipe()
	t.Cleanup(func() { client.Close(); server.Close() })
	go func() {
		buf := make([]byte, 64*1024)
		for {
			if _, err := client.Read(buf); err != nil {
				return
			}
		}
	}()
	srv.tcpPunchConns.Store(normalizeAddrKey(initiatorAddr.String()), &tcpPunchConn{
		conn:      server,
		createdAt: time.Now(),
		peerID:    "OFFICE_INIT",
	})

	const relayUUID = "399-pending-shared-nat-uuid"
	srv.storePendingUUID("EXT_TARGET", initiatorAddr, relayUUID, "OFFICE_INIT")

	srv.handleRelayResponseForward(&pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RelayResponse{
			RelayResponse: &pb.RelayResponse{
				SocketAddr: cryptopkg.EncodeAddr(initiatorAddr),
				Uuid:       relayUUID,
				Union:      &pb.RelayResponse_Id{Id: "EXT_TARGET"},
			},
		},
	}, targetAddr)

	if !relay.AuthorizeRelayPair(relayUUID, "OFFICE_INIT", "EXT_TARGET") {
		t.Fatal("pending initiator must mint ticket for OFFICE_INIT, not OFFICE_OTHER")
	}
	if relay.AuthorizeRelayPair(relayUUID, "OFFICE_OTHER", "EXT_TARGET") {
		t.Fatal("must not rebind ticket to wrong same-NAT peer")
	}
}

func TestRelayResponseForwardHonorsPanelProxyCIDR(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	initiatorAddr := udpAddr("127.0.0.1", 51757)
	targetAddr := udpAddr("198.51.100.99", 58002)
	putOnlinePeer(srv, "TGTPANEL399", targetAddr.IP.String(), targetAddr.Port, peer.ConnTCP)

	client, server := net.Pipe()
	t.Cleanup(func() { client.Close(); server.Close() })
	go func() {
		buf := make([]byte, 64*1024)
		for {
			if _, err := client.Read(buf); err != nil {
				return
			}
		}
	}()
	srv.tcpPunchConns.Store(normalizeAddrKey(initiatorAddr.String()), &tcpPunchConn{
		conn:      server,
		createdAt: time.Now(),
	})

	const relayUUID = "399-panel-proxy-forward-uuid"
	srv.handleRelayResponseForward(&pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RelayResponse{
			RelayResponse: &pb.RelayResponse{
				SocketAddr: cryptopkg.EncodeAddr(initiatorAddr),
				Uuid:       relayUUID,
				Union:      &pb.RelayResponse_Id{Id: "TGTPANEL399"},
			},
		},
	}, targetAddr)

	if !relay.AuthorizeRelayPair(relayUUID, panelWebRemoteInitiatorID, "TGTPANEL399") {
		t.Fatal("panel proxy initiator must be authorized on RelayResponse forward")
	}
}

func TestRelayResponseForwardSharedNATFlag(t *testing.T) {
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	srv.cfg.AllowSharedNATInitiator = true
	sharedIP := "203.0.113.77"
	initiatorAddr := udpAddr(sharedIP, 51757)
	putOnlinePeer(srv, "SITE_A1", sharedIP, 40001, peer.ConnUDP)
	putOnlinePeer(srv, "SITE_A2", sharedIP, 40002, peer.ConnUDP)
	targetAddr := udpAddr("198.51.100.77", 45918)
	putOnlinePeer(srv, "EXT77", targetAddr.IP.String(), targetAddr.Port, peer.ConnUDP)

	client, server := net.Pipe()
	t.Cleanup(func() { client.Close(); server.Close() })
	go func() {
		buf := make([]byte, 64*1024)
		for {
			if _, err := client.Read(buf); err != nil {
				return
			}
		}
	}()
	srv.tcpPunchConns.Store(normalizeAddrKey(initiatorAddr.String()), &tcpPunchConn{
		conn:      server,
		createdAt: time.Now(),
	})

	const relayUUID = "399-shared-nat-flag-uuid"
	srv.handleRelayResponseForward(&pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RelayResponse{
			RelayResponse: &pb.RelayResponse{
				SocketAddr: cryptopkg.EncodeAddr(initiatorAddr),
				Uuid:       relayUUID,
				Union:      &pb.RelayResponse_Id{Id: "EXT77"},
			},
		},
	}, targetAddr)

	if !relay.AuthorizeRelayPair(relayUUID, sharedNATInitiatorID, "EXT77") {
		t.Fatal("ALLOW_SHARED_NAT_INITIATOR must authorize synthetic initiator on forward")
	}
}

func TestRelayResponseRefusesFindByIPMisdelivery(t *testing.T) {
	// Without pending / exact punch conn, multi-peer FindByIP must not mint a
	// ticket for an arbitrary same-IP peer.
	srv, _ := newTestSignalServer(t, config.EnrollmentModeOpen)
	sharedIP := "203.0.113.66"
	initiatorAddr := udpAddr(sharedIP, 50783)
	putOnlinePeer(srv, "WRONG66", sharedIP, 64215, peer.ConnUDP)
	putOnlinePeer(srv, "RIGHT66", sharedIP, 40001, peer.ConnUDP)
	targetAddr := udpAddr("198.51.100.66", 58002)
	putOnlinePeer(srv, "EXT66", targetAddr.IP.String(), targetAddr.Port, peer.ConnUDP)

	const relayUUID = "399-no-misdelivery-uuid"
	srv.handleRelayResponseForward(&pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RelayResponse{
			RelayResponse: &pb.RelayResponse{
				SocketAddr: cryptopkg.EncodeAddr(initiatorAddr),
				Uuid:       relayUUID,
				Union:      &pb.RelayResponse_Id{Id: "EXT66"},
			},
		},
	}, targetAddr)

	if relay.ClaimRelayPair(relayUUID) {
		t.Fatal("ambiguous shared-NAT initiator without pending/flag must not mint a ticket")
	}
}
