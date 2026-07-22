// Organization CRUD operations for SQLite backend (v3.0.0).
package db

import (
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// ---------------------------------------------------------------------------
//  Organizations
// ---------------------------------------------------------------------------

func (s *SQLiteDB) CreateOrganization(o *Organization) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`INSERT INTO organizations (id, name, slug, logo_url, settings, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		o.ID, o.Name, o.Slug, o.LogoURL, o.Settings, o.CreatedAt.UTC().Format(time.RFC3339),
	)
	return err
}

func (s *SQLiteDB) GetOrganization(id string) (*Organization, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var o Organization
	var createdAt string
	err := s.db.QueryRow(
		`SELECT id, name, slug, logo_url, settings, created_at FROM organizations WHERE id = ?`, id,
	).Scan(&o.ID, &o.Name, &o.Slug, &o.LogoURL, &o.Settings, &createdAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	o.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	return &o, nil
}

func (s *SQLiteDB) GetOrganizationBySlug(slug string) (*Organization, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var o Organization
	var createdAt string
	err := s.db.QueryRow(
		`SELECT id, name, slug, logo_url, settings, created_at FROM organizations WHERE slug = ?`, slug,
	).Scan(&o.ID, &o.Name, &o.Slug, &o.LogoURL, &o.Settings, &createdAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	o.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	return &o, nil
}

func (s *SQLiteDB) ListOrganizations() ([]*Organization, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rows, err := s.db.Query(`SELECT id, name, slug, logo_url, settings, created_at FROM organizations ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var orgs []*Organization
	for rows.Next() {
		var o Organization
		var createdAt string
		if err := rows.Scan(&o.ID, &o.Name, &o.Slug, &o.LogoURL, &o.Settings, &createdAt); err != nil {
			return nil, err
		}
		o.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
		orgs = append(orgs, &o)
	}
	return orgs, rows.Err()
}

func (s *SQLiteDB) UpdateOrganization(o *Organization) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`UPDATE organizations SET name = ?, slug = ?, logo_url = ?, settings = ? WHERE id = ?`,
		o.Name, o.Slug, o.LogoURL, o.Settings, o.ID,
	)
	return err
}

func (s *SQLiteDB) DeleteOrganization(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Cascade: remove settings, invitations, devices, users, then org
	tx.Exec(`DELETE FROM org_address_books WHERE org_id = ?`, id)
	tx.Exec(`DELETE FROM org_settings WHERE org_id = ?`, id)
	tx.Exec(`DELETE FROM org_invitations WHERE org_id = ?`, id)
	tx.Exec(`DELETE FROM org_devices WHERE org_id = ?`, id)
	tx.Exec(`DELETE FROM org_users WHERE org_id = ?`, id)
	if _, err := tx.Exec(`DELETE FROM organizations WHERE id = ?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// ---------------------------------------------------------------------------
//  Org Users
// ---------------------------------------------------------------------------

func (s *SQLiteDB) CreateOrgUser(u *OrgUser) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`INSERT INTO org_users (id, org_id, server_user_id, username, display_name, email, password_hash, role, totp_secret, avatar_url, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		u.ID, u.OrgID, u.ServerUserID, u.Username, u.DisplayName, u.Email, u.PasswordHash,
		u.Role, u.TOTPSecret, u.AvatarURL, u.CreatedAt.UTC().Format(time.RFC3339),
	)
	return err
}

func (s *SQLiteDB) GetOrgUser(id string) (*OrgUser, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	return s.scanOrgUser(s.db.QueryRow(
		`SELECT id, org_id, server_user_id, username, display_name, email, password_hash, role, totp_secret, avatar_url, last_login, created_at
		 FROM org_users WHERE id = ?`, id,
	))
}

func (s *SQLiteDB) GetOrgUserByUsername(orgID, username string) (*OrgUser, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	return s.scanOrgUser(s.db.QueryRow(
		`SELECT id, org_id, server_user_id, username, display_name, email, password_hash, role, totp_secret, avatar_url, last_login, created_at
		 FROM org_users WHERE org_id = ? AND username = ?`, orgID, username,
	))
}

func (s *SQLiteDB) GetOrgUserByServerUserID(orgID string, serverUserID int64) (*OrgUser, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	return s.scanOrgUser(s.db.QueryRow(
		`SELECT id, org_id, server_user_id, username, display_name, email, password_hash, role, totp_secret, avatar_url, last_login, created_at
		 FROM org_users WHERE org_id = ? AND server_user_id = ?`, orgID, serverUserID,
	))
}

func (s *SQLiteDB) ListOrgUsers(orgID string) ([]*OrgUser, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rows, err := s.db.Query(
		`SELECT id, org_id, server_user_id, username, display_name, email, password_hash, role, totp_secret, avatar_url, last_login, created_at
		 FROM org_users WHERE org_id = ? ORDER BY username`, orgID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []*OrgUser
	for rows.Next() {
		u, err := s.scanOrgUserRow(rows)
		if err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

func (s *SQLiteDB) UpdateOrgUser(u *OrgUser) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`UPDATE org_users SET display_name = ?, email = ?, role = ?, totp_secret = ?, avatar_url = ?
		 WHERE id = ?`,
		u.DisplayName, u.Email, u.Role, u.TOTPSecret, u.AvatarURL, u.ID,
	)
	return err
}

func (s *SQLiteDB) DeleteOrgUser(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`DELETE FROM org_users WHERE id = ?`, id)
	return err
}

func (s *SQLiteDB) UpdateOrgUserLogin(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`UPDATE org_users SET last_login = ? WHERE id = ?`,
		time.Now().UTC().Format(time.RFC3339), id,
	)
	return err
}

