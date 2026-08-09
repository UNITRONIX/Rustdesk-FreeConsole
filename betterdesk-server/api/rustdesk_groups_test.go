package api

import (
	"fmt"
	"testing"

	"github.com/unitronix/betterdesk-server/auth"
	"github.com/unitronix/betterdesk-server/db"
)

func TestPanelAccessAllowedCaseInsensitive(t *testing.T) {
	user := &db.User{Username: "Test", Role: auth.RoleOperator}
	guids := map[string]bool{
		"Ug-AbC": true,
		"ug-abc": true,
	}
	if !panelAccessAllowed(user, auth.RoleOperator, guids, []string{"test"}, nil) {
		t.Fatal("expected case-insensitive username match")
	}
	if !panelAccessAllowed(user, auth.RoleOperator, guids, nil, []string{"UG-ABC"}) {
		t.Fatal("expected case-insensitive user-group GUID match")
	}
}

func TestPanelAccessAllowedStrictIgnoresAdminBypass(t *testing.T) {
	admin := &db.User{Username: "Chesster", Role: auth.RoleAdmin}
	guids := map[string]bool{"ug-ops": true}

	// Privileged bypass still applies for panel-style checks.
	if !panelAccessAllowed(admin, auth.RoleAdmin, guids, nil, nil) {
		t.Fatal("panelAccessAllowed should bypass for admin on empty ACL")
	}
	// Strict helper itself must deny empty grants even for admin.
	if panelAccessAllowedStrict(admin, guids, nil, nil) {
		t.Fatal("strict ACL must deny empty grants even for admin")
	}
	if panelAccessAllowedStrict(admin, guids, nil, []string{"ug-other"}) {
		t.Fatal("strict ACL must deny groups outside the admin's user groups")
	}
	if !panelAccessAllowedStrict(admin, guids, nil, []string{"ug-ops"}) {
		t.Fatal("strict ACL must allow groups granted to the admin's user group")
	}
	// RustDesk AB group listing uses panelAccessAllowed — admins see all groups.
	g := db.PanelDeviceGroup{Name: "Event Servers", AllowedGroupGUIDs: []string{"ug-other"}}
	if !panelGroupAllowedForRustDeskAB(g, admin, auth.RoleAdmin, guids) {
		t.Fatal("RustDesk AB must list device groups for panel admins (panel parity)")
	}
	g.AllowedGroupGUIDs = nil
	if !panelGroupAllowedForRustDeskAB(g, admin, auth.RoleAdmin, guids) {
		t.Fatal("RustDesk AB must list empty-ACL groups for panel admins")
	}
	op := &db.User{Username: "op", Role: auth.RoleOperator}
	if panelGroupAllowedForRustDeskAB(g, op, auth.RoleOperator, guids) {
		t.Fatal("RustDesk AB must hide empty-ACL groups from operators")
	}
	g.AllowedGroupGUIDs = []string{"ug-ops"}
	if !panelGroupAllowedForRustDeskAB(g, op, auth.RoleOperator, guids) {
		t.Fatal("RustDesk AB must show groups granted to the operator's user group")
	}
}

func TestCoerceNonAdminVisibleSet(t *testing.T) {
	srv := &Server{}
	user := &db.User{ID: 1, Username: "op", Role: auth.RoleOperator}
	peerByID := map[string]*db.Peer{"A": {ID: "A"}, "B": {ID: "B"}}

	// Restricted + nil → deny-all
	srv.SetPanelStore(&mockPanelACLStore{restrictedDefault: true})
	got := srv.coerceNonAdminVisibleSet(user, auth.RoleOperator, peerByID, nil)
	if got == nil || len(got) != 0 {
		t.Fatalf("restricted nil coerce = %#v, want empty map", got)
	}

	// Open + nil → materialize full inventory (never leave nil for non-admins)
	srv.SetPanelStore(&mockPanelACLStore{restrictedDefault: false})
	got = srv.coerceNonAdminVisibleSet(user, auth.RoleOperator, peerByID, nil)
	if got == nil || !got["A"] || !got["B"] {
		t.Fatalf("open nil coerce = %#v, want full inventory", got)
	}

	// Admin keeps nil
	if got := srv.coerceNonAdminVisibleSet(user, auth.RoleAdmin, peerByID, nil); got != nil {
		t.Fatalf("admin nil must stay nil, got %#v", got)
	}
}

