package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/unitronix/betterdesk-server/db"
)

// generateSecureToken creates a cryptographically secure random token.
func generateSecureToken(length int) (string, error) {
	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes)[:length], nil
}

// hashToken creates a SHA256 hash of a token for storage.
func hashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

// DeviceTokenRequest is the JSON body for creating a device token.
type DeviceTokenRequest struct {
	Name      string `json:"name"`
	MaxUses   int    `json:"max_uses"`   // 0 = unlimited, 1 = single-use (default)
	ExpiresIn int    `json:"expires_in"` // Seconds until expiration (0 = no expiration)
	Note      string `json:"note"`
}

// DeviceTokenResponse is the JSON response for a device token.
// Note: The plain token is only returned once upon creation.
type DeviceTokenResponse struct {
	ID          int64      `json:"id"`
	Token       string     `json:"token,omitempty"` // Plain token (only on create)
	TokenPrefix string     `json:"token_prefix"`    // First 8 chars for display
	Name        string     `json:"name"`
	PeerID      string     `json:"peer_id,omitempty"`
	Status      string     `json:"status"`
	MaxUses     int        `json:"max_uses"`
	UseCount    int        `json:"use_count"`
	CreatedAt   time.Time  `json:"created_at"`
	ExpiresAt   *time.Time `json:"expires_at,omitempty"`
	RevokedAt   *time.Time `json:"revoked_at,omitempty"`
	LastUsedAt  *time.Time `json:"last_used_at,omitempty"`
	CreatedBy   string     `json:"created_by,omitempty"`
	Note        string     `json:"note,omitempty"`
}

// toResponse converts a db.DeviceToken to a DeviceTokenResponse.
func toDeviceTokenResponse(t *db.DeviceToken, includePlainToken bool) *DeviceTokenResponse {
	resp := &DeviceTokenResponse{
		ID:          t.ID,
		TokenPrefix: t.Token, // Token field stores prefix after retrieval
		Name:        t.Name,
		PeerID:      t.PeerID,
		Status:      t.Status,
		MaxUses:     t.MaxUses,
		UseCount:    t.UseCount,
		CreatedAt:   t.CreatedAt,
		ExpiresAt:   t.ExpiresAt,
		RevokedAt:   t.RevokedAt,
		LastUsedAt:  t.LastUsedAt,
		CreatedBy:   t.CreatedBy,
		Note:        t.Note,
	}
	if includePlainToken {
		resp.Token = t.Token
	}
	return resp
}

