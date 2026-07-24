package db

import (
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (pg *PostgresDB) AssignStrategy(strategyGUID string, peerKeys, userKeys, groupKeys []string) error {
	strategyGUID = strings.TrimSpace(strategyGUID)
	if strategyGUID != "" {
		st, err := pg.GetStrategy(strategyGUID)
		if err != nil {
			return err
		}
		if st == nil {
			return fmt.Errorf("strategy not found")
		}
	}

	tx, err := pg.pool.Begin(pg.ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(pg.ctx)

	upsert := func(targetType string, keys []string) error {
		for _, raw := range keys {
			key := strings.TrimSpace(raw)
			if key == "" {
				continue
			}
			if strategyGUID == "" {
				if _, err := tx.Exec(pg.ctx,
					`DELETE FROM strategy_assignments WHERE target_type = $1 AND target_key = $2`,
					targetType, key,
				); err != nil {
					return err
				}
				continue
			}
			_, err := tx.Exec(pg.ctx, `
				INSERT INTO strategy_assignments (target_type, target_key, strategy_guid, updated_at)
				VALUES ($1, $2, $3, NOW())
				ON CONFLICT (target_type, target_key) DO UPDATE SET
					strategy_guid = EXCLUDED.strategy_guid,
					updated_at = EXCLUDED.updated_at`,
				targetType, key, strategyGUID,
			)
			if err != nil {
				return err
			}
		}
		return nil
	}

	if err := upsert(StrategyTargetPeer, peerKeys); err != nil {
		return err
	}
	if err := upsert(StrategyTargetUser, userKeys); err != nil {
		return err
	}
	if err := upsert(StrategyTargetDeviceGroup, groupKeys); err != nil {
		return err
	}
	return tx.Commit(pg.ctx)
}

func (pg *PostgresDB) GetStrategyAssignmentSummary(strategyGUID string) (*StrategyAssignmentSummary, error) {
	rows, err := pg.pool.Query(pg.ctx, `
		SELECT target_type, target_key FROM strategy_assignments
		WHERE strategy_guid = $1 ORDER BY target_type, target_key`, strategyGUID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := &StrategyAssignmentSummary{}
	for rows.Next() {
		var targetType, key string
		if err := rows.Scan(&targetType, &key); err != nil {
			return nil, err
		}
		switch targetType {
		case StrategyTargetPeer:
			out.PeerCount++
			out.Peers = append(out.Peers, key)
		case StrategyTargetUser:
			out.UserCount++
			out.Users = append(out.Users, key)
		case StrategyTargetDeviceGroup:
			out.DeviceGroupCount++
			out.Groups = append(out.Groups, key)
		}
	}
	return out, rows.Err()
}

func (pg *PostgresDB) ResolvePeerAssignmentKey(ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return "", fmt.Errorf("empty peer reference")
	}
	var id string
	err := pg.pool.QueryRow(pg.ctx, `
		SELECT id FROM peers
		WHERE id = $1 OR guid = $1 OR uuid = $1
		LIMIT 1`, ref).Scan(&id)
	if err == pgx.ErrNoRows {
		return "", fmt.Errorf("peer not found")
	}
	if err != nil {
		return "", err
	}
	return pg.EnsurePeerGUID(id)
}

func (pg *PostgresDB) ResolveUserAssignmentKey(ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return "", fmt.Errorf("empty user reference")
	}
	var userID int64
	err := pg.pool.QueryRow(pg.ctx, `
		SELECT id FROM users
		WHERE guid = $1 OR username = $1 OR id::text = $1
		LIMIT 1`, ref).Scan(&userID)
	if err == pgx.ErrNoRows {
		return "", fmt.Errorf("user not found")
	}
	if err != nil {
		return "", err
	}
	return pg.ensureUserGUID(userID)
}

func (pg *PostgresDB) ResolveDeviceGroupAssignmentKey(ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return "", fmt.Errorf("empty device group reference")
	}
	var guid string
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT guid FROM device_groups WHERE guid = $1 OR name = $1 LIMIT 1`, ref).Scan(&guid)
	if err == pgx.ErrNoRows {
		return "", fmt.Errorf("device group not found")
	}
	return guid, err
}

func (pg *PostgresDB) GetPeerIDByGUID(guid string) (string, error) {
	guid = strings.TrimSpace(guid)
	if guid == "" {
		return "", fmt.Errorf("empty peer guid")
	}
	var id string
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT id FROM peers WHERE guid = $1 AND soft_deleted = FALSE LIMIT 1`, guid).Scan(&id)
	if err == pgx.ErrNoRows {
		return "", fmt.Errorf("peer not found")
	}
	return id, err
}

