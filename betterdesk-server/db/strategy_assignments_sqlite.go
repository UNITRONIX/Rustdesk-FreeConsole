package db

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

func (s *SQLiteDB) AssignStrategy(strategyGUID string, peerKeys, userKeys, groupKeys []string) error {
	strategyGUID = strings.TrimSpace(strategyGUID)
	if strategyGUID != "" {
		st, err := s.GetStrategy(strategyGUID)
		if err != nil {
			return err
		}
		if st == nil {
			return fmt.Errorf("strategy not found")
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	upsert := func(targetType string, keys []string) error {
		for _, raw := range keys {
			key := strings.TrimSpace(raw)
			if key == "" {
				continue
			}
			if strategyGUID == "" {
				if _, err := tx.Exec(
					`DELETE FROM strategy_assignments WHERE target_type = ? AND target_key = ?`,
					targetType, key,
				); err != nil {
					return err
				}
				continue
			}
			_, err := tx.Exec(`
				INSERT INTO strategy_assignments (target_type, target_key, strategy_guid, updated_at)
				VALUES (?, ?, ?, datetime('now'))
				ON CONFLICT(target_type, target_key) DO UPDATE SET
					strategy_guid = excluded.strategy_guid,
					updated_at = excluded.updated_at`,
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
	return tx.Commit()
}

func (s *SQLiteDB) GetStrategyAssignmentSummary(strategyGUID string) (*StrategyAssignmentSummary, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows, err := s.db.Query(`
		SELECT target_type, target_key FROM strategy_assignments
		WHERE strategy_guid = ? ORDER BY target_type, target_key`,
		strategyGUID,
	)
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

func (s *SQLiteDB) ResolvePeerAssignmentKey(ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return "", fmt.Errorf("empty peer reference")
	}
	s.mu.RLock()
	var id string
	err := s.db.QueryRow(`
		SELECT id FROM peers
		WHERE id = ? OR guid = ? OR uuid = ?
		LIMIT 1`, ref, ref, ref).Scan(&id)
	s.mu.RUnlock()
	if err == sql.ErrNoRows {
		return "", fmt.Errorf("peer not found")
	}
	if err != nil {
		return "", err
	}
	return s.EnsurePeerGUID(id)
}

func (s *SQLiteDB) ResolveUserAssignmentKey(ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return "", fmt.Errorf("empty user reference")
	}
	s.mu.RLock()
	var userID int64
	err := s.db.QueryRow(`
		SELECT id FROM users
		WHERE guid = ? OR username = ? OR CAST(id AS TEXT) = ?
		LIMIT 1`, ref, ref, ref).Scan(&userID)
	s.mu.RUnlock()
	if err == sql.ErrNoRows {
		return "", fmt.Errorf("user not found")
	}
	if err != nil {
		return "", err
	}
	return s.ensureUserGUID(userID)
}

func (s *SQLiteDB) ResolveDeviceGroupAssignmentKey(ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return "", fmt.Errorf("empty device group reference")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	var guid string
	err := s.db.QueryRow(`SELECT guid FROM device_groups WHERE guid = ? OR name = ? LIMIT 1`, ref, ref).
		Scan(&guid)
	if err == sql.ErrNoRows {
		return "", fmt.Errorf("device group not found")
	}
	return guid, err
}

func (s *SQLiteDB) GetPeerIDByGUID(guid string) (string, error) {
	guid = strings.TrimSpace(guid)
	if guid == "" {
		return "", fmt.Errorf("empty peer guid")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	var id string
	err := s.db.QueryRow(`SELECT id FROM peers WHERE guid = ? AND soft_deleted = 0 LIMIT 1`, guid).Scan(&id)
	if err == sql.ErrNoRows {
		return "", fmt.Errorf("peer not found")
	}
	return id, err
}

func (s *SQLiteDB) EnsurePeerGUID(id string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return "", fmt.Errorf("empty peer id")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	var peerUUID, peerGUID string
	err := s.db.QueryRow(`SELECT COALESCE(uuid, ''), COALESCE(guid, '') FROM peers WHERE id = ?`, id).
		Scan(&peerUUID, &peerGUID)
	if err == sql.ErrNoRows {
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
	_, err = s.db.Exec(`UPDATE peers SET guid = ? WHERE id = ?`, peerGUID, id)
	return peerGUID, err
}

func (s *SQLiteDB) ensureUserGUID(userID int64) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var userGUID string
	err := s.db.QueryRow(`SELECT COALESCE(guid, '') FROM users WHERE id = ?`, userID).Scan(&userGUID)
	if err != nil {
		return "", err
	}
	if userGUID != "" {
		return userGUID, nil
	}
	userGUID = uuid.NewString()
	_, err = s.db.Exec(`UPDATE users SET guid = ? WHERE id = ?`, userGUID, userID)
	return userGUID, err
}

func (s *SQLiteDB) SetStrategyEnabled(guid string, enabled bool) error {
	st, err := s.GetStrategy(guid)
	if err != nil {
		return err
	}
	if st == nil {
		return fmt.Errorf("strategy not found")
	}
	st.Enabled = enabled
	st.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	return s.UpdateStrategy(guid, st)
}

func (s *SQLiteDB) backfillPeerGUIDsLocked() error {
	rows, err := s.db.Query(`SELECT id, COALESCE(uuid, ''), COALESCE(guid, '') FROM peers WHERE COALESCE(guid, '') = ''`)
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
		if _, err := s.db.Exec(`UPDATE peers SET guid = ? WHERE id = ?`, peerGUID, id); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (s *SQLiteDB) backfillUserGUIDsLocked() error {
	rows, err := s.db.Query(`SELECT id FROM users WHERE COALESCE(guid, '') = ''`)
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
		if _, err := s.db.Exec(`UPDATE users SET guid = ? WHERE id = ?`, guid, id); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (s *SQLiteDB) ListProDeviceRefs(idFilter string, limit, offset int) ([]ProDeviceRef, int, error) {
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

	s.mu.RLock()
	countQuery := `SELECT COUNT(*) FROM peers WHERE soft_deleted = 0`
	countArgs := []any{}
	if idFilter != "" {
		countQuery += ` AND id = ?`
		countArgs = append(countArgs, idFilter)
	}
	var total int
	if err := s.db.QueryRow(countQuery, countArgs...).Scan(&total); err != nil {
		s.mu.RUnlock()
		return nil, 0, err
	}

	query := `SELECT id FROM peers WHERE soft_deleted = 0`
	args := []any{}
	if idFilter != "" {
		query += ` AND id = ?`
		args = append(args, idFilter)
	}
	query += ` ORDER BY id LIMIT ? OFFSET ?`
	args = append(args, limit, offset)

	rows, err := s.db.Query(query, args...)
	if err != nil {
		s.mu.RUnlock()
		return nil, 0, err
	}
	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			s.mu.RUnlock()
			return nil, 0, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	s.mu.RUnlock()
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}

	out := make([]ProDeviceRef, 0, len(ids))
	for _, id := range ids {
		guid, err := s.EnsurePeerGUID(id)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, ProDeviceRef{ID: id, GUID: guid})
	}
	return out, total, nil
}
