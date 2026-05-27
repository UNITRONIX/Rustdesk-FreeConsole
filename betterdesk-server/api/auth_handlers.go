// Auth handlers implement user authentication, user management,
// API key management, and TOTP 2FA endpoints for the BetterDesk API.
package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/unitronix/betterdesk-server/audit"
	"github.com/unitronix/betterdesk-server/auth"
	"github.com/unitronix/betterdesk-server/db"
)

// Context keys for authenticated request metadata.
type contextKey string

const (
	ctxKeyRole     contextKey = "role"
	ctxKeyUsername contextKey = "username"
	ctxKeyUser     contextKey = "user"   // Full db.User object
	ctxKeyOrgID    contextKey = "org_id" // Organization ID (empty for global users)
)

// getRoleFromCtx returns the authenticated user's role from the request context.
func getRoleFromCtx(r *http.Request) string {
	if v, ok := r.Context().Value(ctxKeyRole).(string); ok {
		return v
	}
	return ""
}

// getUsernameFromCtx returns the authenticated username from the request context.
func getUsernameFromCtx(r *http.Request) string {
	if v, ok := r.Context().Value(ctxKeyUsername).(string); ok {
		return v
	}
	return ""
}

// getOrgIDFromCtx returns the org ID embedded in the JWT token (empty for global users).
func getOrgIDFromCtx(r *http.Request) string {
	if v, ok := r.Context().Value(ctxKeyOrgID).(string); ok {
		return v
	}
	return ""
}

// peerOrgScopeCheck verifies org-scoped users have access to the target peer.
// Returns true if access is allowed, false if denied (response already written).
// Super admins, global admins, and users without org context bypass the check.
func (s *Server) peerOrgScopeCheck(w http.ResponseWriter, r *http.Request, peerID string) bool {
	userRole := getRoleFromCtx(r)
	// Super admin and global admin can access any peer.
	if auth.IsSuperAdminRole(userRole) || userRole == auth.RoleGlobalAdmin {
		return true
	}
	orgID := getOrgIDFromCtx(r)
	if orgID == "" {
		// Global user (no org scope) — allowed (permissions already checked by requirePermission).
		return true
	}
	// Org-scoped user: peer must be assigned to their org.
	od, _ := s.db.GetOrgDevice(orgID, peerID)
	if od != nil {
		return true
	}
	writeJSON(w, http.StatusForbidden, map[string]string{"error": "Device not in your organization"})
	return false
}

// requireRole wraps a handler to enforce minimum role permissions.
func (s *Server) requireRole(role string, handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userRole := getRoleFromCtx(r)
		if !auth.HasPermission(userRole, role) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "Insufficient permissions"})
			return
		}
		handler(w, r)
	}
}

// requirePermission wraps a handler to enforce a specific granular permission.
// Checks custom DB overrides first, then falls back to default role permissions.
func (s *Server) requirePermission(perm string, handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userRole := getRoleFromCtx(r)

		// Super admin (and legacy admin) always has all permissions
		if auth.IsSuperAdminRole(userRole) {
			handler(w, r)
			return
		}

		// Check DB-stored custom permission overrides first
		if s.db != nil {
			granted, err := s.db.HasRolePermission(userRole, perm)
			if err == nil {
				if granted {
					handler(w, r)
					return
				}
				// explicit deny in DB — reject even if default says yes
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "Insufficient permissions"})
				return
			}
			// err != nil means no override found — fall through to defaults
		}

		// Fall back to built-in default role permissions
		if auth.RoleHasPermission(userRole, perm) {
			handler(w, r)
			return
		}

		writeJSON(w, http.StatusForbidden, map[string]string{"error": "Insufficient permissions"})
	}
}

// requireOrgMembership wraps a handler to enforce that the authenticated user
// belongs to the organization identified by the URL path parameter.
// Global admins bypass the check. Org-scoped users must match their JWT org_id.
func (s *Server) requireOrgMembership(paramName string, handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userRole := getRoleFromCtx(r)

		// Super admin, legacy admin, and global_admin can access any org
		if auth.IsSuperAdminRole(userRole) || userRole == auth.RoleGlobalAdmin {
			handler(w, r)
			return
		}

		// Get the org ID from the URL path parameter
		targetOrgID := r.PathValue(paramName)
		if targetOrgID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Organization ID required"})
			return
		}

		// Check if the user's JWT org_id matches the target org
		userOrgID := getOrgIDFromCtx(r)
		if userOrgID != "" && userOrgID == targetOrgID {
			handler(w, r)
			return
		}

		// For global users (no org_id in JWT), check DB membership
		username := getUsernameFromCtx(r)
		if username != "" {
			orgUser, err := s.db.GetOrgUserByUsername(targetOrgID, username)
			if err == nil && orgUser != nil {
				handler(w, r)
				return
			}
		}

		writeJSON(w, http.StatusForbidden, map[string]string{"error": "Not a member of this organization"})
	}
}

