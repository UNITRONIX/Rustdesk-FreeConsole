// OIDC/OAuth2 configuration and callback API handlers for the BetterDesk server.
// Endpoints for managing OIDC provider settings and handling the authorization code flow.
package api

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/unitronix/betterdesk-server/audit"
	"github.com/unitronix/betterdesk-server/auth"
)

// loadOIDCConfigFromDB reads OIDC configuration from the server_config table.
func (s *Server) loadOIDCConfigFromDB() *auth.OIDCConfig {
	cfg := &auth.OIDCConfig{
		Scopes:        "openid profile email",
		ClaimUsername: "preferred_username",
		ClaimEmail:    "email",
		ClaimName:     "name",
		ClaimGroups:   "groups",
		DefaultRole:   "viewer",
		AllowSignup:   true,
		AutoDiscovery: true,
	}

	getString := func(key string) string {
		v, err := s.db.GetConfig(key)
		if err != nil || v == "" {
			return ""
		}
		return v
	}
	getBool := func(key string) bool {
		return getString(key) == "true"
	}

	cfg.Enabled = getBool("oidc.enabled")
	if v := getString("oidc.display_name"); v != "" {
		cfg.DisplayName = v
	}
	if v := getString("oidc.issuer_url"); v != "" {
		cfg.IssuerURL = v
	}
	if v := getString("oidc.client_id"); v != "" {
		cfg.ClientID = v
	}
	if v := getString("oidc.client_secret"); v != "" {
		cfg.ClientSecret = v
	}
	if v := getString("oidc.redirect_url"); v != "" {
		cfg.RedirectURL = v
	}
	if v := getString("oidc.panel_url"); v != "" {
		cfg.PanelURL = v
	}
	if v := getString("oidc.scopes"); v != "" {
		cfg.Scopes = v
	}
	cfg.UsePKCE = getBool("oidc.use_pkce")
	// auto_discovery defaults to true unless explicitly "false"
	if v := getString("oidc.auto_discovery"); v != "" {
		cfg.AutoDiscovery = v == "true"
	}
	if v := getString("oidc.authorization_url"); v != "" {
		cfg.AuthorizationURL = v
	}
	if v := getString("oidc.token_url"); v != "" {
		cfg.TokenURL = v
	}
	if v := getString("oidc.userinfo_url"); v != "" {
		cfg.UserinfoURL = v
	}
	if v := getString("oidc.claim_username"); v != "" {
		cfg.ClaimUsername = v
	}
	if v := getString("oidc.claim_email"); v != "" {
		cfg.ClaimEmail = v
	}
	if v := getString("oidc.claim_name"); v != "" {
		cfg.ClaimName = v
	}
	if v := getString("oidc.claim_groups"); v != "" {
		cfg.ClaimGroups = v
	}
	if v := getString("oidc.default_role"); v != "" {
		cfg.DefaultRole = v
	}
	if v := getString("oidc.group_role_map"); v != "" {
		cfg.GroupRoleMap = v
	}
	if v := getString("oidc.allow_signup"); v != "" {
		cfg.AllowSignup = v == "true"
	}

	return cfg
}

// saveOIDCConfigToDB writes OIDC configuration to the server_config table.
func (s *Server) saveOIDCConfigToDB(cfg *auth.OIDCConfig) error {
	set := func(key, val string) error {
		return s.db.SetConfig(key, val)
	}
	setBool := func(key string, val bool) error {
		v := "false"
		if val {
			v = "true"
		}
		return s.db.SetConfig(key, v)
	}

	if err := setBool("oidc.enabled", cfg.Enabled); err != nil {
		return err
	}
	if err := set("oidc.display_name", cfg.DisplayName); err != nil {
		return err
	}
	if err := set("oidc.issuer_url", cfg.IssuerURL); err != nil {
		return err
	}
	if err := set("oidc.client_id", cfg.ClientID); err != nil {
		return err
	}
	if err := set("oidc.client_secret", cfg.ClientSecret); err != nil {
		return err
	}
	if err := set("oidc.redirect_url", cfg.RedirectURL); err != nil {
		return err
	}
	if err := set("oidc.panel_url", cfg.PanelURL); err != nil {
		return err
	}
	if err := set("oidc.scopes", cfg.Scopes); err != nil {
		return err
	}
	if err := setBool("oidc.use_pkce", cfg.UsePKCE); err != nil {
		return err
	}
	if err := setBool("oidc.auto_discovery", cfg.AutoDiscovery); err != nil {
		return err
	}
	if err := set("oidc.authorization_url", cfg.AuthorizationURL); err != nil {
		return err
	}
	if err := set("oidc.token_url", cfg.TokenURL); err != nil {
		return err
	}
	if err := set("oidc.userinfo_url", cfg.UserinfoURL); err != nil {
		return err
	}
	if err := set("oidc.claim_username", cfg.ClaimUsername); err != nil {
		return err
	}
	if err := set("oidc.claim_email", cfg.ClaimEmail); err != nil {
		return err
	}
	if err := set("oidc.claim_name", cfg.ClaimName); err != nil {
		return err
	}
	if err := set("oidc.claim_groups", cfg.ClaimGroups); err != nil {
		return err
	}
	if err := set("oidc.default_role", cfg.DefaultRole); err != nil {
		return err
	}
	if err := set("oidc.group_role_map", cfg.GroupRoleMap); err != nil {
		return err
	}
	if err := setBool("oidc.allow_signup", cfg.AllowSignup); err != nil {
		return err
	}
	return nil
}

