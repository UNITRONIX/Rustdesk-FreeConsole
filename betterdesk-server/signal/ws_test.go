package signal

import (
	"context"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/unitronix/betterdesk-server/codec"
	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/crypto"
	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/peer"
	pb "github.com/unitronix/betterdesk-server/proto"
	"google.golang.org/protobuf/proto"
)

func TestWSSignalHealthCheck(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.SignalPort = 29100
	cfg.RelayPort = 29101

	dir := t.TempDir()
	cfg.DBPath = dir + "/test.db"
	cfg.KeyFile = dir + "/id_ed25519"

	database, err := db.OpenSQLite(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	database.Migrate()
	defer database.Close()

	kp, err := crypto.LoadOrGenerateKeyPair(cfg.KeyFile)
	if err != nil {
		t.Fatal(err)
	}

	srv := New(cfg, kp, database)
	ctx := t.Context()
	if err := srv.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	time.Sleep(200 * time.Millisecond)

	// Connect via WebSocket to signal port + 2 = 29102
	wsURL := "ws://127.0.0.1:29102/"
	ws, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("WS dial: %v", err)
	}
	defer ws.CloseNow()

	// Send health check
	hc := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_Hc{
			Hc: &pb.HealthCheck{Token: "ws-test-123"},
		},
	}
	data, _ := proto.Marshal(hc)
	if err := ws.Write(ctx, websocket.MessageBinary, data); err != nil {
		t.Fatalf("WS write: %v", err)
	}

	resp := readWSProtoSkippingKeepAlive(t, ctx, ws)
	if resp.GetHc() == nil || resp.GetHc().Token != "ws-test-123" {
		t.Errorf("unexpected response: %v", resp)
	}
}

func TestWSSignalHealthCheckProxyPath(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.SignalPort = 29120
	cfg.RelayPort = 29121

	dir := t.TempDir()
	cfg.DBPath = dir + "/test.db"
	cfg.KeyFile = dir + "/id_ed25519"

	database, err := db.OpenSQLite(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	database.Migrate()
	defer database.Close()

	kp, err := crypto.LoadOrGenerateKeyPair(cfg.KeyFile)
	if err != nil {
		t.Fatal(err)
	}

	srv := New(cfg, kp, database)
	ctx := t.Context()
	if err := srv.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	time.Sleep(200 * time.Millisecond)

	ws, _, err := websocket.Dial(ctx, "ws://127.0.0.1:29122/ws/id", nil)
	if err != nil {
		t.Fatalf("WS dial: %v", err)
	}
	defer ws.CloseNow()

	hc := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_Hc{
			Hc: &pb.HealthCheck{Token: "ws-proxy-path"},
		},
	}
	data, _ := proto.Marshal(hc)
	if err := ws.Write(ctx, websocket.MessageBinary, data); err != nil {
		t.Fatalf("WS write: %v", err)
	}

	resp := readWSProtoSkippingKeepAlive(t, ctx, ws)
	if resp.GetHc() == nil || resp.GetHc().Token != "ws-proxy-path" {
		t.Errorf("unexpected response: %v", resp)
	}
}

