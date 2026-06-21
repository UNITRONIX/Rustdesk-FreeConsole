package meshcentral

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha512"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/events"
	"github.com/unitronix/betterdesk-server/peer"
)

func newTestGateway(t *testing.T) (*Gateway, *httptest.Server) {
	t.Helper()
	dir := t.TempDir()
	database, err := db.OpenSQLite(filepath.Join(dir, "mesh.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(); err != nil {
		t.Fatal(err)
	}
	cfg := config.DefaultConfig()
	cfg.MeshCentralEnabled = true
	cfg.MeshCoreVersion = "1.2.0"
	cfg.MeshAgentCertFile = filepath.Join(dir, "mesh_agent.pem")
	cfg.MeshAssetsDir = filepath.Join(dir, "assets-empty")

	gw, err := NewGateway(cfg, database, peer.NewMap(), events.NewBus(), "mesh-interop-test-secret-32b")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := gw.Start(ctx); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	gw.RegisterRoutes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(func() {
		srv.Close()
		gw.Stop()
		database.Close()
	})
	return gw, srv
}

func generateAgentKeyAndCert(t *testing.T) (*rsa.PrivateKey, []byte, string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 3072)
	if err != nil {
		t.Fatal(err)
	}
	serial, err := rand.Int(rand.Reader, big.NewInt(1<<62))
	if err != nil {
		t.Fatal(err)
	}
	tmpl := x509.Certificate{
		SerialNumber:          serial,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
		BasicConstraintsValid: true,
	}
	certDER, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	nodeID, err := NodeIDFromCertDER(certDER)
	if err != nil {
		t.Fatal(err)
	}
	return key, certDER, nodeID
}

func random48() []byte {
	b := make([]byte, sha384Size)
	rand.Read(b)
	return b
}

func signAgent(key *rsa.PrivateKey, webHash, serverNonce, agentNonce []byte) []byte {
	data := make([]byte, 0, sha384Size*3)
	data = append(data, webHash...)
	data = append(data, serverNonce...)
	data = append(data, agentNonce...)
	sum := sha512.Sum384(data)
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA384, sum[:])
	if err != nil {
		panic(err)
	}
	return sig
}

func buildAuthInfoPacket(meshRaw []byte, hostname string) []byte {
	if len(meshRaw) < 48 {
		padded := make([]byte, 48)
		copy(padded, meshRaw)
		meshRaw = padded
	}
	hn := []byte(hostname)
	pkt := make([]byte, 72+len(hn))
	binary.BigEndian.PutUint16(pkt[0:2], cmdAuthInfo)
	copy(pkt[18:66], meshRaw)
	binary.BigEndian.PutUint32(pkt[66:70], 0xffffffff)
	binary.BigEndian.PutUint16(pkt[70:72], uint16(len(hn)))
	copy(pkt[72:], hn)
	return pkt
}

func readWSBinaryCmd(ctx context.Context, conn *websocket.Conn, wantCmd uint16) []byte {
	return readWSBinaryCmdAny(ctx, conn, []uint16{wantCmd})
}

func readWSBinaryCmdAny(ctx context.Context, conn *websocket.Conn, cmds []uint16) []byte {
	want := make(map[uint16]bool)
	for _, c := range cmds {
		want[c] = true
	}
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			panic(err)
		}
		if typ == websocket.MessageBinary && len(data) >= 2 && want[readU16(data, 0)] {
			return data
		}
	}
}

