package agent

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSafePathRejectsTraversalAndSiblingPrefix(t *testing.T) {
	root := t.TempDir()
	sibling := root + "-sibling"
	if _, err := safePath(root, "../"+filepath.Base(sibling)); err == nil {
		t.Fatal("safePath accepted a traversal path")
	}
	if _, err := safePath(root, filepath.Join("..", filepath.Base(sibling))); err == nil {
		t.Fatal("safePath accepted a sibling-prefix escape")
	}
}

func TestSafePathRejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}

	link := filepath.Join(root, "link")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink creation unavailable: %v", err)
	}

	if _, err := safePath(root, filepath.Join("link", "secret.txt")); err == nil {
		t.Fatal("safePath accepted a symlink escape")
	}
}
