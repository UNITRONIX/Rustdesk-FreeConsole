package api

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/sessiongrant"
)

const (
	supportGrantDefaultTTL = 5 * time.Minute
	supportGrantMaxTTL     = 10 * time.Minute
)

type supportSessionGrantRequest struct {
	SessionID    string   `json:"session_id"`
	Transport    string   `json:"transport"`
	Capabilities []string `json:"capabilities"`
	TTLSeconds   int      `json:"ttl_seconds,omitempty"`
}

type supportSessionGrantResponse struct {
	Grant     string `json:"grant"`
	ExpiresAt string `json:"expires_at"`
	PublicKey string `json:"public_key"`
}

// handleIssueSupportSessionGrant mints a short-lived, operator-bound grant for
// an inbound Support Agent session. Device credentials can never call this
// endpoint: the route requires an authenticated operator role.
func (s *Server) handleIssueSupportSessionGrant(w http.ResponseWriter, r *http.Request) {
	deviceID := strings.TrimSpace(r.PathValue("id"))
	if deviceID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "peer ID required"})
		return
	}
	if !s.peerOrgScopeCheck(w, r, deviceID) {
		return
	}
	if s.keyPair == nil || len(s.keyPair.PrivateKey) == 0 {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "session grant signer unavailable"})
		return
	}
	peerInfo, err := s.db.GetPeer(deviceID)
	if err != nil || peerInfo == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "peer not found"})
		return
	}
	if !isPassiveSupportPeer(peerInfo) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "peer is not a passive support agent"})
		return
	}
	if peerInfo.Disabled || peerInfo.SoftDeleted {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "peer is unavailable"})
		return
	}
	if banned, _ := s.db.IsPeerBanned(deviceID); banned {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "peer is banned"})
		return
	}

	var body supportSessionGrantRequest
	r.Body = http.MaxBytesReader(w, r.Body, 32<<10)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid session grant request"})
		return
	}
	body.SessionID = strings.TrimSpace(body.SessionID)
	body.Transport = strings.ToLower(strings.TrimSpace(body.Transport))
	operatorID := strings.TrimSpace(getUsernameFromCtx(r))
	if operatorID == "" || len(body.SessionID) > 128 || !validSupportTransport(body.Transport) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid session grant binding"})
		return
	}
	capabilities, ok := normalizeSupportGrantCapabilities(body.Capabilities)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid or empty capability set"})
		return
	}
	ttl := supportGrantDefaultTTL
	if body.TTLSeconds < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid grant lifetime"})
		return
	}
	if body.TTLSeconds > 0 {
		ttl = time.Duration(body.TTLSeconds) * time.Second
	}
	if ttl <= 0 || ttl > supportGrantMaxTTL {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid grant lifetime"})
		return
	}

	signer, err := sessiongrant.NewSigner(s.keyPair.PrivateKey)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "session grant signer unavailable"})
		return
	}
	now := time.Now().UTC()
	nonce, err := newSessionGrantNonce()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not create session grant"})
		return
	}
	grant, err := signer.Issue(sessiongrant.Claims{
		DeviceID:     deviceID,
		OperatorID:   operatorID,
		SessionID:    body.SessionID,
		Transport:    body.Transport,
		Initiator:    "operator",
		Capabilities: capabilities,
		IssuedAt:     now.Unix(),
		ExpiresAt:    now.Add(ttl).Unix(),
		Nonce:        nonce,
	})
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "could not issue session grant"})
		return
	}
	if s.auditLog != nil {
		s.auditLog.Log("support_session_grant_issued", s.remoteIP(r), deviceID, map[string]string{
			"operator":   operatorID,
			"transport":  body.Transport,
			"session_id": body.SessionID,
		})
	}
	writeJSON(w, http.StatusOK, supportSessionGrantResponse{
		Grant:     grant,
		ExpiresAt: now.Add(ttl).Format(time.RFC3339),
		PublicKey: s.keyPair.PublicKeyBase64(),
	})
}

func validSupportTransport(transport string) bool {
	switch transport {
	case "cdap", "relay", "interop":
		return true
	default:
		return false
	}
}

func normalizeSupportGrantCapabilities(input []string) ([]string, bool) {
	allowed := map[string]struct{}{
		"screen_view":   {},
		"input":         {},
		"system_audio":  {},
		"clipboard":     {},
		"files":         {},
		"terminal":      {},
		"chat":          {},
		"multi_monitor": {},
		"privacy_mode":  {},
		"block_input":   {},
		"restart":       {},
		"recording":     {},
	}
	seen := make(map[string]struct{}, len(input))
	out := make([]string, 0, len(input))
	for _, capability := range input {
		capability = strings.ToLower(strings.TrimSpace(capability))
		if _, exists := allowed[capability]; !exists {
			return nil, false
		}
		if _, duplicate := seen[capability]; duplicate {
			continue
		}
		seen[capability] = struct{}{}
		out = append(out, capability)
	}
	return out, len(out) > 0
}

func isPassiveSupportPeer(peerInfo *db.Peer) bool {
	if peerInfo == nil {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(peerInfo.DeviceType)) {
	case "os_agent", "support-agent", "support_agent":
		return true
	}
	for _, tag := range strings.FieldsFunc(strings.ToLower(peerInfo.Tags), func(r rune) bool {
		return r == ',' || r == ';' || r == '|' || r == ' ' || r == '\t' || r == '\n'
	}) {
		if tag == "support-agent" || tag == "support_agent" {
			return true
		}
	}
	return false
}

func newSessionGrantNonce() (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("session grant nonce: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}