func (pg *PostgresDB) EnsurePeerGUID(id string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return "", fmt.Errorf("empty peer id")
	}

	var peerUUID, peerGUID string
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT COALESCE(uuid, ''), COALESCE(guid, '') FROM peers WHERE id = $1`, id).
		Scan(&peerUUID, &peerGUID)
	if err == pgx.ErrNoRows {
		return "", fmt.Errorf("peer not found")
	}
	if err != nil {
		return "", err
	}
	if peerGUID != "" {
		return peerGUID, nil
	}
	if isUUIDLike(peerUUID) {
		peerGUID = strings.ToLower(peerUUID)
	} else {
		peerGUID = uuid.NewString()
	}
	_, err = pg.pool.Exec(pg.ctx, `UPDATE peers SET guid = $1 WHERE id = $2`, peerGUID, id)
	return peerGUID, err
}

func (pg *PostgresDB) ensureUserGUID(userID int64) (string, error) {
	var userGUID string
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT COALESCE(guid, '') FROM users WHERE id = $1`, userID).Scan(&userGUID)
	if err != nil {
		return "", err
	}
	if userGUID != "" {
		return userGUID, nil
	}
	userGUID = uuid.NewString()
	_, err = pg.pool.Exec(pg.ctx, `UPDATE users SET guid = $1 WHERE id = $2`, userGUID, userID)
	return userGUID, err
}

func (pg *PostgresDB) SetStrategyEnabled(guid string, enabled bool) error {
	st, err := pg.GetStrategy(guid)
	if err != nil {
		return err
	}
	if st == nil {
		return fmt.Errorf("strategy not found")
	}
	st.Enabled = enabled
	st.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	return pg.UpdateStrategy(guid, st)
}

func (pg *PostgresDB) ListProDeviceRefs(idFilter string, limit, offset int) ([]ProDeviceRef, int, error) {
	idFilter = strings.TrimSpace(idFilter)
	if limit <= 0 {
		limit = 50
	}
	if limit > 1000 {
		limit = 1000
	}
	if offset < 0 {
		offset = 0
	}

	var total int
	countQuery := `SELECT COUNT(*) FROM peers WHERE soft_deleted = FALSE`
	countArgs := []any{}
	if idFilter != "" {
		countQuery += ` AND id = $1`
		countArgs = append(countArgs, idFilter)
	}
	if err := pg.pool.QueryRow(pg.ctx, countQuery, countArgs...).Scan(&total); err != nil {
		return nil, 0, err
	}

	query := `SELECT id, COALESCE(uuid, ''), COALESCE(guid, '') FROM peers WHERE soft_deleted = FALSE`
	args := []any{}
	idx := 1
	if idFilter != "" {
		query += fmt.Sprintf(` AND id = $%d`, idx)
		args = append(args, idFilter)
		idx++
	}
	query += fmt.Sprintf(` ORDER BY id LIMIT $%d OFFSET $%d`, idx, idx+1)
	args = append(args, limit, offset)

	rows, err := pg.pool.Query(pg.ctx, query, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	out := make([]ProDeviceRef, 0)
	for rows.Next() {
		var id, peerUUID, peerGUID string
		if err := rows.Scan(&id, &peerUUID, &peerGUID); err != nil {
			return nil, 0, err
		}
		if peerGUID == "" {
			if isUUIDLike(peerUUID) {
				peerGUID = strings.ToLower(peerUUID)
			} else {
				peerGUID = uuid.NewString()
			}
			if _, err := pg.pool.Exec(pg.ctx, `UPDATE peers SET guid = $1 WHERE id = $2`, peerGUID, id); err != nil {
				return nil, 0, err
			}
		}
		out = append(out, ProDeviceRef{ID: id, GUID: peerGUID})
	}
	return out, total, rows.Err()
}

func (pg *PostgresDB) backfillPeerGUIDs() error {
	rows, err := pg.pool.Query(pg.ctx,
		`SELECT id, COALESCE(uuid, ''), COALESCE(guid, '') FROM peers WHERE COALESCE(guid, '') = ''`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id, peerUUID, peerGUID string
		if err := rows.Scan(&id, &peerUUID, &peerGUID); err != nil {
			return err
		}
		if peerGUID != "" {
			continue
		}
		if isUUIDLike(peerUUID) {
			peerGUID = strings.ToLower(peerUUID)
		} else {
			peerGUID = uuid.NewString()
		}
		if _, err := pg.pool.Exec(pg.ctx, `UPDATE peers SET guid = $1 WHERE id = $2`, peerGUID, id); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (pg *PostgresDB) backfillUserGUIDs() error {
	rows, err := pg.pool.Query(pg.ctx, `SELECT id FROM users WHERE COALESCE(guid, '') = ''`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return err
		}
		guid := uuid.NewString()
		if _, err := pg.pool.Exec(pg.ctx, `UPDATE users SET guid = $1 WHERE id = $2`, guid, id); err != nil {
			return err
		}
	}
	return rows.Err()
}
