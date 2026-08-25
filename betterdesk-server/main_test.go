package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteBootstrapAdminCredentialsDoesNotOverwriteExistingFile(t *testing.T) {
	dir := t.TempDir()
	credentialsPath := filepath.Join(dir, ".admin_credentials")
	original := []byte("Admin Username: admin\nAdmin Password: original-password\n")
	if err := os.WriteFile(credentialsPath, original, 0600); err != nil {
		t.Fatal(err)
	}

	gotPath, err := writeBootstrapAdminCredentials(dir, "admin", "replacement-password")
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != credentialsPath {
		t.Fatalf("credentials path = %q, want %q", gotPath, credentialsPath)
	}

	got, err := os.ReadFile(credentialsPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(original) {
		t.Fatalf("existing credentials were overwritten: %q", got)
	}
}

func TestReadBootstrapAdminPassword(t *testing.T) {
	dir := t.TempDir()
	credentialsPath := filepath.Join(dir, ".admin_credentials")
	if err := os.WriteFile(credentialsPath,
		[]byte("Admin Username: admin\nAdmin Password: shared-password\n"), 0600); err != nil {
		t.Fatal(err)
	}

	if got := readBootstrapAdminPassword(dir); got != "shared-password" {
		t.Fatalf("password = %q, want %q", got, "shared-password")
	}
}