// resolvePanelBaseURL returns the Node.js console origin for OIDC session redirects.
// Priority: oidc.panel_url (DB) → PANEL_PUBLIC_URL → PUBLIC_URL env vars.
func resolvePanelBaseURL(cfg *auth.OIDCConfig) string {
	if cfg != nil {
		if base := auth.NormalizePanelBaseURL(cfg.PanelURL); base != "" && auth.IsValidPanelBaseURL(base) {
			return base
		}
	}
	for _, key := range []string{"PANEL_PUBLIC_URL", "PUBLIC_URL"} {
		if v := strings.TrimSpace(os.Getenv(key)); v != "" {
			base := auth.NormalizePanelBaseURL(v)
			if auth.IsValidPanelBaseURL(base) {
				return base
			}
		}
	}
	return ""
}

// oidcLoginRedirectURL builds a redirect to the panel login page with an OIDC error code.
func oidcLoginRedirectURL(cfg *auth.OIDCConfig, errCode string) string {
	panelBase := resolvePanelBaseURL(cfg)
	if panelBase != "" {
		return panelBase + "/login?error=" + url.QueryEscape(errCode)
	}
	return "/login?error=" + url.QueryEscape(errCode)
}

// handleGetOIDCConfig returns the current OIDC configuration.
// GET /api/auth/oidc/config
func (s *Server) handleGetOIDCConfig(w http.ResponseWriter, r *http.Request) {
	cfg := s.loadOIDCConfigFromDB()

	// Mask client secret for display
	if cfg.ClientSecret != "" {
		cfg.ClientSecret = "••••••••"
	}

	writeJSON(w, http.StatusOK, cfg)
}

// handleSaveOIDCConfig saves the OIDC configuration.
// PUT /api/auth/oidc/config
func (s *Server) handleSaveOIDCConfig(w http.ResponseWriter, r *http.Request) {
	var cfg auth.OIDCConfig
	if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid JSON"})
		return
	}

	// If secret is masked, preserve the existing one
	if cfg.ClientSecret == "••••••••" {
		existing := s.loadOIDCConfigFromDB()
		cfg.ClientSecret = existing.ClientSecret
	}

	// Basic validation
	if cfg.Enabled {
		if cfg.ClientID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Client ID is required when OIDC is enabled"})
			return
		}
		if cfg.IssuerURL == "" && (cfg.AuthorizationURL == "" || cfg.TokenURL == "") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Issuer URL or manual endpoint URLs are required"})
			return
		}
		if cfg.RedirectURL == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Redirect URL is required"})
			return
		}
	}

	if err := s.saveOIDCConfigToDB(&cfg); err != nil {
		log.Printf("[OIDC] Failed to save config: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to save configuration"})
		return
	}

	// Update the live provider
	if s.oidcProvider != nil {
		s.oidcProvider.UpdateConfig(&cfg)
	}

	log.Printf("[OIDC] Configuration updated (enabled=%v, issuer=%s)", cfg.Enabled, cfg.IssuerURL)

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleOIDCLoginOptions returns OIDC status for the login page.
// GET /api/auth/oidc/status
// Public endpoint — used by login page to show/hide SSO button.
func (s *Server) handleOIDCLoginStatus(w http.ResponseWriter, r *http.Request) {
	if s.oidcProvider == nil || !s.oidcProvider.IsEnabled() {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"enabled": false,
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"enabled":      true,
		"display_name": s.oidcProvider.GetDisplayName(),
	})
}

