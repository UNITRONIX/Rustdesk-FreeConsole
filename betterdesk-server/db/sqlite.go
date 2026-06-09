package db

import (
	"database/sql"
	"fmt"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// SQLiteDB implements the Database interface using modernc.org/sqlite (pure Go, no CGO).
type SQLiteDB struct {
	db *sql.DB
	mu sync.RWMutex // serialize writes (SQLite limitation)
}

// OpenSQLite opens or creates a SQLite database at the given path.
func OpenSQLite(path string) (*SQLiteDB, error) {
	dsn := fmt.Sprintf("file:%s?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=ON", path)
	sqlDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("db: failed to open SQLite %q: %w", path, err)
	}
	sqlDB.SetMaxOpenConns(1) // SQLite single-writer
	sqlDB.SetMaxIdleConns(1)
	sqlDB.SetConnMaxLifetime(0) // keep alive

	if err := sqlDB.Ping(); err != nil {
		return nil, fmt.Errorf("db: SQLite ping failed: %w", err)
	}

	return &SQLiteDB{db: sqlDB}, nil
}

// Close closes the database connection.
func (s *SQLiteDB) Close() error {
	return s.db.Close()
}

// Migrate creates all required tables if they don't exist.
func (s *SQLiteDB) Migrate() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	statements := []string{
		`CREATE TABLE IF NOT EXISTS peers (
			id TEXT PRIMARY KEY,
			uuid TEXT DEFAULT '',
			pk BLOB DEFAULT NULL,
			ip TEXT DEFAULT '',
			user TEXT DEFAULT '',
			hostname TEXT DEFAULT '',
			os TEXT DEFAULT '',
			version TEXT DEFAULT '',
			status TEXT DEFAULT 'OFFLINE',
			nat_type INTEGER DEFAULT 0,
			last_online TEXT DEFAULT '',
			created_at TEXT DEFAULT (datetime('now')),
			disabled INTEGER DEFAULT 0,
			banned INTEGER DEFAULT 0,
			ban_reason TEXT DEFAULT '',
			banned_at TEXT DEFAULT NULL,
			soft_deleted INTEGER DEFAULT 0,
			deleted_at TEXT DEFAULT NULL,
			note TEXT DEFAULT '',
			tags TEXT DEFAULT '',
			heartbeat_seq INTEGER DEFAULT 0
		)`,
		`CREATE INDEX IF NOT EXISTS idx_peers_uuid ON peers(uuid)`,
		`CREATE INDEX IF NOT EXISTS idx_peers_status ON peers(status)`,

		`CREATE TABLE IF NOT EXISTS server_config (
			key TEXT PRIMARY KEY,
			value TEXT DEFAULT ''
		)`,

		`CREATE TABLE IF NOT EXISTS id_change_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			old_id TEXT NOT NULL,
			new_id TEXT NOT NULL,
			changed_at TEXT DEFAULT (datetime('now')),
			reason TEXT DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_id_history_old ON id_change_history(old_id)`,
		`CREATE INDEX IF NOT EXISTS idx_id_history_new ON id_change_history(new_id)`,

		// Users table (authentication)
		`CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT UNIQUE NOT NULL,
			password_hash TEXT NOT NULL,
			role TEXT NOT NULL DEFAULT 'viewer',
			auth_provider TEXT NOT NULL DEFAULT 'local',
			totp_secret TEXT DEFAULT '',
			totp_enabled INTEGER DEFAULT 0,
			totp_recovery_codes TEXT DEFAULT NULL,
			created_at TEXT DEFAULT (datetime('now')),
			last_login TEXT DEFAULT ''
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)`,

		// API keys table (scoped programmatic access)
		`CREATE TABLE IF NOT EXISTS api_keys (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			key_hash TEXT UNIQUE NOT NULL,
			key_prefix TEXT NOT NULL DEFAULT '',
			name TEXT NOT NULL DEFAULT '',
			role TEXT NOT NULL DEFAULT 'viewer',
			created_at TEXT DEFAULT (datetime('now')),
			expires_at TEXT DEFAULT '',
			last_used TEXT DEFAULT ''
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)`,

		// Device tokens table (Dual Key System for enhanced security)
		`CREATE TABLE IF NOT EXISTS device_tokens (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			token_hash TEXT UNIQUE NOT NULL,
			token_prefix TEXT NOT NULL DEFAULT '',
			name TEXT NOT NULL DEFAULT '',
			peer_id TEXT DEFAULT '',
			status TEXT NOT NULL DEFAULT 'pending',
			max_uses INTEGER DEFAULT 1,
			use_count INTEGER DEFAULT 0,
			created_at TEXT DEFAULT (datetime('now')),
			expires_at TEXT DEFAULT NULL,
			revoked_at TEXT DEFAULT NULL,
			last_used_at TEXT DEFAULT NULL,
			created_by TEXT DEFAULT '',
			note TEXT DEFAULT ''
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_device_tokens_hash ON device_tokens(token_hash)`,
		`CREATE INDEX IF NOT EXISTS idx_device_tokens_peer ON device_tokens(peer_id)`,
		`CREATE INDEX IF NOT EXISTS idx_device_tokens_status ON device_tokens(status)`,

		// Address books table (RustDesk client AB sync)
		`CREATE TABLE IF NOT EXISTS address_books (
			username TEXT NOT NULL,
			ab_type TEXT NOT NULL DEFAULT 'legacy',
			data TEXT DEFAULT '{}',
			updated_at TEXT DEFAULT (datetime('now')),
			PRIMARY KEY (username, ab_type)
		)`,

		// Peer metrics table (heartbeat CPU/memory/disk data)
		`CREATE TABLE IF NOT EXISTS peer_metrics (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			peer_id TEXT NOT NULL,
			cpu_usage REAL DEFAULT 0,
			memory_usage REAL DEFAULT 0,
			disk_usage REAL DEFAULT 0,
			created_at TEXT DEFAULT (datetime('now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_peer_metrics_peer ON peer_metrics(peer_id)`,
		`CREATE INDEX IF NOT EXISTS idx_peer_metrics_created ON peer_metrics(created_at)`,

		// Chat messages table
		`CREATE TABLE IF NOT EXISTS chat_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			conversation_id TEXT NOT NULL,
			from_id TEXT NOT NULL,
			from_name TEXT DEFAULT '',
			to_id TEXT DEFAULT '',
			text TEXT NOT NULL,
			read INTEGER DEFAULT 0,
			created_at TEXT DEFAULT (datetime('now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversation_id)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_messages_from ON chat_messages(from_id)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at)`,

		// Chat groups table
		`CREATE TABLE IF NOT EXISTS chat_groups (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			members TEXT DEFAULT '',
			created_by TEXT DEFAULT '',
			created_at TEXT DEFAULT (datetime('now'))
		)`,

		// Help requests table (support requests raised by agent devices)
		`CREATE TABLE IF NOT EXISTS help_requests (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			device_id TEXT NOT NULL,
			hostname TEXT DEFAULT '',
			org_id TEXT DEFAULT '',
			message TEXT DEFAULT '',
			status TEXT DEFAULT 'pending',
			handled_by TEXT DEFAULT '',
			created_at TEXT DEFAULT (datetime('now')),
			updated_at TEXT DEFAULT (datetime('now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_help_requests_device ON help_requests(device_id)`,
		`CREATE INDEX IF NOT EXISTS idx_help_requests_status ON help_requests(status)`,
		`CREATE INDEX IF NOT EXISTS idx_help_requests_created ON help_requests(created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_help_requests_org ON help_requests(org_id)`,

		// Organizations (v3.0.0)
		`CREATE TABLE IF NOT EXISTS organizations (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			slug TEXT UNIQUE NOT NULL,
			logo_url TEXT DEFAULT '',
			settings TEXT DEFAULT '{}',
			created_at TEXT DEFAULT (datetime('now'))
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug)`,

		// Organization users (v3.0.0)
		`CREATE TABLE IF NOT EXISTS org_users (
			id TEXT PRIMARY KEY,
			org_id TEXT NOT NULL REFERENCES organizations(id),
			username TEXT NOT NULL,
			display_name TEXT DEFAULT '',
			email TEXT DEFAULT '',
			password_hash TEXT NOT NULL,
			role TEXT DEFAULT 'user',
			totp_secret TEXT DEFAULT '',
			avatar_url TEXT DEFAULT '',
			last_login TEXT DEFAULT NULL,
			created_at TEXT DEFAULT (datetime('now')),
			UNIQUE(org_id, username)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_org_users_org ON org_users(org_id)`,

		// Organization devices (v3.0.0)
		`CREATE TABLE IF NOT EXISTS org_devices (
			org_id TEXT NOT NULL REFERENCES organizations(id),
			device_id TEXT NOT NULL,
			assigned_user_id TEXT DEFAULT '',
			department TEXT DEFAULT '',
			location TEXT DEFAULT '',
			building TEXT DEFAULT '',
			tags TEXT DEFAULT '',
			PRIMARY KEY(org_id, device_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_org_devices_org ON org_devices(org_id)`,
		`CREATE INDEX IF NOT EXISTS idx_org_devices_device ON org_devices(device_id)`,

		// Organization invitations (v3.0.0)
		`CREATE TABLE IF NOT EXISTS org_invitations (
			id TEXT PRIMARY KEY,
			org_id TEXT NOT NULL REFERENCES organizations(id),
			token TEXT UNIQUE NOT NULL,
			email TEXT DEFAULT '',
			role TEXT DEFAULT 'user',
			expires_at TEXT NOT NULL,
			used_at TEXT DEFAULT NULL
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_invitations_token ON org_invitations(token)`,

		// Organization settings (v3.0.0)
		`CREATE TABLE IF NOT EXISTS org_settings (
			org_id TEXT NOT NULL REFERENCES organizations(id),
			key TEXT NOT NULL,
			value TEXT DEFAULT '',
			PRIMARY KEY(org_id, key)
		)`,
		`CREATE TABLE IF NOT EXISTS access_policies (
			peer_id TEXT PRIMARY KEY,
			unattended_enabled INTEGER DEFAULT 0,
			password_hash TEXT DEFAULT '',
			schedule_enabled INTEGER DEFAULT 0,
			schedule_days TEXT DEFAULT '',
			schedule_start_time TEXT DEFAULT '',
			schedule_end_time TEXT DEFAULT '',
			schedule_timezone TEXT DEFAULT '',
			allowed_operators TEXT DEFAULT '',
			updated_at TEXT DEFAULT '',
			updated_by TEXT DEFAULT ''
		)`,

		// Role permissions (RBAC Phase 52) — custom permission overrides per role
		`CREATE TABLE IF NOT EXISTS role_permissions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			role TEXT NOT NULL,
			permission TEXT NOT NULL,
			granted INTEGER NOT NULL DEFAULT 1,
			UNIQUE(role, permission)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role)`,

		// Audit logs (RustDesk client reporting — API-port consolidation Phase A)
		`CREATE TABLE IF NOT EXISTS audit_connections (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			host_id TEXT NOT NULL,
			host_uuid TEXT DEFAULT '',
			peer_id TEXT DEFAULT '',
			peer_name TEXT DEFAULT '',
			action TEXT NOT NULL DEFAULT '',
			conn_type INTEGER DEFAULT 0,
			session_id TEXT DEFAULT '',
			ip TEXT DEFAULT '',
			created_at TEXT DEFAULT (datetime('now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_conn_host ON audit_connections(host_id, created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_conn_peer ON audit_connections(peer_id, created_at)`,

		`CREATE TABLE IF NOT EXISTS audit_files (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			host_id TEXT NOT NULL,
			host_uuid TEXT DEFAULT '',
			peer_id TEXT DEFAULT '',
			direction INTEGER DEFAULT 0,
			path TEXT DEFAULT '',
			is_file INTEGER DEFAULT 1,
			num_files INTEGER DEFAULT 0,
			files_json TEXT DEFAULT '[]',
			ip TEXT DEFAULT '',
			peer_name TEXT DEFAULT '',
			created_at TEXT DEFAULT (datetime('now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_files_host ON audit_files(host_id, created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_files_peer ON audit_files(peer_id, created_at)`,

		`CREATE TABLE IF NOT EXISTS audit_alarms (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			alarm_type INTEGER NOT NULL DEFAULT 0,
			alarm_name TEXT DEFAULT '',
			host_id TEXT DEFAULT '',
			peer_id TEXT DEFAULT '',
			ip TEXT DEFAULT '',
			details TEXT DEFAULT '{}',
			created_at TEXT DEFAULT (datetime('now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_alarms_type ON audit_alarms(alarm_type, created_at)`,

		// Billing / commercialization module
		`CREATE TABLE IF NOT EXISTS billing_packages (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			description TEXT DEFAULT '',
			included_minutes INTEGER NOT NULL DEFAULT 0,
			overage_rate REAL NOT NULL DEFAULT 0,
			currency TEXT NOT NULL DEFAULT 'PLN',
			created_at TEXT DEFAULT (datetime('now')),
			updated_at TEXT DEFAULT (datetime('now'))
		)`,
		`CREATE TABLE IF NOT EXISTS billing_org_contracts (
			id TEXT PRIMARY KEY,
			org_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active',
			remaining_minutes INTEGER NOT NULL DEFAULT 0,
			overage_rate REAL,
			hourly_rate REAL NOT NULL DEFAULT 0,
			currency TEXT NOT NULL DEFAULT 'PLN',
			valid_from TEXT,
			valid_until TEXT,
			created_at TEXT DEFAULT (datetime('now')),
			updated_at TEXT DEFAULT (datetime('now')),
			FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
			FOREIGN KEY (package_id) REFERENCES billing_packages(id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_billing_contracts_org ON billing_org_contracts(org_id)`,
		`CREATE TABLE IF NOT EXISTS billing_sessions (
			id TEXT PRIMARY KEY,
			org_id TEXT NOT NULL,
			contract_id TEXT NOT NULL DEFAULT '',
			operator_id TEXT NOT NULL DEFAULT '',
			operator_name TEXT NOT NULL DEFAULT '',
			device_id TEXT NOT NULL,
			device_name TEXT NOT NULL DEFAULT '',
			relay_uuid TEXT NOT NULL DEFAULT '',
			transport TEXT NOT NULL DEFAULT 'rustdesk',
			status TEXT NOT NULL DEFAULT 'active',
			billing_phase TEXT NOT NULL DEFAULT 'included',
			started_at TEXT NOT NULL,
			ended_at TEXT,
			raw_seconds INTEGER NOT NULL DEFAULT 0,
			billed_minutes INTEGER NOT NULL DEFAULT 0,
			included_minutes_used INTEGER NOT NULL DEFAULT 0,
			overage_minutes INTEGER NOT NULL DEFAULT 0,
			amount_included REAL NOT NULL DEFAULT 0,
			amount_overage REAL NOT NULL DEFAULT 0,
			currency TEXT NOT NULL DEFAULT 'PLN',
			clock_offset_ms_at_start INTEGER NOT NULL DEFAULT 0,
			clock_synced_at_start INTEGER NOT NULL DEFAULT 1,
			created_at TEXT DEFAULT (datetime('now')),
			updated_at TEXT DEFAULT (datetime('now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_billing_sessions_org ON billing_sessions(org_id, started_at)`,
		`CREATE INDEX IF NOT EXISTS idx_billing_sessions_relay ON billing_sessions(relay_uuid)`,
		`CREATE TABLE IF NOT EXISTS billing_session_ledger (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			event_type TEXT NOT NULL,
			details TEXT DEFAULT '',
			created_at TEXT DEFAULT (datetime('now'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_billing_ledger_session ON billing_session_ledger(session_id)`,
		`CREATE TABLE IF NOT EXISTS billing_work_reports (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL UNIQUE,
			operator_id TEXT NOT NULL DEFAULT '',
			summary TEXT NOT NULL,
			category TEXT DEFAULT '',
			ticket_ref TEXT DEFAULT '',
			created_at TEXT DEFAULT (datetime('now'))
		)`,
		`CREATE TABLE IF NOT EXISTS billing_currencies (
			code TEXT PRIMARY KEY,
			symbol TEXT NOT NULL DEFAULT '',
			exchange_rate_to_base REAL NOT NULL DEFAULT 1
		)`,

		// User/device groups + strategies (API-port consolidation Phase A)
		`CREATE TABLE IF NOT EXISTS user_groups (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			guid TEXT UNIQUE NOT NULL,
			name TEXT NOT NULL,
			note TEXT DEFAULT '',
			team_id TEXT DEFAULT '',
			created_at TEXT DEFAULT (datetime('now'))
		)`,
		`CREATE TABLE IF NOT EXISTS device_groups (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			guid TEXT UNIQUE NOT NULL,
			name TEXT NOT NULL,
			note TEXT DEFAULT '',
			team_id TEXT DEFAULT '',
			source_type TEXT DEFAULT 'manual',
			tag_filter TEXT DEFAULT '',
			created_at TEXT DEFAULT (datetime('now'))
		)`,
		`CREATE TABLE IF NOT EXISTS strategies (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			guid TEXT UNIQUE NOT NULL,
			name TEXT NOT NULL,
			user_group_guid TEXT DEFAULT '',
			device_group_guid TEXT DEFAULT '',
			enabled INTEGER DEFAULT 1,
			permissions TEXT DEFAULT '{}',
			created_at TEXT DEFAULT (datetime('now')),
			updated_at TEXT DEFAULT (datetime('now'))
		)`,
	}

	for _, stmt := range statements {
		if _, err := s.db.Exec(stmt); err != nil {
			return fmt.Errorf("db: migration failed: %w\nStatement: %s", err, stmt)
		}
	}

	// Incremental column migrations for existing databases.
	// SQLite does not support ADD COLUMN IF NOT EXISTS, so we check PRAGMA table_info first.
	columnMigrations := []struct {
		table  string
		column string
		ddl    string
	}{
		// users: TOTP 2FA columns (added in v2.3.0)
		{"users", "totp_secret", `ALTER TABLE users ADD COLUMN totp_secret TEXT DEFAULT ''`},
		{"users", "totp_enabled", `ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0`},
		{"users", "totp_recovery_codes", `ALTER TABLE users ADD COLUMN totp_recovery_codes TEXT DEFAULT NULL`},
		// peers: ban columns (added in v2.1.0)
		{"peers", "banned", `ALTER TABLE peers ADD COLUMN banned INTEGER DEFAULT 0`},
		{"peers", "ban_reason", `ALTER TABLE peers ADD COLUMN ban_reason TEXT DEFAULT ''`},
		{"peers", "banned_at", `ALTER TABLE peers ADD COLUMN banned_at TEXT DEFAULT NULL`},
		// peers: tags (added in v2.2.0)
		{"peers", "tags", `ALTER TABLE peers ADD COLUMN tags TEXT DEFAULT ''`},
		// peers: heartbeat_seq (added in v2.3.0)
		{"peers", "heartbeat_seq", `ALTER TABLE peers ADD COLUMN heartbeat_seq INTEGER DEFAULT 0`},
		// peers: CDAP device type and linked peer (added in v2.5.0)
		{"peers", "device_type", `ALTER TABLE peers ADD COLUMN device_type TEXT DEFAULT ''`},
		{"peers", "linked_peer_id", `ALTER TABLE peers ADD COLUMN linked_peer_id TEXT DEFAULT ''`},
		// peers: display_name alias (added in v2.6.0)
		{"peers", "display_name", `ALTER TABLE peers ADD COLUMN display_name TEXT DEFAULT ''`},
		// users: is_server_admin flag (RBAC Phase 52)
		{"users", "is_server_admin", `ALTER TABLE users ADD COLUMN is_server_admin INTEGER DEFAULT 0`},
		{"users", "auth_provider", `ALTER TABLE users ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'local'`},
		// org_users: server_user_id for linking existing users (Issue #106)
		{"org_users", "server_user_id", `ALTER TABLE org_users ADD COLUMN server_user_id INTEGER DEFAULT 0`},
	}

	for _, m := range columnMigrations {
		if !s.hasColumn(m.table, m.column) {
			if _, err := s.db.Exec(m.ddl); err != nil {
				// Ignore "duplicate column" errors — race-safe
				if !strings.Contains(err.Error(), "duplicate column") {
					return fmt.Errorf("db: column migration failed (%s.%s): %w", m.table, m.column, err)
				}
			}
		}
	}

	// Deferred indexes — created after column migrations to avoid
	// "no such column" errors on legacy databases.
	deferredIndexes := []string{
		`CREATE INDEX IF NOT EXISTS idx_peers_banned ON peers(banned)`,
		`CREATE INDEX IF NOT EXISTS idx_peers_soft_deleted ON peers(soft_deleted)`,
		`CREATE INDEX IF NOT EXISTS idx_peers_linked_peer ON peers(linked_peer_id)`,
		`CREATE INDEX IF NOT EXISTS idx_peer_metrics_peer_created ON peer_metrics(peer_id, created_at DESC)`,
	}
	for _, idx := range deferredIndexes {
		if _, err := s.db.Exec(idx); err != nil {
			return fmt.Errorf("db: deferred index failed: %w\nStatement: %s", err, idx)
		}
	}

	// Billing: backfill NULL optional text columns (SQLite cannot ALTER to add NOT NULL).
	billingNullBackfills := []string{
		`UPDATE billing_sessions SET contract_id = '' WHERE contract_id IS NULL`,
		`UPDATE billing_sessions SET operator_name = '' WHERE operator_name IS NULL`,
		`UPDATE billing_sessions SET device_name = '' WHERE device_name IS NULL`,
		`UPDATE billing_sessions SET relay_uuid = '' WHERE relay_uuid IS NULL`,
	}
	for _, stmt := range billingNullBackfills {
		if _, err := s.db.Exec(stmt); err != nil {
			return fmt.Errorf("db: billing null backfill failed: %w\nStatement: %s", err, stmt)
		}
	}

	return nil
}

