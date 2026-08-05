package cdap

import (
	"testing"
	"time"

	servercrypto "github.com/unitronix/betterdesk-server/crypto"
	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/sessiongrant"
)

func TestPassiveDesktopGrantBindsCDAPOperatorAndTarget(t *testing.T) {
	gateway, database, _ := newDeviceTokenAuthGateway(t)
	if err := database.UpsertPeer(&db.Peer{
		ID: "AGENT001", Status: "ONLINE", DeviceType: "os_agent", Tags: "support-agent",
	}); err != nil {
		t.Fatal(err)
	}
	keyPair, err := servercrypto.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	if err := gateway.SetSessionGrantPrivateKey(keyPair.PrivateKey); err != nil {
		t.Fatal(err)
	}

	grant, capabilities, err := gateway.issuePassiveDesktopGrant("AGENT001", "operator-1", "session-1")
	if err != nil {
		t.Fatal(err)
	}
	if grant == "" || len(capabilities) != 2 {
		t.Fatalf("grant=%q capabilities=%v", grant, capabilities)
	}
	claims, err := sessiongrant.Verify(grant, keyPair.PublicKey, "AGENT001", "cdap", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if claims.OperatorID != "operator-1" || claims.SessionID != "session-1" {
		t.Fatalf("unexpected claims: %+v", claims)
	}
}

func TestPassiveDesktopGrantIsNotIssuedForOrdinaryDevice(t *testing.T) {
	gateway, _, _ := newDeviceTokenAuthGateway(t)
	grant, capabilities, err := gateway.issuePassiveDesktopGrant("AGENT001", "operator-1", "session-1")
	if err != nil {
		t.Fatal(err)
	}
	if grant != "" || capabilities != nil {
		t.Fatalf("ordinary device received passive grant: %q %v", grant, capabilities)
	}
}
