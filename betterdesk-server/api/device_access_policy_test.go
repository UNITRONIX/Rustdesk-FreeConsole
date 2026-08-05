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

func TestDeviceSelfAccessPolicyNeverAcceptsPasswordMaterial(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()
	const deviceID = "BD-LOCAL-PASSWORD"
	if err := database.UpsertPeer(&db.Peer{ID: deviceID, Status: "ONLINE", DeviceType: "os_agent"}); err != nil {
		t.Fatal(err)
	}
	srv := New(config.DefaultConfig(), database, peer.NewMap(), nil, "test")
	token, err := srv.issueEnrollmentDeviceToken(deviceID)
	if err != nil {
		t.Fatal(err)
	}

	post := func(body map[string]any) *httptest.ResponseRecorder {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, "/api/devices/self/access-policy", bytes.NewReader(raw))
		rec := httptest.NewRecorder()
		srv.handleDeviceSelfAccessPolicy(rec, req)
		return rec
	}

	rec := post(map[string]any{
		"device_id": deviceID, "device_token": token,
		"password": "must-not-leave-the-agent", "password_set": true,
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("password payload status = %d body=%s", rec.Code, rec.Body.String())
	}

	rec = post(map[string]any{
		"device_id": deviceID, "device_token": token,
		"password_set": true, "unattended_enabled": true,
	})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("password status payload status = %d body=%s", rec.Code, rec.Body.String())
	}
	policy, err := database.GetAccessPolicy(deviceID)
	if err != nil {
		t.Fatal(err)
	}
	if !policy.PasswordSet || policy.PasswordHash != "LOCAL_ONLY" {
		t.Fatalf("expected local-only password marker, got %+v", policy)
	}
}

func TestDeviceTOTPIgnoresCredentialsInQueryString(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()
	const deviceID = "BD-TOTP-QUERY"
	if err := database.UpsertPeer(&db.Peer{ID: deviceID, Status: "ONLINE", DeviceType: "os_agent"}); err != nil {
		t.Fatal(err)
	}
	srv := New(config.DefaultConfig(), database, peer.NewMap(), nil, "test")
	token, err := srv.issueEnrollmentDeviceToken(deviceID)
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(
		http.MethodPost,
		"/api/devices/self/totp?device_id="+deviceID+"&device_token="+token,
		bytes.NewBufferString(`{"action":"status"}`),
	)
	rec := httptest.NewRecorder()
	srv.handleDeviceSelfTOTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("query credentials status = %d body=%s", rec.Code, rec.Body.String())
	}
}
