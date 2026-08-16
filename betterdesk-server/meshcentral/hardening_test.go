package meshcentral

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/unitronix/betterdesk-server/config"
)

func TestClientIPHonorsForwardedHeaderOnlyForTrustedProxy(t *testing.T) {
	t.Parallel()

	cfg := config.DefaultConfig()
	request := httptest.NewRequest(http.MethodGet, "http://mesh.example/agent.ashx", nil)
	request.RemoteAddr = "203.0.113.9:443"
	request.Header.Set("X-Forwarded-For", "198.51.100.20, 203.0.113.9")

	if got := clientIP(request, cfg); got != "203.0.113.9" {
		t.Fatalf("untrusted clientIP() = %q, want direct remote IP", got)
	}

	cfg.TrustProxy = true
	nets, err := config.ParseTrustedProxies("203.0.113.0/24")
	if err != nil {
		t.Fatal(err)
	}
	cfg.TrustedProxies = nets
	if got := clientIP(request, cfg); got != "198.51.100.20" {
		t.Fatalf("trusted clientIP() = %q, want first X-Forwarded-For hop", got)
	}
}

func TestAgentWebSocketOriginPolicyAllowsNativeAndConfiguredOrigins(t *testing.T) {
	gw, srv := newTestGateway(t)
	gw.cfg.AllowedWSOrigins = "https://console.example.test"
	wsURL := strings.Replace(srv.URL, "http://", "ws://", 1) + "/agent.ashx"

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// MeshAgent does not send Origin, so its protocol connection must remain
	// accepted when browser origins are configured.
	native, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("native agent upgrade failed: %v", err)
	}
	native.Close(websocket.StatusNormalClosure, "")

	allowed, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"https://console.example.test"}},
	})
	if err != nil {
		t.Fatalf("configured browser origin upgrade failed: %v", err)
	}
	allowed.Close(websocket.StatusNormalClosure, "")

	denied, response, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"https://attacker.example.test"}},
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
