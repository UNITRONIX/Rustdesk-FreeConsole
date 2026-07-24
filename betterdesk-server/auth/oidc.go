// Package auth — OIDC/OAuth2 authentication provider for BetterDesk server.
//
// Supports OpenID Connect Authorization Code Flow with:
//   - Auto-discovery via .well-known/openid-configuration
//   - Manual endpoint configuration (for non-compliant IdPs)
//   - PKCE (S256) for public/confidential clients
//   - UserInfo endpoint for claim extraction
//   - Claim → role mapping
//   - Auto-provisioning of local user accounts on first OIDC login
//   - State + nonce CSRF protection
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// OIDCConfig holds all OIDC provider settings.
// Stored in server_config table with "oidc." prefix.
type OIDCConfig struct {
	Enabled          bool   `json:"enabled"`
	DisplayName      string `json:"display_name"`      // Button label, e.g. "Google", "Azure AD"
	IssuerURL        string `json:"issuer_url"`        // e.g. "https://accounts.google.com"
	ClientID         string `json:"client_id"`         // OAuth2 client ID
	ClientSecret     string `json:"client_secret"`     // OAuth2 client secret
	RedirectURL      string `json:"redirect_url"`      // e.g. "https://betterdesk.example.com/api/auth/oidc/callback"
	PanelURL         string `json:"panel_url"`         // e.g. "https://betterdesk.example.com" (Node console origin)
	Scopes           string `json:"scopes"`            // space-separated, default "openid profile email"
	UsePKCE          bool   `json:"use_pkce"`          // enable PKCE (S256)
	AutoDiscovery    bool   `json:"auto_discovery"`    // use .well-known/openid-configuration
	AuthorizationURL string `json:"authorization_url"` // manual: authorization endpoint
	TokenURL         string `json:"token_url"`         // manual: token endpoint
	UserinfoURL      string `json:"userinfo_url"`      // manual: userinfo endpoint
	ClaimUsername    string `json:"claim_username"`    // claim for username (default: preferred_username)
	ClaimEmail       string `json:"claim_email"`       // claim for email (default: email)
	ClaimName        string `json:"claim_name"`        // claim for display name (default: name)
	ClaimGroups      string `json:"claim_groups"`      // claim for groups (default: groups)
	DefaultRole      string `json:"default_role"`      // role for users without group mapping (default: viewer)
	GroupRoleMap     string `json:"group_role_map"`    // pipe-delimited: "GroupName=role|GroupName=role"
	AllowSignup      bool   `json:"allow_signup"`      // allow auto-creation of new users
}

// OIDC flow kinds stored in OAuth state.
const (
	OIDCFlowPanel  = "panel"  // web console login
	OIDCFlowClient = "client" // stock RustDesk desktop client
)

// OIDCResult represents the outcome of an OIDC authentication.
type OIDCResult struct {
	Authenticated bool
	Username      string
	DisplayName   string
	Email         string
	Role          string
	Groups        []string
	IDToken       string // raw ID token for audit
	ReturnURL     string // post-login relative path from OAuth state
	Flow          string // OIDCFlowPanel or OIDCFlowClient
	ClientID      string
	ClientUUID    string
	State         string // OAuth state (= client poll code for client flow)
}

// oidcDiscovery holds discovered OIDC endpoints.
type oidcDiscovery struct {
	AuthorizationEndpoint string `json:"authorization_endpoint"`
	TokenEndpoint         string `json:"token_endpoint"`
	UserinfoEndpoint      string `json:"userinfo_endpoint"`
	Issuer                string `json:"issuer"`
}

// oidcState holds pending authorization state for CSRF protection.
type oidcState struct {
	Nonce        string
	CodeVerifier string // PKCE
	CreatedAt    time.Time
	ReturnURL    string // where to redirect after login (panel flow)
	Flow         string // OIDCFlowPanel (default) or OIDCFlowClient
	ClientID     string
	ClientUUID   string
	DeviceName   string
	DeviceOS     string
	DeviceType   string
}

