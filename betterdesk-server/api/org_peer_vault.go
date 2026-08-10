package api

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"github.com/unitronix/betterdesk-server/audit"
	"github.com/unitronix/betterdesk-server/db"
)

const maxOrgPeerPasswordLen = 128

// GET /api/org/{id}/peer-credentials — list password_set flags only (no secrets).
func (s *Server) handleListOrgPeerCredentials(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")
	flags, err := s.db.ListOrgPeerCredentialFlags(orgID)
	if err != nil {
		log.Printf("[org] ListOrgPeerCredentialFlags error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	if flags == nil {
		flags = []*db.OrgPeerCredential{}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"credentials": flags})
}

// PUT /api/org/{id}/peer-credentials/{peerId} — set encrypted preset password.
func (s *Server) handleSetOrgPeerCredential(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")
	peerID := strings.TrimSpace(r.PathValue("peerId"))
	username := getUsernameFromCtx(r)

	if !peerIDRegexp.MatchString(peerID) {
		http.Error(w, `{"error":"invalid peer id"}`, http.StatusBadRequest)
		return
	}
	if s.peerVault == nil {
		http.Error(w, `{"error":"peer credential vault not configured"}`, http.StatusServiceUnavailable)
		return
	}

	var body struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}
	password := strings.TrimSpace(body.Password)
	if password == "" {
		http.Error(w, `{"error":"password required"}`, http.StatusBadRequest)
		return
	}
	if len(password) > maxOrgPeerPasswordLen {
		http.Error(w, `{"error":"password too long"}`, http.StatusBadRequest)
		return
	}

	nonce, ciphertext, keyID, err := s.peerVault.Seal(password)
	if err != nil {
		log.Printf("[org] peer vault seal error: %v", err)
		http.Error(w, `{"error":"failed to encrypt password"}`, http.StatusInternalServerError)
		return
	}
	row := &db.OrgPeerCredential{
		OrgID:      orgID,
		PeerID:     peerID,
		Ciphertext: ciphertext,
		Nonce:      nonce,
		KeyID:      keyID,
		UpdatedBy:  username,
	}
	if err := s.db.SaveOrgPeerCredential(row); err != nil {
		log.Printf("[org] SaveOrgPeerCredential error: %v", err)
		http.Error(w, `{"error":"failed to save credential"}`, http.StatusInternalServerError)
		return
	}
	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionOrgPeerCredentialSet, s.remoteIP(r), peerID, map[string]string{
			"org_id": orgID,
			"actor":  username,
			"key_id": keyID,
			"action": "set",
		})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "password_set": true})
}

// DELETE /api/org/{id}/peer-credentials/{peerId}
func (s *Server) handleClearOrgPeerCredential(w http.ResponseWriter, r *http.Request) {
	orgID := r.PathValue("id")
	peerID := strings.TrimSpace(r.PathValue("peerId"))
	username := getUsernameFromCtx(r)
	if !peerIDRegexp.MatchString(peerID) {
		http.Error(w, `{"error":"invalid peer id"}`, http.StatusBadRequest)
		return
	}
	if err := s.db.DeleteOrgPeerCredential(orgID, peerID); err != nil {
		log.Printf("[org] DeleteOrgPeerCredential error: %v", err)
		http.Error(w, `{"error":"failed to clear credential"}`, http.StatusInternalServerError)
		return
	}
	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionOrgPeerCredentialClear, s.remoteIP(r), peerID, map[string]string{
			"org_id": orgID,
			"actor":  username,
			"action": "clear",
		})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// GET /api/peers/{id}/connect-password — decrypt once for authorized Web Remote operators.
func (s *Server) handleGetPeerConnectPassword(w http.ResponseWriter, r *http.Request) {
	peerID := strings.TrimSpace(r.PathValue("id"))
	username := getUsernameFromCtx(r)
	role := getRoleFromCtx(r)
	if !peerIDRegexp.MatchString(peerID) {
		http.Error(w, `{"error":"invalid peer id"}`, http.StatusBadRequest)
		return
	}
	if s.peerVault == nil {
		http.Error(w, `{"error":"peer credential vault not configured"}`, http.StatusServiceUnavailable)
		return
	}

	orgID, err := s.db.GetDeviceOrgID(peerID)
	if err != nil {
		log.Printf("[org] GetDeviceOrgID error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	if orgID == "" {
		writeJSON(w, http.StatusNotFound, map[string]any{"password_set": false})
		return
	}

	// Membership: user must belong to the device's org (or be server admin).
	if !authIsServerAdmin(role) {
		allowed := false
		for _, id := range s.resolveUserOrgIDsForAB(r) {
			if id == orgID {
				allowed = true
				break
			}
		}
		if !allowed {
			http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
			return
		}
	}

	row, err := s.db.GetOrgPeerCredential(orgID, peerID)
	if err != nil {
		log.Printf("[org] GetOrgPeerCredential error: %v", err)
		http.Error(w, `{"error":"internal"}`, http.StatusInternalServerError)
		return
	}
	if row == nil || row.Ciphertext == "" {
		writeJSON(w, http.StatusNotFound, map[string]any{"password_set": false})
		return
	}
	plain, err := s.peerVault.Open(row.Nonce, row.Ciphertext, row.KeyID)
	if err != nil {
		log.Printf("[org] peer vault open error: %v", err)
		http.Error(w, `{"error":"failed to decrypt credential"}`, http.StatusInternalServerError)
		return
	}
	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionOrgPeerCredentialFetch, s.remoteIP(r), peerID, map[string]string{
			"org_id": orgID,
			"actor":  username,
			"action": "fetch",
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"password_set": true,
		"password":     plain,
		"org_id":       orgID,
	})
}

func authIsServerAdmin(role string) bool {
	r := strings.ToLower(strings.TrimSpace(role))
	return r == "admin" || r == "server_admin"
}
