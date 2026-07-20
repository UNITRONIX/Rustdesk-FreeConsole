package db

import (
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// clientSessionsPostgresDDL creates the RustDesk client session table (#242 / #284).
const clientSessionsPostgresDDL = `CREATE TABLE IF NOT EXISTS client_sessions (
			id          BIGSERIAL PRIMARY KEY,
			token_hash  TEXT UNIQUE NOT NULL,
			user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			client_id   TEXT NOT NULL DEFAULT '',
			client_uuid TEXT NOT NULL DEFAULT '',
			expires_at  TIMESTAMPTZ NOT NULL,
			last_used   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			revoked     BOOLEAN NOT NULL DEFAULT FALSE,
			ip_address  TEXT NOT NULL DEFAULT ''
		)`

// EnsureClientSessionsSchema creates client_sessions + indexes if missing (idempotent).
func (pg *PostgresDB) EnsureClientSessionsSchema() error {
	statements := []string{
		clientSessionsPostgresDDL,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_client_sessions_hash ON client_sessions(token_hash)`,
		`CREATE INDEX IF NOT EXISTS idx_client_sessions_user ON client_sessions(user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_client_sessions_expires ON client_sessions(expires_at)`,
	}
	for _, stmt := range statements {
		if _, err := pg.pool.Exec(pg.ctx, stmt); err != nil {
			return fmt.Errorf("db: EnsureClientSessionsSchema: %w", err)
		}
	}
	return nil
}

// CreateClientSession inserts a new RustDesk client session.
func (pg *PostgresDB) CreateClientSession(sess *ClientSession) error {
	err := pg.pool.QueryRow(pg.ctx,
		`INSERT INTO client_sessions
			(token_hash, user_id, client_id, client_uuid, expires_at, last_used, ip_address)
		 VALUES ($1, $2, $3, $4, $5::timestamptz, NOW(), $6)
		 RETURNING id, created_at`,
		sess.TokenHash, sess.UserID, sess.ClientID, sess.ClientUUID, sess.ExpiresAt, sess.IPAddress,
	).Scan(&sess.ID, &sess.CreatedAt)
	if err != nil {
		return fmt.Errorf("db: CreateClientSession: %w", err)
	}
	return nil
}

// GetClientSessionByTokenHash returns an active (non-revoked, non-expired) session or nil.
func (pg *PostgresDB) GetClientSessionByTokenHash(tokenHash string) (*ClientSession, error) {
	sess := &ClientSession{}
	var revoked bool
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT id, token_hash, user_id, client_id, client_uuid,
			to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
			to_char(last_used AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
			to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
			revoked, ip_address
		 FROM client_sessions
		 WHERE token_hash = $1 AND revoked = FALSE AND expires_at > NOW()`,
		tokenHash,
	).Scan(
		&sess.ID, &sess.TokenHash, &sess.UserID, &sess.ClientID, &sess.ClientUUID,
		&sess.ExpiresAt, &sess.LastUsed, &sess.CreatedAt, &revoked, &sess.IPAddress)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	sess.Revoked = revoked
	return sess, nil
}

// GetActiveClientSessionByClient returns the newest active session for a RustDesk
// client id and/or uuid, or nil when none match.
func (pg *PostgresDB) GetActiveClientSessionByClient(clientID, clientUUID string) (*ClientSession, error) {
	clientID = strings.TrimSpace(clientID)
	clientUUID = strings.TrimSpace(clientUUID)
	if clientID == "" && clientUUID == "" {
		return nil, nil
	}

	sess := &ClientSession{}
	var revoked bool
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT id, token_hash, user_id, client_id, client_uuid,
			to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
			to_char(last_used AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
			to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
			revoked, ip_address
		 FROM client_sessions
		 WHERE revoked = FALSE AND expires_at > NOW()
		   AND (
		     ($1 <> '' AND client_id = $1)
		     OR ($2 <> '' AND client_uuid = $2)
		   )
		 ORDER BY COALESCE(last_used, created_at) DESC, id DESC
		 LIMIT 1`,
		clientID, clientUUID,
	).Scan(
		&sess.ID, &sess.TokenHash, &sess.UserID, &sess.ClientID, &sess.ClientUUID,
		&sess.ExpiresAt, &sess.LastUsed, &sess.CreatedAt, &revoked, &sess.IPAddress)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	sess.Revoked = revoked
	return sess, nil
}

// TouchClientSession updates expiry and last_used for sliding session renewal.
func (pg *PostgresDB) TouchClientSession(id int64, expiresAt, lastUsed string) error {
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE client_sessions SET expires_at = $1::timestamptz, last_used = $2::timestamptz
		 WHERE id = $3 AND revoked = FALSE`,
		expiresAt, lastUsed, id)
	return err
}

// RevokeClientSessionByTokenHash marks a session as revoked.
func (pg *PostgresDB) RevokeClientSessionByTokenHash(tokenHash string) error {
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE client_sessions SET revoked = TRUE WHERE token_hash = $1`, tokenHash)
	return err
}

// RevokeClientSessionsForDevice revokes prior sessions for the same user + client device.
func (pg *PostgresDB) RevokeClientSessionsForDevice(userID int64, clientID, clientUUID string) error {
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE client_sessions SET revoked = TRUE
		 WHERE user_id = $1 AND client_id = $2 AND client_uuid = $3 AND revoked = FALSE`,
		userID, clientID, clientUUID)
	return err
}

// CleanupExpiredClientSessions deletes expired or old revoked sessions.
func (pg *PostgresDB) CleanupExpiredClientSessions() (int64, error) {
	cutoff := time.Now().UTC().Add(-7 * 24 * time.Hour)
	tag, err := pg.pool.Exec(pg.ctx,
		`DELETE FROM client_sessions
		 WHERE expires_at < NOW()
		    OR (revoked = TRUE AND COALESCE(last_used, created_at) < $1)`, cutoff)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// DropClientSessionsTableForTest removes client_sessions so tests can verify
// EnsureClientSessionsSchema / login recovery (#284).
func DropClientSessionsTableForTest(database Database) error {
	switch d := database.(type) {
	case *SQLiteDB:
		d.mu.Lock()
		defer d.mu.Unlock()
		_, err := d.db.Exec(`DROP TABLE IF EXISTS client_sessions`)
		return err
	case *PostgresDB:
		_, err := d.pool.Exec(d.ctx, `DROP TABLE IF EXISTS client_sessions`)
		return err
	default:
		return fmt.Errorf("db: DropClientSessionsTableForTest: unsupported database type %T", database)
	}
}
