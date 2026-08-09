package api

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestValidateReplaceBinarySource_rejectsTiny(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	p := filepath.Join(dir, "betterdesk-server.exe")
	if err := os.WriteFile(p, []byte("MZ"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := validateReplaceBinarySource(p); err == nil {
		t.Fatal("expected size error")
	}
}

func TestValidateReplaceBinarySource_acceptsPE(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("PE check is Windows-oriented")
	}
	t.Parallel()
	dir := t.TempDir()
	p := filepath.Join(dir, "betterdesk-server.exe")
	buf := make([]byte, 2<<20)
	buf[0], buf[1] = 'M', 'Z'
	if err := os.WriteFile(p, buf, 0644); err != nil {
		t.Fatal(err)
	}
	if err := validateReplaceBinarySource(p); err != nil {
		t.Fatalf("unexpected: %v", err)
	}
}

func TestReplaceRunningExecutable_copies(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	target := filepath.Join(dir, "betterdesk-server.exe")
	source := filepath.Join(dir, "new.exe")
	if err := os.WriteFile(target, []byte("old-binary-content!!!!"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte("new-binary-content!!!!"), 0755); err != nil {
		t.Fatal(err)
	}
	backup, err := replaceRunningExecutable(source, target)
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new-binary-content!!!!" {
		t.Fatalf("target=%q", got)
	}
	if backup == "" {
		t.Fatal("expected backup path")
	}
	bak, err := os.ReadFile(backup)
	if err != nil {
		t.Fatal(err)
	}
	if string(bak) != "old-binary-content!!!!" {
		t.Fatalf("backup=%q", bak)
	}
}
