package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func enrollmentTestState(t *testing.T) *AppState {
	t.Helper()
	t.Setenv("BETTERDESK_AGENT_DATA_DIR", t.TempDir())

	st, err := LoadState()
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func enrollmentTestBranding(serverURL string) Branding {
	return Branding{
		ServerAddress: serverURL,
		Server: &ServerBranding{
			Address: serverURL,
			APIURL:  serverURL + "/api",
		},
	}
}

func TestPollEnrollmentPersistsRejectedServerState(t *testing.T) {
	st := enrollmentTestState(t)
	if err := st.SetEnrollment(EnrollmentPending, st.DeviceID, "", "Waiting for approval"); err != nil {
		t.Fatal(err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/devices/register/status" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(enrollmentResponse{
			Status:   EnrollmentRejected,
			DeviceID: st.DeviceID,
			Message:  "Device enrollment was rejected",
		})
	}))
	defer server.Close()

	res, err := PollEnrollment(enrollmentTestBranding(server.URL), st, "test")
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != EnrollmentRejected {
		t.Fatalf("status = %q, want %q", res.Status, EnrollmentRejected)
	}

	status, token, message := st.EnrollmentSnapshot()
	if status != EnrollmentRejected || token != "" || message != "Device enrollment was rejected" {
		t.Fatalf("persisted enrollment = status=%q token=%q message=%q", status, token, message)
	}
}

func TestEnsureEnrolledDoesNotUseCachedTokenAfterRejection(t *testing.T) {
	st := enrollmentTestState(t)
	if err := st.SetEnrollment(EnrollmentApproved, st.DeviceID, "cached-device-token", ""); err != nil {
		t.Fatal(err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/devices/register" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(enrollmentResponse{
			Status:   EnrollmentRejected,
			DeviceID: st.DeviceID,
			Message:  "Device is banned",
		})
	}))
	defer server.Close()

	res, err := EnsureEnrolled(enrollmentTestBranding(server.URL), st, "test")
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != EnrollmentRejected || res.Message != "Device is banned" {
		t.Fatalf("unexpected enrollment result: %+v", res)
	}

	status, token, _ := st.EnrollmentSnapshot()
	if status != EnrollmentRejected || token != "" {
		t.Fatalf("rejected enrollment retained a cached credential: status=%q token=%q", status, token)
	}
}

func TestPollEnrollmentKeepsExistingTokenOnOrdinaryApprovedRefresh(t *testing.T) {
	st := enrollmentTestState(t)
	if err := st.SetEnrollment(EnrollmentApproved, st.DeviceID, "existing-device-token", ""); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/devices/register/status" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer existing-device-token" {
			t.Fatalf("Authorization = %q, want device bearer token", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(enrollmentResponse{
			Status:   EnrollmentApproved,
			DeviceID: st.DeviceID,
		})
	}))
	defer server.Close()

	result, err := PollEnrollment(enrollmentTestBranding(server.URL), st, "test")
	if err != nil {
		t.Fatal(err)
	}
	if result.DeviceToken != "existing-device-token" {
		t.Fatalf("token = %q, want retained local token", result.DeviceToken)
	}
	status, token, _ := st.EnrollmentSnapshot()
	if status != EnrollmentApproved || token != "existing-device-token" {
		t.Fatalf("state = status=%q token=%q", status, token)
	}
}
