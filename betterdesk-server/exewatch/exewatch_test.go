package exewatch

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFileFingerprintChangesWhenContentChanges(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	p := filepath.Join(dir, "bin.exe")
	if err := os.WriteFile(p, []byte("version-one-content-aaaa"), 0755); err != nil {
		t.Fatal(err)
	}
	a, err := FileFingerprint(p)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * time.Millisecond)
	if err := os.WriteFile(p, []byte("version-two-content-bbbb"), 0755); err != nil {
		t.Fatal(err)
	}
	b, err := FileFingerprint(p)
	if err != nil {
		t.Fatal(err)
	}
	if a.Equal(b) {
		t.Fatal("expected fingerprint to change after rewrite")
	}
}

func TestFileFingerprintStable(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	p := filepath.Join(dir, "bin.exe")
	if err := os.WriteFile(p, []byte("same-content-zzzzzzzz"), 0755); err != nil {
		t.Fatal(err)
	}
	a, err := FileFingerprint(p)
	if err != nil {
		t.Fatal(err)
	}
	b, err := FileFingerprint(p)
	if err != nil {
		t.Fatal(err)
	}
	if !a.Equal(b) {
		t.Fatalf("stable file should match: %#v vs %#v", a, b)
	}
}
