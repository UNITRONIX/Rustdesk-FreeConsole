// Package db — read-only access to legacy console auth.db (SQLite deployments).
// PostgreSQL deployments implement PanelSyncStore on PostgresDB directly.
package db

import (
	"database/sql"
	"fmt"
	"os"
	"strings"

	_ "modernc.org/sqlite"
)

// ConsoleAuthDB opens the panel auth.sqlite (device_groups live here, not in Go peer DB).
type ConsoleAuthDB struct {
	db *sql.DB
}

// PanelDeviceGroup is a device group row from auth.db with access lists.
type PanelDeviceGroup struct {
	ID                int64
	GUID              string
	Name              string
	Note              string
	SourceType        string
	TagFilter         string
	AllowedUsers      []string
	AllowedGroupGUIDs []string
}

// PanelFolder is a folder chip from the devices panel.
type PanelFolder struct {
	ID   int64
	Name string
}

// ConsolePeerSysinfo is optional enrichment from auth.db peer_sysinfo.
type ConsolePeerSysinfo struct {
	Hostname string
	Username string
	Platform string
	Version  string
}

// OpenConsoleAuth opens auth.db read-only (shared with BetterDesk Console).
func OpenConsoleAuth(path string) (*ConsoleAuthDB, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("console auth path is empty")
	}
	dsn := fmt.Sprintf("file:%s?mode=ro&_journal_mode=WAL&_busy_timeout=5000", path)
	sqlDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	if err := sqlDB.Ping(); err != nil {
		_ = sqlDB.Close()
		return nil, err
	}
	return &ConsoleAuthDB{db: sqlDB}, nil
}

// GetUserIDByUsername returns the panel user id from auth.db (for group ACL joins).
func (c *ConsoleAuthDB) GetUserIDByUsername(username string) (int64, error) {
	if !c.hasTable("users") {
		return 0, sql.ErrNoRows
	}
	var id int64
	err := c.db.QueryRow(`SELECT id FROM users WHERE username = ?`, strings.TrimSpace(username)).Scan(&id)
	return id, err
}

// Close releases the auth.db handle.
func (c *ConsoleAuthDB) Close() error {
	if c == nil || c.db == nil {
		return nil
	}
	return c.db.Close()
}

func (c *ConsoleAuthDB) hasTable(name string) bool {
	var n string
	err := c.db.QueryRow(
		`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, name,
	).Scan(&n)
	return err == nil && n == name
}

// ListPanelDeviceGroups returns custom device groups (excludes folder_* mirror guids).
func (c *ConsoleAuthDB) ListPanelDeviceGroups() ([]PanelDeviceGroup, error) {
	if !c.hasTable("device_groups") {
		return nil, nil
	}
	rows, err := c.db.Query(`
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
		g.AllowedUsers, g.AllowedGroupGUIDs, _ = c.loadDeviceGroupAccess(g.ID)
		out = append(out, g)
	}
	return out, rows.Err()
}