// handleSSOStatus reports whether any SSO provider (LDAP, OIDC) is enabled.
// GET /api/auth/sso/status
// Public endpoint — Node.js console queries this (cached) so it can delegate
// unknown-user logins to the Go server's LDAP/OIDC flow without requiring the
// admin to set BETTERDESK_AUTH_AUTOCREATE manually (#148).
func (s *Server) handleSSOStatus(w http.ResponseWriter, r *http.Request) {
	ldapEnabled := s.ldapProvider != nil && s.ldapProvider.IsEnabled()
	oidcEnabled := s.oidcProvider != nil && s.oidcProvider.IsEnabled()
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ldap_enabled": ldapEnabled,
		"oidc_enabled": oidcEnabled,
		"any_enabled":  ldapEnabled || oidcEnabled,
	})
}

// handleOIDCAuthorize starts the OIDC authorization code flow.
// GET /api/auth/oidc/authorize
// Public endpoint — redirects user to the IdP's authorization page.
func (s *Server) handleOIDCAuthorize(w http.ResponseWriter, r *http.Request) {
	if s.oidcProvider == nil || !s.oidcProvider.IsEnabled() {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "OIDC is not enabled"})
		return
	}

	// Only accept relative paths to prevent open-redirect via the IdP round-trip.
	returnURL := r.URL.Query().Get("return_url")
	if !auth.IsRelativeReturnURL(returnURL) {
		returnURL = "/"
	}

	authURL, _, err := s.oidcProvider.BuildAuthURL(returnURL)
	if err != nil {
		log.Printf("[OIDC] Failed to build auth URL: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to initiate OIDC login"})
		return
	}

	http.Redirect(w, r, authURL, http.StatusFound)
}

// handleOIDCCallback handles the IdP callback with the authorization code.
// GET /api/auth/oidc/callback and GET /api/oidc/callback
// Public endpoint — exchanges code for tokens, creates/updates user.
// Panel flow issues a one-time panel auth code; client flow completes pending poll.
func (s *Server) handleOIDCCallback(w http.ResponseWriter, r *http.Request) {
	if s.oidcProvider == nil || !s.oidcProvider.IsEnabled() {
		http.Error(w, "OIDC is not enabled", http.StatusBadRequest)
		return
	}

	cfg := s.loadOIDCConfigFromDB()
	stateParam := r.URL.Query().Get("state")

	// Check for error from IdP
	if errCode := r.URL.Query().Get("error"); errCode != "" {
		errDesc := r.URL.Query().Get("error_description")
		log.Printf("[OIDC] IdP returned error: %s — %s", errCode, errDesc)
		if pending := s.oidcProvider.PeekClientPending(stateParam); pending != nil {
			s.oidcProvider.FailClientPending(stateParam)
			writeClientOIDCResultPage(w, false, clientOIDCErrorMessage("oidc_denied"))
			return
		}
		http.Redirect(w, r, oidcLoginRedirectURL(cfg, "oidc_denied"), http.StatusFound)
		return
	}

	code := r.URL.Query().Get("code")
	state := stateParam

	if code == "" || state == "" {
		if pending := s.oidcProvider.PeekClientPending(state); pending != nil {
			s.oidcProvider.FailClientPending(state)
			writeClientOIDCResultPage(w, false, clientOIDCErrorMessage("oidc_invalid"))
			return
		}
		http.Redirect(w, r, oidcLoginRedirectURL(cfg, "oidc_invalid"), http.StatusFound)
		return
	}

	// Prefer client branch when a desktop poll session exists for this state
	// (covers races before ExchangeCode copies Flow onto the result).
	isClientPending := s.oidcProvider.PeekClientPending(state) != nil

	// Exchange code for tokens and user info
	result, err := s.oidcProvider.ExchangeCode(r.Context(), code, state)
	if err != nil {
		log.Printf("[OIDC] Code exchange failed: %v", err)
		if isClientPending {
			s.oidcProvider.FailClientPending(state)
			writeClientOIDCResultPage(w, false, clientOIDCErrorMessage("oidc_failed"))
			return
		}
		http.Redirect(w, r, oidcLoginRedirectURL(cfg, "oidc_failed"), http.StatusFound)
		return
	}

	if result.Flow == auth.OIDCFlowClient || isClientPending {
		if result.State == "" {
			result.State = state
		}
		s.finishClientOIDCCallback(w, r, result, cfg)
		return
	}

	loginErr := func(code string) {
		http.Redirect(w, r, oidcLoginRedirectURL(cfg, code), http.StatusFound)
	}

	user, errCode := s.ensureOIDCUser(result, cfg)
	if errCode != "" {
		loginErr(errCode)
		return
	}

	// Audit log
	if s.auditLog != nil {
		s.auditLog.Log(audit.ActionAuthLogin, s.remoteIP(r), user.Username, map[string]string{"method": "oidc"})
	}

	_ = s.db.UpdateUserLogin(user.ID)

	// Issue JWT token
	token, err := s.jwtManager.Generate(user.Username, user.Role)
	if err != nil {
		log.Printf("[OIDC] Failed to generate JWT for %s: %v", user.Username, err)
		loginErr("oidc_error")
		return
	}

	// Return URL was captured from OAuth state inside ExchangeCode.
	returnURL := result.ReturnURL
	if !auth.IsRelativeReturnURL(returnURL) {
		returnURL = "/"
	}

	// Store a one-time auth code that the panel will exchange via a
	// server-to-server POST to /api/auth/oidc/exchange. This prevents the
	// JWT from being exposed in the browser URL bar, Referer headers,
	// browser history, and access logs.
	authCode, err := s.oidcProvider.StoreAuthCode(token, user.Username, user.Role, returnURL)
	if err != nil {
		log.Printf("[OIDC] Failed to store auth code for %s: %v", user.Username, err)
		loginErr("oidc_error")
		return
	}

	// Redirect to Node.js session handler with ONLY the auth code.
	// Use an absolute panel URL when configured so Docker / split-port
	// deployments reach the console (port 5000), not the Go API port (#269).
	panelBase := resolvePanelBaseURL(cfg)
	callbackURL := auth.BuildOIDCSessionURL(panelBase, authCode)
	if panelBase == "" {
		log.Printf("[OIDC] Panel URL not configured — session redirect uses relative path (may fail on split-port setups)")
	}

	http.Redirect(w, r, callbackURL, http.StatusFound)
}

