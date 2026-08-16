package db

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSqliteFileURIUsesForwardSlashes(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "auth.db")
	if err := os.WriteFile(path, []byte{}, 0o600); err != nil {
		t.Fatal(err)
	}
	uri := sqliteFileURI(path, nil)
	if strings.Contains(uri, `\`) {
		t.Fatalf("URI still has backslashes: %q", uri)
	}
	if !strings.HasPrefix(uri, "file:") {
		t.Fatalf("missing file: scheme: %q", uri)
	}
	if runtime.GOOS == "windows" {
		// Drive letter form: file:/C:/...
		rest := strings.TrimPrefix(uri, "file:")
		if len(rest) < 3 || rest[0] != '/' || rest[2] != ':' {
			t.Fatalf("expected file:/X:/…, got %q", uri)
		}
	}
}

func TestOpenConsoleAuthRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "auth.db")
	peer, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	_ = peer.Close()

	c, err := OpenConsoleAuth(path)
	if err != nil {
		t.Fatalf("OpenConsoleAuth: %v", err)
	}
	defer c.Close()
}
