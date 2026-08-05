package db

import (
	"os"
	"testing"
)

func TestPostgresRoundTripRenameTreatsCurrentIDAsActive(t *testing.T) {
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

	const idA, idB = "PGROUND_A", "PGROUND_B"
	cleanup := func() {
		_, _ = database.pool.Exec(database.ctx,
			`DELETE FROM id_change_history WHERE old_id = ANY($1) OR new_id = ANY($1)`,
			[]string{idA, idB})
		_, _ = database.pool.Exec(database.ctx,
			`DELETE FROM peers WHERE id = ANY($1)`, []string{idA, idB})
	}
	cleanup()
	t.Cleanup(cleanup)

	if err := database.UpsertPeer(&Peer{ID: idA, Status: "ONLINE"}); err != nil {
		t.Fatal(err)
	}
	if err := database.ChangePeerID(idA, idB, "client"); err != nil {
		t.Fatal(err)
	}
	if err := database.ChangePeerID(idB, idA, "client"); err != nil {
		t.Fatal(err)
	}

	renamed, err := database.IsRenamedPeerID(idA)
	if err != nil {
		t.Fatal(err)
	}
	if renamed {
		t.Fatalf("current %s must not be treated as a stale renamed ID", idA)
	}

	renamed, err = database.IsRenamedPeerID(idB)
	if err != nil {
		t.Fatal(err)
	}
	if !renamed {
		t.Fatalf("non-current %s should remain reserved as a renamed ID", idB)
	}
}