// helpers

func (s *SQLiteDB) scanOrgUser(row *sql.Row) (*OrgUser, error) {
	var u OrgUser
	var lastLogin sql.NullString
	var createdAt string
	var serverUserID sql.NullInt64
	err := row.Scan(
		&u.ID, &u.OrgID, &serverUserID, &u.Username, &u.DisplayName, &u.Email,
		&u.PasswordHash, &u.Role, &u.TOTPSecret, &u.AvatarURL,
		&lastLogin, &createdAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if serverUserID.Valid {
		u.ServerUserID = serverUserID.Int64
	}
	u.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	if lastLogin.Valid {
		t, _ := time.Parse(time.RFC3339, lastLogin.String)
		u.LastLogin = &t
	}
	return &u, nil
}

type orgUserRowScanner interface {
	Scan(dest ...interface{}) error
}

func (s *SQLiteDB) scanOrgUserRow(row orgUserRowScanner) (*OrgUser, error) {
	var u OrgUser
	var lastLogin sql.NullString
	var createdAt string
	var serverUserID sql.NullInt64
	err := row.Scan(
		&u.ID, &u.OrgID, &serverUserID, &u.Username, &u.DisplayName, &u.Email,
		&u.PasswordHash, &u.Role, &u.TOTPSecret, &u.AvatarURL,
		&lastLogin, &createdAt,
	)
	if err != nil {
		return nil, err
	}
	if serverUserID.Valid {
		u.ServerUserID = serverUserID.Int64
	}
	u.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	if lastLogin.Valid {
		t, _ := time.Parse(time.RFC3339, lastLogin.String)
		u.LastLogin = &t
	}
	return &u, nil
}

// ---------------------------------------------------------------------------
//  Org Devices
// ---------------------------------------------------------------------------

func (s *SQLiteDB) AssignDeviceToOrg(d *OrgDevice) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`INSERT OR REPLACE INTO org_devices (org_id, device_id, assigned_user_id, department, location, building, tags)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		d.OrgID, d.DeviceID, d.AssignedUserID, d.Department, d.Location, d.Building, d.Tags,
	)
	return err
}

func (s *SQLiteDB) UnassignDeviceFromOrg(orgID, deviceID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`DELETE FROM org_devices WHERE org_id = ? AND device_id = ?`, orgID, deviceID)
	return err
}

func (s *SQLiteDB) GetOrgDevice(orgID, deviceID string) (*OrgDevice, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var d OrgDevice
	err := s.db.QueryRow(
		`SELECT org_id, device_id, assigned_user_id, department, location, building, tags
		 FROM org_devices WHERE org_id = ? AND device_id = ?`, orgID, deviceID,
	).Scan(&d.OrgID, &d.DeviceID, &d.AssignedUserID, &d.Department, &d.Location, &d.Building, &d.Tags)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &d, nil
}

func (s *SQLiteDB) ListOrgDevices(orgID string) ([]*OrgDevice, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rows, err := s.db.Query(
		`SELECT org_id, device_id, assigned_user_id, department, location, building, tags
		 FROM org_devices WHERE org_id = ? ORDER BY device_id`, orgID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var devices []*OrgDevice
	for rows.Next() {
		var d OrgDevice
		if err := rows.Scan(&d.OrgID, &d.DeviceID, &d.AssignedUserID, &d.Department, &d.Location, &d.Building, &d.Tags); err != nil {
			return nil, err
		}
		devices = append(devices, &d)
	}
	return devices, rows.Err()
}

func (s *SQLiteDB) UpdateOrgDevice(d *OrgDevice) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`UPDATE org_devices SET assigned_user_id = ?, department = ?, location = ?, building = ?, tags = ?
		 WHERE org_id = ? AND device_id = ?`,
		d.AssignedUserID, d.Department, d.Location, d.Building, d.Tags, d.OrgID, d.DeviceID,
	)
	return err
}

// ---------------------------------------------------------------------------
//  Org Invitations
// ---------------------------------------------------------------------------

func (s *SQLiteDB) CreateOrgInvitation(inv *OrgInvitation) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`INSERT INTO org_invitations (id, org_id, token, email, role, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		inv.ID, inv.OrgID, inv.Token, inv.Email, inv.Role,
		inv.ExpiresAt.UTC().Format(time.RFC3339),
	)
	return err
}

