package db

import (
	"testing"
)

func TestAssignStrategy(t *testing.T) {
	db := newTestDB(t)

	if err := db.CreateUserGroup(&UserGroup{Name: "UG1"}); err != nil {
		t.Fatalf("CreateUserGroup: %v", err)
	}
	if err := db.CreateDeviceGroup(&DeviceGroup{Name: "DG1"}); err != nil {
		t.Fatalf("CreateDeviceGroup: %v", err)
	}
	st := &Strategy{Name: "Policy A", Enabled: true, Permissions: "{}"}
	if err := db.CreateStrategy(st); err != nil {
		t.Fatalf("CreateStrategy: %v", err)
	}

	p := &Peer{ID: "DEV1001", UUID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", Status: "OFFLINE"}
	if err := db.UpsertPeer(p); err != nil {
		t.Fatalf("UpsertPeer: %v", err)
	}
	peerGUID, err := db.EnsurePeerGUID("DEV1001")
	if err != nil || peerGUID == "" {
		t.Fatalf("EnsurePeerGUID: %v guid=%q", err, peerGUID)
	}

	groups, _ := db.ListDeviceGroups()
	var dgGUID string
	for _, g := range groups {
		if g.Name == "DG1" {
			dgGUID = g.GUID
			break
		}
	}
	if dgGUID == "" {
		t.Fatal("device group guid missing")
	}

	if err := db.AssignStrategy(st.GUID, []string{peerGUID}, nil, []string{dgGUID}); err != nil {
		t.Fatalf("AssignStrategy: %v", err)
	}

	summary, err := db.GetStrategyAssignmentSummary(st.GUID)
	if err != nil {
		t.Fatalf("GetStrategyAssignmentSummary: %v", err)
	}
	if summary.PeerCount != 1 || summary.DeviceGroupCount != 1 {
		t.Fatalf("summary counts = %+v", summary)
	}

	if err := db.AssignStrategy("", []string{peerGUID}, nil, nil); err != nil {
		t.Fatalf("unassign peer: %v", err)
	}
	summary, _ = db.GetStrategyAssignmentSummary(st.GUID)
	if summary.PeerCount != 0 {
		t.Fatalf("expected peer unassigned, got %+v", summary)
	}

	if err := db.DeleteStrategy(st.GUID); err != nil {
		t.Fatalf("DeleteStrategy: %v", err)
	}
}
