package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSyncAccessPasswordPublishesEffectiveUnattendedPolicy(t *testing.T) {
	if isReleaseBuild() {
		t.Skip("HTTP test server is intentionally refused by release transport policy")
	}

	var payload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/devices/self/access-policy" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode policy payload: %v", err)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	st := &AppState{
		DeviceID:       "BD-TEST",
		DeviceToken:    "device-token",
		AccessMode:     AccessUnattended,
		AccessPassword: " \t ",
	}
	brand := Branding{
		AllowUnattended: true,
		Server:          &ServerBranding{APIURL: server.URL},
	}
	if err := SyncAccessPassword(brand, st); err != nil {
		t.Fatalf("SyncAccessPassword: %v", err)
	}

	if got, want := payload["password_set"], false; got != want {
		t.Fatalf("password_set = %v, want %v", got, want)
	}
	if got, want := payload["unattended_enabled"], false; got != want {
		t.Fatalf("unattended_enabled = %v, want %v", got, want)
	}
	if _, leaked := payload["password"]; leaked {
		t.Fatal("access policy payload must not contain the local password")
	}
}

func TestSyncAccessPasswordNeverSendsLocalSecret(t *testing.T) {
	if isReleaseBuild() {
		t.Skip("HTTP test server is intentionally refused by release transport policy")
	}

	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/devices/self/access-policy" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatal(err)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	state := &AppState{
		DeviceID:       "BD-LOCAL-SECRET",
		DeviceToken:    "device-token",
		AccessPassword: "must-remain-local",
		AccessMode:     AccessUnattended,
	}
	brand := Branding{Server: &ServerBranding{APIURL: server.URL}}
	if err := SyncAccessPassword(brand, state); err != nil {
		t.Fatal(err)
	}
	if _, found := received["password"]; found {
		t.Fatalf("password was sent: %#v", received)
	}
	if received["password_set"] != true {
		t.Fatalf("password_set = %#v", received["password_set"])
	}
}