// TestAgentHandshakeInterop simulates MeshAgent binary auth and BetterCore delivery.
func TestAgentHandshakeInterop(t *testing.T) {
	gw, srv := newTestGateway(t)
	agentKey, agentCert, nodeID := generateAgentKeyAndCert(t)

	wsURL := strings.Replace(srv.URL, "http://", "ws://", 1) + "/agent.ashx"
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	webHash := make([]byte, sha384Size)
	agentNonce := random48()

	authReq := make([]byte, 98)
	binary.BigEndian.PutUint16(authReq[0:2], cmdAuthRequest)
	copy(authReq[2:50], webHash)
	copy(authReq[50:98], agentNonce)
	if err := conn.Write(ctx, websocket.MessageBinary, authReq); err != nil {
		t.Fatal(err)
	}

	resp1 := readWSBinaryCmd(ctx, conn, cmdAuthRequest)
	serverNonce := append([]byte(nil), resp1[50:98]...)

	_ = readWSBinaryCmd(ctx, conn, cmdAuthVerify)

	sig := signAgent(agentKey, webHash, serverNonce, agentNonce)
	agentVerify := make([]byte, 4+len(agentCert)+len(sig))
	binary.BigEndian.PutUint16(agentVerify[0:2], cmdAuthVerify)
	binary.BigEndian.PutUint16(agentVerify[2:4], uint16(len(agentCert)))
	copy(agentVerify[4:], agentCert)
	copy(agentVerify[4+len(agentCert):], sig)
	if err := conn.Write(ctx, websocket.MessageBinary, agentVerify); err != nil {
		t.Fatal(err)
	}

	meshRaw := make([]byte, 48)
	rand.Read(meshRaw[:16])
	authInfo := buildAuthInfoPacket(meshRaw, "interop-host")
	if err := conn.Write(ctx, websocket.MessageBinary, authInfo); err != nil {
		t.Fatal(err)
	}

	_ = readWSBinaryCmd(ctx, conn, cmdAuthConfirm)
	_ = readWSBinaryCmd(ctx, conn, cmdCoreModuleHash)

	deadline := time.Now().Add(5 * time.Second)
	for gw.ActiveAgentCount() == 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if gw.ActiveAgentCount() != 1 {
		t.Fatalf("expected 1 active agent, got %d", gw.ActiveAgentCount())
	}

	peerID := ""
	gw.agents.Range(func(key, _ any) bool {
		peerID, _ = key.(string)
		return false
	})
	if peerID == "" {
		t.Fatal("missing peer id")
	}
	if gw.MeshNodeID(peerID) != nodeID {
		t.Fatalf("node id mismatch: got %s want %s", gw.MeshNodeID(peerID), nodeID)
	}

	// Agent reports core hash — server should push BetterCore or CoreOk.
	coreHashPkt := make([]byte, 4+sha384Size)
	binary.BigEndian.PutUint16(coreHashPkt[0:2], cmdCoreModuleHash)
	binary.BigEndian.PutUint16(coreHashPkt[2:4], 0)
	copy(coreHashPkt[4:], gw.assets.CoreModuleHash)
	if err := conn.Write(ctx, websocket.MessageBinary, coreHashPkt); err != nil {
		t.Fatal(err)
	}

	resp5 := readWSBinaryCmdAny(ctx, conn, []uint16{cmdCoreOk, cmdCoreModule})
	cmd := readU16(resp5, 0)
	if cmd == cmdCoreModule {
		if len(resp5) < 4 || string(resp5[4:]) != string(gw.assets.CoreModule) {
			t.Fatal("core module payload mismatch")
		}
	}
}

func downloadMeshAgentLinux64(dest string) error {
	url := "https://raw.githubusercontent.com/Ylianst/MeshCentral/master/agents/meshagent_x86-64"
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download meshagent: status %d", resp.StatusCode)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if err := os.WriteFile(dest, data, 0700); err != nil {
		return err
	}
	return nil
}

func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0700)
}

// TestBetterCoreAssetEmbedded ensures BetterCore ships in the binary.
func TestBetterCoreAssetEmbedded(t *testing.T) {
	assets, err := LoadCoreAssets("1.2.0", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(assets.CoreModule) < 100 {
		t.Fatal("bettercore asset too small")
	}
	if !strings.Contains(string(assets.CoreModule), "BetterCore") {
		t.Fatal("bettercore asset missing marker")
	}
	if len(assets.CoreModuleHash) != sha384Size {
		t.Fatalf("hash len %d", len(assets.CoreModuleHash))
	}
}

// TestMeshMSHServerIDFormat documents ServerID used in .msh interop files.
func TestMeshMSHServerIDFormat(t *testing.T) {
	cred, err := LoadOrCreateAgentCredentials("")
	if err != nil {
		t.Fatal(err)
	}
	if len(cred.ServerID) != 96 {
		t.Fatalf("server id hex len %d", len(cred.ServerID))
	}
	if _, err := hex.DecodeString(cred.ServerID); err != nil {
		t.Fatal(err)
	}
}