// safeIdentifier validates that a string is a safe SQL identifier (letters, digits, underscores).
func safeIdentifier(name string) bool {
	if len(name) == 0 || len(name) > 64 {
		return false
	}
	for _, c := range name {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_') {
			return false
		}
	}
	return true
}

// hasColumn checks if a column exists in a table using PRAGMA table_info.
func (s *SQLiteDB) hasColumn(table, column string) bool {
	if !safeIdentifier(table) {
		return false
	}
	rows, err := s.db.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return false
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull int
		var dfltValue sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dfltValue, &pk); err != nil {
			continue
		}
		if strings.EqualFold(name, column) {
			return true
		}
	}
	return false
}

// GetPeer returns a peer by ID, or nil if not found.
func (s *SQLiteDB) GetPeer(id string) (*Peer, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	p := &Peer{}
	var lastOnline, createdAt, bannedAt, deletedAt sql.NullString

	err := s.db.QueryRow(`
		SELECT id, uuid, pk, ip, user, hostname, os, version, 
		       status, nat_type, last_online, created_at,
		       disabled, banned, ban_reason, banned_at,
		       soft_deleted, deleted_at, note, tags, heartbeat_seq,
		       device_type, linked_peer_id, display_name
		FROM peers WHERE id = ? AND (soft_deleted IS NULL OR soft_deleted = 0)`, id).Scan(
		&p.ID, &p.UUID, &p.PK, &p.IP, &p.User, &p.Hostname,
		&p.OS, &p.Version, &p.Status, &p.NATType,
		&lastOnline, &createdAt, &p.Disabled, &p.Banned,
		&p.BanReason, &bannedAt, &p.SoftDeleted, &deletedAt,
		&p.Note, &p.Tags, &p.HeartbeatSeq,
		&p.DeviceType, &p.LinkedPeerID, &p.DisplayName,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("db: GetPeer(%q): %w", id, err)
	}

	p.LastOnline = parseTime(lastOnline)
	p.CreatedAt = parseTime(createdAt)
	p.BannedAt = parseTimePtr(bannedAt)
	p.DeletedAt = parseTimePtr(deletedAt)

	return p, nil
}

