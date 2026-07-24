package meshcentral

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/unitronix/betterdesk-server/audit"
)

// MeshShareGrant is a time-limited guest desktop link for a mesh agent peer.
type MeshShareGrant struct {
	PeerID    string    `json:"peer_id"`
	CreatedBy string    `json:"created_by"`
	ExpiresAt time.Time `json:"expires_at"`
	ViewOnly  bool      `json:"view_only"`
}

const meshShareConfigPrefix = "mesh_share_"

// CreateShareGrant issues a guest link token for mesh KVM (view-only optional).
func (g *Gateway) CreateShareGrant(peerID, userID string, ttlMinutes int, viewOnly bool) (string, error) {
	if ttlMinutes <= 0 {
		ttlMinutes = 60
	}
	if ttlMinutes > 24*60 {
		ttlMinutes = 24 * 60
	}
	if !g.IsConnected(peerID) {
		return "", fmt.Errorf("mesh agent not connected")
	}
	token, err := newShareToken()
	if err != nil {
		return "", err
	}
	grant := MeshShareGrant{
		PeerID:    peerID,
		CreatedBy: userID,
		ExpiresAt: time.Now().Add(time.Duration(ttlMinutes) * time.Minute),
		ViewOnly:  viewOnly,
	}
	b, err := json.Marshal(grant)
	if err != nil {
		return "", err
	}
	if err := g.db.SetConfig(meshShareConfigPrefix+token, string(b)); err != nil {
		return "", err
	}
	if g.auditLog != nil {
		g.auditLog.Log(audit.ActionPeerUpdated, userID, peerID, map[string]string{
			"event": "mesh_share_created",
			"ttl":   fmt.Sprintf("%d", ttlMinutes),
		})
	}
	return token, nil
}

// ValidateShareGrant returns grant metadata when token is valid for peerID.
func (g *Gateway) ValidateShareGrant(token, peerID string) (*MeshShareGrant, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, fmt.Errorf("missing share token")
	}
	raw, err := g.db.GetConfig(meshShareConfigPrefix + token)
	if err != nil || raw == "" {
		return nil, fmt.Errorf("invalid or expired share link")
	}
	var grant MeshShareGrant
	if err := json.Unmarshal([]byte(raw), &grant); err != nil {
		return nil, fmt.Errorf("invalid share grant")
	}
	if grant.PeerID != peerID {
		return nil, fmt.Errorf("share link does not match device")
	}
	if time.Now().After(grant.ExpiresAt) {
		g.db.SetConfig(meshShareConfigPrefix+token, "")
		return nil, fmt.Errorf("share link expired")
	}
	return &grant, nil
}

func newShareToken() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
