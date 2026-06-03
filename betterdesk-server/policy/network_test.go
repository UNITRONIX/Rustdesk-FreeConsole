package policy

import (
	"path/filepath"
	"testing"

	"github.com/unitronix/betterdesk-server/db"
)

func TestNetworkResolverForceRelay(t *testing.T) {
	database, err := db.OpenSQLite(filepath.Join(t.TempDir(), "policy-test.db"))
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	t.Cleanup(func() { database.Close() })
	if err := database.Migrate(); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	if err := database.CreateOrganization(&db.Organization{ID: "org1", Name: "Test Org"}); err != nil {
		t.Fatalf("CreateOrganization: %v", err)
	}
	if err := database.SetOrgSetting("org1", networkPolicyKey, `{"block_direct_p2p":true}`); err != nil {
		t.Fatalf("SetOrgSetting: %v", err)
	}
	if err := database.AssignDeviceToOrg(&db.OrgDevice{OrgID: "org1", DeviceID: "device123"}); err != nil {
		t.Fatalf("AssignDeviceToOrg: %v", err)
	}

	r := NewNetworkResolver(database)
	if !r.ShouldForceRelay("device123") {
		t.Fatal("expected block_direct_p2p to force relay")
	}
	if r.ShouldForceRelay("unknown") {
		t.Fatal("unknown device should not force relay")
	}
}

func TestNetworkResolverAllowedRelayServers(t *testing.T) {
	database, err := db.OpenSQLite(filepath.Join(t.TempDir(), "policy-relay.db"))
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	t.Cleanup(func() { database.Close() })
	if err := database.Migrate(); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	if err := database.CreateOrganization(&db.Organization{ID: "org2", Name: "Relay Org"}); err != nil {
		t.Fatalf("CreateOrganization: %v", err)
	}
	if err := database.SetOrgSetting("org2", networkPolicyKey, `{"allowed_relay_servers":["relay.example.com:21117"]}`); err != nil {
		t.Fatalf("SetOrgSetting: %v", err)
	}
	if err := database.AssignDeviceToOrg(&db.OrgDevice{OrgID: "org2", DeviceID: "devA"}); err != nil {
		t.Fatalf("AssignDeviceToOrg: %v", err)
	}

	r := NewNetworkResolver(database)
	got := r.ResolveRelay("198.51.100.1:21117", "devA")
	if got != "relay.example.com:21117" {
		t.Fatalf("ResolveRelay = %q, want org allowlist entry", got)
	}
}
