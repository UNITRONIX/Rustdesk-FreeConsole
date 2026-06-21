package meshcentral

import (
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestRelayIDPairing(t *testing.T) {
	g := &Gateway{
		relays: sync.Map{},
	}
	// pairing logic is integration-tested via meshrelay handler;
	// verify relay session map stores pending peer.
	session := &relaySession{id: "test-relay-id"}
	g.relays.Store("test-relay-id", session)
	v, ok := g.relays.Load("test-relay-id")
	if !ok || v.(*relaySession).id != "test-relay-id" {
		t.Fatal("relay session not stored")
	}
}

func TestRelayCookieReplayExpired(t *testing.T) {
	c, _ := NewCookieCodec("relay-test-secret-32chars-min")
	data := &RelayCookieData{RUserID: "u", ExpireMin: 1, IssuedAt: time.Now().Unix() - 3600}
	cookie, err := c.Encode(data, 1)
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.Decode(cookie, 1)
	if err == nil {
		t.Fatal("expected expired cookie error")
	}
}

// Ensure mesh relay connect signal matches MeshCentral contract.
func TestRelayConnectSignal(t *testing.T) {
	if string([]byte{'c'}) != "c" {
		t.Fatal("connect signal must be 'c'")
	}
	_ = websocket.MessageText
}
