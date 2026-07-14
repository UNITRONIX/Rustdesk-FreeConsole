package db

import (
	"fmt"
	"time"
)

// TouchDeviceOnlineSession opens a presence interval or advances its last
// heartbeat. The partial unique index makes concurrent heartbeats idempotent.
func (pg *PostgresDB) TouchDeviceOnlineSession(peerID string, observedAt time.Time, maxGap time.Duration) error {
	if peerID == "" || observedAt.IsZero() {
		return nil
	}
	ctx, cancel := pg.opCtx()
	defer cancel()
	tx, err := pg.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if maxGap > 0 {
		if _, err := tx.Exec(ctx, `
			UPDATE device_online_sessions
			SET ended_at = GREATEST(started_at, last_seen_at + $3 * INTERVAL '1 second'),
			    end_reason = 'heartbeat_gap'
			WHERE peer_id = $1 AND ended_at IS NULL AND last_seen_at < $2`,
			peerID, observedAt.UTC().Add(-maxGap), maxGap.Seconds()); err != nil {
			return err
		}
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO device_online_sessions (peer_id, started_at, last_seen_at)
		VALUES ($1, $2, $2)
		ON CONFLICT (peer_id) WHERE ended_at IS NULL
		DO UPDATE SET last_seen_at = GREATEST(device_online_sessions.last_seen_at, EXCLUDED.last_seen_at)`,
		peerID, observedAt.UTC())
	if err != nil {
		return fmt.Errorf("db: TouchDeviceOnlineSession(%q): %w", peerID, err)
	}
	return tx.Commit(ctx)
}

// CloseDeviceOnlineSession closes the current presence interval, if any.
func (pg *PostgresDB) CloseDeviceOnlineSession(peerID string, endedAt time.Time, reason string) error {
	if peerID == "" || endedAt.IsZero() {
		return nil
	}
	ctx, cancel := pg.opCtx()
	defer cancel()
	_, err := pg.pool.Exec(ctx, `
		UPDATE device_online_sessions
		SET ended_at = GREATEST(started_at, $2),
		    last_seen_at = LEAST(last_seen_at, $2),
		    end_reason = $3
		WHERE peer_id = $1 AND ended_at IS NULL`, peerID, endedAt.UTC(), reason)
	if err != nil {
		return fmt.Errorf("db: CloseDeviceOnlineSession(%q): %w", peerID, err)
	}
	return nil
}

// CloseStaleDeviceOnlineSessions closes intervals at last_seen_at + grace.
func (pg *PostgresDB) CloseStaleDeviceOnlineSessions(staleBefore time.Time, grace time.Duration, reason string) (int64, error) {
	ctx, cancel := pg.opCtx()
	defer cancel()
	tag, err := pg.pool.Exec(ctx, `
		UPDATE device_online_sessions
		SET ended_at = GREATEST(started_at, last_seen_at + $2 * INTERVAL '1 second'),
		    end_reason = $3
		WHERE ended_at IS NULL AND last_seen_at < $1`,
		staleBefore.UTC(), grace.Seconds(), reason)
	if err != nil {
		return 0, fmt.Errorf("db: CloseStaleDeviceOnlineSessions: %w", err)
	}
	return tag.RowsAffected(), nil
}

// ListDeviceOnlineSessions returns all intervals overlapping [From, To).
func (pg *PostgresDB) ListDeviceOnlineSessions(filter DeviceOnlineSessionFilter) ([]*DeviceOnlineSession, error) {
	ctx, cancel := pg.opCtx()
	defer cancel()
	query := `
		SELECT id, peer_id, started_at, last_seen_at, ended_at, end_reason
		FROM device_online_sessions
		WHERE started_at < $1 AND (ended_at IS NULL OR ended_at > $2)`
	args := []any{filter.To.UTC(), filter.From.UTC()}
	if len(filter.PeerIDs) > 0 {
		query += ` AND peer_id = ANY($3)`
		args = append(args, filter.PeerIDs)
	}
	query += ` ORDER BY peer_id, started_at`
	rows, err := pg.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("db: ListDeviceOnlineSessions: %w", err)
	}
	defer rows.Close()

	var sessions []*DeviceOnlineSession
	for rows.Next() {
		session := &DeviceOnlineSession{}
		if err := rows.Scan(&session.ID, &session.PeerID, &session.StartedAt, &session.LastSeenAt, &session.EndedAt, &session.EndReason); err != nil {
			return nil, err
		}
		sessions = append(sessions, session)
	}
	return sessions, rows.Err()
}

// GetOpenDeviceOnlineSessions returns the currently open interval per device.
func (pg *PostgresDB) GetOpenDeviceOnlineSessions(peerIDs []string) (map[string]*DeviceOnlineSession, error) {
	ctx, cancel := pg.opCtx()
	defer cancel()
	query := `
		SELECT id, peer_id, started_at, last_seen_at, ended_at, end_reason
		FROM device_online_sessions WHERE ended_at IS NULL`
	args := []any{}
	if len(peerIDs) > 0 {
		query += ` AND peer_id = ANY($1)`
		args = append(args, peerIDs)
	}
	rows, err := pg.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("db: GetOpenDeviceOnlineSessions: %w", err)
	}
	defer rows.Close()
	result := make(map[string]*DeviceOnlineSession)
	for rows.Next() {
		session := &DeviceOnlineSession{}
		if err := rows.Scan(&session.ID, &session.PeerID, &session.StartedAt, &session.LastSeenAt, &session.EndedAt, &session.EndReason); err != nil {
			return nil, err
		}
		result[session.PeerID] = session
	}
	return result, rows.Err()
}