func TestWSSignalRustDeskKeepAlive(t *testing.T) {
	oldInterval := setWSSignalKeepAliveInterval(50 * time.Millisecond)
	defer setWSSignalKeepAliveInterval(oldInterval)

	cfg := config.DefaultConfig()
	cfg.SignalPort = 29140
	cfg.RelayPort = 29141

	dir := t.TempDir()
	cfg.DBPath = dir + "/test.db"
	cfg.KeyFile = dir + "/id_ed25519"

	database, err := db.OpenSQLite(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	database.Migrate()
	defer database.Close()

	kp, err := crypto.LoadOrGenerateKeyPair(cfg.KeyFile)
	if err != nil {
		t.Fatal(err)
	}

	srv := New(cfg, kp, database)
	ctx := t.Context()
	if err := srv.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	time.Sleep(200 * time.Millisecond)

	ws, _, err := websocket.Dial(ctx, "ws://127.0.0.1:29142/ws/id", nil)
	if err != nil {
		t.Fatalf("WS dial: %v", err)
	}
	defer ws.CloseNow()

	reg := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RegisterPk{
			RegisterPk: &pb.RegisterPk{
				Id:   "WSKEEP1",
				Uuid: []byte("ws-keepalive-uuid"),
				Pk:   make([]byte, 32),
			},
		},
	}
	data, _ := proto.Marshal(reg)
	if err := ws.Write(ctx, websocket.MessageBinary, data); err != nil {
		t.Fatalf("WS register write: %v", err)
	}

	resp := readWSProtoSkippingKeepAlive(t, ctx, ws)
	if resp.GetRegisterPkResponse() == nil {
		t.Fatalf("expected RegisterPkResponse, got: %v", resp)
	}
	beforeKeepAlive, ok := srv.PeerMap().GetSnapshot("WSKEEP1", config.DegradedThreshold, config.CriticalThreshold)
	if !ok {
		t.Fatal("expected WSKEEP1 to be registered")
	}

	readCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	typ, frame, err := ws.Read(readCtx)
	if err != nil {
		t.Fatalf("WS keepalive read: %v", err)
	}
	if typ != websocket.MessageBinary || len(frame) != 0 {
		t.Fatalf("expected empty binary keepalive frame, got type=%v len=%d", typ, len(frame))
	}

	if err := ws.Write(ctx, websocket.MessageBinary, nil); err != nil {
		t.Fatalf("WS keepalive reply write: %v", err)
	}

	hc := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_Hc{
			Hc: &pb.HealthCheck{Token: "after-keepalive"},
		},
	}
	data, _ = proto.Marshal(hc)
	if err := ws.Write(ctx, websocket.MessageBinary, data); err != nil {
		t.Fatalf("WS health write after keepalive: %v", err)
	}

	resp = readWSProtoSkippingKeepAlive(t, ctx, ws)
	if resp.GetHc() == nil || resp.GetHc().Token != "after-keepalive" {
		t.Fatalf("expected HealthCheck response after keepalive, got: %v", resp)
	}
	afterKeepAlive, ok := srv.PeerMap().GetSnapshot("WSKEEP1", config.DegradedThreshold, config.CriticalThreshold)
	if !ok {
		t.Fatal("expected WSKEEP1 to remain registered after keepalive")
	}
	if !afterKeepAlive.LastHeartbeat.After(beforeKeepAlive.LastHeartbeat) {
		t.Fatalf("expected WS keepalive echo to refresh heartbeat, before=%v after=%v", beforeKeepAlive.LastHeartbeat, afterKeepAlive.LastHeartbeat)
	}
}

func readWSProtoSkippingKeepAlive(t *testing.T, ctx context.Context, ws *websocket.Conn) *pb.RendezvousMessage {
	t.Helper()

	readCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()

	for {
		typ, data, err := ws.Read(readCtx)
		if err != nil {
			t.Fatalf("WS read: %v", err)
		}
		if typ != websocket.MessageBinary {
			t.Fatalf("expected binary frame, got %v", typ)
		}
		if len(data) == 0 {
			continue
		}

		resp := &pb.RendezvousMessage{}
		if err := proto.Unmarshal(data, resp); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		return resp
	}
}

func TestWSSignalRegisterPeer(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.SignalPort = 29200
	cfg.RelayPort = 29201

	dir := t.TempDir()
	cfg.DBPath = dir + "/test.db"
	cfg.KeyFile = dir + "/id_ed25519"

	database, err := db.OpenSQLite(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	database.Migrate()
	defer database.Close()

	kp, err := crypto.LoadOrGenerateKeyPair(cfg.KeyFile)
	if err != nil {
		t.Fatal(err)
	}

	srv := New(cfg, kp, database)
	ctx := t.Context()
	if err := srv.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	time.Sleep(200 * time.Millisecond)

	// Connect WS
	ws, _, err := websocket.Dial(ctx, "ws://127.0.0.1:29202/", nil)
	if err != nil {
		t.Fatalf("WS dial: %v", err)
	}
	defer ws.CloseNow()

	// Send RegisterPeer (heartbeat)
	reg := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RegisterPeer{
			RegisterPeer: &pb.RegisterPeer{
				Id:     "WSTEST1",
				Serial: 1,
			},
		},
	}
	data, _ := proto.Marshal(reg)
	if err := ws.Write(ctx, websocket.MessageBinary, data); err != nil {
		t.Fatalf("WS write: %v", err)
	}

	resp := readWSProtoSkippingKeepAlive(t, ctx, ws)
	rpr := resp.GetRegisterPeerResponse()
	if rpr == nil {
		t.Fatalf("expected RegisterPeerResponse, got: %v", resp)
	}
	if !rpr.RequestPk {
		t.Error("should request PK for new peer")
	}

	entry := srv.PeerMap().Get("WSTEST1")
	if entry == nil {
		t.Fatal("peer WSTEST1 should exist in memory")
	}
	if entry.ConnType != peer.ConnWS {
		t.Fatalf("expected ConnWS, got %v", entry.ConnType)
	}
	if entry.WSConn == nil {
		t.Fatal("RegisterPeer should bind WSConn for outbound WS signaling")
	}

	// Verify peer is in memory
	if !srv.PeerMap().IsOnline("WSTEST1", config.RegTimeout) {
		t.Error("peer WSTEST1 should be online")
	}
}