func (c *ConsoleAuthDB) loadDeviceGroupAccess(deviceGroupID int64) ([]string, []string, error) {
	var users []string
	if c.hasTable("device_group_user_access") && c.hasTable("users") {
		rows, err := c.db.Query(`
			SELECT u.username FROM device_group_user_access a
			INNER JOIN users u ON u.id = a.user_id
			WHERE a.device_group_id = ?
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
			users = append(users, u)
		}
		rows.Close()
	}

	var groupGUIDs []string
	if c.hasTable("device_group_user_group_access") && c.hasTable("user_groups") {
		rows, err := c.db.Query(`
			SELECT ug.guid FROM device_group_user_group_access a
			INNER JOIN user_groups ug ON ug.id = a.user_group_id
			WHERE a.device_group_id = ?
			ORDER BY ug.name ASC`, deviceGroupID)
		if err != nil {
			return users, nil, err
		}
		for rows.Next() {
			var g string
			if err := rows.Scan(&g); err != nil {
				rows.Close()
				return users, nil, err
			}
			groupGUIDs = append(groupGUIDs, g)
		}
		rows.Close()
	}
	return users, groupGUIDs, nil
}

// ListDeviceGroupMemberPeerIDs returns peer IDs assigned to a device group.
func (c *ConsoleAuthDB) ListDeviceGroupMemberPeerIDs(deviceGroupID int64) ([]string, error) {
	if !c.hasTable("device_group_members") {
		return nil, nil
	}
	rows, err := c.db.Query(
		`SELECT peer_id FROM device_group_members WHERE device_group_id = ? ORDER BY peer_id ASC`,
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
func (c *ConsoleAuthDB) ListDeviceGroupGUIDsForPeer(peerID string) ([]string, error) {
	peerID = strings.TrimSpace(peerID)
	if peerID == "" || !c.hasTable("device_group_members") || !c.hasTable("device_groups") {
		return nil, nil
	}
	rows, err := c.db.Query(`
		SELECT g.guid FROM device_groups g
		INNER JOIN device_group_members m ON m.device_group_id = g.id
		WHERE m.peer_id = ?
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
func (c *ConsoleAuthDB) ListUserGroupGUIDsForUser(userID int64) ([]string, error) {
	if !c.hasTable("user_group_members") || !c.hasTable("user_groups") {
		return nil, nil
	}
	rows, err := c.db.Query(`
		SELECT ug.guid FROM user_groups ug
		INNER JOIN user_group_members ugm ON ug.id = ugm.user_group_id
		WHERE ugm.user_id = ?
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
func (c *ConsoleAuthDB) ListFolders() ([]PanelFolder, error) {
	if !c.hasTable("folders") {
		return nil, nil
	}
	rows, err := c.db.Query(`SELECT id, name FROM folders ORDER BY sort_order ASC, name ASC`)
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

// ListFolderAssignments returns device_id → folder_id from auth.db.
func (c *ConsoleAuthDB) ListFolderAssignments() (map[string]int64, error) {
	out := make(map[string]int64)
	if !c.hasTable("device_folder_assignments") {
		return out, nil
	}
	rows, err := c.db.Query(`SELECT device_id, folder_id FROM device_folder_assignments`)
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

// ListPeerSysinfo returns peer_id → sysinfo rows from auth.db when the table exists.
func (c *ConsoleAuthDB) ListPeerSysinfo() (map[string]ConsolePeerSysinfo, error) {
	out := make(map[string]ConsolePeerSysinfo)
	if !c.hasTable("peer_sysinfo") {
		return out, nil
	}
	rows, err := c.db.Query(`SELECT peer_id, hostname, username, platform, version FROM peer_sysinfo`)
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
func (c *ConsoleAuthDB) FolderGroupAccess(folderID int64) ([]string, []string, error) {
	if !c.hasTable("device_groups") {
		return nil, nil, nil
	}
	var id int64
	guid := fmt.Sprintf("folder_%d", folderID)
	err := c.db.QueryRow(`SELECT id FROM device_groups WHERE guid = ?`, guid).Scan(&id)
	if err == sql.ErrNoRows {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	return c.loadDeviceGroupAccess(id)
}

// ListUserPeerGrants returns peer IDs directly granted to a panel user.
func (c *ConsoleAuthDB) ListUserPeerGrants(userID int64) ([]string, error) {
	if userID <= 0 || !c.hasTable("user_peer_grants") {
		return nil, nil
	}
	rows, err := c.db.Query(`
		SELECT peer_id FROM user_peer_grants WHERE user_id = ? ORDER BY peer_id ASC`, userID)
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
func (c *ConsoleAuthDB) DeviceScopeDefaultRestricted() bool {
	envDefault := func() bool {
		env := strings.TrimSpace(os.Getenv("DEVICE_SCOPE_DEFAULT"))
		if env == "" {
			return true
		}
		return strings.EqualFold(env, "restricted")
	}
	if !c.hasTable("settings") {
		return envDefault()
	}
	var value string
	err := c.db.QueryRow(`SELECT value FROM settings WHERE key = 'device_scope_default' LIMIT 1`).Scan(&value)
	if err == sql.ErrNoRows || strings.TrimSpace(value) == "" {
		return envDefault()
	}
	return strings.EqualFold(strings.TrimSpace(value), "restricted")
}
