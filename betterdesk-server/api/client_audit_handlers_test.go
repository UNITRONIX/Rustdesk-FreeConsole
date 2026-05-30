package api

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/unitronix/betterdesk-server/config"
	cryptopkg "github.com/unitronix/betterdesk-server/crypto"
	"github.com/unitronix/betterdesk-server/peer"
)

// startTestServer spins up a Server on the given port with a generated keypair.
func startTestServer(t *testing.T, port int) (*config.Config, func()) {
	t.Helper()
	cfg := config.DefaultConfig()
	cfg.APIPort = port
	database := testSetupDB(t)
	kp, err := cryptopkg.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	srv := New(cfg, database, peer.NewMap(), nil, "1.0.0-test")
	srv.SetKeyPair(kp)
	if err := srv.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	return cfg, func() {
		srv.Stop()
		database.Close()
	}
}

func TestAuditConnEndpoint(t *testing.T) {
	cfg, cleanup := startTestServer(t, 19901)
	defer cleanup()
	base := fmt.Sprintf("http://127.0.0.1:%d", cfg.APIPort)

	// POST is public (no auth) — client reports a connection event.
	payload := map[string]any{
		"host_id":   1340238749, // numeric host_id (RustDesk client behaviour)
		"peer_id":   "PEER01",
		"peer_name": "workstation",
		"action":    "connect",
		"conn_type": 0,
	}
	body, _ := json.Marshal(payload)
	resp, err := http.Post(base+"/api/audit/conn", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST /api/audit/conn: %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("POST status: %d", resp.StatusCode)
	}
	resp.Body.Close()

	// GET requires auth and returns {data, total}.
	resp, err = testAuthGet(base + "/api/audit/conn")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("GET status: %d", resp.StatusCode)
	}
	var out struct {
		Data  []map[string]any `json:"data"`
		Total int              `json:"total"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Total != 1 || len(out.Data) != 1 {
		t.Fatalf("expected 1 record, got total=%d len=%d", out.Total, len(out.Data))
	}
	if out.Data[0]["host_id"] != "1340238749" {
		t.Errorf("host_id coercion: %v", out.Data[0]["host_id"])
	}
}

func TestAuditConnRequiresHostID(t *testing.T) {
	cfg, cleanup := startTestServer(t, 19902)
	defer cleanup()
	base := fmt.Sprintf("http://127.0.0.1:%d", cfg.APIPort)

	body, _ := json.Marshal(map[string]any{"peer_id": "P1"})
	resp, err := http.Post(base+"/api/audit/conn", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Errorf("expected 400 for missing host_id, got %d", resp.StatusCode)
	}
}

func TestServerKeyEndpoints(t *testing.T) {
	cfg, cleanup := startTestServer(t, 19903)
	defer cleanup()
	base := fmt.Sprintf("http://127.0.0.1:%d", cfg.APIPort)

	// server-key is public.
	resp, err := http.Get(base + "/api/server-key")
	if err != nil {
		t.Fatal(err)
	}
	var kr struct {
		Key string `json:"key"`
	}
	json.NewDecoder(resp.Body).Decode(&kr)
	resp.Body.Close()
	decoded, err := base64.StdEncoding.DecodeString(kr.Key)
	if err != nil || len(decoded) != 32 {
		t.Fatalf("server-key not a 32-byte base64 key: %q (err=%v)", kr.Key, err)
	}

	// fingerprint format: uppercase colon-separated hex.
	resp, err = http.Get(base + "/api/server-key/fingerprint")
	if err != nil {
		t.Fatal(err)
	}
	var fr struct {
		Fingerprint string `json:"fingerprint"`
		Algorithm   string `json:"algorithm"`
	}
	json.NewDecoder(resp.Body).Decode(&fr)
	resp.Body.Close()
	if fr.Algorithm != "SHA-256" {
		t.Errorf("algorithm: %s", fr.Algorithm)
	}
	if !strings.Contains(fr.Fingerprint, ":") || fr.Fingerprint != strings.ToUpper(fr.Fingerprint) {
		t.Errorf("fingerprint format: %s", fr.Fingerprint)
	}
}

func TestUserGroupsEndpoint(t *testing.T) {
	cfg, cleanup := startTestServer(t, 19904)
	defer cleanup()
	base := fmt.Sprintf("http://127.0.0.1:%d", cfg.APIPort)

	// Create a user group (auth required).
	body, _ := json.Marshal(map[string]any{"name": "Support Team"})
	req, _ := http.NewRequest("POST", base+"/api/user-groups", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(testAuthReq(req))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("POST status: %d", resp.StatusCode)
	}
	resp.Body.Close()

	// List user groups.
	resp, err = testAuthGet(base + "/api/user-groups")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		Data  []map[string]any `json:"data"`
		Total int              `json:"total"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	if out.Total != 1 || len(out.Data) != 1 {
		t.Fatalf("expected 1 group, got total=%d len=%d", out.Total, len(out.Data))
	}
	if out.Data[0]["name"] != "Support Team" {
		t.Errorf("name: %v", out.Data[0]["name"])
	}
	if out.Data[0]["guid"] == "" || out.Data[0]["guid"] == nil {
		t.Error("guid should be auto-generated")
	}
}
