package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestNewOIDCProvider verifies that a provider is correctly created.
func TestNewOIDCProvider(t *testing.T) {
	cfg := &OIDCConfig{
		Enabled:   true,
		ClientID:  "test-client",
		IssuerURL: "https://example.com",
	}
	p := NewOIDCProvider(cfg)
	if p == nil {
		t.Fatal("expected non-nil provider")
	}
	if !p.IsEnabled() {
		t.Error("expected provider to be enabled")
	}
}

// TestOIDCProviderDisabled verifies IsEnabled returns false without client_id.
func TestOIDCProviderDisabled(t *testing.T) {
	cfg := &OIDCConfig{
		Enabled: true,
		// ClientID is empty
	}
	p := NewOIDCProvider(cfg)
	if p.IsEnabled() {
		t.Error("expected provider to be disabled without client_id")
	}
}

// TestOIDCProviderGetDisplayName verifies display name fallback.
func TestOIDCProviderGetDisplayName(t *testing.T) {
	tests := []struct {
		name     string
		display  string
		expected string
	}{
		{"custom name", "Azure AD", "Azure AD"},
		{"empty falls back", "", "SSO"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := NewOIDCProvider(&OIDCConfig{DisplayName: tt.display})
			got := p.GetDisplayName()
			if got != tt.expected {
				t.Errorf("got %q, want %q", got, tt.expected)
			}
		})
	}
}

// TestOIDCProviderUpdateConfig verifies config hot-reload.
func TestOIDCProviderUpdateConfig(t *testing.T) {
	p := NewOIDCProvider(&OIDCConfig{Enabled: false})
	if p.IsEnabled() {
		t.Fatal("should start disabled")
	}
	p.UpdateConfig(&OIDCConfig{Enabled: true, ClientID: "new-id"})
	if !p.IsEnabled() {
		t.Error("should be enabled after update")
	}
}

// TestBuildAuthURL verifies authorization URL construction.
func TestBuildAuthURL(t *testing.T) {
	cfg := &OIDCConfig{
		Enabled:          true,
		ClientID:         "my-client",
		RedirectURL:      "http://localhost/callback",
		Scopes:           "openid profile email",
		AuthorizationURL: "https://idp.example.com/authorize",
		UsePKCE:          true,
	}
	p := NewOIDCProvider(cfg)

	authURL, state, err := p.BuildAuthURL("/dashboard")
	if err != nil {
		t.Fatalf("BuildAuthURL error: %v", err)
	}
	if state == "" {
		t.Error("state should not be empty")
	}
	if !strings.Contains(authURL, "client_id=my-client") {
		t.Errorf("URL missing client_id: %s", authURL)
	}
	if !strings.Contains(authURL, "redirect_uri=") {
		t.Errorf("URL missing redirect_uri: %s", authURL)
	}
	if !strings.Contains(authURL, "scope=openid") {
		t.Errorf("URL missing scope: %s", authURL)
	}
	if !strings.Contains(authURL, "state=") {
		t.Errorf("URL missing state: %s", authURL)
	}
	if !strings.Contains(authURL, "nonce=") {
		t.Errorf("URL missing nonce: %s", authURL)
	}
	// PKCE
	if !strings.Contains(authURL, "code_challenge=") {
		t.Errorf("URL missing code_challenge (PKCE): %s", authURL)
	}
	if !strings.Contains(authURL, "code_challenge_method=S256") {
		t.Errorf("URL missing code_challenge_method: %s", authURL)
	}
}

// TestBuildAuthURLNoPKCE verifies URL without PKCE.
func TestBuildAuthURLNoPKCE(t *testing.T) {
	cfg := &OIDCConfig{
		Enabled:          true,
		ClientID:         "client",
		RedirectURL:      "http://localhost/callback",
		Scopes:           "openid",
		AuthorizationURL: "https://idp.example.com/authorize",
		UsePKCE:          false,
	}
	p := NewOIDCProvider(cfg)

	authURL, _, err := p.BuildAuthURL("/")
	if err != nil {
		t.Fatalf("BuildAuthURL error: %v", err)
	}
	if strings.Contains(authURL, "code_challenge=") {
		t.Errorf("URL should NOT contain code_challenge when PKCE disabled: %s", authURL)
	}
}

// TestBuildAuthURLNoEndpoint verifies error when endpoint is missing.
func TestBuildAuthURLNoEndpoint(t *testing.T) {
	cfg := &OIDCConfig{
		Enabled:  true,
		ClientID: "client",
		// No AuthorizationURL and no discovery
	}
	p := NewOIDCProvider(cfg)
	_, _, err := p.BuildAuthURL("/")
	if err == nil {
		t.Error("expected error when no authorization endpoint configured")
	}
}

// TestGetReturnURL verifies state → returnURL mapping.
func TestGetReturnURL(t *testing.T) {
	cfg := &OIDCConfig{
		Enabled:          true,
		ClientID:         "client",
		RedirectURL:      "http://localhost/callback",
		Scopes:           "openid",
		AuthorizationURL: "https://idp.example.com/authorize",
	}
	p := NewOIDCProvider(cfg)

	_, state, err := p.BuildAuthURL("/my-page")
	if err != nil {
		t.Fatalf("BuildAuthURL error: %v", err)
	}

	returnURL := p.GetReturnURL(state)
	if returnURL != "/my-page" {
		t.Errorf("got return URL %q, want %q", returnURL, "/my-page")
	}

	// Unknown state returns empty
	unknown := p.GetReturnURL("unknown-state")
	if unknown != "" {
		t.Errorf("expected empty for unknown state, got %q", unknown)
	}
}

