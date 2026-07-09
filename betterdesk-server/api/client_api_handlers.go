// RustDesk Client API handlers.
// Provides RustDesk-compatible endpoints on the Go server's consolidated API port
// (default :21121, overridable via -api-port / API_PORT). When the RustDesk client
// has no explicit API Server URL, it may fall back to signal_port - 2 (21114).
//
// Endpoints:
//
//	POST /api/login          — RustDesk-compatible login (username/password + TOTP)
//	GET  /api/login-options   — Available authentication methods
//	POST /api/logout          — Invalidate session (no-op for stateless JWT)
//	GET  /api/currentUser     — Get current user info (Bearer token required)
//	POST /api/ab              — Get/update address book
//	GET  /api/ab              — Get address book
package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/unitronix/betterdesk-server/audit"
	"github.com/unitronix/betterdesk-server/auth"
	"github.com/unitronix/betterdesk-server/db"
)

// tfaSession holds temporary state for a two-factor auth flow in progress.
type tfaSession struct {
	username   string
	role       string
	userID     int64
	clientID   string
	clientUUID string
	clientIP   string
	createdAt  time.Time
}

// tfaSessionStore is a concurrency-safe in-memory store for pending 2FA sessions.
// Sessions expire after 5 minutes.
type tfaSessionStore struct {
	mu       sync.Mutex
	sessions map[string]*tfaSession
}

func newTFASessionStore() *tfaSessionStore {
	return &tfaSessionStore{sessions: make(map[string]*tfaSession)}
}

func (s *tfaSessionStore) put(secret string, sess *tfaSession) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Prune expired sessions (>5 min)
	now := time.Now()
	for k, v := range s.sessions {
		if now.Sub(v.createdAt) > 5*time.Minute {
			delete(s.sessions, k)
		}
	}
	// Limit total sessions to prevent memory exhaustion
	if len(s.sessions) >= 1000 {
		s.mu.Unlock()
		return
	}
	s.sessions[secret] = sess
}

func (s *tfaSessionStore) take(secret string) *tfaSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[secret]
	if !ok {
		return nil
	}
	delete(s.sessions, secret)
	if time.Since(sess.createdAt) > 5*time.Minute {
		return nil // expired
	}
	return sess
}

// rustdeskUserPayload builds a user object in the format the RustDesk client expects.
func rustdeskUserPayload(username, role string) map[string]any {
	return map[string]any{
		"name":     username,
		"email":    "",
		"note":     "",
		"status":   1, // kNormal
		"grp":      "",
		"is_admin": role == auth.RoleAdmin,
	}
}

