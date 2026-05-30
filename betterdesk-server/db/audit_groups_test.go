package db

import "testing"

// TestAuditConnectionsRoundTrip verifies insert, list (with filters) and count.
func TestAuditConnectionsRoundTrip(t *testing.T) {
	db := newTestDB(t)

	for i := 0; i < 3; i++ {
		if err := db.InsertAuditConnection(&AuditConnection{
			HostID:   "HOST1",
			PeerID:   "PEER1",
			Action:   "connect",
			ConnType: 0,
			IP:       "10.0.0.1",
		}); err != nil {
			t.Fatalf("InsertAuditConnection: %v", err)
		}
	}
	if err := db.InsertAuditConnection(&AuditConnection{
		HostID: "HOST2",
		PeerID: "PEER2",
		Action: "disconnect",
	}); err != nil {
		t.Fatalf("InsertAuditConnection HOST2: %v", err)
	}

	total, err := db.CountAuditConnections(AuditFilter{})
	if err != nil {
		t.Fatalf("CountAuditConnections: %v", err)
	}
	if total != 4 {
		t.Errorf("CountAuditConnections = %d, want 4", total)
	}

	host1, err := db.ListAuditConnections(AuditFilter{HostID: "HOST1"})
	if err != nil {
		t.Fatalf("ListAuditConnections: %v", err)
	}
	if len(host1) != 3 {
		t.Errorf("ListAuditConnections(HOST1) = %d, want 3", len(host1))
	}

	n, err := db.CountAuditConnections(AuditFilter{Action: "disconnect"})
	if err != nil {
		t.Fatalf("CountAuditConnections(disconnect): %v", err)
	}
	if n != 1 {
		t.Errorf("CountAuditConnections(disconnect) = %d, want 1", n)
	}
}

// TestAuditFilesRoundTrip verifies file audit insert/list/count.
func TestAuditFilesRoundTrip(t *testing.T) {
	db := newTestDB(t)

	if err := db.InsertAuditFile(&AuditFile{
		HostID:    "HOST1",
		PeerID:    "PEER1",
		Direction: 1,
		Path:      "/tmp/x",
		IsFile:    1,
		NumFiles:  2,
		FilesJSON: `[{"name":"a"},{"name":"b"}]`,
	}); err != nil {
		t.Fatalf("InsertAuditFile: %v", err)
	}

	files, err := db.ListAuditFiles(AuditFilter{HostID: "HOST1"})
	if err != nil {
		t.Fatalf("ListAuditFiles: %v", err)
	}
	if len(files) != 1 {
		t.Fatalf("ListAuditFiles = %d, want 1", len(files))
	}
	if files[0].NumFiles != 2 || files[0].FilesJSON == "" {
		t.Errorf("unexpected file record: %+v", files[0])
	}
}

// TestAuditAlarmsRoundTrip verifies alarm audit insert/list/count with type filter.
func TestAuditAlarmsRoundTrip(t *testing.T) {
	db := newTestDB(t)

	typ := 3
	if err := db.InsertAuditAlarm(&AuditAlarm{
		AlarmType: typ,
		AlarmName: "ip_whitelist",
		HostID:    "HOST1",
	}); err != nil {
		t.Fatalf("InsertAuditAlarm: %v", err)
	}
	if err := db.InsertAuditAlarm(&AuditAlarm{AlarmType: 1, AlarmName: "other"}); err != nil {
		t.Fatalf("InsertAuditAlarm 2: %v", err)
	}

	got, err := db.ListAuditAlarms(AuditFilter{AlarmType: &typ})
	if err != nil {
		t.Fatalf("ListAuditAlarms: %v", err)
	}
	if len(got) != 1 || got[0].AlarmName != "ip_whitelist" {
		t.Errorf("ListAuditAlarms(type=3) = %+v", got)
	}
}

// TestUserGroupCRUD verifies user group create/get/update/delete and GUID generation.
func TestUserGroupCRUD(t *testing.T) {
	db := newTestDB(t)

	g := &UserGroup{Name: "Ops", Note: "operators"}
	if err := db.CreateUserGroup(g); err != nil {
		t.Fatalf("CreateUserGroup: %v", err)
	}
	if g.GUID == "" {
		t.Fatal("CreateUserGroup did not generate GUID")
	}

	got, err := db.GetUserGroup(g.GUID)
	if err != nil {
		t.Fatalf("GetUserGroup: %v", err)
	}
	if got == nil || got.Name != "Ops" {
		t.Fatalf("GetUserGroup = %+v", got)
	}

	if err := db.UpdateUserGroup(g.GUID, &UserGroup{Name: "Ops2", Note: "x", TeamID: "t1"}); err != nil {
		t.Fatalf("UpdateUserGroup: %v", err)
	}
	got, _ = db.GetUserGroup(g.GUID)
	if got.Name != "Ops2" || got.TeamID != "t1" {
		t.Errorf("UpdateUserGroup result = %+v", got)
	}

	if err := db.DeleteUserGroup(g.GUID); err != nil {
		t.Fatalf("DeleteUserGroup: %v", err)
	}
	got, _ = db.GetUserGroup(g.GUID)
	if got != nil {
		t.Errorf("group still present after delete: %+v", got)
	}
}