// GetPeerByUUID returns a peer by UUID, or nil if not found.
func (s *SQLiteDB) GetPeerByUUID(uuid string) (*Peer, error) {
	s.mu.RLock()
	var id string
	err := s.db.QueryRow(`SELECT id FROM peers WHERE uuid = ?`, uuid).Scan(&id)
	s.mu.RUnlock()

	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	return s.GetPeer(id)
}

// UpsertPeer inserts or updates a peer record.
func (s *SQLiteDB) UpsertPeer(p *Peer) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`
		INSERT INTO peers (id, uuid, pk, ip, user, hostname, os, version, 
		                    status, nat_type, last_online, disabled, note, tags, heartbeat_seq)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			uuid = COALESCE(NULLIF(excluded.uuid, ''), peers.uuid),
			pk = COALESCE(excluded.pk, peers.pk),
			ip = excluded.ip,
			user = COALESCE(NULLIF(excluded.user, ''), peers.user),
			hostname = COALESCE(NULLIF(excluded.hostname, ''), peers.hostname),
			os = COALESCE(NULLIF(excluded.os, ''), peers.os),
			version = COALESCE(NULLIF(excluded.version, ''), peers.version),
			status = excluded.status,
			nat_type = excluded.nat_type,
			last_online = excluded.last_online,
			disabled = excluded.disabled,
			note = COALESCE(NULLIF(excluded.note, ''), peers.note),
			tags = COALESCE(NULLIF(excluded.tags, ''), peers.tags),
			heartbeat_seq = excluded.heartbeat_seq`,
		/* SECURITY (GHSA-3v82-3gf8-fxx8): UpsertPeer MUST NOT silently clear
		   soft_deleted/deleted_at on conflict. Doing so allows any successful
		   registration to undo an administrator's deletion. Restoration is now
		   an explicit operation — see RestorePeer. */
		p.ID, p.UUID, p.PK, p.IP, p.User, p.Hostname, p.OS, p.Version,
		p.Status, p.NATType, formatTime(p.LastOnline),
		p.Disabled, p.Note, p.Tags, p.HeartbeatSeq,
	)
	if err != nil {
		return fmt.Errorf("db: UpsertPeer(%q): %w", p.ID, err)
	}
	return nil
}

// DeletePeer marks a peer as soft-deleted.
func (s *SQLiteDB) DeletePeer(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`UPDATE peers SET soft_deleted = 1, deleted_at = datetime('now') WHERE id = ?`, id)
	return err
}

// HardDeletePeer permanently removes a peer from the database.
func (s *SQLiteDB) HardDeletePeer(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`DELETE FROM peers WHERE id = ?`, id)
	return err
}

