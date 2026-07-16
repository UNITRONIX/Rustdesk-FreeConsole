package db

import (
	"testing"
	"time"
)

func TestClientSessionLifecycleSQLite(t *testing.T) {
	database := openTestSQLiteDB(t)
	defer database.Close()

	user := &User{Username: "sessionuser", PasswordHash: "hash", Role: "admin"}
	if err := database.CreateUser(user); err != nil {
		t.Fatal(err)
	}

	expires := time.Now().UTC().Add(7 * 24 * time.Hour).Format("2006-01-02 15:04:05")
	sess := &ClientSession{
		TokenHash:  "abc123hash",
		UserID:     user.ID,
		ClientID:   "device1",
		ClientUUID: "uuid1",
		ExpiresAt:  expires,
		IPAddress:  "127.0.0.1",
	}
	if err := database.CreateClientSession(sess); err != nil {
		t.Fatal(err)
	}

	got, err := database.GetClientSessionByTokenHash("abc123hash")
	if err != nil {
		t.Fatal(err)
	}
	if got == nil || got.UserID != user.ID {
		t.Fatalf("expected active session, got %#v", got)
	}

	newExpiry := time.Now().UTC().Add(14 * 24 * time.Hour).Format("2006-01-02 15:04:05")
	now := time.Now().UTC().Format("2006-01-02 15:04:05")
	if err := database.TouchClientSession(got.ID, newExpiry, now); err != nil {
		t.Fatal(err)
	}

	if err := database.RevokeClientSessionsForDevice(user.ID, "device1", "uuid1"); err != nil {
		t.Fatal(err)
	}

	got, err = database.GetClientSessionByTokenHash("abc123hash")
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatal("expected revoked session to be invisible")
	}
}

func TestGetActiveClientSessionByClient(t *testing.T) {
	database := openTestSQLiteDB(t)
	defer database.Close()

	user := &User{Username: "owner1", PasswordHash: "hash", Role: "admin"}
	if err := database.CreateUser(user); err != nil {
		t.Fatal(err)
	}

	expires := time.Now().UTC().Add(7 * 24 * time.Hour).Format("2006-01-02 15:04:05")
	if err := database.CreateClientSession(&ClientSession{
		TokenHash:  "hash-a",
		UserID:     user.ID,
		ClientID:   "dev-a",
		ClientUUID: "uuid-a",
		ExpiresAt:  expires,
	}); err != nil {
		t.Fatal(err)
	}

	got, err := database.GetActiveClientSessionByClient("dev-a", "")
	if err != nil || got == nil || got.TokenHash != "hash-a" {
		t.Fatalf("by client_id: err=%v got=%#v", err, got)
	}

	got, err = database.GetActiveClientSessionByClient("", "uuid-a")
	if err != nil || got == nil || got.TokenHash != "hash-a" {
		t.Fatalf("by client_uuid: err=%v got=%#v", err, got)
	}

	got, err = database.GetActiveClientSessionByClient("missing", "missing-uuid")
	if err != nil || got != nil {
		t.Fatalf("expected nil for unknown client, err=%v got=%#v", err, got)
	}
}

func TestBindPeerOwnerAndApplyActiveSessionOwner(t *testing.T) {
	database := openTestSQLiteDB(t)
	defer database.Close()

	user := &User{Username: "bounduser", PasswordHash: "hash", Role: "operator"}
	if err := database.CreateUser(user); err != nil {
		t.Fatal(err)
	}
	if err := database.UpsertPeer(&Peer{ID: "P-OWN", UUID: "u-own", Status: "ONLINE"}); err != nil {
		t.Fatal(err)
	}

	BindPeerOwner(database, "P-OWN", "u-own", "bounduser")
	peer, _ := database.GetPeer("P-OWN")
	if peer == nil || peer.User != "bounduser" {
		t.Fatalf("BindPeerOwner failed: %#v", peer)
	}

	// Login-before-peer: clear user, create session, re-apply via session lookup.
	_ = database.UpdatePeerFields("P-OWN", map[string]string{"user": ""})
	expires := time.Now().UTC().Add(24 * time.Hour).Format("2006-01-02 15:04:05")
	if err := database.CreateClientSession(&ClientSession{
		TokenHash:  "hash-own",
		UserID:     user.ID,
		ClientID:   "P-OWN",
		ClientUUID: "u-own",
		ExpiresAt:  expires,
	}); err != nil {
		t.Fatal(err)
	}
	ApplyActiveSessionOwner(database, "P-OWN", "u-own")
	peer, _ = database.GetPeer("P-OWN")
	if peer == nil || peer.User != "bounduser" {
		t.Fatalf("ApplyActiveSessionOwner failed: %#v", peer)
	}
}

func openTestSQLiteDB(t *testing.T) Database {
	t.Helper()
	db, err := OpenSQLite(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatal(err)
	}
	return db
}