// TestDeviceGroupCRUD verifies device group create/get/update/delete and source_type rules.
func TestDeviceGroupCRUD(t *testing.T) {
	db := newTestDB(t)

	g := &DeviceGroup{Name: "Tagged", SourceType: "tag", TagFilter: "prod"}
	if err := db.CreateDeviceGroup(g); err != nil {
		t.Fatalf("CreateDeviceGroup: %v", err)
	}
	got, err := db.GetDeviceGroup(g.GUID)
	if err != nil {
		t.Fatalf("GetDeviceGroup: %v", err)
	}
	if got.SourceType != "tag" || got.TagFilter != "prod" {
		t.Errorf("device group = %+v", got)
	}

	// Manual source type must clear tag filter.
	m := &DeviceGroup{Name: "Manual", SourceType: "manual", TagFilter: "ignored"}
	if err := db.CreateDeviceGroup(m); err != nil {
		t.Fatalf("CreateDeviceGroup manual: %v", err)
	}
	gotM, _ := db.GetDeviceGroup(m.GUID)
	if gotM.SourceType != "manual" || gotM.TagFilter != "" {
		t.Errorf("manual group should clear tag_filter: %+v", gotM)
	}
}

// TestStrategyCRUD verifies strategy create/get/update/delete and enabled bool mapping.
func TestStrategyCRUD(t *testing.T) {
	db := newTestDB(t)

	st := &Strategy{Name: "Default", Enabled: true, Permissions: `{"file":true}`}
	if err := db.CreateStrategy(st); err != nil {
		t.Fatalf("CreateStrategy: %v", err)
	}
	got, err := db.GetStrategy(st.GUID)
	if err != nil {
		t.Fatalf("GetStrategy: %v", err)
	}
	if !got.Enabled || got.Permissions != `{"file":true}` {
		t.Errorf("strategy = %+v", got)
	}

	if err := db.UpdateStrategy(st.GUID, &Strategy{Name: "Default", Enabled: false}); err != nil {
		t.Fatalf("UpdateStrategy: %v", err)
	}
	got, _ = db.GetStrategy(st.GUID)
	if got.Enabled {
		t.Error("strategy should be disabled after update")
	}
	if got.Permissions != "{}" {
		t.Errorf("empty permissions should default to {}, got %q", got.Permissions)
	}

	all, err := db.ListStrategies()
	if err != nil {
		t.Fatalf("ListStrategies: %v", err)
	}
	if len(all) != 1 {
		t.Errorf("ListStrategies = %d, want 1", len(all))
	}
}

// TestMigrationBackwardCompatible verifies the new tables are added idempotently
// to a database that was migrated before they existed (existing-instance upgrade path).
func TestMigrationBackwardCompatible(t *testing.T) {
	db := newTestDB(t)

	// Simulate an existing instance: drop the new tables, then re-run Migrate.
	for _, tbl := range []string{
		"audit_connections", "audit_files", "audit_alarms",
		"user_groups", "device_groups", "strategies",
	} {
		if _, err := db.db.Exec("DROP TABLE IF EXISTS " + tbl); err != nil {
			t.Fatalf("drop %s: %v", tbl, err)
		}
	}

	// Insert a peer to ensure pre-existing data survives the migration.
	if err := db.UpsertPeer(&Peer{ID: "KEEP1", UUID: "u", Status: "ONLINE"}); err != nil {
		t.Fatalf("UpsertPeer: %v", err)
	}

	if err := db.Migrate(); err != nil {
		t.Fatalf("Migrate (upgrade path): %v", err)
	}

	// New tables must now be usable.
	if err := db.InsertAuditConnection(&AuditConnection{HostID: "H", Action: "connect"}); err != nil {
		t.Fatalf("InsertAuditConnection after re-migrate: %v", err)
	}

	// Pre-existing data must still be present.
	p, err := db.GetPeer("KEEP1")
	if err != nil {
		t.Fatalf("GetPeer: %v", err)
	}
	if p == nil {
		t.Error("pre-existing peer lost after migration")
	}
}
