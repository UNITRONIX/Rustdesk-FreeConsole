package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/unitronix/betterdesk-server/audit"
	"github.com/unitronix/betterdesk-server/auth"
	"github.com/unitronix/betterdesk-server/guestaccess"
)

func (s *Server) guestAccessStore() *guestaccess.Store {
	return &guestaccess.Store{DB: s.db}
}

func (s *Server) isGuestAdmin(role string) bool {
	return role == auth.RoleAdmin || role == auth.RoleSuperAdmin || role == auth.RoleGlobalAdmin
}

// POST /api/guest/access-links
func (s *Server) handleGuestAccessCreate(w http.ResponseWriter, r *http.Request) {
	username := usernameFromRequest(r)
	var body struct {
		PeerIDs    []string `json:"peer_ids"`
		TTLMinutes int      `json:"ttl_minutes"`
		ViewOnly   bool     `json:"view_only"`
		Label      string   `json:"label"`
		MaxUses    int      `json:"max_uses"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	token, grant, err := s.guestAccessStore().Create(body.PeerIDs, username, body.TTLMinutes, body.ViewOnly, body.Label, body.MaxUses)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	entryPeer := grant.PeerIDs[0]
	path := "/remote/guest?t=" + token
	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionPeerUpdated, username, entryPeer, map[string]string{
			"event":       "guest_access_created",
			"grant_id":    grant.ID,
			"peer_count":  strconv.Itoa(len(grant.PeerIDs)),
			"ttl_minutes": strconv.Itoa(body.TTLMinutes),
			"view_only":   strconv.FormatBool(body.ViewOnly),
		})
	}
	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"id":           grant.ID,
		"token":        token,
		"path":         path,
		"peer_ids":     grant.PeerIDs,
		"view_only":    grant.ViewOnly,
		"expires_at":   grant.ExpiresAt.Format(time.RFC3339),
		"label":        grant.Label,
		"token_prefix": grant.TokenPrefix,
	})
}

// GET /api/guest/access-links/validate?token=&peer_id=
func (s *Server) handleGuestAccessValidate(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	peerID := strings.TrimSpace(r.URL.Query().Get("peer_id"))
	if token == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "token required"})
		return
	}
	grant, err := s.guestAccessStore().Validate(token, peerID)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{"valid": false, "error": err.Error()})
		return
	}
	pub := guestaccess.ToPublic(grant)
	writeJSON(w, http.StatusOK, pub)
}

// GET /api/guest/access-links
func (s *Server) handleGuestAccessList(w http.ResponseWriter, r *http.Request) {
	username := usernameFromRequest(r)
	role := getRoleFromCtx(r)
	grants, err := s.guestAccessStore().ListActive(username, s.isGuestAdmin(role))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	items := make([]map[string]interface{}, 0, len(grants))
	for _, g := range grants {
		items = append(items, map[string]interface{}{
			"id":           g.ID,
			"peer_ids":     g.PeerIDs,
			"view_only":    g.ViewOnly,
			"expires_at":   g.ExpiresAt.Format(time.RFC3339),
			"created_at":   g.CreatedAt.Format(time.RFC3339),
			"created_by":   g.CreatedBy,
			"label":        g.Label,
			"token_prefix": g.TokenPrefix,
			"use_count":    g.UseCount,
			"max_uses":     g.MaxUses,
		})
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"grants": items})
}

// DELETE /api/guest/access-links/{id}
func (s *Server) handleGuestAccessRevoke(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id required"})
		return
	}
	username := usernameFromRequest(r)
	role := getRoleFromCtx(r)
	ok, err := s.guestAccessStore().RevokeByID(id, username, s.isGuestAdmin(role))
	if err != nil {
		if err.Error() == "forbidden" {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionPeerUpdated, username, id, map[string]string{
			"event":    "guest_access_revoked",
			"grant_id": id,
		})
	}
	writeJSON(w, http.StatusOK, map[string]bool{"revoked": true})
}

// GET /api/guest/access-links/peers?token=  — safe device list for guest UI (ids + basic peer info)
func (s *Server) handleGuestAccessPeers(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(r.URL.Query().Get("token"))
	if token == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "token required"})
		return
	}
	grant, err := s.guestAccessStore().Validate(token, "")
	if err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		return
	}
	onlineTimeout := 90 * time.Second
	devices := make([]map[string]interface{}, 0, len(grant.PeerIDs))
	for _, id := range grant.PeerIDs {
		item := map[string]interface{}{
			"id":       id,
			"online":   false,
			"hostname": "",
			"os":       "",
		}
		if s.peers != nil {
			item["online"] = s.peers.IsOnline(id, onlineTimeout)
		}
		if peer, err := s.db.GetPeer(id); err == nil && peer != nil {
			item["hostname"] = peer.Hostname
			item["os"] = peer.OS
			item["display_name"] = peer.DisplayName
			item["device_type"] = peer.DeviceType
		}
		devices = append(devices, item)
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"valid":     true,
		"view_only": grant.ViewOnly,
		"expires_at": grant.ExpiresAt.Format(time.RFC3339),
		"label":     grant.Label,
		"devices":   devices,
	})
}
