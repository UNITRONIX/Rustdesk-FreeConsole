package signal

import (
	"bytes"
	"log"
	"net"
	"strings"

	"github.com/unitronix/betterdesk-server/db"
)

// resolveRegistrationPeerID maps a registration ID to the effective peer ID.
//
// When id was renamed via the panel/API, the same physical device may still
// heartbeat under the old ID until the RustDesk client adopts the new one.
// Redirect matching devices to the successor row instead of recreating the
// old ID (which desynchronizes the panel and Go backend).
//
// Returns ("", false) when registration must be rejected (impostor on old ID).
func (s *Server) resolveRegistrationPeerID(id, clientHost string, uuid, pk []byte) (string, bool) {
	renamed, err := s.db.IsRenamedPeerID(id)
	if err != nil {
		log.Printf("[signal] IsRenamedPeerID(%s): %v", id, err)
		return "", false
	}
	if !renamed {
		return id, true
	}

	newID, err := s.db.GetLatestRenameTarget(id)
	if err != nil {
		log.Printf("[signal] GetLatestRenameTarget(%s): %v", id, err)
		return "", false
	}
	if newID == "" {
		return "", false
	}

	successor, err := s.db.GetPeer(newID)
	if err != nil {
		log.Printf("[signal] GetPeer(%s) for rename successor: %v", newID, err)
		return "", false
	}
	if successor == nil {
		// Successor removed — old ID is free to reuse.
		return id, true
	}

	if renamedPeerIdentityMatches(successor, clientHost, uuid, pk) {
		if newID != id {
			log.Printf("[signal] Redirect registration %s -> %s (panel rename)", id, newID)
		}
		return newID, true
	}

	log.Printf("[signal] Rejected registration for renamed peer ID: %s (successor %s)", id, newID)
	return "", false
}

// rejectRenamedPeerRegistration is kept for call sites that only need a boolean.
func (s *Server) rejectRenamedPeerRegistration(id, clientHost string, uuid, pk []byte) bool {
	_, ok := s.resolveRegistrationPeerID(id, clientHost, uuid, pk)
	return !ok
}

func renamedPeerIdentityMatches(successor *db.Peer, clientHost string, uuid, pk []byte) bool {
	if len(pk) > 0 && len(successor.PK) > 0 && bytes.Equal(successor.PK, pk) {
		return true
	}
	if len(uuid) > 0 && successor.UUID != "" && peerUUIDEqual(peerUUIDFromDB(successor.UUID), uuid) {
		return true
	}
	if len(pk) == 0 && len(uuid) == 0 && clientHost != "" && peerIPMatches(clientHost, successor.IP) {
		return true
	}
	return false
}

func peerIPMatches(clientHost, storedIP string) bool {
	if clientHost == "" || storedIP == "" {
		return false
	}
	storedHost := storedIP
	if h, _, err := net.SplitHostPort(storedIP); err == nil && h != "" {
		storedHost = h
	}
	return clientHost == storedHost || strings.HasPrefix(storedIP, clientHost+":")
}
