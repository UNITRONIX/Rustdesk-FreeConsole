package db

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func newTestDB(t *testing.T) *SQLiteDB {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "test.db")
	db, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestOpenAndMigrate(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.db")
	db, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	defer db.Close()

	if err := db.Migrate(); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	// Migrate again should be idempotent
	if err := db.Migrate(); err != nil {
		t.Fatalf("Migrate (second): %v", err)
	}

	// File should exist
	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Error("database file not created")
	}
}

func TestUpsertAndGetPeer(t *testing.T) {
	db := newTestDB(t)

	peer := &Peer{
		ID:         "TESTPEER1",
		UUID:       "uuid-1234",
		IP:         "192.168.1.100",
		Hostname:   "desktop-1",
		OS:         "Windows 10",
		Version:    "1.2.3",
		Status:     "ONLINE",
		NATType:    1,
		LastOnline: time.Now().Truncate(time.Second),
	}

	if err := db.UpsertPeer(peer); err != nil {
		t.Fatalf("UpsertPeer: %v", err)
	}

	got, err := db.GetPeer("TESTPEER1")
	if err != nil {
		t.Fatalf("GetPeer: %v", err)
	}
	if got == nil {
		t.Fatal("GetPeer returned nil")
	}

	if got.ID != "TESTPEER1" {
		t.Errorf("ID: got %q, want %q", got.ID, "TESTPEER1")
	}
	if got.Hostname != "desktop-1" {
		t.Errorf("Hostname: got %q, want %q", got.Hostname, "desktop-1")
	}
	if got.Status != "ONLINE" {
		t.Errorf("Status: got %q, want %q", got.Status, "ONLINE")
	}
}

func TestUpsertPeerUpdate(t *testing.T) {
	db := newTestDB(t)

	// Insert
	if err := db.UpsertPeer(&Peer{ID: "P1", Hostname: "host-a", IP: "1.2.3.4", Status: "ONLINE"}); err != nil {
		t.Fatal(err)
	}

	// Update — hostname should be kept (COALESCE with non-empty)
	if err := db.UpsertPeer(&Peer{ID: "P1", IP: "5.6.7.8", Status: "OFFLINE"}); err != nil {
		t.Fatal(err)
	}

	got, _ := db.GetPeer("P1")
	if got.IP != "5.6.7.8" {
		t.Errorf("IP not updated: %q", got.IP)
	}
	if got.Hostname != "host-a" {
		t.Errorf("Hostname should be preserved: got %q", got.Hostname)
	}
}

func TestGetPeerNotFound(t *testing.T) {
	db := newTestDB(t)

	got, err := db.GetPeer("NONEXISTENT")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != nil {
		t.Errorf("expected nil for missing peer, got %+v", got)
	}
}

func TestListPeers(t *testing.T) {
	db := newTestDB(t)

	for _, id := range []string{"A", "B", "C"} {
		db.UpsertPeer(&Peer{ID: id, Status: "ONLINE"})
	}

	peers, err := db.ListPeers(false)
	if err != nil {
		t.Fatal(err)
	}
	if len(peers) != 3 {
		t.Errorf("expected 3 peers, got %d", len(peers))
	}
}

func TestSoftDelete(t *testing.T) {
	db := newTestDB(t)

	db.UpsertPeer(&Peer{ID: "DEL1", Status: "ONLINE"})
	if err := db.DeletePeer("DEL1"); err != nil {
		t.Fatal(err)
	}

	// Should not appear in normal list
	peers, _ := db.ListPeers(false)
	for _, p := range peers {
		if p.ID == "DEL1" {
			t.Error("soft-deleted peer should not appear in normal list")
		}
	}

	// Should appear with includeDeleted
	peers, _ = db.ListPeers(true)
	found := false
	for _, p := range peers {
		if p.ID == "DEL1" {
			found = true
			if !p.SoftDeleted {
				t.Error("soft_deleted flag should be true")
			}
		}
	}
	if !found {
		t.Error("soft-deleted peer should appear with includeDeleted=true")
	}
}

