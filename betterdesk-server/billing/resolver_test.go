package billing

import (
	"errors"
	"testing"

	"github.com/unitronix/betterdesk-server/db"
)

type mockResolver struct {
	byTarget map[string]*db.BillingContract
	orgID    string
}

func (m *mockResolver) GetActiveBillingContract(targetType, targetKey string) (*db.BillingContract, error) {
	if m.byTarget == nil {
		return nil, nil
	}
	return m.byTarget[targetType+":"+targetKey], nil
}

func (m *mockResolver) GetDeviceOrgID(deviceID string) (string, error) {
	return m.orgID, nil
}

type mockPanel struct {
	folders map[string]int64
	groups  []string
}

func (m *mockPanel) ListFolderAssignments() (map[string]int64, error) {
	return m.folders, nil
}

func (m *mockPanel) ListDeviceGroupGUIDsForPeer(peerID string) ([]string, error) {
	return m.groups, nil
}

func TestResolveContractForDevicePriority(t *testing.T) {
	deviceContract := &db.BillingContract{ID: "c-device", TargetType: db.BillingTargetDevice}
	folderContract := &db.BillingContract{ID: "c-folder", TargetType: db.BillingTargetFolder}
	groupContract := &db.BillingContract{ID: "c-group", TargetType: db.BillingTargetDeviceGroup}
	orgContract := &db.BillingContract{ID: "c-org", TargetType: db.BillingTargetOrg}

	resolver := &mockResolver{
		orgID: "org-1",
		byTarget: map[string]*db.BillingContract{
			"device:dev1":           deviceContract,
			"folder:5":              folderContract,
			"device_group:grp-guid": groupContract,
			"org:org-1":             orgContract,
		},
	}
	panel := &mockPanel{
		folders: map[string]int64{"dev1": 5},
		groups:  []string{"grp-guid"},
	}

	got, err := ResolveContractForDevice(resolver, panel, "dev1")
	if err != nil {
		t.Fatalf("ResolveContractForDevice: %v", err)
	}
	if got == nil || got.ID != "c-device" {
		t.Fatalf("want device contract, got %#v", got)
	}

	resolver.byTarget["device:dev1"] = nil
	got, err = ResolveContractForDevice(resolver, panel, "dev1")
	if err != nil || got == nil || got.ID != "c-folder" {
		t.Fatalf("want folder contract, got %#v err=%v", got, err)
	}

	resolver.byTarget["folder:5"] = nil
	got, err = ResolveContractForDevice(resolver, panel, "dev1")
	if err != nil || got == nil || got.ID != "c-group" {
		t.Fatalf("want group contract, got %#v err=%v", got, err)
	}

	resolver.byTarget["device_group:grp-guid"] = nil
	got, err = ResolveContractForDevice(resolver, panel, "dev1")
	if err != nil || got == nil || got.ID != "c-org" {
		t.Fatalf("want org contract, got %#v err=%v", got, err)
	}
}

func TestNormalizeContractTargetLegacyOrg(t *testing.T) {
	body := &db.BillingContract{OrgID: "org-99", PackageID: "pkg-1"}
	if err := NormalizeContractTarget(body); err != nil {
		t.Fatal(err)
	}
	if body.TargetType != db.BillingTargetOrg || body.TargetKey != "org-99" {
		t.Fatalf("got type=%q key=%q", body.TargetType, body.TargetKey)
	}
}

func TestNormalizeContractTargetInvalid(t *testing.T) {
	err := NormalizeContractTarget(&db.BillingContract{TargetType: "bad", TargetKey: "x"})
	if err == nil {
		t.Fatal("expected error for invalid target_type")
	}
	if !errors.Is(err, err) && err.Error() == "" {
		t.Fatal("expected non-empty error")
	}
}
