package signal

import (
	"bytes"
	"log"
	"net"
	"strings"
)

// rejectRenamedPeerRegistration returns true when a peer must be blocked from
// registering under id because it was renamed and the caller is not the owner.
//
// RustDesk 1.4.x clients may keep using the old ID after a panel-initiated
// rename; allow the same device (matching PK/UUID or IP) to continue until it
// adopts the new ID (#213).
func (s *Server) rejectRenamedPeerRegistration(id, clientHost string, uuid, pk []byte) bool {
	renamed, err := s.db.IsRenamedPeerID(id)
	if err != nil {
		log.Printf("[signal] IsRenamedPeerID(%s): %v", id, err)
		return true
	}
	if !renamed {
		return false
	}

	newID, err := s.db.GetLatestRenameTarget(id)
	if err != nil {
		log.Printf("[signal] GetLatestRenameTarget(%s): %v", id, err)
		return true
	}
	if newID == "" {
		return true
	}

	successor, err := s.db.GetPeer(newID)
	if err != nil {
		log.Printf("[signal] GetPeer(%s) for rename successor: %v", newID, err)
		return true
	}
	if successor == nil {
		// Successor removed — old ID is free to reuse.
		return false
	}

	if len(pk) > 0 && len(successor.PK) > 0 && bytes.Equal(successor.PK, pk) {
		return false
	}
	if len(uuid) > 0 && successor.UUID != "" && peerUUIDEqual(peerUUIDFromDB(successor.UUID), uuid) {
		return false
	}
	if len(pk) == 0 && len(uuid) == 0 && clientHost != "" && peerIPMatches(clientHost, successor.IP) {
		return false
	}

	log.Printf("[signal] Rejected registration for renamed peer ID: %s (successor %s)", id, newID)
	return true
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
