package api

import "testing"

func TestRejectWindowsClientAppName(t *testing.T) {
	t.Setenv(envWindowsClientAppNameGate, "true")
	t.Setenv(envAllowedWindowsAppNames, "DCS Norway")

	cases := []struct {
		os, app string
		reject  bool
	}{
		{"android", "RustDesk", false},
		{"ios", "", false},
		{"linux", "RustDesk", false},
		{"macos", "RustDesk", false},
		{"windows", "DCS Norway", false},
		{"windows", "RustDesk", true},
		{"windows", "", true},
		{"Windows", "DCS Norway", false},
	}
	for _, c := range cases {
		msg := rejectWindowsClientAppName(c.os, c.app)
		got := msg != ""
		if got != c.reject {
			t.Fatalf("os=%q app=%q: reject=%v want=%v msg=%q", c.os, c.app, got, c.reject, msg)
		}
	}
}

func TestRejectWindowsClientAppNameDisabled(t *testing.T) {
	t.Setenv(envWindowsClientAppNameGate, "false")
	if msg := rejectWindowsClientAppName("windows", "RustDesk"); msg != "" {
		t.Fatalf("expected allow when gate disabled, got %q", msg)
	}
}