// handleClientLogin processes RustDesk desktop client login requests.
// POST /api/login
//
// Request body (initial login):
//
//	{ "username": "...", "password": "...", "id": "DEVICE_ID", "uuid": "...", "type": "account" }
//
// Request body (2FA verification):
//
//	{ "verificationCode": "123456", "secret": "hex...", "id": "DEVICE_ID", "uuid": "..." }
//
// Response (success):
//
//	{ "type": "access_token", "access_token": "jwt...", "user": { "name": ..., "is_admin": ... } }
//
// Response (2FA required):
//
//	{ "type": "email_check", "tfa_type": "tfa_check", "secret": "hex..." }
//
// RustDesk 1.4.7+ expects email_check + tfa_type tfa_check (not type tfa_check).
func (s *Server) handleClientLogin(w http.ResponseWriter, r *http.Request) {
	clientIP := s.remoteIP(r)

	// Rate limiting
	if s.loginLimiter != nil && !s.loginLimiter.Allow(clientIP) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{
			"error": "Too many login attempts. Please try again later.",
		})
		return
	}

	var body struct {
		Username         string `json:"username"`
		Password         string `json:"password"`
		ID               string `json:"id"`   // RustDesk device ID
		UUID             string `json:"uuid"` // RustDesk device UUID
		Type             string `json:"type"` // "account" or "email_code"
		VerificationCode string `json:"verificationCode"`
		TfaCode          string `json:"tfaCode"`
		Secret           string `json:"secret"` // TFA session secret
		AutoLogin        bool   `json:"autoLogin"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		log.Printf("[api] /api/login: JSON decode error from %s: %v", clientIP, err)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid JSON"})
		return
	}

	// DEBUG: Log incoming login request fields (excluding password)
	log.Printf("[api] /api/login from %s: user=%q type=%q code=%q secret_len=%d id=%q uuid=%q",
		clientIP, body.Username, body.Type, body.VerificationCode, len(body.Secret), body.ID, body.UUID)

	totpCode := body.VerificationCode
	if totpCode == "" {
		totpCode = body.TfaCode
	}

	// ── TFA verification step ──
	if totpCode != "" && body.Secret != "" {
		s.handleClientTFAVerify(w, clientIP, totpCode, body.Secret)
		return
	}

	// ── Initial login step ──
	if body.Username == "" || body.Password == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Missing credentials"})
		return
	}

	if s.loginLimiter != nil && !s.loginLimiter.Allow("user:"+strings.ToLower(body.Username)) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{
			"error": "Too many login attempts. Please try again later.",
		})
		return
	}

	login := s.authenticatePasswordLogin(body.Username, body.Password, clientIP)
	switch login.Status {
	case passwordLoginInternal:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal error"})
		return
	case passwordLoginOIDC:
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "This account uses single sign-on. Please log in with your identity provider."})
		return
	case passwordLoginInvalid:
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid credentials"})
		return
	}

	user := login.User

	// Check if TOTP 2FA is required
	if user.TOTPEnabled && user.TOTPSecret != "" {
		secret := make([]byte, 16)
		if _, err := rand.Read(secret); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal error"})
			return
		}
		tfaSecret := hex.EncodeToString(secret)

		s.clientTFASessions.put(tfaSecret, &tfaSession{
			username:   user.Username,
			role:       user.Role,
			userID:     user.ID,
			clientID:   body.ID,
			clientUUID: body.UUID,
			clientIP:   clientIP,
			createdAt:  time.Now(),
		})

		if s.auditLog != nil {
			s.auditLog.Log(audit.ActionAuthLoginFailed, clientIP, user.Username,
				map[string]string{"reason": "2fa_required", "client_id": body.ID})
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"type":     "email_check",
			"tfa_type": "tfa_check",
			"secret":   tfaSecret,
		})
		return
	}

	// No 2FA — issue client session token
	token, err := s.issueClientSession(user, body.ID, body.UUID, clientIP)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Token generation failed"})
		return
	}

	_ = s.db.UpdateUserLogin(user.ID)

	auditFields := map[string]string{"client_id": body.ID}
	if login.AuthMethod != "" {
		auditFields["method"] = login.AuthMethod
	}
	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionAuthLogin, clientIP, user.Username, auditFields)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"type":         "access_token",
		"access_token": token,
		"user":         rustdeskUserPayload(user.Username, user.Role),
	})
}

// handleClientTFAVerify completes the TOTP step for a RustDesk client login.
func (s *Server) handleClientTFAVerify(w http.ResponseWriter, clientIP, totpCode, secret string) {
	sess := s.clientTFASessions.take(secret)
	if sess == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid or expired TFA session"})
		return
	}

	// Validate TOTP code length (6 digits)
	if len(totpCode) != 6 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid verification code"})
		return
	}

	user, err := s.db.GetUser(sess.username)
	if err != nil || user == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "User not found"})
		return
	}

	if !auth.ValidateTOTP(user.TOTPSecret, totpCode) {
		if s.auditLog != nil {
			s.auditLog.Log(audit.ActionAuthLoginFailed, clientIP, sess.username,
				map[string]string{"reason": "invalid_totp", "client_id": sess.clientID})
		}
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid verification code"})
		return
	}

	token, err := s.issueClientSession(user, sess.clientID, sess.clientUUID, clientIP)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Token generation failed"})
		return
	}

	_ = s.db.UpdateUserLogin(user.ID)

	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionAuthLogin, clientIP, user.Username,
			map[string]string{"client_id": sess.clientID, "method": "totp"})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"type":         "access_token",
		"access_token": token,
		"user":         rustdeskUserPayload(user.Username, user.Role),
	})
}

// handleClientLoginOptions returns available authentication methods.
// GET /api/login-options
func (s *Server) handleClientLoginOptions(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, []string{""})
}

// handleClientLogout handles logout for RustDesk clients.
// POST /api/logout
func (s *Server) handleClientLogout(w http.ResponseWriter, r *http.Request) {
	s.revokeClientSessionToken(bearerTokenFromRequest(r))
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleClientCurrentUser returns the current user info from Bearer token.
// GET /api/currentUser
func (s *Server) handleClientCurrentUser(w http.ResponseWriter, r *http.Request) {
	username := getUsernameFromCtx(r)
	role := getRoleFromCtx(r)
	if username == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Not authenticated"})
		return
	}
	writeJSON(w, http.StatusOK, rustdeskUserPayload(username, role))
}

type clientAbPostBody struct {
	Data json.RawMessage `json:"data"`
}

// decodeClientAbPostBody parses RustDesk legacy address book POST envelopes.
// emptyBody is true when the client sent no JSON (Content-Length: 0), which
// RustDesk 1.4.x uses for /api/ab/personal legacy-mode probing.
func decodeClientAbPostBody(r *http.Request, endpoint, username string) (clientAbPostBody, bool, error) {
	var body clientAbPostBody
	err := json.NewDecoder(r.Body).Decode(&body)
	if err != nil {
		if errors.Is(err, io.EOF) {
			return clientAbPostBody{}, true, nil
		}
		log.Printf("[api] %s JSON decode error for %s: %v (Content-Length: %s)",
			endpoint, username, err, r.Header.Get("Content-Length"))
		return clientAbPostBody{}, false, err
	}
	return body, false, nil
}

func abDataFieldPresent(data json.RawMessage) bool {
	if len(data) == 0 {
		return false
	}
	s := strings.TrimSpace(string(data))
	return s != "" && s != "null"
}

func normalizeAbDataField(data json.RawMessage) string {
	dataStr := string(data)
	if len(dataStr) > 0 && dataStr[0] == '"' {
		var unquoted string
		if err := json.Unmarshal(data, &unquoted); err == nil {
			dataStr = unquoted
		}
	}
	if dataStr == "" || dataStr == "null" {
		dataStr = "{}"
	}
	return dataStr
}

// handleClientAddressBook handles address book get/set for RustDesk clients.
// GET /api/ab — get legacy address book
// POST /api/ab — update legacy address book
func (s *Server) handleClientAddressBook(w http.ResponseWriter, r *http.Request) {
	username := getUsernameFromCtx(r)
	role := getRoleFromCtx(r)
	if username == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Not authenticated"})
		return
	}

	switch r.Method {
	case http.MethodGet:
		data, err := s.db.GetAddressBook(username, "legacy")
		if err != nil {
			log.Printf("[api] GetAddressBook error for %s: %v", username, err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal error"})
			return
		}
		data = s.mergeOrgAddressBooksIntoAB(r, data)
		if !auth.IsProRole(role) {
			// Merge admin-set tags from peers table into AB (#76 TAG sync)
			data = s.mergeAdminTagsIntoAB(data)
			// RustDesk legacy AB reads tags from GET /api/ab (not /api/ab/tags).
			data = s.syncServerTagsIntoAddressBook(data, r, username, role)
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": data, "licensed_devices": 0})

	case http.MethodPost:
		body, emptyBody, err := decodeClientAbPostBody(r, "POST /api/ab", username)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
			return
		}
		dataStr := "{}"
		if !emptyBody {
			dataStr = normalizeAbDataField(body.Data)
		}
		// Limit AB size to 512 KB
		if len(dataStr) > 512*1024 {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "Address book too large"})
			return
		}
		if err := s.db.SaveAddressBook(username, "legacy", dataStr); err != nil {
			log.Printf("[api] SaveAddressBook error for %s: %v", username, err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal error"})
			return
		}
		s.syncAddressBookTagsToPeers(username, role, "legacy", dataStr)
		log.Printf("[api] Saved legacy address book for %s (%d bytes)", username, len(dataStr))
		writeJSON(w, http.StatusOK, map[string]any{})

	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
	}
}

// handleClientAddressBookPersonal handles personal address book get/set.
// GET /api/ab/personal — get personal address book
// POST /api/ab/personal — update personal address book
func (s *Server) handleClientAddressBookPersonal(w http.ResponseWriter, r *http.Request) {
	username := getUsernameFromCtx(r)
	role := getRoleFromCtx(r)
	if username == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Not authenticated"})
		return
	}

	switch r.Method {
	case http.MethodGet:
		data, err := s.db.GetAddressBook(username, "personal")
		if err != nil {
			log.Printf("[api] GetAddressBook(personal) error for %s: %v", username, err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal error"})
			return
		}
		if !auth.IsProRole(role) {
			data = s.mergeAdminTagsIntoAB(data)
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": data})

	case http.MethodPost:
		body, emptyBody, err := decodeClientAbPostBody(r, "POST /api/ab/personal", username)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
			return
		}
		// RustDesk 1.4.7 probes with an empty POST body; legacy servers return 404 (PR #14813).
		if emptyBody || !abDataFieldPresent(body.Data) {
			http.NotFound(w, r)
			return
		}
		dataStr := normalizeAbDataField(body.Data)
		if len(dataStr) > 512*1024 {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "Address book too large"})
			return
		}
		if err := s.db.SaveAddressBook(username, "personal", dataStr); err != nil {
			log.Printf("[api] SaveAddressBook(personal) error for %s: %v", username, err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal error"})
			return
		}
		s.syncAddressBookTagsToPeers(username, role, "personal", dataStr)
		log.Printf("[api] Saved personal address book for %s (%d bytes)", username, len(dataStr))
		writeJSON(w, http.StatusOK, map[string]any{})

	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
	}
}

func normalizeClientTags(value any) []string {
	var raw []string
	switch v := value.(type) {
	case []any:
		for _, item := range v {
			if tag, ok := item.(string); ok {
				raw = append(raw, tag)
			}
		}
	case []string:
		raw = append(raw, v...)
	case string:
		if strings.TrimSpace(v) == "" {
			return nil
		}
		if strings.HasPrefix(strings.TrimSpace(v), "[") {
			var arr []string
			if err := json.Unmarshal([]byte(v), &arr); err == nil {
				raw = append(raw, arr...)
			} else {
				raw = strings.Split(v, ",")
			}
		} else {
			raw = strings.Split(v, ",")
		}
	default:
		return nil
	}

	seen := make(map[string]bool, len(raw))
	tags := make([]string, 0, len(raw))
	for _, tag := range raw {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		if len(tag) > 50 {
			tag = tag[:50]
		}
		if seen[tag] {
			continue
		}
		seen[tag] = true
		tags = append(tags, tag)
		if len(tags) >= 20 {
			break
		}
	}
	return tags
}

func (s *Server) syncAddressBookTagsToPeers(username, role, abType, data string) {
	if role == auth.RolePro || !auth.RoleHasPermission(role, auth.PermDeviceEdit) {
		return
	}

	var ab struct {
		Peers []map[string]any `json:"peers"`
	}
	if err := json.Unmarshal([]byte(data), &ab); err != nil || len(ab.Peers) == 0 {
		return
	}

	synced := 0
	seenPeers := make(map[string]bool, len(ab.Peers))
	for _, peer := range ab.Peers {
		id, _ := peer["id"].(string)
		id = strings.TrimSpace(id)
		if id == "" || seenPeers[id] {
			continue
		}
		if _, hasTags := peer["tags"]; !hasTags {
			continue
		}
		seenPeers[id] = true
		tags := normalizeClientTags(peer["tags"])
		if err := s.db.UpdatePeerTags(id, strings.Join(tags, ",")); err != nil {
			log.Printf("[api] Address book tag sync failed for peer %s user=%s: %v", id, username, err)
			continue
		}
		synced++
	}
	if synced > 0 {
		log.Printf("[api] Synced %d peer tag set(s) from %s address book for %s", synced, abType, username)
	}
}

// mergeAdminTagsIntoAB merges admin-set tags from the peers table into the
// address book data.  For each peer in the AB that also exists in the peers
// table with non-empty tags, the admin tags are added to the peer's tag list.
// The global tags[] array is also extended with any new admin tags.
// Peer hostname/platform/alias are enriched from the peers table if missing.
// This implements TAG sync (Issue #76) and sysinfo enrichment (Issue #138).
//
// IMPORTANT: We use map[string]any for the top-level AB object to preserve
// ALL fields (including tag_colors, rule, etc.) that the RustDesk client
// sends/expects.  A typed struct would silently drop unknown fields on
// re-serialization, causing "type 'String' is not a subtype of type 'int'"
// errors in the Dart client when tag_colors disappears.
func (s *Server) mergeAdminTagsIntoAB(data string) string {
	if data == "" || data == "{}" {
		return data
	}

	// Unmarshal into a generic map to preserve ALL fields (tag_colors, etc.)
	var ab map[string]any
	if err := json.Unmarshal([]byte(data), &ab); err != nil {
		return data
	}

	// Extract peers array
	peersRaw, _ := ab["peers"].([]any)
	if len(peersRaw) == 0 {
		return data
	}
	peers := make([]map[string]any, 0, len(peersRaw))
	for _, p := range peersRaw {
		if pm, ok := p.(map[string]any); ok {
			peers = append(peers, pm)
		}
	}
	if len(peers) == 0 {
		return data
	}

	// Extract existing tags array
	var existingTags []string
	if tagsRaw, ok := ab["tags"].([]any); ok {
		for _, t := range tagsRaw {
			if ts, ok := t.(string); ok {
				existingTags = append(existingTags, ts)
			}
		}
	}

	// Collect all peer IDs from the AB
	ids := make([]string, 0, len(peers))
	for _, p := range peers {
		if id, ok := p["id"].(string); ok && id != "" {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return data
	}

	// Build maps of peer_id → admin tags and peer_id → sysinfo from the peers table
	adminTags := make(map[string][]string)
	peerInfo := make(map[string]*db.Peer)
	bannedPeers := make(map[string]bool)
	peerMap, err := s.db.GetPeersByIDs(ids)
	if err != nil {
		return data
	}
	for id, peer := range peerMap {
		if peer == nil {
			continue
		}
		// Issue #138: track banned/deleted peers so they can be stripped from the AB
		if peer.Banned || peer.SoftDeleted {
			bannedPeers[id] = true
			continue
		}
		peerInfo[id] = peer
		if peer.Tags == "" {
			continue
		}
		tags := strings.Split(peer.Tags, ",")
		cleaned := make([]string, 0, len(tags))
		for _, t := range tags {
			t = strings.TrimSpace(t)
			if t != "" {
				cleaned = append(cleaned, t)
			}
		}
		if len(cleaned) > 0 {
			adminTags[id] = cleaned
		}
	}
	if len(adminTags) == 0 && len(peerInfo) == 0 {
		return data
	}

	// Build a set of existing global tags
	tagSet := make(map[string]bool)
	for _, t := range existingTags {
		tagSet[t] = true
	}

	// Merge admin tags and sysinfo into each peer; strip banned/deleted peers
	modified := false
	filtered := make([]map[string]any, 0, len(peers))
	for _, p := range peers {
		id, ok := p["id"].(string)
		if !ok || id == "" {
			filtered = append(filtered, p)
			continue
		}

		// Issue #138: remove banned/deleted peers from the address book entirely
		if bannedPeers[id] {
			modified = true
			continue
		}
		filtered = append(filtered, p)

		// Enrich peer with sysinfo from peers table (Issue #138: OS icon/name not showing)
		if info, ok := peerInfo[id]; ok {
			if _, hasHostname := p["hostname"]; !hasHostname || p["hostname"] == "" {
				if info.Hostname != "" {
					p["hostname"] = info.Hostname
					modified = true
				}
			}
			if _, hasPlatform := p["platform"]; !hasPlatform || p["platform"] == "" {
				if info.OS != "" {
					p["platform"] = info.OS
					modified = true
				}
			}
			if _, hasUsername := p["username"]; !hasUsername || p["username"] == "" {
				if info.User != "" {
					p["username"] = info.User
					modified = true
				}
			}
		}

		// Merge admin tags
		atags, hasAdminTags := adminTags[id]
		if !hasAdminTags {
			continue
		}
		// Get existing peer tags
		existing := make(map[string]bool)
		if arr, ok := p["tags"].([]any); ok {
			for _, v := range arr {
				if s, ok := v.(string); ok {
					existing[s] = true
				}
			}
		}
		// Add admin tags that aren't already present
		merged := make([]string, 0, len(existing)+len(atags))
		if arr, ok := p["tags"].([]any); ok {
			for _, v := range arr {
				if s, ok := v.(string); ok {
					merged = append(merged, s)
				}
			}
		}
		for _, t := range atags {
			if !existing[t] {
				merged = append(merged, t)
				existing[t] = true
			}
			// Add to global tags if new
			if !tagSet[t] {
				existingTags = append(existingTags, t)
				tagSet[t] = true
			}
		}
		p["tags"] = merged
		modified = true
	}

	if !modified {
		return data
	}

	// Write back the modified peers and tags into the original map
	// Use filtered list (banned/deleted peers removed)
	peersAny := make([]any, len(filtered))
	for i, p := range filtered {
		peersAny[i] = p
	}
	ab["peers"] = peersAny

	// Convert tags to []any
	tagsAny := make([]any, len(existingTags))
	for i, t := range existingTags {
		tagsAny[i] = t
	}
	ab["tags"] = tagsAny

	// Re-serialize — all other fields (tag_colors, rule, etc.) are preserved
	out, err := json.Marshal(ab)
	if err != nil {
		return data
	}
	return string(out)
}

// handleClientAddressBookTags returns tags from the legacy address book.
// GET /api/ab/tags
func (s *Server) handleClientAddressBookTags(w http.ResponseWriter, r *http.Request) {
	username := getUsernameFromCtx(r)
	role := getRoleFromCtx(r)
	if username == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Not authenticated"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"data": s.collectRustDeskTags(r, username, role)})
}

// handleClientGroupList returns panel device groups and folders (auth.db) for /api/group.
// Peer tags are exposed separately via /api/ab/tags and the tags field on /api/peers/list.
//
// GET  /api/group, /api/group/get
// POST /api/group/get
func (s *Server) handleClientGroupList(w http.ResponseWriter, r *http.Request) {
	if getUsernameFromCtx(r) == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Not authenticated"})
		return
	}

	built := s.buildRustDeskDeviceGroups(r)
	accessibleOnly := strings.Contains(r.URL.Path, "/device-group")
	payload := make([]map[string]any, 0, len(built))
	for i, g := range built {
		if accessibleOnly {
			// RustDesk GroupModel (/api/device-group/accessible) reads "name" only.
			payload = append(payload, rustDeskAccessibleDeviceGroupPayload(g, i))
		} else {
			payload = append(payload, rustDeskGroupPayload(g, i))
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"total": len(payload),
		"data":  payload,
		"msg":   "success",
	})
}

// handleClientGroupPeers returns all registered peers in the {total,data,msg}
// envelope expected by RustDesk PRO Flutter clients.  Peers are enriched with
// hostname, platform, and username from the peers table so the RustDesk client
// can display OS icons and system names.
//
// GET /api/peers/list
//
// Compatibility shim suggested by progloto in PR #81, enhanced for Issue #138.
func (s *Server) handleClientGroupPeers(w http.ResponseWriter, r *http.Request) {
	if getUsernameFromCtx(r) == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Not authenticated"})
		return
	}

	data, total := s.buildRustDeskPeerList(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"total": total,
		"data":  data,
		"msg":   "success",
	})
}

// handleClientHeartbeat accepts heartbeat pings from RustDesk clients.
// POST /api/heartbeat
// Request:  { "id": "DEVICE_ID", "uuid": "...", "cpu": 42, "memory": 55, "disk": 30 }
// Response: { "modified_at": "2026-...", "sysinfo": true } (if sysinfo needed)
//
//	{ "modified_at": "2026-..." }                   (normal ACK)
func (s *Server) handleClientHeartbeat(w http.ResponseWriter, r *http.Request) {
	// BD-2026-001: Rate-limit heartbeat requests per IP
	clientIP := s.remoteIP(r)
	if !s.heartbeatLimiter.Allow(clientIP) {
		writeJSON(w, http.StatusOK, map[string]string{"modified_at": time.Now().UTC().Format(time.RFC3339)})
		return
	}

	var body struct {
		ID     string  `json:"id"`
		UUID   string  `json:"uuid"`
		CPU    float64 `json:"cpu"`
		Memory float64 `json:"memory"`
		Disk   float64 `json:"disk"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusOK, map[string]string{"modified_at": time.Now().UTC().Format(time.RFC3339)})
		return
	}

	deviceID := body.ID
	if deviceID == "" {
		deviceID = body.UUID
	}
	if deviceID == "" || !peerIDRegexp.MatchString(deviceID) {
		writeJSON(w, http.StatusOK, map[string]string{"modified_at": time.Now().UTC().Format(time.RFC3339)})
		return
	}

	// Verify peer exists
	peer, err := s.db.GetPeer(deviceID)
	if err != nil || peer == nil {
		writeJSON(w, http.StatusOK, map[string]string{"modified_at": time.Now().UTC().Format(time.RFC3339)})
		return
	}

	if peer.Banned {
		writeJSON(w, http.StatusOK, map[string]string{"error": "BANNED"})
		return
	}

	// Update peer status to ONLINE
	_ = s.db.UpdatePeerStatus(deviceID, "ONLINE", clientIP)

	// Save metrics if any values provided (values > 0)
	if body.CPU > 0 || body.Memory > 0 || body.Disk > 0 {
		if err := s.db.SavePeerMetric(deviceID, body.CPU, body.Memory, body.Disk); err != nil {
			log.Printf("[api] Failed to save peer metrics for %s: %v", deviceID, err)
		}
	}

	// Request sysinfo if hostname is empty (never received)
	if peer.Hostname == "" {
		writeJSON(w, http.StatusOK, map[string]any{
			"modified_at": time.Now().UTC().Format(time.RFC3339),
			"sysinfo":     true,
		})
		return
	}

	resp := map[string]any{
		"modified_at": time.Now().UTC().Format(time.RFC3339),
	}
	if policy, err := s.db.GetAccessPolicy(deviceID); err == nil && policy != nil {
		resp["access_policy"] = map[string]any{
			"unattended_enabled": policy.UnattendedEnabled,
			"password_set":       policy.PasswordSet,
			"schedule_enabled":   policy.ScheduleEnabled,
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// handleClientSysinfo receives hardware/software info from RustDesk clients.
// POST /api/sysinfo
// Request:  { "id": "DEVICE_ID", "hostname": "...", "platform": "...", "os": "...", "version": "..." ... }
// Response: plain text "SYSINFO_UPDATED" (activates PRO mode in client),
//
//	"ID_NOT_FOUND" (client retries), or "ERROR".
func (s *Server) handleClientSysinfo(w http.ResponseWriter, r *http.Request) {
	// BD-2026-001: Rate-limit sysinfo requests per IP
	if !s.heartbeatLimiter.Allow(s.remoteIP(r)) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("ID_NOT_FOUND")) //nolint:errcheck
		return
	}

	var body struct {
		ID       string `json:"id"`
		UUID     string `json:"uuid"`
		Hostname string `json:"hostname"`
		Platform string `json:"platform"`
		OS       string `json:"os"`
		Version  string `json:"version"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("ID_NOT_FOUND")) //nolint:errcheck
		return
	}

	deviceID := body.ID
	if deviceID == "" {
		deviceID = body.UUID
	}
	if deviceID == "" || !peerIDRegexp.MatchString(deviceID) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("ID_NOT_FOUND")) //nolint:errcheck
		return
	}

	// Verify peer exists
	peer, err := s.db.GetPeer(deviceID)
	if err != nil || peer == nil {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("ID_NOT_FOUND")) //nolint:errcheck
		return
	}

	if peer.Banned {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("ID_NOT_FOUND")) //nolint:errcheck
		return
	}

	// Use platform or os field (RustDesk client may send either)
	osValue := body.Platform
	if osValue == "" {
		osValue = body.OS
	}

	// Truncate fields to safe lengths
	hostname := truncate(body.Hostname, 255)
	osVal := truncate(osValue, 255)
	version := truncate(body.Version, 64)

	if err := s.db.UpdatePeerSysinfo(deviceID, hostname, osVal, version); err != nil {
		s.auditLog.Log(audit.ActionSysinfoError, deviceID, "sysinfo", map[string]string{"error": err.Error()})
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("ERROR")) //nolint:errcheck
		return
	}

	s.auditLog.Log(audit.ActionSysinfoUpdated, deviceID, "sysinfo", map[string]string{
		"hostname": hostname,
		"os":       osVal,
		"version":  version,
	})

	w.Header().Set("Content-Type", "text/plain")
	w.Write([]byte("SYSINFO_UPDATED")) //nolint:errcheck
}

// handleClientSysinfoVer checks if sysinfo needs to be re-uploaded.
// POST /api/sysinfo_ver
// Returns a hash of existing sysinfo; empty response triggers full upload.
func (s *Server) handleClientSysinfoVer(w http.ResponseWriter, r *http.Request) {
	// BD-2026-001: Rate-limit sysinfo_ver requests per IP
	if !s.heartbeatLimiter.Allow(s.remoteIP(r)) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("")) //nolint:errcheck
		return
	}

	var body struct {
		ID   string `json:"id"`
		UUID string `json:"uuid"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("")) //nolint:errcheck
		return
	}

	deviceID := body.ID
	if deviceID == "" {
		deviceID = body.UUID
	}
	if deviceID == "" || !peerIDRegexp.MatchString(deviceID) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("")) //nolint:errcheck
		return
	}

	peer, err := s.db.GetPeer(deviceID)
	if err != nil || peer == nil || peer.Hostname == "" {
		// No sysinfo → trigger upload
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("")) //nolint:errcheck
		return
	}

	// Build a deterministic hash from stored sysinfo fields
	h := sha256.New()
	h.Write([]byte(peer.Hostname))
	h.Write([]byte(peer.OS))
	h.Write([]byte(peer.Version))
	hash := hex.EncodeToString(h.Sum(nil))[:16]

	w.Header().Set("Content-Type", "text/plain")
	w.Write([]byte(hash)) //nolint:errcheck
}

// truncate returns s capped at maxLen bytes.
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}