// ListPeers returns all peers, optionally including soft-deleted ones.
func (s *SQLiteDB) ListPeers(includeDeleted bool) ([]*Peer, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	query := `SELECT id, uuid, pk, ip, user, hostname, os, version,
	                  status, nat_type, last_online, created_at,
	                  disabled, banned, ban_reason, banned_at,
	                  soft_deleted, deleted_at, note, tags, heartbeat_seq,
	                  device_type, linked_peer_id, display_name
	           FROM peers`
	if !includeDeleted {
		query += ` WHERE soft_deleted = 0`
	}
	query += ` ORDER BY id`

	rows, err := s.db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("db: ListPeers: %w", err)
	}
	defer rows.Close()

	var peers []*Peer
	for rows.Next() {
		p := &Peer{}
		var lastOnline, createdAt, bannedAt, deletedAt sql.NullString
		if err := rows.Scan(
			&p.ID, &p.UUID, &p.PK, &p.IP, &p.User, &p.Hostname,
			&p.OS, &p.Version, &p.Status, &p.NATType,
			&lastOnline, &createdAt, &p.Disabled, &p.Banned,
			&p.BanReason, &bannedAt, &p.SoftDeleted, &deletedAt,
			&p.Note, &p.Tags, &p.HeartbeatSeq,
			&p.DeviceType, &p.LinkedPeerID, &p.DisplayName,
		); err != nil {
			return nil, fmt.Errorf("db: ListPeers scan: %w", err)
		}
		p.LastOnline = parseTime(lastOnline)
		p.CreatedAt = parseTime(createdAt)
		p.BannedAt = parseTimePtr(bannedAt)
		p.DeletedAt = parseTimePtr(deletedAt)
		peers = append(peers, p)
	}
	return peers, rows.Err()
}

// GetPeerCount returns total and online peer counts.
func (s *SQLiteDB) GetPeerCount() (total int, online int, err error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	err = s.db.QueryRow(
		`SELECT COUNT(*) FROM peers WHERE soft_deleted = 0`).Scan(&total)
	if err != nil {
		return 0, 0, err
	}
	err = s.db.QueryRow(
		`SELECT COUNT(*) FROM peers WHERE soft_deleted = 0 AND status = 'ONLINE'`).Scan(&online)
	return total, online, err
}

// GetBannedPeerCount returns the number of banned peers in the database.
func (s *SQLiteDB) GetBannedPeerCount() (int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var count int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM peers WHERE banned = 1 AND soft_deleted = 0`).Scan(&count)
	return count, err
}

// UpdatePeerStatus updates a peer's status and IP, plus last_online timestamp.
func (s *SQLiteDB) UpdatePeerStatus(id string, status string, ip string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`UPDATE peers SET status = ?, ip = ?, last_online = datetime('now') WHERE id = ? AND soft_deleted = 0`,
		status, ip, id)
	return err
}

// UpdatePeerSysinfo updates hostname, os, and version for a peer.
// Only non-empty values overwrite existing data.
func (s *SQLiteDB) UpdatePeerSysinfo(id, hostname, os, version string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`
		UPDATE peers SET
			hostname = CASE WHEN ? != '' THEN ? ELSE hostname END,
			os = CASE WHEN ? != '' THEN ? ELSE os END,
			version = CASE WHEN ? != '' THEN ? ELSE version END
		WHERE id = ?`,
		hostname, hostname, os, os, version, version, id)
	return err
}

// SetAllOffline marks all peers as OFFLINE. Called at server startup.
func (s *SQLiteDB) SetAllOffline() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`UPDATE peers SET status = 'OFFLINE'`)
	return err
}

// BanPeer bans a specific peer by ID.
func (s *SQLiteDB) BanPeer(id string, reason string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`UPDATE peers SET banned = 1, ban_reason = ?, banned_at = datetime('now') WHERE id = ?`,
		reason, id)
	return err
}

// UnbanPeer removes the ban from a peer.
func (s *SQLiteDB) UnbanPeer(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`UPDATE peers SET banned = 0, ban_reason = '', banned_at = NULL WHERE id = ?`, id)
	return err
}

// IsPeerBanned checks if a peer is banned.
func (s *SQLiteDB) IsPeerBanned(id string) (bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var banned bool
	err := s.db.QueryRow(`SELECT banned FROM peers WHERE id = ?`, id).Scan(&banned)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return banned, err
}

// IsPeerSoftDeleted checks if a peer is soft-deleted.
func (s *SQLiteDB) IsPeerSoftDeleted(id string) (bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var deleted bool
	err := s.db.QueryRow(`SELECT soft_deleted FROM peers WHERE id = ?`, id).Scan(&deleted)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return deleted, err
}

// RestorePeer clears soft_deleted and deleted_at for a previously deleted
// peer. Required because UpsertPeer no longer does this implicitly
// (GHSA-3v82-3gf8-fxx8).
func (s *SQLiteDB) RestorePeer(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`UPDATE peers SET soft_deleted = 0, deleted_at = NULL WHERE id = ?`,
		id)
	return err
}

// UpdatePeerFields updates specific peer fields (note, user, tags, device_type, linked_peer_id, display_name).
// Only provided keys are updated; others are left unchanged.
// Allowed keys: "note", "user", "tags", "device_type", "linked_peer_id".
func (s *SQLiteDB) UpdatePeerFields(id string, fields map[string]string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	allowed := map[string]bool{"note": true, "user": true, "tags": true, "device_type": true, "linked_peer_id": true, "display_name": true}
	setClauses := []string{}
	args := []interface{}{}
	for k, v := range fields {
		if !allowed[k] {
			continue
		}
		setClauses = append(setClauses, k+" = ?")
		args = append(args, v)
	}
	if len(setClauses) == 0 {
		return nil
	}
	args = append(args, id)
	query := "UPDATE peers SET " + strings.Join(setClauses, ", ") + " WHERE id = ? AND soft_deleted = 0"
	_, err := s.db.Exec(query, args...)
	return err
}

// ChangePeerID changes a peer's ID and records it in history.
func (s *SQLiteDB) ChangePeerID(oldID, newID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Check new ID doesn't exist
	var count int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM peers WHERE id = ?`, newID).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return fmt.Errorf("db: peer ID %q already exists", newID)
	}

	// Create new row with new ID, copy data from old
	_, err = tx.Exec(`
		INSERT INTO peers (id, uuid, pk, ip, user, hostname, os, version,
		                    status, nat_type, last_online, created_at,
		                    disabled, banned, ban_reason, banned_at,
		                    soft_deleted, deleted_at, note, tags, heartbeat_seq,
		                    device_type, linked_peer_id, display_name)
		SELECT ?, uuid, pk, ip, user, hostname, os, version,
		       status, nat_type, last_online, created_at,
		       disabled, banned, ban_reason, banned_at,
		       soft_deleted, deleted_at, note, tags, heartbeat_seq,
		       device_type, linked_peer_id, display_name
		FROM peers WHERE id = ?`, newID, oldID)
	if err != nil {
		return fmt.Errorf("db: ChangePeerID insert: %w", err)
	}

	// Delete old row
	if _, err := tx.Exec(`DELETE FROM peers WHERE id = ?`, oldID); err != nil {
		return fmt.Errorf("db: ChangePeerID delete: %w", err)
	}

	// Record in history
	if _, err := tx.Exec(
		`INSERT INTO id_change_history (old_id, new_id) VALUES (?, ?)`,
		oldID, newID); err != nil {
		return fmt.Errorf("db: ChangePeerID history: %w", err)
	}

	return tx.Commit()
}

