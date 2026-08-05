package cdap

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/events"
	"github.com/unitronix/betterdesk-server/peer"
)

func TestWebSocketOriginPolicyAllowsNativeAndConfiguredOrigins(t *testing.T) {
	cfg := config.DefaultConfig()
	cfg.AllowedWSOrigins = "https://console.example.test"
	gateway := New(cfg, nil, peer.NewMap(), events.NewBus())
	gateway.ctx = context.Background()

	server := httptest.NewServer(http.HandlerFunc(gateway.handleWebSocket))
	t.Cleanup(server.Close)
	wsURL := strings.Replace(server.URL, "http://", "ws://", 1) + "/cdap"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// CDAP devices are native agents and do not send Origin.
	native, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		Subprotocols: []string{"cdap-v1"},
	})
	if err != nil {
		t.Fatalf("native CDAP upgrade failed: %v", err)
	}
	native.Close(websocket.StatusNormalClosure, "")

	allowed, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		Subprotocols: []string{"cdap-v1"},
		HTTPHeader:   http.Header{"Origin": []string{"https://console.example.test"}},
	})
	if err != nil {
		t.Fatalf("configured browser origin upgrade failed: %v", err)
	}
	allowed.Close(websocket.StatusNormalClosure, "")

	denied, response, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		Subprotocols: []string{"cdap-v1"},
		HTTPHeader:   http.Header{"Origin": []string{"https://attacker.example.test"}},
	})
	if denied != nil {
		denied.Close(websocket.StatusNormalClosure, "")
	}
	if err == nil {
		t.Fatal("unconfigured browser origin upgrade unexpectedly succeeded")
	}
	if response == nil || response.StatusCode != http.StatusForbidden {
		t.Fatalf("unconfigured origin status = %v, want %d", response, http.StatusForbidden)
	}
}
