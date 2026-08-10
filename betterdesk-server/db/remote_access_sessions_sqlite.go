package db

import (
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// UpsertRemoteAccessSession starts an actual remote session idempotently.
// Duplicate client audit posts update attribution but never reset the start.
func (s *SQLiteDB) UpsertRemoteAccessSession(session *RemoteAccessSession) error {
	if session == nil || session.SessionKey == "" || session.TargetID == "" || session.StartedAt.IsZero() {
		return nil
	}
	lastSeen := session.LastSeenAt
	if lastSeen.IsZero() {
		lastSeen = session.StartedAt
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`
		INSERT INTO remote_access_sessions
			(session_key, target_id, target_uuid, operator_username, controller_id,
			 controller_name, connection_type, source, started_at, last_seen_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_key) DO UPDATE SET
			target_id = excluded.target_id,
			target_uuid = CASE WHEN excluded.target_uuid != '' THEN excluded.target_uuid ELSE remote_access_sessions.target_uuid END,
			operator_username = CASE WHEN excluded.operator_username != '' THEN excluded.operator_username ELSE remote_access_sessions.operator_username END,
			controller_id = CASE WHEN excluded.controller_id != '' THEN excluded.controller_id ELSE remote_access_sessions.controller_id END,
			controller_name = CASE WHEN excluded.controller_name != '' THEN excluded.controller_name ELSE remote_access_sessions.controller_name END,
			connection_type = excluded.connection_type,
			last_seen_at = CASE WHEN remote_access_sessions.last_seen_at < excluded.last_seen_at THEN excluded.last_seen_at ELSE remote_access_sessions.last_seen_at END,
			updated_at = datetime('now')`,
		session.SessionKey, session.TargetID, session.TargetUUID, session.OperatorUsername,
		session.ControllerID, session.ControllerName, session.ConnectionType,
		defaultRemoteSessionSource(session.Source), activityTimeString(session.StartedAt), activityTimeString(lastSeen))
	if err != nil {
		return fmt.Errorf("db: UpsertRemoteAccessSession(%q): %w", session.SessionKey, err)
	}
	return nil
}

func defaultRemoteSessionSource(source string) string {
	if strings.TrimSpace(source) == "" {
		return "rustdesk_audit"
	}
	return source
}

func (s *SQLiteDB) TouchRemoteAccessSession(sessionKey string, observedAt time.Time) error {
	if sessionKey == "" || observedAt.IsZero() {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	stamp := activityTimeString(observedAt)
	_, err := s.db.Exec(`UPDATE remote_access_sessions
		SET last_seen_at = CASE WHEN last_seen_at < ? THEN ? ELSE last_seen_at END,
		    updated_at = datetime('now')
		WHERE session_key = ? AND ended_at IS NULL`, stamp, stamp, sessionKey)
	return err
}

func (s *SQLiteDB) EndRemoteAccessSession(sessionKey string, endedAt time.Time, reason string) error {
	if sessionKey == "" || endedAt.IsZero() {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	stamp := activityTimeString(endedAt)
	_, err := s.db.Exec(`UPDATE remote_access_sessions
		SET ended_at = CASE WHEN ? < started_at THEN started_at ELSE ? END,
		    last_seen_at = CASE WHEN last_seen_at < ? THEN ? ELSE last_seen_at END,
		    end_reason = ?, updated_at = datetime('now')
		WHERE session_key = ? AND ended_at IS NULL`, stamp, stamp, stamp, stamp, reason, sessionKey)
	if err != nil {
		return fmt.Errorf("db: EndRemoteAccessSession(%q): %w", sessionKey, err)
	}
	return nil
}

func (s *SQLiteDB) CloseStaleWebRemoteAccessSessions(staleBefore time.Time, grace time.Duration) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`SELECT id, started_at, last_seen_at FROM remote_access_sessions
		WHERE source = 'web_console' AND ended_at IS NULL AND last_seen_at < ?`, activityTimeString(staleBefore))
	if err != nil {
		return 0, err
	}
	type staleSession struct {
		id                int64
		started, lastSeen time.Time
	}
	var stale []staleSession
	for rows.Next() {
		var id int64
		var startedRaw, lastSeenRaw string
		if err := rows.Scan(&id, &startedRaw, &lastSeenRaw); err != nil {
			rows.Close()
			return 0, err
		}
		started, err := parseActivityTime(startedRaw)
		if err != nil {
			rows.Close()
			return 0, err
		}
		lastSeen, err := parseActivityTime(lastSeenRaw)
		if err != nil {
			rows.Close()
			return 0, err
		}
		stale = append(stale, staleSession{id: id, started: started, lastSeen: lastSeen})
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	for _, session := range stale {
		ended := session.lastSeen.Add(grace)
		if ended.Before(session.started) {
			ended = session.started
		}
		if _, err := s.db.Exec(`UPDATE remote_access_sessions SET ended_at = ?, end_reason = 'heartbeat_timeout', updated_at = datetime('now') WHERE id = ? AND ended_at IS NULL`, activityTimeString(ended), session.id); err != nil {
			return 0, err
		}
	}
	return int64(len(stale)), nil
}

func (s *SQLiteDB) ListRemoteAccessSessions(filter RemoteAccessSessionFilter) ([]*RemoteAccessSession, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	query := `SELECT id, session_key, target_id, target_uuid, operator_username,
		controller_id, controller_name, connection_type, source, started_at,
		last_seen_at, ended_at, end_reason, created_at, updated_at
		FROM remote_access_sessions
		WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?)`
	args := []any{activityTimeString(filter.To), activityTimeString(filter.From)}
	if len(filter.TargetIDs) > 0 {
		query += ` AND target_id IN (` + sqlitePlaceholders(len(filter.TargetIDs)) + `)`
		for _, id := range filter.TargetIDs {
			args = append(args, id)
		}
	}
	if len(filter.Operators) > 0 {
		query += ` AND operator_username IN (` + sqlitePlaceholders(len(filter.Operators)) + `)`
		for _, operator := range filter.Operators {
			args = append(args, operator)
		}
	}
	query += ` ORDER BY operator_username, target_id, started_at`
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("db: ListRemoteAccessSessions: %w", err)
	}
	defer rows.Close()
	var sessions []*RemoteAccessSession
	for rows.Next() {
		session, err := scanSQLiteRemoteAccessSession(rows)
		if err != nil {
			return nil, err
		}
		sessions = append(sessions, session)
	}
	return sessions, rows.Err()
}

func (s *SQLiteDB) GetOpenRemoteAccessSessions(targetIDs []string) (map[string][]*RemoteAccessSession, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	query := `SELECT id, session_key, target_id, target_uuid, operator_username,
		controller_id, controller_name, connection_type, source, started_at,
		last_seen_at, ended_at, end_reason, created_at, updated_at
		FROM remote_access_sessions WHERE ended_at IS NULL`
	args := make([]any, 0, len(targetIDs))
	if len(targetIDs) > 0 {
		query += ` AND target_id IN (` + sqlitePlaceholders(len(targetIDs)) + `)`
		for _, id := range targetIDs {
			args = append(args, id)
		}
	}
	query += ` ORDER BY started_at`
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("db: GetOpenRemoteAccessSessions: %w", err)
	}
	defer rows.Close()
	result := make(map[string][]*RemoteAccessSession)
	for rows.Next() {
		session, err := scanSQLiteRemoteAccessSession(rows)
		if err != nil {
			return nil, err
		}
		result[session.TargetID] = append(result[session.TargetID], session)
	}
	return result, rows.Err()
}