// ClientOIDCPending tracks a RustDesk desktop OIDC login until auth-query consumes it.
type ClientOIDCPending struct {
	ClientID   string
	ClientUUID string
	DeviceName string
	DeviceOS   string
	DeviceType string
	UserID     int64
	Username   string
	Role       string
	Authed     bool
	CreatedAt  time.Time
}

// oidcAuthCode is a one-time-use code that the panel exchanges (over a
// server-to-server POST) for the JWT + verified user identity. This avoids
// passing the JWT through the browser URL bar (which would leak it via
// browser history, Referer headers, and access logs).
type oidcAuthCode struct {
	Token     string
	Username  string
	Role      string
	ReturnURL string // already validated as a relative path
	CreatedAt time.Time
}

// OIDCProvider manages OIDC authentication.
type OIDCProvider struct {
	mu            sync.RWMutex
	config        *OIDCConfig
	discovery     *oidcDiscovery
	states        map[string]*oidcState         // state → oidcState
	codes         map[string]*oidcAuthCode      // one-time auth codes for panel exchange
	clientPending map[string]*ClientOIDCPending // state/code → RustDesk client OIDC pending
	client        *http.Client
}

// NewOIDCProvider creates a new OIDC provider with the given configuration.
func NewOIDCProvider(cfg *OIDCConfig) *OIDCProvider {
	p := &OIDCProvider{
		config:        cfg,
		states:        make(map[string]*oidcState),
		codes:         make(map[string]*oidcAuthCode),
		clientPending: make(map[string]*ClientOIDCPending),
		client:        &http.Client{Timeout: 15 * time.Second},
	}
	if cfg.Enabled && cfg.AutoDiscovery && cfg.IssuerURL != "" {
		go p.discover()
	}
	// Start state cleanup goroutine
	go p.cleanupStates()
	return p
}

// IsEnabled returns whether OIDC authentication is active.
func (p *OIDCProvider) IsEnabled() bool {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.config != nil && p.config.Enabled && p.config.ClientID != ""
}

// GetConfig returns a copy of the current OIDC config (thread-safe).
func (p *OIDCProvider) GetConfig() OIDCConfig {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.config == nil {
		return OIDCConfig{}
	}
	return *p.config
}

// UpdateConfig replaces the current configuration and triggers re-discovery.
func (p *OIDCProvider) UpdateConfig(cfg *OIDCConfig) {
	p.mu.Lock()
	p.config = cfg
	p.discovery = nil
	p.mu.Unlock()
	if cfg.Enabled && cfg.AutoDiscovery && cfg.IssuerURL != "" {
		go p.discover()
	}
}

// GetDisplayName returns the configured button label or a default.
func (p *OIDCProvider) GetDisplayName() string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.config != nil && p.config.DisplayName != "" {
		return p.config.DisplayName
	}
	return "SSO"
}

// discover fetches the OIDC discovery document from issuer_url/.well-known/openid-configuration.
func (p *OIDCProvider) discover() {
	p.mu.RLock()
	issuer := p.config.IssuerURL
	p.mu.RUnlock()

	if issuer == "" {
		return
	}

	discoveryURL := strings.TrimRight(issuer, "/") + "/.well-known/openid-configuration"
	resp, err := fetchValidatedHTTPGet(p.client, discoveryURL)
	if err != nil {
		log.Printf("[OIDC] Discovery failed for %s: %v", issuer, err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("[OIDC] Discovery returned %d for %s", resp.StatusCode, discoveryURL)
		return
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20)) // 1MB limit
	if err != nil {
		log.Printf("[OIDC] Discovery read error: %v", err)
		return
	}

	var disc oidcDiscovery
	if err := json.Unmarshal(body, &disc); err != nil {
		log.Printf("[OIDC] Discovery parse error: %v", err)
		return
	}

	p.mu.Lock()
	p.discovery = &disc
	p.mu.Unlock()

	log.Printf("[OIDC] Discovery OK: auth=%s, token=%s", disc.AuthorizationEndpoint, disc.TokenEndpoint)
}