// TestResolveRole verifies group → role mapping.
func TestResolveRole(t *testing.T) {
	tests := []struct {
		name        string
		roleMap     string
		defaultRole string
		groups      []string
		expected    string
	}{
		{
			"admin group maps to admin",
			"admins=admin|operators=operator",
			"viewer",
			[]string{"admins", "users"},
			"admin",
		},
		{
			"operator group",
			"admins=admin|ops=operator",
			"viewer",
			[]string{"ops", "users"},
			"operator",
		},
		{
			"no match returns default",
			"admins=admin|ops=operator",
			"viewer",
			[]string{"users", "developers"},
			"viewer",
		},
		{
			"pipe-separated multiple",
			"admins=admin|ops=operator|devs=viewer",
			"",
			[]string{"ops"},
			"operator",
		},
		{
			"empty groups returns default",
			"admins=admin",
			"viewer",
			[]string{},
			"viewer",
		},
		{
			"empty role map returns default",
			"",
			"viewer",
			[]string{"admins"},
			"viewer",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := &OIDCConfig{GroupRoleMap: tt.roleMap, DefaultRole: tt.defaultRole}
			p := NewOIDCProvider(cfg)
			got := p.resolveRole(tt.groups)
			if got != tt.expected {
				t.Errorf("resolveRole(%v) = %q, want %q", tt.groups, got, tt.expected)
			}
		})
	}
}

// TestParseJWTPayload verifies JWT payload extraction.
func TestParseJWTPayload(t *testing.T) {
	// Build a fake JWT with header.payload.signature
	payload := map[string]interface{}{
		"sub":                "user123",
		"preferred_username": "john.doe",
		"email":             "john@example.com",
		"name":             "John Doe",
		"groups":           []string{"admins", "users"},
	}
	payloadJSON, _ := json.Marshal(payload)
	payloadB64 := base64.RawURLEncoding.EncodeToString(payloadJSON)

	// Construct minimal JWT (header.payload.signature)
	fakeJWT := "eyJhbGciOiJSUzI1NiJ9." + payloadB64 + ".fakesignature"

	claims, err := parseJWTPayload(fakeJWT)
	if err != nil {
		t.Fatalf("parseJWTPayload error: %v", err)
	}

	if claims["sub"] != "user123" {
		t.Errorf("sub claim = %v, want user123", claims["sub"])
	}
	if claims["preferred_username"] != "john.doe" {
		t.Errorf("preferred_username = %v, want john.doe", claims["preferred_username"])
	}
}

// TestTestOIDCDiscovery verifies the discovery test function.
func TestTestOIDCDiscovery(t *testing.T) {
	// Mock OIDC discovery server
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/openid-configuration" {
			http.NotFound(w, r)
			return
		}
		disc := map[string]string{
			"issuer":                 "https://example.com",
			"authorization_endpoint": "https://example.com/authorize",
			"token_endpoint":         "https://example.com/token",
			"userinfo_endpoint":      "https://example.com/userinfo",
		}
		json.NewEncoder(w).Encode(disc)
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result, err := TestOIDCDiscovery(ctx, srv.URL)
	if err != nil {
		t.Fatalf("TestOIDCDiscovery error: %v", err)
	}
	if result.AuthorizationEndpoint != "https://example.com/authorize" {
		t.Errorf("authorization_endpoint = %q", result.AuthorizationEndpoint)
	}
	if result.TokenEndpoint != "https://example.com/token" {
		t.Errorf("token_endpoint = %q", result.TokenEndpoint)
	}
}

// TestTestOIDCDiscoveryInvalidURL tests discovery with unreachable URL.
func TestTestOIDCDiscoveryInvalidURL(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	_, err := TestOIDCDiscovery(ctx, "http://192.0.2.1:1") // RFC 5737 TEST-NET
	if err == nil {
		t.Error("expected error for unreachable URL")
	}
}

// TestExchangeCodeInvalidState verifies that invalid state is rejected.
func TestExchangeCodeInvalidState(t *testing.T) {
	p := NewOIDCProvider(&OIDCConfig{
		Enabled:  true,
		ClientID: "client",
		TokenURL: "http://localhost/token",
	})

	_, err := p.ExchangeCode(context.Background(), "code123", "invalid-state")
	if err == nil {
		t.Error("expected error for invalid state")
	}
	if !strings.Contains(err.Error(), "invalid or expired state") {
		t.Errorf("unexpected error: %v", err)
	}
}

// TestCleanupStates verifies that expired states are cleaned up.
func TestCleanupStates(t *testing.T) {
	cfg := &OIDCConfig{
		Enabled:          true,
		ClientID:         "client",
		AuthorizationURL: "https://idp.example.com/authorize",
		RedirectURL:      "http://localhost/callback",
		Scopes:           "openid",
	}
	p := NewOIDCProvider(cfg)

	// Create a state entry
	_, state, _ := p.BuildAuthURL("/")

	// Verify it exists
	p.mu.RLock()
	_, exists := p.states[state]
	p.mu.RUnlock()
	if !exists {
		t.Fatal("state should exist after BuildAuthURL")
	}

	// Manually expire it
	p.mu.Lock()
	if s, ok := p.states[state]; ok {
		s.CreatedAt = time.Now().Add(-20 * time.Minute) // 20 min ago (beyond 15 min TTL)
	}
	p.mu.Unlock()

	// Run cleanup manually (normally runs on ticker)
	p.mu.Lock()
	for k, v := range p.states {
		if time.Since(v.CreatedAt) > 15*time.Minute {
			delete(p.states, k)
		}
	}
	p.mu.Unlock()

	// Verify it's gone
	p.mu.RLock()
	_, exists = p.states[state]
	p.mu.RUnlock()
	if exists {
		t.Error("expired state should have been cleaned up")
	}
}
