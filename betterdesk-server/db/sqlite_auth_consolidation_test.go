package db

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func TestConsolidateSQLiteAuthPreservesUsersAndPanelData(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "db_v2.sqlite3")
	legacy := filepath.Join(dir, "auth.db")

	targetDB, err := OpenSQLite(target)
	if err != nil {
		t.Fatal(err)
	}
	if err := targetDB.Migrate(); err != nil {
		t.Fatal(err)
	}
	if err := targetDB.Close(); err != nil {
		t.Fatal(err)
	}

	legacyDB, err := sql.Open("sqlite", legacy)
	if err != nil {
		t.Fatal(err)
	}
	_, err = legacyDB.Exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT UNIQUE NOT NULL,
			password_hash TEXT NOT NULL,
			role TEXT NOT NULL,
			auth_provider TEXT DEFAULT 'local',
			created_at TEXT DEFAULT (datetime('now')),
			last_login TEXT,
			totp_secret TEXT,
			totp_enabled INTEGER DEFAULT 0,
			totp_recovery_codes TEXT,
			email TEXT DEFAULT ''
		);
		CREATE TABLE address_books (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			user_id INTEGER NOT NULL,
			ab_type TEXT DEFAULT 'legacy',
			data TEXT DEFAULT '{}',
			updated_at TEXT DEFAULT (datetime('now')),
			UNIQUE(user_id, ab_type)
		);
		CREATE TABLE settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at TEXT DEFAULT (datetime('now'))
		);
		INSERT INTO users (id, username, password_hash, role, totp_secret, totp_enabled, email)
			VALUES (7, 'alice', 'pbkdf2-sha256$600000$test', 'operator', 'secret', 1, 'alice@example.test');
		INSERT INTO address_books (user_id, ab_type, data) VALUES (7, 'legacy', '{"tags":["ops"]}');
		INSERT INTO settings (key, value) VALUES ('theme', 'dark');
	`)
	if err != nil {
		t.Fatal(err)
	}
	if err := legacyDB.Close(); err != nil {
		t.Fatal(err)
	}

	report, err := ConsolidateSQLiteAuth(SQLiteAuthConsolidationOptions{
		DBPath: target, AuthDBPath: legacy, BackupDir: filepath.Join(dir, "backups"),
		Now: func() time.Time { return time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if report.AlreadyComplete || report.TargetBackupPath == "" || report.SourceBackupPath == "" {
		t.Fatalf("unexpected report: %+v", report)
	}
	legacyCheck, err := sql.Open("sqlite", legacy)
	if err != nil {
		t.Fatalf("legacy database must remain available: %v", err)
	}
	legacyCheck.Close()
	consolidated, err := SQLiteAuthConsolidated(target)
	if err != nil || !consolidated {
		t.Fatalf("consolidated=%v err=%v", consolidated, err)
	}

	check, err := sql.Open("sqlite", target)
	if err != nil {
		t.Fatal(err)
	}
	defer check.Close()
	var id int
	var email string
	if err := check.QueryRow(`SELECT id, email FROM users WHERE username='alice'`).Scan(&id, &email); err != nil {
		t.Fatal(err)
	}
	if id != 7 || email != "alice@example.test" {
		t.Fatalf("user was not preserved: id=%d email=%q", id, email)
	}
	var data string
	if err := check.QueryRow(`SELECT data FROM address_books WHERE username='alice' AND ab_type='legacy'`).Scan(&data); err != nil {
		t.Fatal(err)
	}
	if data != `{"tags":["ops"]}` {
		t.Fatalf("address book = %q", data)
	}
	var setting string
	if err := check.QueryRow(`SELECT value FROM settings WHERE key='theme'`).Scan(&setting); err != nil {
		t.Fatal(err)
	}
	if setting != "dark" {
		t.Fatalf("setting = %q", setting)
	}
}

func TestConsolidateSQLiteAuthRejectsCredentialConflict(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "db_v2.sqlite3")
	legacy := filepath.Join(dir, "auth.db")
	targetDB, err := OpenSQLite(target)
	if err != nil {
		t.Fatal(err)
	}
	if err := targetDB.Migrate(); err != nil {
		t.Fatal(err)
	}
	if _, err := targetDB.db.Exec(`
		INSERT INTO users (id, username, password_hash, role) VALUES (1, 'alice', 'go-hash', 'admin')`); err != nil {
		t.Fatal(err)
	}
	if err := targetDB.Close(); err != nil {
		t.Fatal(err)
	}
	legacyDB, err := sql.Open("sqlite", legacy)
	if err != nil {
		t.Fatal(err)
	}
	_, err = legacyDB.Exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
			role TEXT NOT NULL, totp_secret TEXT DEFAULT '', totp_enabled INTEGER DEFAULT 0
		);
		INSERT INTO users (id, username, password_hash, role) VALUES (1, 'alice', 'legacy-hash', 'admin');
	`)
	if err != nil {
		t.Fatal(err)
	}
	legacyDB.Close()

	if _, err := ConsolidateSQLiteAuth(SQLiteAuthConsolidationOptions{
		DBPath: target, AuthDBPath: legacy, BackupDir: filepath.Join(dir, "backups"),
	}); err == nil {
		t.Fatal("expected conflicting credentials to abort consolidation")
	}
	consolidated, err := SQLiteAuthConsolidated(target)
	if err != nil {
		t.Fatal(err)
	}
	if consolidated {
		t.Fatal("failed consolidation must not mark target complete")
	}
}
