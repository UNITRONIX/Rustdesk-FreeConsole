package api

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/unitronix/betterdesk-server/auth"
	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/peer"
)

func testDeleteUserRequest(port int, userID int64) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodDelete, fmt.Sprintf("http://127.0.0.1:%d/api/users/%d", port, userID), nil)
	if err != nil {
		return nil, err
	}
	return http.DefaultClient.Do(testAuthReq(req))
}

func TestDeleteUserBlocksLastSuperAdmin(t *testing.T) {
	cfg := config.DefaultConfig()
	database := testSetupDB(t)
	defer database.Close()

	hash, err := auth.HashPassword("secret123")
	if err != nil {
		t.Fatal(err)
	}
	admin := &db.User{
		Username:     "sole-super",
		PasswordHash: hash,
		Role:         auth.RoleSuperAdmin,
		AuthProvider: db.AuthProviderLocal,
	}
	if err := database.CreateUser(admin); err != nil {
		t.Fatal(err)
	}

	peerMap := peer.NewMap()
	cfg.APIPort = 19890
	srv := New(cfg, database, peerMap, nil, "1.0.0-test")
	if err := srv.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	time.Sleep(100 * time.Millisecond)

	resp, err := testDeleteUserRequest(cfg.APIPort, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("DELETE last super_admin: status %d, want 409", resp.StatusCode)
	}
}

func TestDeleteUserAllowsWhenAnotherSuperAdminExists(t *testing.T) {
	cfg := config.DefaultConfig()
	database := testSetupDB(t)
	defer database.Close()

	hash, err := auth.HashPassword("secret123")
	if err != nil {
		t.Fatal(err)
	}
	first := &db.User{
		Username:     "super-one",
		PasswordHash: hash,
		Role:         auth.RoleSuperAdmin,
		AuthProvider: db.AuthProviderLocal,
	}
	second := &db.User{
		Username:     "super-two",
		PasswordHash: hash,
		Role:         auth.RoleSuperAdmin,
		AuthProvider: db.AuthProviderLocal,
	}
	if err := database.CreateUser(first); err != nil {
		t.Fatal(err)
	}
	if err := database.CreateUser(second); err != nil {
		t.Fatal(err)
	}

	peerMap := peer.NewMap()
	cfg.APIPort = 19891
	srv := New(cfg, database, peerMap, nil, "1.0.0-test")
	if err := srv.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	time.Sleep(100 * time.Millisecond)

	resp, err := testDeleteUserRequest(cfg.APIPort, second.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("DELETE non-last super_admin: status %d, want 200", resp.StatusCode)
	}
}

// Issue #292: delete/demote must succeed when another user has NULL last_login
// (previously ListUsers scanned NULL into string and returned 500).
func TestDeleteUserSucceedsWithNullLastLoginSibling(t *testing.T) {
	cfg := config.DefaultConfig()
	database := testSetupDB(t)
	defer database.Close()

	hash, err := auth.HashPassword("secret123")
	if err != nil {
		t.Fatal(err)
	}
	admin := &db.User{
		Username:     "admin-292",
		PasswordHash: hash,
		Role:         auth.RoleSuperAdmin,
		AuthProvider: db.AuthProviderLocal,
	}
	target := &db.User{
		Username:     "fresh-292",
		PasswordHash: hash,
		Role:         auth.RoleViewer,
		AuthProvider: db.AuthProviderLocal,
	}
	if err := database.CreateUser(admin); err != nil {
		t.Fatal(err)
	}
	if err := database.CreateUser(target); err != nil {
		t.Fatal(err)
	}

	sqliteDB, ok := database.(*db.SQLiteDB)
	if !ok {
		t.Fatal("expected SQLiteDB test backend")
	}
	if err := sqliteDB.NullifyUserLoginFieldsForTest(target.ID); err != nil {
		t.Fatalf("force NULL last_login: %v", err)
	}

	peerMap := peer.NewMap()
	cfg.APIPort = 19892
	srv := New(cfg, database, peerMap, nil, "1.0.0-test")
	if err := srv.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	time.Sleep(100 * time.Millisecond)

	// Listing must not 500 when any user has NULL last_login.
	listResp, err := testAuthGet(fmt.Sprintf("http://127.0.0.1:%d/api/users", cfg.APIPort))
	if err != nil {
		t.Fatal(err)
	}
	defer listResp.Body.Close()
	if listResp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/users with NULL last_login: status %d, want 200", listResp.StatusCode)
	}

	resp, err := testDeleteUserRequest(cfg.APIPort, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("DELETE user with NULL last_login: status %d, want 200", resp.StatusCode)
	}
}

func TestDemoteUserSucceedsWithNullLastLoginSibling(t *testing.T) {
	cfg := config.DefaultConfig()
	database := testSetupDB(t)
	defer database.Close()

	hash, err := auth.HashPassword("secret123")
	if err != nil {
		t.Fatal(err)
	}
	admin := &db.User{
		Username:     "admin-demote-292",
		PasswordHash: hash,
		Role:         auth.RoleSuperAdmin,
		AuthProvider: db.AuthProviderLocal,
	}
	operator := &db.User{
		Username:     "op-demote-292",
		PasswordHash: hash,
		Role:         auth.RoleOperator,
		AuthProvider: db.AuthProviderLocal,
	}
	if err := database.CreateUser(admin); err != nil {
		t.Fatal(err)
	}
	if err := database.CreateUser(operator); err != nil {
		t.Fatal(err)
	}

	sqliteDB, ok := database.(*db.SQLiteDB)
	if !ok {
		t.Fatal("expected SQLiteDB test backend")
	}
	if err := sqliteDB.NullifyUserLoginFieldsForTest(operator.ID); err != nil {
		t.Fatalf("force NULL last_login: %v", err)
	}

	peerMap := peer.NewMap()
	cfg.APIPort = 19893
	srv := New(cfg, database, peerMap, nil, "1.0.0-test")
	if err := srv.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	time.Sleep(100 * time.Millisecond)

	body := `{"role":"viewer"}`
	req, err := http.NewRequest(http.MethodPut,
		fmt.Sprintf("http://127.0.0.1:%d/api/users/%d", cfg.APIPort, operator.ID),
		strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(testAuthReq(req))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT demote with NULL last_login: status %d, want 200", resp.StatusCode)
	}
}