func (s *SQLiteDB) GetOrgInvitationByToken(token string) (*OrgInvitation, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var inv OrgInvitation
	var expiresAt string
	var usedAt sql.NullString
	err := s.db.QueryRow(
		`SELECT id, org_id, token, email, role, expires_at, used_at
		 FROM org_invitations WHERE token = ?`, token,
	).Scan(&inv.ID, &inv.OrgID, &inv.Token, &inv.Email, &inv.Role, &expiresAt, &usedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	inv.ExpiresAt, _ = time.Parse(time.RFC3339, expiresAt)
	if usedAt.Valid {
		t, _ := time.Parse(time.RFC3339, usedAt.String)
		inv.UsedAt = &t
	}
	return &inv, nil
}

func (s *SQLiteDB) ListOrgInvitations(orgID string) ([]*OrgInvitation, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rows, err := s.db.Query(
		`SELECT id, org_id, token, email, role, expires_at, used_at
		 FROM org_invitations WHERE org_id = ? ORDER BY expires_at DESC`, orgID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var invs []*OrgInvitation
	for rows.Next() {
		var inv OrgInvitation
		var expiresAt string
		var usedAt sql.NullString
		if err := rows.Scan(&inv.ID, &inv.OrgID, &inv.Token, &inv.Email, &inv.Role, &expiresAt, &usedAt); err != nil {
			return nil, err
		}
		inv.ExpiresAt, _ = time.Parse(time.RFC3339, expiresAt)
		if usedAt.Valid {
			t, _ := time.Parse(time.RFC3339, usedAt.String)
			inv.UsedAt = &t
		}
		invs = append(invs, &inv)
	}
	return invs, rows.Err()
}

func (s *SQLiteDB) UseOrgInvitation(token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`UPDATE org_invitations SET used_at = ? WHERE token = ?`,
		time.Now().UTC().Format(time.RFC3339), token,
	)
	return err
}

func (s *SQLiteDB) DeleteOrgInvitation(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`DELETE FROM org_invitations WHERE id = ?`, id)
	return err
}

// ---------------------------------------------------------------------------
//  Org Settings
// ---------------------------------------------------------------------------

func (s *SQLiteDB) GetOrgSetting(orgID, key string) (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var value string
	err := s.db.QueryRow(
		`SELECT value FROM org_settings WHERE org_id = ? AND key = ?`, orgID, key,
	).Scan(&value)
	if err == sql.ErrNoRows {
		return "", fmt.Errorf("org setting not found: %s/%s", orgID, key)
	}
	return value, err
}

func (s *SQLiteDB) SetOrgSetting(orgID, key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`INSERT OR REPLACE INTO org_settings (org_id, key, value) VALUES (?, ?, ?)`,
		orgID, key, value,
	)
	return err
}

func (s *SQLiteDB) DeleteOrgSetting(orgID, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`DELETE FROM org_settings WHERE org_id = ? AND key = ?`, orgID, key)
	return err
}

