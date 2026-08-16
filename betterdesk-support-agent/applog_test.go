package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestWriteAppLogRepairsExistingFilePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows does not report POSIX file permissions")
	}

	dir := t.TempDir()
	t.Setenv("BETTERDESK_AGENT_DATA_DIR", dir)
	path := filepath.Join(dir, "support-agent.log")
	if err := os.WriteFile(path, []byte("old entry\n"), 0o644); err != nil {
		t.Fatalf("seed log: %v", err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatalf("make log permissive: %v", err)
	}

	writeAppLog("info", "test", "test log", nil)

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat log: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("log permissions = %o, want 0600", got)
	}
}
