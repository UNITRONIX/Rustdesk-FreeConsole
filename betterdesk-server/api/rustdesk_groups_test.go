package api

import (
	"testing"

	"github.com/unitronix/betterdesk-server/auth"
	"github.com/unitronix/betterdesk-server/db"
)

func TestPanelAccessAllowed(t *testing.T) {
	user := &db.User{Username: "operator1", Role: auth.RoleOperator}
	guids := map[string]bool{"ug-1": true}

	if panelAccessAllowed(user, auth.RoleOperator, guids, nil, nil) {
		t.Fatal("expected deny for empty ACL (fail closed)")
	}
	if panelAccessAllowed(user, auth.RoleOperator, guids, []string{"other"}, nil) {
		t.Fatal("expected deny when username not in allowed_users")
	}
	if !panelAccessAllowed(user, auth.RoleOperator, guids, nil, []string{"ug-1"}) {
		t.Fatal("expected allow via user group membership")
	}
	if !panelAccessAllowed(user, auth.RoleGlobalAdmin, guids, []string{"x"}, nil) {
		t.Fatal("expected global_admin bypass")
	}
}

func TestRustDeskPeerDeviceGroupName(t *testing.T) {
	assignments := map[string]int64{"P1": 1, "P2": 1, "P3": 2}
	folderNames := map[int64]string{1: "Admins", 2: "Users"}
	manual := map[string]string{"P3": "Servers", "P4": "Servers"}

	if got := rustDeskPeerDeviceGroupName("P1", assignments, folderNames, manual); got != "Admins" {
		t.Fatalf("folder assignment: got %q", got)
	}
	if got := rustDeskPeerDeviceGroupName("P3", assignments, folderNames, manual); got != "Users" {
		t.Fatalf("folder wins over manual group: got %q", got)
	}
	if got := rustDeskPeerDeviceGroupName("P4", assignments, folderNames, manual); got != "Servers" {
		t.Fatalf("manual group without folder: got %q", got)
	}
}

func TestBuildRustDeskPeerManualGroupNames(t *testing.T) {
	groups := []rustDeskGroup{
		{guid: "folder_1", name: "Admins", peerIDs: []string{"P1"}},
		{guid: "g-servers", name: "Servers", peerIDs: []string{"P2", "P3"}},
		{guid: "g-default", name: "Default", peerIDs: []string{"P3"}},
	}
	got := buildRustDeskPeerManualGroupNames(groups)
	if got["P1"] != "" {
		t.Fatalf("folder mirror group should be skipped, got %q", got["P1"])
	}
	if got["P2"] != "Servers" || got["P3"] != "Servers" {
		t.Fatalf("unexpected manual map: %#v", got)
	}
}
