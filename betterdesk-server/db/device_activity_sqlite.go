package db

import (
	"database/sql"
	"fmt"
	"strings"
	"time"
)

type sqliteActivityExecer interface {
	Exec(query string, args ...any) (sql.Result, error)
	QueryRow(query string, args ...any) *sql.Row
}

func activityTimeString(t time.Time) string {
	return t.UTC().Format(time.RFC3339Nano)
}

func parseActivityTime(value string) (time.Time, error) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05.999999999", "2006-01-02 15:04:05"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("db: invalid device activity timestamp %q", value)
}

func touchDeviceOnlineSessionSQLite(exec sqliteActivityExecer, peerID string, observedAt time.Time, maxGap time.Duration) error {
	stamp := activityTimeString(observedAt)
	if maxGap > 0 {
		var startedRaw, lastSeenRaw string
		err := exec.QueryRow(`
			SELECT started_at, last_seen_at
			FROM device_online_sessions
			WHERE peer_id = ? AND ended_at IS NULL`, peerID).Scan(&startedRaw, &lastSeenRaw)
		if err != nil && err != sql.ErrNoRows {
			return err
		}
		if err == nil {
			startedAt, parseErr := parseActivityTime(startedRaw)
			if parseErr != nil {
				return parseErr
			}
			lastSeen, parseErr := parseActivityTime(lastSeenRaw)
			if parseErr != nil {
				return parseErr
			}
			if observedAt.Sub(lastSeen) > maxGap {
				endedAt := lastSeen.Add(maxGap)
				if endedAt.Before(startedAt) {
					endedAt = startedAt
				}
				if err := closeDeviceOnlineSessionSQLite(exec, peerID, endedAt, "heartbeat_gap"); err != nil {
					return err
				}
			}
		}
	}
	result, err := exec.Exec(`
		UPDATE device_online_sessions
		SET last_seen_at = CASE WHEN last_seen_at < ? THEN ? ELSE last_seen_at END
		WHERE peer_id = ? AND ended_at IS NULL`, stamp, stamp, peerID)
	if err != nil {
		return err
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if updated > 0 {
		return nil
	}
	_, err = exec.Exec(`
		INSERT INTO device_online_sessions (peer_id, started_at, last_seen_at)
		VALUES (?, ?, ?)`, peerID, stamp, stamp)
	return err
}

func closeDeviceOnlineSessionSQLite(exec sqliteActivityExecer, peerID string, endedAt time.Time, reason string) error {
	stamp := activityTimeString(endedAt)
	_, err := exec.Exec(`
		UPDATE device_online_sessions
		SET ended_at = CASE WHEN ? < started_at THEN started_at ELSE ? END,
		    last_seen_at = CASE WHEN last_seen_at > ? THEN ? ELSE last_seen_at END,
		    end_reason = ?
		WHERE peer_id = ? AND ended_at IS NULL`, stamp, stamp, stamp, stamp, reason, peerID)
	return err
}

// TouchDeviceOnlineSession opens a presence interval or advances its last
// heartbeat. SQLite writes are serialized by the database mutex.
func (s *SQLiteDB) TouchDeviceOnlineSession(peerID string, observedAt time.Time, maxGap time.Duration) error {
	if peerID == "" || observedAt.IsZero() {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := touchDeviceOnlineSessionSQLite(s.db, peerID, observedAt, maxGap); err != nil {
		return fmt.Errorf("db: TouchDeviceOnlineSession(%q): %w", peerID, err)
	}
	return nil
}

// CloseDeviceOnlineSession closes the current presence interval, if any.
func (s *SQLiteDB) CloseDeviceOnlineSession(peerID string, endedAt time.Time, reason string) error {
	if peerID == "" || endedAt.IsZero() {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	err := closeDeviceOnlineSessionSQLite(s.db, peerID, endedAt, reason)
	if err != nil {
		return fmt.Errorf("db: CloseDeviceOnlineSession(%q): %w", peerID, err)
	}
	return nil
}

// CloseStaleDeviceOnlineSessions closes intervals whose heartbeat has not
// advanced before staleBefore. Their end is last_seen_at + grace, matching the
// server's online timeout rather than the cleanup job's wall-clock delay.
func (s *SQLiteDB) CloseStaleDeviceOnlineSessions(staleBefore time.Time, grace time.Duration, reason string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	rows, err := tx.Query(`
		SELECT id, started_at, last_seen_at
		FROM device_online_sessions
		WHERE ended_at IS NULL AND last_seen_at < ?`, activityTimeString(staleBefore))
	if err != nil {
		return 0, err
	}
	type staleSession struct {
		id        int64
		startedAt time.Time
		lastSeen  time.Time
	}
	var stale []staleSession
	for rows.Next() {
		var id int64
		var startedRaw, lastSeenRaw string
		if err := rows.Scan(&id, &startedRaw, &lastSeenRaw); err != nil {
			rows.Close()
			return 0, err
		}
		startedAt, err := parseActivityTime(startedRaw)
		if err != nil {
			rows.Close()
			return 0, err
		}
		lastSeen, err := parseActivityTime(lastSeenRaw)
		if err != nil {
			rows.Close()
			return 0, err
		}
		stale = append(stale, staleSession{id: id, startedAt: startedAt, lastSeen: lastSeen})
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}

	for _, session := range stale {
		endedAt := session.lastSeen.Add(grace)
		if endedAt.Before(session.startedAt) {
			endedAt = session.startedAt
		}
		if _, err := tx.Exec(`
			UPDATE device_online_sessions
			SET ended_at = ?, end_reason = ?
			WHERE id = ? AND ended_at IS NULL`, activityTimeString(endedAt), reason, session.id); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return int64(len(stale)), nil
}

// ListDeviceOnlineSessions returns all intervals overlapping [From, To).
func (s *SQLiteDB) ListDeviceOnlineSessions(filter DeviceOnlineSessionFilter) ([]*DeviceOnlineSession, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	query := `
		SELECT id, peer_id, started_at, last_seen_at, ended_at, end_reason
		FROM device_online_sessions
		WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?)`
	args := []any{activityTimeString(filter.To), activityTimeString(filter.From)}
	if len(filter.PeerIDs) > 0 {
		placeholders := make([]string, len(filter.PeerIDs))
		for i, id := range filter.PeerIDs {
			placeholders[i] = "?"
			args = append(args, id)
		}
		query += ` AND peer_id IN (` + strings.Join(placeholders, ",") + `)`
	}
	query += ` ORDER BY peer_id, started_at`

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("db: ListDeviceOnlineSessions: %w", err)
	}
	defer rows.Close()

	var sessions []*DeviceOnlineSession
	for rows.Next() {
		session, err := scanSQLiteDeviceOnlineSession(rows)
		if err != nil {
			return nil, err
		}
		sessions = append(sessions, session)
	}
	return sessions, rows.Err()
}

// GetOpenDeviceOnlineSessions returns the currently open interval per device.
func (s *SQLiteDB) GetOpenDeviceOnlineSessions(peerIDs []string) (map[string]*DeviceOnlineSession, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	query := `
		SELECT id, peer_id, started_at, last_seen_at, ended_at, end_reason
		FROM device_online_sessions WHERE ended_at IS NULL`
	args := make([]any, 0, len(peerIDs))
	if len(peerIDs) > 0 {
		placeholders := make([]string, len(peerIDs))
		for i, id := range peerIDs {
			placeholders[i] = "?"
			args = append(args, id)
		}
		query += ` AND peer_id IN (` + strings.Join(placeholders, ",") + `)`
	}
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("db: GetOpenDeviceOnlineSessions: %w", err)
	}
	defer rows.Close()

	result := make(map[string]*DeviceOnlineSession)
	for rows.Next() {
		session, err := scanSQLiteDeviceOnlineSession(rows)
		if err != nil {
			return nil, err
		}
		result[session.PeerID] = session
	}
	return result, rows.Err()
}

type sqliteActivityScanner interface {
	Scan(dest ...any) error
}

func scanSQLiteDeviceOnlineSession(row sqliteActivityScanner) (*DeviceOnlineSession, error) {
	session := &DeviceOnlineSession{}
	var startedRaw, lastSeenRaw string
	var endedRaw sql.NullString
	if err := row.Scan(&session.ID, &session.PeerID, &startedRaw, &lastSeenRaw, &endedRaw, &session.EndReason); err != nil {
		return nil, err
	}
	var err error
	if session.StartedAt, err = parseActivityTime(startedRaw); err != nil {
		return nil, err
	}
	if session.LastSeenAt, err = parseActivityTime(lastSeenRaw); err != nil {
		return nil, err
	}
	if endedRaw.Valid && endedRaw.String != "" {
		endedAt, err := parseActivityTime(endedRaw.String)
		if err != nil {
			return nil, err
		}
		session.EndedAt = &endedAt
	}
	return session, nil
}