// handleListDeviceTokens returns all device tokens.
// GET /api/tokens
func (s *Server) handleListDeviceTokens(w http.ResponseWriter, r *http.Request) {
	includeRevoked := r.URL.Query().Get("include_revoked") == "true"

	tokens, err := s.db.ListDeviceTokens(includeRevoked)
	if err != nil {
		log.Printf("[API] ListDeviceTokens: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	var resp []*DeviceTokenResponse
	for _, t := range tokens {
		resp = append(resp, toDeviceTokenResponse(t, false))
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"tokens": resp,
		"count":  len(resp),
	})
}

// handleCreateDeviceToken creates a new device enrollment token.
// POST /api/tokens
func (s *Server) handleCreateDeviceToken(w http.ResponseWriter, r *http.Request) {
	var req DeviceTokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// MaxUses: 0 = unlimited (bundle enrollment tokens). Ad-hoc admin tokens
	// should pass max_uses explicitly (typically 1 for single-use invites).

	// Generate secure token (32 chars)
	plainToken, err := generateSecureToken(32)
	if err != nil {
		http.Error(w, "Failed to generate token", http.StatusInternalServerError)
		return
	}

	// Calculate expiration
	var expiresAt *time.Time
	if req.ExpiresIn > 0 {
		exp := time.Now().Add(time.Duration(req.ExpiresIn) * time.Second)
		expiresAt = &exp
	}

	// Get creator from context
	creator := ""
	if user, ok := r.Context().Value(ctxKeyUser).(*db.User); ok && user != nil {
		creator = user.Username
	}

	token := &db.DeviceToken{
		Token:     plainToken,
		TokenHash: hashToken(plainToken),
		Name:      req.Name,
		Status:    db.TokenStatusPending,
		MaxUses:   req.MaxUses,
		UseCount:  0,
		ExpiresAt: expiresAt,
		CreatedBy: creator,
		Note:      req.Note,
	}

	if err := s.db.CreateDeviceToken(token); err != nil {
		log.Printf("[API] CreateDeviceToken: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	// Return with plain token (only time it's visible)
	resp := toDeviceTokenResponse(token, true)
	resp.Token = plainToken // Ensure plain token is returned

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(resp)
}

// handleGetDeviceToken returns a single device token by ID.
// GET /api/tokens/{id}
func (s *Server) handleGetDeviceToken(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid token ID", http.StatusBadRequest)
		return
	}

	token, err := s.db.GetDeviceToken(id)
	if err != nil {
		log.Printf("[API] GetDeviceToken %d: %v", id, err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	if token == nil {
		http.Error(w, "Token not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(toDeviceTokenResponse(token, false))
}

// handleUpdateDeviceToken updates a device token.
// PUT /api/tokens/{id}
func (s *Server) handleUpdateDeviceToken(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid token ID", http.StatusBadRequest)
		return
	}

	token, err := s.db.GetDeviceToken(id)
	if err != nil {
		log.Printf("[API] GetDeviceToken (update) %d: %v", id, err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	if token == nil {
		http.Error(w, "Token not found", http.StatusNotFound)
		return
	}

	var req struct {
		Name    string `json:"name"`
		MaxUses int    `json:"max_uses"`
		Note    string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Update fields
	if req.Name != "" {
		token.Name = req.Name
	}
	if req.MaxUses > 0 {
		token.MaxUses = req.MaxUses
	}
	if req.Note != "" {
		token.Note = req.Note
	}

	if err := s.db.UpdateDeviceToken(token); err != nil {
		log.Printf("[API] UpdateDeviceToken %d: %v", token.ID, err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(toDeviceTokenResponse(token, false))
}

// handleRevokeDeviceToken revokes a device token.
// DELETE /api/tokens/{id}
func (s *Server) handleRevokeDeviceToken(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid token ID", http.StatusBadRequest)
		return
	}

	token, err := s.db.GetDeviceToken(id)
	if err != nil {
		log.Printf("[API] GetDeviceToken (revoke) %d: %v", id, err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	if token == nil {
		http.Error(w, "Token not found", http.StatusNotFound)
		return
	}

	if err := s.db.RevokeDeviceToken(id); err != nil {
		log.Printf("[API] RevokeDeviceToken %d: %v", id, err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	// Audit log
	if s.auditLog != nil {
		s.auditLog.Log("token_revoked", s.remoteIP(r), getUsernameFromCtx(r), map[string]string{
			"token_id":   strconv.FormatInt(id, 10),
			"token_name": token.Name,
			"peer_id":    token.PeerID,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "Token revoked",
	})
}

// BulkTokenRequest is the JSON body for bulk token generation.
type BulkTokenRequest struct {
	Count      int    `json:"count"`       // Number of tokens to generate
	NamePrefix string `json:"name_prefix"` // Prefix for token names
	MaxUses    int    `json:"max_uses"`    // Max uses per token
	ExpiresIn  int    `json:"expires_in"`  // Seconds until expiration
}

// handleBulkGenerateTokens generates multiple device tokens at once.
// POST /api/tokens/generate-bulk
func (s *Server) handleBulkGenerateTokens(w http.ResponseWriter, r *http.Request) {
	var req BulkTokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	if req.Count < 1 || req.Count > 100 {
		http.Error(w, "Count must be between 1 and 100", http.StatusBadRequest)
		return
	}

	if req.MaxUses == 0 {
		req.MaxUses = 1
	}

	// Calculate expiration
	var expiresAt *time.Time
	if req.ExpiresIn > 0 {
		exp := time.Now().Add(time.Duration(req.ExpiresIn) * time.Second)
		expiresAt = &exp
	}

	// Get creator from context
	creator := ""
	if user, ok := r.Context().Value(ctxKeyUser).(*db.User); ok && user != nil {
		creator = user.Username
	}

	var tokens []*DeviceTokenResponse
	for i := 0; i < req.Count; i++ {
		plainToken, err := generateSecureToken(32)
		if err != nil {
			http.Error(w, "Failed to generate token", http.StatusInternalServerError)
			return
		}

		name := req.NamePrefix
		if name == "" {
			name = "Device"
		}
		name = name + "-" + strconv.Itoa(i+1)

		token := &db.DeviceToken{
			Token:     plainToken,
			TokenHash: hashToken(plainToken),
			Name:      name,
			Status:    db.TokenStatusPending,
			MaxUses:   req.MaxUses,
			UseCount:  0,
			ExpiresAt: expiresAt,
			CreatedBy: creator,
		}

		if err := s.db.CreateDeviceToken(token); err != nil {
			log.Printf("[API] CreateDeviceToken (batch): %v", err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		resp := toDeviceTokenResponse(token, true)
		resp.Token = plainToken
		tokens = append(tokens, resp)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"tokens": tokens,
		"count":  len(tokens),
	})
}

// handleBindTokenToPeer pre-binds a token to a specific peer ID.
// This allows the token to be validated when the device registers.
// POST /api/tokens/{id}/bind
func (s *Server) handleBindTokenToPeer(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "Invalid token ID", http.StatusBadRequest)
		return
	}

	var req struct {
		PeerID string `json:"peer_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	if req.PeerID == "" {
		http.Error(w, "peer_id required", http.StatusBadRequest)
		return
	}

	// Validate peer ID format
	if len(req.PeerID) < 6 || len(req.PeerID) > 16 {
		http.Error(w, "Peer ID must be 6-16 characters", http.StatusBadRequest)
		return
	}

	token, err := s.db.GetDeviceToken(id)
	if err != nil {
		log.Printf("[API] GetDeviceToken (bind) %d: %v", id, err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	if token == nil {
		http.Error(w, "Token not found", http.StatusNotFound)
		return
	}
	if token.Status == db.TokenStatusRevoked {
		http.Error(w, "Token has been revoked", http.StatusConflict)
		return
	}
	if token.PeerID != "" && token.PeerID != req.PeerID {
		http.Error(w, "Token already bound to different peer", http.StatusConflict)
		return
	}

	// Bind token to peer ID
	if err := s.db.BindTokenToPeer(token.TokenHash, req.PeerID); err != nil {
		log.Printf("[API] BindTokenToPeer %d -> %s: %v", id, req.PeerID, err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	// Audit log
	if s.auditLog != nil {
		s.auditLog.Log("token_bound", s.remoteIP(r), getUsernameFromCtx(r), map[string]string{
			"token_id":   strconv.FormatInt(id, 10),
			"token_name": token.Name,
			"peer_id":    req.PeerID,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":  true,
		"message":  "Token bound to peer",
		"token_id": id,
		"peer_id":  req.PeerID,
	})
}

// handleGetEnrollmentMode returns the current enrollment mode configuration.
// GET /api/enrollment/mode
func (s *Server) handleGetEnrollmentMode(w http.ResponseWriter, r *http.Request) {
	mode := s.cfg.EnrollmentMode
	if mode == "" {
		mode = "open"
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"mode":        mode,
		"description": getEnrollmentModeDescription(mode),
	})
}

// handleSetEnrollmentMode updates the enrollment mode.
// PUT /api/enrollment/mode
func (s *Server) handleSetEnrollmentMode(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	mode := req.Mode
	if mode != "open" && mode != "managed" && mode != "locked" {
		http.Error(w, "Invalid mode (open, managed, locked)", http.StatusBadRequest)
		return
	}

	// Store in database config
	if err := s.db.SetConfig("enrollment_mode", mode); err != nil {
		log.Printf("[API] SetConfig enrollment_mode=%s: %v", mode, err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	// Update runtime config
	s.cfg.EnrollmentMode = mode

	// Audit log
	if s.auditLog != nil {
		s.auditLog.Log("enrollment_mode_changed", s.remoteIP(r), getUsernameFromCtx(r), map[string]string{
			"new_mode": mode,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":     true,
		"mode":        mode,
		"description": getEnrollmentModeDescription(mode),
	})
}

func getEnrollmentModeDescription(mode string) string {
	switch mode {
	case "open":
		return "All devices can register (backward compatible)"
	case "managed":
		return "New devices need to be pre-approved or have a valid token"
	case "locked":
		return "Only devices with a valid token binding can register"
	default:
		return "Unknown mode"
	}
}
