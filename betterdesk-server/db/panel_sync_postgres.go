package db

import (
	"fmt"
	"os"
	"strings"

	"github.com/jackc/pgx/v5"
)

// PostgresDB implements PanelSyncStore when panel tables are in the consolidated database.
var _ PanelSyncStore = (*PostgresDB)(nil)

func (pg *PostgresDB) pgHasTable(name string) bool {
	var exists bool
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name = $1
		)`, name).Scan(&exists)
	return err == nil && exists
}

// GetUserIDByUsername returns the user id from the consolidated users table.
func (pg *PostgresDB) GetUserIDByUsername(username string) (int64, error) {
	var id int64
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT id FROM users WHERE username = $1`, strings.TrimSpace(username)).Scan(&id)
	if err == pgx.ErrNoRows {
		return 0, err
	}
	return id, err
}

// ListPanelDeviceGroups returns custom device groups (excludes folder_* mirror guids).
func (pg *PostgresDB) ListPanelDeviceGroups() ([]PanelDeviceGroup, error) {
	if !pg.pgHasTable("device_groups") {
		return nil, nil
	}
	rows, err := pg.pool.Query(pg.ctx, `
		SELECT id, guid, name, COALESCE(note,''), COALESCE(source_type,'manual'), COALESCE(tag_filter,'')
		FROM device_groups
		WHERE guid NOT LIKE 'folder_%'
		ORDER BY name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []PanelDeviceGroup
	for rows.Next() {
		var g PanelDeviceGroup
		if err := rows.Scan(&g.ID, &g.GUID, &g.Name, &g.Note, &g.SourceType, &g.TagFilter); err != nil {
			return nil, err
		}
		if g.SourceType == "" {
			g.SourceType = "manual"
		}
		g.AllowedUsers, g.AllowedGroupGUIDs, err = pg.loadDeviceGroupAccess(g.ID)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

func (pg *PostgresDB) loadDeviceGroupAccess(deviceGroupID int64) ([]string, []string, error) {
	var users []string
	if pg.pgHasTable("device_group_user_access") {
		rows, err := pg.pool.Query(pg.ctx, `
			SELECT u.username FROM device_group_user_access a
			INNER JOIN users u ON u.id = a.user_id
			WHERE a.device_group_id = $1
			ORDER BY u.username ASC`, deviceGroupID)
		if err != nil {
			return nil, nil, err
		}
		for rows.Next() {
			var u string
			if err := rows.Scan(&u); err != nil {
				rows.Close()
				return nil, nil, err
			}
			if u != "" {
				users = append(users, u)
			}
		}
		rows.Close()
	}

	var groupGUIDs []string
	if pg.pgHasTable("device_group_user_group_access") && pg.pgHasTable("user_groups") {
		rows, err := pg.pool.Query(pg.ctx, `
			SELECT ug.guid FROM device_group_user_group_access a
			INNER JOIN user_groups ug ON ug.id = a.user_group_id
			WHERE a.device_group_id = $1
			ORDER BY ug.name ASC`, deviceGroupID)
		if err != nil {
			return nil, nil, err
		}
		for rows.Next() {
			var g string
			if err := rows.Scan(&g); err != nil {
				rows.Close()
				return nil, nil, err
			}
			if g != "" {
				groupGUIDs = append(groupGUIDs, g)
			}
		}
		rows.Close()
	}
	return users, groupGUIDs, nil
}

// ListDeviceGroupMemberPeerIDs returns peer IDs assigned to a device group.
func (pg *PostgresDB) ListDeviceGroupMemberPeerIDs(deviceGroupID int64) ([]string, error) {
	if !pg.pgHasTable("device_group_members") {
		return nil, nil
	}
	rows, err := pg.pool.Query(pg.ctx,
		`SELECT peer_id FROM device_group_members WHERE device_group_id = $1 ORDER BY peer_id ASC`,
		deviceGroupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		id = strings.TrimSpace(id)
		if id != "" {
			ids = append(ids, id)
		}
	}
	return ids, rows.Err()
}

// ListDeviceGroupGUIDsForPeer returns device-group GUIDs that include the peer.
func (pg *PostgresDB) ListDeviceGroupGUIDsForPeer(peerID string) ([]string, error) {
	peerID = strings.TrimSpace(peerID)
	if peerID == "" || !pg.pgHasTable("device_group_members") || !pg.pgHasTable("device_groups") {
		return nil, nil
	}
	rows, err := pg.pool.Query(pg.ctx, `
		SELECT g.guid FROM device_groups g
		INNER JOIN device_group_members m ON m.device_group_id = g.id
		WHERE m.peer_id = $1
		ORDER BY g.name ASC`, peerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var guids []string
	for rows.Next() {
		var guid string
		if err := rows.Scan(&guid); err != nil {
			return nil, err
		}
		guid = strings.TrimSpace(guid)
		if guid != "" {
			guids = append(guids, guid)
		}
	}
	return guids, rows.Err()
}

// ListUserGroupGUIDsForUser returns user-group GUIDs the user belongs to.
func (pg *PostgresDB) ListUserGroupGUIDsForUser(userID int64) ([]string, error) {
	if !pg.pgHasTable("user_group_members") || !pg.pgHasTable("user_groups") {
		return nil, nil
	}
	rows, err := pg.pool.Query(pg.ctx, `
		SELECT ug.guid FROM user_groups ug
		INNER JOIN user_group_members ugm ON ug.id = ugm.user_group_id
		WHERE ugm.user_id = $1
		ORDER BY ug.name ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var guids []string
	for rows.Next() {
		var g string
		if err := rows.Scan(&g); err != nil {
			return nil, err
		}
		if g != "" {
			guids = append(guids, g)
		}
	}
	return guids, rows.Err()
}

// ListFolders returns panel folder definitions.
func (pg *PostgresDB) ListFolders() ([]PanelFolder, error) {
	if !pg.pgHasTable("folders") {
		return nil, nil
	}
	rows, err := pg.pool.Query(pg.ctx,
		`SELECT id, name FROM folders ORDER BY sort_order ASC, name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PanelFolder
	for rows.Next() {
		var f PanelFolder
		if err := rows.Scan(&f.ID, &f.Name); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// ListFolderAssignments returns device_id → folder_id.
func (pg *PostgresDB) ListFolderAssignments() (map[string]int64, error) {
	out := make(map[string]int64)
	if !pg.pgHasTable("device_folder_assignments") {
		return out, nil
	}
	rows, err := pg.pool.Query(pg.ctx, `SELECT device_id, folder_id FROM device_folder_assignments`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var deviceID string
		var folderID int64
		if err := rows.Scan(&deviceID, &folderID); err != nil {
			return nil, err
		}
		deviceID = strings.TrimSpace(deviceID)
		if deviceID != "" {
			out[deviceID] = folderID
		}
	}
	return out, rows.Err()
}

// ListPeerSysinfo returns peer_id → sysinfo from peer_sysinfo when present.
func (pg *PostgresDB) ListPeerSysinfo() (map[string]ConsolePeerSysinfo, error) {
	out := make(map[string]ConsolePeerSysinfo)
	if !pg.pgHasTable("peer_sysinfo") {
		return out, nil
	}
	rows, err := pg.pool.Query(pg.ctx,
		`SELECT peer_id, hostname, username, platform, version FROM peer_sysinfo`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var si ConsolePeerSysinfo
		if err := rows.Scan(&id, &si.Hostname, &si.Username, &si.Platform, &si.Version); err != nil {
			return nil, err
		}
		id = strings.TrimSpace(id)
		if id != "" {
			out[id] = si
		}
	}
	return out, rows.Err()
}

// FolderGroupAccess loads allowed_users / allowed_groups for folder_<id> mirror group.
func (pg *PostgresDB) FolderGroupAccess(folderID int64) ([]string, []string, error) {
	if !pg.pgHasTable("device_groups") {
		return nil, nil, nil
	}
	var id int64
	guid := fmt.Sprintf("folder_%d", folderID)
	err := pg.pool.QueryRow(pg.ctx, `SELECT id FROM device_groups WHERE guid = $1`, guid).Scan(&id)
	if err == pgx.ErrNoRows {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	return pg.loadDeviceGroupAccess(id)
}

// ListUserPeerGrants returns peer IDs directly granted to a panel user.
func (pg *PostgresDB) ListUserPeerGrants(userID int64) ([]string, error) {
	if userID <= 0 || !pg.pgHasTable("user_peer_grants") {
		return nil, nil
	}
	rows, err := pg.pool.Query(pg.ctx, `
		SELECT peer_id FROM user_peer_grants WHERE user_id = $1 ORDER BY peer_id ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		id = strings.TrimSpace(id)
		if id != "" {
			out = append(out, id)
		}
	}
	return out, rows.Err()
}

// DeviceScopeDefaultRestricted reads panel settings for default-deny device visibility.
// When unset, defaults to restricted (allowlist-only for non-admins).
func (pg *PostgresDB) DeviceScopeDefaultRestricted() bool {
	if pg.pgHasTable("settings") {
		var value string
		err := pg.pool.QueryRow(pg.ctx, `SELECT value FROM settings WHERE key = 'device_scope_default' LIMIT 1`).Scan(&value)
		if err == nil && strings.TrimSpace(value) != "" {
			return strings.EqualFold(strings.TrimSpace(value), "restricted")
		}
	}
	env := strings.TrimSpace(os.Getenv("DEVICE_SCOPE_DEFAULT"))
	if env == "" {
		return true
	}
	return strings.EqualFold(env, "restricted")
}
