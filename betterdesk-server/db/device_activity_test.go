package db

import (
	"testing"
	"time"
)

func openActivityTestDB(t *testing.T) *SQLiteDB {
	t.Helper()
	database, err := OpenSQLite(t.TempDir() + "/activity.db")
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(); err != nil {
		database.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	return database
}

func TestDeviceOnlineSessionSplitsHeartbeatGap(t *testing.T) {
	database := openActivityTestDB(t)
	if err := database.UpsertPeer(&Peer{ID: "WORKPC1", Status: "OFFLINE"}); err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 6, 1, 8, 0, 0, 0, time.UTC)
	if err := database.TouchDeviceOnlineSession("WORKPC1", start, 90*time.Second); err != nil {
		t.Fatal(err)
	}
	if err := database.TouchDeviceOnlineSession("WORKPC1", start.Add(30*time.Second), 90*time.Second); err != nil {
		t.Fatal(err)
	}
	secondStart := start.Add(5 * time.Minute)
	if err := database.TouchDeviceOnlineSession("WORKPC1", secondStart, 90*time.Second); err != nil {
		t.Fatal(err)
	}
	if err := database.CloseDeviceOnlineSession("WORKPC1", secondStart.Add(time.Hour), "test_disconnect"); err != nil {
		t.Fatal(err)
	}

	sessions, err := database.ListDeviceOnlineSessions(DeviceOnlineSessionFilter{
		PeerIDs: []string{"WORKPC1"},
		From:    start.Add(-time.Hour),
		To:      secondStart.Add(2 * time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 {
		t.Fatalf("sessions = %d, want 2", len(sessions))
	}
	if sessions[0].EndedAt == nil || !sessions[0].EndedAt.Equal(start.Add(2*time.Minute)) {
		t.Fatalf("first session ended_at = %v, want %v", sessions[0].EndedAt, start.Add(2*time.Minute))
	}
	if sessions[0].EndReason != "heartbeat_gap" {
		t.Fatalf("first end reason = %q", sessions[0].EndReason)
	}
	if sessions[1].EndedAt == nil || !sessions[1].EndedAt.Equal(secondStart.Add(time.Hour)) {
		t.Fatalf("second session ended_at = %v", sessions[1].EndedAt)
	}
	open, err := database.GetOpenDeviceOnlineSessions([]string{"WORKPC1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(open) != 0 {
		t.Fatalf("open sessions = %d, want 0", len(open))
	}
}

func TestCloseStaleDeviceOnlineSessionsUsesHeartbeatGrace(t *testing.T) {
	database := openActivityTestDB(t)
	start := time.Date(2026, 6, 2, 9, 0, 0, 0, time.UTC)
	if err := database.TouchDeviceOnlineSession("STALEPC1", start, 0); err != nil {
		t.Fatal(err)
	}
	closed, err := database.CloseStaleDeviceOnlineSessions(start.Add(2*time.Minute), 45*time.Second, "heartbeat_timeout")
	if err != nil {
		t.Fatal(err)
	}
	if closed != 1 {
		t.Fatalf("closed = %d, want 1", closed)
	}
	sessions, err := database.ListDeviceOnlineSessions(DeviceOnlineSessionFilter{
		PeerIDs: []string{"STALEPC1"}, From: start.Add(-time.Minute), To: start.Add(3 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].EndedAt == nil {
		t.Fatalf("sessions = %+v", sessions)
	}
	if want := start.Add(45 * time.Second); !sessions[0].EndedAt.Equal(want) {
		t.Fatalf("ended_at = %v, want %v", sessions[0].EndedAt, want)
	}
}

func TestDeviceOnlineSessionsFollowPeerIDChange(t *testing.T) {
	database := openActivityTestDB(t)
	if err := database.UpsertPeer(&Peer{ID: "OLDWORK1", Status: "ONLINE"}); err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 6, 3, 7, 30, 0, 0, time.UTC)
	if err := database.TouchDeviceOnlineSession("OLDWORK1", start, 0); err != nil {
		t.Fatal(err)
	}
	if err := database.ChangePeerID("OLDWORK1", "NEWWORK1", "test"); err != nil {
		t.Fatal(err)
	}
	open, err := database.GetOpenDeviceOnlineSessions([]string{"NEWWORK1"})
	if err != nil {
		t.Fatal(err)
	}
	if open["NEWWORK1"] == nil || !open["NEWWORK1"].StartedAt.Equal(start) {
		t.Fatalf("renamed open session = %+v", open["NEWWORK1"])
	}
	if old, _ := database.GetOpenDeviceOnlineSessions([]string{"OLDWORK1"}); len(old) != 0 {
		t.Fatalf("old ID still has %d open sessions", len(old))
	}
}

func TestSetAllOfflineClosesOpenSessionsAtLastSeen(t *testing.T) {
	database := openActivityTestDB(t)
	start := time.Date(2026, 6, 4, 10, 0, 0, 0, time.UTC)
	lastSeen := start.Add(30 * time.Minute)
	if err := database.TouchDeviceOnlineSession("RESTART1", start, 0); err != nil {
		t.Fatal(err)
	}
	if err := database.TouchDeviceOnlineSession("RESTART1", lastSeen, 0); err != nil {
		t.Fatal(err)
	}
	if err := database.SetAllOffline(); err != nil {
		t.Fatal(err)
	}
	sessions, err := database.ListDeviceOnlineSessions(DeviceOnlineSessionFilter{
		PeerIDs: []string{"RESTART1"}, From: start.Add(-time.Minute), To: lastSeen.Add(time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].EndedAt == nil || !sessions[0].EndedAt.Equal(lastSeen) {
		t.Fatalf("session after restart = %+v", sessions)
	}
	if sessions[0].EndReason != "server_restart" {
		t.Fatalf("end reason = %q", sessions[0].EndReason)
	}
}

func TestHardDeletePeerRemovesDeviceOnlineHistory(t *testing.T) {
	database := openActivityTestDB(t)
	if err := database.UpsertPeer(&Peer{ID: "DELETEPC1", Status: "ONLINE"}); err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 6, 5, 10, 0, 0, 0, time.UTC)
	if err := database.TouchDeviceOnlineSession("DELETEPC1", start, 0); err != nil {
		t.Fatal(err)
	}
	if err := database.CloseDeviceOnlineSession("DELETEPC1", start.Add(time.Hour), "test"); err != nil {
		t.Fatal(err)
	}
	if err := database.HardDeletePeer("DELETEPC1"); err != nil {
		t.Fatal(err)
	}

	sessions, err := database.ListDeviceOnlineSessions(DeviceOnlineSessionFilter{
		PeerIDs: []string{"DELETEPC1"}, From: start.Add(-time.Minute), To: start.Add(2 * time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 0 {
		t.Fatalf("sessions after permanent deletion = %d, want 0", len(sessions))
	}
}
