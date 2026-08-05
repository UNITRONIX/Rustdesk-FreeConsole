package cdap

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"testing"

	"github.com/unitronix/betterdesk-server/auth"
	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/events"
	"github.com/unitronix/betterdesk-server/peer"
)

func newDeviceTokenAuthGateway(t *testing.T) (*Gateway, db.Database, string) {
	t.Helper()

	database, err := db.OpenSQLite(filepath.Join(t.TempDir(), "cdap-device-token.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(); err != nil {
		database.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })

	const deviceID = "AGENT001"
	if err := database.UpsertPeer(&db.Peer{ID: deviceID, Status: "ONLINE"}); err != nil {
		t.Fatal(err)
	}

	const plainToken = "cdap-device-token-0123456789"
	sum := sha256.Sum256([]byte(plainToken))
	if err := database.CreateDeviceToken(&db.DeviceToken{
		Token:     plainToken,
		TokenHash: hex.EncodeToString(sum[:]),
		Name:      "agent token",
		PeerID:    deviceID,
		Status:    db.TokenStatusActive,
	}); err != nil {
		t.Fatal(err)
	}

	return New(config.DefaultConfig(), database, peer.NewMap(), events.NewBus()), database, plainToken
}

func TestDeviceTokenAuthenticatesAsDeviceScopedRole(t *testing.T) {
	gateway, _, token := newDeviceTokenAuthGateway(t)

	username, role, err := gateway.authDeviceToken(AuthPayload{
		Token:    token,
		DeviceID: "AGENT001",
	}, "127.0.0.1")
	if err != nil {
		t.Fatalf("authDeviceToken: %v", err)
	}
	if username != "device:AGENT001" {
		t.Fatalf("username = %q, want device-scoped identity", username)
	}
	if role != auth.RoleDevice {
		t.Fatalf("role = %q, want %q", role, auth.RoleDevice)
	}
	if auth.HasPermission(role, auth.RoleOperator) {
		t.Fatal("device role must not satisfy operator role checks")
	}
	if auth.RoleHasPermission(role, auth.PermDeviceView) {
		t.Fatal("device role must not receive panel permissions")
	}
}

func TestDeviceTokenCannotAuthenticateAnotherDevice(t *testing.T) {
	gateway, _, token := newDeviceTokenAuthGateway(t)

	if _, _, err := gateway.authDeviceToken(AuthPayload{
		Token:    token,
		DeviceID: "OTHER001",
	}, "127.0.0.1"); err == nil {
		t.Fatal("device token bound to AGENT001 authenticated OTHER001")
	}
}

func TestDeviceTokenCannotAuthenticateDisabledDevice(t *testing.T) {
	gateway, database, token := newDeviceTokenAuthGateway(t)
	if err := database.UpsertPeer(&db.Peer{
		ID:       "AGENT001",
		Status:   "ONLINE",
		Disabled: true,
	}); err != nil {
		t.Fatal(err)
	}

	if _, _, err := gateway.authDeviceToken(AuthPayload{
		Token:    token,
		DeviceID: "AGENT001",
	}, "127.0.0.1"); err == nil {
		t.Fatal("disabled device token unexpectedly authenticated")
	}
}
