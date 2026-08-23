package signal

import (
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

	srv.storePendingUUID(target, initiatorA, "corr-session-a")
	srv.storePendingUUID(target, initiatorB, "corr-session-b")

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

	srv.storePendingUUID("CORRTARGET3", initiatorA, "corr-empty-session-a")
	srv.storePendingUUID("CORRTARGET3", initiatorB, "corr-empty-session-b")
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
