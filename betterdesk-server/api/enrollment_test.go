package api

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/peer"
)

func signedEnrollmentHeaders(t *testing.T, privateKey ed25519.PrivateKey, method, path, deviceID string, publicKey ed25519.PublicKey) http.Header {
	t.Helper()
	timestamp := time.Now().UTC().Format(time.RFC3339)
	nonce := fmt.Sprintf("%s-%d", t.Name(), time.Now().UnixNano())
	canonicalKey := base64.StdEncoding.EncodeToString(publicKey)
	signature := ed25519.Sign(privateKey, enrollmentProofPayload(method, path, deviceID, canonicalKey, timestamp, nonce))

	headers := make(http.Header)
	headers.Set("X-BD-Enrollment-Timestamp", timestamp)
	headers.Set("X-BD-Enrollment-Nonce", nonce)
	headers.Set("X-BD-Enrollment-Signature", base64.StdEncoding.EncodeToString(signature))
	return headers
}

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

	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	database.UpsertPeer(&db.Peer{
		ID:   "BD-TEST2",
		UUID: "same-machine-uuid",
	})

	cfg := config.DefaultConfig()
	cfg.EnrollmentMode = "open"
	srv := New(cfg, database, peer.NewMap(), nil, "test")
	if err := srv.storeBdMgmtPublicKey("BD-TEST2", base64.StdEncoding.EncodeToString(publicKey)); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/devices/register", srv.handleDeviceRegister)

	body, _ := json.Marshal(map[string]any{
		"device_id":   "BD-TEST2",
		"uuid":        "same-machine-uuid",
		"hostname":    "host-a",
		"platform":    "linux amd64",
		"device_type": "os_agent",
		"public_key":  base64.StdEncoding.EncodeToString(publicKey),
	})
	req := httptest.NewRequest(http.MethodPost, "/api/devices/register", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	applyHeaders(req, signedEnrollmentHeaders(t, privateKey, http.MethodPost, "/api/devices/register", "BD-TEST2", publicKey))
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

func TestDeviceRegisterDoesNotReissueTokenWithoutIdentityProof(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	publicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.UpsertPeer(&db.Peer{
		ID:   "BD-NOPROOF",
		UUID: "machine-uuid-no-proof",
	}); err != nil {
		t.Fatal(err)
	}

	srv := New(config.DefaultConfig(), database, peer.NewMap(), nil, "test")
	if err := srv.storeBdMgmtPublicKey("BD-NOPROOF", base64.StdEncoding.EncodeToString(publicKey)); err != nil {
		t.Fatal(err)
	}

	body, _ := json.Marshal(map[string]any{
		"device_id":  "BD-NOPROOF",
		"uuid":       "machine-uuid-no-proof",
		"public_key": base64.StdEncoding.EncodeToString(publicKey),
	})
	req := httptest.NewRequest(http.MethodPost, "/api/devices/register", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	srv.handleDeviceRegister(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", rec.Code, rec.Body.String())
	}
	var resp EnrollmentResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.DeviceToken != "" {
		t.Fatal("unauthenticated re-registration must not receive a device token")
	}
}

func TestDeviceRegisterStatusIssuesTokenOnlyAfterIdentityProof(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.UpsertPeer(&db.Peer{
		ID:   "BD-STATUS",
		UUID: "machine-uuid-status",
	}); err != nil {
		t.Fatal(err)
	}

	srv := New(config.DefaultConfig(), database, peer.NewMap(), nil, "test")
	if err := srv.storeBdMgmtPublicKey("BD-STATUS", base64.StdEncoding.EncodeToString(publicKey)); err != nil {
		t.Fatal(err)
	}

	noProof := httptest.NewRequest(http.MethodGet, "/api/devices/register/status?device_id=BD-STATUS", nil)
	noProofRec := httptest.NewRecorder()
	srv.handleDeviceRegisterStatus(noProofRec, noProof)
	var noProofResp EnrollmentResponse
	if err := json.Unmarshal(noProofRec.Body.Bytes(), &noProofResp); err != nil {
		t.Fatal(err)
	}
	if noProofResp.DeviceToken != "" {
		t.Fatal("unauthenticated status poll must not receive a device token")
	}

	proof := httptest.NewRequest(http.MethodGet, "/api/devices/register/status?device_id=BD-STATUS", nil)
	applyHeaders(proof, signedEnrollmentHeaders(t, privateKey, http.MethodGet, "/api/devices/register/status", "BD-STATUS", publicKey))
	proofRec := httptest.NewRecorder()
	srv.handleDeviceRegisterStatus(proofRec, proof)
	if proofRec.Code != http.StatusOK {
		t.Fatalf("signed status = %d, want 200: %s", proofRec.Code, proofRec.Body.String())
	}
	var proofResp EnrollmentResponse
	if err := json.Unmarshal(proofRec.Body.Bytes(), &proofResp); err != nil {
		t.Fatal(err)
	}
	if proofResp.DeviceToken == "" {
		t.Fatal("signed status poll must receive a device token")
	}

	refresh := httptest.NewRequest(http.MethodGet, "/api/devices/register/status?device_id=BD-STATUS", nil)
	applyHeaders(refresh, signedEnrollmentHeaders(t, privateKey, http.MethodGet, "/api/devices/register/status", "BD-STATUS", publicKey))
	refresh.Header.Set("Authorization", "Bearer "+proofResp.DeviceToken)
	refreshRec := httptest.NewRecorder()
	srv.handleDeviceRegisterStatus(refreshRec, refresh)
	if refreshRec.Code != http.StatusOK {
		t.Fatalf("authenticated refresh = %d, want 200: %s", refreshRec.Code, refreshRec.Body.String())
	}
	var refreshResp EnrollmentResponse
	if err := json.Unmarshal(refreshRec.Body.Bytes(), &refreshResp); err != nil {
		t.Fatal(err)
	}
	if refreshResp.DeviceToken != "" {
		t.Fatal("ordinary authenticated refresh must not re-issue a device token")
	}
}

func TestEnrollmentProofCannotBeReplayed(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.UpsertPeer(&db.Peer{ID: "BD-REPLAY", UUID: "machine-uuid-replay"}); err != nil {
		t.Fatal(err)
	}
	srv := New(config.DefaultConfig(), database, peer.NewMap(), nil, "test")
	if err := srv.storeBdMgmtPublicKey("BD-REPLAY", base64.StdEncoding.EncodeToString(publicKey)); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/devices/register/status?device_id=BD-REPLAY", nil)
	applyHeaders(req, signedEnrollmentHeaders(t, privateKey, http.MethodGet, "/api/devices/register/status", "BD-REPLAY", publicKey))
	if err := srv.verifyEnrollmentDeviceProof(req, "BD-REPLAY", ""); err != nil {
		t.Fatalf("first proof verification: %v", err)
	}
	if err := srv.verifyEnrollmentDeviceProof(req, "BD-REPLAY", ""); err == nil {
		t.Fatal("replayed enrollment proof was accepted")
	}
}

func TestOpenEnrollmentRequiresProofBeforeIssuingDeviceToken(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	srv := New(config.DefaultConfig(), database, peer.NewMap(), nil, "test")

	body, _ := json.Marshal(map[string]any{
		"device_id":   "BD-OPEN01",
		"uuid":        "machine-uuid-open",
		"device_type": "os_agent",
		"public_key":  base64.StdEncoding.EncodeToString(publicKey),
	})
	unauthenticated := httptest.NewRequest(http.MethodPost, "/api/devices/register", bytes.NewReader(body))
	unauthenticatedRec := httptest.NewRecorder()
	srv.handleDeviceRegister(unauthenticatedRec, unauthenticated)
	var unauthenticatedResp EnrollmentResponse
	if err := json.Unmarshal(unauthenticatedRec.Body.Bytes(), &unauthenticatedResp); err != nil {
		t.Fatal(err)
	}
	if unauthenticatedResp.DeviceToken != "" {
		t.Fatal("open enrollment without proof must not issue a device token")
	}

	proof := httptest.NewRequest(http.MethodPost, "/api/devices/register", bytes.NewReader(body))
	applyHeaders(proof, signedEnrollmentHeaders(t, privateKey, http.MethodPost, "/api/devices/register", "BD-OPEN01", publicKey))
	proofRec := httptest.NewRecorder()
	srv.handleDeviceRegister(proofRec, proof)
	var proofResp EnrollmentResponse
	if err := json.Unmarshal(proofRec.Body.Bytes(), &proofResp); err != nil {
		t.Fatal(err)
	}
	if proofResp.DeviceToken == "" {
		t.Fatal("open enrollment with proof must issue a device token")
	}
}

func TestManagedApprovalPreservesEnrollmentMetadata(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	publicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.DefaultConfig()
	cfg.EnrollmentMode = config.EnrollmentModeManaged
	srv := New(cfg, database, peer.NewMap(), nil, "test")

	body, _ := json.Marshal(map[string]any{
		"device_id":   "BD-META1",
		"uuid":        "machine-uuid-metadata",
		"hostname":    "agent-host",
		"platform":    "linux",
		"version":     "1.2.3",
		"device_type": "os_agent",
		"bundle_id":   "support-bundle-a",
		"tags":        "support, linux, support",
		"public_key":  base64.StdEncoding.EncodeToString(publicKey),
	})
	register := httptest.NewRequest(http.MethodPost, "/api/devices/register", bytes.NewReader(body))
	registerRec := httptest.NewRecorder()
	srv.handleDeviceRegister(registerRec, register)
	if registerRec.Code != http.StatusAccepted {
		t.Fatalf("managed registration status = %d, want 202: %s", registerRec.Code, registerRec.Body.String())
	}

	pendingRaw, err := database.GetConfig(pendingDevicePrefix + "BD-META1")
	if err != nil {
		t.Fatal(err)
	}
	pending := parsePendingEnrollmentMeta(pendingRaw)
	if pending.UUID != "machine-uuid-metadata" || pending.DeviceType != "os_agent" ||
		pending.BundleID != "support-bundle-a" || pending.Tags != "support,linux" ||
		pending.PublicKey != base64.StdEncoding.EncodeToString(publicKey) {
		t.Fatalf("pending metadata was not preserved: %+v", pending)
	}

	approve := httptest.NewRequest(http.MethodPost, "/api/enrollment/approve/BD-META1", bytes.NewBufferString(`{"sync_mode":"standard"}`))
	approve.SetPathValue("id", "BD-META1")
	approveRec := httptest.NewRecorder()
	srv.handleApproveDevice(approveRec, approve)
	if approveRec.Code != http.StatusOK {
		t.Fatalf("approval status = %d, want 200: %s", approveRec.Code, approveRec.Body.String())
	}

	approved, err := database.GetPeer("BD-META1")
	if err != nil {
		t.Fatal(err)
	}
	if approved == nil {
		t.Fatal("approved peer missing")
	}
	if approved.UUID != "machine-uuid-metadata" || approved.DeviceType != "os_agent" || approved.Tags != "support,linux" {
		t.Fatalf("approved peer metadata = %+v", approved)
	}
	if bundleID, err := database.GetConfig(deviceBundleIDPrefix + "BD-META1"); err != nil || bundleID != "support-bundle-a" {
		t.Fatalf("bundle ID = %q, err=%v", bundleID, err)
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

func TestEnrollmentProofReplayCannotUseBoundTokenFallback(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	const deviceID = "BD-PROOF-REPLAY"
	if err := database.UpsertPeer(&db.Peer{ID: deviceID, UUID: "proof-replay-machine"}); err != nil {
		t.Fatal(err)
	}

	srv := New(config.DefaultConfig(), database, peer.NewMap(), nil, "test")
	if err := srv.storeBdMgmtPublicKey(deviceID, base64.StdEncoding.EncodeToString(publicKey)); err != nil {
		t.Fatal(err)
	}
	boundToken, err := srv.issueEnrollmentDeviceToken(deviceID)
	if err != nil {
		t.Fatal(err)
	}

	headers := signedEnrollmentHeaders(t, privateKey, http.MethodPost, "/api/devices/register", deviceID, publicKey)
	headers.Set("Authorization", "Bearer "+boundToken)
	newRequest := func() *http.Request {
		req := httptest.NewRequest(http.MethodPost, "/api/devices/register", nil)
		applyHeaders(req, headers)
		return req
	}

	if !srv.authorizeEnrollmentTokenIssue(newRequest(), deviceID, base64.StdEncoding.EncodeToString(publicKey), "", true) {
		t.Fatal("first proof should authorize token issuance")
	}
	if srv.authorizeEnrollmentTokenIssue(newRequest(), deviceID, base64.StdEncoding.EncodeToString(publicKey), "", true) {
		t.Fatal("replayed proof must not bypass nonce protection with a bound token")
	}
}

func TestEnrollmentStateBlocksRegistrationAndStatus(t *testing.T) {
	t.Run("rejected", func(t *testing.T) {
		database := testSetupDB(t)
		defer database.Close()

		const deviceID = "BD-REJECTED-STATE"
		if err := database.SetConfig(rejectedDevicePrefix+deviceID, `{"rejected":true}`); err != nil {
			t.Fatal(err)
		}
		srv := New(config.DefaultConfig(), database, peer.NewMap(), nil, "test")
		body, err := json.Marshal(map[string]any{
			"device_id": deviceID,
			"uuid":      "rejected-machine",
		})
		if err != nil {
			t.Fatal(err)
		}

		register := httptest.NewRecorder()
		srv.handleDeviceRegister(register, httptest.NewRequest(http.MethodPost, "/api/devices/register", bytes.NewReader(body)))
		if register.Code != http.StatusForbidden {
			t.Fatalf("rejected registration status = %d, want 403: %s", register.Code, register.Body.String())
		}
		if peerInfo, err := database.GetPeer(deviceID); err != nil || peerInfo != nil {
			t.Fatalf("rejected registration unexpectedly created peer: peer=%+v err=%v", peerInfo, err)
		}

		status := httptest.NewRecorder()
		srv.handleDeviceRegisterStatus(status, httptest.NewRequest(http.MethodGet, "/api/devices/register/status?device_id="+deviceID, nil))
		if status.Code != http.StatusForbidden {
			t.Fatalf("rejected status poll = %d, want 403: %s", status.Code, status.Body.String())
		}
	})

	t.Run("banned", func(t *testing.T) {
		database := testSetupDB(t)
		defer database.Close()

		const deviceID = "BD-BANNED-STATE"
		if err := database.UpsertPeer(&db.Peer{ID: deviceID, UUID: "banned-machine"}); err != nil {
			t.Fatal(err)
		}
		if err := database.BanPeer(deviceID, "test"); err != nil {
			t.Fatal(err)
		}
		srv := New(config.DefaultConfig(), database, peer.NewMap(), nil, "test")
		body, err := json.Marshal(map[string]any{
			"device_id": deviceID,
			"uuid":      "banned-machine",
		})
		if err != nil {
			t.Fatal(err)
		}

		register := httptest.NewRecorder()
		srv.handleDeviceRegister(register, httptest.NewRequest(http.MethodPost, "/api/devices/register", bytes.NewReader(body)))
		if register.Code != http.StatusForbidden {
			t.Fatalf("banned registration status = %d, want 403: %s", register.Code, register.Body.String())
		}

		status := httptest.NewRecorder()
		srv.handleDeviceRegisterStatus(status, httptest.NewRequest(http.MethodGet, "/api/devices/register/status?device_id="+deviceID, nil))
		if status.Code != http.StatusForbidden {
			t.Fatalf("banned status poll = %d, want 403: %s", status.Code, status.Body.String())
		}
	})

	t.Run("removed", func(t *testing.T) {
		database := testSetupDB(t)
		defer database.Close()

		const deviceID = "BD-REMOVED-STATE"
		if err := database.UpsertPeer(&db.Peer{ID: deviceID, UUID: "removed-machine"}); err != nil {
			t.Fatal(err)
		}
		if err := database.DeletePeer(deviceID); err != nil {
			t.Fatal(err)
		}
		srv := New(config.DefaultConfig(), database, peer.NewMap(), nil, "test")
		body, err := json.Marshal(map[string]any{
			"device_id": deviceID,
			"uuid":      "removed-machine",
		})
		if err != nil {
			t.Fatal(err)
		}

		register := httptest.NewRecorder()
		srv.handleDeviceRegister(register, httptest.NewRequest(http.MethodPost, "/api/devices/register", bytes.NewReader(body)))
		if register.Code != http.StatusForbidden {
			t.Fatalf("removed registration status = %d, want 403: %s", register.Code, register.Body.String())
		}

		status := httptest.NewRecorder()
		srv.handleDeviceRegisterStatus(status, httptest.NewRequest(http.MethodGet, "/api/devices/register/status?device_id="+deviceID, nil))
		if status.Code != http.StatusForbidden {
			t.Fatalf("removed status poll = %d, want 403: %s", status.Code, status.Body.String())
		}
	})
}
