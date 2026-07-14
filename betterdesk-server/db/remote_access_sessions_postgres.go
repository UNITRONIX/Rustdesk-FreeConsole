package db

import (
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

func (pg *PostgresDB) UpsertRemoteAccessSession(session *RemoteAccessSession) error {
	if session == nil || session.SessionKey == "" || session.TargetID == "" || session.StartedAt.IsZero() {
		return nil
	}
	lastSeen := session.LastSeenAt
	if lastSeen.IsZero() {
		lastSeen = session.StartedAt
	}
	ctx, cancel := pg.opCtx()
	defer cancel()
	_, err := pg.pool.Exec(ctx, `INSERT INTO remote_access_sessions
		(session_key, target_id, target_uuid, operator_username, controller_id,
		 controller_name, connection_type, source, started_at, last_seen_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		ON CONFLICT (session_key) DO UPDATE SET
			target_id = EXCLUDED.target_id,
			target_uuid = CASE WHEN EXCLUDED.target_uuid != '' THEN EXCLUDED.target_uuid ELSE remote_access_sessions.target_uuid END,
			operator_username = CASE WHEN EXCLUDED.operator_username != '' THEN EXCLUDED.operator_username ELSE remote_access_sessions.operator_username END,
			controller_id = CASE WHEN EXCLUDED.controller_id != '' THEN EXCLUDED.controller_id ELSE remote_access_sessions.controller_id END,
			controller_name = CASE WHEN EXCLUDED.controller_name != '' THEN EXCLUDED.controller_name ELSE remote_access_sessions.controller_name END,
			connection_type = EXCLUDED.connection_type,
			last_seen_at = GREATEST(remote_access_sessions.last_seen_at, EXCLUDED.last_seen_at),
			updated_at = NOW()`, session.SessionKey, session.TargetID, session.TargetUUID,
		session.OperatorUsername, session.ControllerID, session.ControllerName,
		session.ConnectionType, defaultRemoteSessionSource(session.Source), session.StartedAt.UTC(), lastSeen.UTC())
	if err != nil {
		return fmt.Errorf("db: UpsertRemoteAccessSession(%q): %w", session.SessionKey, err)
	}
	return nil
}

func (pg *PostgresDB) TouchRemoteAccessSession(sessionKey string, observedAt time.Time) error {
	if sessionKey == "" || observedAt.IsZero() {
		return nil
	}
	ctx, cancel := pg.opCtx()
	defer cancel()
	_, err := pg.pool.Exec(ctx, `UPDATE remote_access_sessions
		SET last_seen_at = GREATEST(last_seen_at, $2), updated_at = NOW()
		WHERE session_key = $1 AND ended_at IS NULL`, sessionKey, observedAt.UTC())
	return err
}

func (pg *PostgresDB) EndRemoteAccessSession(sessionKey string, endedAt time.Time, reason string) error {
	if sessionKey == "" || endedAt.IsZero() {
		return nil
	}
	ctx, cancel := pg.opCtx()
	defer cancel()
	_, err := pg.pool.Exec(ctx, `UPDATE remote_access_sessions
		SET ended_at = GREATEST(started_at, $2), last_seen_at = GREATEST(last_seen_at, $2),
		    end_reason = $3, updated_at = NOW()
		WHERE session_key = $1 AND ended_at IS NULL`, sessionKey, endedAt.UTC(), reason)
	if err != nil {
		return fmt.Errorf("db: EndRemoteAccessSession(%q): %w", sessionKey, err)
	}
	return nil
}

func (pg *PostgresDB) CloseStaleWebRemoteAccessSessions(staleBefore time.Time, grace time.Duration) (int64, error) {
	ctx, cancel := pg.opCtx()
	defer cancel()
	tag, err := pg.pool.Exec(ctx, `UPDATE remote_access_sessions
		SET ended_at = GREATEST(started_at, last_seen_at + $2 * INTERVAL '1 second'),
		    end_reason = 'heartbeat_timeout', updated_at = NOW()
		WHERE source = 'web_console' AND ended_at IS NULL AND last_seen_at < $1`,
		staleBefore.UTC(), grace.Seconds())
	if err != nil {
		return 0, fmt.Errorf("db: CloseStaleWebRemoteAccessSessions: %w", err)
	}
	return tag.RowsAffected(), nil
}

func (pg *PostgresDB) ListRemoteAccessSessions(filter RemoteAccessSessionFilter) ([]*RemoteAccessSession, error) {
	ctx, cancel := pg.opCtx()
	defer cancel()
	query := `SELECT id, session_key, target_id, target_uuid, operator_username,
		controller_id, controller_name, connection_type, source, started_at,
		last_seen_at, ended_at, end_reason, created_at, updated_at
		FROM remote_access_sessions
		WHERE started_at < $1 AND (ended_at IS NULL OR ended_at > $2)`
	args := []any{filter.To.UTC(), filter.From.UTC()}
	n := 3
	if len(filter.TargetIDs) > 0 {
		query += fmt.Sprintf(" AND target_id = ANY($%d)", n)
		args = append(args, filter.TargetIDs)
		n++
	}
	if len(filter.Operators) > 0 {
		query += fmt.Sprintf(" AND operator_username = ANY($%d)", n)
		args = append(args, filter.Operators)
	}
	query += ` ORDER BY operator_username, target_id, started_at`
	rows, err := pg.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("db: ListRemoteAccessSessions: %w", err)
	}
	defer rows.Close()
	var sessions []*RemoteAccessSession
	for rows.Next() {
		session, err := scanPostgresRemoteAccessSession(rows)
		if err != nil {
			return nil, err
		}
		sessions = append(sessions, session)
	}
	return sessions, rows.Err()
}