func TestWSSignalOnlineRequest(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.SignalPort = 29300
	cfg.RelayPort = 29301

	dir := t.TempDir()
	cfg.DBPath = dir + "/test.db"
	cfg.KeyFile = dir + "/id_ed25519"

	database, err := db.OpenSQLite(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	database.Migrate()
	defer database.Close()

	kp, err := crypto.LoadOrGenerateKeyPair(cfg.KeyFile)
	if err != nil {
		t.Fatal(err)
	}

	srv := New(cfg, kp, database)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()

	if err := srv.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	time.Sleep(200 * time.Millisecond)

	// First register a peer via one WS connection
	ws1, _, _ := websocket.Dial(ctx, "ws://127.0.0.1:29302/", nil)
	defer ws1.CloseNow()

	reg := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RegisterPeer{
			RegisterPeer: &pb.RegisterPeer{Id: "ONLINE1", Serial: 1},
		},
	}
	data, _ := proto.Marshal(reg)
	ws1.Write(ctx, websocket.MessageBinary, data)
	readWSProtoSkippingKeepAlive(t, ctx, ws1) // consume RegisterPeerResponse

	// Now query online status via WS
	ws2, _, _ := websocket.Dial(ctx, "ws://127.0.0.1:29302/", nil)
	defer ws2.CloseNow()

	online := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_OnlineRequest{
			OnlineRequest: &pb.OnlineRequest{
				Peers: []string{"ONLINE1", "NOTEXIST"},
			},
		},
	}
	data, _ = proto.Marshal(online)
	ws2.Write(ctx, websocket.MessageBinary, data)

	resp := readWSProtoSkippingKeepAlive(t, ctx, ws2)
	or := resp.GetOnlineResponse()
	if or == nil {
		t.Fatalf("expected OnlineResponse, got: %v", resp)
	}

	// 1-bit-per-peer, big-endian: ONLINE1 (index 0) → bit 7 → 0x80
	if len(or.States) == 0 || or.States[0]&0x80 == 0 {
		t.Errorf("ONLINE1 should be online (bit 7), states: %v", or.States)
	}
	// NOTEXIST (index 1) → bit 6 → should be 0
	if len(or.States) > 0 && or.States[0]&0x40 != 0 {
		t.Errorf("NOTEXIST should be offline (bit 6), states: %v", or.States)
	}
}