// --- Login Handlers ---

// handleLogin authenticates a user with username+password and returns a JWT token.
// If TOTP is enabled, returns a partial token requiring 2FA completion.
// POST /api/auth/login
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	// Per-IP login rate limiting (S8)
	clientIP := s.remoteIP(r)
	if s.loginLimiter != nil && !s.loginLimiter.Allow(clientIP) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{
			"error": "Too many login attempts. Please try again later.",
		})
		return
	}

	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid JSON"})
		return
	}
	if body.Username == "" || body.Password == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Username and password required"})
		return
	}

	// SECURITY (audit fix H-03, 2026-04-10): per-username rate limiting in
	// addition to per-IP. Defeats credential-stuffing from a rotating IP pool
	// hammering a single high-value account (e.g. "admin").
	if s.loginLimiter != nil && !s.loginLimiter.Allow("user:"+strings.ToLower(body.Username)) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{
			"error": "Too many login attempts. Please try again later.",
		})
		return
	}

	user, err := s.db.GetUser(body.Username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal error"})
		return
	}
	if user == nil || !auth.VerifyPassword(user.PasswordHash, body.Password) {
		if s.auditLog != nil {
			s.auditLog.Log(audit.ActionAuthLoginFailed, s.remoteIP(r), body.Username, nil)
		}
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid credentials"})
		return
	}

	// If TOTP is enabled, issue a short-lived partial token that requires 2FA completion.
	// H4: Use 5-minute TTL instead of the default 24h to limit brute-force window.
	if user.TOTPEnabled {
		partialToken, err := s.jwtManager.GenerateWithTTL(user.Username, "__2fa_pending__", 5*time.Minute)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Token generation failed"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"requires_2fa":  true,
			"partial_token": partialToken,
		})
		return
	}

	// No 2FA — issue full token
	token, err := s.jwtManager.Generate(user.Username, user.Role)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Token generation failed"})
		return
	}

	_ = s.db.UpdateUserLogin(user.ID)

	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionAuthLogin, s.remoteIP(r), user.Username, nil)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"token":    token,
		"role":     user.Role,
		"username": user.Username,
	})
}

// handleLogin2FA completes a two-factor authentication login.
// POST /api/auth/login/2fa
func (s *Server) handleLogin2FA(w http.ResponseWriter, r *http.Request) {
	// Per-IP rate limiting for 2FA attempts (H3: prevent TOTP brute-force)
	clientIP := s.remoteIP(r)
	if s.loginLimiter != nil && !s.loginLimiter.Allow(clientIP) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{
			"error": "Too many 2FA attempts. Please try again later.",
		})
		return
	}

	var body struct {
		PartialToken string `json:"partial_token"`
		Code         string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid JSON"})
		return
	}

	claims, err := s.jwtManager.Validate(body.PartialToken)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid or expired partial token"})
		return
	}

	// H-03: per-username 2FA rate limiting (in addition to per-IP).
	if claims != nil && claims.Sub != "" {
		if s.loginLimiter != nil && !s.loginLimiter.Allow("user:"+strings.ToLower(claims.Sub)) {
			writeJSON(w, http.StatusTooManyRequests, map[string]string{
				"error": "Too many 2FA attempts. Please try again later.",
			})
			return
		}
	}
	if claims.Role != "__2fa_pending__" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Not a 2FA partial token"})
		return
	}

	user, err := s.db.GetUser(claims.Sub)
	if err != nil || user == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "User not found"})
		return
	}

	if !auth.ValidateTOTP(user.TOTPSecret, body.Code) {
		// H4: fall back to recovery code consumption (single-use).
		if user.TOTPRecoveryCodes != "" {
			newStore, matched, rcErr := auth.ConsumeRecoveryCode(user.TOTPRecoveryCodes, body.Code)
			if rcErr != nil {
				log.Printf("api: recovery code consume failed for user %d: %v", user.ID, rcErr)
			}
			if matched {
				user.TOTPRecoveryCodes = newStore
				if err := s.db.UpdateUser(user); err != nil {
					log.Printf("api: persist consumed recovery code failed for user %d: %v", user.ID, err)
					writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
					return
				}
				if s.auditLog != nil {
					s.auditLog.Log(audit.ActionAuthLogin, s.remoteIP(r), user.Username, map[string]string{"2fa": "recovery_code"})
				}
				token, err := s.jwtManager.Generate(user.Username, user.Role)
				if err != nil {
					writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Token generation failed"})
					return
				}
				_ = s.db.UpdateUserLogin(user.ID)
				writeJSON(w, http.StatusOK, map[string]any{
					"token":              token,
					"role":               user.Role,
					"username":           user.Username,
					"used_recovery_code": true,
				})
				return
			}
		}

		if s.auditLog != nil {
			s.auditLog.Log(audit.ActionAuthLoginFailed, s.remoteIP(r), claims.Sub, map[string]string{"reason": "invalid_totp"})
		}
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid TOTP code"})
		return
	}

	token, err := s.jwtManager.Generate(user.Username, user.Role)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Token generation failed"})
		return
	}

	_ = s.db.UpdateUserLogin(user.ID)

	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionAuthLogin, s.remoteIP(r), user.Username, map[string]string{"2fa": "true"})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"token":    token,
		"role":     user.Role,
		"username": user.Username,
	})
}

