package guestaccess

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/unitronix/betterdesk-server/db"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "guest.db")
	database, err := db.OpenSQLite(path)
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	if err := database.Migrate(); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	t.Cleanup(func() { database.Close() })
	return &Store{DB: database}
}

func TestCreateValidateRevoke(t *testing.T) {
	store := newStore(t)
	token, grant, err := store.Create([]string{"DEV111", "DEV222"}, "alice", 30, true, "vendor", 0)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if token == "" || grant == nil || grant.ID == "" {
		t.Fatal("expected token and grant")
	}
	if len(grant.PeerIDs) != 2 {
		t.Fatalf("peer ids: %v", grant.PeerIDs)
	}

	g, err := store.Validate(token, "DEV111")
	if err != nil {
		t.Fatalf("Validate DEV111: %v", err)
	}
	if !g.ViewOnly {
		t.Fatal("expected view_only")
	}

	if _, err := store.Validate(token, "OTHER"); err == nil {
		t.Fatal("expected reject for peer outside allowlist")
	}

	ok, err := store.RevokeByID(grant.ID, "alice", false)
	if err != nil || !ok {
		t.Fatalf("Revoke: ok=%v err=%v", ok, err)
	}
	if _, err := store.Validate(token, "DEV111"); err == nil {
		t.Fatal("expected reject after revoke")
	}
}

func TestExpiry(t *testing.T) {
	store := newStore(t)
	token, grant, err := store.Create([]string{"PEER01"}, "bob", 1, false, "", 0)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	grant.ExpiresAt = time.Now().UTC().Add(-time.Minute)
	b, err := json.Marshal(grant)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.DB.SetConfig(configPrefix+hashToken(token), string(b)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Validate(token, "PEER01"); err == nil {
		t.Fatal("expected expired")
	}
}
