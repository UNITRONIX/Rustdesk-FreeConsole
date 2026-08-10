package db

import (
	"testing"
	"time"
)

func TestRemoteAccessSessionLifecycleSQLite(t *testing.T) {
	database := newTestDB(t)
	start := time.Date(2026, 7, 14, 8, 0, 0, 0, time.UTC)
	session := &RemoteAccessSession{
		SessionKey: "native:test-session", TargetID: "TARGET01", TargetUUID: "uuid-target",
		OperatorUsername: "support.alice", ControllerID: "SUPPORT1", ControllerName: "Alice PC",
		ConnectionType: 0, Source: "rustdesk_audit", StartedAt: start, LastSeenAt: start,
	}
	if err := database.UpsertRemoteAccessSession(session); err != nil {
		t.Fatal(err)
	}
	// A repeated audit post must be idempotent.
	if err := database.UpsertRemoteAccessSession(session); err != nil {
		t.Fatal(err)
	}
	rows, err := database.ListRemoteAccessSessions(RemoteAccessSessionFilter{
		TargetIDs: []string{"TARGET01"}, From: start.Add(-time.Hour), To: start.Add(time.Hour),
	})
	if err != nil || len(rows) != 1 {
		t.Fatalf("rows=%+v err=%v", rows, err)
	}
	open, err := database.GetOpenRemoteAccessSessions([]string{"TARGET01"})
	if err != nil || len(open["TARGET01"]) != 1 {
		t.Fatalf("open=%+v err=%v", open, err)
	}
	end := start.Add(90 * time.Minute)
	if err := database.EndRemoteAccessSession(session.SessionKey, end, "close"); err != nil {
		t.Fatal(err)
	}
	open, err = database.GetOpenRemoteAccessSessions([]string{"TARGET01"})
	if err != nil || len(open["TARGET01"]) != 0 {
		t.Fatalf("open after close=%+v err=%v", open, err)
	}
	rows, err = database.ListRemoteAccessSessions(RemoteAccessSessionFilter{
		Operators: []string{"support.alice"}, From: start.Add(-time.Hour), To: end.Add(time.Hour),
	})
	if err != nil || len(rows) != 1 || rows[0].EndedAt == nil || !rows[0].EndedAt.Equal(end) {
		t.Fatalf("closed rows=%+v err=%v", rows, err)
	}
}