func TestWSEffectiveRemoteAddr(t *testing.T) {
	t.Parallel()
	loopbackNet := mustCIDR(t, "10.0.0.0/8")
	cases := []struct {
		name            string
		trustProxy      bool
		trustedProxies  []*net.IPNet
		remoteAddr      string
		xri             string
		xff             string
		want            string
	}{
		{
			name:       "no proxy trust ignores headers",
			trustProxy: false,
			remoteAddr: "10.0.0.2:50123",
			xri:        "203.0.113.10",
			want:       "10.0.0.2:50123",
		},
		{
			name:           "trust proxy without allowlist ignores headers",
			trustProxy:     true,
			trustedProxies: nil,
			remoteAddr:     "10.0.0.2:50123",
			xff:            "203.0.113.10",
			want:           "10.0.0.2:50123",
		},
		{
			name:           "untrusted remote ignores headers",
			trustProxy:     true,
			trustedProxies: []*net.IPNet{mustCIDR(t, "127.0.0.1/32")},
			remoteAddr:     "10.0.0.2:50123",
			xff:            "203.0.113.10",
			want:           "10.0.0.2:50123",
		},
		{
			name:           "xff ip-only uses remote port",
			trustProxy:     true,
			trustedProxies: []*net.IPNet{loopbackNet},
			remoteAddr:     "10.0.0.2:50123",
			xff:            "203.0.113.10, 10.0.0.1",
			want:           "203.0.113.10:50123",
		},
		{
			name:           "x-real-ip preferred over xff",
			trustProxy:     true,
			trustedProxies: []*net.IPNet{loopbackNet},
			remoteAddr:     "10.0.0.10:48438",
			xri:            "203.0.113.99",
			xff:            "198.51.100.1",
			want:           "203.0.113.99:48438",
		},
		{
			name:           "xff with port is not double-wrapped",
			trustProxy:     true,
			trustedProxies: []*net.IPNet{loopbackNet},
			remoteAddr:     "10.0.0.2:50124",
			xff:            "203.0.113.10:50200",
			want:           "203.0.113.10:50200",
		},
		{
			name:           "x-real-ip with port",
			trustProxy:     true,
			trustedProxies: []*net.IPNet{loopbackNet},
			remoteAddr:     "10.0.0.2:50124",
			xri:            "203.0.113.10:50200",
			want:           "203.0.113.10:50200",
		},
		{
			name:           "hostname in header rejected",
			trustProxy:     true,
			trustedProxies: []*net.IPNet{loopbackNet},
			remoteAddr:     "10.0.0.2:50124",
			xri:            "evil.example:443",
			want:           "10.0.0.2:50124",
		},
		{
			name:           "port zero in header rejected",
			trustProxy:     true,
			trustedProxies: []*net.IPNet{loopbackNet},
			remoteAddr:     "10.0.0.2:50124",
			xri:            "203.0.113.10:0",
			want:           "10.0.0.2:50124",
		},
		{
			name:           "ipv6 forwarded with remote port",
			trustProxy:     true,
			trustedProxies: []*net.IPNet{loopbackNet},
			remoteAddr:     "10.0.0.2:50125",
			xri:            "2001:db8::1",
			want:           "[2001:db8::1]:50125",
		},
		{
			name:           "ipv6 hostport in header",
			trustProxy:     true,
			trustedProxies: []*net.IPNet{loopbackNet},
			remoteAddr:     "10.0.0.2:50125",
			xri:            "[2001:db8::1]:443",
			want:           "[2001:db8::1]:443",
		},
		{
			name:           "no forwarded headers",
			trustProxy:     true,
			trustedProxies: []*net.IPNet{loopbackNet},
			remoteAddr:     "203.0.113.50:60000",
			want:           "203.0.113.50:60000",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptestNewRequest("GET", "/ws/id", tc.remoteAddr)
			if tc.xri != "" {
				req.Header.Set("X-Real-IP", tc.xri)
			}
			if tc.xff != "" {
				req.Header.Set("X-Forwarded-For", tc.xff)
			}
			cfg := &config.Config{
				TrustProxy:     tc.trustProxy,
				TrustedProxies: tc.trustedProxies,
			}
			got := wsEffectiveRemoteAddr(req, cfg)
			if got != tc.want {
				t.Fatalf("effective addr = %q, want %q", got, tc.want)
			}
		})
	}
}

func mustCIDR(t *testing.T, cidr string) *net.IPNet {
	t.Helper()
	_, n, err := net.ParseCIDR(cidr)
	if err != nil {
		t.Fatalf("ParseCIDR(%q): %v", cidr, err)
	}
	return n
}

func httptestNewRequest(method, target, remoteAddr string) *http.Request {
	r := &http.Request{
		Method: method,
		URL:    &url.URL{Path: target},
		Header: make(http.Header),
	}
	r.RemoteAddr = remoteAddr
	return r
}

func TestWSSignalImmediateKeepAlive(t *testing.T) {
	oldDelay := setWSSignalIdleKeepAliveDelay(80 * time.Millisecond)
	defer setWSSignalIdleKeepAliveDelay(oldDelay)

	cfg := config.DefaultConfig()
	cfg.SignalPort = 29150
	cfg.RelayPort = 29151

	dir := t.TempDir()
	cfg.DBPath = dir + "/test.db"
	cfg.KeyFile = dir + "/id_ed25519"

	database, err := db.OpenSQLite(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	database.Migrate()
	defer database.Close()

	kp, err := crypto.LoadOrGenerateKeyPair(cfg.KeyFile)
	if err != nil {
		t.Fatal(err)
	}

	srv := New(cfg, kp, database)
	ctx := t.Context()
	if err := srv.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	time.Sleep(200 * time.Millisecond)

	ws, _, err := websocket.Dial(ctx, "ws://127.0.0.1:29152/ws/id", nil)
	if err != nil {
		t.Fatalf("WS dial: %v", err)
	}
	defer ws.CloseNow()

	// Idle register path (#229): empty keepalive after delay when client is silent.
	// Must not be immediate after 101 (that breaks ephemeral RequestRelay — #276).
	readCtx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer cancel()
	start := time.Now()
	typ, frame, err := ws.Read(readCtx)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("WS idle keepalive read: %v", err)
	}
	if typ != websocket.MessageBinary || len(frame) != 0 {
		t.Fatalf("expected delayed empty keepalive, got type=%v len=%d", typ, len(frame))
	}
	if elapsed < 50*time.Millisecond {
		t.Fatalf("keepalive arrived too soon (%v); must not be immediate after HTTP 101", elapsed)
	}
}