// getAuthEndpoint returns the authorization endpoint URL.
func (p *OIDCProvider) getAuthEndpoint() string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.config.AuthorizationURL != "" {
		return p.config.AuthorizationURL
	}
	if p.discovery != nil {
		return p.discovery.AuthorizationEndpoint
	}
	return ""
}

// getTokenEndpoint returns the token endpoint URL.
func (p *OIDCProvider) getTokenEndpoint() string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.config.TokenURL != "" {
		return p.config.TokenURL
	}
	if p.discovery != nil {
		return p.discovery.TokenEndpoint
	}
	return ""
}

// getUserinfoEndpoint returns the userinfo endpoint URL.
func (p *OIDCProvider) getUserinfoEndpoint() string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.config.UserinfoURL != "" {
		return p.config.UserinfoURL
	}
	if p.discovery != nil {
		return p.discovery.UserinfoEndpoint
	}
	return ""
}

// BuildAuthURL constructs the OIDC authorization URL for panel (web console) login.
func (p *OIDCProvider) BuildAuthURL(returnURL string) (string, string, error) {
	return p.buildAuthURL(oidcState{
		ReturnURL: returnURL,
		Flow:      OIDCFlowPanel,
	})
}

// ClientDeviceInfo is device metadata from the RustDesk desktop client.
type ClientDeviceInfo struct {
	Name string
	OS   string
	Type string
}

// BuildClientAuthURL starts OIDC for the stock RustDesk desktop client.
// The returned code is the OAuth state value; the client polls auth-query with it.
func (p *OIDCProvider) BuildClientAuthURL(clientID, clientUUID string, device ClientDeviceInfo) (authURL, code string, err error) {
	authURL, code, err = p.buildAuthURL(oidcState{
		Flow:       OIDCFlowClient,
		ClientID:   clientID,
		ClientUUID: clientUUID,
		DeviceName: device.Name,
		DeviceOS:   device.OS,
		DeviceType: device.Type,
	})
	if err != nil {
		return "", "", err
	}
	p.mu.Lock()
	p.clientPending[code] = &ClientOIDCPending{
		ClientID:   clientID,
		ClientUUID: clientUUID,
		DeviceName: device.Name,
		DeviceOS:   device.OS,
		DeviceType: device.Type,
		CreatedAt:  time.Now(),
	}
	p.mu.Unlock()
	return authURL, code, nil
}

func (p *OIDCProvider) buildAuthURL(base oidcState) (string, string, error) {
	authEP := p.getAuthEndpoint()
	if authEP == "" {
		return "", "", fmt.Errorf("authorization endpoint not configured")
	}

	p.mu.RLock()
	cfg := *p.config
	p.mu.RUnlock()

	// Generate state token (CSRF protection)
	state, err := generateRandomString(32)
	if err != nil {
		return "", "", fmt.Errorf("generate state: %w", err)
	}

	// Generate nonce
	nonce, err := generateRandomString(32)
	if err != nil {
		return "", "", fmt.Errorf("generate nonce: %w", err)
	}

	stateEntry := &oidcState{
		Nonce:      nonce,
		CreatedAt:  time.Now(),
		ReturnURL:  base.ReturnURL,
		Flow:       base.Flow,
		ClientID:   base.ClientID,
		ClientUUID: base.ClientUUID,
		DeviceName: base.DeviceName,
		DeviceOS:   base.DeviceOS,
		DeviceType: base.DeviceType,
	}
	if stateEntry.Flow == "" {
		stateEntry.Flow = OIDCFlowPanel
	}

	params := url.Values{
		"response_type": {"code"},
		"client_id":     {cfg.ClientID},
		"redirect_uri":  {cfg.RedirectURL},
		"state":         {state},
		"nonce":         {nonce},
	}

	scopes := cfg.Scopes
	if scopes == "" {
		scopes = "openid profile email"
	}
	params.Set("scope", scopes)

	// PKCE
	if cfg.UsePKCE {
		verifier, err := generateRandomString(64)
		if err != nil {
			return "", "", fmt.Errorf("generate PKCE verifier: %w", err)
		}
		stateEntry.CodeVerifier = verifier

		h := sha256.Sum256([]byte(verifier))
		challenge := base64.RawURLEncoding.EncodeToString(h[:])
		params.Set("code_challenge", challenge)
		params.Set("code_challenge_method", "S256")
	}

	// Store state
	p.mu.Lock()
	p.states[state] = stateEntry
	p.mu.Unlock()

	return authEP + "?" + params.Encode(), state, nil
}