// handleAuthMe returns current authenticated user info.
// GET /api/auth/me
func (s *Server) handleAuthMe(w http.ResponseWriter, r *http.Request) {
	username := getUsernameFromCtx(r)
	user, err := s.db.GetUser(username)
	if err != nil || user == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "User not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":              user.ID,
		"username":        user.Username,
		"role":            user.Role,
		"totp_enabled":    user.TOTPEnabled,
		"is_server_admin": user.IsServerAdmin,
		"created_at":      user.CreatedAt,
		"last_login":      user.LastLogin,
	})
}

// --- User Management Handlers (admin only) ---

// handleListUsers returns all users without sensitive fields.
// GET /api/users
func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	// Detect RustDesk client group model request: sends ?accessible&status=1
	// and expects {total,data} envelope with UserPayload format.
	if r.URL.Query().Has("accessible") || r.URL.Query().Has("pageSize") {
		s.handleClientUsersList(w, r)
		return
	}

	users, err := s.db.ListUsers()
	if err != nil {
		log.Printf("api: list users failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	type userView struct {
		ID            int64  `json:"id"`
		Username      string `json:"username"`
		Role          string `json:"role"`
		TOTPEnabled   bool   `json:"totp_enabled"`
		IsServerAdmin bool   `json:"is_server_admin"`
		CreatedAt     string `json:"created_at"`
		LastLogin     string `json:"last_login,omitempty"`
	}

	result := make([]userView, len(users))
	for i, u := range users {
		result[i] = userView{
			ID: u.ID, Username: u.Username, Role: u.Role,
			TOTPEnabled: u.TOTPEnabled, IsServerAdmin: u.IsServerAdmin,
			CreatedAt: u.CreatedAt, LastLogin: u.LastLogin,
		}
	}
	writeJSON(w, http.StatusOK, result)
}

// handleClientUsersList returns users in the {total,data} envelope format
// expected by the RustDesk Flutter client's group model (UserPayload format).
func (s *Server) handleClientUsersList(w http.ResponseWriter, r *http.Request) {
	users, err := s.db.ListUsers()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"total": 0,
			"data":  []any{},
		})
		return
	}

	result := make([]map[string]any, 0, len(users))
	for _, u := range users {
		// Convert role to status int: 1=active (normal), 0=disabled
		statusInt := 1
		isAdmin := u.Role == "admin" || u.Role == "super_admin" || u.IsServerAdmin

		result = append(result, map[string]any{
			"name":         u.Username,
			"display_name": u.Username,
			"email":        "",
			"note":         "",
			"status":       statusInt,
			"is_admin":     isAdmin,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"total": len(result),
		"data":  result,
	})
}