func TestUpsertDoesNotRestoreSoftDeletedPeer(t *testing.T) {
	// SECURITY (GHSA-3v82-3gf8-fxx8): UpsertPeer must NOT silently clear
	// soft_deleted on conflict. Restoration must happen via RestorePeer.
	db := newTestDB(t)

	if err := db.UpsertPeer(&Peer{ID: "RESTORE1", Status: "ONLINE", IP: "10.0.0.1"}); err != nil {
		t.Fatal(err)
	}
	if err := db.DeletePeer("RESTORE1"); err != nil {
		t.Fatal(err)
	}
	if deleted, err := db.IsPeerSoftDeleted("RESTORE1"); err != nil || !deleted {
		t.Fatalf("peer should be soft-deleted, deleted=%v err=%v", deleted, err)
	}

	// A second upsert (e.g. attacker re-registering under the deleted ID)
	// must NOT bring the row back from the trash bin.
	if err := db.UpsertPeer(&Peer{ID: "RESTORE1", Status: "ONLINE", IP: "10.0.0.2"}); err != nil {
		t.Fatal(err)
	}

	if deleted, err := db.IsPeerSoftDeleted("RESTORE1"); err != nil || !deleted {
		t.Fatalf("peer must remain soft-deleted after upsert, deleted=%v err=%v", deleted, err)
	}

	// GetPeer filters soft-deleted rows, so the peer is invisible.
	peer, err := db.GetPeer("RESTORE1")
	if err != nil {
		t.Fatal(err)
	}
	if peer != nil {
		t.Error("soft-deleted peer must not be visible to GetPeer after upsert")
	}

	// Explicit restore brings it back.
	if err := db.RestorePeer("RESTORE1"); err != nil {
		t.Fatalf("RestorePeer: %v", err)
	}
	peer, err = db.GetPeer("RESTORE1")
	if err != nil {
		t.Fatal(err)
	}
	if peer == nil {
		t.Fatal("restored peer should be visible")
	}
	if peer.SoftDeleted {
		t.Error("restored peer should not remain soft-deleted")
	}
	if peer.DeletedAt != nil {
		t.Error("restored peer should clear deleted_at")
	}
}

func TestUpdatePeerStatusIgnoresSoftDeleted(t *testing.T) {
	db := newTestDB(t)

	if err := db.UpsertPeer(&Peer{ID: "STATDEL1", Status: "OFFLINE", IP: "10.0.0.5"}); err != nil {
		t.Fatal(err)
	}
	if err := db.DeletePeer("STATDEL1"); err != nil {
		t.Fatal(err)
	}
	if err := db.UpdatePeerStatus("STATDEL1", "ONLINE", "10.0.0.99"); err != nil {
		t.Fatal(err)
	}

	peers, err := db.ListPeers(true)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range peers {
		if p.ID == "STATDEL1" {
			if p.Status == "ONLINE" {
				t.Fatal("UpdatePeerStatus must not mark soft-deleted peer ONLINE")
			}
			if p.IP == "10.0.0.99" {
				t.Fatal("UpdatePeerStatus must not update IP on soft-deleted peer")
			}
		}
	}
}

func TestBatchUpdatePeerStatus(t *testing.T) {
	db := newTestDB(t)

	for _, id := range []string{"BATCH1", "BATCH2"} {
		if err := db.UpsertPeer(&Peer{ID: id, Status: "ONLINE", IP: "10.0.0.1"}); err != nil {
			t.Fatal(err)
		}
	}

	if err := db.BatchUpdatePeerStatus([]string{"BATCH1", "BATCH2", "MISSING1"}, "DEGRADED"); err != nil {
		t.Fatal(err)
	}

	check := func(id, wantStatus string) {
		t.Helper()
		p, err := db.GetPeer(id)
		if err != nil {
			t.Fatal(err)
		}
		if p == nil {
			t.Fatalf("peer %s not found", id)
		}
		if p.Status != wantStatus {
			t.Fatalf("peer %s status = %q, want %q", id, p.Status, wantStatus)
		}
	}
	check("BATCH1", "DEGRADED")
	check("BATCH2", "DEGRADED")
}