// ExchangeCode exchanges an authorization code for tokens and user info.
func (p *OIDCProvider) ExchangeCode(ctx context.Context, code, state string) (*OIDCResult, error) {
	// Validate and consume state
	p.mu.Lock()
	stateEntry, ok := p.states[state]
	if ok {
		delete(p.states, state)
	}
	p.mu.Unlock()

	if !ok {
		return nil, fmt.Errorf("invalid or expired state parameter")
	}

	returnURL := stateEntry.ReturnURL
	flow := stateEntry.Flow
	if flow == "" {
		flow = OIDCFlowPanel
	}
	clientID := stateEntry.ClientID
	clientUUID := stateEntry.ClientUUID
	oauthState := state

	// Check state age (10 minute max)
	if time.Since(stateEntry.CreatedAt) > 10*time.Minute {
		return nil, fmt.Errorf("state parameter expired")
	}

	tokenEP := p.getTokenEndpoint()
	if tokenEP == "" {
		return nil, fmt.Errorf("token endpoint not configured")
	}

	p.mu.RLock()
	cfg := *p.config
	p.mu.RUnlock()

	// Token exchange
	params := url.Values{
		"grant_type":   {"authorization_code"},
		"code":         {code},
		"redirect_uri": {cfg.RedirectURL},
		"client_id":    {cfg.ClientID},
	}
	if cfg.ClientSecret != "" {
		params.Set("client_secret", cfg.ClientSecret)
	}
	if cfg.UsePKCE && stateEntry.CodeVerifier != "" {
		params.Set("code_verifier", stateEntry.CodeVerifier)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", tokenEP, strings.NewReader(params.Encode()))
	if err != nil {
		return nil, fmt.Errorf("create token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("token request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read token response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("token endpoint returned %d: %s", resp.StatusCode, string(body))
	}

	var tokenResp struct {
		AccessToken  string `json:"access_token"`
		IDToken      string `json:"id_token"`
		TokenType    string `json:"token_type"`
		ExpiresIn    int    `json:"expires_in"`
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return nil, fmt.Errorf("parse token response: %w", err)
	}

	if tokenResp.AccessToken == "" {
		return nil, fmt.Errorf("no access_token in token response")
	}

	// Extract claims from ID token (JWT payload, no signature verification —
	// we trust the TLS connection to the IdP's token endpoint)
	claims := make(map[string]interface{})
	if tokenResp.IDToken != "" {
		if parsed, err := parseJWTPayload(tokenResp.IDToken); err == nil {
			claims = parsed
		}
	}

	// Fetch userinfo for additional claims
	userinfoClaims, err := p.fetchUserInfo(ctx, tokenResp.AccessToken)
	if err != nil {
		log.Printf("[OIDC] UserInfo fetch failed (non-fatal): %v", err)
	} else {
		// Merge userinfo claims (userinfo takes precedence)
		for k, v := range userinfoClaims {
			claims[k] = v
		}
	}

	// Map claims to result
	result := &OIDCResult{
		Authenticated: true,
		IDToken:       tokenResp.IDToken,
	}

	claimUsername := cfg.ClaimUsername
	if claimUsername == "" {
		claimUsername = "preferred_username"
	}
	claimEmail := cfg.ClaimEmail
	if claimEmail == "" {
		claimEmail = "email"
	}
	claimName := cfg.ClaimName
	if claimName == "" {
		claimName = "name"
	}
	claimGroups := cfg.ClaimGroups
	if claimGroups == "" {
		claimGroups = "groups"
	}

	result.Username = getStringClaim(claims, claimUsername)
	result.Email = getStringClaim(claims, claimEmail)
	result.DisplayName = getStringClaim(claims, claimName)
	result.Groups = getStringSliceClaim(claims, claimGroups)

	// Fallback: use email prefix as username if preferred_username is empty
	if result.Username == "" && result.Email != "" {
		if idx := strings.Index(result.Email, "@"); idx > 0 {
			result.Username = result.Email[:idx]
		}
	}

	if result.Username == "" {
		// Last resort: use "sub" claim
		result.Username = getStringClaim(claims, "sub")
	}

	if result.Username == "" {
		return nil, fmt.Errorf("could not determine username from OIDC claims")
	}

	// Map groups to role
	result.Role = p.resolveRole(result.Groups)
	result.ReturnURL = returnURL
	result.Flow = flow
	result.ClientID = clientID
	result.ClientUUID = clientUUID
	result.State = oauthState

	return result, nil
}

// GetReturnURL retrieves the return URL stored with a state parameter.
func (p *OIDCProvider) GetReturnURL(state string) string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if entry, ok := p.states[state]; ok {
		return entry.ReturnURL
	}
	return ""
}

// fetchUserInfo calls the UserInfo endpoint with an access token.
func (p *OIDCProvider) fetchUserInfo(ctx context.Context, accessToken string) (map[string]interface{}, error) {
	userinfoEP := p.getUserinfoEndpoint()
	if userinfoEP == "" {
		return nil, fmt.Errorf("userinfo endpoint not available")
	}

	req, err := http.NewRequestWithContext(ctx, "GET", userinfoEP, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("userinfo returned %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}

	var claims map[string]interface{}
	if err := json.Unmarshal(body, &claims); err != nil {
		return nil, err
	}
	return claims, nil
}

// resolveRole maps OIDC groups to a BetterDesk role using the configured group-role map.
func (p *OIDCProvider) resolveRole(groups []string) string {
	p.mu.RLock()
	cfg := *p.config
	p.mu.RUnlock()

	if len(groups) == 0 || cfg.GroupRoleMap == "" {
		return cfg.DefaultRole
	}

	roleMap := parseGroupRoleMap(cfg.GroupRoleMap)
	if len(roleMap) == 0 {
		return cfg.DefaultRole
	}

	bestRole := cfg.DefaultRole
	bestLevel := roleLevel(bestRole)

	for _, group := range groups {
		if role, ok := roleMap[group]; ok {
			if lvl := roleLevel(role); lvl > bestLevel {
				bestRole = role
				bestLevel = lvl
			}
		}
	}

	return bestRole
}

// cleanupStates removes expired state entries every 5 minutes.
func (p *OIDCProvider) cleanupStates() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		p.mu.Lock()
		now := time.Now()
		for k, v := range p.states {
			if now.Sub(v.CreatedAt) > 15*time.Minute {
				delete(p.states, k)
			}
		}
		// Auth codes are short-lived (60s); anything older is stale.
		for k, v := range p.codes {
			if now.Sub(v.CreatedAt) > 60*time.Second {
				delete(p.codes, k)
			}
		}
		// Client OIDC pending (auth + poll window ~3–10 min).
		for k, v := range p.clientPending {
			if now.Sub(v.CreatedAt) > 10*time.Minute {
				delete(p.clientPending, k)
			}
		}
		p.mu.Unlock()
	}
}

// CompleteClientPending marks a RustDesk client OIDC poll code as authenticated.
func (p *OIDCProvider) CompleteClientPending(code string, userID int64, username, role string) bool {
	if code == "" || username == "" {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	entry, ok := p.clientPending[code]
	if !ok {
		return false
	}
	if time.Since(entry.CreatedAt) > 10*time.Minute {
		delete(p.clientPending, code)
		return false
	}
	entry.UserID = userID
	entry.Username = username
	entry.Role = role
	entry.Authed = true
	return true
}

// PeekClientPending returns a copy of the pending client OIDC entry without consuming it.
func (p *OIDCProvider) PeekClientPending(code string) *ClientOIDCPending {
	if code == "" {
		return nil
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	entry, ok := p.clientPending[code]
	if !ok {
		return nil
	}
	if time.Since(entry.CreatedAt) > 10*time.Minute {
		return nil
	}
	cp := *entry
	return &cp
}

// ConsumeClientPending atomically retrieves and deletes an authenticated client pending entry.
func (p *OIDCProvider) ConsumeClientPending(code string) *ClientOIDCPending {
	if code == "" {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	entry, ok := p.clientPending[code]
	if !ok {
		return nil
	}
	delete(p.clientPending, code)
	if time.Since(entry.CreatedAt) > 10*time.Minute || !entry.Authed {
		return nil
	}
	cp := *entry
	return &cp
}

// FailClientPending removes a pending client OIDC entry (e.g. after IdP error).
func (p *OIDCProvider) FailClientPending(code string) {
	if code == "" {
		return
	}
	p.mu.Lock()
	delete(p.clientPending, code)
	p.mu.Unlock()
}

// ClientLoginOptionToken returns the login-options string stock RustDesk expects (oidc/<name>).
func (p *OIDCProvider) ClientLoginOptionToken() string {
	name := strings.TrimSpace(p.GetDisplayName())
	if name == "" {
		name = "oidc"
	}
	// Keep spaces — Flutter uses the substring after "oidc/" as the op name.
	return "oidc/" + name
}

// NormalizePanelBaseURL trims whitespace and trailing slashes from a panel origin URL.
func NormalizePanelBaseURL(u string) string {
	return strings.TrimRight(strings.TrimSpace(u), "/")
}

// IsValidPanelBaseURL validates a panel origin (scheme + host only, http/https).
func IsValidPanelBaseURL(u string) bool {
	u = NormalizePanelBaseURL(u)
	if u == "" {
		return false
	}
	if strings.ContainsAny(u, "\r\n\x00") {
		return false
	}
	parsed, err := url.Parse(u)
	if err != nil || parsed.Host == "" {
		return false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return false
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return false
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	return true
}

// BuildOIDCSessionURL builds the browser redirect target after IdP callback.
// When panelBase is empty, returns a relative path (legacy split-port behavior).
func BuildOIDCSessionURL(panelBase, authCode string) string {
	path := "/api/auth/oidc/session?code=" + url.QueryEscape(authCode)
	base := NormalizePanelBaseURL(panelBase)
	if base == "" || !IsValidPanelBaseURL(base) {
		return path
	}
	return base + path
}

// IsRelativeReturnURL validates that a return URL is a safe relative path.
// It rejects:
//   - empty strings
//   - absolute URLs (http://, https://, etc.)
//   - protocol-relative URLs (//evil.com/...)
//   - URLs containing CR/LF (response splitting)
//   - URLs not starting with a single "/"
func IsRelativeReturnURL(u string) bool {
	if u == "" {
		return false
	}
	if strings.ContainsAny(u, "\r\n\x00") {
		return false
	}
	if !strings.HasPrefix(u, "/") {
		return false
	}
	if strings.HasPrefix(u, "//") || strings.HasPrefix(u, "/\\") {
		return false
	}
	// Reject anything that parses as an absolute URL with a host component.
	if parsed, err := url.Parse(u); err == nil {
		if parsed.Scheme != "" || parsed.Host != "" {
			return false
		}
	}
	return true
}

// StoreAuthCode generates a one-time code that maps to a JWT + verified user
// identity. The panel (Node.js) exchanges the code via a server-to-server
// POST to /api/auth/oidc/exchange. Codes expire after 60 seconds.
func (p *OIDCProvider) StoreAuthCode(token, username, role, returnURL string) (string, error) {
	code, err := generateRandomString(32)
	if err != nil {
		return "", err
	}
	p.mu.Lock()
	p.codes[code] = &oidcAuthCode{
		Token:     token,
		Username:  username,
		Role:      role,
		ReturnURL: returnURL,
		CreatedAt: time.Now(),
	}
	p.mu.Unlock()
	return code, nil
}

// ConsumeAuthCode atomically retrieves and deletes a one-time auth code.
// Returns the stored entry or nil if the code is unknown, already used, or
// older than 60 seconds.
func (p *OIDCProvider) ConsumeAuthCode(code string) *oidcAuthCode {
	if code == "" {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	entry, ok := p.codes[code]
	if !ok {
		return nil
	}
	delete(p.codes, code)
	if time.Since(entry.CreatedAt) > 60*time.Second {
		return nil
	}
	return entry
}

// roleLevel returns a numeric priority for role comparison (highest privilege wins).
func roleLevel(role string) int {
	switch strings.ToLower(role) {
	case "super_admin", "admin":
		return 5
	case "server_admin":
		return 4
	case "global_admin":
		return 4
	case "operator":
		return 2
	case "viewer":
		return 1
	case "pro":
		return 0
	default:
		return 0
	}
}

// parseJWTPayload extracts the payload from a JWT without verifying the signature.
// Used only for tokens received directly from the IdP's token endpoint over TLS.
func parseJWTPayload(token string) (map[string]interface{}, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("invalid JWT format")
	}

	// Add padding if needed
	payload := parts[1]
	switch len(payload) % 4 {
	case 2:
		payload += "=="
	case 3:
		payload += "="
	}

	decoded, err := base64.URLEncoding.DecodeString(payload)
	if err != nil {
		// Try without padding (raw URL encoding)
		decoded, err = base64.RawURLEncoding.DecodeString(parts[1])
		if err != nil {
			return nil, fmt.Errorf("decode JWT payload: %w", err)
		}
	}

	var claims map[string]interface{}
	if err := json.Unmarshal(decoded, &claims); err != nil {
		return nil, fmt.Errorf("parse JWT claims: %w", err)
	}
	return claims, nil
}

// getStringClaim extracts a string value from a claims map.
func getStringClaim(claims map[string]interface{}, key string) string {
	v, ok := claims[key]
	if !ok {
		return ""
	}
	s, ok := v.(string)
	if ok {
		return s
	}
	return fmt.Sprintf("%v", v)
}

// getStringSliceClaim extracts a string slice from a claims map.
func getStringSliceClaim(claims map[string]interface{}, key string) []string {
	v, ok := claims[key]
	if !ok {
		return nil
	}
	switch val := v.(type) {
	case []interface{}:
		result := make([]string, 0, len(val))
		for _, item := range val {
			if s, ok := item.(string); ok {
				result = append(result, s)
			}
		}
		return result
	case []string:
		return val
	case string:
		// Some IdPs return groups as a space/comma-separated string
		return strings.FieldsFunc(val, func(r rune) bool { return r == ',' || r == ' ' })
	default:
		return nil
	}
}

// generateRandomString creates a cryptographically secure random string.
func generateRandomString(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// OIDCDiscoveryResult holds the result of a discovery document test.
type OIDCDiscoveryResult struct {
	Issuer                string `json:"issuer"`
	AuthorizationEndpoint string `json:"authorization_endpoint"`
	TokenEndpoint         string `json:"token_endpoint"`
	UserinfoEndpoint      string `json:"userinfo_endpoint"`
}

// TestOIDCDiscovery fetches and validates an OIDC discovery document.
func TestOIDCDiscovery(ctx context.Context, issuerURL string) (*OIDCDiscoveryResult, error) {
	discoveryURL := strings.TrimRight(issuerURL, "/") + "/.well-known/openid-configuration"
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := fetchValidatedHTTPGetContext(ctx, client, discoveryURL)
	if err != nil {
		return nil, fmt.Errorf("discovery URL: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("discovery endpoint returned HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	var disc OIDCDiscoveryResult
	if err := json.Unmarshal(body, &disc); err != nil {
		return nil, fmt.Errorf("parse discovery document: %w", err)
	}

	if disc.AuthorizationEndpoint == "" {
		return nil, fmt.Errorf("discovery document missing authorization_endpoint")
	}
	if disc.TokenEndpoint == "" {
		return nil, fmt.Errorf("discovery document missing token_endpoint")
	}

	return &disc, nil
}