// handleUsersWithClientFallback detects RustDesk client requests (with
// ?accessible or ?pageSize) and returns the current user without requiring
// user.view permission. This prevents the client's group pull from failing
// for operator users. Admin panel requests fall through to the full
// permission-protected list handler.
// Issue #138: _getUsers() failure causes _getPeers() to never run.
func (s *Server) handleUsersWithClientFallback(w http.ResponseWriter, r *http.Request) {
	// RustDesk client sends ?accessible=&status=1&pageSize=100
	if r.URL.Query().Has("accessible") || r.URL.Query().Has("pageSize") {
		username := getUsernameFromCtx(r)
		role := getRoleFromCtx(r)

		// If user has user.view permission, return full list
		if auth.IsSuperAdminRole(role) || auth.RoleHasPermission(role, auth.PermUserView) {
			s.handleClientUsersList(w, r)
			return
		}

		// For operators without user.view, return current user only
		// so the client's _getUsers() succeeds and _getPeers() proceeds
		statusInt := 1
		isAdmin := auth.IsSuperAdminRole(role)
		writeJSON(w, http.StatusOK, map[string]any{
			"total": 1,
			"data": []map[string]any{{
				"name":         username,
				"display_name": username,
				"email":        "",
				"note":         "",
				"status":       statusInt,
				"is_admin":     isAdmin,
			}},
		})
		return
	}

	// Admin panel request — require user.view permission
	s.requirePermission(auth.PermUserView, s.handleListUsers)(w, r)
}

// handleCreateUser creates a new user account.
// POST /api/users
func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Role     string `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid JSON"})
		return
	}
	if body.Username == "" || body.Password == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Username and password required"})
		return
	}
	if body.Role == "" {
		body.Role = auth.RoleViewer
	}
	if !auth.ValidRole(body.Role) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid role (admin, operator, viewer)"})
		return
	}

	// Role boundary: use CanAssignRole for branched hierarchy support.
	callerRole := getRoleFromCtx(r)
	if !auth.CanAssignRole(callerRole, body.Role) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "Cannot assign a role higher than your own"})
		return
	}

	hash, err := auth.HashPassword(body.Password)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Password hash failed"})
		return
	}

	user := &db.User{
		Username:     body.Username,
		PasswordHash: hash,
		Role:         body.Role,
	}
	if err := s.db.CreateUser(user); err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "Username already exists or DB error"})
		return
	}

	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionUserCreated, s.remoteIP(r), body.Username, map[string]string{"role": body.Role})
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id": user.ID, "username": user.Username, "role": user.Role,
	})
}

// handleUpdateUser updates a user's password and/or role.
// PUT /api/users/{id}
func (s *Server) handleUpdateUser(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid user ID"})
		return
	}

	user, err := s.db.GetUserByID(id)
	if err != nil || user == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "User not found"})
		return
	}

	var body struct {
		Password string `json:"password,omitempty"`
		Role     string `json:"role,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid JSON"})
		return
	}

	if body.Password != "" {
		hash, err := auth.HashPassword(body.Password)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Password hash failed"})
			return
		}
		user.PasswordHash = hash
	}
	if body.Role != "" {
		if !auth.ValidRole(body.Role) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid role"})
			return
		}

		callerUsername := getUsernameFromCtx(r)
		callerRole := getRoleFromCtx(r)

		// Prevent self-demotion (admin cannot lower their own role).
		if user.Username == callerUsername && auth.RoleLevel(body.Role) < auth.RoleLevel(user.Role) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "Cannot demote yourself"})
			return
		}

		// Role boundary: use CanAssignRole for branched hierarchy.
		if !auth.CanAssignRole(callerRole, body.Role) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "Cannot assign a role higher than your own"})
			return
		}

		// Prevent demoting the last super-admin/admin.
		if auth.IsSuperAdminRole(user.Role) && !auth.IsSuperAdminRole(body.Role) {
			users, _ := s.db.ListUsers()
			adminCount := 0
			for _, u := range users {
				if auth.IsSuperAdminRole(u.Role) {
					adminCount++
				}
			}
			if adminCount <= 1 {
				writeJSON(w, http.StatusConflict, map[string]string{"error": "Cannot demote the last admin"})
				return
			}
		}

		// Prevent demoting a server admin unless caller is also a server admin.
		if user.IsServerAdmin {
			callerUser, _ := s.db.GetUser(callerUsername)
			if callerUser == nil || !callerUser.IsServerAdmin {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "Only server admins can modify other server admins"})
				return
			}
		}

		user.Role = body.Role
	}

	if err := s.db.UpdateUser(user); err != nil {
		log.Printf("api: update user %d failed: %v", user.ID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionUserUpdated, s.remoteIP(r), user.Username, nil)
	}

	writeJSON(w, http.StatusOK, map[string]any{"status": "updated", "id": user.ID})
}

