package api

import (
	"fmt"
	"net/http"
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
