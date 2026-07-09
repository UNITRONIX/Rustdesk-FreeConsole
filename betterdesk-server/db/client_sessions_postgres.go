package db

import (
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

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