func TestWSRequestRelayFirstFrameIsRelayResponse(t *testing.T) {
	oldDelay := setWSSignalIdleKeepAliveDelay(2 * time.Second)
	defer setWSSignalIdleKeepAliveDelay(oldDelay)

	cfg := config.DefaultConfig()
	cfg.SignalPort = 29190
	cfg.RelayPort = 29191

	dir := t.TempDir()
	cfg.DBPath = dir + "/test.db"
	cfg.KeyFile = dir + "/id_ed25519"

	database, err := db.OpenSQLite(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	database.Migrate()
	defer database.Close()

	kp, err := crypto.LoadOrGenerateKeyPair(cfg.KeyFile)
	if err != nil {
		t.Fatal(err)
	}

	srv := New(cfg, kp, database)
	ctx := t.Context()
	if err := srv.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	time.Sleep(200 * time.Millisecond)

	targetAddr := &net.UDPAddr{IP: net.ParseIP("198.51.100.20"), Port: 21116}
	srv.PeerMap().Put(&peer.Entry{
		ID:       "RELAYTGT",
		PK:       make([]byte, 32),
		IP:       targetAddr.String(),
		UDPAddr:  targetAddr,
		ConnType: peer.ConnWS, // same transport family as WS initiator (#290)
		LastReg:  time.Now(),
	})
	// Pre-authorize initiator by IP so RequestRelay can be the first WS frame
	// (preserves #276 first-frame assertion) while satisfying #302.
	srv.PeerMap().Put(&peer.Entry{
		ID:       "RELAYINIT",
		IP:       "127.0.0.1:0",
		ConnType: peer.ConnWS,
		LastReg:  time.Now(),
	})

	ws, _, err := websocket.Dial(ctx, "ws://127.0.0.1:29192/ws/id", nil)
	if err != nil {
		t.Fatalf("WS dial: %v", err)
	}
	defer ws.CloseNow()

	req := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RequestRelay{
			RequestRelay: &pb.RequestRelay{
				Id:     "RELAYTGT",
				Uuid:   "11111111-1111-1111-1111-111111111111",
				Secure: true,
			},
		},
	}
	data, _ := proto.Marshal(req)
	if err := ws.Write(ctx, websocket.MessageBinary, data); err != nil {
		t.Fatalf("WS RequestRelay write: %v", err)
	}

	// First non-empty server frame must be RelayResponse — not an empty keepalive
	// that desktop parses as RendezvousMessage{union:None} (#276 residual).
	readCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	typ, frame, err := ws.Read(readCtx)
	if err != nil {
		t.Fatalf("WS read after RequestRelay: %v", err)
	}
	if typ != websocket.MessageBinary {
		t.Fatalf("expected binary frame, got %v", typ)
	}
	if len(frame) == 0 {
		t.Fatal("first server frame must not be empty keepalive on RequestRelay session")
	}
	resp := &pb.RendezvousMessage{}
	if err := proto.Unmarshal(frame, resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.GetRelayResponse() == nil {
		t.Fatalf("expected RelayResponse as first frame, got: %v", resp)
	}
	if resp.GetRelayResponse().Uuid != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("RelayResponse uuid = %q", resp.GetRelayResponse().Uuid)
	}
}

