package api

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"
	"time"
)

func TestHandleClientLoginIssuesOpaqueSessionToken(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()
	createClientLoginTestUser(t, database, "admin", "correct-password", false)

	srv := newClientLoginTestServer(database)
	rec, resp := postClientLogin(t, srv, map[string]any{
		"username": "admin",
		"password": "correct-password",
		"type":     "account",
		"id":       "testdev1",
		"uuid":     "test-uuid-1",
	})

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	token, _ := resp["access_token"].(string)
	if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(token) {
		t.Fatalf("expected 64-char hex token, got %q", token)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/currentUser", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	username, role, ok := srv.authenticateClientSession(token)
	if !ok || username != "admin" || role == "" {
		t.Fatalf("authenticateClientSession failed: ok=%v user=%q role=%q", ok, username, role)
	}
}

func TestHandleClientLogoutRevokesSession(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()
	createClientLoginTestUser(t, database, "admin", "correct-password", false)

	srv := newClientLoginTestServer(database)
	_, resp := postClientLogin(t, srv, map[string]any{
		"username": "admin",
		"password": "correct-password",
		"type":     "account",
		"id":       "testdev2",
		"uuid":     "test-uuid-2",
	})
	token, _ := resp["access_token"].(string)

	logoutReq := httptest.NewRequest(http.MethodPost, "/api/logout", nil)
	logoutReq.Header.Set("Authorization", "Bearer "+token)
	logoutRec := httptest.NewRecorder()
	srv.handleClientLogout(logoutRec, logoutReq)

	if logoutRec.Code != http.StatusOK {
		t.Fatalf("logout status = %d", logoutRec.Code)
	}
	if _, _, ok := srv.authenticateClientSession(token); ok {
		t.Fatal("expected token to be revoked after logout")
	}
}

func TestClientSessionSlidingExtendsExpiry(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()
	createClientLoginTestUser(t, database, "admin", "correct-password", false)

	srv := newClientLoginTestServer(database)
	_, resp := postClientLogin(t, srv, map[string]any{
		"username": "admin",
		"password": "correct-password",
		"type":     "account",
		"id":       "testdev3",
		"uuid":     "test-uuid-3",
	})
	token, _ := resp["access_token"].(string)

	before, _ := database.GetClientSessionByTokenHash(hashClientToken(token))
	if before == nil {
		t.Fatal("session not found")
	}

	// Simulate a session near expiry so sliding renewal has visible effect.
	nearExpiry := time.Now().UTC().Add(time.Hour).Format("2006-01-02 15:04:05")
	if err := database.TouchClientSession(before.ID, nearExpiry, formatClientSessionTime(time.Now().UTC())); err != nil {
		t.Fatal(err)
	}
	before, _ = database.GetClientSessionByTokenHash(hashClientToken(token))

	if _, _, ok := srv.authenticateClientSession(token); !ok {
		t.Fatal("expected valid session")
	}

	after, _ := database.GetClientSessionByTokenHash(hashClientToken(token))
	if after == nil {
		t.Fatal("session missing after touch")
	}
	if after.ExpiresAt <= before.ExpiresAt {
		t.Fatalf("expected sliding expiry to extend session: before=%s after=%s", before.ExpiresAt, after.ExpiresAt)
	}
}
