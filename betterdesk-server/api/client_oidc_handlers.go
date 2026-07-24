// RustDesk desktop client OIDC endpoints (stock client protocol).
//
//	POST /api/oidc/auth       — start OAuth; returns {code, url}
//	GET  /api/oidc/auth-query — poll until access_token is ready
//	GET  /api/oidc/callback   — alias of /api/auth/oidc/callback (same Redirect URL)
package api

import (
	"encoding/json"
	"fmt"
	"html"
	"log"
	"net/http"

	"github.com/unitronix/betterdesk-server/audit"
	"github.com/unitronix/betterdesk-server/auth"
	"github.com/unitronix/betterdesk-server/db"
)

// handleClientOIDCAuth starts OIDC for the stock RustDesk desktop client.
// POST /api/oidc/auth
func (s *Server) handleClientOIDCAuth(w http.ResponseWriter, r *http.Request) {
	if s.oidcProvider == nil || !s.oidcProvider.IsEnabled() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "OIDC is not enabled"})
		return
	}

	var body struct {
		Op         string `json:"op"`
		ID         string `json:"id"`
		UUID       string `json:"uuid"`
		DeviceInfo struct {
			Name string `json:"name"`
			OS   string `json:"os"`
			Type string `json:"type"`
		} `json:"deviceInfo"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid JSON"})
		return
	}

	authURL, code, err := s.oidcProvider.BuildClientAuthURL(body.ID, body.UUID, auth.ClientDeviceInfo{
		Name: body.DeviceInfo.Name,
		OS:   body.DeviceInfo.OS,
		Type: body.DeviceInfo.Type,
	})
	if err != nil {
		log.Printf("[OIDC] client auth URL failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to initiate OIDC login"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"code": code,
		"url":  authURL,
	})
}

// handleClientOIDCAuthQuery is polled by the RustDesk client after browser SSO.
// GET /api/oidc/auth-query?code=&id=&uuid=
func (s *Server) handleClientOIDCAuthQuery(w http.ResponseWriter, r *http.Request) {
	if s.oidcProvider == nil || !s.oidcProvider.IsEnabled() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "OIDC is not enabled"})
		return
	}

	code := r.URL.Query().Get("code")
	clientID := r.URL.Query().Get("id")
	clientUUID := r.URL.Query().Get("uuid")
	if code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing code"})
		return
	}

	pending := s.oidcProvider.PeekClientPending(code)
	if pending == nil {
		// Stock client ignores this exact phrase and keeps polling.
		writeJSON(w, http.StatusOK, map[string]string{
			"error":   "No authed oidc is found",
			"message": "Authorization in progress",
		})
		return
	}

	if !pending.Authed {
		writeJSON(w, http.StatusOK, map[string]string{
			"error":   "No authed oidc is found",
			"message": "Authorization in progress",
		})
		return
	}

	// When the pending login bound a device, require matching non-empty id/uuid on
	// every poll (omitting params must not skip binding — token theft via leaked state).
	if pending.ClientID != "" {
		if clientID == "" || pending.ClientID != clientID {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "device id mismatch"})
			return
		}
	}
	if pending.ClientUUID != "" {
		if clientUUID == "" || pending.ClientUUID != clientUUID {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "device uuid mismatch"})
			return
		}
	}

	consumed := s.oidcProvider.ConsumeClientPending(code)
	if consumed == nil {
		writeJSON(w, http.StatusOK, map[string]string{
			"error":   "No authed oidc is found",
			"message": "Authorization in progress",
		})
		return
	}

	user, err := s.db.GetUser(consumed.Username)
	if err != nil || user == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "User not found"})
		return
	}

	clientIP := s.remoteIP(r)
	token, err := s.issueClientSession(user, consumed.ClientID, consumed.ClientUUID, clientIP)
	if err != nil {
		log.Printf("[OIDC] client session issue failed for %q: %v", user.Username, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Token generation failed"})
		return
	}

	_ = s.db.UpdateUserLogin(user.ID)
	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionAuthLogin, clientIP, user.Username, map[string]string{
			"method":    "oidc_client",
			"client_id": consumed.ClientID,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"type":         "access_token",
		"access_token": token,
		"user":         rustdeskUserPayload(user.Username, user.Role),
	})
}

// ensureOIDCUser finds or auto-provisions a local user from an OIDC result.
// On failure it returns an error code suitable for panel redirects / HTML pages.
func (s *Server) ensureOIDCUser(result *auth.OIDCResult, cfg *auth.OIDCConfig) (*db.User, string) {
	if result == nil || result.Username == "" {
		return nil, "oidc_error"
	}

	user, err := s.db.GetUser(result.Username)
	if err != nil {
		log.Printf("[OIDC] DB error looking up user %s: %v", result.Username, err)
		return nil, "oidc_error"
	}

	if user == nil {
		if cfg == nil || !cfg.AllowSignup {
			log.Printf("[OIDC] User %s not found and auto-signup disabled", result.Username)
			return nil, "oidc_no_account"
		}

		randomPass, err := auth.GenerateRandomString(32)
		if err != nil {
			log.Printf("[OIDC] Failed to generate random password: %v", err)
			return nil, "oidc_error"
		}
		hash, err := auth.HashPassword(randomPass)
		if err != nil {
			log.Printf("[OIDC] Failed to hash password: %v", err)
			return nil, "oidc_error"
		}

		role := result.Role
		if role == "" {
			role = auth.RoleViewer
		}

		newUser := &db.User{
			Username:     result.Username,
			PasswordHash: hash,
			Role:         role,
			AuthProvider: db.AuthProviderOIDC,
		}
		if createErr := s.db.CreateUser(newUser); createErr != nil {
			log.Printf("[OIDC] Failed to create user %s: %v", result.Username, createErr)
			return nil, "oidc_error"
		}

		user, _ = s.db.GetUser(result.Username)
		if user == nil {
			return nil, "oidc_error"
		}
		log.Printf("[OIDC] Auto-provisioned user %s with role %s", result.Username, role)
		return user, ""
	}

	changed := false
	if result.Role != "" && result.Role != user.Role {
		user.Role = result.Role
		changed = true
		log.Printf("[OIDC] Updated role for %s to %s", result.Username, result.Role)
	}
	if user.AuthProvider != db.AuthProviderOIDC {
		user.AuthProvider = db.AuthProviderOIDC
		changed = true
	}
	if changed {
		_ = s.db.UpdateUser(user)
	}
	return user, ""
}

func writeClientOIDCResultPage(w http.ResponseWriter, success bool, message string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	title := "Sign-in failed"
	if success {
		title = "Sign-in successful"
	}
	safeMsg := html.EscapeString(message)
	safeTitle := html.EscapeString(title)
	_, _ = fmt.Fprintf(w, `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>%s</title>
<style>
body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;
min-height:100vh;margin:0;background:#0f1419;color:#e7ecf3}
.card{max-width:28rem;padding:2rem;border-radius:12px;background:#1a2332;text-align:center}
h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:0;opacity:.85;line-height:1.5}
</style></head><body><div class="card"><h1>%s</h1><p>%s</p></div></body></html>`,
		safeTitle, safeTitle, safeMsg)
}

func clientOIDCErrorMessage(code string) string {
	switch code {
	case "oidc_denied":
		return "Access was denied by the identity provider."
	case "oidc_invalid":
		return "Invalid OIDC response. Please try again from the RustDesk client."
	case "oidc_failed":
		return "OIDC authentication failed. Check client secret and redirect URL."
	case "oidc_no_account":
		return "Your account was not found and auto-provisioning is disabled."
	default:
		return "An error occurred during SSO login."
	}
}

// finishClientOIDCCallback completes the desktop-client branch after code exchange.
func (s *Server) finishClientOIDCCallback(w http.ResponseWriter, r *http.Request, result *auth.OIDCResult, cfg *auth.OIDCConfig) {
	user, errCode := s.ensureOIDCUser(result, cfg)
	if errCode != "" {
		s.oidcProvider.FailClientPending(result.State)
		writeClientOIDCResultPage(w, false, clientOIDCErrorMessage(errCode))
		return
	}

	if !s.oidcProvider.CompleteClientPending(result.State, user.ID, user.Username, user.Role) {
		log.Printf("[OIDC] client pending missing for state after auth (user=%s)", user.Username)
		writeClientOIDCResultPage(w, false, "Login session expired. Please try again from the RustDesk client.")
		return
	}

	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionAuthLogin, s.remoteIP(r), user.Username, map[string]string{
			"method": "oidc_client_callback",
		})
	}
	_ = s.db.UpdateUserLogin(user.ID)

	writeClientOIDCResultPage(w, true, "You can close this window and return to RustDesk.")
}
