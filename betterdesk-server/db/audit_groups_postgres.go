package db

import (
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// itoa renders a positional placeholder index for PostgreSQL queries.
func itoa(i int) string { return strconv.Itoa(i) }

// ── Audit: Connections ────────────────────────────────────────────────

// InsertAuditConnection records a remote-control session event.
func (pg *PostgresDB) InsertAuditConnection(a *AuditConnection) error {
	_, err := pg.pool.Exec(pg.ctx,
		`INSERT INTO audit_connections (host_id, host_uuid, peer_id, peer_name, action, conn_type, session_id, ip)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		a.HostID, a.HostUUID, a.PeerID, a.PeerName, a.Action, a.ConnType, a.SessionID, a.IP)
	return err
}

// ListAuditConnections returns connection audit records matching the filter.
func (pg *PostgresDB) ListAuditConnections(f AuditFilter) ([]*AuditConnection, error) {
	q := `SELECT id, host_id, host_uuid, peer_id, peer_name, action, conn_type, session_id, ip, created_at::text
	      FROM audit_connections WHERE 1=1`
	var args []any
	i := 1
	if f.HostID != "" {
		q += " AND host_id = $" + itoa(i)
		args = append(args, f.HostID)
		i++
	}
	if f.PeerID != "" {
		q += " AND peer_id = $" + itoa(i)
		args = append(args, f.PeerID)
		i++
	}
	if f.Action != "" {
		q += " AND action = $" + itoa(i)
		args = append(args, f.Action)
		i++
	}
	q += " ORDER BY created_at DESC LIMIT $" + itoa(i) + " OFFSET $" + itoa(i+1)
	args = append(args, auditLimit(f.Limit), auditOffset(f.Offset))
	rows, err := pg.pool.Query(pg.ctx, q, args...)
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
func (pg *PostgresDB) CountAuditConnections(f AuditFilter) (int, error) {
	q := `SELECT COUNT(*) FROM audit_connections WHERE 1=1`
	var args []any
	i := 1
	if f.HostID != "" {
		q += " AND host_id = $" + itoa(i)
		args = append(args, f.HostID)
		i++
	}
	if f.PeerID != "" {
		q += " AND peer_id = $" + itoa(i)
		args = append(args, f.PeerID)
		i++
	}
	if f.Action != "" {
		q += " AND action = $" + itoa(i)
		args = append(args, f.Action)
		i++
	}
	var n int
	err := pg.pool.QueryRow(pg.ctx, q, args...).Scan(&n)
	return n, err
}

// ── Audit: File Transfers ─────────────────────────────────────────────

// InsertAuditFile records a file-transfer event.
func (pg *PostgresDB) InsertAuditFile(a *AuditFile) error {
	filesJSON := a.FilesJSON
	if filesJSON == "" {
		filesJSON = "[]"
	}
	_, err := pg.pool.Exec(pg.ctx,
		`INSERT INTO audit_files (host_id, host_uuid, peer_id, direction, path, is_file, num_files, files_json, ip, peer_name)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
		a.HostID, a.HostUUID, a.PeerID, a.Direction, a.Path, a.IsFile, a.NumFiles, filesJSON, a.IP, a.PeerName)
	return err
}

// ListAuditFiles returns file-transfer audit records matching the filter.
func (pg *PostgresDB) ListAuditFiles(f AuditFilter) ([]*AuditFile, error) {
	q := `SELECT id, host_id, host_uuid, peer_id, direction, path, is_file, num_files, files_json, ip, peer_name, created_at::text
	      FROM audit_files WHERE 1=1`
	var args []any
	i := 1
	if f.HostID != "" {
		q += " AND host_id = $" + itoa(i)
		args = append(args, f.HostID)
		i++
	}
	if f.PeerID != "" {
		q += " AND peer_id = $" + itoa(i)
		args = append(args, f.PeerID)
		i++
	}
	q += " ORDER BY created_at DESC LIMIT $" + itoa(i) + " OFFSET $" + itoa(i+1)
	args = append(args, auditLimit(f.Limit), auditOffset(f.Offset))
	rows, err := pg.pool.Query(pg.ctx, q, args...)
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
func (pg *PostgresDB) CountAuditFiles(f AuditFilter) (int, error) {
	q := `SELECT COUNT(*) FROM audit_files WHERE 1=1`
	var args []any
	i := 1
	if f.HostID != "" {
		q += " AND host_id = $" + itoa(i)
		args = append(args, f.HostID)
		i++
	}
	if f.PeerID != "" {
		q += " AND peer_id = $" + itoa(i)
		args = append(args, f.PeerID)
		i++
	}
	var n int
	err := pg.pool.QueryRow(pg.ctx, q, args...).Scan(&n)
	return n, err
}

// ── Audit: Security Alarms ────────────────────────────────────────────

// InsertAuditAlarm records a security alarm event.
func (pg *PostgresDB) InsertAuditAlarm(a *AuditAlarm) error {
	details := a.Details
	if details == "" {
		details = "{}"
	}
	_, err := pg.pool.Exec(pg.ctx,
		`INSERT INTO audit_alarms (alarm_type, alarm_name, host_id, peer_id, ip, details)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		a.AlarmType, a.AlarmName, a.HostID, a.PeerID, a.IP, details)
	return err
}

// ListAuditAlarms returns alarm audit records matching the filter.
func (pg *PostgresDB) ListAuditAlarms(f AuditFilter) ([]*AuditAlarm, error) {
	q := `SELECT id, alarm_type, alarm_name, host_id, peer_id, ip, details, created_at::text
	      FROM audit_alarms WHERE 1=1`
	var args []any
	i := 1
	if f.AlarmType != nil {
		q += " AND alarm_type = $" + itoa(i)
		args = append(args, *f.AlarmType)
		i++
	}
	if f.HostID != "" {
		q += " AND host_id = $" + itoa(i)
		args = append(args, f.HostID)
		i++
	}
	q += " ORDER BY created_at DESC LIMIT $" + itoa(i) + " OFFSET $" + itoa(i+1)
	args = append(args, auditLimit(f.Limit), auditOffset(f.Offset))
	rows, err := pg.pool.Query(pg.ctx, q, args...)
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
func (pg *PostgresDB) CountAuditAlarms(f AuditFilter) (int, error) {
	q := `SELECT COUNT(*) FROM audit_alarms WHERE 1=1`
	var args []any
	i := 1
	if f.AlarmType != nil {
		q += " AND alarm_type = $" + itoa(i)
		args = append(args, *f.AlarmType)
		i++
	}
	if f.HostID != "" {
		q += " AND host_id = $" + itoa(i)
		args = append(args, f.HostID)
		i++
	}
	var n int
	err := pg.pool.QueryRow(pg.ctx, q, args...).Scan(&n)
	return n, err
}

// ── User Groups ───────────────────────────────────────────────────────

// ListUserGroups returns all user groups.
func (pg *PostgresDB) ListUserGroups() ([]*UserGroup, error) {
	rows, err := pg.pool.Query(pg.ctx,
		`SELECT id, guid, name, note, team_id, created_at::text FROM user_groups ORDER BY name ASC`)
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
func (pg *PostgresDB) GetUserGroup(guid string) (*UserGroup, error) {
	g := &UserGroup{}
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT id, guid, name, note, team_id, created_at::text FROM user_groups WHERE guid = $1`, guid).
		Scan(&g.ID, &g.GUID, &g.Name, &g.Note, &g.TeamID, &g.CreatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return g, nil
}

// CreateUserGroup inserts a new user group. Generates a GUID if empty.
func (pg *PostgresDB) CreateUserGroup(g *UserGroup) error {
	if g.GUID == "" {
		g.GUID = uuid.New().String()
	}
	_, err := pg.pool.Exec(pg.ctx,
		`INSERT INTO user_groups (guid, name, note, team_id) VALUES ($1, $2, $3, $4)`,
		g.GUID, g.Name, g.Note, g.TeamID)
	return err
}

// UpdateUserGroup updates name/note/team_id on an existing user group.
func (pg *PostgresDB) UpdateUserGroup(guid string, g *UserGroup) error {
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE user_groups SET name = $1, note = $2, team_id = $3 WHERE guid = $4`,
		g.Name, g.Note, g.TeamID, guid)
	return err
}

// DeleteUserGroup removes a user group by GUID.
func (pg *PostgresDB) DeleteUserGroup(guid string) error {
	_, err := pg.pool.Exec(pg.ctx, `DELETE FROM user_groups WHERE guid = $1`, guid)
	return err
}

// ── Device Groups ─────────────────────────────────────────────────────

// ListDeviceGroups returns all device groups.
func (pg *PostgresDB) ListDeviceGroups() ([]*DeviceGroup, error) {
	rows, err := pg.pool.Query(pg.ctx,
		`SELECT id, guid, name, note, team_id, source_type, tag_filter, created_at::text FROM device_groups ORDER BY name ASC`)
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
func (pg *PostgresDB) GetDeviceGroup(guid string) (*DeviceGroup, error) {
	g := &DeviceGroup{}
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT id, guid, name, note, team_id, source_type, tag_filter, created_at::text FROM device_groups WHERE guid = $1`, guid).
		Scan(&g.ID, &g.GUID, &g.Name, &g.Note, &g.TeamID, &g.SourceType, &g.TagFilter, &g.CreatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return g, nil
}

// CreateDeviceGroup inserts a new device group. Generates a GUID if empty.
func (pg *PostgresDB) CreateDeviceGroup(g *DeviceGroup) error {
	if g.GUID == "" {
		g.GUID = uuid.New().String()
	}
	st := normalizeSourceType(g.SourceType)
	tf := ""
	if st == "tag" {
		tf = g.TagFilter
	}
	_, err := pg.pool.Exec(pg.ctx,
		`INSERT INTO device_groups (guid, name, note, team_id, source_type, tag_filter) VALUES ($1, $2, $3, $4, $5, $6)`,
		g.GUID, g.Name, g.Note, g.TeamID, st, tf)
	return err
}

// UpdateDeviceGroup updates an existing device group.
func (pg *PostgresDB) UpdateDeviceGroup(guid string, g *DeviceGroup) error {
	st := normalizeSourceType(g.SourceType)
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE device_groups SET name = $1, note = $2, team_id = $3, source_type = $4, tag_filter = $5 WHERE guid = $6`,
		g.Name, g.Note, g.TeamID, st, g.TagFilter, guid)
	return err
}

// DeleteDeviceGroup removes a device group by GUID.
func (pg *PostgresDB) DeleteDeviceGroup(guid string) error {
	_, err := pg.pool.Exec(pg.ctx, `DELETE FROM device_groups WHERE guid = $1`, guid)
	return err
}

// ── Strategies ────────────────────────────────────────────────────────

// ListStrategies returns all strategies.
func (pg *PostgresDB) ListStrategies() ([]*Strategy, error) {
	rows, err := pg.pool.Query(pg.ctx,
		`SELECT id, guid, name, user_group_guid, device_group_guid, enabled, permissions, created_at::text, updated_at::text
		 FROM strategies ORDER BY name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Strategy
	for rows.Next() {
		st := &Strategy{}
		if err := rows.Scan(&st.ID, &st.GUID, &st.Name, &st.UserGroupGUID, &st.DeviceGroupGUID,
			&st.Enabled, &st.Permissions, &st.CreatedAt, &st.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

// GetStrategy returns a single strategy by GUID, or nil if not found.
func (pg *PostgresDB) GetStrategy(guid string) (*Strategy, error) {
	st := &Strategy{}
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT id, guid, name, user_group_guid, device_group_guid, enabled, permissions, created_at::text, updated_at::text
		 FROM strategies WHERE guid = $1`, guid).
		Scan(&st.ID, &st.GUID, &st.Name, &st.UserGroupGUID, &st.DeviceGroupGUID,
			&st.Enabled, &st.Permissions, &st.CreatedAt, &st.UpdatedAt)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return st, nil
}

// CreateStrategy inserts a new strategy. Generates a GUID if empty.
func (pg *PostgresDB) CreateStrategy(st *Strategy) error {
	if st.GUID == "" {
		st.GUID = uuid.New().String()
	}
	perms := st.Permissions
	if perms == "" {
		perms = "{}"
	}
	_, err := pg.pool.Exec(pg.ctx,
		`INSERT INTO strategies (guid, name, user_group_guid, device_group_guid, enabled, permissions)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		st.GUID, st.Name, st.UserGroupGUID, st.DeviceGroupGUID, st.Enabled, perms)
	return err
}

// UpdateStrategy updates an existing strategy.
func (pg *PostgresDB) UpdateStrategy(guid string, st *Strategy) error {
	perms := st.Permissions
	if perms == "" {
		perms = "{}"
	}
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE strategies SET name = $1, user_group_guid = $2, device_group_guid = $3, enabled = $4, permissions = $5,
		 updated_at = NOW() WHERE guid = $6`,
		st.Name, st.UserGroupGUID, st.DeviceGroupGUID, st.Enabled, perms, guid)
	return err
}

// DeleteStrategy removes a strategy by GUID.
func (pg *PostgresDB) DeleteStrategy(guid string) error {
	if _, err := pg.pool.Exec(pg.ctx, `DELETE FROM strategy_assignments WHERE strategy_guid = $1`, guid); err != nil {
		return err
	}
	_, err := pg.pool.Exec(pg.ctx, `DELETE FROM strategies WHERE guid = $1`, guid)
	return err
}
