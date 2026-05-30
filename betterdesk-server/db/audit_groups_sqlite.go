package db

import (
	"database/sql"

	"github.com/google/uuid"
)

// ── Audit: Connections ────────────────────────────────────────────────

// InsertAuditConnection records a remote-control session event.
func (s *SQLiteDB) InsertAuditConnection(a *AuditConnection) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`INSERT INTO audit_connections (host_id, host_uuid, peer_id, peer_name, action, conn_type, session_id, ip)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		a.HostID, a.HostUUID, a.PeerID, a.PeerName, a.Action, a.ConnType, a.SessionID, a.IP)
	return err
}

// ListAuditConnections returns connection audit records matching the filter.
func (s *SQLiteDB) ListAuditConnections(f AuditFilter) ([]*AuditConnection, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	q := `SELECT id, host_id, host_uuid, peer_id, peer_name, action, conn_type, session_id, ip, created_at
	      FROM audit_connections WHERE 1=1`
	var args []any
	if f.HostID != "" {
		q += " AND host_id = ?"
		args = append(args, f.HostID)
	}
	if f.PeerID != "" {
		q += " AND peer_id = ?"
		args = append(args, f.PeerID)
	}
	if f.Action != "" {
		q += " AND action = ?"
		args = append(args, f.Action)
	}
	q += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
	args = append(args, auditLimit(f.Limit), auditOffset(f.Offset))
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*AuditConnection
	for rows.Next() {
		a := &AuditConnection{}
		if err := rows.Scan(&a.ID, &a.HostID, &a.HostUUID, &a.PeerID, &a.PeerName, &a.Action,
			&a.ConnType, &a.SessionID, &a.IP, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// CountAuditConnections returns the total number of connection records matching the filter.
func (s *SQLiteDB) CountAuditConnections(f AuditFilter) (int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	q := `SELECT COUNT(*) FROM audit_connections WHERE 1=1`
	var args []any
	if f.HostID != "" {
		q += " AND host_id = ?"
		args = append(args, f.HostID)
	}
	if f.PeerID != "" {
		q += " AND peer_id = ?"
		args = append(args, f.PeerID)
	}
	if f.Action != "" {
		q += " AND action = ?"
		args = append(args, f.Action)
	}
	var n int
	err := s.db.QueryRow(q, args...).Scan(&n)
	return n, err
}

// ── Audit: File Transfers ─────────────────────────────────────────────

// InsertAuditFile records a file-transfer event.
func (s *SQLiteDB) InsertAuditFile(a *AuditFile) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	filesJSON := a.FilesJSON
	if filesJSON == "" {
		filesJSON = "[]"
	}
	_, err := s.db.Exec(
		`INSERT INTO audit_files (host_id, host_uuid, peer_id, direction, path, is_file, num_files, files_json, ip, peer_name)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.HostID, a.HostUUID, a.PeerID, a.Direction, a.Path, a.IsFile, a.NumFiles, filesJSON, a.IP, a.PeerName)
	return err
}

