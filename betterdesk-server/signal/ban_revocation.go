package signal

import (
	"log"

	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/relay"
)

// revokeBannedPeerAccess removes the access state that this package can revoke
// after observing a persisted ban. API/admin ban handlers live outside signal,
// so this defensive cleanup runs on the next registration or outbound attempt.
func (s *Server) revokeBannedPeerAccess(peerID string, session *db.ClientSession) {
	if peerID == "" {
		return
	}

	relay.RevokeRelayPairsForPeer(peerID)
	if s.peers != nil {
		s.peers.Remove(peerID)
	}
	if s.db == nil {
		return
	}

	if session == nil {
		dbPeer, err := s.db.GetPeer(peerID)
		if err != nil || dbPeer == nil {
			return
		}
		session, err = s.db.GetActiveClientSessionByClient(peerID, dbPeer.UUID)
		if err != nil {
			log.Printf("[signal] Failed to locate active client session for banned peer %s: %v", peerID, err)
			return
		}
	}
	if session == nil {
		return
	}
	if err := s.db.RevokeClientSessionsForDevice(session.UserID, session.ClientID, session.ClientUUID); err != nil {
		log.Printf("[signal] Failed to revoke client sessions for banned peer %s: %v", peerID, err)
	}
}