// GetIDChangeHistory returns the ID change history for a peer.
func (s *SQLiteDB) GetIDChangeHistory(id string) ([]*IDChangeHistory, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rows, err := s.db.Query(
		`SELECT old_id, new_id, changed_at, reason FROM id_change_history
		 WHERE old_id = ? OR new_id = ? ORDER BY changed_at DESC`, id, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var history []*IDChangeHistory
	for rows.Next() {
		h := &IDChangeHistory{}
		var changedAt string
		if err := rows.Scan(&h.OldID, &h.NewID, &changedAt, &h.Reason); err != nil {
			return nil, err
		}
		h.ChangedAt, _ = time.Parse("2006-01-02 15:04:05", changedAt)
		history = append(history, h)
	}
	return history, rows.Err()
}

// IsRenamedPeerID returns true if the given ID was previously used and then
// changed to a different one (appears as old_id in id_change_history).
// This prevents a device from re-registering under its old ID after an
// admin-initiated ID change (#97).
func (s *SQLiteDB) IsRenamedPeerID(id string) (bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM id_change_history WHERE old_id = ?`, id).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// GetLinkedPeers returns all non-deleted peers that have linked_peer_id matching the given ID.
func (s *SQLiteDB) GetLinkedPeers(id string) ([]*Peer, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rows, err := s.db.Query(`
		SELECT id, uuid, pk, ip, user, hostname, os, version, status, nat_type,
		       last_online, created_at, disabled, banned, ban_reason, banned_at,
		       soft_deleted, deleted_at, note, tags, heartbeat_seq,
		       device_type, linked_peer_id, display_name
		FROM peers
		WHERE soft_deleted = 0 AND linked_peer_id = ?
		ORDER BY id`, id)
	if err != nil {
		return nil, fmt.Errorf("db: GetLinkedPeers: %w", err)
	}
	defer rows.Close()

	var peers []*Peer
	for rows.Next() {
		p := &Peer{}
		var lastOnline, createdAt, bannedAt, deletedAt sql.NullString
		if err := rows.Scan(
			&p.ID, &p.UUID, &p.PK, &p.IP, &p.User, &p.Hostname,
			&p.OS, &p.Version, &p.Status, &p.NATType,
			&lastOnline, &createdAt, &p.Disabled, &p.Banned,
			&p.BanReason, &bannedAt, &p.SoftDeleted, &deletedAt,
			&p.Note, &p.Tags, &p.HeartbeatSeq,
			&p.DeviceType, &p.LinkedPeerID, &p.DisplayName,
		); err != nil {
			return nil, fmt.Errorf("db: GetLinkedPeers scan: %w", err)
		}
		p.LastOnline = parseTime(lastOnline)
		p.CreatedAt = parseTime(createdAt)
		p.BannedAt = parseTimePtr(bannedAt)
		p.DeletedAt = parseTimePtr(deletedAt)
		peers = append(peers, p)
	}
	return peers, rows.Err()
}

// GetConfig retrieves a configuration value by key.
func (s *SQLiteDB) GetConfig(key string) (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var value string
	err := s.db.QueryRow(`SELECT value FROM server_config WHERE key = ?`, key).Scan(&value)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return value, err
}

// SetConfig sets a configuration key-value pair.
func (s *SQLiteDB) SetConfig(key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`INSERT INTO server_config (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value)
	return err
}

// DeleteConfig removes a configuration key.
func (s *SQLiteDB) DeleteConfig(key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`DELETE FROM server_config WHERE key = ?`, key)
	return err
}

// ListConfigByPrefix returns all configuration entries whose key starts with the given prefix.
func (s *SQLiteDB) ListConfigByPrefix(prefix string) ([]ServerConfig, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rows, err := s.db.Query(`SELECT key, value FROM server_config WHERE key LIKE ?`,
		prefix+"%")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var configs []ServerConfig
	for rows.Next() {
		var c ServerConfig
		if err := rows.Scan(&c.Key, &c.Value); err != nil {
			return nil, err
		}
		configs = append(configs, c)
	}
	return configs, rows.Err()
}

// UpdatePeerTags updates the tags field for a peer.
func (s *SQLiteDB) UpdatePeerTags(id, tags string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	res, err := s.db.Exec(`UPDATE peers SET tags = ? WHERE id = ?`, tags, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("peer %s not found", id)
	}
	return nil
}

// ListPeersByTag returns all non-deleted peers that have the given tag.
// Tags are stored as comma-separated strings; the query uses LIKE matching.
func (s *SQLiteDB) ListPeersByTag(tag string) ([]*Peer, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	// M1: Escape SQL LIKE wildcards to prevent pattern injection.
	// '%' and '_' in user-supplied tag could match unintended rows.
	escaped := strings.NewReplacer("%", "\\%", "_", "\\_").Replace(tag)
	pattern := "%" + escaped + "%"
	rows, err := s.db.Query(`
		SELECT id, uuid, pk, ip, user, hostname, os, version, status, nat_type,
		       last_online, created_at, disabled, banned, ban_reason, banned_at,
		       soft_deleted, deleted_at, note, tags, heartbeat_seq,
		       device_type, linked_peer_id, display_name
		FROM peers
		WHERE soft_deleted = 0 AND tags LIKE ? ESCAPE '\'
		ORDER BY id`, pattern)
	if err != nil {
		return nil, fmt.Errorf("db: ListPeersByTag: %w", err)
	}
	defer rows.Close()

	var peers []*Peer
	for rows.Next() {
		p := &Peer{}
		var lastOnline, createdAt, bannedAt, deletedAt sql.NullString
		if err := rows.Scan(
			&p.ID, &p.UUID, &p.PK, &p.IP, &p.User, &p.Hostname,
			&p.OS, &p.Version, &p.Status, &p.NATType,
			&lastOnline, &createdAt, &p.Disabled, &p.Banned,
			&p.BanReason, &bannedAt, &p.SoftDeleted, &deletedAt,
			&p.Note, &p.Tags, &p.HeartbeatSeq,
			&p.DeviceType, &p.LinkedPeerID, &p.DisplayName,
		); err != nil {
			return nil, fmt.Errorf("db: ListPeersByTag scan: %w", err)
		}
		p.LastOnline = parseTime(lastOnline)
		p.CreatedAt = parseTime(createdAt)
		p.BannedAt = parseTimePtr(bannedAt)
		p.DeletedAt = parseTimePtr(deletedAt)
		peers = append(peers, p)
	}
	return peers, rows.Err()
}

// Helper: parse SQLite datetime to time.Time
func parseTime(ns sql.NullString) time.Time {
	if !ns.Valid || ns.String == "" {
		return time.Time{}
	}
	t, _ := time.Parse("2006-01-02 15:04:05", ns.String)
	return t
}

func parseTimePtr(ns sql.NullString) *time.Time {
	if !ns.Valid || ns.String == "" {
		return nil
	}
	t, _ := time.Parse("2006-01-02 15:04:05", ns.String)
	return &t
}

func formatTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format("2006-01-02 15:04:05")
}

// --- User Operations ---

// CreateUser inserts a new user.
func (s *SQLiteDB) CreateUser(u *User) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if u.AuthProvider == "" {
		u.AuthProvider = AuthProviderLocal
	}
	res, err := s.db.Exec(`INSERT INTO users (username, password_hash, role, auth_provider, totp_secret, totp_enabled)
		VALUES (?, ?, ?, ?, ?, ?)`,
		u.Username, u.PasswordHash, u.Role, u.AuthProvider, u.TOTPSecret, u.TOTPEnabled)
	if err != nil {
		return fmt.Errorf("db: CreateUser: %w", err)
	}
	u.ID, _ = res.LastInsertId()
	return nil
}

// GetUser returns a user by username, or nil if not found.
func (s *SQLiteDB) GetUser(username string) (*User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u := &User{}
	err := s.db.QueryRow(`SELECT id, username, password_hash, role, COALESCE(is_server_admin, 0),
		COALESCE(auth_provider, 'local'), totp_secret, totp_enabled, COALESCE(totp_recovery_codes, ''), created_at, last_login FROM users WHERE username = ?`, username).Scan(
		&u.ID, &u.Username, &u.PasswordHash, &u.Role, &u.IsServerAdmin,
		&u.AuthProvider, &u.TOTPSecret, &u.TOTPEnabled, &u.TOTPRecoveryCodes, &u.CreatedAt, &u.LastLogin)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return u, err
}

// GetUserByID returns a user by numeric ID, or nil if not found.
func (s *SQLiteDB) GetUserByID(id int64) (*User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u := &User{}
	err := s.db.QueryRow(`SELECT id, username, password_hash, role, COALESCE(is_server_admin, 0),
		COALESCE(auth_provider, 'local'), totp_secret, totp_enabled, COALESCE(totp_recovery_codes, ''), created_at, last_login FROM users WHERE id = ?`, id).Scan(
		&u.ID, &u.Username, &u.PasswordHash, &u.Role, &u.IsServerAdmin,
		&u.AuthProvider, &u.TOTPSecret, &u.TOTPEnabled, &u.TOTPRecoveryCodes, &u.CreatedAt, &u.LastLogin)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return u, err
}

// ListUsers returns all users.
func (s *SQLiteDB) ListUsers() ([]*User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows, err := s.db.Query(`SELECT id, username, password_hash, role, COALESCE(is_server_admin, 0),
		COALESCE(auth_provider, 'local'), totp_secret, totp_enabled, COALESCE(totp_recovery_codes, ''), created_at, last_login FROM users ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("db: ListUsers: %w", err)
	}
	defer rows.Close()
	var users []*User
	for rows.Next() {
		u := &User{}
		if err := rows.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.Role, &u.IsServerAdmin,
			&u.AuthProvider, &u.TOTPSecret, &u.TOTPEnabled, &u.TOTPRecoveryCodes, &u.CreatedAt, &u.LastLogin); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

// UpdateUser updates a user's mutable fields.
func (s *SQLiteDB) UpdateUser(u *User) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if u.AuthProvider == "" {
		u.AuthProvider = AuthProviderLocal
	}
	_, err := s.db.Exec(`UPDATE users SET password_hash=?, role=?, is_server_admin=?, auth_provider=?,
		totp_secret=?, totp_enabled=?, totp_recovery_codes=? WHERE id=?`,
		u.PasswordHash, u.Role, u.IsServerAdmin, u.AuthProvider, u.TOTPSecret, u.TOTPEnabled, u.TOTPRecoveryCodes, u.ID)
	return err
}

// DeleteUser removes a user by ID.
func (s *SQLiteDB) DeleteUser(id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`DELETE FROM users WHERE id=?`, id)
	return err
}

// UpdateUserLogin updates the last_login timestamp for a user.
func (s *SQLiteDB) UpdateUserLogin(id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE users SET last_login=datetime('now') WHERE id=?`, id)
	return err
}

