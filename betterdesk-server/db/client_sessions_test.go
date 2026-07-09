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