func (s *SQLiteDB) ListOrgSettings(orgID string) ([]*OrgSetting, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rows, err := s.db.Query(
		`SELECT org_id, key, value FROM org_settings WHERE org_id = ? ORDER BY key`, orgID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var settings []*OrgSetting
	for rows.Next() {
		var s OrgSetting
		if err := rows.Scan(&s.OrgID, &s.Key, &s.Value); err != nil {
			return nil, err
		}
		settings = append(settings, &s)
	}
	return settings, rows.Err()
}

// ---------------------------------------------------------------------------
//  User-Org Linking (Issue #106)
// ---------------------------------------------------------------------------

// LinkUserToOrg links an existing server-level user to an organization.
// Creates an OrgUser entry with server_user_id set and empty password_hash.
func (s *SQLiteDB) LinkUserToOrg(orgID string, userID int64, role string) (*OrgUser, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Check if already linked
	var existingID string
	err := s.db.QueryRow(
		`SELECT id FROM org_users WHERE org_id = ? AND server_user_id = ?`, orgID, userID,
	).Scan(&existingID)
	if err == nil {
		return nil, fmt.Errorf("user already linked to this organization")
	}
	if err != sql.ErrNoRows {
		return nil, err
	}

	// Get user by ID directly
	var username string
	err = s.db.QueryRow(`SELECT username FROM users WHERE id = ?`, userID).Scan(&username)
	if err != nil {
		return nil, fmt.Errorf("server user not found: %w", err)
	}

	// Check username conflict
	var conflictID string
	err = s.db.QueryRow(
		`SELECT id FROM org_users WHERE org_id = ? AND username = ?`, orgID, username,
	).Scan(&conflictID)
	if err == nil {
		return nil, fmt.Errorf("username already exists in this organization")
	}

	id := uuid.New().String()
	now := time.Now().UTC()

	_, err = s.db.Exec(
		`INSERT INTO org_users (id, org_id, server_user_id, username, display_name, email, password_hash, role, totp_secret, avatar_url, created_at)
		 VALUES (?, ?, ?, ?, '', '', '', ?, '', '', ?)`,
		id, orgID, userID, username, role, now.Format(time.RFC3339),
	)
	if err != nil {
		return nil, err
	}

	return &OrgUser{
		ID:           id,
		OrgID:        orgID,
		ServerUserID: userID,
		Username:     username,
		Role:         role,
		CreatedAt:    now,
	}, nil
}

// UnlinkUserFromOrg removes a linked server user from an organization.
func (s *SQLiteDB) UnlinkUserFromOrg(orgID string, serverUserID int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	result, err := s.db.Exec(
		`DELETE FROM org_users WHERE org_id = ? AND server_user_id = ?`, orgID, serverUserID,
	)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return fmt.Errorf("user not linked to this organization")
	}
	return nil
}

// ListUsersNotInOrg returns server-level users not yet linked to the organization.
func (s *SQLiteDB) ListUsersNotInOrg(orgID string) ([]*User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rows, err := s.db.Query(
		`SELECT id, username, role, COALESCE(is_server_admin, 0), totp_enabled,
		        COALESCE(created_at, datetime('now')), last_login
		 FROM users
		 WHERE id NOT IN (
			SELECT server_user_id FROM org_users WHERE org_id = ? AND server_user_id > 0
		 )
		 ORDER BY username`, orgID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []*User
	for rows.Next() {
		var u User
		var lastLogin sql.NullString
		var createdAt string
		var totpEnabled int
		var isServerAdmin int
		if err := rows.Scan(&u.ID, &u.Username, &u.Role, &isServerAdmin, &totpEnabled, &createdAt, &lastLogin); err != nil {
			return nil, err
		}
		u.IsServerAdmin = isServerAdmin == 1
		u.TOTPEnabled = totpEnabled == 1
		u.CreatedAt = createdAt
		if lastLogin.Valid {
			u.LastLogin = lastLogin.String
		}
		users = append(users, &u)
	}
	return users, rows.Err()
}

// ListUserOrganizations returns all organizations a server user is linked to.
func (s *SQLiteDB) ListUserOrganizations(userID int64) ([]*Organization, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rows, err := s.db.Query(
		`SELECT o.id, o.name, o.slug, o.logo_url, o.settings, o.created_at
		 FROM organizations o
		 INNER JOIN org_users ou ON o.id = ou.org_id
		 WHERE ou.server_user_id = ?
		 ORDER BY o.name`, userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var orgs []*Organization
	for rows.Next() {
		var org Organization
		var createdAt string
		if err := rows.Scan(&org.ID, &org.Name, &org.Slug, &org.LogoURL, &org.Settings, &createdAt); err != nil {
			return nil, err
		}
		org.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
		orgs = append(orgs, &org)
	}
	return orgs, rows.Err()
}

// ---------------------------------------------------------------------------
//  Org Address Books (shared contacts)
// ---------------------------------------------------------------------------

func (s *SQLiteDB) GetOrgAddressBook(orgID, abType string) (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var data string
	err := s.db.QueryRow(
		`SELECT data FROM org_address_books WHERE org_id = ? AND ab_type = ?`,
		orgID, abType,
	).Scan(&data)
	if err == sql.ErrNoRows {
		return "{}", nil
	}
	return data, err
}

func (s *SQLiteDB) SaveOrgAddressBook(orgID, abType, data, updatedBy string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`INSERT INTO org_address_books (org_id, ab_type, data, updated_at, updated_by)
		 VALUES (?, ?, ?, datetime('now'), ?)
		 ON CONFLICT(org_id, ab_type) DO UPDATE SET
		   data = excluded.data,
		   updated_at = excluded.updated_at,
		   updated_by = excluded.updated_by`,
		orgID, abType, data, updatedBy,
	)
	return err
}