func (pg *PostgresDB) GetOpenRemoteAccessSessions(targetIDs []string) (map[string][]*RemoteAccessSession, error) {
	ctx, cancel := pg.opCtx()
	defer cancel()
	query := `SELECT id, session_key, target_id, target_uuid, operator_username,
		controller_id, controller_name, connection_type, source, started_at,
		last_seen_at, ended_at, end_reason, created_at, updated_at
		FROM remote_access_sessions WHERE ended_at IS NULL`
	args := []any{}
	if len(targetIDs) > 0 {
		query += ` AND target_id = ANY($1)`
		args = append(args, targetIDs)
	}
	query += ` ORDER BY started_at`
	rows, err := pg.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("db: GetOpenRemoteAccessSessions: %w", err)
	}
	defer rows.Close()
	result := make(map[string][]*RemoteAccessSession)
	for rows.Next() {
		session, err := scanPostgresRemoteAccessSession(rows)
		if err != nil {
			return nil, err
		}
		result[session.TargetID] = append(result[session.TargetID], session)
	}
	return result, rows.Err()
}

func (pg *PostgresDB) FindActiveClientUsernameByDevice(clientID string) (string, error) {
	if clientID == "" {
		return "", nil
	}
	ctx, cancel := pg.opCtx()
	defer cancel()
	var username string
	err := pg.pool.QueryRow(ctx, `SELECT u.username
		FROM client_sessions cs JOIN users u ON u.id = cs.user_id
		WHERE cs.client_id = $1 AND cs.revoked = FALSE AND cs.expires_at > NOW()
		ORDER BY COALESCE(cs.last_used, cs.created_at) DESC LIMIT 1`, clientID).Scan(&username)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	return username, err
}

type postgresRemoteSessionScanner interface {
	Scan(dest ...any) error
}

func scanPostgresRemoteAccessSession(row postgresRemoteSessionScanner) (*RemoteAccessSession, error) {
	session := &RemoteAccessSession{}
	err := row.Scan(&session.ID, &session.SessionKey, &session.TargetID, &session.TargetUUID,
		&session.OperatorUsername, &session.ControllerID, &session.ControllerName,
		&session.ConnectionType, &session.Source, &session.StartedAt, &session.LastSeenAt,
		&session.EndedAt, &session.EndReason, &session.CreatedAt, &session.UpdatedAt)
	return session, err
}
