package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/peer"
	"github.com/unitronix/betterdesk-server/ratelimit"
	"github.com/unitronix/betterdesk-server/security"
)

const testAPIKey = "test-api-key-12345"

// testAuthReq adds the X-API-Key header for authenticated test requests.
func testAuthReq(req *http.Request) *http.Request {
	req.Header.Set("X-API-Key", testAPIKey)
	return req
}

func testAuthGet(url string) (*http.Response, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	return http.DefaultClient.Do(testAuthReq(req))
}

// testSetupDB creates a temp database with migration and API key configured.
func testSetupDB(t *testing.T) db.Database {
	t.Helper()
	dir := t.TempDir()
	database, err := db.OpenSQLite(dir + "/test.db")
	if err != nil {
		t.Fatal(err)
	}
	database.Migrate()
	hash := sha256.Sum256([]byte(testAPIKey))
	if err := database.CreateAPIKey(&db.APIKey{
		KeyHash:   hex.EncodeToString(hash[:]),
		KeyPrefix: testAPIKey[:8],
		Name:      "test-key",
		Role:      "admin",
	}); err != nil {
		t.Fatal(err)
	}
	return database
}

func TestHealthEndpoint(t *testing.T) {
	cfg := config.DefaultConfig()
	database := testSetupDB(t)
	defer database.Close()

	// Add some test peers
	database.UpsertPeer(&db.Peer{ID: "T1", Status: "ONLINE"})
	database.UpsertPeer(&db.Peer{ID: "T2", Status: "OFFLINE"})

	peerMap := peer.NewMap()

	cfg.APIPort = 19876
	srv := New(cfg, database, peerMap, nil, "1.0.0-test")

	if err := srv.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	time.Sleep(100 * time.Millisecond)

	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/api/health", cfg.APIPort))
	if err != nil {
		t.Fatalf("GET /api/health: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		t.Errorf("status: %d", resp.StatusCode)
	}

	var body map[string]any
	json.NewDecoder(resp.Body).Decode(&body)

	if body["status"] != "ok" {
		t.Errorf("status field: %v", body["status"])
	}
	if body["version"] != "1.0.0-test" {
		t.Errorf("version: %v", body["version"])
	}
	if body["peers_total"].(float64) != 2 {
		t.Errorf("peers_total: %v", body["peers_total"])
	}
}

func TestServerStatsEndpoint(t *testing.T) {
	cfg := config.DefaultConfig()
	database := testSetupDB(t)
	defer database.Close()

	peerMap := peer.NewMap()
	peerMap.Put(&peer.Entry{ID: "MEM1", LastReg: time.Now()})

	cfg.APIPort = 19877
	srv := New(cfg, database, peerMap, nil, "1.0.0-test")

	if err := srv.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	time.Sleep(100 * time.Millisecond)

	resp, err := testAuthGet(fmt.Sprintf("http://127.0.0.1:%d/api/server/stats", cfg.APIPort))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	var body map[string]any
	json.NewDecoder(resp.Body).Decode(&body)

	if body["peers_in_memory"].(float64) != 1 {
		t.Errorf("peers_in_memory: %v", body["peers_in_memory"])
	}
	if body["go_version"] == nil {
		t.Error("go_version should be present")
	}
}

func TestListPeersEndpoint(t *testing.T) {
	cfg := config.DefaultConfig()
	database := testSetupDB(t)
	defer database.Close()

	database.UpsertPeer(&db.Peer{ID: "P1", Hostname: "pc-1", Status: "ONLINE"})
	database.UpsertPeer(&db.Peer{ID: "P2", Hostname: "pc-2", Status: "OFFLINE"})

	peerMap := peer.NewMap()

	cfg.APIPort = 19878
	srv := New(cfg, database, peerMap, nil, "test")
	srv.Start(t.Context())
	defer srv.Stop()
	time.Sleep(100 * time.Millisecond)

	resp, err := testAuthGet(fmt.Sprintf("http://127.0.0.1:%d/api/peers", cfg.APIPort))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	var peers []map[string]any
	json.NewDecoder(resp.Body).Decode(&peers)

	if len(peers) != 2 {
		t.Errorf("expected 2 peers, got %d", len(peers))
	}
}

func TestListPeersPaginatedEndpoint(t *testing.T) {
	cfg := config.DefaultConfig()
	database := testSetupDB(t)
	defer database.Close()

	for i := 1; i <= 3; i++ {
		id := fmt.Sprintf("PG%02d", i)
		database.UpsertPeer(&db.Peer{ID: id, Hostname: id, Status: "ONLINE"})
	}

	peerMap := peer.NewMap()
	cfg.APIPort = 19880
	srv := New(cfg, database, peerMap, nil, "test")
	srv.Start(t.Context())
	defer srv.Stop()
	time.Sleep(100 * time.Millisecond)

	resp, err := testAuthGet(fmt.Sprintf("http://127.0.0.1:%d/api/peers?limit=2&page=1", cfg.APIPort))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if int(body["total"].(float64)) != 3 {
		t.Fatalf("total = %v, want 3", body["total"])
	}
	data, ok := body["data"].([]any)
	if !ok || len(data) != 2 {
		t.Fatalf("data len = %d, want 2", len(data))
	}
}

func TestBanUnbanEndpoint(t *testing.T) {
	cfg := config.DefaultConfig()
	database := testSetupDB(t)
	defer database.Close()

	database.UpsertPeer(&db.Peer{ID: "BAN1", Status: "ONLINE"})
	peerMap := peer.NewMap()

	cfg.APIPort = 19879
	srv := New(cfg, database, peerMap, nil, "test")
	srv.Start(t.Context())
	defer srv.Stop()
	time.Sleep(100 * time.Millisecond)

	// Ban
	req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/api/peers/BAN1/ban", cfg.APIPort), nil)
	testAuthReq(req)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("ban status: %d", resp.StatusCode)
	}

	banned, _ := database.IsPeerBanned("BAN1")
	if !banned {
		t.Error("peer should be banned")
	}

	// Unban
	req, _ = http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/api/peers/BAN1/unban", cfg.APIPort), nil)
	testAuthReq(req)
	resp, _ = http.DefaultClient.Do(req)
	resp.Body.Close()

	banned, _ = database.IsPeerBanned("BAN1")
	if banned {
		t.Error("peer should be unbanned")
	}
}