// UserCount returns the total number of users.
func (s *SQLiteDB) UserCount() (int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count)
	return count, err
}

// --- API Key Operations ---

// CreateAPIKey inserts a new API key.
func (s *SQLiteDB) CreateAPIKey(k *APIKey) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`INSERT INTO api_keys (key_hash, key_prefix, name, role, expires_at)
		VALUES (?, ?, ?, ?, ?)`,
		k.KeyHash, k.KeyPrefix, k.Name, k.Role, k.ExpiresAt)
	if err != nil {
		return fmt.Errorf("db: CreateAPIKey: %w", err)
	}
	k.ID, _ = res.LastInsertId()
	return nil
}

// GetAPIKeyByHash returns an API key by its SHA-256 hash, or nil if not found.
func (s *SQLiteDB) GetAPIKeyByHash(keyHash string) (*APIKey, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	k := &APIKey{}
	err := s.db.QueryRow(`SELECT id, key_hash, key_prefix, name, role, created_at, expires_at, last_used
		FROM api_keys WHERE key_hash = ?`, keyHash).Scan(
		&k.ID, &k.KeyHash, &k.KeyPrefix, &k.Name, &k.Role,
		&k.CreatedAt, &k.ExpiresAt, &k.LastUsed)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return k, err
}

// ListAPIKeys returns all API keys.
func (s *SQLiteDB) ListAPIKeys() ([]*APIKey, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows, err := s.db.Query(`SELECT id, key_hash, key_prefix, name, role, created_at, expires_at, last_used
		FROM api_keys ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("db: ListAPIKeys: %w", err)
	}
	defer rows.Close()
	var keys []*APIKey
	for rows.Next() {
		k := &APIKey{}
		if err := rows.Scan(&k.ID, &k.KeyHash, &k.KeyPrefix, &k.Name, &k.Role,
			&k.CreatedAt, &k.ExpiresAt, &k.LastUsed); err != nil {
			return nil, err
		}
		keys = append(keys, k)
	}
	return keys, rows.Err()
}

// DeleteAPIKey removes an API key by ID.
func (s *SQLiteDB) DeleteAPIKey(id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`DELETE FROM api_keys WHERE id=?`, id)
	return err
}

// TouchAPIKey updates the last_used timestamp for an API key.
func (s *SQLiteDB) TouchAPIKey(id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE api_keys SET last_used=datetime('now') WHERE id=?`, id)
	return err
}

// ============================================================================
// Device Token Methods (Dual Key System)
// ============================================================================

// CreateDeviceToken creates a new device enrollment token.
func (s *SQLiteDB) CreateDeviceToken(t *DeviceToken) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	var expiresAt sql.NullString
	if t.ExpiresAt != nil {
		expiresAt.Valid = true
		expiresAt.String = t.ExpiresAt.Format(time.RFC3339)
	}

	res, err := s.db.Exec(`
		INSERT INTO device_tokens (token_hash, token_prefix, name, peer_id, status, max_uses, use_count, expires_at, created_by, note)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		t.TokenHash, t.Token[:8], t.Name, t.PeerID, t.Status, t.MaxUses, t.UseCount, expiresAt, t.CreatedBy, t.Note)
	if err != nil {
		return fmt.Errorf("db: CreateDeviceToken: %w", err)
	}
	id, _ := res.LastInsertId()
	t.ID = id
	return nil
}

// GetDeviceToken returns a device token by ID.
func (s *SQLiteDB) GetDeviceToken(id int64) (*DeviceToken, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.getDeviceTokenByQuery(`SELECT id, token_hash, token_prefix, name, peer_id, status, max_uses, use_count, 
		created_at, expires_at, revoked_at, last_used_at, created_by, note 
		FROM device_tokens WHERE id = ?`, id)
}

// GetDeviceTokenByHash returns a device token by its hash.
func (s *SQLiteDB) GetDeviceTokenByHash(tokenHash string) (*DeviceToken, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.getDeviceTokenByQuery(`SELECT id, token_hash, token_prefix, name, peer_id, status, max_uses, use_count, 
		created_at, expires_at, revoked_at, last_used_at, created_by, note 
		FROM device_tokens WHERE token_hash = ?`, tokenHash)
}

// GetDeviceTokenByPeerID returns the token bound to a peer.
func (s *SQLiteDB) GetDeviceTokenByPeerID(peerID string) (*DeviceToken, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.getDeviceTokenByQuery(`SELECT id, token_hash, token_prefix, name, peer_id, status, max_uses, use_count, 
		created_at, expires_at, revoked_at, last_used_at, created_by, note 
		FROM device_tokens WHERE peer_id = ? AND status IN ('active', 'pending')`, peerID)
}

// getDeviceTokenByQuery is a helper function to scan a device token row.
func (s *SQLiteDB) getDeviceTokenByQuery(query string, args ...interface{}) (*DeviceToken, error) {
	t := &DeviceToken{}
	var createdAt, expiresAt, revokedAt, lastUsedAt sql.NullString

	err := s.db.QueryRow(query, args...).Scan(
		&t.ID, &t.TokenHash, &t.Token, &t.Name, &t.PeerID, &t.Status, &t.MaxUses, &t.UseCount,
		&createdAt, &expiresAt, &revokedAt, &lastUsedAt, &t.CreatedBy, &t.Note)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	if createdAt.Valid {
		if tm, err := time.Parse(time.RFC3339, createdAt.String); err == nil {
			t.CreatedAt = tm
		} else if tm, err := time.Parse("2006-01-02 15:04:05", createdAt.String); err == nil {
			t.CreatedAt = tm
		}
	}
	if expiresAt.Valid {
		if tm, err := time.Parse(time.RFC3339, expiresAt.String); err == nil {
			t.ExpiresAt = &tm
		} else if tm, err := time.Parse("2006-01-02 15:04:05", expiresAt.String); err == nil {
			t.ExpiresAt = &tm
		}
	}
	if revokedAt.Valid {
		if tm, err := time.Parse(time.RFC3339, revokedAt.String); err == nil {
			t.RevokedAt = &tm
		} else if tm, err := time.Parse("2006-01-02 15:04:05", revokedAt.String); err == nil {
			t.RevokedAt = &tm
		}
	}
	if lastUsedAt.Valid {
		if tm, err := time.Parse(time.RFC3339, lastUsedAt.String); err == nil {
			t.LastUsedAt = &tm
		} else if tm, err := time.Parse("2006-01-02 15:04:05", lastUsedAt.String); err == nil {
			t.LastUsedAt = &tm
		}
	}
	return t, nil
}

// ListDeviceTokens returns all device tokens.
func (s *SQLiteDB) ListDeviceTokens(includeRevoked bool) ([]*DeviceToken, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	query := `SELECT id, token_hash, token_prefix, name, peer_id, status, max_uses, use_count, 
		created_at, expires_at, revoked_at, last_used_at, created_by, note 
		FROM device_tokens`
	if !includeRevoked {
		query += ` WHERE status != 'revoked'`
	}
	query += ` ORDER BY id DESC`

	rows, err := s.db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("db: ListDeviceTokens: %w", err)
	}
	defer rows.Close()

	var tokens []*DeviceToken
	for rows.Next() {
		t := &DeviceToken{}
		var createdAt, expiresAt, revokedAt, lastUsedAt sql.NullString

		if err := rows.Scan(&t.ID, &t.TokenHash, &t.Token, &t.Name, &t.PeerID, &t.Status,
			&t.MaxUses, &t.UseCount, &createdAt, &expiresAt, &revokedAt, &lastUsedAt,
			&t.CreatedBy, &t.Note); err != nil {
			return nil, err
		}

		if createdAt.Valid {
			if tm, err := time.Parse(time.RFC3339, createdAt.String); err == nil {
				t.CreatedAt = tm
			} else if tm, err := time.Parse("2006-01-02 15:04:05", createdAt.String); err == nil {
				t.CreatedAt = tm
			}
		}
		if expiresAt.Valid {
			if tm, err := time.Parse(time.RFC3339, expiresAt.String); err == nil {
				t.ExpiresAt = &tm
			}
		}
		if revokedAt.Valid {
			if tm, err := time.Parse(time.RFC3339, revokedAt.String); err == nil {
				t.RevokedAt = &tm
			}
		}
		if lastUsedAt.Valid {
			if tm, err := time.Parse(time.RFC3339, lastUsedAt.String); err == nil {
				t.LastUsedAt = &tm
			}
		}
		tokens = append(tokens, t)
	}
	return tokens, rows.Err()
}

// UpdateDeviceToken updates a device token.
func (s *SQLiteDB) UpdateDeviceToken(t *DeviceToken) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	var expiresAt sql.NullString
	if t.ExpiresAt != nil {
		expiresAt.Valid = true
		expiresAt.String = t.ExpiresAt.Format(time.RFC3339)
	}

	_, err := s.db.Exec(`
		UPDATE device_tokens SET name=?, peer_id=?, status=?, max_uses=?, expires_at=?, note=?
		WHERE id=?`, t.Name, t.PeerID, t.Status, t.MaxUses, expiresAt, t.Note, t.ID)
	return err
}

// RevokeDeviceToken revokes a device token by ID.
func (s *SQLiteDB) RevokeDeviceToken(id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE device_tokens SET status='revoked', revoked_at=datetime('now') WHERE id=?`, id)
	return err
}

