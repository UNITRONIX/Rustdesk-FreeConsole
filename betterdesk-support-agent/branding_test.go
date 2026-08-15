package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestBrandingNormalizeDefaults(t *testing.T) {
	b := Branding{CompanyName: "Acme"}.normalize()
	if b.PrimaryColor != "#2563eb" {
		t.Fatalf("primary default: %s", b.PrimaryColor)
	}
	if b.BackgroundColor != "#ffffff" {
		t.Fatalf("background default: %s", b.BackgroundColor)
	}
	if b.AccentColor != "#e0f2fe" {
		t.Fatalf("accent default: %s", b.AccentColor)
	}
	if b.HeaderTextColor != "#1f2937" {
		t.Fatalf("header text default: %s", b.HeaderTextColor)
	}
	if b.StatusReadyColor != "#22c55e" {
		t.Fatalf("status color default: %s", b.StatusReadyColor)
	}
}

func TestBrandingServerNested(t *testing.T) {
	raw := `{"company_name":"X","server":{"address":"https://host:5443","api_url":"https://host:5443/api","public_key":"abc"}}`
	var b Branding
	if err := json.Unmarshal([]byte(raw), &b); err != nil {
		t.Fatal(err)
	}
	b = b.normalize()
	if b.ServerAddress != "https://host:5443" {
		t.Fatalf("address: %s", b.ServerAddress)
	}
	if b.ServerKey != "abc" {
		t.Fatalf("key: %s", b.ServerKey)
	}
}

func TestStateEnrollment(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("BETTERDESK_AGENT_DATA_DIR", dir)

	st, err := LoadState()
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetEnrollment(EnrollmentApproved, st.DeviceID, "tok-123", ""); err != nil {
		t.Fatal(err)
	}
	if !st.IsEnrolled() {
		t.Fatal("expected enrolled")
	}

	st2, err := LoadState()
	if err != nil {
		t.Fatal(err)
	}
	if !st2.IsEnrolled() || st2.DeviceToken != "tok-123" {
		t.Fatalf("reload failed: %+v", st2)
	}

	// Empty token on approve must not wipe a stored token.
	if err := st2.SetEnrollment(EnrollmentApproved, st2.DeviceID, "", ""); err != nil {
		t.Fatal(err)
	}
	if !st2.IsEnrolled() || st2.DeviceToken != "tok-123" {
		t.Fatalf("token wiped: %+v", st2)
	}
}

func TestAPIBaseURL(t *testing.T) {
	b := Branding{
		ServerAddress: "https://desk.example.com:5443",
		Server: &ServerBranding{
			APIURL: "https://desk.example.com:5443/api",
		},
	}.normalize()
	got := apiBaseURL(b)
	want := "https://desk.example.com:5443/api"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestCdapWSURLHTTPS(t *testing.T) {
	b := Branding{ServerAddress: "https://desk.example.com:5443", UseHTTPS: true}.normalize()
	got := cdapWSURL(b)
	if got[:6] != "wss://" {
		t.Fatalf("expected wss, got %q", got)
	}
	if !strings.Contains(got, ":21122/cdap") {
		t.Fatalf("expected default cdap port, got %q", got)
	}
}