// TestBanRemovesPeerFromMap verifies that banning a peer removes it from the
// in-memory peer map so it can no longer receive heartbeats or be targeted
// for PunchHole/Relay operations.
func TestBanRemovesPeerFromMap(t *testing.T) {
	cfg := config.DefaultConfig()
	database := testSetupDB(t)
	defer database.Close()

	database.UpsertPeer(&db.Peer{ID: "EVICT1", Status: "ONLINE"})
	peerMap := peer.NewMap()
	peerMap.Put(&peer.Entry{
		ID:        "EVICT1",
		LastReg:   time.Now(),
		FirstSeen: time.Now(),
		ConnType:  peer.ConnUDP,
	})

	// Verify peer is in the map before ban
	if peerMap.Get("EVICT1") == nil {
		t.Fatal("peer should exist in map before ban")
	}

	cfg.APIPort = 19885
	srv := New(cfg, database, peerMap, nil, "test")
	srv.Start(t.Context())
	defer srv.Stop()
	time.Sleep(100 * time.Millisecond)

	// Ban the peer
	req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/api/peers/EVICT1/ban", cfg.APIPort),
		strings.NewReader(`{"reason":"test ban"}`))
	req.Header.Set("Content-Type", "application/json")
	testAuthReq(req)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("ban returned status %d", resp.StatusCode)
	}

	// Verify: peer should be removed from memory map
	if peerMap.Get("EVICT1") != nil {
		t.Error("peer should be removed from memory map after ban")
	}

	// Verify: peer should be banned in database
	banned, _ := database.IsPeerBanned("EVICT1")
	if !banned {
		t.Error("peer should be banned in database")
	}

	// Verify: peer status should be OFFLINE in database
	dbPeer, _ := database.GetPeer("EVICT1")
	if dbPeer != nil && dbPeer.Status != "OFFLINE" {
		t.Errorf("peer status should be OFFLINE, got %s", dbPeer.Status)
	}
}

func TestChangePeerIDSoftDeletedTargetReturnsConflict(t *testing.T) {
	cfg := config.DefaultConfig()
	database := testSetupDB(t)
	defer database.Close()

	if err := database.UpsertPeer(&db.Peer{ID: "OLD213", Status: "ONLINE"}); err != nil {
		t.Fatal(err)
	}
	if err := database.UpsertPeer(&db.Peer{ID: "MACPRO", Status: "OFFLINE"}); err != nil {
		t.Fatal(err)
	}
	if err := database.DeletePeer("MACPRO"); err != nil {
		t.Fatal(err)
	}

	peerMap := peer.NewMap()
	cfg.APIPort = 19886
	srv := New(cfg, database, peerMap, nil, "test")
	srv.Start(t.Context())
	defer srv.Stop()
	time.Sleep(100 * time.Millisecond)

	req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/api/peers/OLD213/change-id", cfg.APIPort),
		strings.NewReader(`{"new_id":"MACPRO"}`))
	req.Header.Set("Content-Type", "application/json")
	testAuthReq(req)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusConflict)
	}

	var body map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(body["error"], "deleted device") {
		t.Fatalf("error = %q, want deleted-device conflict", body["error"])
	}
}

