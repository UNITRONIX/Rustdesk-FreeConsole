package signalhost

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestLoadIdentityPersistsKeyAndUUID(t *testing.T) {
	dir := t.TempDir()
	first, err := loadIdentity(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	second, err := loadIdentity(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first.publicKey, second.publicKey) {
		t.Fatal("signal public key changed across restart")
	}
	if !bytes.Equal(first.uuid, second.uuid) {
		t.Fatal("signal UUID changed across restart")
	}

	if runtime.GOOS != "windows" {
		info, err := os.Stat(filepath.Join(dir, "signal_ed25519"))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm()&0o077 != 0 {
			t.Fatalf("private key permissions = %o, want owner-only", info.Mode().Perm())
		}
	}
}

func TestLoadIdentityRefusesCorruptStoredKey(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "signal_ed25519"), []byte("bad"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadIdentity(dir, ""); err == nil {
		t.Fatal("corrupt signal identity was silently replaced")
	}
}