func TestWSSignalDesktopRegisterPkDelayed(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.SignalPort = 29160
	cfg.RelayPort = 29161

	dir := t.TempDir()
	cfg.DBPath = dir + "/test.db"
	cfg.KeyFile = dir + "/id_ed25519"

	database, err := db.OpenSQLite(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	database.Migrate()
	defer database.Close()

	kp, err := crypto.LoadOrGenerateKeyPair(cfg.KeyFile)
	if err != nil {
		t.Fatal(err)
	}

	srv := New(cfg, kp, database)
	ctx := t.Context()
	if err := srv.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	time.Sleep(200 * time.Millisecond)

	ws, _, err := websocket.Dial(ctx, "ws://127.0.0.1:29162/ws/id", nil)
	if err != nil {
		t.Fatalf("WS dial: %v", err)
	}
	defer ws.CloseNow()

	// RustDesk desktop waits ~1s after WSS upgrade before sending RegisterPk.
	time.Sleep(time.Second)

	reg := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RegisterPk{
			RegisterPk: &pb.RegisterPk{
				Id:   "WSDESK1",
				Uuid: []byte("desktop-ws-uuid1"),
				Pk:   make([]byte, 32),
			},
		},
	}
	data, _ := proto.Marshal(reg)
	if err := ws.Write(ctx, websocket.MessageBinary, data); err != nil {
		t.Fatalf("WS register write: %v", err)
	}

	resp := readWSProtoSkippingKeepAlive(t, ctx, ws)
	rpk := resp.GetRegisterPkResponse()
	if rpk == nil {
		t.Fatalf("expected RegisterPkResponse, got: %v", resp)
	}
	if rpk.GetResult() != pb.RegisterPkResponse_OK {
		t.Fatalf("RegisterPk result = %v, want OK", rpk.GetResult())
	}

	entry := srv.PeerMap().Get("WSDESK1")
	if entry == nil {
		t.Fatal("expected WSDESK1 in peer map")
	}
	if entry.WSConn == nil {
		t.Fatal("RegisterPk should bind WSConn")
	}
	if _, ok := entry.WSConn.(*codec.WSConn); !ok {
		t.Fatalf("WSConn has unexpected type %T", entry.WSConn)
	}
}

func TestWSSignalIDChangeKeepsInboundRegistrationOpen(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.SignalPort = 29400
	cfg.RelayPort = 29401
	dir := t.TempDir()
	cfg.DBPath = dir + "/test.db"
	cfg.KeyFile = dir + "/id_ed25519"

	database, err := db.OpenSQLite(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(); err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	kp, err := crypto.LoadOrGenerateKeyPair(cfg.KeyFile)
	if err != nil {
		t.Fatal(err)
	}

	srv := New(cfg, kp, database)
	ctx := t.Context()
	if err := srv.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	time.Sleep(200 * time.Millisecond)

	ws, _, err := websocket.Dial(ctx, "ws://127.0.0.1:29402/ws/id", nil)
	if err != nil {
		t.Fatalf("WS dial: %v", err)
	}
	defer ws.CloseNow()

	writeProto := func(msg *pb.RendezvousMessage) {
		t.Helper()
		data, err := proto.Marshal(msg)
		if err != nil {
			t.Fatal(err)
		}
		if err := ws.Write(ctx, websocket.MessageBinary, data); err != nil {
			t.Fatalf("WS write: %v", err)
		}
	}

	writeProto(&pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RegisterPk{
			RegisterPk: &pb.RegisterPk{
				Id: "WSOLD01", Uuid: []byte("desktop-ws-uuid1"), Pk: make([]byte, 32),
			},
		},
	})
	if got := readWSProtoSkippingKeepAlive(t, ctx, ws).GetRegisterPkResponse().GetResult(); got != pb.RegisterPkResponse_OK {
		t.Fatalf("initial RegisterPk result = %v, want OK", got)
	}

	// RustDesk 1.4.x omits pk in its ID-change RegisterPk request.
	writeProto(&pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RegisterPk{
			RegisterPk: &pb.RegisterPk{
				Id: "WSNEW01", OldId: "WSOLD01", Uuid: []byte("desktop-ws-uuid1"),
			},
		},
	})
	if got := readWSProtoSkippingKeepAlive(t, ctx, ws).GetRegisterPkResponse().GetResult(); got != pb.RegisterPkResponse_OK {
		t.Fatalf("ID-change RegisterPk result = %v, want OK", got)
	}

	if srv.PeerMap().Get("WSOLD01") != nil || srv.PeerMap().Get("WSNEW01") == nil {
		t.Fatal("renamed WSS peer was not moved to its new ID")
	}
	if err := srv.sendToWSPeer("WSNEW01", &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_Hc{Hc: &pb.HealthCheck{Token: "inbound-after-id-change"}},
	}); err != nil {
		t.Fatalf("send inbound message after ID change: %v", err)
	}
	if got := readWSProtoSkippingKeepAlive(t, ctx, ws).GetHc(); got == nil || got.Token != "inbound-after-id-change" {
		t.Fatalf("unexpected inbound message after ID change: %v", got)
	}
}