// handleDeleteUser removes a user. Refuses to delete the last admin.
// DELETE /api/users/{id}
func (s *Server) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid user ID"})
		return
	}

	user, err := s.db.GetUserByID(id)
	if err != nil || user == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "User not found"})
		return
	}

	// Prevent deleting the last admin
	if user.Role == auth.RoleAdmin {
		users, _ := s.db.ListUsers()
		adminCount := 0
		for _, u := range users {
			if u.Role == auth.RoleAdmin {
				adminCount++
			}
		}
		if adminCount <= 1 {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "Cannot delete the last admin user"})
			return
		}
	}

	// Prevent deleting a server admin unless caller is also a server admin.
	if user.IsServerAdmin {
		callerUsername := getUsernameFromCtx(r)
		callerUser, _ := s.db.GetUser(callerUsername)
		if callerUser == nil || !callerUser.IsServerAdmin {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "Only server admins can delete other server admins"})
			return
		}
	}

	if err := s.db.DeleteUser(id); err != nil {
		log.Printf("api: delete user %d failed: %v", id, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionUserDeleted, s.remoteIP(r), user.Username, nil)
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// --- TOTP Handlers ---

// handleSetupTOTP generates a new TOTP secret for a user.
// The secret is NOT active until confirmed with a valid code.
// POST /api/users/{id}/totp/setup
func (s *Server) handleSetupTOTP(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid user ID"})
		return
	}

	user, err := s.db.GetUserByID(id)
	if err != nil || user == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "User not found"})
		return
	}

	if user.TOTPEnabled {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "TOTP already enabled"})
		return
	}

	secret := auth.GenerateTOTPSecret()
	user.TOTPSecret = secret
	// Not enabled yet — user must confirm with a valid code.
	user.TOTPEnabled = false

	if err := s.db.UpdateUser(user); err != nil {
		log.Printf("api: totp setup persist failed for user %d: %v", user.ID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"secret": secret,
		"uri":    auth.TOTPUri(secret, "BetterDesk", user.Username),
	})
}

// handleConfirmTOTP activates TOTP after verifying a valid code.
// POST /api/users/{id}/totp/confirm
func (s *Server) handleConfirmTOTP(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid user ID"})
		return
	}

	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid JSON"})
		return
	}

	user, err := s.db.GetUserByID(id)
	if err != nil || user == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "User not found"})
		return
	}
	if user.TOTPSecret == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "TOTP not set up — call setup first"})
		return
	}

	if !auth.ValidateTOTP(user.TOTPSecret, body.Code) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid TOTP code"})
		return
	}

	user.TOTPEnabled = true

	// H4: generate one-shot recovery codes on enable and return them ONCE in
	// plaintext. Only bcrypt hashes are persisted. The user must save them
	// somewhere safe — there is no way to retrieve them later.
	plainCodes, err := auth.GenerateRecoveryCodes()
	if err != nil {
		log.Printf("api: totp recovery code gen failed for user %d: %v", user.ID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	hashed, err := auth.HashRecoveryCodes(plainCodes)
	if err != nil {
		log.Printf("api: totp recovery code hash failed for user %d: %v", user.ID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	user.TOTPRecoveryCodes = hashed

	if err := s.db.UpdateUser(user); err != nil {
		log.Printf("api: totp confirm persist failed for user %d: %v", user.ID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status":         "totp_enabled",
		"recovery_codes": plainCodes,
	})
}

// handleDisableTOTP removes TOTP for a user.
// DELETE /api/users/{id}/totp
func (s *Server) handleDisableTOTP(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid user ID"})
		return
	}

	user, err := s.db.GetUserByID(id)
	if err != nil || user == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "User not found"})
		return
	}

	user.TOTPSecret = ""
	user.TOTPEnabled = false
	user.TOTPRecoveryCodes = ""
	if err := s.db.UpdateUser(user); err != nil {
		log.Printf("api: totp disable persist failed for user %d: %v", user.ID, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "totp_disabled"})
}

