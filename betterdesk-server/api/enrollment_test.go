package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/peer"
)

func TestDeviceRegisterIdentityConflict(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	database.UpsertPeer(&db.Peer{
		ID:   "BD-TEST1",
		UUID: "original-machine-uuid",
	})

	cfg := config.DefaultConfig()
	cfg.EnrollmentMode = "open"
	srv := New(cfg, database, peer.NewMap(), nil, "test")
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/devices/register", srv.handleDeviceRegister)

	body, _ := json.Marshal(map[string]any{
		"device_id":   "BD-TEST1",
		"uuid":        "different-machine-uuid",
		"hostname":    "host-b",
		"platform":    "linux amd64",
		"device_type": "os_agent",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/devices/register", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d body=%s", rec.Code, rec.Body.String())
	}
	var resp EnrollmentResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Error != "identity_conflict" {
		t.Fatalf("expected identity_conflict, got %q", resp.Error)
	}
	if resp.SuggestedDeviceID != "BD-TEST1-2" {
		t.Fatalf("expected suggested ID BD-TEST1-2, got %q", resp.SuggestedDeviceID)
	}
}

func TestDeviceRegisterSameUUIDReissues(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	database.UpsertPeer(&db.Peer{
		ID:   "BD-TEST2",
		UUID: "same-machine-uuid",
	})

	cfg := config.DefaultConfig()
	cfg.EnrollmentMode = "open"
	srv := New(cfg, database, peer.NewMap(), nil, "test")
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/devices/register", srv.handleDeviceRegister)

	body, _ := json.Marshal(map[string]any{
		"device_id":   "BD-TEST2",
		"uuid":        "same-machine-uuid",
		"hostname":    "host-a",
		"platform":    "linux amd64",
		"device_type": "os_agent",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/devices/register", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}
	var resp EnrollmentResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Status != "approved" {
		t.Fatalf("expected approved, got %q", resp.Status)
	}
	if resp.DeviceToken == "" {
		t.Fatal("expected device token on re-registration")
	}
}

func TestSuggestAlternateDeviceID(t *testing.T) {
	if got := suggestAlternateDeviceID("BD-ABC"); got != "BD-ABC-2" {
		t.Fatalf("got %q", got)
	}
	if got := suggestAlternateDeviceID("BD-ABC-2"); got != "BD-ABC-3" {
		t.Fatalf("got %q", got)
	}
}