func (s *SQLiteDB) FindActiveClientUsernameByDevice(clientID string) (string, error) {
	if clientID == "" {
		return "", nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	var username string
	err := s.db.QueryRow(`SELECT u.username
		FROM client_sessions cs JOIN users u ON u.id = cs.user_id
		WHERE cs.client_id = ? AND cs.revoked = 0
		  AND julianday(cs.expires_at) > julianday('now')
		ORDER BY julianday(COALESCE(cs.last_used, cs.created_at)) DESC LIMIT 1`, clientID).Scan(&username)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return username, err
}

func sqlitePlaceholders(count int) string {
	return strings.TrimSuffix(strings.Repeat("?,", count), ",")
}

type sqliteRemoteSessionScanner interface {
	Scan(dest ...any) error
}

func scanSQLiteRemoteAccessSession(row sqliteRemoteSessionScanner) (*RemoteAccessSession, error) {
	session := &RemoteAccessSession{}
	var startedRaw, lastSeenRaw, createdRaw, updatedRaw string
	var endedRaw sql.NullString
	if err := row.Scan(&session.ID, &session.SessionKey, &session.TargetID, &session.TargetUUID,
		&session.OperatorUsername, &session.ControllerID, &session.ControllerName,
		&session.ConnectionType, &session.Source, &startedRaw, &lastSeenRaw, &endedRaw,
		&session.EndReason, &createdRaw, &updatedRaw); err != nil {
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
		ended, parseErr := parseActivityTime(endedRaw.String)
		if parseErr != nil {
			return nil, parseErr
		}
		session.EndedAt = &ended
	}
	if session.CreatedAt, err = parseActivityTime(createdRaw); err != nil {
		return nil, err
	}
	if session.UpdatedAt, err = parseActivityTime(updatedRaw); err != nil {
		return nil, err
	}
	return session, nil
}