func TestStatusSummaryEndpoint(t *testing.T) {
	cfg := config.DefaultConfig()
	database := testSetupDB(t)
	defer database.Close()

	peerMap := peer.NewMap()
	peerMap.Put(&peer.Entry{ID: "ON1", LastReg: time.Now(), FirstSeen: time.Now(), ConnType: peer.ConnUDP, MissedBeats: 0})
	peerMap.Put(&peer.Entry{ID: "DEG1", LastReg: time.Now(), FirstSeen: time.Now(), ConnType: peer.ConnTCP, MissedBeats: 3})
	peerMap.Put(&peer.Entry{ID: "CRIT1", LastReg: time.Now(), FirstSeen: time.Now(), ConnType: peer.ConnWS, MissedBeats: 5})

	cfg.APIPort = 19880
	srv := New(cfg, database, peerMap, nil, "test")
	srv.Start(t.Context())
	defer srv.Stop()
	time.Sleep(100 * time.Millisecond)

	resp, err := testAuthGet(fmt.Sprintf("http://127.0.0.1:%d/api/peers/status/summary", cfg.APIPort))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	var body map[string]any
	json.NewDecoder(resp.Body).Decode(&body)

	if body["total"].(float64) != 3 {
		t.Errorf("total: %v", body["total"])
	}
	if body["online"].(float64) != 1 {
		t.Errorf("online: %v", body["online"])
	}
	if body["degraded"].(float64) != 1 {
		t.Errorf("degraded: %v", body["degraded"])
	}
	if body["critical"].(float64) != 1 {
		t.Errorf("critical: %v", body["critical"])
	}
}

func TestOnlinePeersEndpoint(t *testing.T) {
	cfg := config.DefaultConfig()
	database := testSetupDB(t)
	defer database.Close()

	peerMap := peer.NewMap()
	peerMap.Put(&peer.Entry{
		ID: "LIVE1", LastReg: time.Now(), FirstSeen: time.Now(),
		ConnType: peer.ConnUDP, Version: "1.2.3",
	})
	peerMap.Put(&peer.Entry{
		ID: "LIVE2", LastReg: time.Now(), FirstSeen: time.Now(),
		ConnType: peer.ConnTCP, MissedBeats: 3,
	})

	cfg.APIPort = 19881
	srv := New(cfg, database, peerMap, nil, "test")
	srv.Start(t.Context())
	defer srv.Stop()
	time.Sleep(100 * time.Millisecond)

	resp, err := testAuthGet(fmt.Sprintf("http://127.0.0.1:%d/api/peers/online", cfg.APIPort))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	var body map[string]any
	json.NewDecoder(resp.Body).Decode(&body)

	if body["count"].(float64) != 2 {
		t.Errorf("count: %v", body["count"])
	}
}

func TestPeerStatusEndpoint(t *testing.T) {
	cfg := config.DefaultConfig()
	database := testSetupDB(t)
	defer database.Close()

	// Add peer to memory (live)
	peerMap := peer.NewMap()
	peerMap.Put(&peer.Entry{
		ID: "LIVE1", LastReg: time.Now(), FirstSeen: time.Now(),
		ConnType: peer.ConnUDP, Version: "1.2.3", HeartbeatCount: 10,
	})

	// Add peer to DB only (offline)
	database.UpsertPeer(&db.Peer{ID: "DBONLY", Status: "OFFLINE", Hostname: "my-pc"})

	cfg.APIPort = 19882
	srv := New(cfg, database, peerMap, nil, "test")
	srv.Start(t.Context())
	defer srv.Stop()
	time.Sleep(100 * time.Millisecond)

	// Test live peer
	resp, err := testAuthGet(fmt.Sprintf("http://127.0.0.1:%d/api/peers/LIVE1/status", cfg.APIPort))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	var body map[string]any
	json.NewDecoder(resp.Body).Decode(&body)

	if body["in_memory"] != true {
		t.Errorf("in_memory: %v", body["in_memory"])
	}
	snapshot := body["snapshot"].(map[string]any)
	if snapshot["id"] != "LIVE1" {
		t.Errorf("snapshot.id: %v", snapshot["id"])
	}
	if snapshot["status"] != "ONLINE" {
		t.Errorf("snapshot.status: %v", snapshot["status"])
	}

	// Test offline peer (DB only)
	resp2, err := testAuthGet(fmt.Sprintf("http://127.0.0.1:%d/api/peers/DBONLY/status", cfg.APIPort))
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()

	var body2 map[string]any
	json.NewDecoder(resp2.Body).Decode(&body2)

	if body2["in_memory"] != false {
		t.Errorf("in_memory: %v", body2["in_memory"])
	}
	if body2["status"] != "OFFLINE" {
		t.Errorf("status: %v", body2["status"])
	}

	// Test nonexistent peer
	resp3, err := testAuthGet(fmt.Sprintf("http://127.0.0.1:%d/api/peers/NOPE/status", cfg.APIPort))
	if err != nil {
		t.Fatal(err)
	}
	defer resp3.Body.Close()
	if resp3.StatusCode != 404 {
		t.Errorf("nonexistent peer status: %d", resp3.StatusCode)
	}
}