// --- API Key Handlers ---

// handleListAPIKeys returns all API keys (hashes are not exposed).
// GET /api/keys
func (s *Server) handleListAPIKeys(w http.ResponseWriter, r *http.Request) {
	keys, err := s.db.ListAPIKeys()
	if err != nil {
		log.Printf("api: list api keys failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	type keyView struct {
		ID        int64  `json:"id"`
		KeyPrefix string `json:"key_prefix"`
		Name      string `json:"name"`
		Role      string `json:"role"`
		CreatedAt string `json:"created_at"`
		ExpiresAt string `json:"expires_at,omitempty"`
		LastUsed  string `json:"last_used,omitempty"`
	}

	result := make([]keyView, len(keys))
	for i, k := range keys {
		result[i] = keyView{
			ID: k.ID, KeyPrefix: k.KeyPrefix, Name: k.Name, Role: k.Role,
			CreatedAt: k.CreatedAt, ExpiresAt: k.ExpiresAt, LastUsed: k.LastUsed,
		}
	}
	writeJSON(w, http.StatusOK, result)
}

// handleCreateAPIKey generates a new API key. The plaintext key is returned ONCE.
// POST /api/keys
func (s *Server) handleCreateAPIKey(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name      string `json:"name"`
		Role      string `json:"role"`
		ExpiresIn int    `json:"expires_in_days,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid JSON"})
		return
	}
	if body.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Name required"})
		return
	}
	if body.Role == "" {
		body.Role = auth.RoleViewer
	}
	if !auth.ValidRole(body.Role) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid role"})
		return
	}

	// Generate a random 32-byte (64 hex char) API key
	plainKey, err := auth.GenerateRandomString(32)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Key generation failed"})
		return
	}

	hash := sha256.Sum256([]byte(plainKey))
	keyHash := hex.EncodeToString(hash[:])

	key := &db.APIKey{
		KeyHash:   keyHash,
		KeyPrefix: plainKey[:8],
		Name:      body.Name,
		Role:      body.Role,
	}
	if body.ExpiresIn > 0 {
		exp := time.Now().Add(time.Duration(body.ExpiresIn) * 24 * time.Hour).Format("2006-01-02 15:04:05")
		key.ExpiresAt = exp
	}

	if err := s.db.CreateAPIKey(key); err != nil {
		log.Printf("api: create api key %q failed: %v", body.Name, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionAPIKeyCreated, s.remoteIP(r), body.Name, map[string]string{"role": body.Role})
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":         key.ID,
		"key":        plainKey, // returned once only
		"prefix":     key.KeyPrefix,
		"name":       key.Name,
		"role":       key.Role,
		"expires_at": key.ExpiresAt,
	})
}

// handleDeleteAPIKey revokes an API key by ID.
// DELETE /api/keys/{id}
func (s *Server) handleDeleteAPIKey(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid key ID"})
		return
	}

	if err := s.db.DeleteAPIKey(id); err != nil {
		log.Printf("api: delete api key %d failed: %v", id, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionAPIKeyRevoked, s.remoteIP(r), fmt.Sprintf("key:%d", id), nil)
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "revoked"})
}

// hashAPIKey computes the SHA-256 hash of a plaintext API key for database lookup.
func hashAPIKey(key string) string {
	h := sha256.Sum256([]byte(key))
	return hex.EncodeToString(h[:])
}

// authenticateRequest extracts and validates credentials from a request.
// Returns (username, role, ok). If ok is false, an error response has been written.
// Auth order: Bearer JWT → X-API-Key (scoped DB lookup).
func (s *Server) authenticateRequest(r *http.Request) (username, role string, ok bool) {
	// 1. Bearer JWT
	if bearer := r.Header.Get("Authorization"); len(bearer) > 7 && bearer[:7] == "Bearer " {
		token := bearer[7:]
		claims, err := s.jwtManager.Validate(token)
		if err == nil && claims.Role != "__2fa_pending__" {
			return claims.Sub, claims.Role, true
		}
	}

	// 2. X-API-Key header (query param removed — BD-2026-005: query transport leaks keys in logs/proxies)
	apiKey := r.Header.Get("X-API-Key")
	if apiKey != "" {
		keyHash := hashAPIKey(apiKey)
		if k, err := s.db.GetAPIKeyByHash(keyHash); err == nil && k != nil {
			// Check expiry
			if k.ExpiresAt != "" {
				if exp, err := time.Parse("2006-01-02 15:04:05", k.ExpiresAt); err == nil && exp.Before(time.Now()) {
					return "", "", false
				}
			}
			// Update last_used in background
			go func() { _ = s.db.TouchAPIKey(k.ID) }()
			return "apikey:" + k.Name, k.Role, true
		}
	}

	return "", "", false
}

// extractOrgIDFromRequest reads the org_id from the Bearer JWT token.
// Returns empty string if no JWT, no org_id, or API key auth (non-JWT).
func (s *Server) extractOrgIDFromRequest(r *http.Request) string {
	if s.jwtManager == nil {
		return ""
	}
	bearer := r.Header.Get("Authorization")
	if len(bearer) <= 7 || bearer[:7] != "Bearer " {
		return ""
	}
	claims, err := s.jwtManager.Validate(bearer[7:])
	if err != nil {
		return ""
	}
	return claims.OrgID
}

// redactPathSegment masks high-cardinality identifiers in URL paths so that
// device IDs / user IDs do not leak verbatim into access logs (audit fix L-04).
// Currently rewrites:
//   - /api/peers/{id}/...     -> /api/peers/<id>/...
//   - /api/cdap/devices/{id}/ -> /api/cdap/devices/<id>/
//   - /ws/bd-mgmt/{id}        -> /ws/bd-mgmt/<id>
func redactPathSegment(p string) string {
	for _, prefix := range []string{"/api/peers/", "/api/cdap/devices/", "/ws/bd-mgmt/", "/api/tokens/", "/api/users/", "/api/orgs/"} {
		if !strings.HasPrefix(p, prefix) {
			continue
		}
		rest := p[len(prefix):]
		slash := strings.IndexByte(rest, '/')
		if slash < 0 {
			return prefix + "<id>"
		}
		return prefix + "<id>" + rest[slash:]
	}
	return p
}

// authMiddleware replaces the old apiKeyMiddleware.
// It authenticates every request and attaches role + username to the context.
// Public endpoints are excluded from authentication.
func (s *Server) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Log incoming HTTP requests. SECURITY (audit fix L-04, 2026-04-10):
		//   - skip noisy public probes (heartbeat / sysinfo / metrics / health)
		//   - redact /peers/{id} segments so device IDs do not leak into logs
		path := r.URL.Path
		if path != "/api/heartbeat" && path != "/api/sysinfo" && path != "/api/sysinfo_ver" &&
			path != "/metrics" && path != "/api/health" {
			log.Printf("[api] %s %s from %s", r.Method, redactPathSegment(path), s.remoteIP(r))
		}

		// Limit request body size to 1 MB for all requests (S10)
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)

		// Public endpoints — no auth required
		if path == "/api/health" || path == "/metrics" ||
			path == "/api/auth/login" || path == "/api/auth/login/2fa" ||
			path == "/api/server/pubkey" || path == "/api/server/stats" ||
			path == "/api/login" || path == "/api/login-options" || path == "/api/logout" ||
			path == "/api/heartbeat" || path == "/api/sysinfo" || path == "/api/sysinfo_ver" ||
			path == "/api/branding" ||
			path == "/api/org/login" ||
			strings.HasPrefix(path, "/ws/bd-mgmt/") ||
			path == "/api/devices/register" || path == "/api/devices/register/status" {
			next.ServeHTTP(w, r)
			return
		}

		// HTTPS enforcement
		if s.cfg.ForceHTTPS && r.TLS == nil {
			if r.Header.Get("X-Forwarded-Proto") != "https" {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "HTTPS required"})
				return
			}
		}

		username, role, ok := s.authenticateRequest(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid or missing credentials"})
			return
		}

		ctx := context.WithValue(r.Context(), ctxKeyRole, role)
		ctx = context.WithValue(ctx, ctxKeyUsername, username)

		// Extract org_id from JWT claims (if present)
		orgID := s.extractOrgIDFromRequest(r)
		if orgID != "" {
			ctx = context.WithValue(ctx, ctxKeyOrgID, orgID)
		}

		// Optionally load full user object for handlers that need it
		if user, err := s.db.GetUser(username); err == nil && user != nil {
			ctx = context.WithValue(ctx, ctxKeyUser, user)
		}

		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
