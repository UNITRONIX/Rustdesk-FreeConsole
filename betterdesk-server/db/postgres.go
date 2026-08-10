package db

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresDB implements the Database interface using PostgreSQL via pgx/v5.
// Unlike SQLite, PostgreSQL supports concurrent writes, row-level locking,
// and LISTEN/NOTIFY for real-time event push between server instances.
type PostgresDB struct {
	pool *pgxpool.Pool
	ctx  context.Context

	queryTimeout time.Duration

	// LISTEN/NOTIFY callback (nil = disabled). Set via OnNotify().
	notifyFunc func(channel, payload string)
}

// OpenPostgres connects to a PostgreSQL server. The dsn must use the
// postgres:// or postgresql:// scheme, for example:
//
//	postgres://user:pass@localhost:5432/betterdesk?sslmode=prefer
//
// Connection pooling is built-in via pgxpool. Configure max connections
// with the pool_max_conns query parameter:
//
//	postgres://...?pool_max_conns=10
func OpenPostgres(dsn string) (*PostgresDB, error) {
	ctx := context.Background()

	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("db: PostgreSQL parse config: %w", err)
	}

	// Sensible pool defaults if not specified in DSN
	if config.MaxConns == 0 {
		config.MaxConns = 10
	}
	config.MinConns = 1

	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("db: PostgreSQL connect: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("db: PostgreSQL ping: %w", err)
	}

	return &PostgresDB{pool: pool, ctx: ctx, queryTimeout: 30 * time.Second}, nil
}

// opCtx returns a context for database operations with optional query timeout.
func (pg *PostgresDB) opCtx() (context.Context, context.CancelFunc) {
	if pg.queryTimeout <= 0 {
		return pg.ctx, func() {}
	}
	return context.WithTimeout(pg.ctx, pg.queryTimeout)
}

// Close closes the connection pool.
func (pg *PostgresDB) Close() error {
	pg.pool.Close()
	return nil
}