// BindTokenToPeer binds a token to a peer ID after successful enrollment.
func (s *SQLiteDB) BindTokenToPeer(tokenHash, peerID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`
		UPDATE device_tokens SET peer_id=?, status='active', last_used_at=datetime('now')
		WHERE token_hash=? AND status='pending'`, peerID, tokenHash)
	return err
}

// IncrementTokenUse increments the use count for a token.
func (s *SQLiteDB) IncrementTokenUse(tokenHash string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`
		UPDATE device_tokens SET use_count = use_count + 1, last_used_at=datetime('now')
		WHERE token_hash=?`, tokenHash)
	return err
}

// ValidateToken checks if a token is valid for enrollment.
// Returns the token if valid, nil if invalid/expired/revoked.
func (s *SQLiteDB) ValidateToken(tokenHash string) (*DeviceToken, error) {
	t, err := s.GetDeviceTokenByHash(tokenHash)
	if err != nil {
		return nil, err
	}
	if t == nil {
		return nil, nil // Token not found
	}

	// Check status
	if t.Status == TokenStatusRevoked {
		return nil, nil
	}

	// Check expiration
	if t.ExpiresAt != nil && time.Now().After(*t.ExpiresAt) {
		// Mark as expired if not already
		s.mu.Lock()
		s.db.Exec(`UPDATE device_tokens SET status='expired' WHERE id=? AND status NOT IN ('revoked', 'expired')`, t.ID)
		s.mu.Unlock()
		return nil, nil
	}

	// Check max uses
	if t.MaxUses > 0 && t.UseCount >= t.MaxUses {
		return nil, nil // Exceeded max uses
	}

	return t, nil
}

