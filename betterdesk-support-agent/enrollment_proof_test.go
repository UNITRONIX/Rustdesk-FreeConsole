package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func proofTestState() *AppState {
	return &AppState{
		DeviceID:           "BD-ABC123",
		InstallationSecret: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
		DeviceToken:        "existing-device-token",
	}
}

func TestEnrollmentProofHeadersAreBoundToRequest(t *testing.T) {
	st := proofTestState()
	headers, err := enrollmentProofHeaders(http.MethodPost, "https://desk.example/api/devices/register", st.DeviceID, st)
	if err != nil {
		t.Fatal(err)
	}
	publicKey, _, err := enrollmentIdentity(st)
	if err != nil {
		t.Fatal(err)
	}
	timestamp := headers.Get(enrollmentProofTimestampHeader)
	nonce := headers.Get(enrollmentProofNonceHeader)
	signature, err := base64.StdEncoding.DecodeString(headers.Get(enrollmentProofSignatureHeader))
	if err != nil {
		t.Fatal(err)
	}
	payload := fmt.Sprintf(
		"bd-enrollment-v1\n%s\n%s\n%s\n%s\n%s\n%s",
		http.MethodPost,
		"/api/devices/register",
		st.DeviceID,
		base64.StdEncoding.EncodeToString(publicKey),
		timestamp,
		nonce,
	)
	if !ed25519.Verify(publicKey, []byte(payload), signature) {
		t.Fatal("enrollment proof did not verify")
	}
	if headers.Get("Authorization") != "Bearer existing-device-token" {
		t.Fatalf("unexpected authorization header: %q", headers.Get("Authorization"))
	}
}

func TestEnrollmentPublicKeyIsStablePerInstallation(t *testing.T) {
	st := proofTestState()
	first, err := enrollmentPublicKey(st)
	if err != nil {
		t.Fatal(err)
	}
	second, err := enrollmentPublicKey(st)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("identity changed: %q != %q", first, second)
	}
}

func TestAPIJSONWithHeadersForwardsProofWithoutURLSecrets(t *testing.T) {
	st := proofTestState()
	var gotAuthorization string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuthorization = r.Header.Get("Authorization")
		if r.URL.RawQuery != "" {
			t.Errorf("unexpected query data: %q", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"approved"}`))
	}))
	defer server.Close()

	headers, err := enrollmentProofHeaders(http.MethodPost, server.URL+"/api/devices/register", st.DeviceID, st)
	if err != nil {
		t.Fatal(err)
	}
	var response struct {
		Status string `json:"status"`
	}
	code, err := apiJSONWithHeaders(http.MethodPost, server.URL+"/api/devices/register", map[string]string{"device_id": st.DeviceID}, headers, &response)
	if err != nil {
		t.Fatal(err)
	}
	if code != http.StatusOK || response.Status != "approved" {
		t.Fatalf("unexpected response code=%d payload=%+v", code, response)
	}
	if gotAuthorization != "Bearer existing-device-token" {
		t.Fatalf("authorization header not forwarded: %q", gotAuthorization)
	}
}
