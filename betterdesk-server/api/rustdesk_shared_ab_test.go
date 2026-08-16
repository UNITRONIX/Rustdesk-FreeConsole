package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/peer"
)

func TestHandleClientABSharedProfiles(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	srv := New(config.DefaultConfig(), database, peer.NewMap(), nil, "test")
	req := httptest.NewRequest(http.MethodPost, "/api/ab/shared/profiles?current=1&pageSize=100", nil)
	req = withClientUser(req, "alice", "admin")
	rec := httptest.NewRecorder()

	srv.handleClientABSharedProfiles(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if int(body["total"].(float64)) != 1 {
		t.Fatalf("total = %v, want 1", body["total"])
	}
	data, _ := body["data"].([]any)
	if len(data) != 1 {
		t.Fatalf("data len = %d", len(data))
	}
	profile := data[0].(map[string]any)
	if profile["guid"] != sharedDevicesABGUID {
		t.Fatalf("guid = %v", profile["guid"])
	}
	if profile["name"] != sharedDevicesABName {
		t.Fatalf("name = %v", profile["name"])
	}
}

func TestHandleClientABSettings(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	srv := New(config.DefaultConfig(), database, peer.NewMap(), nil, "test")
	req := httptest.NewRequest(http.MethodPost, "/api/ab/settings", nil)
	req = withClientUser(req, "alice", "admin")
	rec := httptest.NewRecorder()
	srv.handleClientABSettings(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
}

func TestRustDeskABPeerJSONIncludesPassword(t *testing.T) {
	t.Parallel()
	got := rustDeskABPeerJSON(map[string]any{
		"id": "1783243043", "alias": "Training",
	}, "secret-pass")
	if got["password"] != "secret-pass" {
		t.Fatalf("password = %v", got["password"])
	}
	if got["forceAlwaysRelay"] != "false" {
		t.Fatalf("forceAlwaysRelay must be string false, got %v", got["forceAlwaysRelay"])
	}
}