func TestGetPeersByIDs(t *testing.T) {
	db := newTestDB(t)

	for _, id := range []string{"GPID1", "GPID2", "GPID3"} {
		if err := db.UpsertPeer(&Peer{ID: id, Status: "ONLINE", Tags: id}); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.DeletePeer("GPID3"); err != nil {
		t.Fatal(err)
	}

	peers, err := db.GetPeersByIDs([]string{"GPID1", "GPID2", "GPID3", "MISSING"})
	if err != nil {
		t.Fatal(err)
	}
	if len(peers) != 2 {
		t.Fatalf("GetPeersByIDs len = %d, want 2", len(peers))
	}
	if peers["GPID1"] == nil || peers["GPID2"] == nil {
		t.Fatal("expected GPID1 and GPID2")
	}
	if peers["GPID1"].Tags != "GPID1" {
		t.Fatalf("GPID1 tags = %q", peers["GPID1"].Tags)
	}
	if _, ok := peers["GPID3"]; ok {
		t.Fatal("soft-deleted GPID3 must be omitted")
	}
	if _, ok := peers["MISSING"]; ok {
		t.Fatal("missing ID must be omitted")
	}

	empty, err := db.GetPeersByIDs(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(empty) != 0 {
		t.Fatalf("empty ids should return empty map, got %d", len(empty))
	}
}

func TestListPeersPaginated(t *testing.T) {
	db := newTestDB(t)
	for i := 1; i <= 5; i++ {
		id := fmt.Sprintf("PAGE%02d", i)
		if err := db.UpsertPeer(&Peer{ID: id, Status: "ONLINE"}); err != nil {
			t.Fatal(err)
		}
	}

	page1, total, err := db.ListPeersPaginated(false, 2, 0)
	if err != nil {
		t.Fatal(err)
	}
	if total != 5 {
		t.Fatalf("total = %d, want 5", total)
	}
	if len(page1) != 2 {
		t.Fatalf("page1 len = %d, want 2", len(page1))
	}

	page3, total, err := db.ListPeersPaginated(false, 2, 4)
	if err != nil {
		t.Fatal(err)
	}
	if total != 5 || len(page3) != 1 {
		t.Fatalf("page3 total=%d len=%d, want total=5 len=1", total, len(page3))
	}
}

func TestBatchUpdatePeerStatusIgnoresSoftDeleted(t *testing.T) {
	db := newTestDB(t)
	if err := db.UpsertPeer(&Peer{ID: "BATCHDEL", Status: "ONLINE"}); err != nil {
		t.Fatal(err)
	}
	if err := db.DeletePeer("BATCHDEL"); err != nil {
		t.Fatal(err)
	}
	if err := db.BatchUpdatePeerStatus([]string{"BATCHDEL"}, "CRITICAL"); err != nil {
		t.Fatal(err)
	}
	peers, err := db.ListPeers(true)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range peers {
		if p.ID == "BATCHDEL" && p.Status == "CRITICAL" {
			t.Fatal("BatchUpdatePeerStatus must not update soft-deleted peer")
		}
	}
}

func TestBanSystem(t *testing.T) {
	db := newTestDB(t)

	db.UpsertPeer(&Peer{ID: "BAN1", Status: "ONLINE"})

	banned, _ := db.IsPeerBanned("BAN1")
	if banned {
		t.Error("peer should not be banned initially")
	}

	if err := db.BanPeer("BAN1", "test ban"); err != nil {
		t.Fatal(err)
	}

	banned, _ = db.IsPeerBanned("BAN1")
	if !banned {
		t.Error("peer should be banned after BanPeer")
	}

	if err := db.UnbanPeer("BAN1"); err != nil {
		t.Fatal(err)
	}

	banned, _ = db.IsPeerBanned("BAN1")
	if banned {
		t.Error("peer should not be banned after UnbanPeer")
	}
}

func TestChangePeerID(t *testing.T) {
	db := newTestDB(t)

	db.UpsertPeer(&Peer{ID: "OLD1", Hostname: "mypc", Status: "ONLINE"})

	if err := db.ChangePeerID("OLD1", "NEW1", ""); err != nil {
		t.Fatal(err)
	}

	// Old ID should not exist
	old, _ := db.GetPeer("OLD1")
	if old != nil {
		t.Error("old peer should not exist after ID change")
	}

	// New ID should exist with same data
	new1, _ := db.GetPeer("NEW1")
	if new1 == nil {
		t.Fatal("new peer should exist")
	}
	if new1.Hostname != "mypc" {
		t.Errorf("hostname should be preserved: got %q", new1.Hostname)
	}

	// History should have entry
	history, _ := db.GetIDChangeHistory("OLD1")
	if len(history) != 1 {
		t.Fatalf("expected 1 history entry, got %d", len(history))
	}
	if history[0].OldID != "OLD1" || history[0].NewID != "NEW1" {
		t.Errorf("history mismatch: %+v", history[0])
	}
}

func TestChangePeerIDDuplicate(t *testing.T) {
	db := newTestDB(t)

	db.UpsertPeer(&Peer{ID: "A1", Status: "ONLINE"})
	db.UpsertPeer(&Peer{ID: "B1", Status: "ONLINE"})

	err := db.ChangePeerID("A1", "B1", "")
	if err == nil {
		t.Error("expected error when changing to existing ID")
	}
}

func TestChangePeerIDSoftDeletedTarget(t *testing.T) {
	db := newTestDB(t)

	if err := db.UpsertPeer(&Peer{ID: "NEWCLIENT", Status: "ONLINE"}); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertPeer(&Peer{ID: "MACPRO", Status: "OFFLINE"}); err != nil {
		t.Fatal(err)
	}
	if err := db.DeletePeer("MACPRO"); err != nil {
		t.Fatal(err)
	}

	state, err := db.GetPeerIDState("MACPRO")
	if err != nil {
		t.Fatal(err)
	}
	if state != PeerIDSoftDeleted {
		t.Fatalf("MACPRO state = %s, want %s", state, PeerIDSoftDeleted)
	}

	err = db.ChangePeerID("NEWCLIENT", "MACPRO", "")
	if !errors.Is(err, ErrPeerIDSoftDeleted) {
		t.Fatalf("ChangePeerID to soft-deleted target error = %v, want ErrPeerIDSoftDeleted", err)
	}

	if err := db.ChangePeerID("NEWCLIENT", "MACPRO1", ""); err != nil {
		t.Fatalf("ChangePeerID to free target: %v", err)
	}
	peer, err := db.GetPeer("MACPRO1")
	if err != nil {
		t.Fatal(err)
	}
	if peer == nil {
		t.Fatal("MACPRO1 should exist after successful ID change")
	}
}

func TestChangePeerIDSoftDeletedSourceDoesNotMoveReservation(t *testing.T) {
	db := newTestDB(t)

	if err := db.UpsertPeer(&Peer{ID: "MACPRO", Status: "OFFLINE"}); err != nil {
		t.Fatal(err)
	}
	if err := db.DeletePeer("MACPRO"); err != nil {
		t.Fatal(err)
	}

	err := db.ChangePeerID("MACPRO", "MACPRO1", "")
	if !errors.Is(err, ErrPeerNotFound) {
		t.Fatalf("ChangePeerID from soft-deleted source error = %v, want ErrPeerNotFound", err)
	}

	state, err := db.GetPeerIDState("MACPRO")
	if err != nil {
		t.Fatal(err)
	}
	if state != PeerIDSoftDeleted {
		t.Fatalf("MACPRO state = %s, want %s", state, PeerIDSoftDeleted)
	}
	state, err = db.GetPeerIDState("MACPRO1")
	if err != nil {
		t.Fatal(err)
	}
	if state != PeerIDMissing {
		t.Fatalf("MACPRO1 state = %s, want %s", state, PeerIDMissing)
	}
}

func TestSetAllOffline(t *testing.T) {
	db := newTestDB(t)

	for _, id := range []string{"X1", "X2", "X3"} {
		db.UpsertPeer(&Peer{ID: id, Status: "ONLINE"})
	}

	if err := db.SetAllOffline(); err != nil {
		t.Fatal(err)
	}

	peers, _ := db.ListPeers(false)
	for _, p := range peers {
		if p.Status != "OFFLINE" {
			t.Errorf("peer %s status should be OFFLINE, got %q", p.ID, p.Status)
		}
	}
}

func TestGetPeerCount(t *testing.T) {
	db := newTestDB(t)

	db.UpsertPeer(&Peer{ID: "O1", Status: "ONLINE"})
	db.UpsertPeer(&Peer{ID: "O2", Status: "ONLINE"})
	db.UpsertPeer(&Peer{ID: "F1", Status: "OFFLINE"})

	total, online, err := db.GetPeerCount()
	if err != nil {
		t.Fatal(err)
	}
	if total != 3 {
		t.Errorf("total: got %d, want 3", total)
	}
	if online != 2 {
		t.Errorf("online: got %d, want 2", online)
	}
}

func TestConfig(t *testing.T) {
	db := newTestDB(t)

	if err := db.SetConfig("timeout", "15"); err != nil {
		t.Fatal(err)
	}

	val, err := db.GetConfig("timeout")
	if err != nil {
		t.Fatal(err)
	}
	if val != "15" {
		t.Errorf("config value: got %q, want %q", val, "15")
	}

	// Update
	db.SetConfig("timeout", "30")
	val, _ = db.GetConfig("timeout")
	if val != "30" {
		t.Errorf("updated config: got %q, want %q", val, "30")
	}

	// Delete
	db.DeleteConfig("timeout")
	val, _ = db.GetConfig("timeout")
	if val != "" {
		t.Errorf("deleted config should return empty, got %q", val)
	}
}

func TestHardDelete(t *testing.T) {
	db := newTestDB(t)

	db.UpsertPeer(&Peer{ID: "HARD1", Status: "ONLINE"})

	if err := db.HardDeletePeer("HARD1"); err != nil {
		t.Fatal(err)
	}

	// Should not appear even with includeDeleted
	peers, _ := db.ListPeers(true)
	for _, p := range peers {
		if p.ID == "HARD1" {
			t.Error("hard-deleted peer should not appear at all")
		}
	}
}

func TestHardDeleteReleasesIDHistory(t *testing.T) {
	db := newTestDB(t)

	if err := db.UpsertPeer(&Peer{ID: "OLDREL", Status: "ONLINE"}); err != nil {
		t.Fatal(err)
	}
	if err := db.ChangePeerID("OLDREL", "NEWREL", "client"); err != nil {
		t.Fatal(err)
	}
	renamed, err := db.IsRenamedPeerID("OLDREL")
	if err != nil || !renamed {
		t.Fatalf("OLDREL should be reserved before hard delete: %v %v", renamed, err)
	}

	if err := db.HardDeletePeer("NEWREL"); err != nil {
		t.Fatal(err)
	}
	renamed, err = db.IsRenamedPeerID("OLDREL")
	if err != nil {
		t.Fatal(err)
	}
	if renamed {
		t.Fatal("OLDREL should be released after permanent delete of successor")
	}
}

func TestRoundTripRenameTreatsCurrentIDAsActive(t *testing.T) {
	db := newTestDB(t)

	if err := db.UpsertPeer(&Peer{ID: "ROUND_A", Status: "ONLINE"}); err != nil {
		t.Fatal(err)
	}
	if err := db.ChangePeerID("ROUND_A", "ROUND_B", "client"); err != nil {
		t.Fatal(err)
	}
	if err := db.ChangePeerID("ROUND_B", "ROUND_A", "client"); err != nil {
		t.Fatal(err)
	}

	renamed, err := db.IsRenamedPeerID("ROUND_A")
	if err != nil {
		t.Fatal(err)
	}
	if renamed {
		t.Fatal("current ROUND_A must not be treated as a stale renamed ID")
	}
	renamed, err = db.IsRenamedPeerID("ROUND_B")
	if err != nil {
		t.Fatal(err)
	}
	if !renamed {
		t.Fatal("non-current ROUND_B should remain reserved as a renamed ID")
	}
}

func TestChangePeerIDCascadesDeviceTokens(t *testing.T) {
	db := newTestDB(t)

	if err := db.UpsertPeer(&Peer{ID: "OLDCAS", Status: "ONLINE"}); err != nil {
		t.Fatal(err)
	}
	token := &DeviceToken{
		Token:     "cascadetoken12345",
		TokenHash: "hash-cascade-token",
		Name:      "Cascade test",
		PeerID:    "OLDCAS",
		Status:    TokenStatusPending,
		MaxUses:   1,
	}
	if err := db.CreateDeviceToken(token); err != nil {
		t.Fatal(err)
	}

	if err := db.ChangePeerID("OLDCAS", "NEWCAS", "panel"); err != nil {
		t.Fatal(err)
	}

	got, err := db.GetDeviceTokenByPeerID("NEWCAS")
	if err != nil || got == nil {
		t.Fatalf("device token should follow ID change: %v %+v", err, got)
	}
	if stale, _ := db.GetDeviceTokenByPeerID("OLDCAS"); stale != nil {
		t.Fatalf("token should not remain on old ID: %+v", stale)
	}
}

// TestMigrateUpgradesLegacySchema simulates a database created by an older
// version (without totp_secret, totp_enabled in users table). Migrate()
// should add the missing columns so CreateUser and GetUser work correctly.
func TestMigrateUpgradesLegacySchema(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "legacy.db")
	db, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	defer db.Close()

	// Step 1: Create a "legacy" users table WITHOUT totp columns.
	_, err = db.db.Exec(`CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT UNIQUE NOT NULL,
		password_hash TEXT NOT NULL,
		role TEXT NOT NULL DEFAULT 'viewer',
		created_at TEXT DEFAULT (datetime('now')),
		last_login TEXT DEFAULT ''
	)`)
	if err != nil {
		t.Fatalf("Create legacy users table: %v", err)
	}

	// Step 2: Create a "legacy" peers table WITHOUT ban/tags/heartbeat columns.
	_, err = db.db.Exec(`CREATE TABLE IF NOT EXISTS peers (
		id TEXT PRIMARY KEY,
		uuid TEXT DEFAULT '',
		pk BLOB DEFAULT NULL,
		ip TEXT DEFAULT '',
		user TEXT DEFAULT '',
		hostname TEXT DEFAULT '',
		os TEXT DEFAULT '',
		version TEXT DEFAULT '',
		status TEXT DEFAULT 'OFFLINE',
		nat_type INTEGER DEFAULT 0,
		last_online TEXT DEFAULT '',
		created_at TEXT DEFAULT (datetime('now')),
		disabled INTEGER DEFAULT 0,
		soft_deleted INTEGER DEFAULT 0,
		deleted_at TEXT DEFAULT NULL,
		note TEXT DEFAULT ''
	)`)
	if err != nil {
		t.Fatalf("Create legacy peers table: %v", err)
	}

	// Step 3: Run Migrate() — should add missing columns without error.
	if err := db.Migrate(); err != nil {
		t.Fatalf("Migrate on legacy schema: %v", err)
	}

	// Step 4: Verify CreateUser works (uses totp_secret, totp_enabled columns).
	err = db.CreateUser(&User{
		Username:     "admin",
		PasswordHash: "hash123",
		Role:         "admin",
		TOTPSecret:   "secret",
		TOTPEnabled:  true,
	})
	if err != nil {
		t.Fatalf("CreateUser after migration: %v", err)
	}

	// Step 5: Verify GetUser returns totp fields correctly.
	u, err := db.GetUser("admin")
	if err != nil {
		t.Fatalf("GetUser: %v", err)
	}
	if u.TOTPSecret != "secret" {
		t.Errorf("TOTPSecret: got %q, want %q", u.TOTPSecret, "secret")
	}
	if !u.TOTPEnabled {
		t.Error("TOTPEnabled should be true")
	}

	// Step 6: Verify peers table has ban columns.
	db.UpsertPeer(&Peer{ID: "TESTPEER", Status: "ONLINE"})
	err = db.BanPeer("TESTPEER", "test reason")
	if err != nil {
		t.Fatalf("BanPeer after migration: %v", err)
	}
	banned, _ := db.IsPeerBanned("TESTPEER")
	if !banned {
		t.Error("TESTPEER should be banned after migration")
	}

	// Step 7: Verify running Migrate() again is idempotent (no errors).
	if err := db.Migrate(); err != nil {
		t.Fatalf("Migrate (idempotent): %v", err)
	}
}

func TestUpdatePeerSysinfo(t *testing.T) {
	db := newTestDB(t)

	// Insert a peer with empty hostname/os/version
	db.UpsertPeer(&Peer{ID: "SYSINFO1", UUID: "uuid-sys", Status: "ONLINE"})

	// Update sysinfo
	if err := db.UpdatePeerSysinfo("SYSINFO1", "my-desktop", "Windows 11", "1.3.2"); err != nil {
		t.Fatalf("UpdatePeerSysinfo: %v", err)
	}

	got, err := db.GetPeer("SYSINFO1")
	if err != nil {
		t.Fatalf("GetPeer: %v", err)
	}
	if got.Hostname != "my-desktop" {
		t.Errorf("Hostname: got %q, want %q", got.Hostname, "my-desktop")
	}
	if got.OS != "Windows 11" {
		t.Errorf("OS: got %q, want %q", got.OS, "Windows 11")
	}
	if got.Version != "1.3.2" {
		t.Errorf("Version: got %q, want %q", got.Version, "1.3.2")
	}

	// Partial update — empty fields should NOT overwrite existing values
	if err := db.UpdatePeerSysinfo("SYSINFO1", "", "Ubuntu 22.04", ""); err != nil {
		t.Fatalf("UpdatePeerSysinfo partial: %v", err)
	}

	got2, _ := db.GetPeer("SYSINFO1")
	if got2.Hostname != "my-desktop" {
		t.Errorf("Hostname after partial update: got %q, want %q (unchanged)", got2.Hostname, "my-desktop")
	}
	if got2.OS != "Ubuntu 22.04" {
		t.Errorf("OS after partial update: got %q, want %q", got2.OS, "Ubuntu 22.04")
	}
	if got2.Version != "1.3.2" {
		t.Errorf("Version after partial update: got %q, want %q (unchanged)", got2.Version, "1.3.2")
	}

	// Non-existent peer — should not error (0 rows affected)
	if err := db.UpdatePeerSysinfo("NOSUCHPEER", "host", "os", "ver"); err != nil {
		t.Fatalf("UpdatePeerSysinfo non-existent: %v", err)
	}
}

// Issue #292: never-logged-in users may have NULL last_login / totp_secret.
// Scans into string must not fail; delete must clear org_users links.
func TestListUsersToleratesNullLastLogin(t *testing.T) {
	db := newTestDB(t)

	admin := &User{Username: "admin292", PasswordHash: "h", Role: "super_admin"}
	viewer := &User{Username: "fresh292", PasswordHash: "h", Role: "viewer"}
	if err := db.CreateUser(admin); err != nil {
		t.Fatalf("CreateUser admin: %v", err)
	}
	if err := db.CreateUser(viewer); err != nil {
		t.Fatalf("CreateUser viewer: %v", err)
	}

	// Simulate legacy / never-logged-in row (NULL last_login + totp_secret).
	if _, err := db.db.Exec(`UPDATE users SET last_login = NULL, totp_secret = NULL WHERE id = ?`, viewer.ID); err != nil {
		t.Fatalf("force NULL columns: %v", err)
	}

	users, err := db.ListUsers()
	if err != nil {
		t.Fatalf("ListUsers with NULL last_login: %v", err)
	}
	if len(users) < 2 {
		t.Fatalf("ListUsers: got %d users, want >= 2", len(users))
	}

	got, err := db.GetUserByID(viewer.ID)
	if err != nil || got == nil {
		t.Fatalf("GetUserByID: user=%v err=%v", got, err)
	}
	if got.LastLogin != "" {
		t.Errorf("LastLogin: got %q, want empty string after COALESCE", got.LastLogin)
	}
	if got.TOTPSecret != "" {
		t.Errorf("TOTPSecret: got %q, want empty string after COALESCE", got.TOTPSecret)
	}
}

func TestDeleteUserClearsOrgLinks(t *testing.T) {
	db := newTestDB(t)

	u := &User{Username: "orglink292", PasswordHash: "h", Role: "viewer"}
	if err := db.CreateUser(u); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	org := &Organization{
		ID:        "org-292",
		Name:      "Org 292",
		Slug:      "org-292",
		CreatedAt: time.Now().UTC(),
	}
	if err := db.CreateOrganization(org); err != nil {
		t.Fatalf("CreateOrganization: %v", err)
	}
	if _, err := db.LinkUserToOrg(org.ID, u.ID, "member"); err != nil {
		t.Fatalf("LinkUserToOrg: %v", err)
	}

	if _, err := db.db.Exec(`UPDATE users SET last_login = NULL WHERE id = ?`, u.ID); err != nil {
		t.Fatalf("force NULL last_login: %v", err)
	}

	if err := db.DeleteUser(u.ID); err != nil {
		t.Fatalf("DeleteUser: %v", err)
	}

	got, err := db.GetUserByID(u.ID)
	if err != nil {
		t.Fatalf("GetUserByID after delete: %v", err)
	}
	if got != nil {
		t.Fatal("user row should be gone")
	}

	var n int
	if err := db.db.QueryRow(`SELECT COUNT(*) FROM org_users WHERE server_user_id = ?`, u.ID).Scan(&n); err != nil {
		t.Fatalf("count org_users: %v", err)
	}
	if n != 0 {
		t.Fatalf("org_users links remaining: %d, want 0", n)
	}
}

func TestMigrateBackfillsNullUserTimestamps(t *testing.T) {
	db := newTestDB(t)
	u := &User{Username: "nullmig292", PasswordHash: "h", Role: "viewer"}
	if err := db.CreateUser(u); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if _, err := db.db.Exec(`UPDATE users SET last_login = NULL, totp_secret = NULL WHERE id = ?`, u.ID); err != nil {
		t.Fatalf("force NULL: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	var lastLogin, totp any
	if err := db.db.QueryRow(`SELECT last_login, totp_secret FROM users WHERE id = ?`, u.ID).Scan(&lastLogin, &totp); err != nil {
		t.Fatalf("SELECT: %v", err)
	}
	if lastLogin == nil {
		t.Error("last_login still NULL after Migrate backfill")
	}
	if totp == nil {
		t.Error("totp_secret still NULL after Migrate backfill")
	}
}

func TestMigrateUsersDropLegacyRoleCheck(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "legacy-role-check.db")
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open raw: %v", err)
	}
	_, err = raw.Exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT UNIQUE NOT NULL,
			password_hash TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'viewer',
			created_at TEXT DEFAULT (datetime('now')),
			last_login TEXT DEFAULT '',
			CHECK (role IN ('admin', 'operator', 'viewer'))
		);
		INSERT INTO users (username, password_hash, role) VALUES ('op', 'hash', 'operator');
	`)
	if err != nil {
		raw.Close()
		t.Fatalf("seed legacy users: %v", err)
	}
	raw.Close()

	db, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	defer db.Close()
	if err := db.Migrate(); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	if db.usersHasLegacyRoleCheck() {
		t.Fatal("legacy role CHECK still present after Migrate")
	}

	// Phase 52 roles must insert successfully after migration.
	if err := db.CreateUser(&User{Username: "ga", PasswordHash: "hash", Role: "global_admin"}); err != nil {
		t.Fatalf("CreateUser global_admin after migration: %v", err)
	}
	got, err := db.GetUser("ga")
	if err != nil || got == nil {
		t.Fatalf("GetUser global_admin: user=%v err=%v", got, err)
	}
	if got.Role != "global_admin" {
		t.Fatalf("role = %q, want global_admin", got.Role)
	}

	// Idempotent second migrate
	if err := db.Migrate(); err != nil {
		t.Fatalf("Migrate second: %v", err)
	}
}