func TestRustDeskPeerDeviceGroupName(t *testing.T) {
	assignments := map[string]int64{"P1": 1, "P2": 1, "P3": 2}
	folderNames := map[int64]string{1: "Admins", 2: "Users"}
	manual := map[string]string{"P3": "Servers", "P4": "Servers"}

	if got := rustDeskPeerDeviceGroupName("P1", assignments, folderNames, manual); got != "Admins" {
		t.Fatalf("folder assignment only: got %q", got)
	}
	if got := rustDeskPeerDeviceGroupName("P3", assignments, folderNames, manual); got != "Servers" {
		t.Fatalf("device group must win over folder: got %q", got)
	}
	if got := rustDeskPeerDeviceGroupName("P4", assignments, folderNames, manual); got != "Servers" {
		t.Fatalf("manual group without folder: got %q", got)
	}
}

func TestBuildRustDeskDeviceGroupsHidesEmptyGroups(t *testing.T) {
	srv := &Server{}
	srv.SetPanelStore(&mockPanelACLStore{
		restrictedDefault: false,
		userIDs:           map[string]int64{"admin": 1},
		groups: []db.PanelDeviceGroup{
			{ID: 1, GUID: "g-full", Name: "With Peers", AllowedUsers: []string{"admin"}},
			{ID: 2, GUID: "g-empty", Name: "Empty Group", AllowedUsers: []string{"admin"}},
		},
		members: map[int64][]string{
			1: {"P1"},
			2: {}, // no members — must not appear in sidebar
		},
	})
	user := &db.User{ID: 1, Username: "admin", Role: auth.RoleAdmin}
	peerByID := map[string]*db.Peer{"P1": {ID: "P1"}}

	got := srv.buildRustDeskDeviceGroupsFromContext(user, auth.RoleAdmin, peerByID, nil)
	if len(got) != 1 || got[0].name != "With Peers" {
		t.Fatalf("expected only non-empty group, got %#v", got)
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

type errPanelStore struct {
	mockPanelACLStore
	groupsErr error
}

func (e *errPanelStore) ListPanelDeviceGroups() ([]db.PanelDeviceGroup, error) {
	if e.groupsErr != nil {
		return nil, e.groupsErr
	}
	return e.mockPanelACLStore.ListPanelDeviceGroups()
}

func TestRustDeskVisiblePeerSetFailClosedWithoutPanelStore(t *testing.T) {
	srv := &Server{}
	user := &db.User{ID: 1, Username: "op", Role: auth.RoleOperator}
	peerByID := map[string]*db.Peer{"A": {ID: "A"}, "B": {ID: "B"}}

	visible := srv.rustDeskVisiblePeerSet(user, auth.RoleOperator, peerByID)
	if visible == nil {
		t.Fatal("missing panelStore must not mean unrestricted (nil)")
	}
	if len(visible) != 0 {
		t.Fatalf("expected empty deny-all set, got %#v", visible)
	}

	// Admins still unrestricted without panelStore.
	if got := srv.rustDeskVisiblePeerSet(user, auth.RoleAdmin, peerByID); got != nil {
		t.Fatalf("admin should be unrestricted (nil), got %#v", got)
	}
}

func TestRustDeskVisiblePeerSetFailClosedOnPanelQueryError(t *testing.T) {
	srv := &Server{}
	srv.SetPanelStore(&errPanelStore{
		mockPanelACLStore: mockPanelACLStore{
			restrictedDefault: true,
			groups: []db.PanelDeviceGroup{{
				ID: 1, GUID: "dg-a", Name: "A", AllowedUsers: []string{"op"},
			}},
			members: map[int64][]string{1: {"A"}},
		},
		groupsErr: fmt.Errorf("db unavailable"),
	})
	user := &db.User{ID: 1, Username: "op", Role: auth.RoleOperator}
	peerByID := map[string]*db.Peer{"A": {ID: "A"}, "B": {ID: "B"}}

	visible := srv.rustDeskVisiblePeerSet(user, auth.RoleOperator, peerByID)
	if visible == nil || len(visible) != 0 {
		t.Fatalf("panel query error must deny-all, got %#v", visible)
	}
}

func TestRustDeskVisiblePeerSetOpenModeHidesDeniedFolder(t *testing.T) {
	store := &folderACLStore{
		mockPanelACLStore: mockPanelACLStore{
			restrictedDefault: false,
			userIDs:           map[string]int64{"op": 1},
		},
		folders: []db.PanelFolder{{ID: 10, Name: "TeamA"}, {ID: 20, Name: "TeamB"}},
		assignments: map[string]int64{"ALLOW1": 10, "DENY1": 20},
		folderACL: map[int64][2][]string{
			10: {{"op"}, nil},
			20: {{"other"}, nil},
		},
	}
	srv := &Server{}
	srv.SetPanelStore(store)
	user := &db.User{ID: 1, Username: "op", Role: auth.RoleOperator}
	peerByID := map[string]*db.Peer{
		"ALLOW1": {ID: "ALLOW1"},
		"DENY1":  {ID: "DENY1"},
		"FREE1":  {ID: "FREE1"}, // unassigned — must NOT leak once user has any grant
	}

	visible := srv.rustDeskVisiblePeerSet(user, auth.RoleOperator, peerByID)
	if visible == nil {
		t.Fatal("scoped user must return an explicit set")
	}
	if !visible["ALLOW1"] {
		t.Fatalf("expected ALLOW1 visible, got %#v", visible)
	}
	if visible["DENY1"] || visible["FREE1"] {
		t.Fatalf("DENY1 and unassigned FREE1 must be hidden when user has grants, got %#v", visible)
	}
}

func TestRustDeskVisiblePeerSetOpenOverlayOnlyWithoutGrants(t *testing.T) {
	// Open mode, user has no folder/group/peer grants: unassigned stays visible,
	// devices in private folders stay hidden.
	store := &folderACLStore{
		mockPanelACLStore: mockPanelACLStore{
			restrictedDefault: false,
			userIDs:           map[string]int64{"op": 1},
		},
		folders:     []db.PanelFolder{{ID: 10, Name: "Private"}},
		assignments: map[string]int64{"HIDE1": 10},
		folderACL: map[int64][2][]string{
			10: {{"admin-only"}, nil},
		},
	}
	srv := &Server{}
	srv.SetPanelStore(store)
	user := &db.User{ID: 1, Username: "op", Role: auth.RoleOperator}
	peerByID := map[string]*db.Peer{
		"HIDE1": {ID: "HIDE1"},
		"FREE1": {ID: "FREE1"},
	}

	visible := srv.rustDeskVisiblePeerSet(user, auth.RoleOperator, peerByID)
	if visible == nil {
		t.Fatal("expected explicit open-overlay set")
	}
	if !visible["FREE1"] || visible["HIDE1"] {
		t.Fatalf("open overlay without grants: want FREE1 only, got %#v", visible)
	}
}

// folderACLStore extends mockPanelACLStore with folder ACL fixtures.
type folderACLStore struct {
	mockPanelACLStore
	folders     []db.PanelFolder
	assignments map[string]int64
	folderACL   map[int64][2][]string
}

func (f *folderACLStore) ListFolders() ([]db.PanelFolder, error) { return f.folders, nil }
func (f *folderACLStore) ListFolderAssignments() (map[string]int64, error) {
	return f.assignments, nil
}
func (f *folderACLStore) FolderGroupAccess(folderID int64) ([]string, []string, error) {
	acl := f.folderACL[folderID]
	return acl[0], acl[1], nil
}