func TestWSSignalXForwardedFor(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.SignalPort = 29170
	cfg.RelayPort = 29171
	cfg.TrustProxy = true
	cfg.TrustedProxies = []*net.IPNet{mustCIDR(t, "127.0.0.1/32")}

	dir := t.TempDir()
	cfg.DBPath = dir + "/test.db"
	cfg.KeyFile = dir + "/id_ed25519"

	database, err := db.OpenSQLite(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	database.Migrate()
	defer database.Close()

	kp, err := crypto.LoadOrGenerateKeyPair(cfg.KeyFile)
	if err != nil {
		t.Fatal(err)
	}

	srv := New(cfg, kp, database)
	ctx := t.Context()
	if err := srv.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	time.Sleep(200 * time.Millisecond)

	ws, _, err := websocket.Dial(ctx, "ws://127.0.0.1:29172/ws/id", &websocket.DialOptions{
		HTTPHeader: http.Header{
			"X-Forwarded-For": []string{"203.0.113.50"},
		},
	})
	if err != nil {
		t.Fatalf("WS dial: %v", err)
	}
	defer ws.CloseNow()

	reg := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RegisterPeer{
			RegisterPeer: &pb.RegisterPeer{Id: "XFFWS01", Serial: 1},
		},
	}
	data, _ := proto.Marshal(reg)
	if err := ws.Write(ctx, websocket.MessageBinary, data); err != nil {
		t.Fatalf("WS write: %v", err)
	}
	readWSProtoSkippingKeepAlive(t, ctx, ws)

	entry := srv.PeerMap().Get("XFFWS01")
	if entry == nil {
		t.Fatal("peer XFFWS01 should exist")
	}
	if !strings.HasPrefix(entry.IP, "203.0.113.50:") {
		t.Fatalf("peer IP = %q, want prefix 203.0.113.50:", entry.IP)
	}
	if strings.HasSuffix(entry.IP, ":0") {
		t.Fatalf("peer IP = %q must not use synthetic :0 (issue #276)", entry.IP)
	}
	_, err = net.ResolveUDPAddr("udp", entry.IP)
	if err != nil {
		t.Fatalf("peer IP %q must parse as UDP addr: %v", entry.IP, err)
	}
}

func TestWSPunchHoleSentForwardsToWSInitiator(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.SignalPort = 29180
	cfg.RelayPort = 29181
	cfg.TrustProxy = true
	cfg.TrustedProxies = []*net.IPNet{mustCIDR(t, "127.0.0.1/32")}
	cfg.P2PFirst = true

	dir := t.TempDir()
	cfg.DBPath = dir + "/test.db"
	cfg.KeyFile = dir + "/id_ed25519"

	database, err := db.OpenSQLite(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	database.Migrate()
	defer database.Close()

	kp, err := crypto.LoadOrGenerateKeyPair(cfg.KeyFile)
	if err != nil {
		t.Fatal(err)
	}

	srv := New(cfg, kp, database)
	ctx := t.Context()
	if err := srv.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	time.Sleep(200 * time.Millisecond)

	ws, _, err := websocket.Dial(ctx, "ws://127.0.0.1:29182/ws/id", &websocket.DialOptions{
		HTTPHeader: http.Header{
			"X-Forwarded-For": []string{"203.0.113.77"},
		},
	})
	if err != nil {
		t.Fatalf("WS dial: %v", err)
	}
	defer ws.CloseNow()

	reg := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RegisterPeer{
			RegisterPeer: &pb.RegisterPeer{Id: "INITWS01", Serial: 1},
		},
	}
	data, _ := proto.Marshal(reg)
	if err := ws.Write(ctx, websocket.MessageBinary, data); err != nil {
		t.Fatalf("WS write: %v", err)
	}
	readWSProtoSkippingKeepAlive(t, ctx, ws)

	initiator := srv.PeerMap().Get("INITWS01")
	if initiator == nil || initiator.WSConn == nil {
		t.Fatal("INITWS01 should be registered with WSConn")
	}
	initiatorAddr, err := net.ResolveUDPAddr("udp", initiator.IP)
	if err != nil {
		t.Fatalf("resolve initiator IP %q: %v", initiator.IP, err)
	}

	targetAddr := &net.UDPAddr{IP: net.ParseIP("198.51.100.10"), Port: 21116}
	srv.PeerMap().Put(&peer.Entry{
		ID:       "TARGWS01",
		PK:       make([]byte, 32),
		IP:       targetAddr.String(),
		UDPAddr:  targetAddr,
		ConnType: peer.ConnUDP,
		LastReg:  time.Now(),
	})

	srv.handlePunchHoleSent(&pb.PunchHoleSent{
		Id:         "TARGWS01",
		SocketAddr: crypto.EncodeAddr(initiatorAddr),
		NatType:    pb.NatType_ASYMMETRIC,
	}, targetAddr, false)

	resp := readWSProtoSkippingKeepAlive(t, ctx, ws)
	phr := resp.GetPunchHoleResponse()
	if phr == nil {
		t.Fatalf("expected PunchHoleResponse on WS, got: %v", resp)
	}
	if len(phr.SocketAddr) == 0 {
		t.Fatal("PunchHoleResponse should carry target socket addr")
	}
}

