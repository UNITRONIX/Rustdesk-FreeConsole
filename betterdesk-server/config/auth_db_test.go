package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveAuthDBPathExplicitWins(t *testing.T) {
	got := ResolveAuthDBPath(`C:\custom\auth.db`, "")
	if got != `C:\custom\auth.db` {
		t.Fatalf("explicit path ignored: %q", got)
	}
}

func TestResolveAuthDBPathDiscoversBesidePeerDB(t *testing.T) {
	dir := t.TempDir()
	auth := filepath.Join(dir, "auth.db")
	if err := os.WriteFile(auth, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BETTERDESK_AUTH_DB_PATH", "")
	t.Setenv("CONSOLE_PATH", "")
	t.Setenv("CONSOLE_DATA_DIR", "")
	t.Setenv("DATA_DIR", "")
	peerDB := filepath.Join(dir, "db_v2.sqlite3")
	got := ResolveAuthDBPath("", peerDB)
	if got != auth {
		t.Fatalf("want %q, got %q", auth, got)
	}
}

func TestResolveAuthDBPathConsoleDataDir(t *testing.T) {
	dir := t.TempDir()
	auth := filepath.Join(dir, "auth.db")
	if err := os.WriteFile(auth, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("BETTERDESK_AUTH_DB_PATH", "")
	t.Setenv("CONSOLE_PATH", "")
	t.Setenv("CONSOLE_DATA_DIR", dir)
	t.Setenv("DATA_DIR", "")
	got := ResolveAuthDBPath("", "")
	if got != auth {
		t.Fatalf("want %q, got %q", auth, got)
	}
}

func TestResolveAuthDBPathBetterdeskEnvWins(t *testing.T) {
	t.Setenv("BETTERDESK_AUTH_DB_PATH", `/tmp/does-not-need-to-exist.db`)
	got := ResolveAuthDBPath("", "")
	if got != `/tmp/does-not-need-to-exist.db` {
		t.Fatalf("want BETTERDESK_AUTH_DB_PATH, got %q", got)
	}
}
