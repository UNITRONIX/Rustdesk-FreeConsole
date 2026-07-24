package meshcentral

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestSanitizePathSegment(t *testing.T) {
	tests := []struct {
		in, want string
	}{
		{"peer-123", "peer-123"},
		{"../etc/passwd", "___etc_passwd"},
		{"kvm/session", "kvm_session"},
		{"", "segment"},
	}
	for _, tc := range tests {
		if got := sanitizePathSegment(tc.in); got != tc.want {
			t.Errorf("sanitizePathSegment(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestFmtFilenameSanitizesSegments(t *testing.T) {
	name := fmtFilename("../peer", "../../evil", "kvm/../x")
	if strings.Contains(name, "..") {
		t.Fatalf("filename must not contain ..: %q", name)
	}
	if strings.Contains(name, "/") || strings.Contains(name, "\\") {
		t.Fatalf("filename must not contain path separators: %q", name)
	}
	if !strings.HasSuffix(name, ".mcrec") {
		t.Fatalf("expected .mcrec suffix: %q", name)
	}
}

func TestPathWithinDir(t *testing.T) {
	dir := filepath.Join("data", "mesh-recordings")
	inside := filepath.Join(dir, "peer_kvm_20260101-120000_abcd1234.mcrec")
	outside := filepath.Join(dir, "..", "secrets.txt")

	if !pathWithinDir(dir, inside) {
		t.Fatalf("expected %q to be inside %q", inside, dir)
	}
	if pathWithinDir(dir, outside) {
		t.Fatalf("expected %q to be outside %q", outside, dir)
	}
}

func TestOpenRelayRecorderPathConfinement(t *testing.T) {
	dir := t.TempDir()
	rec, path, err := openRelayRecorder(dir, "peer1", "relayid01", "kvm")
	if err != nil {
		t.Fatalf("openRelayRecorder: %v", err)
	}
	rec.Close()

	recordingsDir := filepath.Join(dir, "mesh-recordings")
	if !pathWithinDir(recordingsDir, path) {
		t.Fatalf("recording path escapes directory: %q", path)
	}
}
