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

func seedPendingEnrollment(t *testing.T, database db.Database, deviceID string) {
	t.Helper()
	payload := `{"device_id":"` + deviceID + `","hostname":"host-` + deviceID + `","platform":"linux","version":"1.0.0","ip":"10.0.0.9","created_at":"2026-01-01T00:00:00Z"}`
	if err := database.SetConfig(pendingDevicePrefix+deviceID, payload); err != nil {
		t.Fatalf("seed pending: %v", err)
	}
}

func TestEnrollmentRejectBanCreatesPeerAndHistory(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	const deviceID = "ENR-BAN1"
	seedPendingEnrollment(t, database, deviceID)

	cfg := config.DefaultConfig()
	srv := New(cfg, database, peer.NewMap(), nil, "test")
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/enrollment/reject/{id}", srv.handleRejectDevice)
	mux.HandleFunc("GET /api/enrollment/history", srv.handleListEnrollmentHistory)

	body, _ := json.Marshal(map[string]any{"ban": true})
	req := httptest.NewRequest(http.MethodPost, "/api/enrollment/reject/"+deviceID, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("reject: expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	pending, _ := database.GetConfig(pendingDevicePrefix + deviceID)
	if pending != "" {
		t.Fatal("pending_device should be removed after reject")
	}
	rejected, _ := database.GetConfig(rejectedDevicePrefix + deviceID)
	if rejected == "" {
		t.Fatal("rejected_device marker missing")
	}

	p, err := database.GetPeer(deviceID)
	if err != nil {
		t.Fatalf("GetPeer: %v", err)
	}
	if p == nil {
		t.Fatal("expected peer row created on reject+ban")
	}
	if !p.Banned {
		t.Fatal("peer should be banned")
	}
	if p.BanReason != enrollmentRejectBanReason {
		t.Fatalf("ban reason=%q, want %q", p.BanReason, enrollmentRejectBanReason)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/enrollment/history?status=rejected", nil)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("history: expected 200, got %d", rec.Code)
	}
	var hist struct {
		Devices []enrollmentDecision `json:"devices"`
		Count   int                  `json:"count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &hist); err != nil {
		t.Fatal(err)
	}
	if hist.Count != 1 || len(hist.Devices) != 1 {
		t.Fatalf("expected 1 rejected history row, got count=%d len=%d", hist.Count, len(hist.Devices))
	}
	if hist.Devices[0].DeviceID != deviceID || hist.Devices[0].Status != "rejected" || !hist.Devices[0].Banned {
		t.Fatalf("unexpected history entry: %+v", hist.Devices[0])
	}
}

func TestEnrollmentClearRejectionAllowsRequeue(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	const deviceID = "ENR-CLR1"
	seedPendingEnrollment(t, database, deviceID)

	cfg := config.DefaultConfig()
	srv := New(cfg, database, peer.NewMap(), nil, "test")
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/enrollment/reject/{id}", srv.handleRejectDevice)
	mux.HandleFunc("POST /api/enrollment/clear-rejection/{id}", srv.handleClearEnrollmentRejection)

	body, _ := json.Marshal(map[string]any{"ban": true})
	req := httptest.NewRequest(http.MethodPost, "/api/enrollment/reject/"+deviceID, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("reject: %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/enrollment/clear-rejection/"+deviceID, bytes.NewReader([]byte("{}")))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("clear: expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	var clearResp struct {
		Unbanned    bool `json:"unbanned"`
		PeerRemoved bool `json:"peer_removed"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &clearResp); err != nil {
		t.Fatal(err)
	}
	if !clearResp.Unbanned || !clearResp.PeerRemoved {
		t.Fatalf("clear response: unbanned=%v peer_removed=%v", clearResp.Unbanned, clearResp.PeerRemoved)
	}

	rejected, _ := database.GetConfig(rejectedDevicePrefix + deviceID)
	if rejected != "" {
		t.Fatal("rejected_device should be cleared")
	}
	decision, _ := database.GetConfig(enrollmentDecisionPrefix + deviceID)
	if decision != "" {
		t.Fatal("rejected enrollment_decision should be cleared")
	}

	p, err := database.GetPeer(deviceID)
	if err != nil {
		t.Fatalf("GetPeer: %v", err)
	}
	if p != nil {
		t.Fatal("enrollment-reject audit peer must be hard-deleted so managed mode re-queues")
	}
}

func TestEnrollmentClearRejectionWithoutBanKeepsNoPeer(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	const deviceID = "ENR-CLR2"
	seedPendingEnrollment(t, database, deviceID)

	cfg := config.DefaultConfig()
	srv := New(cfg, database, peer.NewMap(), nil, "test")
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/enrollment/reject/{id}", srv.handleRejectDevice)
	mux.HandleFunc("POST /api/enrollment/clear-rejection/{id}", srv.handleClearEnrollmentRejection)

	req := httptest.NewRequest(http.MethodPost, "/api/enrollment/reject/"+deviceID, bytes.NewReader([]byte("{}")))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("reject: %d %s", rec.Code, rec.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/enrollment/clear-rejection/"+deviceID, nil)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("clear: %d %s", rec.Code, rec.Body.String())
	}

	p, _ := database.GetPeer(deviceID)
	if p != nil {
		t.Fatal("reject without ban should not create a peer")
	}
	rejected, _ := database.GetConfig(rejectedDevicePrefix + deviceID)
	if rejected != "" {
		t.Fatal("rejection should be cleared")
	}
}

func TestEnrollmentUnbanRemovesAuditPeer(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	const deviceID = "ENR-UNBAN1"
	seedPendingEnrollment(t, database, deviceID)

	cfg := config.DefaultConfig()
	srv := New(cfg, database, peer.NewMap(), nil, "test")
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/enrollment/reject/{id}", srv.handleRejectDevice)
	mux.HandleFunc("POST /api/peers/{id}/unban", srv.handleUnbanPeer)

	body, _ := json.Marshal(map[string]any{"ban": true})
	req := httptest.NewRequest(http.MethodPost, "/api/enrollment/reject/"+deviceID, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("reject: %d", rec.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/peers/"+deviceID+"/unban", nil)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("unban: %d %s", rec.Code, rec.Body.String())
	}

	p, _ := database.GetPeer(deviceID)
	if p != nil {
		t.Fatal("unban of enrollment-reject peer must hard-delete audit row")
	}
	rejected, _ := database.GetConfig(rejectedDevicePrefix + deviceID)
	if rejected != "" {
		t.Fatal("unban should clear rejected_device")
	}
}

func TestEnrollmentManualBanUnbanKeepsPeer(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	const deviceID = "ENR-MANBAN1"
	if err := database.UpsertPeer(&db.Peer{ID: deviceID, Hostname: "keep-me", Status: "OFFLINE"}); err != nil {
		t.Fatal(err)
	}
	if err := database.BanPeer(deviceID, "manual panel ban"); err != nil {
		t.Fatal(err)
	}

	cfg := config.DefaultConfig()
	srv := New(cfg, database, peer.NewMap(), nil, "test")
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/peers/{id}/unban", srv.handleUnbanPeer)

	req := httptest.NewRequest(http.MethodPost, "/api/peers/"+deviceID+"/unban", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("unban: %d %s", rec.Code, rec.Body.String())
	}

	p, err := database.GetPeer(deviceID)
	if err != nil || p == nil {
		t.Fatal("manual ban unban must keep peer row")
	}
	if p.Banned {
		t.Fatal("peer should be unbanned")
	}
}

func TestEnrollmentHistoryIncludesOrphanRejected(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	const deviceID = "ENR-ORPHAN1"
	if err := database.SetConfig(rejectedDevicePrefix+deviceID, `{"rejected":true,"device_id":"`+deviceID+`","hostname":"old-host","banned":false}`); err != nil {
		t.Fatal(err)
	}

	cfg := config.DefaultConfig()
	srv := New(cfg, database, peer.NewMap(), nil, "test")
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/enrollment/history", srv.handleListEnrollmentHistory)

	req := httptest.NewRequest(http.MethodGet, "/api/enrollment/history?status=rejected", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("history: %d", rec.Code)
	}
	var hist struct {
		Devices []enrollmentDecision `json:"devices"`
		Count   int                  `json:"count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &hist); err != nil {
		t.Fatal(err)
	}
	if hist.Count != 1 || hist.Devices[0].DeviceID != deviceID || hist.Devices[0].Hostname != "old-host" {
		t.Fatalf("expected orphan rejected row, got %+v", hist)
	}
}

func TestEnrollmentHistoryOrphanBackfillsIPFromPeer(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	const deviceID = "ENR-ORPHAN-IP"
	if err := database.SetConfig(rejectedDevicePrefix+deviceID, `{"rejected":true}`); err != nil {
		t.Fatal(err)
	}
	if err := database.UpsertPeer(&db.Peer{ID: deviceID, Hostname: "legacy-host", IP: "203.0.113.50", Status: "OFFLINE"}); err != nil {
		t.Fatal(err)
	}

	cfg := config.DefaultConfig()
	srv := New(cfg, database, peer.NewMap(), nil, "test")
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/enrollment/history", srv.handleListEnrollmentHistory)

	req := httptest.NewRequest(http.MethodGet, "/api/enrollment/history?status=rejected", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("history: %d", rec.Code)
	}
	var hist struct {
		Devices []enrollmentDecision `json:"devices"`
		Count   int                  `json:"count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &hist); err != nil {
		t.Fatal(err)
	}
	if hist.Count != 1 || hist.Devices[0].DeviceID != deviceID {
		t.Fatalf("expected orphan row, got %+v", hist)
	}
	if hist.Devices[0].IP != "203.0.113.50" {
		t.Fatalf("expected peer IP backfill, got %q", hist.Devices[0].IP)
	}

	raw, err := database.GetConfig(rejectedDevicePrefix + deviceID)
	if err != nil || raw == "" {
		t.Fatalf("expected persisted rejected_device payload: %v %q", err, raw)
	}
	var persisted map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &persisted); err != nil {
		t.Fatal(err)
	}
	if persisted["ip"] != "203.0.113.50" {
		t.Fatalf("expected IP persisted into rejected_device_*, got %+v", persisted)
	}
}

func TestEnrollmentHistoryOrphanWithoutPeerKeepsEmptyIP(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	const deviceID = "ENR-ORPHAN-NOIP"
	if err := database.SetConfig(rejectedDevicePrefix+deviceID, `{"rejected":true}`); err != nil {
		t.Fatal(err)
	}

	cfg := config.DefaultConfig()
	srv := New(cfg, database, peer.NewMap(), nil, "test")
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/enrollment/history", srv.handleListEnrollmentHistory)

	req := httptest.NewRequest(http.MethodGet, "/api/enrollment/history?status=rejected", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("history: %d", rec.Code)
	}
	var hist struct {
		Devices []enrollmentDecision `json:"devices"`
		Count   int                  `json:"count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &hist); err != nil {
		t.Fatal(err)
	}
	if hist.Count != 1 || hist.Devices[0].DeviceID != deviceID {
		t.Fatalf("expected orphan row, got %+v", hist)
	}
	if hist.Devices[0].IP != "" {
		t.Fatalf("legacy orphan without peer must keep empty IP, got %q", hist.Devices[0].IP)
	}
}

func TestEnrollmentApprovePersistsHistoryAndClearsRejection(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	const deviceID = "ENR-APR1"
	seedPendingEnrollment(t, database, deviceID)
	_ = database.SetConfig(rejectedDevicePrefix+deviceID, `{"rejected":true}`)

	cfg := config.DefaultConfig()
	srv := New(cfg, database, peer.NewMap(), nil, "test")
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/enrollment/approve/{id}", srv.handleApproveDevice)
	mux.HandleFunc("GET /api/enrollment/history", srv.handleListEnrollmentHistory)

	body, _ := json.Marshal(map[string]any{
		"display_name": "Approved Host",
		"sync_mode":    "standard",
		"tags":         "",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/enrollment/approve/"+deviceID, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("approve: expected 200, got %d body=%s", rec.Code, rec.Body.String())
	}

	rejected, _ := database.GetConfig(rejectedDevicePrefix + deviceID)
	if rejected != "" {
		t.Fatal("approve should clear rejected_device marker")
	}

	req = httptest.NewRequest(http.MethodGet, "/api/enrollment/history?status=approved", nil)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("history: %d", rec.Code)
	}
	var hist struct {
		Devices []enrollmentDecision `json:"devices"`
		Count   int                  `json:"count"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &hist); err != nil {
		t.Fatal(err)
	}
	if hist.Count != 1 || hist.Devices[0].Status != "approved" || hist.Devices[0].DeviceID != deviceID {
		t.Fatalf("unexpected approved history: %+v", hist)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/enrollment/history?status=rejected", nil)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	_ = json.Unmarshal(rec.Body.Bytes(), &hist)
	if hist.Count != 0 {
		t.Fatalf("approved device should not appear in rejected filter, got %d", hist.Count)
	}
}

func TestEnrollmentHistoryStatusFilter(t *testing.T) {
	database := testSetupDB(t)
	defer database.Close()

	cfg := config.DefaultConfig()
	srv := New(cfg, database, peer.NewMap(), nil, "test")

	srv.storeEnrollmentDecision(enrollmentDecision{
		DeviceID: "H1", Status: "approved", DecidedAt: "2026-01-01T00:00:00Z",
	})
	srv.storeEnrollmentDecision(enrollmentDecision{
		DeviceID: "H2", Status: "rejected", Banned: true, DecidedAt: "2026-01-02T00:00:00Z",
	})

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/enrollment/history", srv.handleListEnrollmentHistory)

	req := httptest.NewRequest(http.MethodGet, "/api/enrollment/history", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	var hist struct {
		Count int `json:"count"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &hist)
	if hist.Count != 2 {
		t.Fatalf("unfiltered history count=%d want 2", hist.Count)
	}

	req = httptest.NewRequest(http.MethodGet, "/api/enrollment/history?status=approved", nil)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	_ = json.Unmarshal(rec.Body.Bytes(), &hist)
	if hist.Count != 1 {
		t.Fatalf("approved filter count=%d want 1", hist.Count)
	}
}