// ListAuditFiles returns file-transfer audit records matching the filter.
func (s *SQLiteDB) ListAuditFiles(f AuditFilter) ([]*AuditFile, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	q := `SELECT id, host_id, host_uuid, peer_id, direction, path, is_file, num_files, files_json, ip, peer_name, created_at
	      FROM audit_files WHERE 1=1`
	var args []any
	if f.HostID != "" {
		q += " AND host_id = ?"
		args = append(args, f.HostID)
	}
	if f.PeerID != "" {
		q += " AND peer_id = ?"
		args = append(args, f.PeerID)
	}
	q += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
	args = append(args, auditLimit(f.Limit), auditOffset(f.Offset))
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*AuditFile
	for rows.Next() {
		a := &AuditFile{}
		if err := rows.Scan(&a.ID, &a.HostID, &a.HostUUID, &a.PeerID, &a.Direction, &a.Path,
			&a.IsFile, &a.NumFiles, &a.FilesJSON, &a.IP, &a.PeerName, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// CountAuditFiles returns the total number of file records matching the filter.
func (s *SQLiteDB) CountAuditFiles(f AuditFilter) (int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	q := `SELECT COUNT(*) FROM audit_files WHERE 1=1`
	var args []any
	if f.HostID != "" {
		q += " AND host_id = ?"
		args = append(args, f.HostID)
	}
	if f.PeerID != "" {
		q += " AND peer_id = ?"
		args = append(args, f.PeerID)
	}
	var n int
	err := s.db.QueryRow(q, args...).Scan(&n)
	return n, err
}

// ── Audit: Security Alarms ────────────────────────────────────────────

// InsertAuditAlarm records a security alarm event.
func (s *SQLiteDB) InsertAuditAlarm(a *AuditAlarm) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	details := a.Details
	if details == "" {
		details = "{}"
	}
	_, err := s.db.Exec(
		`INSERT INTO audit_alarms (alarm_type, alarm_name, host_id, peer_id, ip, details)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		a.AlarmType, a.AlarmName, a.HostID, a.PeerID, a.IP, details)
	return err
}

// ListAuditAlarms returns alarm audit records matching the filter.
func (s *SQLiteDB) ListAuditAlarms(f AuditFilter) ([]*AuditAlarm, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	q := `SELECT id, alarm_type, alarm_name, host_id, peer_id, ip, details, created_at
	      FROM audit_alarms WHERE 1=1`
	var args []any
	if f.AlarmType != nil {
		q += " AND alarm_type = ?"
		args = append(args, *f.AlarmType)
	}
	if f.HostID != "" {
		q += " AND host_id = ?"
		args = append(args, f.HostID)
	}
	q += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
	args = append(args, auditLimit(f.Limit), auditOffset(f.Offset))
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*AuditAlarm
	for rows.Next() {
		a := &AuditAlarm{}
		if err := rows.Scan(&a.ID, &a.AlarmType, &a.AlarmName, &a.HostID, &a.PeerID,
			&a.IP, &a.Details, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// CountAuditAlarms returns the total number of alarm records matching the filter.
func (s *SQLiteDB) CountAuditAlarms(f AuditFilter) (int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	q := `SELECT COUNT(*) FROM audit_alarms WHERE 1=1`
	var args []any
	if f.AlarmType != nil {
		q += " AND alarm_type = ?"
		args = append(args, *f.AlarmType)
	}
	if f.HostID != "" {
		q += " AND host_id = ?"
		args = append(args, f.HostID)
	}
	var n int
	err := s.db.QueryRow(q, args...).Scan(&n)
	return n, err
}

// ── User Groups ───────────────────────────────────────────────────────

// ListUserGroups returns all user groups with member counts.
func (s *SQLiteDB) ListUserGroups() ([]*UserGroup, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows, err := s.db.Query(`SELECT id, guid, name, note, team_id, created_at FROM user_groups ORDER BY name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*UserGroup
	for rows.Next() {
		g := &UserGroup{}
		if err := rows.Scan(&g.ID, &g.GUID, &g.Name, &g.Note, &g.TeamID, &g.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// GetUserGroup returns a single user group by GUID, or nil if not found.
func (s *SQLiteDB) GetUserGroup(guid string) (*UserGroup, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	g := &UserGroup{}
	err := s.db.QueryRow(
		`SELECT id, guid, name, note, team_id, created_at FROM user_groups WHERE guid = ?`, guid).
		Scan(&g.ID, &g.GUID, &g.Name, &g.Note, &g.TeamID, &g.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return g, nil
}

// CreateUserGroup inserts a new user group. Generates a GUID if empty.
func (s *SQLiteDB) CreateUserGroup(g *UserGroup) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if g.GUID == "" {
		g.GUID = uuid.New().String()
	}
	_, err := s.db.Exec(
		`INSERT INTO user_groups (guid, name, note, team_id) VALUES (?, ?, ?, ?)`,
		g.GUID, g.Name, g.Note, g.TeamID)
	return err
}

// UpdateUserGroup updates name/note/team_id on an existing user group.
func (s *SQLiteDB) UpdateUserGroup(guid string, g *UserGroup) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`UPDATE user_groups SET name = ?, note = ?, team_id = ? WHERE guid = ?`,
		g.Name, g.Note, g.TeamID, guid)
	return err
}

// DeleteUserGroup removes a user group by GUID.
func (s *SQLiteDB) DeleteUserGroup(guid string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`DELETE FROM user_groups WHERE guid = ?`, guid)
	return err
}

// ── Device Groups ─────────────────────────────────────────────────────

// ListDeviceGroups returns all device groups.
func (s *SQLiteDB) ListDeviceGroups() ([]*DeviceGroup, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows, err := s.db.Query(
		`SELECT id, guid, name, note, team_id, source_type, tag_filter, created_at FROM device_groups ORDER BY name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*DeviceGroup
	for rows.Next() {
		g := &DeviceGroup{}
		if err := rows.Scan(&g.ID, &g.GUID, &g.Name, &g.Note, &g.TeamID, &g.SourceType, &g.TagFilter, &g.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// GetDeviceGroup returns a single device group by GUID, or nil if not found.
func (s *SQLiteDB) GetDeviceGroup(guid string) (*DeviceGroup, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	g := &DeviceGroup{}
	err := s.db.QueryRow(
		`SELECT id, guid, name, note, team_id, source_type, tag_filter, created_at FROM device_groups WHERE guid = ?`, guid).
		Scan(&g.ID, &g.GUID, &g.Name, &g.Note, &g.TeamID, &g.SourceType, &g.TagFilter, &g.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return g, nil
}

// CreateDeviceGroup inserts a new device group. Generates a GUID if empty.
func (s *SQLiteDB) CreateDeviceGroup(g *DeviceGroup) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if g.GUID == "" {
		g.GUID = uuid.New().String()
	}
	st := normalizeSourceType(g.SourceType)
	tf := ""
	if st == "tag" {
		tf = g.TagFilter
	}
	_, err := s.db.Exec(
		`INSERT INTO device_groups (guid, name, note, team_id, source_type, tag_filter) VALUES (?, ?, ?, ?, ?, ?)`,
		g.GUID, g.Name, g.Note, g.TeamID, st, tf)
	return err
}

// UpdateDeviceGroup updates an existing device group.
func (s *SQLiteDB) UpdateDeviceGroup(guid string, g *DeviceGroup) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := normalizeSourceType(g.SourceType)
	_, err := s.db.Exec(
		`UPDATE device_groups SET name = ?, note = ?, team_id = ?, source_type = ?, tag_filter = ? WHERE guid = ?`,
		g.Name, g.Note, g.TeamID, st, g.TagFilter, guid)
	return err
}

// DeleteDeviceGroup removes a device group by GUID.
func (s *SQLiteDB) DeleteDeviceGroup(guid string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`DELETE FROM device_groups WHERE guid = ?`, guid)
	return err
}

// ── Strategies ────────────────────────────────────────────────────────

// ListStrategies returns all strategies.
func (s *SQLiteDB) ListStrategies() ([]*Strategy, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows, err := s.db.Query(
		`SELECT id, guid, name, user_group_guid, device_group_guid, enabled, permissions, created_at, updated_at
		 FROM strategies ORDER BY name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Strategy
	for rows.Next() {
		st := &Strategy{}
		var enabled int
		if err := rows.Scan(&st.ID, &st.GUID, &st.Name, &st.UserGroupGUID, &st.DeviceGroupGUID,
			&enabled, &st.Permissions, &st.CreatedAt, &st.UpdatedAt); err != nil {
			return nil, err
		}
		st.Enabled = enabled != 0
		out = append(out, st)
	}
	return out, rows.Err()
}

// GetStrategy returns a single strategy by GUID, or nil if not found.
func (s *SQLiteDB) GetStrategy(guid string) (*Strategy, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	st := &Strategy{}
	var enabled int
	err := s.db.QueryRow(
		`SELECT id, guid, name, user_group_guid, device_group_guid, enabled, permissions, created_at, updated_at
		 FROM strategies WHERE guid = ?`, guid).
		Scan(&st.ID, &st.GUID, &st.Name, &st.UserGroupGUID, &st.DeviceGroupGUID,
			&enabled, &st.Permissions, &st.CreatedAt, &st.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	st.Enabled = enabled != 0
	return st, nil
}

// CreateStrategy inserts a new strategy. Generates a GUID if empty.
func (s *SQLiteDB) CreateStrategy(st *Strategy) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if st.GUID == "" {
		st.GUID = uuid.New().String()
	}
	perms := st.Permissions
	if perms == "" {
		perms = "{}"
	}
	enabled := 1
	if !st.Enabled {
		enabled = 0
	}
	_, err := s.db.Exec(
		`INSERT INTO strategies (guid, name, user_group_guid, device_group_guid, enabled, permissions)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		st.GUID, st.Name, st.UserGroupGUID, st.DeviceGroupGUID, enabled, perms)
	return err
}

// UpdateStrategy updates an existing strategy.
func (s *SQLiteDB) UpdateStrategy(guid string, st *Strategy) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	perms := st.Permissions
	if perms == "" {
		perms = "{}"
	}
	enabled := 1
	if !st.Enabled {
		enabled = 0
	}
	_, err := s.db.Exec(
		`UPDATE strategies SET name = ?, user_group_guid = ?, device_group_guid = ?, enabled = ?, permissions = ?,
		 updated_at = datetime('now') WHERE guid = ?`,
		st.Name, st.UserGroupGUID, st.DeviceGroupGUID, enabled, perms, guid)
	return err
}

// DeleteStrategy removes a strategy by GUID.
func (s *SQLiteDB) DeleteStrategy(guid string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`DELETE FROM strategies WHERE guid = ?`, guid)
	return err
}

// ── Shared helpers ────────────────────────────────────────────────────

// auditLimit clamps a requested limit to a sane range (default 100, max 1000).
func auditLimit(limit int) int {
	if limit <= 0 {
		return 100
	}
	if limit > 1000 {
		return 1000
	}
	return limit
}

// auditOffset returns a non-negative offset.
func auditOffset(offset int) int {
	if offset < 0 {
		return 0
	}
	return offset
}

// normalizeSourceType coerces a device group source type to "tag" or "manual".
func normalizeSourceType(src string) string {
	if src == "tag" {
		return "tag"
	}
	return "manual"
}
