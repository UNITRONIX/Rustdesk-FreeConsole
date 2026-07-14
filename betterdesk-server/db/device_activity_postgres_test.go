package db

import (
	"os"
	"testing"
	"time"
)

func TestPostgresDeviceOnlineSessions(t *testing.T) {
	dsn := os.Getenv("BETTERDESK_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("BETTERDESK_TEST_POSTGRES_DSN is not set")
	}
	database, err := OpenPostgres(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err := database.Migrate(); err != nil {
		t.Fatal(err)
	}

	peerID := "PGWORK01"
	database.pool.Exec(database.ctx, `DELETE FROM device_online_sessions WHERE peer_id = $1`, peerID)
	database.pool.Exec(database.ctx, `DELETE FROM peers WHERE id = $1`, peerID)
	t.Cleanup(func() {
		database.pool.Exec(database.ctx, `DELETE FROM device_online_sessions WHERE peer_id = $1`, peerID)
		database.pool.Exec(database.ctx, `DELETE FROM peers WHERE id = $1`, peerID)
	})
	if err := database.UpsertPeer(&Peer{ID: peerID, Status: "OFFLINE"}); err != nil {
		t.Fatal(err)
	}

	start := time.Date(2026, 7, 1, 8, 0, 0, 0, time.UTC)
	if err := database.TouchDeviceOnlineSession(peerID, start, 90*time.Second); err != nil {
		t.Fatal(err)
	}
	if err := database.TouchDeviceOnlineSession(peerID, start.Add(30*time.Second), 90*time.Second); err != nil {
		t.Fatal(err)
	}
	if err := database.CloseDeviceOnlineSession(peerID, start.Add(time.Hour), "integration_test"); err != nil {
		t.Fatal(err)
	}

	sessions, err := database.ListDeviceOnlineSessions(DeviceOnlineSessionFilter{
		PeerIDs: []string{peerID}, From: start.Add(-time.Minute), To: start.Add(2 * time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 1 || sessions[0].EndedAt == nil {
		t.Fatalf("PostgreSQL sessions = %+v", sessions)
	}
	if !sessions[0].StartedAt.Equal(start) || !sessions[0].EndedAt.Equal(start.Add(time.Hour)) {
		t.Fatalf("PostgreSQL interval = %+v", sessions[0])
	}
}