// handleOIDCSessionRedirect forwards browser session requests from the Go API
// port to the Node.js panel. GET /api/auth/oidc/session (public).
func (s *Server) handleOIDCSessionRedirect(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("code")
	cfg := s.loadOIDCConfigFromDB()
	panelBase := resolvePanelBaseURL(cfg)

	if code == "" {
		http.Redirect(w, r, oidcLoginRedirectURL(cfg, "oidc_invalid"), http.StatusFound)
		return
	}

	if panelBase == "" {
		log.Printf("[OIDC] GET /api/auth/oidc/session on Go API but panel URL is not configured")
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "OIDC panel URL is not configured — set Panel URL in Settings → Authentication → OIDC",
		})
		return
	}

	target := auth.BuildOIDCSessionURL(panelBase, code)
	http.Redirect(w, r, target, http.StatusFound)
}

// handleOIDCExchange exchanges a one-time auth code for the JWT + verified
// user identity. POST /api/auth/oidc/exchange (public, no auth — the code
// itself is the credential).
//
// Request body: {"code": "..."}
// Response:     {"token": "...", "username": "...", "role": "...", "return_url": "..."}
//
// Codes are single-use and expire after 60 seconds.
func (s *Server) handleOIDCExchange(w http.ResponseWriter, r *http.Request) {
	if s.oidcProvider == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "OIDC is not configured"})
		return
	}

	var req struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}

	entry := s.oidcProvider.ConsumeAuthCode(req.Code)
	if entry == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid or expired code"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"token":      entry.Token,
		"username":   entry.Username,
		"role":       entry.Role,
		"return_url": entry.ReturnURL,
	})
}

// handleGetOIDCEnabled returns whether OIDC is enabled and the display name.
// GET /api/auth/oidc/enabled  (public, no auth)
func (s *Server) handleGetOIDCEnabled(w http.ResponseWriter, r *http.Request) {
	enabled := false
	displayName := "SSO"
	if s.oidcProvider != nil && s.oidcProvider.IsEnabled() {
		enabled = true
		displayName = s.oidcProvider.GetDisplayName()
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"enabled":      enabled,
		"display_name": displayName,
	})
}

// handleTestOIDCDiscovery tests OIDC discovery by fetching .well-known/openid-configuration.
// POST /api/auth/oidc/test
func (s *Server) handleTestOIDCDiscovery(w http.ResponseWriter, r *http.Request) {
	var body struct {
		IssuerURL string `json:"issuer_url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid JSON"})
		return
	}

	if body.IssuerURL == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Issuer URL is required"})
		return
	}

	// Test by directly fetching the discovery document
	result, err := auth.TestOIDCDiscovery(r.Context(), body.IssuerURL)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"success": false,
			"error":   err.Error(),
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success":               true,
		"issuer":                result.Issuer,
		"authorization_endpoint": result.AuthorizationEndpoint,
		"token_endpoint":        result.TokenEndpoint,
		"userinfo_endpoint":     result.UserinfoEndpoint,
	})
}
