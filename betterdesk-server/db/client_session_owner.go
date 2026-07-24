package db

import (
	"log"
	"strings"
)

// BindPeerOwner sets peers.user for the peer identified by clientID or clientUUID.
// No-op when the peer row does not exist yet (caller may retry after registration).
func BindPeerOwner(database Database, clientID, clientUUID, username string) {
	if database == nil {
		return
	}
	username = strings.TrimSpace(username)
	clientID = strings.TrimSpace(clientID)
	clientUUID = strings.TrimSpace(clientUUID)
	if username == "" || (clientID == "" && clientUUID == "") {
		return
	}

	peer, err := resolvePeerForClient(database, clientID, clientUUID)
	if err != nil || peer == nil {
		return
	}
	if peer.User == username {
		return
	}
	if err := database.UpdatePeerFields(peer.ID, map[string]string{"user": username}); err != nil {
		log.Printf("[db] bind peer owner %s → %s: %v", peer.ID, username, err)
	}
}

// ApplyActiveSessionOwner sets peers.user from the newest active client_session
// for this device. Used when the peer appears after login (register / heartbeat).
// Does not clear peers.user when no session is active (keeps last known owner for audit).
func ApplyActiveSessionOwner(database Database, peerID, peerUUID string) {
	if database == nil {
		return
	}
	peerID = strings.TrimSpace(peerID)
	peerUUID = strings.TrimSpace(peerUUID)
	if peerID == "" && peerUUID == "" {
		return
	}

	sess, err := database.GetActiveClientSessionByClient(peerID, peerUUID)
	if err != nil || sess == nil {
		return
	}
	user, err := database.GetUserByID(sess.UserID)
	if err != nil || user == nil || strings.TrimSpace(user.Username) == "" {
		return
	}
	BindPeerOwner(database, peerID, peerUUID, user.Username)
}

func resolvePeerForClient(database Database, clientID, clientUUID string) (*Peer, error) {
	if clientID != "" {
		peer, err := database.GetPeer(clientID)
		if err != nil {
			return nil, err
		}
		if peer != nil {
			return peer, nil
		}
	}
	if clientUUID != "" {
		return database.GetPeerByUUID(clientUUID)
	}
	return nil, nil
}
