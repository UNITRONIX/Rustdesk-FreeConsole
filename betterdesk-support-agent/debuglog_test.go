package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestDebugLogIsDisabledInReleaseAndPrivateInDevelopment(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("BETTERDESK_AGENT_DATA_DIR", dir)
	t.Setenv("BETTERDESK_DEBUG_LOG", "")

	debugLog("test", "test", "test", nil)
	path := filepath.Join(dir, "debug-7fbd11.log")
	info, err := os.Stat(path)

	if isReleaseBuild() {
		if !os.IsNotExist(err) {
			t.Fatalf("release build wrote debug log: %v", err)
		}
		return
	}
	if err != nil {
		t.Fatalf("development build did not write debug log: %v", err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("debug log permissions = %o, want 0600", info.Mode().Perm())
	}
}
