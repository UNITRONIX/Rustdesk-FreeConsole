package api

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"
	"time"

	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/db"
)

func TestHandleClientLoginBindsPeerOwner(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()
	createClientLoginTestUser(t, database, "admin", "correct-password", false)

	if err := database.UpsertPeer(&db.Peer{
		ID:     "testdev-bind",
		UUID:   "test-uuid-bind",
		Status: "ONLINE",
	}); err != nil {
		t.Fatalf("UpsertPeer: %v", err)
	}

	srv := newClientLoginTestServer(database)
	rec, _ := postClientLogin(t, srv, map[string]any{
		"username": "admin",
		"password": "correct-password",
		"type":     "account",
		"id":       "testdev-bind",
		"uuid":     "test-uuid-bind",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	peer, err := database.GetPeer("testdev-bind")
	if err != nil || peer == nil {
		t.Fatalf("GetPeer: %v peer=%v", err, peer)
	}
	if peer.User != "admin" {
		t.Fatalf("peers.user = %q, want %q", peer.User, "admin")
	}
}

func TestApplyActiveSessionOwnerBindsAfterPeerAppears(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()
	createClientLoginTestUser(t, database, "admin", "correct-password", false)

	srv := newClientLoginTestServer(database)
	rec, _ := postClientLogin(t, srv, map[string]any{
		"username": "admin",
		"password": "correct-password",
		"type":     "account",
		"id":       "late-peer-1",
		"uuid":     "late-uuid-1",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("login status = %d; body=%s", rec.Code, rec.Body.String())
	}

	// Peer did not exist at login time.
	if peer, _ := database.GetPeer("late-peer-1"); peer != nil {
		t.Fatal("expected no peer yet")
	}

	if err := database.UpsertPeer(&db.Peer{
		ID:     "late-peer-1",
		UUID:   "late-uuid-1",
		Status: "ONLINE",
	}); err != nil {
		t.Fatalf("UpsertPeer: %v", err)
	}

	db.ApplyActiveSessionOwner(database, "late-peer-1", "late-uuid-1")

	peer, err := database.GetPeer("late-peer-1")
	if err != nil || peer == nil {
		t.Fatalf("GetPeer: %v", err)
	}
	if peer.User != "admin" {
		t.Fatalf("peers.user = %q, want admin after ApplyActiveSessionOwner", peer.User)
	}
}

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

func TestIsMissingClientSessionsTable(t *testing.T) {
	cases := []struct {
		err  error
		want bool
	}{
		{nil, false},
		{fmt.Errorf("db: CreateClientSession: no such table: client_sessions"), true},
		{fmt.Errorf(`ERROR: relation "client_sessions" does not exist (SQLSTATE 42P01)`), true},
		{fmt.Errorf("FOREIGN KEY constraint failed"), false},
	}
	for _, tc := range cases {
		if got := isMissingClientSessionsTable(tc.err); got != tc.want {
			t.Errorf("isMissingClientSessionsTable(%v) = %v, want %v", tc.err, got, tc.want)
		}
	}
}

func TestIssueClientSessionRejectsZeroUserID(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()
	srv := newClientLoginTestServer(database)
	_, err := srv.issueClientSession(&db.User{ID: 0, Username: "nobody"}, "dev", "uuid", "127.0.0.1")
	if err == nil {
		t.Fatal("expected error for user id 0")
	}
}

func TestManagedLoginQueuesViewerEnrollment(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()
	createClientLoginTestUser(t, database, "admin", "correct-password", false)

	srv := newClientLoginTestServer(database)
	srv.cfg.EnrollmentMode = config.EnrollmentModeManaged

	rec, _ := postClientLogin(t, srv, map[string]any{
		"username": "admin",
		"password": "correct-password",
		"type":     "account",
		"id":       "viewer-ios-375",
		"uuid":     "viewer-uuid-375",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("login status = %d; body=%s", rec.Code, rec.Body.String())
	}

	pending, err := database.GetConfig("pending_device_viewer-ios-375")
	if err != nil || pending == "" {
		t.Fatalf("expected pending_device_viewer-ios-375, got %q err=%v", pending, err)
	}
	if peer, _ := database.GetPeer("viewer-ios-375"); peer != nil {
		t.Fatal("login must not auto-create approved peer")
	}
}

func TestLockedLoginDoesNotQueueViewerEnrollment(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()
	createClientLoginTestUser(t, database, "admin", "correct-password", false)

	srv := newClientLoginTestServer(database)
	srv.cfg.EnrollmentMode = config.EnrollmentModeLocked

	rec, _ := postClientLogin(t, srv, map[string]any{
		"username": "admin",
		"password": "correct-password",
		"type":     "account",
		"id":       "locked-viewer-375",
		"uuid":     "locked-uuid-375",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("login status = %d; body=%s", rec.Code, rec.Body.String())
	}

	pending, err := database.GetConfig("pending_device_locked-viewer-375")
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	if pending != "" {
		t.Fatalf("locked login must not queue pending, got %q", pending)
	}
}

func TestManagedLoginSkipsRejectedViewerEnrollment(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()
	createClientLoginTestUser(t, database, "admin", "correct-password", false)
	if err := database.SetConfig("rejected_device_rej-viewer-375", `{"device_id":"rej-viewer-375"}`); err != nil {
		t.Fatalf("SetConfig: %v", err)
	}

	srv := newClientLoginTestServer(database)
	srv.cfg.EnrollmentMode = config.EnrollmentModeManaged

	rec, _ := postClientLogin(t, srv, map[string]any{
		"username": "admin",
		"password": "correct-password",
		"type":     "account",
		"id":       "rej-viewer-375",
		"uuid":     "rej-uuid-375",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("login status = %d; body=%s", rec.Code, rec.Body.String())
	}

	pending, err := database.GetConfig("pending_device_rej-viewer-375")
	if err != nil {
		t.Fatalf("GetConfig: %v", err)
	}
	if pending != "" {
		t.Fatalf("rejected device must not re-queue, got %q", pending)
	}
}

func TestIssueClientSessionRecoversMissingTable(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()
	createClientLoginTestUser(t, database, "admin", "correct-password", false)

	if err := db.DropClientSessionsTableForTest(database); err != nil {
		t.Fatalf("DropClientSessionsTableForTest: %v", err)
	}

	srv := newClientLoginTestServer(database)
	rec, resp := postClientLogin(t, srv, map[string]any{
		"username": "admin",
		"password": "correct-password",
		"type":     "account",
		"id":       "recover-dev",
		"uuid":     "recover-uuid",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	token, _ := resp["access_token"].(string)
	if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(token) {
		t.Fatalf("access_token = %q, want 64-hex", token)
	}
}