func TestWSPunchHoleSentExactPortNotSiblingNAT(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.SignalPort = 29190
	cfg.RelayPort = 29191
	cfg.TrustProxy = true
	cfg.TrustedProxies = []*net.IPNet{mustCIDR(t, "127.0.0.1/32")}
	cfg.P2PFirst = true

	dir := t.TempDir()
	cfg.DBPath = dir + "/test.db"
	cfg.KeyFile = dir + "/id_ed25519"

	database, err := db.OpenSQLite(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	database.Migrate()
	defer database.Close()

	kp, err := crypto.LoadOrGenerateKeyPair(cfg.KeyFile)
	if err != nil {
		t.Fatal(err)
	}

	srv := New(cfg, kp, database)
	ctx := t.Context()
	if err := srv.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	time.Sleep(200 * time.Millisecond)

	dialWS := func(id string) *websocket.Conn {
		t.Helper()
		ws, _, err := websocket.Dial(ctx, "ws://127.0.0.1:29192/ws/id", &websocket.DialOptions{
			HTTPHeader: http.Header{
				"X-Forwarded-For": []string{"203.0.113.88"},
			},
		})
		if err != nil {
			t.Fatalf("WS dial %s: %v", id, err)
		}
		reg := &pb.RendezvousMessage{
			Union: &pb.RendezvousMessage_RegisterPeer{
				RegisterPeer: &pb.RegisterPeer{Id: id, Serial: 1},
			},
		}
		data, _ := proto.Marshal(reg)
		if err := ws.Write(ctx, websocket.MessageBinary, data); err != nil {
			t.Fatalf("WS write %s: %v", id, err)
		}
		readWSProtoSkippingKeepAlive(t, ctx, ws)
		return ws
	}

	wsA := dialWS("NATA0001")
	defer wsA.CloseNow()
	wsB := dialWS("NATB0001")
	defer wsB.CloseNow()

	peerA := srv.PeerMap().Get("NATA0001")
	peerB := srv.PeerMap().Get("NATB0001")
	if peerA == nil || peerB == nil {
		t.Fatal("both NAT peers should register")
	}
	if peerA.IP == peerB.IP {
		t.Fatalf("expected distinct ip:port keys, both %q", peerA.IP)
	}
	hostA, _, _ := net.SplitHostPort(peerA.IP)
	hostB, _, _ := net.SplitHostPort(peerB.IP)
	if hostA != "203.0.113.88" || hostB != "203.0.113.88" {
		t.Fatalf("want shared public IP, got A=%q B=%q", peerA.IP, peerB.IP)
	}
	if srv.PeerMap().CountWSByIP(net.ParseIP("203.0.113.88")) != 2 {
		t.Fatal("CountWSByIP should be 2")
	}

	initiatorAddr, err := net.ResolveUDPAddr("udp", peerA.IP)
	if err != nil {
		t.Fatal(err)
	}
	targetAddr := &net.UDPAddr{IP: net.ParseIP("198.51.100.20"), Port: 21116}
	srv.PeerMap().Put(&peer.Entry{
		ID:       "TARGNAT1",
		PK:       make([]byte, 32),
		IP:       targetAddr.String(),
		UDPAddr:  targetAddr,
		ConnType: peer.ConnUDP,
		LastReg:  time.Now(),
	})

	srv.handlePunchHoleSent(&pb.PunchHoleSent{
		Id:         "TARGNAT1",
		SocketAddr: crypto.EncodeAddr(initiatorAddr),
		NatType:    pb.NatType_ASYMMETRIC,
	}, targetAddr, false)

	resp := readWSProtoSkippingKeepAlive(t, ctx, wsA)
	if resp.GetPunchHoleResponse() == nil {
		t.Fatalf("peer A should receive PunchHoleResponse, got %v", resp)
	}

	readCtx, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
	defer cancel()
	_, data, err := wsB.Read(readCtx)
	if err == nil {
		var msg pb.RendezvousMessage
		_ = proto.Unmarshal(data, &msg)
		if msg.GetPunchHoleResponse() != nil {
			t.Fatal("peer B must not receive PunchHoleResponse intended for peer A")
		}
	}
}
