package db

import (
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// CreateClientSession inserts a new RustDesk client session.
func (s *SQLiteDB) CreateClientSession(sess *ClientSession) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	res, err := s.db.Exec(`INSERT INTO client_sessions
		(token_hash, user_id, client_id, client_uuid, expires_at, last_used, created_at, revoked, ip_address)
		VALUES (?, ?, ?, ?, ?, COALESCE(NULLIF(?, ''), datetime('now')), datetime('now'), 0, ?)`,
		sess.TokenHash, sess.UserID, sess.ClientID, sess.ClientUUID,
		sess.ExpiresAt, sess.LastUsed, sess.IPAddress)
	if err != nil {
		return fmt.Errorf("db: CreateClientSession: %w", err)
	}
	sess.ID, _ = res.LastInsertId()
	return nil
}

// GetClientSessionByTokenHash returns an active (non-revoked, non-expired) session or nil.
func (s *SQLiteDB) GetClientSessionByTokenHash(tokenHash string) (*ClientSession, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	sess := &ClientSession{}
	var revoked int
	err := s.db.QueryRow(`SELECT id, token_hash, user_id, client_id, client_uuid, expires_at,
		last_used, created_at, revoked, ip_address
		FROM client_sessions
		WHERE token_hash = ? AND revoked = 0 AND expires_at > datetime('now')`,
		tokenHash).Scan(
		&sess.ID, &sess.TokenHash, &sess.UserID, &sess.ClientID, &sess.ClientUUID,
		&sess.ExpiresAt, &sess.LastUsed, &sess.CreatedAt, &revoked, &sess.IPAddress)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	sess.Revoked = revoked != 0
	return sess, nil
}

// GetActiveClientSessionByClient returns the newest active session for a RustDesk
// client id and/or uuid, or nil when none match.
func (s *SQLiteDB) GetActiveClientSessionByClient(clientID, clientUUID string) (*ClientSession, error) {
	clientID = strings.TrimSpace(clientID)
	clientUUID = strings.TrimSpace(clientUUID)
	if clientID == "" && clientUUID == "" {
		return nil, nil
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	sess := &ClientSession{}
	var revoked int
	err := s.db.QueryRow(`SELECT id, token_hash, user_id, client_id, client_uuid, expires_at,
		last_used, created_at, revoked, ip_address
		FROM client_sessions
		WHERE revoked = 0 AND expires_at > datetime('now')
		  AND (
		    (? != '' AND client_id = ?)
		    OR (? != '' AND client_uuid = ?)
		  )
		ORDER BY COALESCE(last_used, created_at) DESC, id DESC
		LIMIT 1`,
		clientID, clientID, clientUUID, clientUUID).Scan(
		&sess.ID, &sess.TokenHash, &sess.UserID, &sess.ClientID, &sess.ClientUUID,
		&sess.ExpiresAt, &sess.LastUsed, &sess.CreatedAt, &revoked, &sess.IPAddress)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	sess.Revoked = revoked != 0
	return sess, nil
}

// TouchClientSession updates expiry and last_used for sliding session renewal.
func (s *SQLiteDB) TouchClientSession(id int64, expiresAt, lastUsed string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE client_sessions SET expires_at = ?, last_used = ? WHERE id = ? AND revoked = 0`,
		expiresAt, lastUsed, id)
	return err
}

// RevokeClientSessionByTokenHash marks a session as revoked.
func (s *SQLiteDB) RevokeClientSessionByTokenHash(tokenHash string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE client_sessions SET revoked = 1 WHERE token_hash = ?`, tokenHash)
	return err
}

// RevokeClientSessionsForDevice revokes prior sessions for the same user + client device.
func (s *SQLiteDB) RevokeClientSessionsForDevice(userID int64, clientID, clientUUID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE client_sessions SET revoked = 1
		WHERE user_id = ? AND client_id = ? AND client_uuid = ? AND revoked = 0`,
		userID, clientID, clientUUID)
	return err
}

// CleanupExpiredClientSessions deletes expired or revoked sessions older than 7 days.
func (s *SQLiteDB) CleanupExpiredClientSessions() (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := time.Now().UTC().Add(-7 * 24 * time.Hour).Format("2006-01-02 15:04:05")
	res, err := s.db.Exec(`DELETE FROM client_sessions
		WHERE expires_at < datetime('now')
		   OR (revoked = 1 AND COALESCE(last_used, created_at) < ?)`, cutoff)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