// Migrate creates all tables and indexes using PostgreSQL-native types.
func (pg *PostgresDB) Migrate() error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS peers (
			id            TEXT PRIMARY KEY,
			uuid          TEXT NOT NULL DEFAULT '',
			pk            BYTEA DEFAULT NULL,
			ip            TEXT NOT NULL DEFAULT '',
			"user"        TEXT NOT NULL DEFAULT '',
			hostname      TEXT NOT NULL DEFAULT '',
			os            TEXT NOT NULL DEFAULT '',
			version       TEXT NOT NULL DEFAULT '',
			status        TEXT NOT NULL DEFAULT 'OFFLINE',
			nat_type      INTEGER NOT NULL DEFAULT 0,
			last_online   TIMESTAMPTZ,
			created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			disabled      BOOLEAN NOT NULL DEFAULT FALSE,
			banned        BOOLEAN NOT NULL DEFAULT FALSE,
			ban_reason    TEXT NOT NULL DEFAULT '',
			banned_at     TIMESTAMPTZ,
			soft_deleted  BOOLEAN NOT NULL DEFAULT FALSE,
			deleted_at    TIMESTAMPTZ,
			note          TEXT NOT NULL DEFAULT '',
			tags          TEXT NOT NULL DEFAULT '',
			heartbeat_seq BIGINT NOT NULL DEFAULT 0,
			device_type   TEXT NOT NULL DEFAULT '',
			linked_peer_id TEXT NOT NULL DEFAULT '',
			display_name  TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_peers_uuid ON peers(uuid)`,
		`CREATE INDEX IF NOT EXISTS idx_peers_status ON peers(status)`,
		`CREATE INDEX IF NOT EXISTS idx_peers_banned ON peers(banned) WHERE banned = TRUE`,
		`CREATE INDEX IF NOT EXISTS idx_peers_soft_deleted ON peers(soft_deleted) WHERE soft_deleted = FALSE`,

		`CREATE TABLE IF NOT EXISTS server_config (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL DEFAULT ''
		)`,

		`CREATE TABLE IF NOT EXISTS id_change_history (
			id         BIGSERIAL PRIMARY KEY,
			old_id     TEXT NOT NULL,
			new_id     TEXT NOT NULL,
			changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			reason     TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_id_history_old ON id_change_history(old_id)`,
		`CREATE INDEX IF NOT EXISTS idx_id_history_new ON id_change_history(new_id)`,

		`CREATE TABLE IF NOT EXISTS users (
			id                   BIGSERIAL PRIMARY KEY,
			username             TEXT UNIQUE NOT NULL,
			password_hash        TEXT NOT NULL,
			role                 TEXT NOT NULL DEFAULT 'viewer',
			auth_provider        TEXT NOT NULL DEFAULT 'local',
			totp_secret          TEXT NOT NULL DEFAULT '',
			totp_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
			totp_recovery_codes  TEXT DEFAULT NULL,
			created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			last_login           TIMESTAMPTZ
		)`,

		`CREATE TABLE IF NOT EXISTS api_keys (
			id         BIGSERIAL PRIMARY KEY,
			key_hash   TEXT UNIQUE NOT NULL,
			key_prefix TEXT NOT NULL DEFAULT '',
			name       TEXT NOT NULL DEFAULT '',
			role       TEXT NOT NULL DEFAULT 'viewer',
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			expires_at TIMESTAMPTZ,
			last_used  TIMESTAMPTZ
		)`,

		// Device tokens table (Dual Key System for enhanced security)
		`CREATE TABLE IF NOT EXISTS device_tokens (
			id           BIGSERIAL PRIMARY KEY,
			token_hash   TEXT UNIQUE NOT NULL,
			token_prefix TEXT NOT NULL DEFAULT '',
			name         TEXT NOT NULL DEFAULT '',
			peer_id      TEXT NOT NULL DEFAULT '',
			status       TEXT NOT NULL DEFAULT 'pending',
			max_uses     INTEGER NOT NULL DEFAULT 1,
			use_count    INTEGER NOT NULL DEFAULT 0,
			created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			expires_at   TIMESTAMPTZ,
			revoked_at   TIMESTAMPTZ,
			last_used_at TIMESTAMPTZ,
			created_by   TEXT NOT NULL DEFAULT '',
			note         TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_device_tokens_peer ON device_tokens(peer_id) WHERE peer_id != ''`,
		`CREATE INDEX IF NOT EXISTS idx_device_tokens_status ON device_tokens(status)`,

		// Address books table (RustDesk client AB sync)
		`CREATE TABLE IF NOT EXISTS address_books (
			username   TEXT NOT NULL,
			ab_type    TEXT NOT NULL DEFAULT 'legacy',
			data       TEXT NOT NULL DEFAULT '{}',
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY (username, ab_type)
		)`,

		// Peer metrics table (heartbeat CPU/memory/disk history)
		`CREATE TABLE IF NOT EXISTS peer_metrics (
			id         BIGSERIAL PRIMARY KEY,
			peer_id    TEXT NOT NULL,
			cpu_usage  REAL NOT NULL DEFAULT 0,
			memory_usage REAL NOT NULL DEFAULT 0,
			disk_usage REAL NOT NULL DEFAULT 0,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_peer_metrics_peer_id ON peer_metrics(peer_id)`,
		`CREATE INDEX IF NOT EXISTS idx_peer_metrics_created_at ON peer_metrics(created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_peer_metrics_peer_created ON peer_metrics(peer_id, created_at DESC)`,

		// Chat messages
		`CREATE TABLE IF NOT EXISTS chat_messages (
			id              BIGSERIAL PRIMARY KEY,
			conversation_id TEXT NOT NULL,
			from_id         TEXT NOT NULL,
			from_name       TEXT NOT NULL DEFAULT '',
			to_id           TEXT NOT NULL DEFAULT '',
			text            TEXT NOT NULL,
			read            BOOLEAN NOT NULL DEFAULT FALSE,
			created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversation_id)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_messages_from ON chat_messages(from_id)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at)`,
		// Chat groups
		`CREATE TABLE IF NOT EXISTS chat_groups (
			id         TEXT PRIMARY KEY,
			name       TEXT NOT NULL,
			members    TEXT NOT NULL DEFAULT '',
			created_by TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,

		// Help requests (support requests raised by agent devices)
		`CREATE TABLE IF NOT EXISTS help_requests (
			id         BIGSERIAL PRIMARY KEY,
			device_id  TEXT NOT NULL,
			hostname   TEXT NOT NULL DEFAULT '',
			org_id     TEXT NOT NULL DEFAULT '',
			message    TEXT NOT NULL DEFAULT '',
			status     TEXT NOT NULL DEFAULT 'pending',
			handled_by TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_help_requests_device ON help_requests(device_id)`,
		`CREATE INDEX IF NOT EXISTS idx_help_requests_status ON help_requests(status)`,
		`CREATE INDEX IF NOT EXISTS idx_help_requests_created ON help_requests(created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_help_requests_org ON help_requests(org_id)`,

		// RustDesk client login sessions (Issue #242 / #284)
		clientSessionsPostgresDDL,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_client_sessions_hash ON client_sessions(token_hash)`,
		`CREATE INDEX IF NOT EXISTS idx_client_sessions_user ON client_sessions(user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_client_sessions_expires ON client_sessions(expires_at)`,

		// Organizations (v3.0.0)
		`CREATE TABLE IF NOT EXISTS organizations (
			id         TEXT PRIMARY KEY,
			name       TEXT NOT NULL,
			slug       TEXT UNIQUE NOT NULL,
			logo_url   TEXT NOT NULL DEFAULT '',
			settings   JSONB NOT NULL DEFAULT '{}',
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,

		// Organization users (v3.0.0)
		`CREATE TABLE IF NOT EXISTS org_users (
			id            TEXT PRIMARY KEY,
			org_id        TEXT NOT NULL REFERENCES organizations(id),
			username      TEXT NOT NULL,
			display_name  TEXT NOT NULL DEFAULT '',
			email         TEXT NOT NULL DEFAULT '',
			password_hash TEXT NOT NULL,
			role          TEXT NOT NULL DEFAULT 'user',
			totp_secret   TEXT NOT NULL DEFAULT '',
			avatar_url    TEXT NOT NULL DEFAULT '',
			last_login    TIMESTAMPTZ DEFAULT NULL,
			created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			UNIQUE(org_id, username)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_org_users_org ON org_users(org_id)`,

		// Organization devices (v3.0.0)
		`CREATE TABLE IF NOT EXISTS org_devices (
			org_id           TEXT NOT NULL REFERENCES organizations(id),
			device_id        TEXT NOT NULL,
			assigned_user_id TEXT NOT NULL DEFAULT '',
			department       TEXT NOT NULL DEFAULT '',
			location         TEXT NOT NULL DEFAULT '',
			building         TEXT NOT NULL DEFAULT '',
			tags             TEXT NOT NULL DEFAULT '',
			PRIMARY KEY(org_id, device_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_org_devices_org ON org_devices(org_id)`,
		`CREATE INDEX IF NOT EXISTS idx_org_devices_device ON org_devices(device_id)`,

		// Organization invitations (v3.0.0)
		`CREATE TABLE IF NOT EXISTS org_invitations (
			id         TEXT PRIMARY KEY,
			org_id     TEXT NOT NULL REFERENCES organizations(id),
			token      TEXT UNIQUE NOT NULL,
			email      TEXT NOT NULL DEFAULT '',
			role       TEXT NOT NULL DEFAULT 'user',
			expires_at TIMESTAMPTZ NOT NULL,
			used_at    TIMESTAMPTZ DEFAULT NULL
		)`,

		// Organization settings (v3.0.0)
		`CREATE TABLE IF NOT EXISTS org_settings (
			org_id TEXT NOT NULL REFERENCES organizations(id),
			key    TEXT NOT NULL,
			value  TEXT NOT NULL DEFAULT '',
			PRIMARY KEY(org_id, key)
		)`,

		// Organization shared address books (Issue #187 / #190)
		`CREATE TABLE IF NOT EXISTS org_address_books (
			org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			ab_type    TEXT NOT NULL DEFAULT 'legacy',
			data       TEXT NOT NULL DEFAULT '{}',
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_by TEXT NOT NULL DEFAULT '',
			PRIMARY KEY(org_id, ab_type)
		)`,
		// Role permission overrides (RBAC Phase 52)
		`CREATE TABLE IF NOT EXISTS role_permissions (
			id          BIGSERIAL PRIMARY KEY,
			role        TEXT NOT NULL,
			permission  TEXT NOT NULL,
			granted     BOOLEAN NOT NULL DEFAULT TRUE,
			UNIQUE(role, permission)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_role_permissions_role ON role_permissions(role)`,

		`CREATE TABLE IF NOT EXISTS access_policies (
			peer_id TEXT PRIMARY KEY,
			unattended_enabled BOOLEAN NOT NULL DEFAULT FALSE,
			password_hash TEXT NOT NULL DEFAULT '',
			passwordless_server_access BOOLEAN NOT NULL DEFAULT TRUE,
			schedule_enabled BOOLEAN NOT NULL DEFAULT FALSE,
			schedule_days TEXT NOT NULL DEFAULT '',
			schedule_start_time TEXT NOT NULL DEFAULT '',
			schedule_end_time TEXT NOT NULL DEFAULT '',
			schedule_timezone TEXT NOT NULL DEFAULT '',
			allowed_operators TEXT NOT NULL DEFAULT '',
			updated_at TIMESTAMPTZ,
			updated_by TEXT NOT NULL DEFAULT ''
		)`,

		// Audit logs (RustDesk client reporting — API-port consolidation Phase A)
		`CREATE TABLE IF NOT EXISTS audit_connections (
			id BIGSERIAL PRIMARY KEY,
			host_id TEXT NOT NULL,
			host_uuid TEXT NOT NULL DEFAULT '',
			peer_id TEXT NOT NULL DEFAULT '',
			peer_name TEXT NOT NULL DEFAULT '',
			action TEXT NOT NULL DEFAULT '',
			conn_type INTEGER NOT NULL DEFAULT 0,
			session_id TEXT NOT NULL DEFAULT '',
			ip TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_conn_host ON audit_connections(host_id, created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_conn_peer ON audit_connections(peer_id, created_at)`,

		`CREATE TABLE IF NOT EXISTS audit_files (
			id BIGSERIAL PRIMARY KEY,
			host_id TEXT NOT NULL,
			host_uuid TEXT NOT NULL DEFAULT '',
			peer_id TEXT NOT NULL DEFAULT '',
			direction INTEGER NOT NULL DEFAULT 0,
			path TEXT NOT NULL DEFAULT '',
			is_file INTEGER NOT NULL DEFAULT 1,
			num_files INTEGER NOT NULL DEFAULT 0,
			files_json TEXT NOT NULL DEFAULT '[]',
			ip TEXT NOT NULL DEFAULT '',
			peer_name TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_files_host ON audit_files(host_id, created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_files_peer ON audit_files(peer_id, created_at)`,

		`CREATE TABLE IF NOT EXISTS audit_alarms (
			id BIGSERIAL PRIMARY KEY,
			alarm_type INTEGER NOT NULL DEFAULT 0,
			alarm_name TEXT NOT NULL DEFAULT '',
			host_id TEXT NOT NULL DEFAULT '',
			peer_id TEXT NOT NULL DEFAULT '',
			ip TEXT NOT NULL DEFAULT '',
			details TEXT NOT NULL DEFAULT '{}',
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_audit_alarms_type ON audit_alarms(alarm_type, created_at)`,

		// Billing / commercialization module
		`CREATE TABLE IF NOT EXISTS billing_packages (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			included_minutes INTEGER NOT NULL DEFAULT 0,
			overage_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
			currency TEXT NOT NULL DEFAULT 'PLN',
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS billing_contracts (
			id TEXT PRIMARY KEY,
			target_type TEXT NOT NULL DEFAULT 'org',
			target_key TEXT NOT NULL,
			package_id TEXT NOT NULL REFERENCES billing_packages(id),
			status TEXT NOT NULL DEFAULT 'active',
			remaining_minutes INTEGER NOT NULL DEFAULT 0,
			overage_rate DOUBLE PRECISION,
			hourly_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
			currency TEXT NOT NULL DEFAULT 'PLN',
			valid_from TIMESTAMPTZ,
			valid_until TIMESTAMPTZ,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			UNIQUE(target_type, target_key)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_billing_contracts_target ON billing_contracts(target_type, target_key)`,
		`CREATE INDEX IF NOT EXISTS idx_billing_contracts_status ON billing_contracts(status)`,
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
			started_at TIMESTAMPTZ NOT NULL,
			ended_at TIMESTAMPTZ,
			raw_seconds INTEGER NOT NULL DEFAULT 0,
			billed_minutes INTEGER NOT NULL DEFAULT 0,
			included_minutes_used INTEGER NOT NULL DEFAULT 0,
			overage_minutes INTEGER NOT NULL DEFAULT 0,
			amount_included DOUBLE PRECISION NOT NULL DEFAULT 0,
			amount_overage DOUBLE PRECISION NOT NULL DEFAULT 0,
			currency TEXT NOT NULL DEFAULT 'PLN',
			clock_offset_ms_at_start BIGINT NOT NULL DEFAULT 0,
			clock_synced_at_start BOOLEAN NOT NULL DEFAULT TRUE,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_billing_sessions_org ON billing_sessions(org_id, started_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_billing_sessions_relay ON billing_sessions(relay_uuid)`,
		`CREATE TABLE IF NOT EXISTS billing_session_ledger (
			id BIGSERIAL PRIMARY KEY,
			session_id TEXT NOT NULL,
			event_type TEXT NOT NULL,
			details TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_billing_ledger_session ON billing_session_ledger(session_id)`,
		`CREATE TABLE IF NOT EXISTS billing_work_reports (
			id BIGSERIAL PRIMARY KEY,
			session_id TEXT NOT NULL UNIQUE,
			operator_id TEXT NOT NULL DEFAULT '',
			summary TEXT NOT NULL,
			category TEXT NOT NULL DEFAULT '',
			ticket_ref TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS billing_currencies (
			code TEXT PRIMARY KEY,
			symbol TEXT NOT NULL DEFAULT '',
			exchange_rate_to_base DOUBLE PRECISION NOT NULL DEFAULT 1
		)`,

		// User/device groups + strategies (API-port consolidation Phase A)
		`CREATE TABLE IF NOT EXISTS user_groups (
			id BIGSERIAL PRIMARY KEY,
			guid TEXT UNIQUE NOT NULL,
			name TEXT NOT NULL,
			note TEXT NOT NULL DEFAULT '',
			team_id TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS device_groups (
			id BIGSERIAL PRIMARY KEY,
			guid TEXT UNIQUE NOT NULL,
			name TEXT NOT NULL,
			note TEXT NOT NULL DEFAULT '',
			team_id TEXT NOT NULL DEFAULT '',
			source_type TEXT NOT NULL DEFAULT 'manual',
			tag_filter TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS strategies (
			id BIGSERIAL PRIMARY KEY,
			guid TEXT UNIQUE NOT NULL,
			name TEXT NOT NULL,
			user_group_guid TEXT NOT NULL DEFAULT '',
			device_group_guid TEXT NOT NULL DEFAULT '',
			enabled BOOLEAN NOT NULL DEFAULT TRUE,
			permissions TEXT NOT NULL DEFAULT '{}',
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS strategy_assignments (
			id BIGSERIAL PRIMARY KEY,
			target_type TEXT NOT NULL,
			target_key TEXT NOT NULL,
			strategy_guid TEXT NOT NULL DEFAULT '',
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			UNIQUE(target_type, target_key)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_strategy_assignments_strategy ON strategy_assignments(strategy_guid)`,

		// Panel sync (folders, group members, ACL — consolidated from auth.db)
		`CREATE TABLE IF NOT EXISTS folders (
			id BIGSERIAL PRIMARY KEY,
			name TEXT NOT NULL,
			color TEXT NOT NULL DEFAULT '#6366f1',
			icon TEXT NOT NULL DEFAULT 'folder',
			sort_order INTEGER NOT NULL DEFAULT 0,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS device_folder_assignments (
			device_id TEXT PRIMARY KEY NOT NULL,
			folder_id BIGINT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
			assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS device_group_members (
			device_group_id BIGINT NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE,
			peer_id TEXT NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY (device_group_id, peer_id)
		)`,
		`CREATE TABLE IF NOT EXISTS user_group_members (
			user_group_id BIGINT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
			user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY (user_group_id, user_id)
		)`,
		`CREATE TABLE IF NOT EXISTS device_group_user_access (
			device_group_id BIGINT NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE,
			user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY (device_group_id, user_id)
		)`,
		`CREATE TABLE IF NOT EXISTS device_group_user_group_access (
			device_group_id BIGINT NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE,
			user_group_id BIGINT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY (device_group_id, user_group_id)
		)`,
		`CREATE TABLE IF NOT EXISTS peer_sysinfo (
			peer_id TEXT PRIMARY KEY,
			hostname TEXT NOT NULL DEFAULT '',
			username TEXT NOT NULL DEFAULT '',
			platform TEXT NOT NULL DEFAULT '',
			version TEXT NOT NULL DEFAULT '',
			cpu_name TEXT NOT NULL DEFAULT '',
			cpu_cores INTEGER NOT NULL DEFAULT 0,
			cpu_freq_ghz REAL NOT NULL DEFAULT 0,
			memory_gb REAL NOT NULL DEFAULT 0,
			os_full TEXT NOT NULL DEFAULT '',
			displays TEXT NOT NULL DEFAULT '[]',
			encoding TEXT NOT NULL DEFAULT '[]',
			features TEXT NOT NULL DEFAULT '{}',
			platform_additions TEXT NOT NULL DEFAULT '{}',
			raw_json TEXT NOT NULL DEFAULT '{}',
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
	}

	for _, stmt := range statements {
		if _, err := pg.pool.Exec(pg.ctx, stmt); err != nil {
			return fmt.Errorf("db: PostgreSQL migration failed: %w\nStatement: %s", err, stmt)
		}
	}

	// Incremental column migrations for existing databases.
	// PostgreSQL supports ADD COLUMN IF NOT EXISTS natively.
	columnMigrations := []string{
		// users: TOTP 2FA columns (added in v2.3.0)
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_recovery_codes TEXT DEFAULT NULL`,
		// peers: ban columns (added in v2.1.0)
		`ALTER TABLE peers ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE peers ADD COLUMN IF NOT EXISTS ban_reason TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE peers ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ`,
		// peers: tags (added in v2.2.0)
		`ALTER TABLE peers ADD COLUMN IF NOT EXISTS tags TEXT NOT NULL DEFAULT ''`,
		// peers: heartbeat_seq (added in v2.3.0)
		`ALTER TABLE peers ADD COLUMN IF NOT EXISTS heartbeat_seq BIGINT NOT NULL DEFAULT 0`,
		// peers: CDAP device type and linked peer (added in v2.5.0)
		`ALTER TABLE peers ADD COLUMN IF NOT EXISTS device_type TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE peers ADD COLUMN IF NOT EXISTS linked_peer_id TEXT NOT NULL DEFAULT ''`,
		// peers: display_name alias (added in v2.6.0)
		`ALTER TABLE peers ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT ''`,
		// users: server admin flag (RBAC Phase 52)
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_server_admin BOOLEAN NOT NULL DEFAULT FALSE`,
		// users: authentication provider (Issue #148)
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'local'`,
		// org_users: server_user_id for linking existing users (Issue #106)
		`ALTER TABLE org_users ADD COLUMN IF NOT EXISTS server_user_id BIGINT NOT NULL DEFAULT 0`,
		// peers/users: Pro strategy assignment GUIDs
		`ALTER TABLE peers ADD COLUMN IF NOT EXISTS guid TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE users ADD COLUMN IF NOT EXISTS guid TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE access_policies ADD COLUMN IF NOT EXISTS password_enc TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE access_policies ADD COLUMN IF NOT EXISTS passwordless_server_access BOOLEAN NOT NULL DEFAULT TRUE`,
	}

	for _, ddl := range columnMigrations {
		if _, err := pg.pool.Exec(pg.ctx, ddl); err != nil {
			return fmt.Errorf("db: PostgreSQL column migration failed: %w\nStatement: %s", err, ddl)
		}
	}

	// Deferred indexes — must run AFTER column migrations so that columns
	// like linked_peer_id exist on databases created before v2.5.0.
	// We use PL/pgSQL DO blocks to safely check column existence first.
	// NOTE: Must use current_schema() to avoid cross-schema false positives.
	// Exception handler catches "column does not exist" if timing race occurs.
	deferredIndexes := []string{
		// linked_peer_id index — check column exists before creating
		`DO $$
		BEGIN
			IF EXISTS (
				SELECT 1 FROM information_schema.columns 
				WHERE table_schema = current_schema() AND table_name = 'peers' AND column_name = 'linked_peer_id'
			) THEN
				CREATE INDEX IF NOT EXISTS idx_peers_linked_peer ON peers(linked_peer_id) WHERE linked_peer_id != '';
			END IF;
		EXCEPTION WHEN undefined_column THEN
			-- Column doesn't exist yet, skip index creation silently
			NULL;
		END $$`,
	}
	for _, idx := range deferredIndexes {
		if _, err := pg.pool.Exec(pg.ctx, idx); err != nil {
			return fmt.Errorf("db: PostgreSQL deferred index failed: %w\nStatement: %s", err, idx)
		}
	}

	if err := pg.migrateBillingOrgContracts(); err != nil {
		return err
	}

	return nil
}

// migrateBillingOrgContracts copies legacy billing_org_contracts into billing_contracts.
func (pg *PostgresDB) migrateBillingOrgContracts() error {
	var exists bool
	err := pg.pool.QueryRow(pg.ctx, `
		SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema = current_schema() AND table_name = 'billing_org_contracts'
		)`).Scan(&exists)
	if err != nil || !exists {
		return err
	}
	var n int
	if err := pg.pool.QueryRow(pg.ctx, `SELECT COUNT(*) FROM billing_contracts`).Scan(&n); err != nil {
		return fmt.Errorf("db: billing_contracts count: %w", err)
	}
	if n > 0 {
		return nil
	}
	_, err = pg.pool.Exec(pg.ctx, `
		INSERT INTO billing_contracts
			(id, target_type, target_key, package_id, status, remaining_minutes, overage_rate, hourly_rate, currency, valid_from, valid_until, created_at, updated_at)
		SELECT id, 'org', org_id, package_id, status, remaining_minutes, overage_rate, hourly_rate, currency, valid_from, valid_until, created_at, updated_at
		FROM billing_org_contracts
		ON CONFLICT (target_type, target_key) DO NOTHING`)
	if err != nil {
		return fmt.Errorf("db: migrate billing_org_contracts: %w", err)
	}
	return nil
}

// ── Peer Operations ───────────────────────────────────────────────────

// peerColumns is the shared SELECT list for all peer queries.
const peerColumns = `id, uuid, pk, ip, "user", hostname, os, version,
	status, nat_type, last_online, created_at,
	disabled, banned, ban_reason, banned_at,
	soft_deleted, deleted_at, note, tags, heartbeat_seq,
	device_type, linked_peer_id, display_name`

// scanPeer scans a row into a Peer struct using nullable types.
func scanPeer(row pgx.Row) (*Peer, error) {
	p := &Peer{}
	var lastOnline, bannedAt, deletedAt *time.Time

	err := row.Scan(
		&p.ID, &p.UUID, &p.PK, &p.IP, &p.User, &p.Hostname,
		&p.OS, &p.Version, &p.Status, &p.NATType,
		&lastOnline, &p.CreatedAt, &p.Disabled, &p.Banned,
		&p.BanReason, &bannedAt, &p.SoftDeleted, &deletedAt,
		&p.Note, &p.Tags, &p.HeartbeatSeq,
		&p.DeviceType, &p.LinkedPeerID, &p.DisplayName,
	)
	if err != nil {
		return nil, err
	}

	if lastOnline != nil {
		p.LastOnline = *lastOnline
	}
	p.BannedAt = bannedAt
	p.DeletedAt = deletedAt

	return p, nil
}

// GetPeer returns a peer by ID, or nil if not found.
func (pg *PostgresDB) GetPeer(id string) (*Peer, error) {
	row := pg.pool.QueryRow(pg.ctx,
		`SELECT `+peerColumns+` FROM peers WHERE id = $1 AND (soft_deleted IS NULL OR soft_deleted = false)`, id)
	p, err := scanPeer(row)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("db: GetPeer(%q): %w", id, err)
	}
	return p, nil
}

// GetPeerIDState returns whether an ID is missing, active, or soft-deleted.
func (pg *PostgresDB) GetPeerIDState(id string) (PeerIDState, error) {
	var deleted bool
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT soft_deleted FROM peers WHERE id = $1`, id).Scan(&deleted)
	if err == pgx.ErrNoRows {
		return PeerIDMissing, nil
	}
	if err != nil {
		return "", fmt.Errorf("db: GetPeerIDState(%q): %w", id, err)
	}
	if deleted {
		return PeerIDSoftDeleted, nil
	}
	return PeerIDActive, nil
}

// GetPeersByIDs returns active peers for the given IDs in one query.
func (pg *PostgresDB) GetPeersByIDs(ids []string) (map[string]*Peer, error) {
	if len(ids) == 0 {
		return map[string]*Peer{}, nil
	}

	rows, err := pg.pool.Query(pg.ctx,
		`SELECT `+peerColumns+` FROM peers WHERE soft_deleted = FALSE AND id = ANY($1)`, ids)
	if err != nil {
		return nil, fmt.Errorf("db: GetPeersByIDs: %w", err)
	}
	defer rows.Close()

	peers, err := scanPeerRows(rows)
	if err != nil {
		return nil, fmt.Errorf("db: GetPeersByIDs: %w", err)
	}
	out := make(map[string]*Peer, len(peers))
	for _, p := range peers {
		out[p.ID] = p
	}
	return out, nil
}

// GetPeerByUUID returns a peer by UUID, or nil if not found.
func (pg *PostgresDB) GetPeerByUUID(uuid string) (*Peer, error) {
	row := pg.pool.QueryRow(pg.ctx,
		`SELECT `+peerColumns+` FROM peers WHERE uuid = $1`, uuid)
	p, err := scanPeer(row)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("db: GetPeerByUUID(%q): %w", uuid, err)
	}
	return p, nil
}

// UpsertPeer inserts or updates a peer record (PostgreSQL ON CONFLICT).
func (pg *PostgresDB) UpsertPeer(p *Peer) error {
	var lastOnline *time.Time
	if !p.LastOnline.IsZero() {
		lastOnline = &p.LastOnline
	}

	_, err := pg.pool.Exec(pg.ctx, `
		INSERT INTO peers (id, uuid, pk, ip, "user", hostname, os, version,
		                    status, nat_type, last_online, disabled, note, tags, heartbeat_seq)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
		ON CONFLICT (id) DO UPDATE SET
			uuid          = COALESCE(NULLIF(EXCLUDED.uuid, ''), peers.uuid),
			pk            = COALESCE(EXCLUDED.pk, peers.pk),
			ip            = EXCLUDED.ip,
			"user"        = COALESCE(NULLIF(EXCLUDED."user", ''), peers."user"),
			hostname      = COALESCE(NULLIF(EXCLUDED.hostname, ''), peers.hostname),
			os            = COALESCE(NULLIF(EXCLUDED.os, ''), peers.os),
			version       = COALESCE(NULLIF(EXCLUDED.version, ''), peers.version),
			status        = EXCLUDED.status,
			nat_type      = EXCLUDED.nat_type,
			last_online   = EXCLUDED.last_online,
			disabled      = EXCLUDED.disabled,
			note          = COALESCE(NULLIF(EXCLUDED.note, ''), peers.note),
			tags          = COALESCE(NULLIF(EXCLUDED.tags, ''), peers.tags),
			heartbeat_seq = EXCLUDED.heartbeat_seq`,
		/* SECURITY (GHSA-3v82-3gf8-fxx8): UpsertPeer MUST NOT silently clear
		   soft_deleted/deleted_at on conflict. Restoration is now an explicit
		   operation — see RestorePeer. */
		p.ID, p.UUID, p.PK, p.IP, p.User, p.Hostname, p.OS, p.Version,
		p.Status, p.NATType, lastOnline, p.Disabled, p.Note, p.Tags, p.HeartbeatSeq,
	)
	if err != nil {
		return fmt.Errorf("db: UpsertPeer(%q): %w", p.ID, err)
	}
	return nil
}

// DeletePeer marks a peer as soft-deleted.
func (pg *PostgresDB) DeletePeer(id string) error {
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE peers SET soft_deleted = TRUE, deleted_at = NOW() WHERE id = $1`, id)
	return err
}

// HardDeletePeer permanently removes a peer from the database and releases
// any id_change_history reservations for that ID (#213).
func (pg *PostgresDB) HardDeletePeer(id string) error {
	tx, err := pg.pool.Begin(pg.ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(pg.ctx)

	if _, err := tx.Exec(pg.ctx, `DELETE FROM peers WHERE id = $1`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(pg.ctx,
		`DELETE FROM id_change_history WHERE old_id = $1 OR new_id = $1`, id); err != nil {
		return err
	}
	return tx.Commit(pg.ctx)
}

// ListPeers returns all peers, optionally including soft-deleted ones.
func (pg *PostgresDB) ListPeers(includeDeleted bool) ([]*Peer, error) {
	query := `SELECT ` + peerColumns + ` FROM peers`
	if !includeDeleted {
		query += ` WHERE soft_deleted = FALSE`
	}
	query += ` ORDER BY id`

	rows, err := pg.pool.Query(pg.ctx, query)
	if err != nil {
		return nil, fmt.Errorf("db: ListPeers: %w", err)
	}
	defer rows.Close()

	var peers []*Peer
	for rows.Next() {
		p, err := scanPeer(rows)
		if err != nil {
			return nil, fmt.Errorf("db: ListPeers scan: %w", err)
		}
		peers = append(peers, p)
	}
	return peers, rows.Err()
}

// ListPeersPaginated returns a page of peers and the total matching row count.
func (pg *PostgresDB) ListPeersPaginated(includeDeleted bool, limit, offset int) ([]*Peer, int, error) {
	where := ""
	if !includeDeleted {
		where = ` WHERE soft_deleted = FALSE`
	}

	var total int
	if err := pg.pool.QueryRow(pg.ctx, `SELECT COUNT(*) FROM peers`+where).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("db: ListPeersPaginated count: %w", err)
	}

	query := `SELECT ` + peerColumns + ` FROM peers` + where + ` ORDER BY id`
	if limit > 0 {
		query += fmt.Sprintf(` LIMIT %d OFFSET %d`, limit, offset)
	}

	rows, err := pg.pool.Query(pg.ctx, query)
	if err != nil {
		return nil, 0, fmt.Errorf("db: ListPeersPaginated: %w", err)
	}
	defer rows.Close()

	peers, err := scanPeerRows(rows)
	if err != nil {
		return nil, 0, fmt.Errorf("db: ListPeersPaginated: %w", err)
	}
	return peers, total, nil
}

// GetPeerCount returns total and online peer counts.
func (pg *PostgresDB) GetPeerCount() (total int, online int, err error) {
	err = pg.pool.QueryRow(pg.ctx,
		`SELECT COUNT(*) FROM peers WHERE soft_deleted = FALSE`).Scan(&total)
	if err != nil {
		return 0, 0, err
	}
	err = pg.pool.QueryRow(pg.ctx,
		`SELECT COUNT(*) FROM peers WHERE soft_deleted = FALSE AND status = 'ONLINE'`).Scan(&online)
	return total, online, err
}

// GetBannedPeerCount returns the number of banned peers in the database.
func (pg *PostgresDB) GetBannedPeerCount() (int, error) {
	var count int
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT COUNT(*) FROM peers WHERE banned = TRUE AND soft_deleted = FALSE`).Scan(&count)
	return count, err
}

// UpdatePeerStatus updates a peer's status and IP, plus last_online timestamp.
func (pg *PostgresDB) UpdatePeerStatus(id string, status string, ip string) error {
	ctx, cancel := pg.opCtx()
	defer cancel()
	_, err := pg.pool.Exec(ctx,
		`UPDATE peers SET status = $1, ip = $2, last_online = NOW() WHERE id = $3 AND soft_deleted = FALSE`,
		status, ip, id)
	return err
}

// BatchUpdatePeerStatus sets status for many peers in one query.
func (pg *PostgresDB) BatchUpdatePeerStatus(ids []string, status string) error {
	if len(ids) == 0 {
		return nil
	}
	ctx, cancel := pg.opCtx()
	defer cancel()
	_, err := pg.pool.Exec(ctx,
		`UPDATE peers SET status = $1, last_online = NOW() WHERE soft_deleted = FALSE AND id = ANY($2)`,
		status, ids)
	return err
}

// UpdatePeerSysinfo updates hostname, os, and version for a peer.
// Only non-empty values overwrite existing data.
func (pg *PostgresDB) UpdatePeerSysinfo(id, hostname, os, version string) error {
	_, err := pg.pool.Exec(pg.ctx, `
		UPDATE peers SET
			hostname = CASE WHEN $1 != '' THEN $1 ELSE hostname END,
			os = CASE WHEN $2 != '' THEN $2 ELSE os END,
			version = CASE WHEN $3 != '' THEN $3 ELSE version END
		WHERE id = $4`,
		hostname, os, version, id)
	return err
}

// SetAllOffline marks all peers as OFFLINE. Called at server startup.
func (pg *PostgresDB) SetAllOffline() error {
	_, err := pg.pool.Exec(pg.ctx, `UPDATE peers SET status = 'OFFLINE'`)
	return err
}

// ── Ban System ────────────────────────────────────────────────────────

// BanPeer bans a specific peer by ID.
func (pg *PostgresDB) BanPeer(id string, reason string) error {
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE peers SET banned = TRUE, ban_reason = $1, banned_at = NOW() WHERE id = $2`,
		reason, id)
	return err
}

// UnbanPeer removes the ban from a peer.
func (pg *PostgresDB) UnbanPeer(id string) error {
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE peers SET banned = FALSE, ban_reason = '', banned_at = NULL WHERE id = $1`, id)
	return err
}

// IsPeerBanned checks if a peer is banned.
func (pg *PostgresDB) IsPeerBanned(id string) (bool, error) {
	var banned bool
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT banned FROM peers WHERE id = $1`, id).Scan(&banned)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	return banned, err
}

// IsPeerSoftDeleted checks if a peer is soft-deleted.
func (pg *PostgresDB) IsPeerSoftDeleted(id string) (bool, error) {
	var deleted bool
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT soft_deleted FROM peers WHERE id = $1`, id).Scan(&deleted)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	return deleted, err
}

// RestorePeer clears soft_deleted and deleted_at for a previously deleted
// peer. Required because UpsertPeer no longer does this implicitly
// (GHSA-3v82-3gf8-fxx8).
func (pg *PostgresDB) RestorePeer(id string) error {
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE peers SET soft_deleted = FALSE, deleted_at = NULL WHERE id = $1`,
		id)
	return err
}

// UpdatePeerFields updates specific peer fields (note, user, tags, device_type, linked_peer_id).
// Only provided keys are updated; others are left unchanged.
// Allowed keys: "note", "user", "tags", "device_type", "linked_peer_id".
func (pg *PostgresDB) UpdatePeerFields(id string, fields map[string]string) error {
	allowed := map[string]string{"note": "note", "user": `"user"`, "tags": "tags", "device_type": "device_type", "linked_peer_id": "linked_peer_id", "display_name": "display_name"}
	setClauses := []string{}
	args := []interface{}{}
	idx := 1
	for k, v := range fields {
		col, ok := allowed[k]
		if !ok {
			continue
		}
		setClauses = append(setClauses, fmt.Sprintf("%s = $%d", col, idx))
		args = append(args, v)
		idx++
	}
	if len(setClauses) == 0 {
		return nil
	}
	args = append(args, id)
	query := fmt.Sprintf("UPDATE peers SET %s WHERE id = $%d AND soft_deleted = FALSE",
		strings.Join(setClauses, ", "), idx)
	_, err := pg.pool.Exec(pg.ctx, query, args...)
	return err
}

// ── ID Change ─────────────────────────────────────────────────────────

func (pg *PostgresDB) cascadePeerIDInTx(ctx context.Context, tx pgx.Tx, oldID, newID string) error {
	stmts := []struct {
		query string
		args  []any
	}{
		{`UPDATE device_tokens SET peer_id = $1 WHERE peer_id = $2`, []any{newID, oldID}},
		{`UPDATE org_devices SET device_id = $1 WHERE device_id = $2`, []any{newID, oldID}},
		{`UPDATE peers SET linked_peer_id = $1 WHERE linked_peer_id = $2`, []any{newID, oldID}},
		{`UPDATE device_folder_assignments SET device_id = $1 WHERE device_id = $2`, []any{newID, oldID}},
		{`UPDATE device_group_members SET peer_id = $1 WHERE peer_id = $2`, []any{newID, oldID}},
	}
	for _, st := range stmts {
		if _, err := tx.Exec(ctx, st.query, st.args...); err != nil {
			return fmt.Errorf("db: cascadePeerID %s→%s: %w", oldID, newID, err)
		}
	}
	return nil
}

// ChangePeerID changes a peer's ID and records it in history.
// Uses a PostgreSQL transaction with row-level locking.
func (pg *PostgresDB) ChangePeerID(oldID, newID, reason string) error {
	tx, err := pg.pool.Begin(pg.ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(pg.ctx)

	var targetDeleted bool
	if err := tx.QueryRow(pg.ctx,
		`SELECT soft_deleted FROM peers WHERE id = $1`, newID).Scan(&targetDeleted); err != nil && err != pgx.ErrNoRows {
		return err
	} else if err == nil {
		if targetDeleted {
			return ErrPeerIDSoftDeleted
		}
		return ErrPeerIDExists
	}

	// Lock and copy the old row with FOR UPDATE
	tag, err := tx.Exec(pg.ctx, `
		INSERT INTO peers (id, uuid, pk, ip, "user", hostname, os, version,
		                    status, nat_type, last_online, created_at,
		                    disabled, banned, ban_reason, banned_at,
		                    soft_deleted, deleted_at, note, tags, heartbeat_seq,
		                    device_type, linked_peer_id, display_name)
		SELECT $1, uuid, pk, ip, "user", hostname, os, version,
		       status, nat_type, last_online, created_at,
		       disabled, banned, ban_reason, banned_at,
		       soft_deleted, deleted_at, note, tags, heartbeat_seq,
		       device_type, linked_peer_id, display_name
		FROM peers WHERE id = $2 AND soft_deleted = FALSE FOR UPDATE`, newID, oldID)
	if err != nil {
		return fmt.Errorf("db: ChangePeerID insert: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrPeerNotFound
	}

	if _, err := tx.Exec(pg.ctx, `DELETE FROM peers WHERE id = $1`, oldID); err != nil {
		return fmt.Errorf("db: ChangePeerID delete: %w", err)
	}

	if err := pg.cascadePeerIDInTx(pg.ctx, tx, oldID, newID); err != nil {
		return err
	}

	if _, err := tx.Exec(pg.ctx,
		`INSERT INTO id_change_history (old_id, new_id, reason) VALUES ($1, $2, $3)`,
		oldID, newID, reason); err != nil {
		return fmt.Errorf("db: ChangePeerID history: %w", err)
	}

	return tx.Commit(pg.ctx)
}

// GetIDChangeHistory returns the ID change history for a peer.
func (pg *PostgresDB) GetIDChangeHistory(id string) ([]*IDChangeHistory, error) {
	rows, err := pg.pool.Query(pg.ctx,
		`SELECT old_id, new_id, changed_at, reason FROM id_change_history
		 WHERE old_id = $1 OR new_id = $1 ORDER BY changed_at DESC`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var history []*IDChangeHistory
	for rows.Next() {
		h := &IDChangeHistory{}
		if err := rows.Scan(&h.OldID, &h.NewID, &h.ChangedAt, &h.Reason); err != nil {
			return nil, err
		}
		history = append(history, h)
	}
	return history, rows.Err()
}

// IsRenamedPeerID returns true if the given ID was previously used and then
// changed to a different one (appears as old_id in id_change_history).
func (pg *PostgresDB) IsRenamedPeerID(id string) (bool, error) {
	var count int
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT COUNT(*) FROM id_change_history WHERE old_id = $1`, id).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// GetLatestRenameTarget returns the most recent new_id for old_id.
func (pg *PostgresDB) GetLatestRenameTarget(oldID string) (string, error) {
	var newID string
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT new_id FROM id_change_history WHERE old_id = $1 ORDER BY id DESC LIMIT 1`,
		oldID).Scan(&newID)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return newID, nil
}

// ReleasePeerID clears id_change_history rows involving id.
func (pg *PostgresDB) ReleasePeerID(id string) error {
	_, err := pg.pool.Exec(pg.ctx,
		`DELETE FROM id_change_history WHERE old_id = $1 OR new_id = $1`, id)
	return err
}

// GetLinkedPeers returns all non-deleted peers that have linked_peer_id matching the given ID.
func (pg *PostgresDB) GetLinkedPeers(id string) ([]*Peer, error) {
	rows, err := pg.pool.Query(pg.ctx, `
		SELECT `+peerColumns+`
		FROM peers
		WHERE soft_deleted = FALSE AND linked_peer_id = $1
		ORDER BY id`, id)
	if err != nil {
		return nil, fmt.Errorf("db: GetLinkedPeers: %w", err)
	}
	defer rows.Close()

	var peers []*Peer
	for rows.Next() {
		p, err := scanPeer(rows)
		if err != nil {
			return nil, fmt.Errorf("db: GetLinkedPeers scan: %w", err)
		}
		peers = append(peers, p)
	}
	return peers, rows.Err()
}

// ── Tags ──────────────────────────────────────────────────────────────

// UpdatePeerTags updates the tags field for a peer.
func (pg *PostgresDB) UpdatePeerTags(id, tags string) error {
	ct, err := pg.pool.Exec(pg.ctx,
		`UPDATE peers SET tags = $1 WHERE id = $2`, tags, id)
	if err != nil {
		return err
	}
	if ct.RowsAffected() == 0 {
		return fmt.Errorf("peer %s not found", id)
	}
	return nil
}

// ListPeersByTag returns all non-deleted peers that have the given tag.
// Uses LIKE with escaped wildcards to prevent SQL injection via pattern chars.
func (pg *PostgresDB) ListPeersByTag(tag string) ([]*Peer, error) {
	// Escape SQL LIKE wildcards (M1)
	escaped := strings.NewReplacer("%", "\\%", "_", "\\_").Replace(tag)
	pattern := "%" + escaped + "%"

	rows, err := pg.pool.Query(pg.ctx, `
		SELECT `+peerColumns+`
		FROM peers
		WHERE soft_deleted = FALSE AND tags LIKE $1 ESCAPE '\'
		ORDER BY id`, pattern)
	if err != nil {
		return nil, fmt.Errorf("db: ListPeersByTag: %w", err)
	}
	defer rows.Close()

	var peers []*Peer
	for rows.Next() {
		p, err := scanPeer(rows)
		if err != nil {
			return nil, fmt.Errorf("db: ListPeersByTag scan: %w", err)
		}
		peers = append(peers, p)
	}
	return peers, rows.Err()
}

// ── Config ────────────────────────────────────────────────────────────

// GetConfig retrieves a configuration value by key.
func (pg *PostgresDB) GetConfig(key string) (string, error) {
	var value string
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT value FROM server_config WHERE key = $1`, key).Scan(&value)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	return value, err
}

// SetConfig sets a configuration key-value pair using UPSERT.
func (pg *PostgresDB) SetConfig(key, value string) error {
	_, err := pg.pool.Exec(pg.ctx,
		`INSERT INTO server_config (key, value) VALUES ($1, $2)
		 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, key, value)
	return err
}

// DeleteConfig removes a configuration key.
func (pg *PostgresDB) DeleteConfig(key string) error {
	_, err := pg.pool.Exec(pg.ctx, `DELETE FROM server_config WHERE key = $1`, key)
	return err
}

// ListConfigByPrefix returns all configuration entries whose key starts with the given prefix.
func (pg *PostgresDB) ListConfigByPrefix(prefix string) ([]ServerConfig, error) {
	rows, err := pg.pool.Query(pg.ctx,
		`SELECT key, value FROM server_config WHERE key LIKE $1`,
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

// ── User Operations ───────────────────────────────────────────────────

// CreateUser inserts a new user and sets u.ID to the generated primary key.
func (pg *PostgresDB) CreateUser(u *User) error {
	if u.AuthProvider == "" {
		u.AuthProvider = AuthProviderLocal
	}
	err := pg.pool.QueryRow(pg.ctx,
		`INSERT INTO users (username, password_hash, role, auth_provider, totp_secret, totp_enabled)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		u.Username, u.PasswordHash, u.Role, u.AuthProvider, u.TOTPSecret, u.TOTPEnabled,
	).Scan(&u.ID)
	if err != nil {
		return fmt.Errorf("db: CreateUser: %w", err)
	}
	return nil
}

// scanUser scans a user row. PostgreSQL uses TIMESTAMPTZ for dates, which
// the Node.js console stores as TEXT — we convert to string representation
// where the interface expects strings.
func scanUser(row pgx.Row) (*User, error) {
	u := &User{}
	var createdAt *time.Time
	var lastLogin *time.Time
	var recoveryCodes *string
	var authProvider *string

	err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.Role,
		&u.TOTPSecret, &u.TOTPEnabled, &createdAt, &lastLogin, &u.IsServerAdmin, &recoveryCodes, &authProvider)
	if err != nil {
		return nil, err
	}

	if createdAt != nil {
		u.CreatedAt = createdAt.Format("2006-01-02 15:04:05")
	}
	if lastLogin != nil {
		u.LastLogin = lastLogin.Format("2006-01-02 15:04:05")
	}
	if recoveryCodes != nil {
		u.TOTPRecoveryCodes = *recoveryCodes
	}
	if authProvider != nil && *authProvider != "" {
		u.AuthProvider = *authProvider
	} else {
		u.AuthProvider = AuthProviderLocal
	}

	return u, nil
}

// userSelectColsPG is the shared SELECT list for GetUser/GetUserByID/ListUsers.
// COALESCE(totp_secret, '') matches SQLite (Issue #292/#301): Node panel inserts
// often leave totp_secret NULL; scanning NULL into Go string fails and breaks
// GET /api/users, which in turn triggered mirrorCreate retry loops.
const userSelectColsPG = `id, username, password_hash, role, COALESCE(totp_secret, ''), totp_enabled,
		        created_at, last_login, COALESCE(is_server_admin, FALSE), totp_recovery_codes, COALESCE(auth_provider, 'local')`

// GetUser returns a user by username, or nil if not found.
func (pg *PostgresDB) GetUser(username string) (*User, error) {
	row := pg.pool.QueryRow(pg.ctx,
		`SELECT `+userSelectColsPG+` FROM users WHERE username = $1`, username)
	u, err := scanUser(row)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return u, err
}

// GetUserByID returns a user by numeric ID, or nil if not found.
func (pg *PostgresDB) GetUserByID(id int64) (*User, error) {
	row := pg.pool.QueryRow(pg.ctx,
		`SELECT `+userSelectColsPG+` FROM users WHERE id = $1`, id)
	u, err := scanUser(row)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return u, err
}

// ListUsers returns all users.
func (pg *PostgresDB) ListUsers() ([]*User, error) {
	rows, err := pg.pool.Query(pg.ctx,
		`SELECT `+userSelectColsPG+` FROM users ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("db: ListUsers: %w", err)
	}
	defer rows.Close()

	var users []*User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

// UpdateUser updates a user's mutable fields.
func (pg *PostgresDB) UpdateUser(u *User) error {
	var recoveryCodes interface{}
	if u.TOTPRecoveryCodes == "" {
		recoveryCodes = nil
	} else {
		recoveryCodes = u.TOTPRecoveryCodes
	}
	if u.AuthProvider == "" {
		u.AuthProvider = AuthProviderLocal
	}
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE users SET password_hash = $1, role = $2, totp_secret = $3, totp_enabled = $4, is_server_admin = $5, totp_recovery_codes = $6, auth_provider = $7
		 WHERE id = $8`,
		u.PasswordHash, u.Role, u.TOTPSecret, u.TOTPEnabled, u.IsServerAdmin, recoveryCodes, u.AuthProvider, u.ID)
	return err
}

// DeleteUser removes a user by ID and clears org membership links (Issue #292).
func (pg *PostgresDB) DeleteUser(id int64) error {
	if _, err := pg.pool.Exec(pg.ctx,
		`DELETE FROM org_users WHERE server_user_id = $1 AND server_user_id > 0`, id); err != nil {
		return fmt.Errorf("db: DeleteUser org cleanup: %w", err)
	}
	_, err := pg.pool.Exec(pg.ctx, `DELETE FROM users WHERE id = $1`, id)
	return err
}

// UpdateUserLogin updates the last_login timestamp for a user.
func (pg *PostgresDB) UpdateUserLogin(id int64) error {
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE users SET last_login = NOW() WHERE id = $1`, id)
	return err
}

// UserCount returns the total number of users.
func (pg *PostgresDB) UserCount() (int, error) {
	var count int
	err := pg.pool.QueryRow(pg.ctx, `SELECT COUNT(*) FROM users`).Scan(&count)
	return count, err
}

// ── API Key Operations ────────────────────────────────────────────────

// CreateAPIKey inserts a new API key and sets k.ID.
func (pg *PostgresDB) CreateAPIKey(k *APIKey) error {
	var expiresAt *time.Time
	if k.ExpiresAt != "" {
		t, err := time.Parse("2006-01-02 15:04:05", k.ExpiresAt)
		if err == nil {
			expiresAt = &t
		}
	}

	err := pg.pool.QueryRow(pg.ctx,
		`INSERT INTO api_keys (key_hash, key_prefix, name, role, expires_at)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		k.KeyHash, k.KeyPrefix, k.Name, k.Role, expiresAt,
	).Scan(&k.ID)
	if err != nil {
		return fmt.Errorf("db: CreateAPIKey: %w", err)
	}
	return nil
}

// scanAPIKey scans an API key row.
func scanAPIKey(row pgx.Row) (*APIKey, error) {
	k := &APIKey{}
	var createdAt *time.Time
	var expiresAt *time.Time
	var lastUsed *time.Time

	err := row.Scan(&k.ID, &k.KeyHash, &k.KeyPrefix, &k.Name, &k.Role,
		&createdAt, &expiresAt, &lastUsed)
	if err != nil {
		return nil, err
	}

	if createdAt != nil {
		k.CreatedAt = createdAt.Format("2006-01-02 15:04:05")
	}
	if expiresAt != nil {
		k.ExpiresAt = expiresAt.Format("2006-01-02 15:04:05")
	}
	if lastUsed != nil {
		k.LastUsed = lastUsed.Format("2006-01-02 15:04:05")
	}

	return k, nil
}

// GetAPIKeyByHash returns an API key by its SHA-256 hash, or nil if not found.
func (pg *PostgresDB) GetAPIKeyByHash(keyHash string) (*APIKey, error) {
	row := pg.pool.QueryRow(pg.ctx,
		`SELECT id, key_hash, key_prefix, name, role, created_at, expires_at, last_used
		 FROM api_keys WHERE key_hash = $1`, keyHash)
	k, err := scanAPIKey(row)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return k, err
}

// ListAPIKeys returns all API keys.
func (pg *PostgresDB) ListAPIKeys() ([]*APIKey, error) {
	rows, err := pg.pool.Query(pg.ctx,
		`SELECT id, key_hash, key_prefix, name, role, created_at, expires_at, last_used
		 FROM api_keys ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("db: ListAPIKeys: %w", err)
	}
	defer rows.Close()

	var keys []*APIKey
	for rows.Next() {
		k, err := scanAPIKey(rows)
		if err != nil {
			return nil, err
		}
		keys = append(keys, k)
	}
	return keys, rows.Err()
}

// DeleteAPIKey removes an API key by ID.
func (pg *PostgresDB) DeleteAPIKey(id int64) error {
	_, err := pg.pool.Exec(pg.ctx, `DELETE FROM api_keys WHERE id = $1`, id)
	return err
}

// TouchAPIKey updates the last_used timestamp for an API key.
func (pg *PostgresDB) TouchAPIKey(id int64) error {
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE api_keys SET last_used = NOW() WHERE id = $1`, id)
	return err
}

// ── Device Token Operations (Dual Key System) ─────────────────────────

// CreateDeviceToken creates a new device enrollment token.
func (pg *PostgresDB) CreateDeviceToken(t *DeviceToken) error {
	var expiresAt *time.Time
	if t.ExpiresAt != nil {
		expiresAt = t.ExpiresAt
	}

	err := pg.pool.QueryRow(pg.ctx, `
		INSERT INTO device_tokens (token_hash, token_prefix, name, peer_id, status, max_uses, use_count, expires_at, created_by, note)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		RETURNING id, created_at`,
		t.TokenHash, t.Token[:8], t.Name, t.PeerID, t.Status, t.MaxUses, t.UseCount, expiresAt, t.CreatedBy, t.Note,
	).Scan(&t.ID, &t.CreatedAt)
	return err
}

// GetDeviceToken returns a device token by ID.
func (pg *PostgresDB) GetDeviceToken(id int64) (*DeviceToken, error) {
	return pg.getDeviceTokenByQuery(`SELECT id, token_hash, token_prefix, name, peer_id, status, max_uses, use_count, 
		created_at, expires_at, revoked_at, last_used_at, created_by, note 
		FROM device_tokens WHERE id = $1`, id)
}

// GetDeviceTokenByHash returns a device token by its hash.
func (pg *PostgresDB) GetDeviceTokenByHash(tokenHash string) (*DeviceToken, error) {
	return pg.getDeviceTokenByQuery(`SELECT id, token_hash, token_prefix, name, peer_id, status, max_uses, use_count, 
		created_at, expires_at, revoked_at, last_used_at, created_by, note 
		FROM device_tokens WHERE token_hash = $1`, tokenHash)
}

// GetDeviceTokenByPeerID returns the token bound to a peer.
func (pg *PostgresDB) GetDeviceTokenByPeerID(peerID string) (*DeviceToken, error) {
	return pg.getDeviceTokenByQuery(`SELECT id, token_hash, token_prefix, name, peer_id, status, max_uses, use_count, 
		created_at, expires_at, revoked_at, last_used_at, created_by, note 
		FROM device_tokens WHERE peer_id = $1 AND status IN ('active', 'pending')`, peerID)
}

// getDeviceTokenByQuery is a helper function to scan a device token row.
func (pg *PostgresDB) getDeviceTokenByQuery(query string, args ...interface{}) (*DeviceToken, error) {
	t := &DeviceToken{}
	var expiresAt, revokedAt, lastUsedAt *time.Time

	err := pg.pool.QueryRow(pg.ctx, query, args...).Scan(
		&t.ID, &t.TokenHash, &t.Token, &t.Name, &t.PeerID, &t.Status, &t.MaxUses, &t.UseCount,
		&t.CreatedAt, &expiresAt, &revokedAt, &lastUsedAt, &t.CreatedBy, &t.Note)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	t.ExpiresAt = expiresAt
	t.RevokedAt = revokedAt
	t.LastUsedAt = lastUsedAt
	return t, nil
}

// ListDeviceTokens returns all device tokens.
func (pg *PostgresDB) ListDeviceTokens(includeRevoked bool) ([]*DeviceToken, error) {
	query := `SELECT id, token_hash, token_prefix, name, peer_id, status, max_uses, use_count, 
		created_at, expires_at, revoked_at, last_used_at, created_by, note 
		FROM device_tokens`
	if !includeRevoked {
		query += ` WHERE status != 'revoked'`
	}
	query += ` ORDER BY id DESC`

	rows, err := pg.pool.Query(pg.ctx, query)
	if err != nil {
		return nil, fmt.Errorf("db: ListDeviceTokens: %w", err)
	}
	defer rows.Close()

	var tokens []*DeviceToken
	for rows.Next() {
		t := &DeviceToken{}
		var expiresAt, revokedAt, lastUsedAt *time.Time

		if err := rows.Scan(&t.ID, &t.TokenHash, &t.Token, &t.Name, &t.PeerID, &t.Status,
			&t.MaxUses, &t.UseCount, &t.CreatedAt, &expiresAt, &revokedAt, &lastUsedAt,
			&t.CreatedBy, &t.Note); err != nil {
			return nil, err
		}

		t.ExpiresAt = expiresAt
		t.RevokedAt = revokedAt
		t.LastUsedAt = lastUsedAt
		tokens = append(tokens, t)
	}
	return tokens, rows.Err()
}

// UpdateDeviceToken updates a device token.
func (pg *PostgresDB) UpdateDeviceToken(t *DeviceToken) error {
	_, err := pg.pool.Exec(pg.ctx, `
		UPDATE device_tokens SET name=$1, peer_id=$2, status=$3, max_uses=$4, expires_at=$5, note=$6
		WHERE id=$7`, t.Name, t.PeerID, t.Status, t.MaxUses, t.ExpiresAt, t.Note, t.ID)
	return err
}

// RevokeDeviceToken revokes a device token by ID.
func (pg *PostgresDB) RevokeDeviceToken(id int64) error {
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE device_tokens SET status='revoked', revoked_at=NOW() WHERE id=$1`, id)
	return err
}

// BindTokenToPeer binds a token to a peer ID after successful enrollment.
func (pg *PostgresDB) BindTokenToPeer(tokenHash, peerID string) error {
	_, err := pg.pool.Exec(pg.ctx, `
		UPDATE device_tokens SET peer_id=$1, status='active', last_used_at=NOW()
		WHERE token_hash=$2 AND status='pending'`, peerID, tokenHash)
	return err
}

// IncrementTokenUse increments the use count for a token.
func (pg *PostgresDB) IncrementTokenUse(tokenHash string) error {
	_, err := pg.pool.Exec(pg.ctx, `
		UPDATE device_tokens SET use_count = use_count + 1, last_used_at=NOW()
		WHERE token_hash=$1`, tokenHash)
	return err
}

// ValidateToken checks if a token is valid for enrollment.
// Returns the token if valid, nil if invalid/expired/revoked.
func (pg *PostgresDB) ValidateToken(tokenHash string) (*DeviceToken, error) {
	t, err := pg.GetDeviceTokenByHash(tokenHash)
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
		pg.pool.Exec(pg.ctx,
			`UPDATE device_tokens SET status='expired' WHERE id=$1 AND status NOT IN ('revoked', 'expired')`, t.ID)
		return nil, nil
	}

	// Check max uses
	if t.MaxUses > 0 && t.UseCount >= t.MaxUses {
		return nil, nil // Exceeded max uses
	}

	return t, nil
}

// CleanupExpiredTokens marks expired tokens as expired.
func (pg *PostgresDB) CleanupExpiredTokens() (int64, error) {
	tag, err := pg.pool.Exec(pg.ctx, `
		UPDATE device_tokens SET status='expired' 
		WHERE status='pending' AND expires_at IS NOT NULL AND expires_at < NOW()`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// ── Address Book ──────────────────────────────────────────────────────

// GetAddressBook retrieves the address book data for a user.
func (pg *PostgresDB) GetAddressBook(username, abType string) (string, error) {
	var data string
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT data FROM address_books WHERE username = $1 AND ab_type = $2`,
		username, abType).Scan(&data)
	if err == pgx.ErrNoRows {
		return "{}", nil
	}
	return data, err
}

// SaveAddressBook stores the address book data for a user (upsert).
func (pg *PostgresDB) SaveAddressBook(username, abType, data string) error {
	_, err := pg.pool.Exec(pg.ctx,
		`INSERT INTO address_books (username, ab_type, data, updated_at)
		 VALUES ($1, $2, $3, NOW())
		 ON CONFLICT (username, ab_type) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
		username, abType, data)
	return err
}

// ── Peer Metrics ──────────────────────────────────────────────────────

// SavePeerMetric inserts a new metric record for a peer.
func (pg *PostgresDB) SavePeerMetric(peerID string, cpu, memory, disk float64) error {
	_, err := pg.pool.Exec(pg.ctx,
		`INSERT INTO peer_metrics (peer_id, cpu_usage, memory_usage, disk_usage) VALUES ($1, $2, $3, $4)`,
		peerID, cpu, memory, disk)
	return err
}

// GetPeerMetrics retrieves the most recent N metric records for a peer.
func (pg *PostgresDB) GetPeerMetrics(peerID string, limit int) ([]*PeerMetric, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := pg.pool.Query(pg.ctx,
		`SELECT id, peer_id, cpu_usage, memory_usage, disk_usage, created_at
		 FROM peer_metrics WHERE peer_id = $1 ORDER BY created_at DESC LIMIT $2`,
		peerID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var metrics []*PeerMetric
	for rows.Next() {
		m := &PeerMetric{}
		if err := rows.Scan(&m.ID, &m.PeerID, &m.CPU, &m.Memory, &m.Disk, &m.CreatedAt); err != nil {
			return nil, err
		}
		metrics = append(metrics, m)
	}
	return metrics, rows.Err()
}

// GetLatestPeerMetric returns the single most recent metric for a peer.
func (pg *PostgresDB) GetLatestPeerMetric(peerID string) (*PeerMetric, error) {
	metrics, err := pg.GetPeerMetrics(peerID, 1)
	if err != nil {
		return nil, err
	}
	if len(metrics) == 0 {
		return nil, nil
	}
	return metrics[0], nil
}

// CleanupOldMetrics deletes metrics older than maxAge. Returns deleted count.
func (pg *PostgresDB) CleanupOldMetrics(maxAge time.Duration) (int64, error) {
	cutoff := time.Now().Add(-maxAge)
	result, err := pg.pool.Exec(pg.ctx,
		`DELETE FROM peer_metrics WHERE created_at < $1`, cutoff)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected(), nil
}

// ── Chat Messages ─────────────────────────────────────────────────────

func (pg *PostgresDB) SaveChatMessage(msg *ChatMessage) (int64, error) {
	var id int64
	err := pg.pool.QueryRow(pg.ctx,
		`INSERT INTO chat_messages (conversation_id, from_id, from_name, to_id, text, read)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		msg.ConversationID, msg.FromID, msg.FromName, msg.ToID, msg.Text, msg.Read,
	).Scan(&id)
	return id, err
}

func (pg *PostgresDB) GetChatHistory(conversationID string, limit int) ([]*ChatMessage, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := pg.pool.Query(pg.ctx,
		`SELECT id, conversation_id, from_id, from_name, to_id, text, read, created_at
		 FROM chat_messages WHERE conversation_id = $1
		 ORDER BY id DESC LIMIT $2`, conversationID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var msgs []*ChatMessage
	for rows.Next() {
		var m ChatMessage
		if err := rows.Scan(&m.ID, &m.ConversationID, &m.FromID, &m.FromName, &m.ToID, &m.Text, &m.Read, &m.CreatedAt); err != nil {
			return nil, err
		}
		msgs = append(msgs, &m)
	}
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	return msgs, nil
}

func (pg *PostgresDB) GetChatHistoryBefore(conversationID string, beforeID int64, limit int) ([]*ChatMessage, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := pg.pool.Query(pg.ctx,
		`SELECT id, conversation_id, from_id, from_name, to_id, text, read, created_at
		 FROM chat_messages WHERE conversation_id = $1 AND id < $2
		 ORDER BY id DESC LIMIT $3`, conversationID, beforeID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var msgs []*ChatMessage
	for rows.Next() {
		var m ChatMessage
		if err := rows.Scan(&m.ID, &m.ConversationID, &m.FromID, &m.FromName, &m.ToID, &m.Text, &m.Read, &m.CreatedAt); err != nil {
			return nil, err
		}
		msgs = append(msgs, &m)
	}
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	return msgs, nil
}

func (pg *PostgresDB) MarkChatRead(conversationID, readerID string) error {
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE chat_messages SET read = TRUE
		 WHERE conversation_id = $1 AND from_id != $2 AND read = FALSE`,
		conversationID, readerID)
	return err
}

func (pg *PostgresDB) GetUnreadCount(deviceID string) (int, error) {
	var count int
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT COUNT(*) FROM chat_messages
		 WHERE (conversation_id = $1 OR to_id = $1) AND from_id != $1 AND read = FALSE`,
		deviceID).Scan(&count)
	return count, err
}

func (pg *PostgresDB) DeleteChatHistory(conversationID string) error {
	_, err := pg.pool.Exec(pg.ctx,
		`DELETE FROM chat_messages WHERE conversation_id = $1`, conversationID)
	return err
}

// ── Chat Groups ───────────────────────────────────────────────────────

func (pg *PostgresDB) CreateChatGroup(g *ChatGroup) error {
	_, err := pg.pool.Exec(pg.ctx,
		`INSERT INTO chat_groups (id, name, members, created_by) VALUES ($1, $2, $3, $4)`,
		g.ID, g.Name, g.Members, g.CreatedBy)
	return err
}

func (pg *PostgresDB) GetChatGroup(id string) (*ChatGroup, error) {
	var g ChatGroup
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT id, name, members, created_by, created_at FROM chat_groups WHERE id = $1`, id,
	).Scan(&g.ID, &g.Name, &g.Members, &g.CreatedBy, &g.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &g, nil
}

func (pg *PostgresDB) ListChatGroups(memberID string) ([]*ChatGroup, error) {
	pattern := "%" + memberID + "%"
	rows, err := pg.pool.Query(pg.ctx,
		`SELECT id, name, members, created_by, created_at FROM chat_groups WHERE members LIKE $1`, pattern)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var groups []*ChatGroup
	for rows.Next() {
		var g ChatGroup
		if err := rows.Scan(&g.ID, &g.Name, &g.Members, &g.CreatedBy, &g.CreatedAt); err != nil {
			return nil, err
		}
		groups = append(groups, &g)
	}
	return groups, nil
}

func (pg *PostgresDB) UpdateChatGroup(g *ChatGroup) error {
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE chat_groups SET name = $1, members = $2 WHERE id = $3`,
		g.Name, g.Members, g.ID)
	return err
}

func (pg *PostgresDB) DeleteChatGroup(id string) error {
	_, err := pg.pool.Exec(pg.ctx,
		`DELETE FROM chat_groups WHERE id = $1`, id)
	return err
}

// ── LISTEN/NOTIFY ─────────────────────────────────────────────────────

// OnNotify registers a callback for PostgreSQL LISTEN/NOTIFY events.
// This enables real-time event push between multiple server instances
// sharing the same database.
func (pg *PostgresDB) OnNotify(fn func(channel, payload string)) {
	pg.notifyFunc = fn
}

// Notify sends a NOTIFY event on the given channel with the given payload.
// Other server instances listening on the same channel will receive it.
func (pg *PostgresDB) Notify(channel, payload string) error {
	_, err := pg.pool.Exec(pg.ctx,
		`SELECT pg_notify($1, $2)`, channel, payload)
	return err
}

// ListenLoop starts listening for notifications on the given channels.
// This blocks and should be called in a goroutine. It reconnects on error.
// Call with context cancellation to stop.
func (pg *PostgresDB) ListenLoop(ctx context.Context, channels ...string) {
	for {
		err := pg.listenOnce(ctx, channels...)
		if ctx.Err() != nil {
			return // context cancelled, clean exit
		}
		log.Printf("[db] PostgreSQL LISTEN error, reconnecting in 5s: %v", err)
		select {
		case <-time.After(5 * time.Second):
		case <-ctx.Done():
			return
		}
	}
}

// listenOnce acquires a dedicated connection and listens until error or cancel.
func (pg *PostgresDB) listenOnce(ctx context.Context, channels ...string) error {
	conn, err := pg.pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire conn for LISTEN: %w", err)
	}
	defer conn.Release()

	for _, ch := range channels {
		// LISTEN requires raw SQL (not parameterized).
		// Channel names are validated to be simple identifiers.
		if !isValidChannel(ch) {
			return fmt.Errorf("invalid channel name: %q", ch)
		}
		if _, err := conn.Exec(ctx, "LISTEN "+ch); err != nil {
			return fmt.Errorf("LISTEN %s: %w", ch, err)
		}
	}

	log.Printf("[db] PostgreSQL LISTEN on channels: %s", strings.Join(channels, ", "))

	for {
		notification, err := conn.Conn().WaitForNotification(ctx)
		if err != nil {
			return err
		}
		if pg.notifyFunc != nil {
			pg.notifyFunc(notification.Channel, notification.Payload)
		}
	}
}

// isValidChannel checks that a channel name is a safe SQL identifier.
func isValidChannel(ch string) bool {
	if len(ch) == 0 || len(ch) > 63 {
		return false
	}
	for _, c := range ch {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') || c == '_') {
			return false
		}
	}
	return true
}

// Ensure PostgresDB implements the Database interface at compile time.
var _ Database = (*PostgresDB)(nil)

// scanPeerRows is used by collectRows helper to avoid code duplication.
// Note: We intentionally don't use pgx.CollectRows here because scanPeer
// handles our custom nullable-to-Peer-field mapping consistently.
func scanPeerRows(rows pgx.Rows) ([]*Peer, error) {
	var peers []*Peer
	for rows.Next() {
		p, err := scanPeer(rows)
		if err != nil {
			return nil, err
		}
		peers = append(peers, p)
	}
	return peers, rows.Err()
}

// Pool returns the underlying pgxpool.Pool for advanced usage
// (e.g., migration tools, raw queries). Not part of the Database interface.
func (pg *PostgresDB) Pool() *pgxpool.Pool {
	return pg.pool
}

// ============================================================
// Access Policies (unattended access management)
// ============================================================

// GetAccessPolicy retrieves the access policy for a peer device.
func (pg *PostgresDB) GetAccessPolicy(peerID string) (*AccessPolicy, error) {
	row := pg.pool.QueryRow(pg.ctx,
		`SELECT peer_id, unattended_enabled, password_hash, COALESCE(password_enc, ''),
				COALESCE(passwordless_server_access, TRUE), schedule_enabled,
				schedule_days, schedule_start_time, schedule_end_time, schedule_timezone,
				allowed_operators, COALESCE(updated_at, NOW()), updated_by
		 FROM access_policies WHERE peer_id = $1`, peerID)

	var p AccessPolicy
	var updatedAt time.Time
	err := row.Scan(&p.PeerID, &p.UnattendedEnabled, &p.PasswordHash, &p.PasswordEnc,
		&p.PasswordlessServerAccess, &p.ScheduleEnabled,
		&p.ScheduleDays, &p.ScheduleStartTime, &p.ScheduleEndTime, &p.ScheduleTimezone,
		&p.AllowedOperators, &updatedAt, &p.UpdatedBy)
	if err != nil {
		return nil, err
	}
	p.UpdatedAt = updatedAt.Format(time.RFC3339)
	p.PasswordSet = p.PasswordHash != ""
	return &p, nil
}

// GetAccessPoliciesByPeerIDs returns access policies for the given peer IDs.
func (pg *PostgresDB) GetAccessPoliciesByPeerIDs(peerIDs []string) (map[string]*AccessPolicy, error) {
	out := make(map[string]*AccessPolicy)
	if len(peerIDs) == 0 {
		return out, nil
	}

	rows, err := pg.pool.Query(pg.ctx,
		`SELECT peer_id, unattended_enabled, password_hash, COALESCE(password_enc, ''),
				COALESCE(passwordless_server_access, TRUE), schedule_enabled,
				schedule_days, schedule_start_time, schedule_end_time, schedule_timezone,
				allowed_operators, COALESCE(updated_at, NOW()), updated_by
		 FROM access_policies WHERE peer_id = ANY($1)`, peerIDs)
	if err != nil {
		return nil, fmt.Errorf("db: GetAccessPoliciesByPeerIDs: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var p AccessPolicy
		var updatedAt time.Time
		if err := rows.Scan(&p.PeerID, &p.UnattendedEnabled, &p.PasswordHash, &p.PasswordEnc,
			&p.PasswordlessServerAccess, &p.ScheduleEnabled,
			&p.ScheduleDays, &p.ScheduleStartTime, &p.ScheduleEndTime, &p.ScheduleTimezone,
			&p.AllowedOperators, &updatedAt, &p.UpdatedBy); err != nil {
			return nil, fmt.Errorf("db: GetAccessPoliciesByPeerIDs scan: %w", err)
		}
		p.UpdatedAt = updatedAt.Format(time.RFC3339)
		p.PasswordSet = p.PasswordHash != ""
		out[p.PeerID] = &p
	}
	return out, rows.Err()
}

// SaveAccessPolicy creates or updates the access policy for a peer device.
func (pg *PostgresDB) SaveAccessPolicy(p *AccessPolicy) error {
	_, err := pg.pool.Exec(pg.ctx,
		`INSERT INTO access_policies (peer_id, unattended_enabled, password_hash, password_enc,
			passwordless_server_access,
			schedule_enabled, schedule_days, schedule_start_time, schedule_end_time,
			schedule_timezone, allowed_operators, updated_at, updated_by)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12)
		 ON CONFLICT(peer_id) DO UPDATE SET
			unattended_enabled = EXCLUDED.unattended_enabled,
			password_hash = CASE WHEN EXCLUDED.password_hash = '' THEN access_policies.password_hash WHEN EXCLUDED.password_hash = 'CLEAR' THEN '' ELSE EXCLUDED.password_hash END,
			password_enc = CASE WHEN EXCLUDED.password_hash = '' THEN access_policies.password_enc WHEN EXCLUDED.password_hash = 'CLEAR' THEN '' ELSE EXCLUDED.password_enc END,
			passwordless_server_access = EXCLUDED.passwordless_server_access,
			schedule_enabled = EXCLUDED.schedule_enabled,
			schedule_days = EXCLUDED.schedule_days,
			schedule_start_time = EXCLUDED.schedule_start_time,
			schedule_end_time = EXCLUDED.schedule_end_time,
			schedule_timezone = EXCLUDED.schedule_timezone,
			allowed_operators = EXCLUDED.allowed_operators,
			updated_at = NOW(),
			updated_by = EXCLUDED.updated_by`,
		p.PeerID, p.UnattendedEnabled, p.PasswordHash, p.PasswordEnc,
		p.PasswordlessServerAccess,
		p.ScheduleEnabled, p.ScheduleDays, p.ScheduleStartTime, p.ScheduleEndTime,
		p.ScheduleTimezone, p.AllowedOperators, p.UpdatedBy)
	return err
}

// DeleteAccessPolicy removes the access policy for a peer device.
func (pg *PostgresDB) DeleteAccessPolicy(peerID string) error {
	_, err := pg.pool.Exec(pg.ctx, `DELETE FROM access_policies WHERE peer_id = $1`, peerID)
	return err
}

// --- Role Permissions (RBAC Phase 52) ---

func (pg *PostgresDB) ListRolePermissions(role string) ([]*RolePermission, error) {
	rows, err := pg.pool.Query(pg.ctx,
		`SELECT id, role, permission, granted FROM role_permissions WHERE role = $1`, role)
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

func (pg *PostgresDB) SetRolePermission(role, permission string, granted bool) error {
	_, err := pg.pool.Exec(pg.ctx,
		`INSERT INTO role_permissions (role, permission, granted)
		 VALUES ($1, $2, $3) ON CONFLICT (role, permission) DO UPDATE SET granted = EXCLUDED.granted`,
		role, permission, granted)
	return err
}

func (pg *PostgresDB) DeleteRolePermission(role, permission string) error {
	_, err := pg.pool.Exec(pg.ctx,
		`DELETE FROM role_permissions WHERE role = $1 AND permission = $2`, role, permission)
	return err
}

func (pg *PostgresDB) HasRolePermission(role, permission string) (bool, error) {
	var granted bool
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT granted FROM role_permissions WHERE role = $1 AND permission = $2`,
		role, permission).Scan(&granted)
	if err == pgx.ErrNoRows {
		return false, fmt.Errorf("no override")
	}
	return granted, err
}

func (pg *PostgresDB) ListPeersForOrg(orgID string, includeDeleted bool) ([]*Peer, error) {
	query := `SELECT ` + peerColumns + ` FROM peers p
		INNER JOIN org_devices od ON p.id = od.device_id
		WHERE od.org_id = $1`
	if !includeDeleted {
		query += ` AND p.soft_deleted = FALSE`
	}
	query += ` ORDER BY p.last_online DESC NULLS LAST`

	rows, err := pg.pool.Query(pg.ctx, query, orgID)
	if err != nil {
		return nil, fmt.Errorf("db: ListPeersForOrg: %w", err)
	}
	defer rows.Close()

	var peers []*Peer
	for rows.Next() {
		p, err := scanPeer(rows)
		if err != nil {
			return nil, err
		}
		peers = append(peers, p)
	}
	return peers, rows.Err()
}

func (pg *PostgresDB) ListPeersForOrgPaginated(orgID string, includeDeleted bool, limit, offset int) ([]*Peer, int, error) {
	where := ` FROM peers p INNER JOIN org_devices od ON p.id = od.device_id WHERE od.org_id = $1`
	if !includeDeleted {
		where += ` AND p.soft_deleted = FALSE`
	}

	var total int
	if err := pg.pool.QueryRow(pg.ctx, `SELECT COUNT(*)`+where, orgID).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("db: ListPeersForOrgPaginated count: %w", err)
	}

	query := `SELECT ` + peerColumns + where + ` ORDER BY p.last_online DESC NULLS LAST`
	if limit > 0 {
		query += fmt.Sprintf(` LIMIT %d OFFSET %d`, limit, offset)
	}

	rows, err := pg.pool.Query(pg.ctx, query, orgID)
	if err != nil {
		return nil, 0, fmt.Errorf("db: ListPeersForOrgPaginated: %w", err)
	}
	defer rows.Close()

	peers, err := scanPeerRows(rows)
	if err != nil {
		return nil, 0, fmt.Errorf("db: ListPeersForOrgPaginated: %w", err)
	}
	return peers, total, nil
}