// CleanupExpiredTokens marks expired tokens as expired.
func (s *SQLiteDB) CleanupExpiredTokens() (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`
		UPDATE device_tokens SET status='expired' 
		WHERE status='pending' AND expires_at IS NOT NULL AND expires_at < datetime('now')`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// ── Address Book ──────────────────────────────────────────────────────

// GetAddressBook retrieves the address book data for a user.
func (s *SQLiteDB) GetAddressBook(username, abType string) (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var data string
	err := s.db.QueryRow(
		`SELECT data FROM address_books WHERE username = ? AND ab_type = ?`,
		username, abType).Scan(&data)
	if err == sql.ErrNoRows {
		return "{}", nil
	}
	return data, err
}

// SaveAddressBook stores the address book data for a user (upsert).
func (s *SQLiteDB) SaveAddressBook(username, abType, data string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`INSERT INTO address_books (username, ab_type, data, updated_at)
		 VALUES (?, ?, ?, datetime('now'))
		 ON CONFLICT(username, ab_type) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
		username, abType, data)
	return err
}

// ── Peer Metrics ──────────────────────────────────────────────────────

// SavePeerMetric inserts a new heartbeat metric data point for a peer.
func (s *SQLiteDB) SavePeerMetric(peerID string, cpu, memory, disk float64) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`INSERT INTO peer_metrics (peer_id, cpu_usage, memory_usage, disk_usage, created_at)
		 VALUES (?, ?, ?, ?, datetime('now'))`,
		peerID, cpu, memory, disk)
	return err
}

// GetPeerMetrics returns the most recent metric data points for a peer.
func (s *SQLiteDB) GetPeerMetrics(peerID string, limit int) ([]*PeerMetric, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rows, err := s.db.Query(
		`SELECT id, peer_id, cpu_usage, memory_usage, disk_usage, created_at
		 FROM peer_metrics WHERE peer_id = ? ORDER BY created_at DESC LIMIT ?`,
		peerID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var metrics []*PeerMetric
	for rows.Next() {
		var m PeerMetric
		var createdAt string
		if err := rows.Scan(&m.ID, &m.PeerID, &m.CPU, &m.Memory, &m.Disk, &createdAt); err != nil {
			return nil, err
		}
		m.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", createdAt)
		metrics = append(metrics, &m)
	}
	return metrics, nil
}

// GetLatestPeerMetric returns the most recent metric for a peer.
func (s *SQLiteDB) GetLatestPeerMetric(peerID string) (*PeerMetric, error) {
	metrics, err := s.GetPeerMetrics(peerID, 1)
	if err != nil {
		return nil, err
	}
	if len(metrics) == 0 {
		return nil, nil
	}
	return metrics[0], nil
}

// CleanupOldMetrics deletes metric records older than maxAge.
// Returns the number of deleted rows.
func (s *SQLiteDB) CleanupOldMetrics(maxAge time.Duration) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	cutoff := time.Now().Add(-maxAge).UTC().Format("2006-01-02 15:04:05")
	result, err := s.db.Exec(
		`DELETE FROM peer_metrics WHERE created_at < ?`, cutoff)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// ---------------------------------------------------------------------------
//  Chat Messages
// ---------------------------------------------------------------------------

// SaveChatMessage inserts a new chat message and returns its ID.
func (s *SQLiteDB) SaveChatMessage(msg *ChatMessage) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	result, err := s.db.Exec(
		`INSERT INTO chat_messages (conversation_id, from_id, from_name, to_id, text, read)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		msg.ConversationID, msg.FromID, msg.FromName, msg.ToID, msg.Text, msg.Read,
	)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

// GetChatHistory returns the most recent messages for a conversation.
func (s *SQLiteDB) GetChatHistory(conversationID string, limit int) ([]*ChatMessage, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if limit <= 0 || limit > 500 {
		limit = 100
	}

	rows, err := s.db.Query(
		`SELECT id, conversation_id, from_id, from_name, to_id, text, read, created_at
		 FROM chat_messages WHERE conversation_id = ?
		 ORDER BY id DESC LIMIT ?`,
		conversationID, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var msgs []*ChatMessage
	for rows.Next() {
		var m ChatMessage
		var createdAt string
		if err := rows.Scan(&m.ID, &m.ConversationID, &m.FromID, &m.FromName, &m.ToID, &m.Text, &m.Read, &createdAt); err != nil {
			return nil, err
		}
		m.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", createdAt)
		msgs = append(msgs, &m)
	}
	// Reverse so oldest is first
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	return msgs, nil
}

// GetChatHistoryBefore returns messages before a given ID (for pagination).
func (s *SQLiteDB) GetChatHistoryBefore(conversationID string, beforeID int64, limit int) ([]*ChatMessage, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if limit <= 0 || limit > 500 {
		limit = 100
	}

	rows, err := s.db.Query(
		`SELECT id, conversation_id, from_id, from_name, to_id, text, read, created_at
		 FROM chat_messages WHERE conversation_id = ? AND id < ?
		 ORDER BY id DESC LIMIT ?`,
		conversationID, beforeID, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var msgs []*ChatMessage
	for rows.Next() {
		var m ChatMessage
		var createdAt string
		if err := rows.Scan(&m.ID, &m.ConversationID, &m.FromID, &m.FromName, &m.ToID, &m.Text, &m.Read, &createdAt); err != nil {
			return nil, err
		}
		m.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", createdAt)
		msgs = append(msgs, &m)
	}
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	return msgs, nil
}

// MarkChatRead marks all messages in a conversation as read for a given reader.
func (s *SQLiteDB) MarkChatRead(conversationID, readerID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`UPDATE chat_messages SET read = 1
		 WHERE conversation_id = ? AND from_id != ? AND read = 0`,
		conversationID, readerID,
	)
	return err
}

// GetUnreadCount returns total unread messages for a device across all conversations.
func (s *SQLiteDB) GetUnreadCount(deviceID string) (int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var count int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM chat_messages
		 WHERE (conversation_id = ? OR to_id = ?) AND from_id != ? AND read = 0`,
		deviceID, deviceID, deviceID,
	).Scan(&count)
	return count, err
}

// DeleteChatHistory removes all messages for a conversation.
func (s *SQLiteDB) DeleteChatHistory(conversationID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`DELETE FROM chat_messages WHERE conversation_id = ?`, conversationID)
	return err
}

// ---------------------------------------------------------------------------
//  Chat Groups
// ---------------------------------------------------------------------------

// CreateChatGroup inserts a new chat group.
func (s *SQLiteDB) CreateChatGroup(g *ChatGroup) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`INSERT INTO chat_groups (id, name, members, created_by) VALUES (?, ?, ?, ?)`,
		g.ID, g.Name, g.Members, g.CreatedBy,
	)
	return err
}

// GetChatGroup returns a chat group by ID.
func (s *SQLiteDB) GetChatGroup(id string) (*ChatGroup, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var g ChatGroup
	var createdAt string
	err := s.db.QueryRow(
		`SELECT id, name, members, created_by, created_at FROM chat_groups WHERE id = ?`, id,
	).Scan(&g.ID, &g.Name, &g.Members, &g.CreatedBy, &createdAt)
	if err != nil {
		return nil, err
	}
	g.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", createdAt)
	return &g, nil
}

// ListChatGroups returns all groups where memberID is in the members list.
func (s *SQLiteDB) ListChatGroups(memberID string) ([]*ChatGroup, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	// Use LIKE with escaped wildcards for comma-separated member search
	pattern := "%" + memberID + "%"
	rows, err := s.db.Query(
		`SELECT id, name, members, created_by, created_at FROM chat_groups
		 WHERE members LIKE ?`, pattern,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var groups []*ChatGroup
	for rows.Next() {
		var g ChatGroup
		var createdAt string
		if err := rows.Scan(&g.ID, &g.Name, &g.Members, &g.CreatedBy, &createdAt); err != nil {
			return nil, err
		}
		g.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", createdAt)
		groups = append(groups, &g)
	}
	return groups, nil
}

// UpdateChatGroup updates a chat group's name or members.
func (s *SQLiteDB) UpdateChatGroup(g *ChatGroup) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`UPDATE chat_groups SET name = ?, members = ? WHERE id = ?`,
		g.Name, g.Members, g.ID,
	)
	return err
}

// DeleteChatGroup removes a chat group.
func (s *SQLiteDB) DeleteChatGroup(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`DELETE FROM chat_groups WHERE id = ?`, id)
	return err
}

// ============================================================
// Access Policies (unattended access management)
// ============================================================

// GetAccessPolicy retrieves the access policy for a peer device.
func (s *SQLiteDB) GetAccessPolicy(peerID string) (*AccessPolicy, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	row := s.db.QueryRow(
		`SELECT peer_id, unattended_enabled, password_hash, schedule_enabled,
				schedule_days, schedule_start_time, schedule_end_time, schedule_timezone,
				allowed_operators, updated_at, updated_by
		 FROM access_policies WHERE peer_id = ?`, peerID)

	var p AccessPolicy
	err := row.Scan(&p.PeerID, &p.UnattendedEnabled, &p.PasswordHash, &p.ScheduleEnabled,
		&p.ScheduleDays, &p.ScheduleStartTime, &p.ScheduleEndTime, &p.ScheduleTimezone,
		&p.AllowedOperators, &p.UpdatedAt, &p.UpdatedBy)
	if err != nil {
		return nil, err
	}
	p.PasswordSet = p.PasswordHash != ""
	return &p, nil
}

// SaveAccessPolicy creates or updates the access policy for a peer device.
func (s *SQLiteDB) SaveAccessPolicy(p *AccessPolicy) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`INSERT INTO access_policies (peer_id, unattended_enabled, password_hash,
			schedule_enabled, schedule_days, schedule_start_time, schedule_end_time,
			schedule_timezone, allowed_operators, updated_at, updated_by)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(peer_id) DO UPDATE SET
			unattended_enabled = excluded.unattended_enabled,
			password_hash = CASE WHEN excluded.password_hash = '' THEN access_policies.password_hash WHEN excluded.password_hash = 'CLEAR' THEN '' ELSE excluded.password_hash END,
			schedule_enabled = excluded.schedule_enabled,
			schedule_days = excluded.schedule_days,
			schedule_start_time = excluded.schedule_start_time,
			schedule_end_time = excluded.schedule_end_time,
			schedule_timezone = excluded.schedule_timezone,
			allowed_operators = excluded.allowed_operators,
			updated_at = excluded.updated_at,
			updated_by = excluded.updated_by`,
		p.PeerID, p.UnattendedEnabled, p.PasswordHash,
		p.ScheduleEnabled, p.ScheduleDays, p.ScheduleStartTime, p.ScheduleEndTime,
		p.ScheduleTimezone, p.AllowedOperators, p.UpdatedAt, p.UpdatedBy)
	return err
}

// DeleteAccessPolicy removes the access policy for a peer device.
func (s *SQLiteDB) DeleteAccessPolicy(peerID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`DELETE FROM access_policies WHERE peer_id = ?`, peerID)
	return err
}

// --- Role Permissions (RBAC Phase 52) ---

// ListRolePermissions returns all custom permission overrides for a role.
func (s *SQLiteDB) ListRolePermissions(role string) ([]*RolePermission, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rows, err := s.db.Query(`SELECT id, role, permission, granted FROM role_permissions WHERE role = ?`, role)
	if err != nil {
		return nil, fmt.Errorf("db: ListRolePermissions: %w", err)
	}
	defer rows.Close()

	var perms []*RolePermission
	for rows.Next() {
		p := &RolePermission{}
		if err := rows.Scan(&p.ID, &p.Role, &p.Permission, &p.Granted); err != nil {
			return nil, err
		}
		perms = append(perms, p)
	}
	return perms, rows.Err()
}

// SetRolePermission creates or updates a custom permission override for a role.
func (s *SQLiteDB) SetRolePermission(role, permission string, granted bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	grantedInt := 0
	if granted {
		grantedInt = 1
	}
	_, err := s.db.Exec(`INSERT INTO role_permissions (role, permission, granted)
		VALUES (?, ?, ?) ON CONFLICT(role, permission) DO UPDATE SET granted = excluded.granted`,
		role, permission, grantedInt)
	return err
}

// DeleteRolePermission removes a custom permission override, reverting to defaults.
func (s *SQLiteDB) DeleteRolePermission(role, permission string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`DELETE FROM role_permissions WHERE role = ? AND permission = ?`, role, permission)
	return err
}

// HasRolePermission checks if a custom permission override exists for a role.
// Returns (granted_value, nil) if found, or (false, error) if no override exists.
func (s *SQLiteDB) HasRolePermission(role, permission string) (bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var granted bool
	err := s.db.QueryRow(`SELECT granted FROM role_permissions WHERE role = ? AND permission = ?`,
		role, permission).Scan(&granted)
	if err == sql.ErrNoRows {
		return false, fmt.Errorf("no override")
	}
	return granted, err
}

// --- Org-scoped device queries (RBAC Phase 52) ---

// ListPeersForOrg returns only peers assigned to the given organization.
func (s *SQLiteDB) ListPeersForOrg(orgID string, includeDeleted bool) ([]*Peer, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	query := `SELECT p.id, p.uuid, p.pk, p.ip, p.user, p.hostname, p.os, p.version,
		p.status, p.nat_type, p.last_online, p.created_at, p.disabled,
		p.banned, p.ban_reason, p.banned_at, p.soft_deleted, p.deleted_at,
		p.note, p.tags, p.heartbeat_seq, COALESCE(p.display_name, ''),
		COALESCE(p.device_type, ''), COALESCE(p.linked_peer_id, '')
		FROM peers p INNER JOIN org_devices od ON p.id = od.device_id
		WHERE od.org_id = ?`
	if !includeDeleted {
		query += ` AND p.soft_deleted = 0`
	}
	query += ` ORDER BY p.last_online DESC`

	rows, err := s.db.Query(query, orgID)
	if err != nil {
		return nil, fmt.Errorf("db: ListPeersForOrg: %w", err)
	}
	defer rows.Close()

	var peers []*Peer
	for rows.Next() {
		p := &Peer{}
		var lastOnline, createdAt, bannedAt, deletedAt sql.NullString
		if err := rows.Scan(
			&p.ID, &p.UUID, &p.PK, &p.IP, &p.User, &p.Hostname, &p.OS, &p.Version,
			&p.Status, &p.NATType, &lastOnline, &createdAt, &p.Disabled,
			&p.Banned, &p.BanReason, &bannedAt, &p.SoftDeleted, &deletedAt,
			&p.Note, &p.Tags, &p.HeartbeatSeq, &p.DisplayName,
			&p.DeviceType, &p.LinkedPeerID,
		); err != nil {
			return nil, err
		}
		if lastOnline.Valid {
			p.LastOnline, _ = time.Parse("2006-01-02 15:04:05", lastOnline.String)
		}
		if createdAt.Valid {
			p.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", createdAt.String)
		}
		if bannedAt.Valid {
			t, _ := time.Parse("2006-01-02 15:04:05", bannedAt.String)
			p.BannedAt = &t
		}
		if deletedAt.Valid {
			t, _ := time.Parse("2006-01-02 15:04:05", deletedAt.String)
			p.DeletedAt = &t
		}
		peers = append(peers, p)
	}
	return peers, rows.Err()
}
