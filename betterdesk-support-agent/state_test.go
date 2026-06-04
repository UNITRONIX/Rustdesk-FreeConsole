package main

import (
	"path/filepath"
	"testing"
)

func TestAppImagePortableDir(t *testing.T) {
	t.Setenv("APPIMAGE", "/home/user/Downloads/BetterDesk.AppImage")
	dir, ok := appImagePortableDir()
	if !ok {
		t.Fatal("expected AppImage portable dir")
	}
	want := filepath.Join("/home/user/Downloads", "betterdesk-support-data")
	if dir != want {
		t.Fatalf("got %q want %q", dir, want)
	}
}

func TestIsPortableAppImage(t *testing.T) {
	t.Setenv("APPIMAGE", "/tmp/test.AppImage")
	t.Setenv("BETTERDESK_AGENT_DATA_DIR", "")
	if !IsPortable() {
		t.Fatal("AppImage should be treated as portable")
	}
}

func TestIsPortableNotWhenDataDirOverride(t *testing.T) {
	t.Setenv("APPIMAGE", "/tmp/test.AppImage")
	t.Setenv("BETTERDESK_AGENT_DATA_DIR", "/var/lib/test")
	if IsPortable() {
		t.Fatal("BETTERDESK_AGENT_DATA_DIR override disables portable tagging")
	}
}

func TestAppImagePortableDirUnset(t *testing.T) {
	t.Setenv("APPIMAGE", "")
	if _, ok := appImagePortableDir(); ok {
		t.Fatal("expected false without APPIMAGE")
	}
}
