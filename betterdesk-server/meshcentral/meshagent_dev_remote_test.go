//go:build meshagent_dev_remote

package meshcentral

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type devRemoteInteropEnv struct {
	WSURL   string
	APIBase string
	User    string
	Pass    string
}

func devRemoteInteropEnvFromOS() devRemoteInteropEnv {
	wsURL := strings.TrimSpace(os.Getenv("MESH_INTEROP_WS"))
	if wsURL == "" {
		wsURL = "ws://127.0.0.1:21114/agent.ashx"
	}
	apiBase := strings.TrimSpace(os.Getenv("MESH_INTEROP_API"))
	if apiBase == "" {
		apiBase = "http://127.0.0.1:21114/api"
	}
	user := strings.TrimSpace(os.Getenv("MESH_INTEROP_ADMIN_USER"))
	if user == "" {
		user = "admin"
	}
	pass := os.Getenv("MESH_INTEROP_ADMIN_PASS")
	if pass == "" {
		pass = "MeshInteropTest123!"
	}
	return devRemoteInteropEnv{WSURL: wsURL, APIBase: apiBase, User: user, Pass: pass}
}

type devRemoteAgentSession struct {
	conn    *websocket.Conn
	cancel  context.CancelFunc
	readCmd func(...uint16) []byte
	nodeID  string
}

func devRemoteConnectAgent(t *testing.T, env devRemoteInteropEnv) (*devRemoteAgentSession, func()) {
	t.Helper()
	agentKey, agentCert, nodeID := generateAgentKeyAndCert(t)
	ctx, cancel := context.WithCancel(context.Background())

	conn, _, err := websocket.Dial(ctx, env.WSURL, nil)
	if err != nil {
		cancel()
		t.Fatal(err)
	}

	inbound := make(chan []byte, 16)
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			select {
			case inbound <- data:
			default:
			}
		}
	}()

	readCmd := func(want ...uint16) []byte {
		wantMap := make(map[uint16]bool)
		for _, c := range want {
			wantMap[c] = true
		}
		deadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			select {
			case data := <-inbound:
				if len(data) >= 2 && wantMap[readU16(data, 0)] {
					return data
				}
			case <-time.After(200 * time.Millisecond):
			}
		}
		t.Fatal("timeout waiting for mesh cmd")
		return nil
	}

	webHash := make([]byte, sha384Size)
	agentNonce := random48()

	authReq := make([]byte, 98)
	putU16(authReq, 0, cmdAuthRequest)
	copy(authReq[2:50], webHash)
	copy(authReq[50:98], agentNonce)
	if err := conn.Write(ctx, websocket.MessageBinary, authReq); err != nil {
		cancel()
		conn.Close(websocket.StatusInternalError, "")
		<-readDone
		t.Fatal(err)
	}

	resp1 := readCmd(cmdAuthRequest)
	serverNonce := append([]byte(nil), resp1[50:98]...)
	_ = readCmd(cmdAuthVerify)

	sig := signAgent(agentKey, webHash, serverNonce, agentNonce)
	agentVerify := make([]byte, 4+len(agentCert)+len(sig))
	putU16(agentVerify, 0, cmdAuthVerify)
	putU16(agentVerify, 2, uint16(len(agentCert)))
	copy(agentVerify[4:], agentCert)
	copy(agentVerify[4+len(agentCert):], sig)
	if err := conn.Write(ctx, websocket.MessageBinary, agentVerify); err != nil {
		cancel()
		conn.Close(websocket.StatusInternalError, "")
		<-readDone
		t.Fatal(err)
	}

	meshRaw := make([]byte, 48)
	copy(meshRaw, []byte("BetterDeskInteropDevRemoteAgent!!"))
	authInfo := buildAuthInfoPacket(meshRaw, "interop-win-dev")
	if err := conn.Write(ctx, websocket.MessageBinary, authInfo); err != nil {
		cancel()
		conn.Close(websocket.StatusInternalError, "")
		<-readDone
		t.Fatal(err)
	}

	_ = readCmd(cmdAuthConfirm)
	_ = readCmd(cmdCoreModuleHash)

	coreHashPkt := make([]byte, 4+sha384Size)
	putU16(coreHashPkt, 0, cmdCoreModuleHash)
	copy(coreHashPkt[4:], make([]byte, sha384Size))
	if err := conn.Write(ctx, websocket.MessageBinary, coreHashPkt); err != nil {
		cancel()
		conn.Close(websocket.StatusInternalError, "")
		<-readDone
		t.Fatal(err)
	}
	_ = readCmd(cmdCoreOk, cmdCoreModule)

	cleanup := func() {
		cancel()
		conn.Close(websocket.StatusNormalClosure, "")
		<-readDone
	}

	return &devRemoteAgentSession{conn: conn, cancel: cancel, readCmd: readCmd, nodeID: nodeID}, cleanup
}

