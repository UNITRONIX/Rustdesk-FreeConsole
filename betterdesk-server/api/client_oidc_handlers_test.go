package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/unitronix/betterdesk-server/auth"
)

func TestHandleClientLoginOptionsOIDC(t *testing.T) {
	s := &Server{
		oidcProvider: auth.NewOIDCProvider(&auth.OIDCConfig{
			Enabled:     true,
			ClientID:    "cid",
			DisplayName: "Keycloak",
		}),
	}

	req := httptest.NewRequest(http.MethodGet, "/api/login-options", nil)
	rec := httptest.NewRecorder()
	s.handleClientLoginOptions(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	var opts []string
	if err := json.Unmarshal(rec.Body.Bytes(), &opts); err != nil {
		t.Fatal(err)
	}
	if len(opts) != 2 || opts[0] != "" || opts[1] != "oidc/Keycloak" {
		t.Fatalf("opts = %#v", opts)
	}
}

func TestHandleClientLoginOptionsPasswordOnly(t *testing.T) {
	s := &Server{}
	req := httptest.NewRequest(http.MethodGet, "/api/login-options", nil)
	rec := httptest.NewRecorder()
	s.handleClientLoginOptions(rec, req)

	var opts []string
	_ = json.Unmarshal(rec.Body.Bytes(), &opts)
	if len(opts) != 1 || opts[0] != "" {
		t.Fatalf("opts = %#v", opts)
	}
}

func TestHandleClientOIDCAuthRequiresEnabled(t *testing.T) {
	s := &Server{oidcProvider: auth.NewOIDCProvider(&auth.OIDCConfig{Enabled: false})}
	req := httptest.NewRequest(http.MethodPost, "/api/oidc/auth", strings.NewReader(`{"id":"1","uuid":"u"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.handleClientOIDCAuth(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
}

func TestHandleClientOIDCAuthQueryWaiting(t *testing.T) {
	p := auth.NewOIDCProvider(&auth.OIDCConfig{
		Enabled: true, ClientID: "c",
		AuthorizationURL: "https://idp.example.com/a",
		RedirectURL:      "http://localhost/cb",
	})
	_, code, err := p.BuildClientAuthURL("dev", "uuid", auth.ClientDeviceInfo{})
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{oidcProvider: p}

	req := httptest.NewRequest(http.MethodGet, "/api/oidc/auth-query?code="+code+"&id=dev&uuid=uuid", nil)
	rec := httptest.NewRecorder()
	s.handleClientOIDCAuthQuery(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	var body map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body["error"] != "No authed oidc is found" {
		t.Fatalf("body = %#v", body)
	}
}

func TestHandleClientOIDCAuthQueryDeviceMismatch(t *testing.T) {
	p := auth.NewOIDCProvider(&auth.OIDCConfig{
		Enabled: true, ClientID: "c",
		AuthorizationURL: "https://idp.example.com/a",
		RedirectURL:      "http://localhost/cb",
	})
	_, code, err := p.BuildClientAuthURL("dev", "uuid", auth.ClientDeviceInfo{})
	if err != nil {
		t.Fatal(err)
	}
	if !p.CompleteClientPending(code, 1, "alice", "viewer") {
		t.Fatal("complete failed")
	}
	s := &Server{oidcProvider: p}

	req := httptest.NewRequest(http.MethodGet, "/api/oidc/auth-query?code="+code+"&id=other&uuid=uuid", nil)
	rec := httptest.NewRecorder()
	s.handleClientOIDCAuthQuery(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
}

func TestHandleClientOIDCAuthQueryOmittingDeviceRejected(t *testing.T) {
	p := auth.NewOIDCProvider(&auth.OIDCConfig{
		Enabled: true, ClientID: "c",
		AuthorizationURL: "https://idp.example.com/a",
		RedirectURL:      "http://localhost/cb",
	})
	_, code, err := p.BuildClientAuthURL("dev", "uuid", auth.ClientDeviceInfo{})
	if err != nil {
		t.Fatal(err)
	}
	if !p.CompleteClientPending(code, 1, "alice", "viewer") {
		t.Fatal("complete failed")
	}
	s := &Server{oidcProvider: p}

	req := httptest.NewRequest(http.MethodGet, "/api/oidc/auth-query?code="+code, nil)
	rec := httptest.NewRecorder()
	s.handleClientOIDCAuthQuery(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
}

func TestHandleClientOIDCAuthQuerySuccessIncludesUserInfo(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()
	createClientLoginTestUser(t, database, "alice", "unused-password", false)

	user, err := database.GetUser("alice")
	if err != nil || user == nil {
		t.Fatalf("GetUser: %v", err)
	}

	p := auth.NewOIDCProvider(&auth.OIDCConfig{
		Enabled: true, ClientID: "c",
		AuthorizationURL: "https://idp.example.com/a",
		RedirectURL:      "http://localhost/cb",
	})
	_, code, err := p.BuildClientAuthURL("dev1", "uuid1", auth.ClientDeviceInfo{})
	if err != nil {
		t.Fatal(err)
	}
	if !p.CompleteClientPending(code, user.ID, user.Username, user.Role) {
		t.Fatal("complete failed")
	}

	s := newClientLoginTestServer(database)
	s.oidcProvider = p

	req := httptest.NewRequest(http.MethodGet, "/api/oidc/auth-query?code="+code+"&id=dev1&uuid=uuid1", nil)
	rec := httptest.NewRecorder()
	s.handleClientOIDCAuthQuery(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["type"] != "access_token" {
		t.Fatalf("type = %#v", body["type"])
	}
	token, _ := body["access_token"].(string)
	if token == "" {
		t.Fatal("expected access_token")
	}
	userObj, ok := body["user"].(map[string]any)
	if !ok {
		t.Fatalf("user = %#v", body["user"])
	}
	if _, ok := userObj["info"].(map[string]any); !ok {
		t.Fatalf("user.info missing or wrong type: %#v", userObj["info"])
	}
	if userObj["name"] != "alice" {
		t.Fatalf("user.name = %#v", userObj["name"])
	}
}

func TestRustdeskUserPayloadHasInfo(t *testing.T) {
	payload := rustdeskUserPayload("bob", auth.RoleAdmin)
	info, ok := payload["info"].(map[string]any)
	if !ok || info == nil {
		t.Fatalf("info = %#v", payload["info"])
	}
	if payload["is_admin"] != true {
		t.Fatalf("is_admin = %#v", payload["is_admin"])
	}
}