func TestBlocklistEndpoints(t *testing.T) {
	cfg := config.DefaultConfig()
	database := testSetupDB(t)
	defer database.Close()

	peerMap := peer.NewMap()
	bl := security.NewBlocklist()

	cfg.APIPort = 19883
	srv := New(cfg, database, peerMap, nil, "test")
	srv.SetBlocklist(bl)
	srv.Start(t.Context())
	defer srv.Stop()
	time.Sleep(100 * time.Millisecond)

	baseURL := fmt.Sprintf("http://127.0.0.1:%d", cfg.APIPort)

	// List (initially empty)
	resp, _ := testAuthGet(baseURL + "/api/blocklist")
	var body map[string]any
	json.NewDecoder(resp.Body).Decode(&body)
	resp.Body.Close()
	if body["count"].(float64) != 0 {
		t.Errorf("initial count: %v", body["count"])
	}

	// Add IP
	req, _ := http.NewRequest("POST", baseURL+"/api/blocklist",
		strings.NewReader(`{"value":"10.0.0.1","type":"ip","reason":"test"}`))
	req.Header.Set("Content-Type", "application/json")
	testAuthReq(req)
	resp, _ = http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("add IP status: %d", resp.StatusCode)
	}

	// Verify added
	if !bl.IsIPBlocked("10.0.0.1") {
		t.Error("10.0.0.1 should be blocked")
	}

	// Remove
	req, _ = http.NewRequest("DELETE", baseURL+"/api/blocklist/10.0.0.1", nil)
	testAuthReq(req)
	resp, _ = http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("remove status: %d", resp.StatusCode)
	}

	if bl.IsIPBlocked("10.0.0.1") {
		t.Error("10.0.0.1 should be unblocked after removal")
	}
}

func TestServerStatsWithBandwidthAndBlocklist(t *testing.T) {
	cfg := config.DefaultConfig()
	database := testSetupDB(t)
	defer database.Close()

	peerMap := peer.NewMap()
	peerMap.Put(&peer.Entry{ID: "X", LastReg: time.Now(), FirstSeen: time.Now()})

	bl := security.NewBlocklist()
	bl.BlockIP("1.2.3.4", "test")

	bwLimiter := ratelimit.NewBandwidthLimiter(1024*1024, 64*1024)

	cfg.APIPort = 19884
	srv := New(cfg, database, peerMap, nil, "test")
	srv.SetBlocklist(bl)
	srv.SetBandwidthLimiter(bwLimiter)
	srv.Start(t.Context())
	defer srv.Stop()
	time.Sleep(100 * time.Millisecond)

	resp, _ := testAuthGet(fmt.Sprintf("http://127.0.0.1:%d/api/server/stats", cfg.APIPort))
	var body map[string]any
	json.NewDecoder(resp.Body).Decode(&body)
	resp.Body.Close()

	if body["blocklist_count"].(float64) != 1 {
		t.Errorf("blocklist_count: %v", body["blocklist_count"])
	}
	if body["peers_online_live"].(float64) != 1 {
		t.Errorf("peers_online_live: %v", body["peers_online_live"])
	}
	if _, ok := body["bandwidth_bytes_transferred"]; !ok {
		t.Error("bandwidth_bytes_transferred should be present")
	}
	if _, ok := body["total_registrations"]; !ok {
		t.Error("total_registrations should be present")
	}
}