func devRemoteWaitForPeer(t *testing.T, apiBase, token string, timeout time.Duration) (string, devRemoteMeshStatusResp) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var peerID string
	var status devRemoteMeshStatusResp
	for time.Now().Before(deadline) {
		var err error
		status, err = devRemoteMeshStatus(apiBase, token)
		if err != nil {
			t.Fatal(err)
		}
		peers, err := devRemoteListPeers(apiBase, token)
		if err != nil {
			t.Fatal(err)
		}
		var candidates []devRemotePeer
		for _, p := range peers {
			if isMeshAgentPeer(p) {
				candidates = append(candidates, p)
			}
		}
		for _, p := range candidates {
			if p.MeshConnected {
				peerID = p.ID
				break
			}
		}
		if peerID == "" && len(candidates) == 1 && status.AgentsOnline >= 1 {
			peerID = candidates[0].ID
		}
		if peerID != "" && status.AgentsOnline >= 1 {
			for _, p := range candidates {
				if p.ID == peerID {
					t.Logf("found mesh peer=%s agents_online=%d mesh_connected=%v os=%s", peerID, status.AgentsOnline, p.MeshConnected, p.OS)
					break
				}
			}
			return peerID, status
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("mesh agent did not appear in /api/peers within timeout")
	return "", status
}

func devRemoteRunIntegrationChecks(t *testing.T, apiBase, token, peerID string) map[string]string {
	t.Helper()
	results := map[string]string{}
	status, _ := devRemoteMeshStatus(apiBase, token)
	if status.AgentsOnline < 1 {
		results["note"] = "agent session not active"
		return results
	}
	if err := devRemotePost(apiBase, token, "/peers/"+peerID+"/exec", map[string]any{"command": "echo mesh-interop-ok", "shell": false}); err != nil {
		results["exec"] = "FAIL: " + err.Error()
		t.Fatalf("exec: %v", err)
	}
	results["exec"] = "PASS"
	for _, tc := range []struct {
		key  string
		path string
	}{
		{"desktop_tunnel", "/mesh/devices/" + peerID + "/desktop"},
		{"terminal_tunnel", "/mesh/devices/" + peerID + "/terminal"},
		{"files_tunnel", "/mesh/devices/" + peerID + "/files"},
	} {
		body, err := devRemotePostRaw(apiBase, token, tc.path, map[string]any{})
		if err != nil {
			results[tc.key] = "FAIL: " + err.Error()
			t.Fatalf("%s: %v", tc.path, err)
		}
		if !strings.Contains(string(body), "relay_id") {
			results[tc.key] = "FAIL: missing relay_id"
			t.Fatalf("%s: missing relay_id in %s", tc.path, string(body))
		}
		results[tc.key] = "PASS"
	}
	return results
}

func devRemoteWriteState(path string, payload map[string]any) error {
	if path == "" {
		return nil
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// TestDevRemoteAgentHandshake connects a protocol-compatible agent client to a
// running BetterDesk server (local dev interop) and verifies inventory registration.
func TestDevRemoteAgentHandshake(t *testing.T) {
	env := devRemoteInteropEnvFromOS()
	session, cleanup := devRemoteConnectAgent(t, env)
	defer cleanup()

	token, err := devRemoteLogin(env.APIBase, env.User, env.Pass)
	if err != nil {
		t.Fatal(err)
	}

	peerID, _ := devRemoteWaitForPeer(t, env.APIBase, token, 30*time.Second)
	t.Logf("registered peer %s nodeID=%s", peerID, session.nodeID)

	statePath := strings.TrimSpace(os.Getenv("MESH_INTEROP_STATE_FILE"))
	if statePath != "" {
		_ = devRemoteWriteState(statePath, map[string]any{
			"peer_id": peerID,
			"node_id": session.nodeID,
			"tests":   devRemoteRunIntegrationChecks(t, env.APIBase, token, peerID),
		})
	} else {
		devRemoteRunIntegrationChecks(t, env.APIBase, token, peerID)
	}

	time.Sleep(2 * time.Second)
}

// TestDevRemoteAgentKeepAlive maintains an agent websocket for verify-api.ps1.
func TestDevRemoteAgentKeepAlive(t *testing.T) {
	env := devRemoteInteropEnvFromOS()
	session, cleanup := devRemoteConnectAgent(t, env)
	defer cleanup()

	token, err := devRemoteLogin(env.APIBase, env.User, env.Pass)
	if err != nil {
		t.Fatal(err)
	}

	start := time.Now()
	peerID, status := devRemoteWaitForPeer(t, env.APIBase, token, 30*time.Second)
	registerSec := time.Since(start).Seconds()
	t.Logf("keepalive peer %s agents_online=%d (%.2fs)", peerID, status.AgentsOnline, registerSec)

	statePath := strings.TrimSpace(os.Getenv("MESH_INTEROP_STATE_FILE"))
	if statePath == "" {
		t.Fatal("MESH_INTEROP_STATE_FILE required for keepalive test")
	}
	_ = devRemoteWriteState(statePath, map[string]any{
		"peer_id":          peerID,
		"node_id":          session.nodeID,
		"agents_online":    status.AgentsOnline,
		"register_seconds": registerSec,
		"ready":            true,
	})

	keepSec := 120
	if v := strings.TrimSpace(os.Getenv("MESH_INTEROP_KEEPALIVE_SEC")); v != "" {
		if n, err := fmt.Sscanf(v, "%d", &keepSec); n != 1 || err != nil {
			t.Fatalf("invalid MESH_INTEROP_KEEPALIVE_SEC: %q", v)
		}
	}
	deadline := time.Now().Add(time.Duration(keepSec) * time.Second)
	for time.Now().Before(deadline) {
		if statePath != "" {
			if data, err := os.ReadFile(statePath); err == nil {
				if strings.Contains(string(data), `"stop":true`) {
					t.Log("stop signal received")
					return
				}
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Log("keepalive timeout reached")
}

func putU16(b []byte, off int, v uint16) {
	b[off] = byte(v >> 8)
	b[off+1] = byte(v)
}

type devRemoteMeshStatusResp struct {
	AgentsOnline int `json:"agents_online"`
}

type devRemotePeer struct {
	ID            string `json:"id"`
	DeviceType    string `json:"device_type"`
	OS            string `json:"os"`
	MeshConnected bool   `json:"mesh_connected"`
	LiveOnline    bool   `json:"live_online"`
	MeshNodeID    string `json:"mesh_node_id"`
}

func isMeshAgentPeer(p devRemotePeer) bool {
	if p.DeviceType == "mesh_agent" || p.OS == "mesh" || p.MeshNodeID != "" {
		return true
	}
	return strings.HasPrefix(p.ID, "M")
}

func devRemoteLogin(apiBase, user, pass string) (string, error) {
	body, _ := json.Marshal(map[string]string{"username": user, "password": pass})
	resp, err := http.Post(apiBase+"/auth/login", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("login status %d: %s", resp.StatusCode, string(data))
	}
	var out struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return "", err
	}
	if out.Token == "" {
		return "", fmt.Errorf("empty token")
	}
	return out.Token, nil
}

func devRemoteMeshStatus(apiBase, token string) (devRemoteMeshStatusResp, error) {
	var out devRemoteMeshStatusResp
	req, _ := http.NewRequest(http.MethodGet, apiBase+"/mesh/status", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return out, fmt.Errorf("mesh status %d: %s", resp.StatusCode, string(data))
	}
	err = json.Unmarshal(data, &out)
	return out, err
}

func devRemotePost(apiBase, token, path string, body map[string]any) error {
	_, err := devRemotePostRaw(apiBase, token, path, body)
	return err
}

func devRemotePostRaw(apiBase, token, path string, body map[string]any) ([]byte, error) {
	data, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, apiBase+path, bytes.NewReader(data))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return out, fmt.Errorf("status %d: %s", resp.StatusCode, string(out))
	}
	return out, nil
}

func devRemoteListPeers(apiBase, token string) ([]devRemotePeer, error) {
	req, _ := http.NewRequest(http.MethodGet, apiBase+"/peers", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("peers %d: %s", resp.StatusCode, string(data))
	}
	var out []devRemotePeer
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	return out, nil
}
