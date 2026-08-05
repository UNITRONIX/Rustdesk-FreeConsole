/**
 * BetterDesk Console — Database Adapter
 *
 * Provides a unified async interface over SQLite (better-sqlite3) and
 * PostgreSQL (pg).  Every public method returns a Promise so that callers
 * don't need to know which backend is active.
 *
 * Selection:
 *   DB_TYPE=sqlite   (default, zero-config, single-user / small installs)
 *   DB_TYPE=postgres  (enterprise, multi-user, multiple operators)
 *
 * PostgreSQL connection string:
 *   DATABASE_URL=postgres://user:pass@host:5432/betterdesk
 *
 * The adapter exposes higher-level domain methods (peers, users, tokens, …)
 * instead of raw SQL, so the rest of the codebase stays database-agnostic.
 */

'use strict';

// ---------------------------------------------------------------------------
//  Imports
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const agentBundleService = require('./agentBundleService');
const { hashAccessToken } = require('../lib/tokenHash');
const { redactAuditDetails } = require('../lib/logRedact');

// Lazy-loaded drivers — keeps startup fast when one backend isn't installed.
let _sqlite = null;

/** Match Go signal peerIPMatches — client host vs stored peer IP (may include port). */
function peerIPMatches(clientHost, storedIP) {
    if (!clientHost || !storedIP) return false;
    let storedHost = storedIP;
    const idx = storedIP.lastIndexOf(':');
    if (idx > 0) {
        const hostPart = storedIP.slice(0, idx);
        if (/^\d+\.\d+\.\d+\.\d+$/.test(hostPart)) storedHost = hostPart;
    }
    return clientHost === storedHost || storedIP.startsWith(`${clientHost}:`);
}

function pkEqual(a, b) {
    if (!a || !b) return false;
    try {
        const toBuf = (v) => {
            if (Buffer.isBuffer(v)) return v;
            const s = String(v);
            return /^[0-9a-f]+$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s);
        };
        const bufA = toBuf(a);
        const bufB = toBuf(b);
        return bufA.length === bufB.length && bufA.equals(bufB);
    } catch (_) {
        return false;
    }
}

function uuidEqual(a, b) {
    if (!a || !b) return false;
    return String(a).replace(/-/g, '').toLowerCase() === String(b).replace(/-/g, '').toLowerCase();
}
let _pg = null;

function getSqliteDriver() {
    if (!_sqlite) _sqlite = require('better-sqlite3');
    return _sqlite;
}

function getPgDriver() {
    if (!_pg) _pg = require('pg');
    return _pg;
}

// ---------------------------------------------------------------------------
//  Configuration
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL || '';

// Auto-detect: if DATABASE_URL starts with postgres://, use postgres mode
// even if DB_TYPE is not explicitly set.
const DB_TYPE = (() => {
    const explicit = (process.env.DB_TYPE || '').toLowerCase();
    if (explicit === 'postgres' || explicit === 'postgresql') return 'postgres';
    if (explicit === 'sqlite') return 'sqlite';
    // Auto-detect from DATABASE_URL when DB_TYPE is not set
    if (!explicit && DATABASE_URL && /^postgres(ql)?:\/\//i.test(DATABASE_URL)) {
        console.log('[DB] Auto-detected PostgreSQL from DATABASE_URL');
        return 'postgres';
    }
    return 'sqlite';
})();

// ---------------------------------------------------------------------------
//  Security Helpers
// ---------------------------------------------------------------------------

/**
 * Escape special characters in LIKE patterns to prevent SQL injection.
 * PostgreSQL and SQLite both use backslash as escape character.
 * @param {string} str - User input to escape
 * @returns {string} - Escaped string safe for LIKE patterns
 */
function escapeLikePattern(str) {
    if (!str || typeof str !== 'string') return '';
    // Escape backslash first, then % and _
    return str.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

// ---------------------------------------------------------------------------
//  Interface contract — every adapter must implement these
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} DbAdapter
 * @property {function(): Promise<void>}  init
 * @property {function(): Promise<void>}  close
 *
 * -- Peers --
 * @property {function(Object): Promise<Object[]>}  getAllPeers
 * @property {function(string): Promise<Object|null>}  getPeerById
 * @property {function(Object): Promise<void>}  upsertPeer
 * @property {function(string, Object): Promise<void>}  updatePeer
 * @property {function(string): Promise<void>}  softDeletePeer
 * @property {function(string, boolean, string): Promise<void>}  setBanStatus
 * @property {function(): Promise<Object>}  getPeerStats
 * @property {function(): Promise<void>}  resetAllOnlineStatus
 * @property {function(string[]): Promise<void>}  markPeersOnline
 *
 * -- Users --
 * @property {function(string): Promise<Object|null>}  getUserByUsername
 * @property {function(number): Promise<Object|null>}  getUserById
 * @property {function(string, string, string): Promise<Object>}  createUser
 * @property {function(number, string): Promise<void>}  updateUserPassword
 * @property {function(number): Promise<void>}  touchLastLogin
 * @property {function(): Promise<boolean>}  hasUsers
 * @property {function(): Promise<Object[]>}  getAllUsers
 * @property {function(number, string): Promise<void>}  updateUserRole
 * @property {function(number): Promise<void>}  deleteUser
 * @property {function(): Promise<number>}  countAdmins
 *
 * -- TOTP --
 * @property {function(number, string): Promise<void>}  saveTotpSecret
 * @property {function(number, string): Promise<void>}  enableTotp
 * @property {function(number): Promise<void>}  disableTotp
 * @property {function(number, string): Promise<void>}  useRecoveryCode
 *
 * -- Token --
 * @property {function(Object): Promise<void>}  createAccessToken
 * @property {function(string): Promise<Object|null>}  getAccessToken
 * @property {function(string): Promise<void>}  touchAccessToken
 * @property {function(string): Promise<void>}  revokeAccessToken
 * @property {function(number, string): Promise<void>}  revokeUserClientTokens
 * @property {function(number): Promise<void>}  revokeAllUserTokens
 * @property {function(): Promise<void>}  cleanupExpiredTokens
 *
 * -- Login tracking --
 * @property {function(string, string, boolean): Promise<void>}  recordLoginAttempt
 * @property {function(string, number): Promise<number>}  countRecentFailedAttempts
 * @property {function(string, number): Promise<number>}  countRecentFailedAttemptsFromIp
 * @property {function(string, string, number): Promise<void>}  lockAccount
 * @property {function(string): Promise<Object|null>}  getAccountLockout
 * @property {function(string): Promise<void>}  clearAccountLockout
 *
 * -- Folders --
 * @property {function(): Promise<Object[]>}  getAllFolders
 * @property {function(number): Promise<Object|null>}  getFolderById
 * @property {function(Object): Promise<Object>}  createFolder
 * @property {function(number, Object): Promise<void>}  updateFolder
 * @property {function(number): Promise<void>}  deleteFolder
 * @property {function(string, number|null): Promise<void>}  assignDeviceToFolder
 *
 * -- Address books --
 * @property {function(number, string): Promise<Object|null>}  getAddressBook
 * @property {function(number, string, string): Promise<void>}  saveAddressBook
 *
 * -- Audit --
 * @property {function(number|null, string, string, string): Promise<void>}  logAction
 * @property {function(number, number): Promise<Object[]>}  getAuditLogs
 *
 * -- Settings --
 * @property {function(string): Promise<string|null>}  getSetting
 * @property {function(string, string): Promise<void>}  setSetting
 * @property {function(): Promise<Object>}  getAllSettings
 *
 * -- Sessions (enterprise) --
 * @property {function(Object): Promise<void>}  createSession
 * @property {function(string): Promise<Object|null>}  getSession
 * @property {function(string): Promise<void>}  deleteSession
 * @property {function(): Promise<void>}  cleanupExpiredSessions
 */

// =========================================================================
//  SQLite adapter
// =========================================================================

function createSqliteAdapter(config) {
    const Database = getSqliteDriver();
    let mainDb = null;
    let authDb = null;
    let authUsesMain = false;

    /** open helper */
    function openMain() {
        if (mainDb) return mainDb;
        mainDb = new Database(config.dbPath, { readonly: false, fileMustExist: false });
        mainDb.pragma('busy_timeout = 5000');
        mainDb.pragma('journal_mode = WAL');
        mainDb.pragma('foreign_keys = ON');
        return mainDb;
    }

    /**
     * New installs use db_v2.sqlite3 as the only SQLite store. Existing
     * installations continue to use auth.db until the Go migration writes its
     * completion marker; this prevents an accidental empty-store cutover.
     */
    function authStorageIsConsolidated() {
        if ((process.env.SQLITE_AUTH_DB_MODE || '').toLowerCase() === 'legacy') return false;
        if ((process.env.SQLITE_AUTH_DB_MODE || '').toLowerCase() === 'consolidated') return true;
        const legacyPath = config.authDbPath || path.join(config.dataDir, 'auth.db');
        if (!fs.existsSync(legacyPath)) return true;
        try {
            const db = openMain();
            const markerTable = db.prepare(`
                SELECT 1 FROM sqlite_master
                WHERE type = 'table' AND name = 'betterdesk_migrations'
            `).get();
            if (!markerTable) return false;
            return !!db.prepare(`
                SELECT 1 FROM betterdesk_migrations
                WHERE name = 'sqlite_auth_consolidation_v1' AND status = 'complete'
            `).get();
        } catch (_) {
            // Fail safely: preserve the existing legacy store when its
            // consolidation state cannot be determined.
            return false;
        }
    }

    function openAuth() {
        if (authDb) return authDb;
        if (authStorageIsConsolidated()) {
            authDb = openMain();
            authUsesMain = true;
            return authDb;
        }
        const authDbPath = config.authDbPath || path.join(config.dataDir, 'auth.db');
        // Existing legacy paths must already exist. Never recreate a missing
        // auth.db, otherwise a failed/misconfigured migration could silently
        // create a second identity store.
        if (!fs.existsSync(authDbPath)) {
            throw new Error(`Legacy auth database is missing: ${authDbPath}`);
        }
        authDb = new Database(authDbPath, { readonly: false, fileMustExist: true });
        authDb.pragma('busy_timeout = 5000');
        authDb.pragma('journal_mode = WAL');
        authDb.pragma('foreign_keys = ON');
        return authDb;
    }

    function usesUsernameAddressBooks(db = openAuth()) {
        try {
            return db.prepare('PRAGMA table_info(address_books)').all()
                .some((column) => column.name === 'username');
        } catch (_) {
            return false;
        }
    }

    function usernameForUserId(db, userId) {
        const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
        return user ? user.username : null;
    }

    // ---- Schema bootstrap ----

    function ensurePeerTable(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS peer (
                id TEXT PRIMARY KEY,
                uuid TEXT DEFAULT '',
                pk BLOB,
                note TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now')),
                status_online INTEGER DEFAULT 0,
                last_online TEXT,
                is_deleted INTEGER DEFAULT 0,
                info TEXT DEFAULT '',
                ip TEXT DEFAULT '',
                "user" TEXT DEFAULT '',
                is_banned INTEGER DEFAULT 0,
                banned_at TEXT,
                banned_reason TEXT DEFAULT '',
                folder_id INTEGER DEFAULT NULL
            )
        `);
        const cols = [
            { name: 'status_online', sql: 'INTEGER DEFAULT 0' },
            { name: 'last_online', sql: 'TEXT' },
            { name: 'is_deleted', sql: 'INTEGER DEFAULT 0' },
            { name: 'user', sql: 'TEXT DEFAULT \'\'' },
            { name: 'is_banned', sql: 'INTEGER DEFAULT 0' },
            { name: 'banned_at', sql: 'TEXT' },
            { name: 'banned_reason', sql: 'TEXT DEFAULT \'\'' },
            { name: 'folder_id', sql: 'INTEGER DEFAULT NULL' },
            { name: 'tags', sql: "TEXT DEFAULT ''" },
        ];
        const existing = new Set(db.prepare('PRAGMA table_info(peer)').all().map(c => c.name));
        for (const c of cols) {
            if (!existing.has(c.name)) {
                try { db.exec(`ALTER TABLE peer ADD COLUMN ${c.name} ${c.sql}`); } catch (_) {}
            }
        }
    }

    function ensureAccessTokenHashColumnSqlite(db) {
        const cols = new Set(db.prepare('PRAGMA table_info(access_tokens)').all().map((c) => c.name));
        if (!cols.has('token_hash')) {
            db.exec('ALTER TABLE access_tokens ADD COLUMN token_hash TEXT');
            console.log('[DB] Migration: added access_tokens.token_hash');
        }
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_access_tokens_hash ON access_tokens (token_hash)
            WHERE token_hash IS NOT NULL`);
        const rows = db.prepare(`
            SELECT id, token FROM access_tokens
            WHERE (token_hash IS NULL OR token_hash = '') AND token != ''
        `).all();
        if (rows.length > 0) {
            const upd = db.prepare('UPDATE access_tokens SET token_hash = ? WHERE id = ?');
            for (const row of rows) {
                upd.run(hashAccessToken(row.token), row.id);
            }
        }
    }

    function ensureAuthTables(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT DEFAULT 'admin',
                auth_provider TEXT DEFAULT 'local',
                created_at TEXT DEFAULT (datetime('now')),
                last_login TEXT,
                preferred_language TEXT DEFAULT NULL,
                totp_secret TEXT DEFAULT NULL,
                totp_enabled INTEGER DEFAULT 0,
                totp_recovery_codes TEXT DEFAULT NULL
            );
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                action TEXT NOT NULL,
                details TEXT,
                ip_address TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at);
            CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action, created_at);
            CREATE TABLE IF NOT EXISTS access_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token TEXT UNIQUE NOT NULL,
                token_hash TEXT,
                user_id INTEGER NOT NULL,
                client_id TEXT DEFAULT '',
                client_uuid TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now')),
                expires_at TEXT NOT NULL,
                last_used TEXT,
                ip_address TEXT DEFAULT '',
                revoked INTEGER DEFAULT 0,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS login_attempts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                ip_address TEXT DEFAULT '',
                success INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS account_lockouts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                locked_until TEXT NOT NULL,
                attempt_count INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS folders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                color TEXT DEFAULT '#6366f1',
                icon TEXT DEFAULT 'folder',
                sort_order INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS address_books (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                ab_type TEXT DEFAULT 'legacy',
                data TEXT DEFAULT '{}',
                updated_at TEXT DEFAULT (datetime('now')),
                UNIQUE(user_id, ab_type),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS branding_config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS branding_profiles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                description TEXT DEFAULT '',
                data TEXT NOT NULL,
                is_active INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS relay_sessions (
                id TEXT PRIMARY KEY,
                initiator_id TEXT NOT NULL,
                target_id TEXT NOT NULL,
                initiator_pk TEXT,
                target_pk TEXT,
                status TEXT DEFAULT 'pending',
                created_at TEXT DEFAULT (datetime('now')),
                expires_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS device_folder_assignments (
                device_id TEXT PRIMARY KEY NOT NULL,
                folder_id INTEGER NOT NULL,
                assigned_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS peer_sysinfo (
                peer_id TEXT PRIMARY KEY,
                hostname TEXT DEFAULT '',
                username TEXT DEFAULT '',
                platform TEXT DEFAULT '',
                version TEXT DEFAULT '',
                cpu_name TEXT DEFAULT '',
                cpu_cores INTEGER DEFAULT 0,
                cpu_freq_ghz REAL DEFAULT 0,
                memory_gb REAL DEFAULT 0,
                os_full TEXT DEFAULT '',
                displays TEXT DEFAULT '[]',
                encoding TEXT DEFAULT '[]',
                features TEXT DEFAULT '{}',
                platform_additions TEXT DEFAULT '{}',
                raw_json TEXT DEFAULT '{}',
                updated_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS peer_metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                peer_id TEXT NOT NULL,
                cpu_usage REAL DEFAULT 0,
                memory_usage REAL DEFAULT 0,
                disk_usage REAL DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_peer_metrics_peer_time ON peer_metrics (peer_id, created_at);
            CREATE TABLE IF NOT EXISTS audit_connections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                host_id TEXT NOT NULL,
                host_uuid TEXT DEFAULT '',
                peer_id TEXT DEFAULT '',
                peer_name TEXT DEFAULT '',
                action TEXT NOT NULL,
                conn_type INTEGER DEFAULT 0,
                session_id TEXT DEFAULT '',
                ip TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_audit_conn_host ON audit_connections (host_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_audit_conn_peer ON audit_connections (peer_id, created_at);
            CREATE TABLE IF NOT EXISTS audit_files (
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
            );
            CREATE INDEX IF NOT EXISTS idx_audit_files_host ON audit_files (host_id, created_at);
            CREATE TABLE IF NOT EXISTS audit_alarms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                alarm_type INTEGER NOT NULL,
                alarm_name TEXT DEFAULT '',
                host_id TEXT DEFAULT '',
                peer_id TEXT DEFAULT '',
                ip TEXT DEFAULT '',
                details TEXT DEFAULT '{}',
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_audit_alarms_type ON audit_alarms (alarm_type, created_at);
            CREATE TABLE IF NOT EXISTS user_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guid TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                note TEXT DEFAULT '',
                team_id TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS user_group_members (
                user_group_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                created_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (user_group_id, user_id),
                FOREIGN KEY (user_group_id) REFERENCES user_groups(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS device_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guid TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                note TEXT DEFAULT '',
                team_id TEXT DEFAULT '',
                source_type TEXT DEFAULT 'manual',
                tag_filter TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS device_group_members (
                device_group_id INTEGER NOT NULL,
                peer_id TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (device_group_id, peer_id),
                FOREIGN KEY (device_group_id) REFERENCES device_groups(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS device_group_user_access (
                device_group_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                created_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (device_group_id, user_id),
                FOREIGN KEY (device_group_id) REFERENCES device_groups(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS device_group_user_group_access (
                device_group_id INTEGER NOT NULL,
                user_group_id INTEGER NOT NULL,
                created_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (device_group_id, user_group_id),
                FOREIGN KEY (device_group_id) REFERENCES device_groups(id) ON DELETE CASCADE,
                FOREIGN KEY (user_group_id) REFERENCES user_groups(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS strategies (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guid TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                user_group_guid TEXT DEFAULT '',
                device_group_guid TEXT DEFAULT '',
                enabled INTEGER DEFAULT 1,
                permissions TEXT DEFAULT '{}',
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS strategy_assignments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                target_type TEXT NOT NULL,
                target_key TEXT NOT NULL,
                strategy_guid TEXT NOT NULL DEFAULT '',
                updated_at TEXT DEFAULT (datetime('now')),
                UNIQUE(target_type, target_key)
            );
            CREATE INDEX IF NOT EXISTS idx_strategy_assignments_strategy ON strategy_assignments (strategy_guid);
            CREATE TABLE IF NOT EXISTS user_peer_grants (
                user_id INTEGER NOT NULL,
                peer_id TEXT NOT NULL,
                granted_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (user_id, peer_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_user_peer_grants_user ON user_peer_grants (user_id);
            CREATE TABLE IF NOT EXISTS notification_reads (
                user_id INTEGER NOT NULL,
                notification_id TEXT NOT NULL,
                read_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (user_id, notification_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_notification_reads_user ON notification_reads (user_id, read_at);
            CREATE TABLE IF NOT EXISTS email_notification_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL,
                event_id TEXT NOT NULL,
                recipient TEXT NOT NULL,
                sent_at TEXT DEFAULT (datetime('now')),
                UNIQUE(event_type, event_id, recipient)
            );
            CREATE INDEX IF NOT EXISTS idx_email_notification_log_event ON email_notification_log (event_type, event_id);
        `);

        // Migration: Add missing columns to existing users table (for upgrades from older versions)
        const userColsMigration = [
            { name: 'last_login', sql: 'TEXT' },
            { name: 'auth_provider', sql: "TEXT DEFAULT 'local'" },
            { name: 'preferred_language', sql: 'TEXT DEFAULT NULL' },
            { name: 'totp_secret', sql: 'TEXT DEFAULT NULL' },
            { name: 'totp_enabled', sql: 'INTEGER DEFAULT 0' },
            { name: 'totp_recovery_codes', sql: 'TEXT DEFAULT NULL' },
            // Phase 4: operator identity profile (shown to end-user on consent popup)
            { name: 'first_name', sql: "TEXT DEFAULT ''" },
            { name: 'last_name',  sql: "TEXT DEFAULT ''" },
            { name: 'email',      sql: "TEXT DEFAULT ''" },
            { name: 'phone',      sql: "TEXT DEFAULT ''" },
            { name: 'role_display', sql: "TEXT DEFAULT ''" },
            { name: 'avatar_url', sql: "TEXT DEFAULT ''" },
            { name: 'guid', sql: "TEXT DEFAULT ''" },
        ];
        try {
            const existingUserCols = new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name));
            if (existingUserCols.size > 0) {
                for (const c of userColsMigration) {
                    if (!existingUserCols.has(c.name)) {
                        try { db.exec(`ALTER TABLE users ADD COLUMN ${c.name} ${c.sql}`); console.log(`[DB] Migration: added users.${c.name}`); } catch (_) {}
                    }
                }
            }
        } catch (e) { console.warn('[DB] Migration users columns error:', e.message); }

        // Migration: Add updated_at to settings table if missing (for upgrades from older versions)
        try {
            const settingsCols = new Set(db.prepare('PRAGMA table_info(settings)').all().map(c => c.name));
            if (settingsCols.size > 0 && !settingsCols.has('updated_at')) {
                db.exec("ALTER TABLE settings ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))");
                console.log('[DB] Migration: added settings.updated_at');
            }
        } catch (e) { console.warn('[DB] Migration settings columns error:', e.message); }

        // Migration: Add updated_at to branding_config table if missing
        try {
            const brandingCols = new Set(db.prepare('PRAGMA table_info(branding_config)').all().map(c => c.name));
            if (brandingCols.size > 0 && !brandingCols.has('updated_at')) {
                db.exec("ALTER TABLE branding_config ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))");
                console.log('[DB] Migration: added branding_config.updated_at');
            }
        } catch (e) { console.warn('[DB] Migration branding_config columns error:', e.message); }

        try {
            db.exec(`
                CREATE TABLE IF NOT EXISTS branding_profiles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    description TEXT DEFAULT '',
                    data TEXT NOT NULL,
                    is_active INTEGER DEFAULT 0,
                    created_at TEXT DEFAULT (datetime('now')),
                    updated_at TEXT DEFAULT (datetime('now'))
                )
            `);
        } catch (e) { console.warn('[DB] Migration branding_profiles error:', e.message); }

        try {
            const groupCols = new Set(db.prepare('PRAGMA table_info(device_groups)').all().map(c => c.name));
            if (groupCols.size > 0 && !groupCols.has('source_type')) {
                db.exec("ALTER TABLE device_groups ADD COLUMN source_type TEXT DEFAULT 'manual'");
            }
            if (groupCols.size > 0 && !groupCols.has('tag_filter')) {
                db.exec("ALTER TABLE device_groups ADD COLUMN tag_filter TEXT DEFAULT ''");
            }
        } catch (e) { console.warn('[DB] Migration device_groups columns error:', e.message); }

        // Seed default groups if empty
        const ugCount = db.prepare('SELECT COUNT(*) as c FROM user_groups').get().c;
        if (ugCount === 0) {
            const crypto = require('crypto');
            db.prepare('INSERT INTO user_groups (guid, name, note) VALUES (?, ?, ?)').run(
                crypto.randomUUID(), 'Default', 'Default user group'
            );
        }
        const dgCount = db.prepare('SELECT COUNT(*) as c FROM device_groups').get().c;
        if (dgCount === 0) {
            const crypto = require('crypto');
            db.prepare('INSERT INTO device_groups (guid, name, note) VALUES (?, ?, ?)').run(
                crypto.randomUUID(), 'Default', 'Default device group'
            );
        }

        ensureAccessTokenHashColumnSqlite(db);
    }

    function ensureInventoryTables(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS device_inventory (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                hardware TEXT DEFAULT '{}',
                software TEXT DEFAULT '{}',
                collected_at TEXT,
                received_at TEXT DEFAULT (datetime('now')),
                UNIQUE(device_id)
            );
            CREATE TABLE IF NOT EXISTS device_telemetry (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                cpu_usage_percent REAL DEFAULT 0,
                memory_used_bytes INTEGER DEFAULT 0,
                memory_total_bytes INTEGER DEFAULT 0,
                uptime_secs INTEGER DEFAULT 0,
                timestamp TEXT,
                received_at TEXT DEFAULT (datetime('now')),
                UNIQUE(device_id)
            );
        `);
    }

    function ensureActivityTables(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS activity_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                app_name TEXT NOT NULL DEFAULT '',
                window_title TEXT NOT NULL DEFAULT '',
                category TEXT DEFAULT 'other',
                started_at TEXT NOT NULL,
                ended_at TEXT NOT NULL,
                duration_secs INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS activity_summaries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                idle_seconds INTEGER DEFAULT 0,
                session_count INTEGER DEFAULT 0,
                total_active_secs INTEGER DEFAULT 0,
                reported_at TEXT NOT NULL,
                received_at TEXT DEFAULT (datetime('now')),
                UNIQUE(device_id, reported_at)
            );
            CREATE INDEX IF NOT EXISTS idx_activity_device ON activity_sessions (device_id);
            CREATE INDEX IF NOT EXISTS idx_activity_time ON activity_sessions (started_at);
        `);
    }

    function ensureTicketTables(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS tickets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                status TEXT DEFAULT 'open',
                priority TEXT DEFAULT 'medium',
                category TEXT DEFAULT 'general',
                device_id TEXT DEFAULT NULL,
                created_by TEXT NOT NULL,
                assigned_to TEXT DEFAULT NULL,
                sla_due_at TEXT DEFAULT NULL,
                resolved_at TEXT DEFAULT NULL,
                closed_at TEXT DEFAULT NULL,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS ticket_comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticket_id INTEGER NOT NULL,
                author TEXT NOT NULL,
                body TEXT NOT NULL,
                is_internal INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS ticket_attachments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticket_id INTEGER NOT NULL,
                filename TEXT NOT NULL,
                mimetype TEXT DEFAULT 'application/octet-stream',
                size_bytes INTEGER DEFAULT 0,
                storage_path TEXT NOT NULL,
                uploaded_by TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
            );
        `);
    }

    function ensureAlertTables(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS alert_rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                enabled INTEGER DEFAULT 1,
                condition_type TEXT NOT NULL,
                condition_op TEXT NOT NULL DEFAULT 'gt',
                condition_value REAL NOT NULL DEFAULT 0,
                severity TEXT DEFAULT 'warning',
                scope_device_id TEXT DEFAULT NULL,
                cooldown_secs INTEGER DEFAULT 300,
                notify_emails TEXT DEFAULT '',
                created_by TEXT DEFAULT NULL,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS alert_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                rule_id INTEGER NOT NULL,
                device_id TEXT DEFAULT NULL,
                severity TEXT DEFAULT 'warning',
                message TEXT NOT NULL DEFAULT '',
                triggered_at TEXT NOT NULL,
                acknowledged INTEGER DEFAULT 0,
                acknowledged_by TEXT DEFAULT NULL,
                acknowledged_at TEXT DEFAULT NULL,
                created_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS remote_commands (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                command_type TEXT NOT NULL DEFAULT 'shell',
                payload TEXT NOT NULL DEFAULT '',
                status TEXT DEFAULT 'pending',
                result TEXT DEFAULT NULL,
                created_by TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now')),
                executed_at TEXT DEFAULT NULL,
                completed_at TEXT DEFAULT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_alert_history_rule ON alert_history (rule_id);
            CREATE INDEX IF NOT EXISTS idx_alert_history_device ON alert_history (device_id);
            CREATE INDEX IF NOT EXISTS idx_remote_commands_device ON remote_commands (device_id, status);
        `);
    }

    // ---- Parse helpers ----

    function ensureNetworkTables(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS network_targets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                host TEXT DEFAULT '',
                port INTEGER DEFAULT NULL,
                url TEXT DEFAULT NULL,
                check_type TEXT NOT NULL DEFAULT 'ping',
                timeout_ms INTEGER DEFAULT 5000,
                interval_ms INTEGER DEFAULT 60000,
                enabled INTEGER DEFAULT 1,
                last_status TEXT DEFAULT NULL,
                last_check_at TEXT DEFAULT NULL,
                last_rtt_ms REAL DEFAULT NULL,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS network_checks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                target_id INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'unknown',
                rtt_ms REAL DEFAULT NULL,
                status_code INTEGER DEFAULT NULL,
                error_msg TEXT DEFAULT NULL,
                checked_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (target_id) REFERENCES network_targets(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_network_checks_target ON network_checks (target_id);
            CREATE INDEX IF NOT EXISTS idx_network_checks_time ON network_checks (checked_at);
        `);
    }

    // -- DataGuard / DLP tables -------------------------------------------
    function ensureDataGuardTables(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS dlp_policies (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                policy_type TEXT DEFAULT '',
                action TEXT DEFAULT 'log',
                scope TEXT DEFAULT '',
                enabled INTEGER DEFAULT 1,
                rules TEXT DEFAULT '[]',
                created_at DATETIME DEFAULT (datetime('now')),
                updated_at DATETIME DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS dlp_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                event_source TEXT NOT NULL DEFAULT 'unknown',
                event_type TEXT NOT NULL DEFAULT 'info',
                policy_id INTEGER DEFAULT NULL,
                policy_name TEXT DEFAULT '',
                action TEXT DEFAULT 'log',
                details TEXT DEFAULT '{}',
                created_at DATETIME DEFAULT (datetime('now')),
                FOREIGN KEY (policy_id) REFERENCES dlp_policies(id) ON DELETE SET NULL
            );
            CREATE INDEX IF NOT EXISTS idx_dlp_events_device ON dlp_events (device_id);
            CREATE INDEX IF NOT EXISTS idx_dlp_events_time ON dlp_events (created_at);
            CREATE INDEX IF NOT EXISTS idx_dlp_events_source ON dlp_events (event_source);
        `);
        // Migrate existing tables: add new columns if missing
        try {
            const cols = db.prepare("PRAGMA table_info(dlp_policies)").all().map(c => c.name);
            if (!cols.includes('policy_type')) db.exec("ALTER TABLE dlp_policies ADD COLUMN policy_type TEXT DEFAULT ''");
            if (!cols.includes('action')) db.exec("ALTER TABLE dlp_policies ADD COLUMN action TEXT DEFAULT 'log'");
            if (!cols.includes('scope')) db.exec("ALTER TABLE dlp_policies ADD COLUMN scope TEXT DEFAULT ''");
        } catch (_) { /* table may not exist yet */ }
    }

    // -- Saved reports table -----------------------------------------------
    function ensureReportTables(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS saved_reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                report_type TEXT NOT NULL,
                filters TEXT DEFAULT '{}',
                payload TEXT DEFAULT '{}',
                created_by TEXT NOT NULL DEFAULT 'admin',
                created_at DATETIME DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_saved_reports_type ON saved_reports (report_type);
        `);
    }

    // -- LAN Discovery / Pending Registrations ----------------------------
    function ensureRegistrationTables(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS pending_registrations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                hostname TEXT DEFAULT '',
                platform TEXT DEFAULT '',
                version TEXT DEFAULT '',
                ip_address TEXT DEFAULT '',
                public_key TEXT DEFAULT '',
                uuid TEXT DEFAULT '',
                status TEXT DEFAULT 'pending',
                approved_by TEXT DEFAULT NULL,
                approved_at TEXT DEFAULT NULL,
                rejected_reason TEXT DEFAULT '',
                access_token TEXT DEFAULT NULL,
                console_url TEXT DEFAULT NULL,
                server_address TEXT DEFAULT NULL,
                server_key TEXT DEFAULT NULL,
                created_at DATETIME DEFAULT (datetime('now')),
                updated_at DATETIME DEFAULT (datetime('now')),
                UNIQUE(device_id)
            );
            CREATE INDEX IF NOT EXISTS idx_pending_reg_status ON pending_registrations (status);
            CREATE INDEX IF NOT EXISTS idx_pending_reg_device ON pending_registrations (device_id);
        `);
    }

    // -- Agent installer bundles (Generator Agenta) ------------------------
    function migrateAgentBundleSlugsSqlite(db) {
        try {
            const cols = new Set(db.prepare('PRAGMA table_info(agent_bundles)').all().map(c => c.name));
            if (!cols.has('slug')) {
                db.exec('ALTER TABLE agent_bundles ADD COLUMN slug TEXT DEFAULT NULL');
                console.log('[DB] Migration: added agent_bundles.slug');
            }
            db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_bundles_slug ON agent_bundles (slug) WHERE slug IS NOT NULL AND slug != ''");

            const taken = new Set(
                db.prepare("SELECT slug FROM agent_bundles WHERE slug IS NOT NULL AND slug != ''").all().map(r => r.slug)
            );
            const missing = db.prepare("SELECT id, bundle_id, name FROM agent_bundles WHERE slug IS NULL OR slug = ''").all();
            const update = db.prepare('UPDATE agent_bundles SET slug = ? WHERE id = ?');
            for (const row of missing) {
                const slug = agentBundleService.allocateUniqueSlug({
                    preferred: null,
                    name: row.name,
                    fallbackId: row.bundle_id,
                    isTaken: (s) => taken.has(s),
                });
                update.run(slug, row.id);
                taken.add(slug);
            }
        } catch (e) {
            console.warn('[DB] Migration agent_bundles.slug error:', e.message);
        }
    }

    function ensureAgentBundleTables(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS agent_bundles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                bundle_id TEXT NOT NULL UNIQUE,
                slug TEXT DEFAULT NULL,
                name TEXT NOT NULL,
                branding TEXT NOT NULL DEFAULT '{}',
                branding_hash TEXT NOT NULL DEFAULT '',
                created_by INTEGER DEFAULT NULL,
                revoked INTEGER NOT NULL DEFAULT 0,
                download_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_agent_bundles_bundle_id ON agent_bundles (bundle_id);
            CREATE INDEX IF NOT EXISTS idx_agent_bundles_hash ON agent_bundles (branding_hash);

            CREATE TABLE IF NOT EXISTS agent_bundle_builds (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                branding_hash TEXT NOT NULL,
                platform TEXT NOT NULL,
                arch TEXT NOT NULL DEFAULT 'x64',
                format TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                artifact_path TEXT DEFAULT NULL,
                artifact_size INTEGER DEFAULT 0,
                artifact_sha256 TEXT DEFAULT NULL,
                error_message TEXT DEFAULT '',
                started_at TEXT DEFAULT NULL,
                finished_at TEXT DEFAULT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                UNIQUE(branding_hash, platform, arch, format)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_bundle_builds_hash ON agent_bundle_builds (branding_hash);
            CREATE INDEX IF NOT EXISTS idx_agent_bundle_builds_status ON agent_bundle_builds (status);
        `);
        migrateAgentBundleSlugsSqlite(db);
        try {
            const cols = new Set(db.prepare('PRAGMA table_info(agent_bundles)').all().map(c => c.name));
            if (!cols.has('product_type')) {
                db.exec("ALTER TABLE agent_bundles ADD COLUMN product_type TEXT NOT NULL DEFAULT 'agent'");
                console.log('[DB] Migration: added agent_bundles.product_type');
            }
        } catch (e) {
            console.warn('[DB] Migration agent_bundles.product_type error:', e.message);
        }
    }

    // -- Multi-tenancy tables ----------------------------------------------
    function ensureTenantTables(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS tenants (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                slug TEXT NOT NULL UNIQUE,
                contact_name TEXT DEFAULT '',
                contact_email TEXT DEFAULT '',
                max_devices INTEGER DEFAULT 0,
                notes TEXT DEFAULT '',
                active INTEGER DEFAULT 1,
                created_at DATETIME DEFAULT (datetime('now')),
                updated_at DATETIME DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS tenant_devices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tenant_id INTEGER NOT NULL,
                device_id TEXT NOT NULL,
                assigned_at DATETIME DEFAULT (datetime('now')),
                UNIQUE(tenant_id, device_id),
                FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS tenant_users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tenant_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                assigned_at DATETIME DEFAULT (datetime('now')),
                UNIQUE(tenant_id, user_id),
                FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_tenant_devices_tenant ON tenant_devices (tenant_id);
            CREATE INDEX IF NOT EXISTS idx_tenant_devices_device ON tenant_devices (device_id);
            CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant ON tenant_users (tenant_id);
        `);
    }

    function parsePeer(row) {
        if (!row) return null;
        let info = {};
        if (row.info) { try { info = JSON.parse(row.info); } catch (_) {} }
        return {
            id: row.id,
            uuid: row.uuid || '',
            pk: row.pk || null,
            hostname: row.note || info.hostname || '',
            username: typeof row.user === 'string' ? row.user : '',
            platform: info.os || info.platform || '',
            ip: info.ip || row.ip || '',
            note: row.note || '',
            online: row.status_online === 1,
            banned: row.is_banned === 1,
            created_at: row.created_at,
            last_online: row.last_online,
            ban_reason: row.banned_reason || '',
            folder_id: row.folder_id || null,
            info: row.info || '',
            tags: row.tags ? row.tags.split(',').filter(Boolean) : [],
        };
    }

    function safeJsonParse(str, fallback) {
        try { return JSON.parse(str); } catch { return fallback; }
    }

    function parseSysinfoRow(row) {
        return {
            peer_id: row.peer_id,
            hostname: row.hostname,
            username: row.username,
            platform: row.platform,
            version: row.version,
            cpu_name: row.cpu_name,
            cpu_cores: row.cpu_cores,
            cpu_freq_ghz: row.cpu_freq_ghz,
            memory_gb: row.memory_gb,
            os_full: row.os_full,
            displays: safeJsonParse(row.displays, []),
            encoding: safeJsonParse(row.encoding, []),
            features: safeJsonParse(row.features, {}),
            platform_additions: safeJsonParse(row.platform_additions, {}),
            updated_at: row.updated_at,
        };
    }

    // ========= Go ↔ Node.js peer sync (SQLite) =========

    let _lastGoPeerSyncSqlite = 0;
    const GO_SYNC_INTERVAL_SQLITE_MS = 30_000;

    function cascadePeerIdChangeSqlite(oldId, newId) {
        if (!oldId || !newId || oldId === newId) return;
        try {
            openMain().prepare('UPDATE peer SET id = ? WHERE id = ?').run(newId, oldId);
        } catch (err) {
            console.warn('[DB] cascadePeerIdChange peer table:', err.message);
        }
        try {
            const authDb = openAuth();
            const stmts = [
                ['UPDATE peer_sysinfo SET peer_id = ? WHERE peer_id = ?', [newId, oldId]],
                ['UPDATE peer_metrics SET peer_id = ? WHERE peer_id = ?', [newId, oldId]],
                ['UPDATE device_folder_assignments SET device_id = ? WHERE device_id = ?', [newId, oldId]],
                ['UPDATE device_folder_assignments SET peer_id = ? WHERE peer_id = ?', [newId, oldId]],
                ['UPDATE device_group_peers SET peer_id = ? WHERE peer_id = ?', [newId, oldId]],
                ['UPDATE access_tokens SET client_id = ? WHERE client_id = ?', [newId, oldId]],
                ['UPDATE audit_connections SET peer_id = ? WHERE peer_id = ?', [newId, oldId]],
                ['UPDATE audit_files SET peer_id = ? WHERE peer_id = ?', [newId, oldId]],
                ['UPDATE audit_alarms SET peer_id = ? WHERE peer_id = ?', [newId, oldId]],
            ];
            for (const [sql, params] of stmts) {
                try {
                    authDb.prepare(sql).run(...params);
                } catch (err) {
                    if (!err.message.includes('no such table') && !err.message.includes('no such column')) {
                        console.warn('[DB] cascadePeerIdChange:', err.message);
                    }
                }
            }
        } catch (err) {
            console.warn('[DB] cascadePeerIdChange auth:', err.message);
        }
    }

    function syncPanelPeerIdRenamesFromGoSqlite() {
        const db = openMain();
        try {
            const histTbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='id_change_history'").get();
            const peersTbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='peers'").get();
            if (!histTbl || !peersTbl) return;
            const rows = db.prepare(`
                SELECT h.old_id, h.new_id FROM id_change_history h
                INNER JOIN peers p ON p.id = h.new_id AND (p.soft_deleted IS NULL OR p.soft_deleted = 0)
                WHERE EXISTS (SELECT 1 FROM peer WHERE id = h.old_id)
            `).all();
            for (const row of rows) {
                cascadePeerIdChangeSqlite(row.old_id, row.new_id);
            }
        } catch (err) {
            if (!err.message.includes('no such table')) {
                console.warn('[DB] syncPanelPeerIdRenamesFromGo:', err.message);
            }
        }
    }

    function purgePanelPeerRecordSqlite(id) {
        if (!id) return;
        try {
            openMain().prepare('DELETE FROM peer WHERE id = ?').run(id);
        } catch (err) {
            console.warn('[DB] purgePanelPeerRecord:', err.message);
        }
    }

    /**
     * Identity-aware rename guard — mirrors Go signal rejectRenamedPeerRegistration (#213).
     * @returns {{ reject: boolean, new_id?: string }}
     */
    function shouldRejectRenamedPeerRegistrationSqlite(oldId, { uuid, pk, ip } = {}) {
        const newId = (() => {
            try {
                const db = openMain();
                const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='id_change_history'").get();
                if (!tbl) return null;
                const row = db.prepare('SELECT new_id FROM id_change_history WHERE old_id = ? ORDER BY rowid DESC LIMIT 1').get(oldId);
                return row ? row.new_id : null;
            } catch (_) {
                return null;
            }
        })();
        if (!newId) return { reject: false };

        const db = openMain();
        let successor = null;
        try {
            const peersTbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='peers'").get();
            if (peersTbl) {
                successor = db.prepare('SELECT pk, uuid, ip FROM peers WHERE id = ? AND NOT soft_deleted').get(newId);
            }
        } catch (_) {}
        if (!successor) {
            try {
                successor = db.prepare('SELECT pk, uuid, ip FROM peer WHERE id = ? AND is_deleted = 0').get(newId);
            } catch (_) {}
        }
        if (!successor) return { reject: false };

        const pkVal = pk || '';
        const uuidVal = uuid || '';
        if (pkVal && successor.pk && pkEqual(pkVal, successor.pk)) return { reject: false, redirect_id: newId };
        if (uuidVal && successor.uuid && uuidEqual(uuidVal, successor.uuid)) return { reject: false, redirect_id: newId };
        if (!pkVal && !uuidVal && ip && peerIPMatches(ip, successor.ip || '')) return { reject: false, redirect_id: newId };

        return { reject: true, new_id: newId };
    }

    function syncGoPeersSqlite() {
        const now = Date.now();
        if (now - _lastGoPeerSyncSqlite < GO_SYNC_INTERVAL_SQLITE_MS) return;
        _lastGoPeerSyncSqlite = now;
        const db = openMain();
        try {
            // Check if Go's 'peers' table exists
            const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='peers'").get();
            if (!tbl) return;
            db.prepare(`
                INSERT INTO peer (id, uuid, pk, info, ip, "user", status_online, last_online, created_at,
                                  is_deleted, is_banned, banned_at, banned_reason, tags)
                SELECT
                    p.id,
                    COALESCE(p.uuid, ''),
                    p.pk,
                    json_object(
                        'hostname', COALESCE(p.hostname, ''),
                        'os',       COALESCE(p.os, ''),
                        'platform', COALESCE(p.os, ''),
                        'version',  COALESCE(p.version, '')
                    ),
                    COALESCE(p.ip, ''),
                    COALESCE(p."user", ''),
                    CASE WHEN p.status = 'ONLINE' THEN 1 ELSE 0 END,
                    p.last_online,
                    COALESCE(p.created_at, datetime('now')),
                    0,
                    CASE WHEN p.banned THEN 1 ELSE 0 END,
                    p.banned_at,
                    COALESCE(p.ban_reason, ''),
                    COALESCE(p.tags, '')
                FROM peers p
                WHERE NOT p.soft_deleted
                ON CONFLICT(id) DO UPDATE SET
                    status_online = excluded.status_online,
                    last_online   = COALESCE(excluded.last_online, last_online),
                    info          = CASE WHEN info IS NULL OR info = '{}' OR info = '' THEN excluded.info ELSE info END,
                    is_deleted    = 0,
                    tags          = COALESCE(NULLIF(excluded.tags, ''), tags)
            `).run();

            // Clean up ghost entries from ID changes: remove peers whose ID appears
            // as old_id in Go's id_change_history and no longer exists in Go's peers table.
            const histTbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='id_change_history'").get();
            if (histTbl) {
                const result = db.prepare(`
                    DELETE FROM peer WHERE id IN (
                        SELECT h.old_id FROM id_change_history h
                        LEFT JOIN peers p ON p.id = h.old_id AND NOT p.soft_deleted
                        WHERE p.id IS NULL
                    )
                `).run();
                if (result.changes > 0) {
                    console.log(`[DB] syncGoPeersSqlite: cleaned up ${result.changes} ghost peer(s) from ID changes`);
                }
            }
            syncPanelPeerIdRenamesFromGoSqlite();
        } catch (err) {
            if (!err.message.includes('no such table')) {
                console.warn('[DB] syncGoPeersSqlite error:', err.message);
            }
        }
    }

    // ========= Adapter object =========

    return {
        type: 'sqlite',

        async init() {
            const main = openMain();
            const auth = openAuth();
            ensurePeerTable(main);
            ensureInventoryTables(main);
            ensureActivityTables(main);
            ensureTicketTables(auth);
            ensureAlertTables(auth);
            ensureNetworkTables(main);
            ensureDataGuardTables(main);
            ensureReportTables(main);
            ensureTenantTables(main);
            ensureRegistrationTables(main);
            ensureAgentBundleTables(main);
            ensureAuthTables(auth);
            console.log('[DB] SQLite adapter initialized');
        },

        async close() {
            if (authDb && !authUsesMain) { authDb.close(); }
            authDb = null;
            authUsesMain = false;
            if (mainDb) { mainDb.close(); mainDb = null; }
        },

        // ---- Peers ----

        async getAllPeers(filters = {}) {
            syncGoPeersSqlite();
            const db = openMain();
            let where = 'WHERE is_deleted = 0';
            const params = [];
            if (filters.online !== undefined) { where += ' AND status_online = ?'; params.push(filters.online ? 1 : 0); }
            if (filters.banned !== undefined) { where += ' AND is_banned = ?'; params.push(filters.banned ? 1 : 0); }
            if (filters.search) { where += ` AND (id LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\' OR "user" LIKE ? ESCAPE '\\')`; const s = `%${escapeLikePattern(filters.search)}%`; params.push(s, s, s); }
            if (filters.folder_id !== undefined) {
                if (filters.folder_id === null) { where += ' AND folder_id IS NULL'; }
                else { where += ' AND folder_id = ?'; params.push(filters.folder_id); }
            }
            const rows = db.prepare(`SELECT * FROM peer ${where} ORDER BY id`).all(...params);
            return rows.map(parsePeer);
        },

        async getPeerById(id) {
            const db = openMain();
            let row = db.prepare('SELECT * FROM peer WHERE id = ? AND is_deleted = 0').get(id);
            if (!row) {
                // Fallback: check Go server's 'peers' table (different schema).
                // Both Go and Node.js use the same db_v2.sqlite3 file but create
                // different tables ('peers' vs 'peer'). Bridge them here.
                try {
                    const goRow = db.prepare('SELECT * FROM peers WHERE id = ? AND NOT soft_deleted').get(id);
                    if (goRow) {
                        const info = JSON.stringify({
                            hostname: goRow.hostname || '',
                            os: goRow.os || '',
                            platform: goRow.os || '',
                            version: goRow.version || ''
                        });
                        db.prepare(`
                            INSERT INTO peer (id, uuid, pk, info, ip, "user", status_online, last_online, created_at, is_deleted, is_banned, banned_at, banned_reason, tags)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
                            ON CONFLICT(id) DO UPDATE SET
                                uuid = COALESCE(NULLIF(excluded.uuid, ''), uuid),
                                pk = COALESCE(excluded.pk, pk),
                                info = COALESCE(NULLIF(excluded.info, '{}'), info),
                                ip = COALESCE(NULLIF(excluded.ip, ''), ip),
                                "user" = COALESCE(NULLIF(excluded."user", ''), "user"),
                                status_online = excluded.status_online,
                                last_online = COALESCE(excluded.last_online, last_online),
                                is_deleted = 0,
                                tags = COALESCE(NULLIF(excluded.tags, ''), tags)
                        `).run(
                            goRow.id,
                            goRow.uuid || '',
                            goRow.pk || null,
                            info,
                            goRow.ip || '',
                            goRow.user || '',
                            goRow.status === 'ONLINE' ? 1 : 0,
                            goRow.last_online || null,
                            goRow.created_at || new Date().toISOString(),
                            goRow.banned ? 1 : 0,
                            goRow.banned_at || null,
                            goRow.ban_reason || '',
                            goRow.tags || ''
                        );
                        row = db.prepare('SELECT * FROM peer WHERE id = ? AND is_deleted = 0').get(id);
                    }
                } catch (err) {
                    // 'peers' table might not exist if Go server hasn't run yet
                    if (!err.message.includes('no such table')) {
                        console.warn('[DB] Fallback peers lookup error:', err.message);
                    }
                }
            }
            return parsePeer(row);
        },

        async upsertPeer({ id, uuid, pk, info, ip }) {
            openMain().prepare(`
                INSERT INTO peer (id, uuid, pk, info, ip, status_online, created_at)
                VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
                ON CONFLICT(id) DO UPDATE SET
                    uuid = COALESCE(excluded.uuid, uuid),
                    pk = COALESCE(excluded.pk, pk),
                    info = COALESCE(excluded.info, info),
                    ip = COALESCE(excluded.ip, ip),
                    status_online = 1,
                    last_online = datetime('now'),
                    is_deleted = 0
            `).run(id, uuid || '', pk || null, info || '', ip || '');
        },

        async updatePeer(id, data) {
            const db = openMain();
            if (data.note !== undefined) db.prepare('UPDATE peer SET note = ? WHERE id = ?').run(data.note, id);
            if (data.user !== undefined) db.prepare('UPDATE peer SET "user" = ? WHERE id = ?').run(data.user, id);
            if (data.info !== undefined) db.prepare('UPDATE peer SET info = ? WHERE id = ?').run(data.info, id);
        },

        async softDeletePeer(id) {
            openMain().prepare('UPDATE peer SET is_deleted = 1 WHERE id = ?').run(id);
        },

        async cleanupDeletedPeerData(id) {
            const authDb = openAuth();
            authDb.prepare('DELETE FROM peer_sysinfo WHERE peer_id = ?').run(id);
            authDb.prepare('DELETE FROM peer_metrics WHERE peer_id = ?').run(id);
            authDb.prepare('DELETE FROM device_folder_assignments WHERE peer_id = ?').run(id);
            authDb.prepare('DELETE FROM device_group_peers WHERE peer_id = ?').run(id);
        },

        /**
         * Check if a peer ID was renamed to a new ID. Returns the new_id if found,
         * null otherwise. Used to reject registrations with stale/old IDs.
         */
        getRenamedPeerId(oldId) {
            try {
                const db = openMain();
                const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='id_change_history'").get();
                if (!tbl) return null;
                const row = db.prepare('SELECT new_id FROM id_change_history WHERE old_id = ? ORDER BY rowid DESC LIMIT 1').get(oldId);
                return row ? row.new_id : null;
            } catch (_) { return null; }
        },

        /**
         * Update auth.db and panel peer rows when a device ID changes (#213).
         */
        cascadePeerIdChange(oldId, newId) {
            cascadePeerIdChangeSqlite(oldId, newId);
        },

        purgePanelPeerRecord(id) {
            purgePanelPeerRecordSqlite(id);
        },

        shouldRejectRenamedPeerRegistration(oldId, identity) {
            return shouldRejectRenamedPeerRegistrationSqlite(oldId, identity);
        },

        async setBanStatus(id, banned, reason = '') {
            openMain().prepare(`
                UPDATE peer SET is_banned = ?, banned_at = CASE WHEN ? THEN datetime('now') ELSE NULL END, banned_reason = ?
                WHERE id = ?
            `).run(banned ? 1 : 0, banned ? 1 : 0, reason, id);
        },

        async getPeerStats() {
            syncGoPeersSqlite();
            const db = openMain();
            const total = db.prepare('SELECT COUNT(*) as c FROM peer WHERE is_deleted = 0').get().c;
            const online = db.prepare('SELECT COUNT(*) as c FROM peer WHERE is_deleted = 0 AND status_online = 1').get().c;
            const banned = db.prepare('SELECT COUNT(*) as c FROM peer WHERE is_deleted = 0 AND is_banned = 1').get().c;
            return { total, online, banned, offline: total - online };
        },

        async resetAllOnlineStatus() {
            openMain().prepare('UPDATE peer SET status_online = 0').run();
        },

        async markPeersOnline(ids) {
            if (!ids.length) return;
            const db = openMain();
            const placeholders = ids.map(() => '?').join(',');
            db.prepare(`UPDATE peer SET status_online = 1, last_online = datetime('now') WHERE id IN (${placeholders})`).run(...ids);
        },

        // ---- Users ----

        async getUserByUsername(username) {
            return openAuth().prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
        },
        async getUserById(id) {
            return openAuth().prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
        },
        async createUser(username, passwordHash, role = 'admin', authProvider = 'local') {
            const provider = authProvider || 'local';
            const info = openAuth().prepare('INSERT INTO users (username, password_hash, role, auth_provider) VALUES (?, ?, ?, ?)').run(username, passwordHash, role, provider);
            return { id: Number(info.lastInsertRowid), username, role, auth_provider: provider };
        },
        async syncUserFromGo(id, { role, authProvider, passwordHash } = {}) {
            const sets = [];
            const values = [];
            if (role !== undefined && role !== null) {
                sets.push('role = ?');
                values.push(role);
            }
            if (authProvider !== undefined && authProvider !== null) {
                sets.push('auth_provider = ?');
                values.push(authProvider);
            }
            if (passwordHash !== undefined && passwordHash !== null) {
                sets.push('password_hash = ?');
                values.push(passwordHash);
            }
            if (!sets.length) return;
            values.push(id);
            openAuth().prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
        },
        async updateUserPassword(id, passwordHash) {
            openAuth().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
        },
        async touchLastLogin(id) {
            openAuth().prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(id);
        },
        async hasUsers() {
            return (openAuth().prepare('SELECT COUNT(*) as c FROM users').get().c) > 0;
        },
        async getAllUsers() {
            return openAuth().prepare('SELECT id, username, role, auth_provider, created_at, last_login, preferred_language, totp_enabled, email FROM users ORDER BY id').all();
        },
        async updateUserRole(id, role) {
            openAuth().prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
        },
        async updateUserLanguage(id, lang) {
            openAuth().prepare('UPDATE users SET preferred_language = ? WHERE id = ?').run(lang, id);
        },
        // Phase 4: update operator identity profile (first_name, last_name, email, phone, role_display, avatar_url)
        async updateUserProfile(id, fields) {
            const allowed = ['first_name', 'last_name', 'email', 'phone', 'role_display', 'avatar_url'];
            const sets = [];
            const values = [];
            for (const k of allowed) {
                if (fields && Object.prototype.hasOwnProperty.call(fields, k)) {
                    sets.push(`${k} = ?`);
                    values.push(String(fields[k] == null ? '' : fields[k]).slice(0, 200));
                }
            }
            if (!sets.length) return;
            values.push(id);
            openAuth().prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
        },
        async deleteUser(id) {
            const db = openAuth();
            db.prepare('DELETE FROM user_group_members WHERE user_id = ?').run(id);
            db.prepare('DELETE FROM device_group_user_access WHERE user_id = ?').run(id);
            db.prepare('DELETE FROM users WHERE id = ?').run(id);
        },
        async countAdmins() {
            return openAuth().prepare("SELECT COUNT(*) as c FROM users WHERE role IN ('admin', 'super_admin')").get().c;
        },

        // ---- TOTP ----

        async saveTotpSecret(userId, secret) {
            openAuth().prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, userId);
        },
        async enableTotp(userId, recoveryCodes) {
            const codesJson = Array.isArray(recoveryCodes) ? JSON.stringify(recoveryCodes) : recoveryCodes;
            openAuth().prepare('UPDATE users SET totp_enabled = 1, totp_recovery_codes = ? WHERE id = ?').run(codesJson, userId);
        },
        async disableTotp(userId) {
            openAuth().prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_recovery_codes = NULL WHERE id = ?').run(userId);
        },
        async useRecoveryCode(userId, updatedCodes) {
            const codesJson = Array.isArray(updatedCodes) ? JSON.stringify(updatedCodes) : updatedCodes;
            openAuth().prepare('UPDATE users SET totp_recovery_codes = ? WHERE id = ?').run(codesJson, userId);
        },

        // ---- Access tokens ----

        async createAccessToken({ token, userId, clientId, clientUuid, expiresAt, ipAddress }) {
            const tokenHash = hashAccessToken(token);
            openAuth().prepare(`
                INSERT INTO access_tokens (token, token_hash, user_id, client_id, client_uuid, expires_at, ip_address)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(token, tokenHash, userId, clientId || '', clientUuid || '', expiresAt, ipAddress || '');
        },
        async getAccessToken(token) {
            const tokenHash = hashAccessToken(token);
            const byHash = openAuth().prepare(`
                SELECT * FROM access_tokens
                WHERE token_hash = ? AND revoked = 0 AND expires_at > datetime('now')
            `).get(tokenHash);
            if (byHash) return byHash;
            return openAuth().prepare(`
                SELECT * FROM access_tokens
                WHERE token = ? AND revoked = 0 AND expires_at > datetime('now')
            `).get(token) || null;
        },
        async touchAccessToken(token) {
            const tokenHash = hashAccessToken(token);
            openAuth().prepare(`
                UPDATE access_tokens SET last_used = datetime('now')
                WHERE token_hash = ? OR token = ?
            `).run(tokenHash, token);
        },
        async revokeAccessToken(token) {
            const tokenHash = hashAccessToken(token);
            openAuth().prepare(`
                UPDATE access_tokens SET revoked = 1
                WHERE token_hash = ? OR token = ?
            `).run(tokenHash, token);
        },
        async revokeUserClientTokens(userId, clientUuid) {
            openAuth().prepare('UPDATE access_tokens SET revoked = 1 WHERE user_id = ? AND client_uuid = ?').run(userId, clientUuid);
        },
        async revokeAllUserTokens(userId) {
            openAuth().prepare('UPDATE access_tokens SET revoked = 1 WHERE user_id = ?').run(userId);
        },
        async cleanupExpiredTokens() {
            openAuth().prepare("DELETE FROM access_tokens WHERE expires_at < datetime('now') OR revoked = 1").run();
        },

        // ---- Login tracking ----

        async recordLoginAttempt(username, ipAddress, success) {
            openAuth().prepare('INSERT INTO login_attempts (username, ip_address, success) VALUES (?, ?, ?)').run(username, ipAddress, success ? 1 : 0);
        },
        async countRecentFailedAttempts(username, windowMinutes) {
            return openAuth().prepare(`
                SELECT COUNT(*) as c FROM login_attempts
                WHERE username = ? AND success = 0
                    AND created_at > datetime('now', '-' || ? || ' minutes')
            `).get(username, windowMinutes).c;
        },
        async countRecentFailedAttemptsFromIp(ipAddress, windowMinutes) {
            return openAuth().prepare(`
                SELECT COUNT(*) as c FROM login_attempts
                WHERE ip_address = ? AND success = 0
                    AND created_at > datetime('now', '-' || ? || ' minutes')
            `).get(ipAddress, windowMinutes).c;
        },
        async lockAccount(username, lockedUntil, attemptCount) {
            openAuth().prepare(`
                INSERT INTO account_lockouts (username, locked_until, attempt_count)
                VALUES (?, ?, ?)
                ON CONFLICT(username) DO UPDATE SET locked_until = excluded.locked_until, attempt_count = excluded.attempt_count
            `).run(username, lockedUntil, attemptCount);
        },
        async getAccountLockout(username) {
            return openAuth().prepare("SELECT * FROM account_lockouts WHERE username = ? AND locked_until > datetime('now')").get(username) || null;
        },
        async clearAccountLockout(username) {
            openAuth().prepare('DELETE FROM account_lockouts WHERE username = ?').run(username);
        },

        // ---- Folders ----

        async getAllFolders() {
            return openAuth().prepare('SELECT * FROM folders ORDER BY sort_order, name').all();
        },
        async getFolderById(id) {
            return openAuth().prepare('SELECT * FROM folders WHERE id = ?').get(id) || null;
        },
        async createFolder({ name, color, icon, sort_order }) {
            const info = openAuth().prepare('INSERT INTO folders (name, color, icon, sort_order) VALUES (?, ?, ?, ?)').run(name, color || '#6366f1', icon || 'folder', sort_order || 0);
            return { id: Number(info.lastInsertRowid), name, color, icon, sort_order };
        },
        async updateFolder(id, { name, color, icon, sort_order }) {
            const sets = [];
            const params = [];
            if (name !== undefined) { sets.push('name = ?'); params.push(name); }
            if (color !== undefined) { sets.push('color = ?'); params.push(color); }
            if (icon !== undefined) { sets.push('icon = ?'); params.push(icon); }
            if (sort_order !== undefined) { sets.push('sort_order = ?'); params.push(sort_order); }
            if (!sets.length) return;
            params.push(id);
            openAuth().prepare(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`).run(...params);
        },
        async deleteFolder(id) {
            // Clear folder assignments first
            openAuth().prepare('DELETE FROM device_folder_assignments WHERE folder_id = ?').run(id);
            openAuth().prepare('DELETE FROM folders WHERE id = ?').run(id);
        },
        async assignDeviceToFolder(deviceId, folderId) {
            // Update assignment tracking table (device_folder_assignments is the single source of truth)
            if (folderId === null || folderId === undefined) {
                openAuth().prepare('DELETE FROM device_folder_assignments WHERE device_id = ?').run(deviceId);
            } else {
                openAuth().prepare(`
                    INSERT INTO device_folder_assignments (device_id, folder_id)
                    VALUES (?, ?)
                    ON CONFLICT(device_id) DO UPDATE SET folder_id = ?, assigned_at = datetime('now')
                `).run(deviceId, folderId, folderId);
            }
        },

        // ---- Address books ----

        async getAddressBook(userId, abType = 'legacy') {
            const db = openAuth();
            if (usesUsernameAddressBooks(db)) {
                const username = usernameForUserId(db, userId);
                return username
                    ? db.prepare('SELECT * FROM address_books WHERE username = ? AND ab_type = ?').get(username, abType) || null
                    : null;
            }
            return db.prepare('SELECT * FROM address_books WHERE user_id = ? AND ab_type = ?').get(userId, abType) || null;
        },
        async saveAddressBook(userId, abType, data) {
            const db = openAuth();
            if (usesUsernameAddressBooks(db)) {
                const username = usernameForUserId(db, userId);
                if (!username) return;
                db.prepare(`
                    INSERT INTO address_books (username, ab_type, data, updated_at)
                    VALUES (?, ?, ?, datetime('now'))
                    ON CONFLICT(username, ab_type) DO UPDATE SET data = excluded.data, updated_at = datetime('now')
                `).run(username, abType, data);
                return;
            }
            db.prepare(`
                INSERT INTO address_books (user_id, ab_type, data, updated_at)
                VALUES (?, ?, ?, datetime('now'))
                ON CONFLICT(user_id, ab_type) DO UPDATE SET data = excluded.data, updated_at = datetime('now')
            `).run(userId, abType, data);
        },

        // ---- Notification read state (navbar bell) ----

        async getReadNotificationIds(userId) {
            const rows = openAuth()
                .prepare('SELECT notification_id FROM notification_reads WHERE user_id = ?')
                .all(userId);
            return new Set(rows.map((r) => String(r.notification_id)));
        },
        async markNotificationRead(userId, notificationId) {
            const auth = openAuth();
            auth.prepare(`
                INSERT OR IGNORE INTO notification_reads (user_id, notification_id, read_at)
                VALUES (?, ?, datetime('now'))
            `).run(userId, String(notificationId));
            const count = auth.prepare('SELECT COUNT(*) AS c FROM notification_reads WHERE user_id = ?').get(userId);
            if (count && count.c > 500) {
                auth.prepare(`
                    DELETE FROM notification_reads
                    WHERE user_id = ? AND rowid NOT IN (
                        SELECT rowid FROM notification_reads
                        WHERE user_id = ?
                        ORDER BY read_at DESC
                        LIMIT 400
                    )
                `).run(userId, userId);
            }
        },
        async markAllNotificationsRead(userId, notificationIds) {
            const auth = openAuth();
            const insert = auth.prepare(`
                INSERT OR IGNORE INTO notification_reads (user_id, notification_id, read_at)
                VALUES (?, ?, datetime('now'))
            `);
            const txn = auth.transaction((ids) => {
                for (const id of ids) {
                    insert.run(userId, String(id));
                }
            });
            txn(notificationIds);
            const count = auth.prepare('SELECT COUNT(*) AS c FROM notification_reads WHERE user_id = ?').get(userId);
            if (count && count.c > 500) {
                auth.prepare(`
                    DELETE FROM notification_reads
                    WHERE user_id = ? AND rowid NOT IN (
                        SELECT rowid FROM notification_reads
                        WHERE user_id = ?
                        ORDER BY read_at DESC
                        LIMIT 400
                    )
                `).run(userId, userId);
            }
        },

        async hasEmailNotificationSent(eventType, eventId, recipient) {
            const row = openAuth().prepare(`
                SELECT 1 FROM email_notification_log
                WHERE event_type = ? AND event_id = ? AND recipient = ?
            `).get(String(eventType), String(eventId), String(recipient));
            return !!row;
        },
        async logEmailNotificationSent(eventType, eventId, recipient) {
            openAuth().prepare(`
                INSERT OR IGNORE INTO email_notification_log (event_type, event_id, recipient, sent_at)
                VALUES (?, ?, ?, datetime('now'))
            `).run(String(eventType), String(eventId), String(recipient));
        },
        async getUsersEmailsByUsernames(usernames = []) {
            const list = Array.from(new Set((usernames || []).map(u => String(u || '').trim()).filter(Boolean)));
            if (!list.length) return [];
            const placeholders = list.map(() => '?').join(',');
            return openAuth().prepare(`
                SELECT username, email FROM users
                WHERE username IN (${placeholders}) AND email IS NOT NULL AND email != ''
            `).all(...list);
        },
        async getUsernamesByUserGroupGuid(guid) {
            const groupGuid = String(guid || '').trim();
            if (!groupGuid) return [];
            return openAuth().prepare(`
                SELECT u.username FROM users u
                INNER JOIN user_group_members ugm ON ugm.user_id = u.id
                INNER JOIN user_groups ug ON ug.id = ugm.user_group_id
                WHERE ug.guid = ?
                ORDER BY u.username ASC
            `).all(groupGuid).map(r => r.username);
        },

        // ---- Audit ----

        async logAction(userId, action, details, ipAddress) {
            const safeDetails = redactAuditDetails(details);
            openAuth().prepare('INSERT INTO audit_log (user_id, action, details, ip_address) VALUES (?, ?, ?, ?)').run(userId, action, safeDetails, ipAddress);
        },
        async getAuditLogs(limit = 100, offset = 0) {
            return openAuth().prepare(`
                SELECT a.*, u.username FROM audit_log a
                LEFT JOIN users u ON a.user_id = u.id
                ORDER BY a.created_at DESC LIMIT ? OFFSET ?
            `).all(limit, offset);
        },
        async cleanupOldAuditLogs(daysToKeep = 90) {
            const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();
            const result = openAuth().prepare('DELETE FROM audit_log WHERE created_at < ?').run(cutoff);
            return result.changes || 0;
        },

        // ---- Settings ----

        async getSetting(key) {
            const row = openAuth().prepare('SELECT value FROM settings WHERE key = ?').get(key);
            return row ? row.value : null;
        },
        async setSetting(key, value) {
            openAuth().prepare(`
                INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
            `).run(key, value);
        },
        async getAllSettings() {
            const rows = openAuth().prepare('SELECT key, value FROM settings').all();
            const result = {};
            for (const r of rows) result[r.key] = r.value;
            return result;
        },

        // ---- Branding Config ----

        async getBrandingConfig() {
            return openAuth().prepare('SELECT key, value FROM branding_config').all();
        },
        async saveBrandingConfigBatch(entries) {
            const db = openAuth();
            const stmt = db.prepare(`
                INSERT INTO branding_config (key, value, updated_at) VALUES (?, ?, datetime('now'))
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
            `);
            const tx = db.transaction((items) => {
                for (const { key, value } of items) stmt.run(key, value);
            });
            tx(entries);
        },
        async resetBrandingConfig() {
            openAuth().prepare('DELETE FROM branding_config').run();
        },

        async getBrandingConfigRevision() {
            const row = openAuth().prepare('SELECT MAX(updated_at) AS rev FROM branding_config').get();
            return row?.rev || null;
        },

        async listBrandingProfiles() {
            return openAuth().prepare(
                'SELECT id, name, description, is_active, created_at, updated_at FROM branding_profiles ORDER BY name COLLATE NOCASE'
            ).all();
        },

        async getBrandingProfile(id) {
            return openAuth().prepare('SELECT * FROM branding_profiles WHERE id = ?').get(id);
        },

        async createBrandingProfile(name, description, data) {
            const json = typeof data === 'string' ? data : JSON.stringify(data);
            const r = openAuth().prepare(`
                INSERT INTO branding_profiles (name, description, data, created_at, updated_at)
                VALUES (?, ?, ?, datetime('now'), datetime('now'))
            `).run(name, description || '', json);
            return r.lastInsertRowid;
        },

        async updateBrandingProfile(id, name, description, data) {
            const json = typeof data === 'string' ? data : JSON.stringify(data);
            openAuth().prepare(`
                UPDATE branding_profiles
                SET name = ?, description = ?, data = ?, updated_at = datetime('now')
                WHERE id = ?
            `).run(name, description || '', json, id);
        },

        async setActiveBrandingProfile(id) {
            const db = openAuth();
            const tx = db.transaction((profileId) => {
                db.prepare('UPDATE branding_profiles SET is_active = 0').run();
                db.prepare('UPDATE branding_profiles SET is_active = 1, updated_at = datetime(\'now\') WHERE id = ?').run(profileId);
            });
            tx(id);
        },

        async deleteBrandingProfile(id) {
            openAuth().prepare('DELETE FROM branding_profiles WHERE id = ?').run(id);
        },

        // ---- Backup Helpers ----

        async getAllUsersForBackup() {
            // SELECT * captures every column (incl. totp_secret, totp_recovery_codes,
            // is_server_admin, org_id, preferred_language) so account restore is lossless.
            return openAuth().prepare('SELECT * FROM users ORDER BY id').all();
        },
        async getAllAddressBooks() {
            const db = openAuth();
            if (usesUsernameAddressBooks(db)) {
                return db.prepare(`
                    SELECT u.id AS user_id, ab.ab_type, ab.data, ab.updated_at
                    FROM address_books ab INNER JOIN users u ON u.username = ab.username
                    ORDER BY u.id
                `).all();
            }
            return db.prepare('SELECT user_id, ab_type, data, updated_at FROM address_books ORDER BY user_id').all();
        },
        async restoreUsers(users) {
            const db = openAuth();
            // Restore dynamically against the live schema so backups created on a
            // newer schema (extra columns) still import without raising errors.
            const cols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
            const tx = db.transaction((items) => {
                db.prepare('DELETE FROM users').run();
                for (const u of items) {
                    const keys = Object.keys(u).filter((k) => cols.has(k));
                    if (keys.length === 0) continue;
                    const placeholders = keys.map(() => '?').join(', ');
                    const ins = db.prepare(
                        `INSERT OR REPLACE INTO users (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${placeholders})`
                    );
                    ins.run(...keys.map((k) => u[k]));
                }
            });
            tx(users);
        },
        async getBackupStats() {
            const db = openAuth();
            const c = (tbl) => {
                try { return db.prepare(`SELECT COUNT(*) as c FROM ${tbl}`).get().c; }
                catch (_) { return 0; }
            };
            return {
                users: c('users'), settings: c('settings'), folders: c('folders'),
                userGroups: c('user_groups'), deviceGroups: c('device_groups'),
                strategies: c('strategies'), addressBooks: c('address_books'),
            };
        },

        /**
         * Absolute path to the SQLite database file backing the console.
         * Used by full backups for a 1:1 raw file copy. Returns null for PostgreSQL.
         */
        getDatabaseFilePath() {
            return authStorageIsConsolidated()
                ? config.dbPath
                : (config.authDbPath || path.join(config.dataDir, 'auth.db'));
        },

        /**
         * Logical dump of every user table in auth.db. DB-agnostic and portable
         * across machines and database engines. BLOB values are encoded as
         * { __buf__: <base64> } so they survive JSON serialisation.
         */
        async dumpAllTables() {
            const db = openAuth();
            const tableRows = db.prepare(
                `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
            ).all();
            const tables = {};
            for (const { name } of tableRows) {
                try {
                    const rows = db.prepare(`SELECT * FROM "${name}"`).all();
                    tables[name] = rows.map((row) => {
                        const out = {};
                        for (const [k, v] of Object.entries(row)) {
                            out[k] = Buffer.isBuffer(v) ? { __buf__: v.toString('base64') } : v;
                        }
                        return out;
                    });
                } catch (_) { /* skip unreadable table */ }
            }
            return { _engine: 'sqlite', tables };
        },

        /**
         * Logical restore of tables produced by dumpAllTables(). Each table is
         * wiped and re-populated. Only tables that exist in the live schema are
         * touched; unknown columns are dropped. Wrapped per-table so one bad
         * table does not abort the whole restore.
         * @returns {{ restored: string[], skipped: string[], warnings: string[] }}
         */
        async importAllTables(dump) {
            const db = openAuth();
            const result = { restored: [], skipped: [], warnings: [] };
            const tables = (dump && dump.tables) || {};
            const liveTables = new Set(
                db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((t) => t.name)
            );
            db.pragma('foreign_keys = OFF');
            try {
                for (const [name, rows] of Object.entries(tables)) {
                    if (!liveTables.has(name) || !Array.isArray(rows)) { result.skipped.push(name); continue; }
                    const cols = new Set(db.prepare(`PRAGMA table_info("${name}")`).all().map((c) => c.name));
                    try {
                        const tx = db.transaction(() => {
                            db.prepare(`DELETE FROM "${name}"`).run();
                            for (const row of rows) {
                                const keys = Object.keys(row).filter((k) => cols.has(k));
                                if (keys.length === 0) continue;
                                const vals = keys.map((k) => {
                                    const v = row[k];
                                    if (v && typeof v === 'object' && typeof v.__buf__ === 'string') {
                                        return Buffer.from(v.__buf__, 'base64');
                                    }
                                    return v;
                                });
                                const placeholders = keys.map(() => '?').join(', ');
                                db.prepare(
                                    `INSERT OR REPLACE INTO "${name}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${placeholders})`
                                ).run(...vals);
                            }
                        });
                        tx();
                        result.restored.push(name);
                    } catch (err) {
                        result.warnings.push(`Table ${name}: ${err.message}`);
                    }
                }
            } finally {
                db.pragma('foreign_keys = ON');
            }
            return result;
        },

        // ---- Tickets ----

        async createTicket({ title, description, priority, category, deviceId, createdBy, assignedTo, slaDueAt }) {
            const info = openAuth().prepare(`
                INSERT INTO tickets (title, description, priority, category, device_id, created_by, assigned_to, sla_due_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(title, description || '', priority || 'medium', category || 'general', deviceId || null, createdBy, assignedTo || null, slaDueAt || null);
            return { id: Number(info.lastInsertRowid), title };
        },

        async getTicketById(id) {
            return openAuth().prepare('SELECT * FROM tickets WHERE id = ?').get(id) || null;
        },

        async getAllTickets(filters = {}) {
            const db = openAuth();
            let where = 'WHERE 1=1';
            const params = [];
            if (filters.status) { where += ' AND status = ?'; params.push(filters.status); }
            if (filters.priority) { where += ' AND priority = ?'; params.push(filters.priority); }
            if (filters.category) { where += ' AND category = ?'; params.push(filters.category); }
            if (filters.assigned_to) { where += ' AND assigned_to = ?'; params.push(filters.assigned_to); }
            if (filters.device_id) { where += ' AND device_id = ?'; params.push(filters.device_id); }
            if (filters.created_by) { where += ' AND created_by = ?'; params.push(filters.created_by); }
            if (filters.search) { where += ` AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')`; const s = `%${escapeLikePattern(filters.search)}%`; params.push(s, s); }
            return db.prepare(`SELECT * FROM tickets ${where} ORDER BY created_at DESC`).all(...params);
        },

        async updateTicket(id, data) {
            const db = openAuth();
            const sets = [];
            const params = [];
            for (const key of ['title', 'description', 'status', 'priority', 'category', 'assigned_to', 'sla_due_at']) {
                if (data[key] !== undefined) { sets.push(`${key} = ?`); params.push(data[key]); }
            }
            if (data.status === 'resolved' && !data.resolved_at) { sets.push("resolved_at = datetime('now')"); }
            if (data.status === 'closed' && !data.closed_at) { sets.push("closed_at = datetime('now')"); }
            sets.push("updated_at = datetime('now')");
            params.push(id);
            db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`).run(...params);
        },

        async deleteTicket(id) {
            const db = openAuth();
            db.prepare('DELETE FROM ticket_comments WHERE ticket_id = ?').run(id);
            db.prepare('DELETE FROM ticket_attachments WHERE ticket_id = ?').run(id);
            db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
        },

        async getTicketStats() {
            const db = openAuth();
            const total = db.prepare('SELECT COUNT(*) as c FROM tickets').get().c;
            const open = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status = 'open'").get().c;
            const inProgress = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status = 'in_progress'").get().c;
            const resolved = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status = 'resolved'").get().c;
            const closed = db.prepare("SELECT COUNT(*) as c FROM tickets WHERE status = 'closed'").get().c;
            return { total, open, in_progress: inProgress, resolved, closed };
        },

        async addTicketComment(ticketId, author, body, isInternal = false) {
            const info = openAuth().prepare(`
                INSERT INTO ticket_comments (ticket_id, author, body, is_internal) VALUES (?, ?, ?, ?)
            `).run(ticketId, author, body, isInternal ? 1 : 0);
            openAuth().prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(ticketId);
            return { id: Number(info.lastInsertRowid) };
        },

        async getTicketComments(ticketId) {
            return openAuth().prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at ASC').all(ticketId);
        },

        async addTicketAttachment(ticketId, { filename, mimetype, sizeBytes, storagePath, uploadedBy }) {
            const info = openAuth().prepare(`
                INSERT INTO ticket_attachments (ticket_id, filename, mimetype, size_bytes, storage_path, uploaded_by)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(ticketId, filename, mimetype || 'application/octet-stream', sizeBytes || 0, storagePath, uploadedBy);
            return { id: Number(info.lastInsertRowid) };
        },

        async getTicketAttachments(ticketId) {
            return openAuth().prepare('SELECT * FROM ticket_attachments WHERE ticket_id = ? ORDER BY created_at ASC').all(ticketId);
        },

        async getAttachmentById(id) {
            return openAuth().prepare('SELECT * FROM ticket_attachments WHERE id = ?').get(id) || null;
        },

        // ---- Inventory ----

        async upsertInventory(deviceId, hardware, software, collectedAt) {
            openMain().prepare(`
                INSERT INTO device_inventory (device_id, hardware, software, collected_at, received_at)
                VALUES (?, ?, ?, ?, datetime('now'))
                ON CONFLICT(device_id) DO UPDATE SET
                    hardware = excluded.hardware,
                    software = excluded.software,
                    collected_at = excluded.collected_at,
                    received_at = datetime('now')
            `).run(deviceId, JSON.stringify(hardware), JSON.stringify(software || {}), collectedAt || new Date().toISOString());
        },

        async getInventory(deviceId) {
            const row = openMain().prepare('SELECT * FROM device_inventory WHERE device_id = ?').get(deviceId);
            if (!row) return null;
            return {
                device_id: row.device_id,
                hardware: JSON.parse(row.hardware || '{}'),
                software: JSON.parse(row.software || '{}'),
                collected_at: row.collected_at,
                received_at: row.received_at,
            };
        },

        async getAllInventories() {
            return openMain().prepare('SELECT * FROM device_inventory ORDER BY received_at DESC').all().map(row => ({
                device_id: row.device_id,
                hardware: JSON.parse(row.hardware || '{}'),
                software: JSON.parse(row.software || '{}'),
                collected_at: row.collected_at,
                received_at: row.received_at,
            }));
        },

        async upsertTelemetry(deviceId, data) {
            openMain().prepare(`
                INSERT INTO device_telemetry (device_id, cpu_usage_percent, memory_used_bytes, memory_total_bytes, uptime_secs, timestamp, received_at)
                VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(device_id) DO UPDATE SET
                    cpu_usage_percent = excluded.cpu_usage_percent,
                    memory_used_bytes = excluded.memory_used_bytes,
                    memory_total_bytes = excluded.memory_total_bytes,
                    uptime_secs = excluded.uptime_secs,
                    timestamp = excluded.timestamp,
                    received_at = datetime('now')
            `).run(deviceId, data.cpu_usage_percent ?? 0, data.memory_used_bytes ?? 0, data.memory_total_bytes ?? 0, data.uptime_secs ?? 0, data.timestamp || new Date().toISOString());
        },

        async getTelemetry(deviceId) {
            const row = openMain().prepare('SELECT * FROM device_telemetry WHERE device_id = ?').get(deviceId);
            if (!row) return null;
            return {
                device_id: row.device_id,
                cpu_usage_percent: row.cpu_usage_percent,
                memory_used_bytes: row.memory_used_bytes,
                memory_total_bytes: row.memory_total_bytes,
                uptime_secs: row.uptime_secs,
                timestamp: row.timestamp,
                received_at: row.received_at,
            };
        },

        // ---- Alert rules & automation ----

        async getAlertRules(filters = {}) {
            let sql = 'SELECT * FROM alert_rules WHERE 1=1';
            const params = [];
            if (filters.enabled !== undefined) { sql += ' AND enabled = ?'; params.push(filters.enabled ? 1 : 0); }
            if (filters.condition_type) { sql += ' AND condition_type = ?'; params.push(filters.condition_type); }
            sql += ' ORDER BY created_at DESC';
            return openAuth().prepare(sql).all(...params);
        },

        async getAlertRuleById(id) {
            return openAuth().prepare('SELECT * FROM alert_rules WHERE id = ?').get(id) || null;
        },

        async createAlertRule(rule) {
            const info = openAuth().prepare(`
                INSERT INTO alert_rules (name, description, enabled, condition_type, condition_op, condition_value,
                    severity, scope_device_id, cooldown_secs, notify_emails, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(rule.name, rule.description || '', rule.enabled !== false ? 1 : 0,
                rule.condition_type, rule.condition_op || 'gt', rule.condition_value || 0,
                rule.severity || 'warning', rule.scope_device_id || null,
                rule.cooldown_secs || 300, rule.notify_emails || '', rule.created_by || null);
            return { id: Number(info.lastInsertRowid), ...rule };
        },

        async updateAlertRule(id, data) {
            const sets = [];
            const params = [];
            for (const key of ['name', 'description', 'condition_type', 'condition_op', 'condition_value',
                'severity', 'scope_device_id', 'cooldown_secs', 'notify_emails']) {
                if (data[key] !== undefined) { sets.push(`${key} = ?`); params.push(data[key]); }
            }
            if (data.enabled !== undefined) { sets.push('enabled = ?'); params.push(data.enabled ? 1 : 0); }
            if (!sets.length) return;
            sets.push("updated_at = datetime('now')");
            params.push(id);
            openAuth().prepare(`UPDATE alert_rules SET ${sets.join(', ')} WHERE id = ?`).run(...params);
        },

        async deleteAlertRule(id) {
            openAuth().prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
        },

        async createAlert(alert) {
            const info = openAuth().prepare(`
                INSERT INTO alert_history (rule_id, device_id, severity, message, triggered_at)
                VALUES (?, ?, ?, ?, ?)
            `).run(alert.rule_id, alert.device_id || null, alert.severity || 'warning',
                alert.message || '', alert.triggered_at || new Date().toISOString());
            return { id: Number(info.lastInsertRowid), ...alert };
        },

        async getRecentAlert(ruleId, deviceId, cooldownSecs) {
            return openAuth().prepare(`
                SELECT * FROM alert_history
                WHERE rule_id = ? AND device_id = ?
                  AND triggered_at > datetime('now', '-' || ? || ' seconds')
                ORDER BY triggered_at DESC LIMIT 1
            `).get(ruleId, deviceId, cooldownSecs) || null;
        },

        async getAlertHistory(filters = {}) {
            let sql = 'SELECT h.*, r.name as rule_name FROM alert_history h LEFT JOIN alert_rules r ON h.rule_id = r.id WHERE 1=1';
            const params = [];
            if (filters.device_id) { sql += ' AND h.device_id = ?'; params.push(filters.device_id); }
            if (filters.severity) { sql += ' AND h.severity = ?'; params.push(filters.severity); }
            if (filters.acknowledged !== undefined) { sql += ' AND h.acknowledged = ?'; params.push(filters.acknowledged ? 1 : 0); }
            sql += ' ORDER BY h.triggered_at DESC';
            if (filters.limit) { sql += ' LIMIT ?'; params.push(filters.limit); }
            return openAuth().prepare(sql).all(...params);
        },

        async acknowledgeAlert(id, username) {
            openAuth().prepare(`
                UPDATE alert_history SET acknowledged = 1, acknowledged_by = ?, acknowledged_at = datetime('now')
                WHERE id = ?
            `).run(username, id);
        },

        // ---- Remote commands ----

        async createRemoteCommand(cmd) {
            const info = openAuth().prepare(`
                INSERT INTO remote_commands (device_id, command_type, payload, status, created_by)
                VALUES (?, ?, ?, 'pending', ?)
            `).run(cmd.device_id, cmd.command_type || 'shell', cmd.payload || '',
                cmd.created_by || 'admin');
            return { id: Number(info.lastInsertRowid), device_id: cmd.device_id, status: 'pending' };
        },

        async getPendingCommands(deviceId) {
            return openAuth().prepare(
                "SELECT * FROM remote_commands WHERE device_id = ? AND status = 'pending' ORDER BY created_at ASC"
            ).all(deviceId);
        },

        async updateRemoteCommand(id, data) {
            const sets = [];
            const params = [];
            if (data.status) { sets.push('status = ?'); params.push(data.status); }
            if (data.result !== undefined) { sets.push('result = ?'); params.push(data.result); }
            if (data.status === 'running') { sets.push("executed_at = datetime('now')"); }
            if (data.status === 'completed' || data.status === 'failed') { sets.push("completed_at = datetime('now')"); }
            if (!sets.length) return;
            params.push(id);
            openAuth().prepare(`UPDATE remote_commands SET ${sets.join(', ')} WHERE id = ?`).run(...params);
        },

        async getRemoteCommands(filters = {}) {
            let sql = 'SELECT * FROM remote_commands WHERE 1=1';
            const params = [];
            if (filters.device_id) { sql += ' AND device_id = ?'; params.push(filters.device_id); }
            if (filters.status) { sql += ' AND status = ?'; params.push(filters.status); }
            sql += ' ORDER BY created_at DESC';
            if (filters.limit) { sql += ' LIMIT ?'; params.push(filters.limit); }
            return openAuth().prepare(sql).all(...params);
        },

        async getRemoteCommandById(id) {
            return openAuth().prepare('SELECT * FROM remote_commands WHERE id = ?').get(id) || null;
        },

        // ---- Activity monitoring ----

        async insertActivitySessions(deviceId, sessions) {
            const stmt = openMain().prepare(`
                INSERT INTO activity_sessions (device_id, app_name, window_title, category, started_at, ended_at, duration_secs)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            const tx = openMain().transaction((items) => {
                for (const s of items) {
                    stmt.run(deviceId, s.app_name || '', s.window_title || '', s.category || 'other',
                        s.started_at, s.ended_at, s.duration_secs || 0);
                }
            });
            tx(sessions);
        },

        async upsertActivitySummary(deviceId, data) {
            openMain().prepare(`
                INSERT INTO activity_summaries (device_id, idle_seconds, session_count, total_active_secs, reported_at, received_at)
                VALUES (?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(device_id, reported_at) DO UPDATE SET
                    idle_seconds = excluded.idle_seconds,
                    session_count = excluded.session_count,
                    total_active_secs = excluded.total_active_secs,
                    received_at = datetime('now')
            `).run(deviceId, data.idle_seconds ?? 0, data.session_count ?? 0,
                data.total_active_secs ?? 0, data.reported_at || new Date().toISOString());
        },

        async getActivitySessions(deviceId, { from, to, limit } = {}) {
            let sql = 'SELECT * FROM activity_sessions WHERE device_id = ?';
            const params = [deviceId];
            if (from) { sql += ' AND started_at >= ?'; params.push(from); }
            if (to) { sql += ' AND ended_at <= ?'; params.push(to); }
            sql += ' ORDER BY started_at DESC';
            if (limit) { sql += ' LIMIT ?'; params.push(limit); }
            return openMain().prepare(sql).all(...params);
        },

        async getActivitySummaries(deviceId, { from, to } = {}) {
            let sql = 'SELECT * FROM activity_summaries WHERE device_id = ?';
            const params = [deviceId];
            if (from) { sql += ' AND reported_at >= ?'; params.push(from); }
            if (to) { sql += ' AND reported_at <= ?'; params.push(to); }
            sql += ' ORDER BY reported_at DESC';
            return openMain().prepare(sql).all(...params);
        },

        async getAllActivitySummaries({ from, to } = {}) {
            let sql = `SELECT s.*, (
                SELECT COUNT(*) FROM activity_sessions a
                WHERE a.device_id = s.device_id
                  AND a.started_at >= s.reported_at
            ) as detail_count
            FROM activity_summaries s WHERE 1=1`;
            const params = [];
            if (from) { sql += ' AND s.reported_at >= ?'; params.push(from); }
            if (to) { sql += ' AND s.reported_at <= ?'; params.push(to); }
            sql += ' ORDER BY s.received_at DESC';
            return openMain().prepare(sql).all(...params);
        },

        async getTopApps(deviceId, { from, to, limit } = {}) {
            let sql = `SELECT app_name, category,
                SUM(duration_secs) as total_secs,
                COUNT(*) as session_count
            FROM activity_sessions WHERE device_id = ?`;
            const params = [deviceId];
            if (from) { sql += ' AND started_at >= ?'; params.push(from); }
            if (to) { sql += ' AND ended_at <= ?'; params.push(to); }
            sql += ' GROUP BY app_name ORDER BY total_secs DESC';
            if (limit) { sql += ' LIMIT ?'; params.push(limit || 10); }
            return openMain().prepare(sql).all(...params);
        },

        // ---- Relay sessions (enterprise) ----

        async createSession({ id, initiatorId, targetId, initiatorPk, expiresAt }) {
            openAuth().prepare(`
                INSERT INTO relay_sessions (id, initiator_id, target_id, initiator_pk, status, expires_at)
                VALUES (?, ?, ?, ?, 'pending', ?)
            `).run(id, initiatorId, targetId, initiatorPk || null, expiresAt);
        },
        async getSession(id) {
            return openAuth().prepare("SELECT * FROM relay_sessions WHERE id = ? AND expires_at > datetime('now')").get(id) || null;
        },
        async updateSession(id, data) {
            const sets = [];
            const params = [];
            if (data.status !== undefined) { sets.push('status = ?'); params.push(data.status); }
            if (data.target_pk !== undefined) { sets.push('target_pk = ?'); params.push(data.target_pk); }
            if (!sets.length) return;
            params.push(id);
            openAuth().prepare(`UPDATE relay_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
        },
        async deleteSession(id) {
            openAuth().prepare('DELETE FROM relay_sessions WHERE id = ?').run(id);
        },
        async cleanupExpiredSessions() {
            openAuth().prepare("DELETE FROM relay_sessions WHERE expires_at < datetime('now')").run();
        },

        // ---- Network monitoring ----

        async getNetworkTargets(filters = {}) {
            let sql = 'SELECT * FROM network_targets WHERE 1=1';
            const params = [];
            if (filters.enabled !== undefined) { sql += ' AND enabled = ?'; params.push(filters.enabled ? 1 : 0); }
            if (filters.check_type) { sql += ' AND check_type = ?'; params.push(filters.check_type); }
            sql += ' ORDER BY name';
            return openMain().prepare(sql).all(...params);
        },
        async getNetworkTargetById(id) {
            return openMain().prepare('SELECT * FROM network_targets WHERE id = ?').get(id) || null;
        },
        async createNetworkTarget(data) {
            const stmt = openMain().prepare(`
                INSERT INTO network_targets (name, host, port, url, check_type, timeout_ms, interval_ms, enabled)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const r = stmt.run(data.name, data.host, data.port, data.url, data.check_type,
                data.timeout_ms || 5000, data.interval_ms || 60000, data.enabled !== false ? 1 : 0);
            return this.getNetworkTargetById(r.lastInsertRowid);
        },
        async updateNetworkTarget(id, data) {
            const sets = [];
            const params = [];
            if (data.name !== undefined) { sets.push('name = ?'); params.push(data.name); }
            if (data.host !== undefined) { sets.push('host = ?'); params.push(data.host); }
            if (data.port !== undefined) { sets.push('port = ?'); params.push(data.port); }
            if (data.url !== undefined) { sets.push('url = ?'); params.push(data.url); }
            if (data.check_type !== undefined) { sets.push('check_type = ?'); params.push(data.check_type); }
            if (data.timeout_ms !== undefined) { sets.push('timeout_ms = ?'); params.push(data.timeout_ms); }
            if (data.interval_ms !== undefined) { sets.push('interval_ms = ?'); params.push(data.interval_ms); }
            if (data.enabled !== undefined) { sets.push('enabled = ?'); params.push(data.enabled ? 1 : 0); }
            if (data.last_status !== undefined) { sets.push('last_status = ?'); params.push(data.last_status); }
            if (data.last_check_at !== undefined) { sets.push('last_check_at = ?'); params.push(data.last_check_at); }
            if (data.last_rtt_ms !== undefined) { sets.push('last_rtt_ms = ?'); params.push(data.last_rtt_ms); }
            if (!sets.length) return null;
            sets.push("updated_at = datetime('now')");
            params.push(id);
            openMain().prepare(`UPDATE network_targets SET ${sets.join(', ')} WHERE id = ?`).run(...params);
            return this.getNetworkTargetById(id);
        },
        async deleteNetworkTarget(id) {
            const r = openMain().prepare('DELETE FROM network_targets WHERE id = ?').run(id);
            return r.changes > 0;
        },
        async insertNetworkCheck(data) {
            openMain().prepare(`
                INSERT INTO network_checks (target_id, status, rtt_ms, status_code, error_msg)
                VALUES (?, ?, ?, ?, ?)
            `).run(data.target_id, data.status, data.rtt_ms, data.status_code, data.error_msg);
        },
        async getNetworkCheckHistory(targetId, { limit, from, to } = {}) {
            let sql = 'SELECT * FROM network_checks WHERE target_id = ?';
            const params = [targetId];
            if (from) { sql += ' AND checked_at >= ?'; params.push(from); }
            if (to) { sql += ' AND checked_at <= ?'; params.push(to); }
            sql += ' ORDER BY checked_at DESC';
            if (limit) { sql += ' LIMIT ?'; params.push(limit); }
            return openMain().prepare(sql).all(...params);
        },

        // -- DataGuard / DLP -------------------------------------------------
        async getDlpPolicies() {
            return openMain().prepare('SELECT * FROM dlp_policies ORDER BY id').all();
        },
        async getDlpPolicyById(id) {
            return openMain().prepare('SELECT * FROM dlp_policies WHERE id = ?').get(id) || null;
        },
        async createDlpPolicy(data) {
            const r = openMain().prepare(`
                INSERT INTO dlp_policies (name, description, policy_type, action, scope, enabled, rules)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                data.name,
                data.description || '',
                data.policy_type || '',
                data.action || 'log',
                data.scope || '',
                data.enabled !== undefined ? (data.enabled ? 1 : 0) : 1,
                typeof data.rules === 'string' ? data.rules : JSON.stringify(data.rules || [])
            );
            return this.getDlpPolicyById(r.lastInsertRowid);
        },
        async updateDlpPolicy(id, data) {
            const sets = [];
            const params = [];
            if (data.name !== undefined) { sets.push('name = ?'); params.push(data.name); }
            if (data.description !== undefined) { sets.push('description = ?'); params.push(data.description); }
            if (data.policy_type !== undefined) { sets.push('policy_type = ?'); params.push(data.policy_type); }
            if (data.action !== undefined) { sets.push('action = ?'); params.push(data.action); }
            if (data.scope !== undefined) { sets.push('scope = ?'); params.push(data.scope); }
            if (data.enabled !== undefined) { sets.push('enabled = ?'); params.push(data.enabled ? 1 : 0); }
            if (data.rules !== undefined) {
                sets.push('rules = ?');
                params.push(typeof data.rules === 'string' ? data.rules : JSON.stringify(data.rules));
            }
            if (!sets.length) return null;
            sets.push("updated_at = datetime('now')");
            params.push(id);
            openMain().prepare(`UPDATE dlp_policies SET ${sets.join(', ')} WHERE id = ?`).run(...params);
            return this.getDlpPolicyById(id);
        },
        async deleteDlpPolicy(id) {
            const r = openMain().prepare('DELETE FROM dlp_policies WHERE id = ?').run(id);
            return r.changes > 0;
        },
        async insertDlpEvent(data) {
            const r = openMain().prepare(`
                INSERT INTO dlp_events (device_id, event_source, event_type, policy_id, policy_name, action, details)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                data.device_id,
                data.event_source || 'unknown',
                data.event_type || 'info',
                data.policy_id || null,
                data.policy_name || '',
                data.action || 'log',
                typeof data.details === 'string' ? data.details : JSON.stringify(data.details || {})
            );
            return { id: Number(r.lastInsertRowid) };
        },
        async getDlpEvents({ device_id, event_source, event_type, limit, from, to } = {}) {
            let sql = 'SELECT * FROM dlp_events WHERE 1=1';
            const params = [];
            if (device_id) { sql += ' AND device_id = ?'; params.push(device_id); }
            if (event_source) { sql += ' AND event_source = ?'; params.push(event_source); }
            if (event_type) { sql += ' AND event_type = ?'; params.push(event_type); }
            if (from) { sql += ' AND created_at >= ?'; params.push(from); }
            if (to) { sql += ' AND created_at <= ?'; params.push(to); }
            sql += ' ORDER BY created_at DESC';
            if (limit) { sql += ' LIMIT ?'; params.push(limit); }
            return openMain().prepare(sql).all(...params);
        },
        async getDlpEventStats() {
            const row = openMain().prepare(`
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN action = 'block' THEN 1 ELSE 0 END) AS blocked,
                    SUM(CASE WHEN action = 'log' THEN 1 ELSE 0 END) AS logged,
                    SUM(CASE WHEN event_source = 'usb' THEN 1 ELSE 0 END) AS usb_events,
                    SUM(CASE WHEN event_source = 'file' THEN 1 ELSE 0 END) AS file_events
                FROM dlp_events
            `).get();
            return row || { total: 0, blocked: 0, logged: 0, usb_events: 0, file_events: 0 };
        },

        // -- Saved Reports ----------------------------------------------------
        async getSavedReports() {
            return openMain().prepare('SELECT * FROM saved_reports ORDER BY created_at DESC').all();
        },
        async getSavedReportById(id) {
            return openMain().prepare('SELECT * FROM saved_reports WHERE id = ?').get(id) || null;
        },
        async createSavedReport(data) {
            const r = openMain().prepare(`
                INSERT INTO saved_reports (title, report_type, filters, payload, created_by)
                VALUES (?, ?, ?, ?, ?)
            `).run(data.title, data.report_type, data.filters || '{}', data.payload || '{}', data.created_by || 'admin');
            return this.getSavedReportById(r.lastInsertRowid);
        },
        async deleteSavedReport(id) {
            const r = openMain().prepare('DELETE FROM saved_reports WHERE id = ?').run(id);
            return r.changes > 0;
        },

        // -- Multi-Tenancy ----------------------------------------------------
        async getTenants() {
            return openMain().prepare('SELECT * FROM tenants ORDER BY name').all();
        },
        async getTenantById(id) {
            return openMain().prepare('SELECT * FROM tenants WHERE id = ?').get(id) || null;
        },
        async createTenant(data) {
            const r = openMain().prepare(`
                INSERT INTO tenants (name, slug, contact_name, contact_email, max_devices, notes, active)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                data.name, data.slug, data.contact_name || '', data.contact_email || '',
                data.max_devices || 0, data.notes || '', data.active !== undefined ? (data.active ? 1 : 0) : 1
            );
            return this.getTenantById(r.lastInsertRowid);
        },
        async updateTenant(id, data) {
            const sets = [];
            const params = [];
            if (data.name !== undefined) { sets.push('name = ?'); params.push(data.name); }
            if (data.slug !== undefined) { sets.push('slug = ?'); params.push(data.slug); }
            if (data.contact_name !== undefined) { sets.push('contact_name = ?'); params.push(data.contact_name); }
            if (data.contact_email !== undefined) { sets.push('contact_email = ?'); params.push(data.contact_email); }
            if (data.max_devices !== undefined) { sets.push('max_devices = ?'); params.push(data.max_devices); }
            if (data.notes !== undefined) { sets.push('notes = ?'); params.push(data.notes); }
            if (data.active !== undefined) { sets.push('active = ?'); params.push(data.active ? 1 : 0); }
            if (!sets.length) return this.getTenantById(id);
            sets.push("updated_at = datetime('now')");
            params.push(id);
            openMain().prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`).run(...params);
            return this.getTenantById(id);
        },
        async deleteTenant(id) {
            const r = openMain().prepare('DELETE FROM tenants WHERE id = ?').run(id);
            return r.changes > 0;
        },
        async getTenantDevices(tenantId) {
            const rows = openMain().prepare(`
                SELECT td.*, p.info, p.note, p.status_online, p.is_banned, p.ip, p.last_online
                FROM tenant_devices td
                LEFT JOIN peer p ON p.id = td.device_id AND (p.is_deleted = 0 OR p.is_deleted IS NULL)
                WHERE td.tenant_id = ?
                ORDER BY td.assigned_at DESC
            `).all(tenantId);
            return rows.map(r => ({
                device_id: r.device_id,
                assigned_at: r.assigned_at,
                online: r.status_online === 1,
                hostname: r.note || '',
                ip: r.ip || '',
            }));
        },
        async assignDeviceToTenant(tenantId, deviceId) {
            try {
                openMain().prepare(`
                    INSERT OR REPLACE INTO tenant_devices (tenant_id, device_id) VALUES (?, ?)
                `).run(tenantId, deviceId);
                return true;
            } catch (_) { return false; }
        },
        async removeDeviceFromTenant(tenantId, deviceId) {
            const r = openMain().prepare('DELETE FROM tenant_devices WHERE tenant_id = ? AND device_id = ?').run(tenantId, deviceId);
            return r.changes > 0;
        },
        async getTenantUsers(tenantId) {
            return openMain().prepare(`
                SELECT tu.user_id, tu.assigned_at
                FROM tenant_users tu
                WHERE tu.tenant_id = ?
                ORDER BY tu.assigned_at DESC
            `).all(tenantId);
        },
        async assignUserToTenant(tenantId, userId) {
            try {
                openMain().prepare(`
                    INSERT OR REPLACE INTO tenant_users (tenant_id, user_id) VALUES (?, ?)
                `).run(tenantId, userId);
                return true;
            } catch (_) { return false; }
        },
        async removeUserFromTenant(tenantId, userId) {
            const r = openMain().prepare('DELETE FROM tenant_users WHERE tenant_id = ? AND user_id = ?').run(tenantId, userId);
            return r.changes > 0;
        },

        // ---- Pending Registrations ----

        async getPendingRegistrations(filters = {}) {
            const db = openMain();
            let where = 'WHERE 1=1';
            const params = [];
            if (filters.status) { where += ' AND status = ?'; params.push(filters.status); }
            if (filters.search) {
                where += ' AND (device_id LIKE ? OR hostname LIKE ? OR ip_address LIKE ?)';
                const s = `%${filters.search}%`;
                params.push(s, s, s);
            }
            const order = 'ORDER BY created_at DESC';
            return db.prepare(`SELECT * FROM pending_registrations ${where} ${order}`).all(...params);
        },

        async getPendingRegistrationById(id) {
            return openMain().prepare('SELECT * FROM pending_registrations WHERE id = ?').get(id) || null;
        },

        async getPendingRegistrationByDeviceId(deviceId) {
            return openMain().prepare('SELECT * FROM pending_registrations WHERE device_id = ?').get(deviceId) || null;
        },

        async createPendingRegistration(data) {
            const db = openMain();
            // Upsert: if device already has a pending/rejected request, update it
            const existing = db.prepare('SELECT id, status FROM pending_registrations WHERE device_id = ?').get(data.device_id);
            if (existing) {
                if (existing.status === 'approved') {
                    // Already approved — return existing without changes
                    return db.prepare('SELECT * FROM pending_registrations WHERE id = ?').get(existing.id);
                }
                db.prepare(`
                    UPDATE pending_registrations
                    SET hostname = ?, platform = ?, version = ?, ip_address = ?, public_key = ?, uuid = ?,
                        status = 'pending', rejected_reason = '', updated_at = datetime('now')
                    WHERE id = ?
                `).run(data.hostname || '', data.platform || '', data.version || '', data.ip_address || '', data.public_key || '', data.uuid || '', existing.id);
                return db.prepare('SELECT * FROM pending_registrations WHERE id = ?').get(existing.id);
            }
            const r = db.prepare(`
                INSERT INTO pending_registrations (device_id, hostname, platform, version, ip_address, public_key, uuid)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(data.device_id, data.hostname || '', data.platform || '', data.version || '', data.ip_address || '', data.public_key || '', data.uuid || '');
            return db.prepare('SELECT * FROM pending_registrations WHERE id = ?').get(r.lastInsertRowid);
        },

        async approvePendingRegistration(id, approvedBy, serverConfig = {}) {
            const db = openMain();
            db.prepare(`
                UPDATE pending_registrations
                SET status = 'approved', approved_by = ?, approved_at = datetime('now'),
                    access_token = ?, console_url = ?, server_address = ?, server_key = ?,
                    updated_at = datetime('now')
                WHERE id = ? AND status = 'pending'
            `).run(
                approvedBy || 'admin',
                serverConfig.access_token || null,
                serverConfig.console_url || null,
                serverConfig.server_address || null,
                serverConfig.server_key || null,
                id
            );
            return db.prepare('SELECT * FROM pending_registrations WHERE id = ?').get(id) || null;
        },

        async rejectPendingRegistration(id, reason = '') {
            const db = openMain();
            db.prepare(`
                UPDATE pending_registrations
                SET status = 'rejected', rejected_reason = ?, updated_at = datetime('now')
                WHERE id = ? AND status = 'pending'
            `).run(reason, id);
            return db.prepare('SELECT * FROM pending_registrations WHERE id = ?').get(id) || null;
        },

        async deletePendingRegistration(id) {
            const r = openMain().prepare('DELETE FROM pending_registrations WHERE id = ?').run(id);
            return r.changes > 0;
        },

        async getPendingRegistrationCount() {
            const row = openMain().prepare("SELECT COUNT(*) as count FROM pending_registrations WHERE status = 'pending'").get();
            return row ? row.count : 0;
        },

        // ---- Peer Sysinfo ----

        async upsertPeerSysinfo(peerId, data) {
            openAuth().prepare(`
                INSERT INTO peer_sysinfo (peer_id, hostname, username, platform, version,
                    cpu_name, cpu_cores, cpu_freq_ghz, memory_gb, os_full,
                    displays, encoding, features, platform_additions, raw_json, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(peer_id) DO UPDATE SET
                    hostname = excluded.hostname, username = excluded.username,
                    platform = excluded.platform, version = excluded.version,
                    cpu_name = excluded.cpu_name, cpu_cores = excluded.cpu_cores,
                    cpu_freq_ghz = excluded.cpu_freq_ghz, memory_gb = excluded.memory_gb,
                    os_full = excluded.os_full, displays = excluded.displays,
                    encoding = excluded.encoding, features = excluded.features,
                    platform_additions = excluded.platform_additions,
                    raw_json = excluded.raw_json, updated_at = datetime('now')
            `).run(
                peerId,
                data.hostname || '', data.username || '', data.platform || '', data.version || '',
                data.cpu_name || '', data.cpu_cores || 0, data.cpu_freq_ghz || 0, data.memory_gb || 0,
                data.os_full || '',
                JSON.stringify(data.displays || []), JSON.stringify(data.encoding || []),
                JSON.stringify(data.features || {}), JSON.stringify(data.platform_additions || {}),
                JSON.stringify(data)
            );
        },

        async getPeerSysinfo(peerId) {
            const row = openAuth().prepare('SELECT * FROM peer_sysinfo WHERE peer_id = ?').get(peerId);
            if (!row) return null;
            return parseSysinfoRow(row);
        },

        async getAllPeerSysinfo() {
            return openAuth().prepare('SELECT * FROM peer_sysinfo').all().map(parseSysinfoRow);
        },

        // ---- Peer Metrics ----

        async updatePeerOnlineStatus(peerId) {
            openMain().prepare(
                "UPDATE peer SET status_online = 1, last_online = datetime('now') WHERE id = ?"
            ).run(peerId);
        },

        async cleanupStaleOnlinePeers(thresholdSeconds = 90) {
            const r = openMain().prepare(`
                UPDATE peer SET status_online = 0
                WHERE status_online = 1
                  AND last_online IS NOT NULL
                  AND last_online < datetime('now', '-' || ? || ' seconds')
            `).run(thresholdSeconds);
            return { changes: r.changes };
        },

        async insertPeerMetric(peerId, cpuUsage, memoryUsage, diskUsage) {
            openAuth().prepare(
                'INSERT INTO peer_metrics (peer_id, cpu_usage, memory_usage, disk_usage) VALUES (?, ?, ?, ?)'
            ).run(peerId, cpuUsage || 0, memoryUsage || 0, diskUsage || 0);
        },

        async getPeerMetrics(peerId, limit = 100) {
            return openAuth().prepare(
                'SELECT * FROM peer_metrics WHERE peer_id = ? ORDER BY created_at DESC LIMIT ?'
            ).all(peerId, limit);
        },

        async getLatestPeerMetric(peerId) {
            return openAuth().prepare(
                'SELECT * FROM peer_metrics WHERE peer_id = ? ORDER BY created_at DESC LIMIT 1'
            ).get(peerId) || null;
        },

        async cleanupOldMetrics(days = 7) {
            const safeDays = Math.max(1, parseInt(days, 10) || 7);
            openAuth().prepare(
                "DELETE FROM peer_metrics WHERE created_at < datetime('now', ? || ' days')"
            ).run(`-${safeDays}`);
        },

        // ---- Audit: Connections ----

        async insertAuditConnection(data) {
            openAuth().prepare(`
                INSERT INTO audit_connections (host_id, host_uuid, peer_id, peer_name, action, conn_type, session_id, ip)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(data.host_id || '', data.host_uuid || '', data.peer_id || '', data.peer_name || '',
                data.action || '', data.conn_type || 0, data.session_id || '', data.ip || '');
        },

        async getAuditConnections(filters = {}) {
            let sql = 'SELECT * FROM audit_connections WHERE 1=1';
            const params = [];
            if (filters.host_id) { sql += ' AND host_id = ?'; params.push(filters.host_id); }
            if (filters.peer_id) { sql += ' AND peer_id = ?'; params.push(filters.peer_id); }
            if (filters.action) { sql += ' AND action = ?'; params.push(filters.action); }
            sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
            params.push(filters.limit || 100, filters.offset || 0);
            return openAuth().prepare(sql).all(...params);
        },

        async countAuditConnections(filters = {}) {
            let sql = 'SELECT COUNT(*) as count FROM audit_connections WHERE 1=1';
            const params = [];
            if (filters.host_id) { sql += ' AND host_id = ?'; params.push(filters.host_id); }
            if (filters.peer_id) { sql += ' AND peer_id = ?'; params.push(filters.peer_id); }
            if (filters.action) { sql += ' AND action = ?'; params.push(filters.action); }
            return openAuth().prepare(sql).get(...params).count;
        },

        // ---- Audit: File Transfers ----

        async insertAuditFile(data) {
            openAuth().prepare(`
                INSERT INTO audit_files (host_id, host_uuid, peer_id, direction, path, is_file, num_files, files_json, ip, peer_name)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(data.host_id || '', data.host_uuid || '', data.peer_id || '',
                data.direction || 0, data.path || '', data.is_file !== undefined ? (data.is_file ? 1 : 0) : 1,
                data.num_files || 0, JSON.stringify(data.files || []), data.ip || '', data.peer_name || '');
        },

        async getAuditFiles(filters = {}) {
            let sql = 'SELECT * FROM audit_files WHERE 1=1';
            const params = [];
            if (filters.host_id) { sql += ' AND host_id = ?'; params.push(filters.host_id); }
            if (filters.peer_id) { sql += ' AND peer_id = ?'; params.push(filters.peer_id); }
            sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
            params.push(filters.limit || 100, filters.offset || 0);
            return openAuth().prepare(sql).all(...params);
        },

        async countAuditFiles(filters = {}) {
            let sql = 'SELECT COUNT(*) as count FROM audit_files WHERE 1=1';
            const params = [];
            if (filters.host_id) { sql += ' AND host_id = ?'; params.push(filters.host_id); }
            if (filters.peer_id) { sql += ' AND peer_id = ?'; params.push(filters.peer_id); }
            return openAuth().prepare(sql).get(...params).count;
        },

        // ---- Audit: Security Alarms ----

        async insertAuditAlarm(data) {
            openAuth().prepare(`
                INSERT INTO audit_alarms (alarm_type, alarm_name, host_id, peer_id, ip, details)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(data.alarm_type || 0, data.alarm_name || '', data.host_id || '',
                data.peer_id || '', data.ip || '',
                typeof data.details === 'string' ? data.details : JSON.stringify(data.details || {}));
        },

        async getAuditAlarms(filters = {}) {
            let sql = 'SELECT * FROM audit_alarms WHERE 1=1';
            const params = [];
            if (filters.alarm_type !== undefined) { sql += ' AND alarm_type = ?'; params.push(filters.alarm_type); }
            if (filters.host_id) { sql += ' AND host_id = ?'; params.push(filters.host_id); }
            sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
            params.push(filters.limit || 100, filters.offset || 0);
            return openAuth().prepare(sql).all(...params);
        },

        async countAuditAlarms(filters = {}) {
            let sql = 'SELECT COUNT(*) as count FROM audit_alarms WHERE 1=1';
            const params = [];
            if (filters.alarm_type !== undefined) { sql += ' AND alarm_type = ?'; params.push(filters.alarm_type); }
            if (filters.host_id) { sql += ' AND host_id = ?'; params.push(filters.host_id); }
            return openAuth().prepare(sql).get(...params).count;
        },

        // ---- User Groups ----

        async getAllUserGroups() {
            const groups = openAuth().prepare('SELECT * FROM user_groups ORDER BY name ASC').all();
            for (const group of groups) {
                group.member_count = openAuth().prepare('SELECT COUNT(*) as c FROM user_group_members WHERE user_group_id = ?').get(group.id).c;
            }
            return groups;
        },

        async getUserGroupByGuid(guid) {
            return openAuth().prepare('SELECT * FROM user_groups WHERE guid = ?').get(guid) || null;
        },

        async createUserGroup(data) {
            const crypto = require('crypto');
            const guid = data.guid || crypto.randomUUID();
            openAuth().prepare('INSERT INTO user_groups (guid, name, note, team_id) VALUES (?, ?, ?, ?)').run(
                guid, data.name, data.note || '', data.team_id || ''
            );
            return openAuth().prepare('SELECT * FROM user_groups WHERE guid = ?').get(guid);
        },

        async updateUserGroup(guid, data) {
            const sets = []; const params = [];
            if (data.name !== undefined) { sets.push('name = ?'); params.push(data.name); }
            if (data.note !== undefined) { sets.push('note = ?'); params.push(data.note); }
            if (data.team_id !== undefined) { sets.push('team_id = ?'); params.push(data.team_id); }
            if (!sets.length) return null;
            params.push(guid);
            openAuth().prepare(`UPDATE user_groups SET ${sets.join(', ')} WHERE guid = ?`).run(...params);
            return openAuth().prepare('SELECT * FROM user_groups WHERE guid = ?').get(guid);
        },

        async deleteUserGroup(guid) {
            const db = openAuth();
            const group = db.prepare('SELECT id FROM user_groups WHERE guid = ?').get(guid);
            if (!group) return;
            db.prepare('DELETE FROM user_group_members WHERE user_group_id = ?').run(group.id);
            db.prepare('DELETE FROM device_group_user_group_access WHERE user_group_id = ?').run(group.id);
            db.prepare('DELETE FROM user_groups WHERE guid = ?').run(guid);
        },

        async getUserGroupsForUser(userId) {
            return openAuth().prepare(`
                SELECT ug.* FROM user_groups ug
                INNER JOIN user_group_members ugm ON ug.id = ugm.user_group_id
                WHERE ugm.user_id = ?
                ORDER BY ug.name ASC
            `).all(userId);
        },

        async setUserGroupMemberships(userId, groupGuids = []) {
            const db = openAuth();
            const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
            if (!user) return [];
            const uniqueGuids = Array.from(new Set((groupGuids || []).map(v => String(v || '').trim()).filter(Boolean))).slice(0, 100);
            const tx = db.transaction((guids) => {
                db.prepare('DELETE FROM user_group_members WHERE user_id = ?').run(user.id);
                const insert = db.prepare('INSERT OR IGNORE INTO user_group_members (user_group_id, user_id) VALUES (?, ?)');
                const groupByGuid = db.prepare('SELECT id FROM user_groups WHERE guid = ?');
                for (const guid of guids) {
                    const group = groupByGuid.get(guid);
                    if (group) insert.run(group.id, user.id);
                }
            });
            tx(uniqueGuids);
            return this.getUserGroupsForUser(user.id);
        },

        // ---- Device Groups ----

        async getAllDeviceGroups() {
            const groups = openAuth().prepare('SELECT * FROM device_groups ORDER BY name ASC').all();
            for (const g of groups) {
                g.member_count = openAuth().prepare('SELECT COUNT(*) as c FROM device_group_members WHERE device_group_id = ?').get(g.id).c;
                g.source_type = g.source_type || 'manual';
                g.tag_filter = g.tag_filter || '';
                g.allowed_users = openAuth().prepare(`
                    SELECT u.username FROM device_group_user_access a
                    INNER JOIN users u ON u.id = a.user_id
                    WHERE a.device_group_id = ?
                    ORDER BY u.username ASC
                `).all(g.id).map(r => r.username);
                const allowedGroups = openAuth().prepare(`
                    SELECT ug.guid, ug.name FROM device_group_user_group_access a
                    INNER JOIN user_groups ug ON ug.id = a.user_group_id
                    WHERE a.device_group_id = ?
                    ORDER BY ug.name ASC
                `).all(g.id);
                g.allowed_groups = allowedGroups.map(r => r.guid);
                g.allowed_user_groups = allowedGroups;
            }
            return groups;
        },

        async getDeviceGroupByGuid(guid) {
            const group = openAuth().prepare('SELECT * FROM device_groups WHERE guid = ?').get(guid) || null;
            if (!group) return null;
            group.source_type = group.source_type || 'manual';
            group.tag_filter = group.tag_filter || '';
            group.allowed_users = openAuth().prepare(`
                SELECT u.username FROM device_group_user_access a
                INNER JOIN users u ON u.id = a.user_id
                WHERE a.device_group_id = ?
                ORDER BY u.username ASC
            `).all(group.id).map(r => r.username);
            const allowedGroups = openAuth().prepare(`
                SELECT ug.guid, ug.name FROM device_group_user_group_access a
                INNER JOIN user_groups ug ON ug.id = a.user_group_id
                WHERE a.device_group_id = ?
                ORDER BY ug.name ASC
            `).all(group.id);
            group.allowed_groups = allowedGroups.map(r => r.guid);
            group.allowed_user_groups = allowedGroups;
            return group;
        },

        async createDeviceGroup(data) {
            const crypto = require('crypto');
            const guid = data.guid || crypto.randomUUID();
            openAuth().prepare('INSERT INTO device_groups (guid, name, note, team_id, source_type, tag_filter) VALUES (?, ?, ?, ?, ?, ?)').run(
                guid,
                data.name,
                data.note || '',
                data.team_id || '',
                data.source_type === 'tag' ? 'tag' : 'manual',
                data.source_type === 'tag' ? (data.tag_filter || '') : ''
            );
            return openAuth().prepare('SELECT * FROM device_groups WHERE guid = ?').get(guid);
        },

        async updateDeviceGroup(guid, data) {
            const sets = []; const params = [];
            if (data.name !== undefined) { sets.push('name = ?'); params.push(data.name); }
            if (data.note !== undefined) { sets.push('note = ?'); params.push(data.note); }
            if (data.team_id !== undefined) { sets.push('team_id = ?'); params.push(data.team_id); }
            if (data.source_type !== undefined) { sets.push('source_type = ?'); params.push(data.source_type === 'tag' ? 'tag' : 'manual'); }
            if (data.tag_filter !== undefined) { sets.push('tag_filter = ?'); params.push(String(data.tag_filter || '').slice(0, 50)); }
            if (!sets.length) return null;
            params.push(guid);
            openAuth().prepare(`UPDATE device_groups SET ${sets.join(', ')} WHERE guid = ?`).run(...params);
            return openAuth().prepare('SELECT * FROM device_groups WHERE guid = ?').get(guid);
        },

        async deleteDeviceGroup(guid) {
            const db = openAuth();
            const group = db.prepare('SELECT id FROM device_groups WHERE guid = ?').get(guid);
            if (!group) return;
            db.prepare('DELETE FROM device_group_members WHERE device_group_id = ?').run(group.id);
            db.prepare('DELETE FROM device_group_user_access WHERE device_group_id = ?').run(group.id);
            db.prepare('DELETE FROM device_group_user_group_access WHERE device_group_id = ?').run(group.id);
            db.prepare('DELETE FROM device_groups WHERE guid = ?').run(guid);
        },

        async addDeviceToGroup(groupGuid, peerId) {
            const group = openAuth().prepare('SELECT id FROM device_groups WHERE guid = ?').get(groupGuid);
            if (!group) return null;
            openAuth().prepare('INSERT OR IGNORE INTO device_group_members (device_group_id, peer_id) VALUES (?, ?)').run(group.id, peerId);
        },

        async removeDeviceFromGroup(groupGuid, peerId) {
            const group = openAuth().prepare('SELECT id FROM device_groups WHERE guid = ?').get(groupGuid);
            if (!group) return null;
            openAuth().prepare('DELETE FROM device_group_members WHERE device_group_id = ? AND peer_id = ?').run(group.id, peerId);
        },

        async getDeviceGroupMembers(groupGuid) {
            const group = openAuth().prepare('SELECT id FROM device_groups WHERE guid = ?').get(groupGuid);
            if (!group) return [];
            return openAuth().prepare('SELECT peer_id FROM device_group_members WHERE device_group_id = ?').all(group.id).map(r => r.peer_id);
        },

        async getDeviceGroupsForPeer(peerId) {
            return openAuth().prepare(`
                SELECT dg.* FROM device_groups dg
                INNER JOIN device_group_members dgm ON dg.id = dgm.device_group_id
                WHERE dgm.peer_id = ?
                ORDER BY dg.name ASC
            `).all(peerId);
        },

        async setDeviceGroupUserAccess(groupGuid, usernames = []) {
            const db = openAuth();
            const group = db.prepare('SELECT id FROM device_groups WHERE guid = ?').get(groupGuid);
            if (!group) return null;
            const uniqueNames = Array.from(new Set((usernames || []).map(v => String(v || '').trim()).filter(Boolean)));
            const tx = db.transaction((names) => {
                db.prepare('DELETE FROM device_group_user_access WHERE device_group_id = ?').run(group.id);
                const insert = db.prepare('INSERT OR IGNORE INTO device_group_user_access (device_group_id, user_id) VALUES (?, ?)');
                const userByName = db.prepare('SELECT id FROM users WHERE username = ?');
                for (const username of names) {
                    const user = userByName.get(username);
                    if (user) insert.run(group.id, user.id);
                }
            });
            tx(uniqueNames);
            return this.getDeviceGroupByGuid(groupGuid);
        },

        async setDeviceGroupUserGroupAccess(groupGuid, groupGuids = []) {
            const db = openAuth();
            const group = db.prepare('SELECT id FROM device_groups WHERE guid = ?').get(groupGuid);
            if (!group) return null;
            const uniqueGuids = Array.from(new Set((groupGuids || []).map(v => String(v || '').trim()).filter(Boolean))).slice(0, 100);
            const tx = db.transaction((guids) => {
                db.prepare('DELETE FROM device_group_user_group_access WHERE device_group_id = ?').run(group.id);
                const insert = db.prepare('INSERT OR IGNORE INTO device_group_user_group_access (device_group_id, user_group_id) VALUES (?, ?)');
                const userGroupByGuid = db.prepare('SELECT id FROM user_groups WHERE guid = ?');
                for (const guid of guids) {
                    const userGroup = userGroupByGuid.get(guid);
                    if (userGroup) insert.run(group.id, userGroup.id);
                }
            });
            tx(uniqueGuids);
            return this.getDeviceGroupByGuid(groupGuid);
        },

        async getDeviceGroupAccessForUser(userId) {
            return openAuth().prepare(`
                SELECT DISTINCT dg.* FROM device_groups dg
                LEFT JOIN device_group_user_access a ON a.device_group_id = dg.id
                LEFT JOIN device_group_user_group_access ga ON ga.device_group_id = dg.id
                LEFT JOIN user_group_members ugm ON ugm.user_group_id = ga.user_group_id
                WHERE a.user_id = ? OR ugm.user_id = ?
                ORDER BY dg.name ASC
            `).all(userId, userId);
        },

        // ---- Strategies / Policies ----

        async getAllStrategies() {
            return openAuth().prepare('SELECT * FROM strategies ORDER BY name ASC').all().map(r => ({
                ...r, permissions: safeJsonParse(r.permissions, {})
            }));
        },

        async getStrategyByGuid(guid) {
            const row = openAuth().prepare('SELECT * FROM strategies WHERE guid = ?').get(guid);
            if (!row) return null;
            return { ...row, permissions: safeJsonParse(row.permissions, {}) };
        },

        async createStrategy(data) {
            const crypto = require('crypto');
            const guid = data.guid || crypto.randomUUID();
            openAuth().prepare(`
                INSERT INTO strategies (guid, name, user_group_guid, device_group_guid, enabled, permissions)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(guid, data.name, data.user_group_guid || '', data.device_group_guid || '',
                data.enabled !== undefined ? (data.enabled ? 1 : 0) : 1,
                JSON.stringify(data.permissions || {}));
            return this.getStrategyByGuid(guid);
        },

        async updateStrategy(guid, data) {
            const sets = []; const params = [];
            if (data.name !== undefined) { sets.push('name = ?'); params.push(data.name); }
            if (data.user_group_guid !== undefined) { sets.push('user_group_guid = ?'); params.push(data.user_group_guid); }
            if (data.device_group_guid !== undefined) { sets.push('device_group_guid = ?'); params.push(data.device_group_guid); }
            if (data.enabled !== undefined) { sets.push('enabled = ?'); params.push(data.enabled ? 1 : 0); }
            if (data.permissions !== undefined) { sets.push('permissions = ?'); params.push(JSON.stringify(data.permissions)); }
            if (!sets.length) return null;
            sets.push("updated_at = datetime('now')");
            params.push(guid);
            openAuth().prepare(`UPDATE strategies SET ${sets.join(', ')} WHERE guid = ?`).run(...params);
            return this.getStrategyByGuid(guid);
        },

        async deleteStrategy(guid) {
            openAuth().prepare('DELETE FROM strategy_assignments WHERE strategy_guid = ?').run(guid);
            openAuth().prepare('DELETE FROM strategies WHERE guid = ?').run(guid);
        },

        _ensurePeerGuidColumnSqlite(db) {
            try {
                const cols = new Set(db.prepare('PRAGMA table_info(peers)').all().map(c => c.name));
                if (cols.size > 0 && !cols.has('guid')) {
                    db.exec("ALTER TABLE peers ADD COLUMN guid TEXT DEFAULT ''");
                }
            } catch (_) { /* peers table may not exist yet */ }
        },

        _ensurePeerGuidSqlite(peerId) {
            const db = openMain();
            this._ensurePeerGuidColumnSqlite(db);
            let row = db.prepare(`SELECT id, COALESCE(uuid, '') AS uuid, COALESCE(guid, '') AS guid FROM peers WHERE id = ?`).get(peerId);
            if (!row) return null;
            if (row.guid) return row.guid;
            const crypto = require('crypto');
            const isUuid = (s) => typeof s === 'string' && s.length === 36 && (s.match(/-/g) || []).length === 4;
            const guid = isUuid(row.uuid) ? row.uuid.toLowerCase() : crypto.randomUUID();
            db.prepare('UPDATE peers SET guid = ? WHERE id = ?').run(guid, peerId);
            return guid;
        },

        async resolvePeerAssignmentKey(ref) {
            const key = String(ref || '').trim();
            if (!key) throw new Error('empty peer reference');
            const db = openMain();
            this._ensurePeerGuidColumnSqlite(db);
            const row = db.prepare(`
                SELECT id FROM peers
                WHERE id = ? OR guid = ? OR uuid = ?
                LIMIT 1
            `).get(key, key, key);
            if (!row) throw new Error('peer not found');
            const guid = this._ensurePeerGuidSqlite(row.id);
            if (!guid) throw new Error('peer not found');
            return guid;
        },

        async resolveUserAssignmentKey(ref) {
            const key = String(ref || '').trim();
            if (!key) throw new Error('empty user reference');
            const row = openAuth().prepare(`
                SELECT id, COALESCE(guid, '') AS guid FROM users
                WHERE guid = ? OR username = ? OR CAST(id AS TEXT) = ?
                LIMIT 1
            `).get(key, key, key);
            if (!row) throw new Error('user not found');
            if (row.guid) return row.guid;
            const crypto = require('crypto');
            const guid = crypto.randomUUID();
            openAuth().prepare('UPDATE users SET guid = ? WHERE id = ?').run(guid, row.id);
            return guid;
        },

        async resolveDeviceGroupAssignmentKey(ref) {
            const key = String(ref || '').trim();
            if (!key) throw new Error('empty device group reference');
            const row = openAuth().prepare(`
                SELECT guid FROM device_groups WHERE guid = ? OR name = ? LIMIT 1
            `).get(key, key);
            if (!row) throw new Error('device group not found');
            return row.guid;
        },

        async assignStrategy(strategyGuid, { peers = [], users = [], groups = [] } = {}) {
            strategyGuid = String(strategyGuid || '').trim();
            if (strategyGuid) {
                const st = await this.getStrategyByGuid(strategyGuid);
                if (!st) throw new Error('strategy not found');
            }
            const auth = openAuth();
            const upsert = (targetType, keys) => {
                for (const raw of keys) {
                    const targetKey = String(raw || '').trim();
                    if (!targetKey) continue;
                    if (!strategyGuid) {
                        auth.prepare('DELETE FROM strategy_assignments WHERE target_type = ? AND target_key = ?')
                            .run(targetType, targetKey);
                        continue;
                    }
                    auth.prepare(`
                        INSERT INTO strategy_assignments (target_type, target_key, strategy_guid, updated_at)
                        VALUES (?, ?, ?, datetime('now'))
                        ON CONFLICT(target_type, target_key) DO UPDATE SET
                            strategy_guid = excluded.strategy_guid,
                            updated_at = excluded.updated_at
                    `).run(targetType, targetKey, strategyGuid);
                }
            };
            upsert('peer', peers);
            upsert('user', users);
            upsert('device_group', groups);
        },

        async getStrategyAssignmentSummary(strategyGuid) {
            const rows = openAuth().prepare(`
                SELECT target_type, target_key FROM strategy_assignments
                WHERE strategy_guid = ? ORDER BY target_type, target_key
            `).all(strategyGuid);
            const summary = { peer_count: 0, user_count: 0, device_group_count: 0, peers: [], users: [], groups: [] };
            for (const row of rows) {
                if (row.target_type === 'peer') { summary.peer_count++; summary.peers.push(row.target_key); }
                else if (row.target_type === 'user') { summary.user_count++; summary.users.push(row.target_key); }
                else if (row.target_type === 'device_group') { summary.device_group_count++; summary.groups.push(row.target_key); }
            }
            return summary;
        },

        async getStrategyAssignmentDisplayRefs(strategyGuid) {
            const summary = await this.getStrategyAssignmentSummary(strategyGuid);
            const peerIds = [];
            const userNames = [];
            try {
                const db = openMain();
                this._ensurePeerGuidColumnSqlite(db);
                for (const guid of summary.peers) {
                    const row = db.prepare('SELECT id FROM peers WHERE guid = ? LIMIT 1').get(guid);
                    if (row) peerIds.push(row.id);
                }
            } catch (_) {}
            for (const guid of summary.users) {
                const row = openAuth().prepare('SELECT username FROM users WHERE guid = ? LIMIT 1').get(guid);
                if (row?.username) userNames.push(row.username);
            }
            return {
                ...summary,
                peer_ids: peerIds,
                user_names: userNames,
                group_guids: summary.groups,
            };
        },

        async getUserStrategyGuid(userId) {
            const userGuid = await this.ensureUserGuid(userId);
            if (!userGuid) return '';
            const row = openAuth().prepare(`
                SELECT strategy_guid FROM strategy_assignments
                WHERE target_type = 'user' AND target_key = ?
                LIMIT 1
            `).get(userGuid);
            return row?.strategy_guid || '';
        },

        async setUserStrategyAssignment(userId, strategyGuid) {
            const userGuid = await this.ensureUserGuid(userId);
            if (!userGuid) throw new Error('user not found');
            strategyGuid = String(strategyGuid || '').trim();
            if (!strategyGuid) {
                openAuth().prepare(`
                    DELETE FROM strategy_assignments WHERE target_type = 'user' AND target_key = ?
                `).run(userGuid);
                return '';
            }
            const st = await this.getStrategyByGuid(strategyGuid);
            if (!st) throw new Error('strategy not found');
            openAuth().prepare(`
                INSERT INTO strategy_assignments (target_type, target_key, strategy_guid, updated_at)
                VALUES ('user', ?, ?, datetime('now'))
                ON CONFLICT(target_type, target_key) DO UPDATE SET
                    strategy_guid = excluded.strategy_guid,
                    updated_at = excluded.updated_at
            `).run(userGuid, strategyGuid);
            return strategyGuid;
        },

        async getUserPeerGrants(userId) {
            const rows = openAuth().prepare(`
                SELECT peer_id FROM user_peer_grants WHERE user_id = ? ORDER BY peer_id ASC
            `).all(userId);
            return rows.map(r => r.peer_id);
        },

        async setUserPeerGrants(userId, peerIds = []) {
            const auth = openAuth();
            const normalized = Array.from(new Set(
                (peerIds || []).map(id => String(id || '').trim()).filter(Boolean)
            )).slice(0, 500);
            auth.prepare('DELETE FROM user_peer_grants WHERE user_id = ?').run(userId);
            const insert = auth.prepare(`
                INSERT INTO user_peer_grants (user_id, peer_id) VALUES (?, ?)
            `);
            auth.transaction((ids) => {
                for (const peerId of ids) insert.run(userId, peerId);
            })(normalized);
            return normalized;
        },

        async setStrategyEnabled(guid, enabled) {
            const row = await this.updateStrategy(guid, { enabled: !!enabled });
            if (!row) throw new Error('strategy not found');
            return row;
        },

        // ---- Folder batch operations ----

        async assignDevicesToFolder(deviceIds, folderId) {
            const db = openAuth();
            if (folderId === null || folderId === undefined) {
                const stmt = db.prepare('DELETE FROM device_folder_assignments WHERE device_id = ?');
                db.transaction((ids) => { for (const id of ids) stmt.run(id); })(deviceIds);
            } else {
                const stmt = db.prepare(`
                    INSERT INTO device_folder_assignments (device_id, folder_id) VALUES (?, ?)
                    ON CONFLICT(device_id) DO UPDATE SET folder_id = ?, assigned_at = datetime('now')
                `);
                db.transaction((ids) => { for (const id of ids) stmt.run(id, folderId, folderId); })(deviceIds);
            }
        },

        async unassignDevicesFromFolder(folderId) {
            openAuth().prepare('DELETE FROM device_folder_assignments WHERE folder_id = ?').run(folderId);
        },

        async getUnassignedDeviceCount() {
            // Note: When using Go server, the peer count comes from Go server API (peers table)
            // This function will return -1 if the local 'peer' table doesn't exist
            // The UI should handle -1 by fetching count from serverBackend instead
            try {
                // Try 'peers' first (Go server schema), then 'peer' (legacy schema)
                let total = 0;
                try {
                    total = openMain().prepare('SELECT COUNT(*) as count FROM peers WHERE NOT is_deleted').get().count;
                } catch {
                    total = openMain().prepare('SELECT COUNT(*) as count FROM peer WHERE is_deleted = 0').get().count;
                }
                const assigned = openAuth().prepare('SELECT COUNT(*) as count FROM device_folder_assignments').get().count;
                return Math.max(0, total - assigned);
            } catch { return -1; }
        },

        async getAllFolderAssignments() {
            const rows = openAuth().prepare('SELECT device_id, folder_id FROM device_folder_assignments').all();
            const map = {};
            for (const row of rows) {
                const folderId = Number(row.folder_id);
                map[row.device_id] = Number.isFinite(folderId) ? folderId : row.folder_id;
            }
            return map;
        },

        // ---- Address Book Tags ----

        async getAddressBookTags(userId) {
            const db = openAuth();
            const row = usesUsernameAddressBooks(db)
                ? (() => {
                    const username = usernameForUserId(db, userId);
                    return username
                        ? db.prepare('SELECT data FROM address_books WHERE username = ? AND ab_type = ?').get(username, 'legacy')
                        : null;
                })()
                : db.prepare('SELECT data FROM address_books WHERE user_id = ? AND ab_type = ?').get(userId, 'legacy');
            if (!row) return [];
            try { return JSON.parse(row.data).tags || []; } catch { return []; }
        },

        // ---- Login Cleanup ----

        async cleanupOldLoginAttempts() {
            openAuth().prepare("DELETE FROM login_attempts WHERE created_at < datetime('now', '-24 hours')").run();
        },

        // ---- User Admin ----

        async resetAdminPassword(passwordHash) {
            const admin = openAuth().prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
            if (admin) {
                openAuth().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, admin.id);
                return admin;
            }
            return null;
        },

        async deleteAllUsers() {
            openAuth().prepare('DELETE FROM users').run();
        },

        // ---- Count Devices ----

        async countDevices(filters = {}) {
            const db = openMain();
            let sql = 'SELECT COUNT(*) as count FROM peer WHERE is_deleted = 0';
            const params = [];
            if (filters.search) {
                sql += " AND (id LIKE ? ESCAPE '\\' OR \"user\" LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')";
                const s = `%${escapeLikePattern(filters.search)}%`;
                params.push(s, s, s);
            }
            if (filters.status === 'online') sql += ' AND status_online = 1';
            else if (filters.status === 'offline') sql += ' AND status_online = 0';
            else if (filters.status === 'banned') sql += ' AND is_banned = 1';
            if (filters.hasNotes) sql += " AND note IS NOT NULL AND note != ''";
            return db.prepare(sql).get(...params).count;
        },

        // ---- Agent installer bundles (Generator) ----

        async listAgentBundles({ includeRevoked = false } = {}) {
            const db = openMain();
            const where = includeRevoked ? '' : 'WHERE revoked = 0';
            return db.prepare(`SELECT * FROM agent_bundles ${where} ORDER BY created_at DESC`).all();
        },

        async getAgentBundle(bundleId) {
            return openMain().prepare('SELECT * FROM agent_bundles WHERE bundle_id = ?').get(bundleId) || null;
        },

        async getAgentBundleByPublicId(publicId) {
            return openMain().prepare(`
                SELECT * FROM agent_bundles WHERE slug = ? OR bundle_id = ? LIMIT 1
            `).get(publicId, publicId) || null;
        },

        async isAgentBundleSlugTaken(slug, excludeBundleId = null) {
            if (!slug) return false;
            const row = openMain().prepare(`
                SELECT bundle_id FROM agent_bundles WHERE slug = ? LIMIT 1
            `).get(slug);
            if (!row) return false;
            return excludeBundleId ? row.bundle_id !== excludeBundleId : true;
        },

        async createAgentBundle({ bundleId, slug, name, branding, brandingHash, createdBy, productType }) {
            const db = openMain();
            const r = db.prepare(`
                INSERT INTO agent_bundles (bundle_id, slug, name, branding, branding_hash, created_by, product_type)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(bundleId, slug || null, name, branding, brandingHash, createdBy || null, productType || 'agent');
            return db.prepare('SELECT * FROM agent_bundles WHERE id = ?').get(r.lastInsertRowid);
        },

        async updateAgentBundle(bundleId, { name, slug, branding, brandingHash }) {
            const db = openMain();
            db.prepare(`
                UPDATE agent_bundles
                SET name = ?, slug = ?, branding = ?, branding_hash = ?, updated_at = datetime('now')
                WHERE bundle_id = ?
            `).run(name, slug || null, branding, brandingHash, bundleId);
            return db.prepare('SELECT * FROM agent_bundles WHERE bundle_id = ?').get(bundleId) || null;
        },

        async setAgentBundleRevoked(bundleId, revoked) {
            const db = openMain();
            db.prepare(`
                UPDATE agent_bundles SET revoked = ?, updated_at = datetime('now') WHERE bundle_id = ?
            `).run(revoked ? 1 : 0, bundleId);
            return db.prepare('SELECT * FROM agent_bundles WHERE bundle_id = ?').get(bundleId) || null;
        },

        async deleteAgentBundle(bundleId) {
            const r = openMain().prepare('DELETE FROM agent_bundles WHERE bundle_id = ?').run(bundleId);
            return r.changes > 0;
        },

        async incrementAgentBundleDownload(bundleId) {
            openMain().prepare(`
                UPDATE agent_bundles SET download_count = download_count + 1, updated_at = datetime('now')
                WHERE bundle_id = ?
            `).run(bundleId);
        },

        async listAgentBundleBuildsForHash(brandingHash) {
            return openMain().prepare(
                'SELECT * FROM agent_bundle_builds WHERE branding_hash = ? ORDER BY platform, arch, format'
            ).all(brandingHash);
        },

        async getAgentBundleBuild({ brandingHash, platform, arch, format }) {
            return openMain().prepare(`
                SELECT * FROM agent_bundle_builds
                WHERE branding_hash = ? AND platform = ? AND arch = ? AND format = ?
            `).get(brandingHash, platform, arch, format) || null;
        },

        async upsertAgentBundleBuild({ brandingHash, platform, arch, format, status, artifactPath, artifactSize, artifactSha256, errorMessage }) {
            const db = openMain();
            const ts = (status === 'building') ? "datetime('now')" : 'started_at';
            const finishTs = (status === 'ready' || status === 'failed') ? "datetime('now')" : 'finished_at';
            db.prepare(`
                INSERT INTO agent_bundle_builds (
                    branding_hash, platform, arch, format, status,
                    artifact_path, artifact_size, artifact_sha256, error_message,
                    started_at, finished_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${status === 'building' ? "datetime('now')" : 'NULL'}, ${status === 'ready' || status === 'failed' ? "datetime('now')" : 'NULL'})
                ON CONFLICT(branding_hash, platform, arch, format) DO UPDATE SET
                    status = excluded.status,
                    artifact_path = COALESCE(excluded.artifact_path, agent_bundle_builds.artifact_path),
                    artifact_size = COALESCE(excluded.artifact_size, agent_bundle_builds.artifact_size),
                    artifact_sha256 = COALESCE(excluded.artifact_sha256, agent_bundle_builds.artifact_sha256),
                    error_message = excluded.error_message,
                    started_at = CASE WHEN excluded.status = 'building' THEN datetime('now') ELSE agent_bundle_builds.started_at END,
                    finished_at = CASE WHEN excluded.status IN ('ready','failed') THEN datetime('now') ELSE agent_bundle_builds.finished_at END,
                    updated_at = datetime('now')
            `).run(
                brandingHash, platform, arch, format, status,
                artifactPath || null, artifactSize || 0, artifactSha256 || null, errorMessage || ''
            );
            return this.getAgentBundleBuild({ brandingHash, platform, arch, format });
        },

        // ---- Integration Housekeeping ----

        async runIntegrationHousekeeping() {
            const db = openAuth();
            db.prepare("DELETE FROM peer_metrics WHERE created_at < datetime('now', '-7 days')").run();
            db.prepare("DELETE FROM audit_connections WHERE created_at < datetime('now', '-90 days')").run();
            db.prepare("DELETE FROM audit_files WHERE created_at < datetime('now', '-90 days')").run();
            db.prepare("DELETE FROM audit_alarms WHERE created_at < datetime('now', '-90 days')").run();
        },
    };
}

// =========================================================================
//  PostgreSQL adapter
// =========================================================================

function createPostgresAdapter() {
    const { Pool } = getPgDriver();
    let pool = null;

    function getPool() {
        if (!pool) {
            pool = new Pool({ connectionString: DATABASE_URL, max: 20, idleTimeoutMillis: 30000 });
            pool.on('error', (err) => console.error('[DB/PG] Idle client error:', err.message));
        }
        return pool;
    }

    /** Run a single-statement query. */
    async function q(text, params = []) {
        return getPool().query(text, params);
    }

    /** Get a single row or null. */
    async function one(text, params = []) {
        const { rows } = await q(text, params);
        return rows[0] || null;
    }

    /** Get all rows. */
    async function all(text, params = []) {
        const { rows } = await q(text, params);
        return rows;
    }

    // ---- Schema bootstrap ----

    async function ensureSchema() {
        await q(`
            CREATE TABLE IF NOT EXISTS peer (
                id TEXT PRIMARY KEY,
                uuid TEXT DEFAULT '',
                pk BYTEA,
                note TEXT DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                status_online BOOLEAN DEFAULT FALSE,
                last_online TIMESTAMPTZ,
                is_deleted BOOLEAN DEFAULT FALSE,
                info JSONB DEFAULT '{}',
                ip TEXT DEFAULT '',
                "user" TEXT DEFAULT '',
                is_banned BOOLEAN DEFAULT FALSE,
                banned_at TIMESTAMPTZ,
                banned_reason TEXT DEFAULT '',
                folder_id INTEGER DEFAULT NULL
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT DEFAULT 'admin',
                auth_provider TEXT DEFAULT 'local',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                last_login TIMESTAMPTZ,
                preferred_language TEXT DEFAULT NULL,
                totp_secret TEXT DEFAULT NULL,
                totp_enabled BOOLEAN DEFAULT FALSE,
                totp_recovery_codes TEXT DEFAULT NULL
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS audit_log (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                action TEXT NOT NULL,
                details TEXT,
                ip_address TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await q('CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at)');
        await q('CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action, created_at)');

        await q(`
            CREATE TABLE IF NOT EXISTS access_tokens (
                id SERIAL PRIMARY KEY,
                token TEXT UNIQUE NOT NULL,
                token_hash TEXT,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                client_id TEXT DEFAULT '',
                client_uuid TEXT DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                expires_at TIMESTAMPTZ NOT NULL,
                last_used TIMESTAMPTZ,
                ip_address TEXT DEFAULT '',
                revoked BOOLEAN DEFAULT FALSE
            )
        `);
        await q(`ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS token_hash TEXT`);
        await q(`CREATE UNIQUE INDEX IF NOT EXISTS idx_access_tokens_hash ON access_tokens (token_hash)
            WHERE token_hash IS NOT NULL`);
        const legacyTokens = await all(`
            SELECT id, token FROM access_tokens
            WHERE (token_hash IS NULL OR token_hash = '') AND token <> ''
        `);
        for (const row of legacyTokens) {
            await q('UPDATE access_tokens SET token_hash = $1 WHERE id = $2', [hashAccessToken(row.token), row.id]);
        }

        await q(`
            CREATE TABLE IF NOT EXISTS login_attempts (
                id SERIAL PRIMARY KEY,
                username TEXT NOT NULL,
                ip_address TEXT DEFAULT '',
                success BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS account_lockouts (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                locked_until TIMESTAMPTZ NOT NULL,
                attempt_count INTEGER DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS folders (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                color TEXT DEFAULT '#6366f1',
                icon TEXT DEFAULT 'folder',
                sort_order INTEGER DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS address_books (
                username TEXT NOT NULL,
                ab_type TEXT NOT NULL DEFAULT 'legacy',
                data TEXT NOT NULL DEFAULT '{}',
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (username, ab_type)
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS notification_reads (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                notification_id TEXT NOT NULL,
                read_at TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (user_id, notification_id)
            )
        `);
        await q('CREATE INDEX IF NOT EXISTS idx_notification_reads_user ON notification_reads (user_id, read_at)');

        await q(`
            CREATE TABLE IF NOT EXISTS email_notification_log (
                id SERIAL PRIMARY KEY,
                event_type TEXT NOT NULL,
                event_id TEXT NOT NULL,
                recipient TEXT NOT NULL,
                sent_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(event_type, event_id, recipient)
            )
        `);
        await q('CREATE INDEX IF NOT EXISTS idx_email_notification_log_event ON email_notification_log (event_type, event_id)');

        await q(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS branding_config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS branding_profiles (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                description TEXT DEFAULT '',
                data TEXT NOT NULL,
                is_active INTEGER DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS relay_sessions (
                id TEXT PRIMARY KEY,
                initiator_id TEXT NOT NULL,
                target_id TEXT NOT NULL,
                initiator_pk TEXT,
                target_pk TEXT,
                status TEXT DEFAULT 'pending',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                expires_at TIMESTAMPTZ NOT NULL
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS device_inventory (
                id SERIAL PRIMARY KEY,
                device_id TEXT NOT NULL UNIQUE,
                hardware JSONB DEFAULT '{}',
                software JSONB DEFAULT '{}',
                collected_at TIMESTAMPTZ,
                received_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS device_telemetry (
                id SERIAL PRIMARY KEY,
                device_id TEXT NOT NULL UNIQUE,
                cpu_usage_percent REAL DEFAULT 0,
                memory_used_bytes BIGINT DEFAULT 0,
                memory_total_bytes BIGINT DEFAULT 0,
                uptime_secs INTEGER DEFAULT 0,
                timestamp TIMESTAMPTZ,
                received_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS tickets (
                id SERIAL PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT DEFAULT '',
                status TEXT DEFAULT 'open',
                priority TEXT DEFAULT 'medium',
                category TEXT DEFAULT 'general',
                device_id TEXT DEFAULT NULL,
                created_by TEXT NOT NULL,
                assigned_to TEXT DEFAULT NULL,
                sla_due_at TIMESTAMPTZ DEFAULT NULL,
                resolved_at TIMESTAMPTZ DEFAULT NULL,
                closed_at TIMESTAMPTZ DEFAULT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS ticket_comments (
                id SERIAL PRIMARY KEY,
                ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
                author TEXT NOT NULL,
                body TEXT NOT NULL,
                is_internal BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS ticket_attachments (
                id SERIAL PRIMARY KEY,
                ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
                filename TEXT NOT NULL,
                mimetype TEXT DEFAULT 'application/octet-stream',
                size_bytes INTEGER DEFAULT 0,
                storage_path TEXT NOT NULL,
                uploaded_by TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS activity_sessions (
                id SERIAL PRIMARY KEY,
                device_id TEXT NOT NULL,
                app_name TEXT NOT NULL DEFAULT '',
                window_title TEXT NOT NULL DEFAULT '',
                category TEXT DEFAULT 'other',
                started_at TIMESTAMPTZ NOT NULL,
                ended_at TIMESTAMPTZ NOT NULL,
                duration_secs INTEGER DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS activity_summaries (
                id SERIAL PRIMARY KEY,
                device_id TEXT NOT NULL,
                idle_seconds INTEGER DEFAULT 0,
                session_count INTEGER DEFAULT 0,
                total_active_secs INTEGER DEFAULT 0,
                reported_at TIMESTAMPTZ NOT NULL,
                received_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(device_id, reported_at)
            )
        `);

        // Alert rules & automation tables
        await q(`
            CREATE TABLE IF NOT EXISTS alert_rules (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                enabled BOOLEAN DEFAULT TRUE,
                condition_type TEXT NOT NULL,
                condition_op TEXT NOT NULL DEFAULT 'gt',
                condition_value REAL NOT NULL DEFAULT 0,
                severity TEXT DEFAULT 'warning',
                scope_device_id TEXT DEFAULT NULL,
                cooldown_secs INTEGER DEFAULT 300,
                notify_emails TEXT DEFAULT '',
                created_by TEXT DEFAULT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS alert_history (
                id SERIAL PRIMARY KEY,
                rule_id INTEGER NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
                device_id TEXT DEFAULT NULL,
                severity TEXT DEFAULT 'warning',
                message TEXT NOT NULL DEFAULT '',
                triggered_at TIMESTAMPTZ NOT NULL,
                acknowledged BOOLEAN DEFAULT FALSE,
                acknowledged_by TEXT DEFAULT NULL,
                acknowledged_at TIMESTAMPTZ DEFAULT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS remote_commands (
                id SERIAL PRIMARY KEY,
                device_id TEXT NOT NULL,
                command_type TEXT NOT NULL DEFAULT 'shell',
                payload TEXT NOT NULL DEFAULT '',
                status TEXT DEFAULT 'pending',
                result TEXT DEFAULT NULL,
                created_by TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                executed_at TIMESTAMPTZ DEFAULT NULL,
                completed_at TIMESTAMPTZ DEFAULT NULL
            )
        `);

        // Network monitoring tables
        await q(`
            CREATE TABLE IF NOT EXISTS network_targets (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                host TEXT DEFAULT '',
                port INTEGER DEFAULT NULL,
                url TEXT DEFAULT NULL,
                check_type TEXT NOT NULL DEFAULT 'ping',
                timeout_ms INTEGER DEFAULT 5000,
                interval_ms INTEGER DEFAULT 60000,
                enabled BOOLEAN DEFAULT TRUE,
                last_status TEXT DEFAULT NULL,
                last_check_at TIMESTAMPTZ DEFAULT NULL,
                last_rtt_ms REAL DEFAULT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS network_checks (
                id SERIAL PRIMARY KEY,
                target_id INTEGER NOT NULL REFERENCES network_targets(id) ON DELETE CASCADE,
                status TEXT NOT NULL DEFAULT 'unknown',
                rtt_ms REAL DEFAULT NULL,
                status_code INTEGER DEFAULT NULL,
                error_msg TEXT DEFAULT NULL,
                checked_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        // Create indexes
        await q('CREATE INDEX IF NOT EXISTS idx_peer_online ON peer (status_online) WHERE NOT is_deleted');
        await q('CREATE INDEX IF NOT EXISTS idx_peer_deleted ON peer (is_deleted)');
        await q('CREATE INDEX IF NOT EXISTS idx_token_lookup ON access_tokens (token) WHERE NOT revoked');
        await q('CREATE INDEX IF NOT EXISTS idx_token_hash_lookup ON access_tokens (token_hash) WHERE NOT revoked');
        await q('CREATE INDEX IF NOT EXISTS idx_relay_sessions_expires ON relay_sessions (expires_at)');
        await q('CREATE INDEX IF NOT EXISTS idx_activity_device ON activity_sessions (device_id)');
        await q('CREATE INDEX IF NOT EXISTS idx_activity_time ON activity_sessions (started_at)');
        await q('CREATE INDEX IF NOT EXISTS idx_alert_history_rule ON alert_history (rule_id)');
        await q('CREATE INDEX IF NOT EXISTS idx_alert_history_device ON alert_history (device_id)');
        await q('CREATE INDEX IF NOT EXISTS idx_remote_commands_device ON remote_commands (device_id, status)');
        await q('CREATE INDEX IF NOT EXISTS idx_network_checks_target ON network_checks (target_id)');
        await q('CREATE INDEX IF NOT EXISTS idx_network_checks_time ON network_checks (checked_at)');

        // DataGuard / DLP tables
        await q(`
            CREATE TABLE IF NOT EXISTS dlp_policies (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                policy_type TEXT DEFAULT '',
                action TEXT DEFAULT 'log',
                scope TEXT DEFAULT '',
                enabled BOOLEAN DEFAULT TRUE,
                rules JSONB DEFAULT '[]',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        // Migrate existing tables: add new columns if missing
        const dlpCols = await all("SELECT column_name FROM information_schema.columns WHERE table_name = 'dlp_policies'");
        const dlpColNames = dlpCols.map(c => c.column_name);
        if (!dlpColNames.includes('policy_type')) await q("ALTER TABLE dlp_policies ADD COLUMN policy_type TEXT DEFAULT ''");
        if (!dlpColNames.includes('action')) await q("ALTER TABLE dlp_policies ADD COLUMN action TEXT DEFAULT 'log'");
        if (!dlpColNames.includes('scope')) await q("ALTER TABLE dlp_policies ADD COLUMN scope TEXT DEFAULT ''");

        await q(`
            CREATE TABLE IF NOT EXISTS dlp_events (
                id SERIAL PRIMARY KEY,
                device_id TEXT NOT NULL,
                event_source TEXT NOT NULL DEFAULT 'unknown',
                event_type TEXT NOT NULL DEFAULT 'info',
                policy_id INTEGER DEFAULT NULL REFERENCES dlp_policies(id) ON DELETE SET NULL,
                policy_name TEXT DEFAULT '',
                action TEXT DEFAULT 'log',
                details JSONB DEFAULT '{}',
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await q('CREATE INDEX IF NOT EXISTS idx_dlp_events_device ON dlp_events (device_id)');
        await q('CREATE INDEX IF NOT EXISTS idx_dlp_events_time ON dlp_events (created_at)');
        await q('CREATE INDEX IF NOT EXISTS idx_dlp_events_source ON dlp_events (event_source)');

        // Saved reports table
        await q(`
            CREATE TABLE IF NOT EXISTS saved_reports (
                id SERIAL PRIMARY KEY,
                title TEXT NOT NULL,
                report_type TEXT NOT NULL,
                filters JSONB DEFAULT '{}',
                payload JSONB DEFAULT '{}',
                created_by TEXT NOT NULL DEFAULT 'admin',
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await q('CREATE INDEX IF NOT EXISTS idx_saved_reports_type ON saved_reports (report_type)');

        // Multi-tenancy tables
        await q(`
            CREATE TABLE IF NOT EXISTS tenants (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                slug TEXT NOT NULL UNIQUE,
                contact_name TEXT DEFAULT '',
                contact_email TEXT DEFAULT '',
                max_devices INTEGER DEFAULT 0,
                notes TEXT DEFAULT '',
                active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await q(`
            CREATE TABLE IF NOT EXISTS tenant_devices (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                device_id TEXT NOT NULL,
                assigned_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(tenant_id, device_id)
            )
        `);
        await q(`
            CREATE TABLE IF NOT EXISTS tenant_users (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL,
                assigned_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(tenant_id, user_id)
            )
        `);
        await q('CREATE INDEX IF NOT EXISTS idx_tenant_devices_tenant ON tenant_devices (tenant_id)');
        await q('CREATE INDEX IF NOT EXISTS idx_tenant_devices_device ON tenant_devices (device_id)');
        await q('CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant ON tenant_users (tenant_id)');

        // -- Pending Registrations
        await q(`
            CREATE TABLE IF NOT EXISTS pending_registrations (
                id SERIAL PRIMARY KEY,
                device_id TEXT NOT NULL UNIQUE,
                hostname TEXT DEFAULT '',
                platform TEXT DEFAULT '',
                version TEXT DEFAULT '',
                ip_address TEXT DEFAULT '',
                public_key TEXT DEFAULT '',
                uuid TEXT DEFAULT '',
                status TEXT DEFAULT 'pending',
                approved_by TEXT DEFAULT NULL,
                approved_at TIMESTAMPTZ DEFAULT NULL,
                rejected_reason TEXT DEFAULT '',
                access_token TEXT DEFAULT NULL,
                console_url TEXT DEFAULT NULL,
                server_address TEXT DEFAULT NULL,
                server_key TEXT DEFAULT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await q('CREATE INDEX IF NOT EXISTS idx_pending_reg_status ON pending_registrations (status)');
        await q('CREATE INDEX IF NOT EXISTS idx_pending_reg_device ON pending_registrations (device_id)');

        // -- Agent installer bundles (Generator Agenta)
        await q(`
            CREATE TABLE IF NOT EXISTS agent_bundles (
                id SERIAL PRIMARY KEY,
                bundle_id TEXT NOT NULL UNIQUE,
                slug TEXT DEFAULT NULL,
                name TEXT NOT NULL,
                branding TEXT NOT NULL DEFAULT '{}',
                branding_hash TEXT NOT NULL DEFAULT '',
                created_by INTEGER DEFAULT NULL,
                revoked BOOLEAN NOT NULL DEFAULT FALSE,
                download_count INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        await q('CREATE INDEX IF NOT EXISTS idx_agent_bundles_bundle_id ON agent_bundles (bundle_id)');
        await q('CREATE INDEX IF NOT EXISTS idx_agent_bundles_hash ON agent_bundles (branding_hash)');
        try {
            const slugCol = await all(`SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_bundles' AND column_name = 'slug'`);
            if (slugCol.length === 0) {
                await q('ALTER TABLE agent_bundles ADD COLUMN slug TEXT DEFAULT NULL');
                console.log('[DB] Migration: added agent_bundles.slug');
            }
            await q('CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_bundles_slug ON agent_bundles (slug) WHERE slug IS NOT NULL AND slug != \'\'');
            const takenRows = await all("SELECT slug FROM agent_bundles WHERE slug IS NOT NULL AND slug != ''");
            const taken = new Set(takenRows.map(r => r.slug));
            const missing = await all("SELECT id, bundle_id, name FROM agent_bundles WHERE slug IS NULL OR slug = ''");
            for (const row of missing) {
                const slug = agentBundleService.allocateUniqueSlug({
                    preferred: null,
                    name: row.name,
                    fallbackId: row.bundle_id,
                    isTaken: (s) => taken.has(s),
                });
                await q('UPDATE agent_bundles SET slug = $1 WHERE id = $2', [slug, row.id]);
                taken.add(slug);
            }
        } catch (e) {
            console.warn('[DB] Migration agent_bundles.slug error:', e.message);
        }
        await q(`
            CREATE TABLE IF NOT EXISTS agent_bundle_builds (
                id SERIAL PRIMARY KEY,
                branding_hash TEXT NOT NULL,
                platform TEXT NOT NULL,
                arch TEXT NOT NULL DEFAULT 'x64',
                format TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                artifact_path TEXT DEFAULT NULL,
                artifact_size BIGINT DEFAULT 0,
                artifact_sha256 TEXT DEFAULT NULL,
                error_message TEXT DEFAULT '',
                started_at TIMESTAMPTZ DEFAULT NULL,
                finished_at TIMESTAMPTZ DEFAULT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE(branding_hash, platform, arch, format)
            )
        `);
        await q('CREATE INDEX IF NOT EXISTS idx_agent_bundle_builds_hash ON agent_bundle_builds (branding_hash)');
        await q('CREATE INDEX IF NOT EXISTS idx_agent_bundle_builds_status ON agent_bundle_builds (status)');

        // -- RustDesk Client Integration tables --
        await q(`
            CREATE TABLE IF NOT EXISTS device_folder_assignments (
                device_id TEXT PRIMARY KEY NOT NULL,
                folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
                assigned_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS peer_sysinfo (
                peer_id TEXT PRIMARY KEY,
                hostname TEXT DEFAULT '',
                username TEXT DEFAULT '',
                platform TEXT DEFAULT '',
                version TEXT DEFAULT '',
                cpu_name TEXT DEFAULT '',
                cpu_cores INTEGER DEFAULT 0,
                cpu_freq_ghz REAL DEFAULT 0,
                memory_gb REAL DEFAULT 0,
                os_full TEXT DEFAULT '',
                displays JSONB DEFAULT '[]',
                encoding JSONB DEFAULT '[]',
                features JSONB DEFAULT '{}',
                platform_additions JSONB DEFAULT '{}',
                raw_json JSONB DEFAULT '{}',
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS peer_metrics (
                id SERIAL PRIMARY KEY,
                peer_id TEXT NOT NULL,
                cpu_usage REAL DEFAULT 0,
                memory_usage REAL DEFAULT 0,
                disk_usage REAL DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await q('CREATE INDEX IF NOT EXISTS idx_peer_metrics_peer_time ON peer_metrics (peer_id, created_at)');

        await q(`
            CREATE TABLE IF NOT EXISTS audit_connections (
                id SERIAL PRIMARY KEY,
                host_id TEXT NOT NULL,
                host_uuid TEXT DEFAULT '',
                peer_id TEXT DEFAULT '',
                peer_name TEXT DEFAULT '',
                action TEXT NOT NULL,
                conn_type INTEGER DEFAULT 0,
                session_id TEXT DEFAULT '',
                ip TEXT DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await q('CREATE INDEX IF NOT EXISTS idx_audit_conn_host ON audit_connections (host_id, created_at)');
        await q('CREATE INDEX IF NOT EXISTS idx_audit_conn_peer ON audit_connections (peer_id, created_at)');

        await q(`
            CREATE TABLE IF NOT EXISTS audit_files (
                id SERIAL PRIMARY KEY,
                host_id TEXT NOT NULL,
                host_uuid TEXT DEFAULT '',
                peer_id TEXT DEFAULT '',
                direction INTEGER DEFAULT 0,
                path TEXT DEFAULT '',
                is_file BOOLEAN DEFAULT TRUE,
                num_files INTEGER DEFAULT 0,
                files_json JSONB DEFAULT '[]',
                ip TEXT DEFAULT '',
                peer_name TEXT DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await q('CREATE INDEX IF NOT EXISTS idx_audit_files_host ON audit_files (host_id, created_at)');

        await q(`
            CREATE TABLE IF NOT EXISTS audit_alarms (
                id SERIAL PRIMARY KEY,
                alarm_type INTEGER NOT NULL,
                alarm_name TEXT DEFAULT '',
                host_id TEXT DEFAULT '',
                peer_id TEXT DEFAULT '',
                ip TEXT DEFAULT '',
                details JSONB DEFAULT '{}',
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await q('CREATE INDEX IF NOT EXISTS idx_audit_alarms_type ON audit_alarms (alarm_type, created_at)');

        await q(`
            CREATE TABLE IF NOT EXISTS user_groups (
                id SERIAL PRIMARY KEY,
                guid TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                note TEXT DEFAULT '',
                team_id TEXT DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS user_group_members (
                user_group_id INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (user_group_id, user_id)
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS device_groups (
                id SERIAL PRIMARY KEY,
                guid TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                note TEXT DEFAULT '',
                team_id TEXT DEFAULT '',
                source_type TEXT DEFAULT 'manual',
                tag_filter TEXT DEFAULT '',
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS device_group_members (
                device_group_id INTEGER NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE,
                peer_id TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (device_group_id, peer_id)
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS device_group_user_access (
                device_group_id INTEGER NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (device_group_id, user_id)
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS device_group_user_group_access (
                device_group_id INTEGER NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE,
                user_group_id INTEGER NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (device_group_id, user_group_id)
            )
        `);

        await q(`
            CREATE TABLE IF NOT EXISTS strategies (
                id SERIAL PRIMARY KEY,
                guid TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                user_group_guid TEXT DEFAULT '',
                device_group_guid TEXT DEFAULT '',
                enabled BOOLEAN DEFAULT TRUE,
                permissions JSONB DEFAULT '{}',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await q(`
            CREATE TABLE IF NOT EXISTS strategy_assignments (
                id SERIAL PRIMARY KEY,
                target_type TEXT NOT NULL,
                target_key TEXT NOT NULL,
                strategy_guid TEXT NOT NULL DEFAULT '',
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(target_type, target_key)
            )
        `);
        await q('CREATE INDEX IF NOT EXISTS idx_strategy_assignments_strategy ON strategy_assignments (strategy_guid)');
        await q(`
            CREATE TABLE IF NOT EXISTS user_peer_grants (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                peer_id TEXT NOT NULL,
                granted_at TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (user_id, peer_id)
            )
        `);
        await q('CREATE INDEX IF NOT EXISTS idx_user_peer_grants_user ON user_peer_grants (user_id)');

        // Seed default groups if empty
        const ugCheck = await one('SELECT COUNT(*)::INTEGER AS c FROM user_groups');
        if (ugCheck && ugCheck.c === 0) {
            const crypto = require('crypto');
            await q('INSERT INTO user_groups (guid, name, note) VALUES ($1, $2, $3)', [crypto.randomUUID(), 'Default', 'Default user group']);
        }
        const dgCheck = await one('SELECT COUNT(*)::INTEGER AS c FROM device_groups');
        if (dgCheck && dgCheck.c === 0) {
            const crypto = require('crypto');
            await q('INSERT INTO device_groups (guid, name, note) VALUES ($1, $2, $3)', [crypto.randomUUID(), 'Default', 'Default device group']);
        }
        
        // Migration: Add missing columns to existing users table (for upgrades from older versions)
        const columnCheck = await all(`SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`);
        const existingCols = new Set(columnCheck.map(c => c.column_name));
        if (!existingCols.has('last_login')) {
            await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ');
        }
        if (!existingCols.has('auth_provider')) {
            await q("ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT DEFAULT 'local'");
        }
        if (!existingCols.has('preferred_language')) {
            await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_language TEXT DEFAULT NULL');
        }
        if (!existingCols.has('totp_secret')) {
            await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT DEFAULT NULL');
        }
        if (!existingCols.has('totp_enabled')) {
            await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN DEFAULT FALSE');
        }
        if (!existingCols.has('totp_recovery_codes')) {
            await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_recovery_codes TEXT DEFAULT NULL');
        }
        if (!existingCols.has('guid')) {
            await q("ALTER TABLE users ADD COLUMN IF NOT EXISTS guid TEXT DEFAULT ''");
        }

        const deviceGroupColumnCheck = await all(`SELECT column_name FROM information_schema.columns WHERE table_name = 'device_groups'`);
        const existingDeviceGroupCols = new Set(deviceGroupColumnCheck.map(c => c.column_name));
        if (!existingDeviceGroupCols.has('source_type')) {
            await q("ALTER TABLE device_groups ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'manual'");
        }
        if (!existingDeviceGroupCols.has('tag_filter')) {
            await q("ALTER TABLE device_groups ADD COLUMN IF NOT EXISTS tag_filter TEXT DEFAULT ''");
        }

        // Phase 4: operator identity profile columns
        const identityCols = [
            ['first_name',   "TEXT DEFAULT ''"],
            ['last_name',    "TEXT DEFAULT ''"],
            ['email',        "TEXT DEFAULT ''"],
            ['phone',        "TEXT DEFAULT ''"],
            ['role_display', "TEXT DEFAULT ''"],
            ['avatar_url',   "TEXT DEFAULT ''"],
        ];
        for (const [col, def] of identityCols) {
            if (!existingCols.has(col)) {
                await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col} ${def}`);
            }
        }

        // Migration: Add updated_at to settings table if missing (for upgrades from older versions)
        try {
            const settingsColCheck = await all(`SELECT column_name FROM information_schema.columns WHERE table_name = 'settings'`);
            const settingsCols = new Set(settingsColCheck.map(c => c.column_name));
            if (settingsCols.size > 0 && !settingsCols.has('updated_at')) {
                await q('ALTER TABLE settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()');
            }
        } catch (_) {}
    }

    // Parse helpers

    function parsePeer(row) {
        if (!row) return null;
        let info = {};
        if (row.info && typeof row.info === 'object') info = row.info;
        else if (row.info && typeof row.info === 'string') { try { info = JSON.parse(row.info); } catch (_) {} }
        return {
            id: row.id,
            uuid: row.uuid || '',
            pk: row.pk || null,
            hostname: row.note || info.hostname || '',
            username: typeof row.user === 'string' ? row.user : '',
            platform: info.os || info.platform || '',
            ip: info.ip || row.ip || '',
            note: row.note || '',
            online: !!row.status_online,
            banned: !!row.is_banned,
            created_at: row.created_at,
            last_online: row.last_online,
            ban_reason: row.banned_reason || '',
            folder_id: row.folder_id || null,
            info: typeof row.info === 'object' ? JSON.stringify(row.info) : (row.info || ''),
            tags: row.tags ? (typeof row.tags === 'string' ? row.tags.split(',').filter(Boolean) : []) : [],
        };
    }

    function safeJsonParse(val, fallback) {
        if (val && typeof val === 'object') return val; // PostgreSQL JSONB is already parsed
        try { return JSON.parse(val); } catch { return fallback; }
    }

    function parseSysinfoRow(row) {
        return {
            peer_id: row.peer_id,
            hostname: row.hostname,
            username: row.username,
            platform: row.platform,
            version: row.version,
            cpu_name: row.cpu_name,
            cpu_cores: row.cpu_cores,
            cpu_freq_ghz: +row.cpu_freq_ghz,
            memory_gb: +row.memory_gb,
            os_full: row.os_full,
            displays: safeJsonParse(row.displays, []),
            encoding: safeJsonParse(row.encoding, []),
            features: safeJsonParse(row.features, {}),
            platform_additions: safeJsonParse(row.platform_additions, {}),
            updated_at: row.updated_at,
        };
    }

    // ========= Go ↔ Node.js peer sync (PostgreSQL only) =========

    let _lastGoPeerSync = 0;
    const GO_SYNC_INTERVAL_MS = 30_000; // sync at most every 30 seconds

    async function cascadePeerIdChangePg(oldId, newId) {
        if (!oldId || !newId || oldId === newId) return;
        try {
            await q('UPDATE peer SET id = $1 WHERE id = $2', [newId, oldId]);
        } catch (err) {
            console.warn('[DB] cascadePeerIdChange peer table:', err.message);
        }
        const stmts = [
            ['UPDATE peer_sysinfo SET peer_id = $1 WHERE peer_id = $2', [newId, oldId]],
            ['UPDATE peer_metrics SET peer_id = $1 WHERE peer_id = $2', [newId, oldId]],
            ['UPDATE device_folder_assignments SET device_id = $1 WHERE device_id = $2', [newId, oldId]],
            ['UPDATE device_group_peers SET peer_id = $1 WHERE peer_id = $2', [newId, oldId]],
            ['UPDATE access_tokens SET client_id = $1 WHERE client_id = $2', [newId, oldId]],
            ['UPDATE audit_connections SET peer_id = $1 WHERE peer_id = $2', [newId, oldId]],
            ['UPDATE audit_files SET peer_id = $1 WHERE peer_id = $2', [newId, oldId]],
            ['UPDATE audit_alarms SET peer_id = $1 WHERE peer_id = $2', [newId, oldId]],
        ];
        for (const [sql, params] of stmts) {
            try {
                await q(sql, params);
            } catch (err) {
                if (!err.message.includes('does not exist')) {
                    console.warn('[DB] cascadePeerIdChange:', err.message);
                }
            }
        }
    }

    async function syncPanelPeerIdRenamesFromGoPg() {
        try {
            const rows = await all(`
                SELECT h.old_id, h.new_id FROM id_change_history h
                INNER JOIN peers p ON p.id = h.new_id AND NOT p.soft_deleted
                WHERE EXISTS (SELECT 1 FROM peer WHERE id = h.old_id)
            `);
            for (const row of rows) {
                await cascadePeerIdChangePg(row.old_id, row.new_id);
            }
        } catch (err) {
            if (!err.message.includes('does not exist')) {
                console.warn('[DB] syncPanelPeerIdRenamesFromGo:', err.message);
            }
        }
    }

    async function purgePanelPeerRecordPg(id) {
        if (!id) return;
        try {
            await q('DELETE FROM peer WHERE id = $1', [id]);
        } catch (err) {
            console.warn('[DB] purgePanelPeerRecord:', err.message);
        }
    }

    /**
     * Identity-aware rename guard — mirrors Go signal rejectRenamedPeerRegistration (#213).
     * @returns {Promise<{ reject: boolean, new_id?: string }>}
     */
    async function shouldRejectRenamedPeerRegistrationPg(oldId, { uuid, pk, ip } = {}) {
        let newId = null;
        try {
            const row = await q1('SELECT new_id FROM id_change_history WHERE old_id = $1 ORDER BY id DESC LIMIT 1', [oldId]);
            newId = row ? row.new_id : null;
        } catch (_) {
            return { reject: false };
        }
        if (!newId) return { reject: false };

        let successor = null;
        try {
            successor = await q1('SELECT pk, uuid, ip FROM peers WHERE id = $1 AND NOT soft_deleted', [newId]);
        } catch (_) {}
        if (!successor) {
            try {
                successor = await q1('SELECT pk, uuid, ip FROM peer WHERE id = $1 AND is_deleted = FALSE', [newId]);
            } catch (_) {}
        }
        if (!successor) return { reject: false };

        const pkVal = pk || '';
        const uuidVal = uuid || '';
        if (pkVal && successor.pk && pkEqual(pkVal, successor.pk)) return { reject: false, redirect_id: newId };
        if (uuidVal && successor.uuid && uuidEqual(uuidVal, successor.uuid)) return { reject: false, redirect_id: newId };
        if (!pkVal && !uuidVal && ip && peerIPMatches(ip, successor.ip || '')) return { reject: false, redirect_id: newId };

        return { reject: true, new_id: newId };
    }

    /**
     * Sync devices from Go server's "peers" table into Node.js "peer" table.
     * Called before bulk queries (getAllPeers, getPeerStats) to ensure the
     * console shows all devices the Go signal server has registered.
     */
    async function syncGoPeers() {
        const now = Date.now();
        if (now - _lastGoPeerSync < GO_SYNC_INTERVAL_MS) return;
        _lastGoPeerSync = now;
        try {
            await q(`
                INSERT INTO peer (id, uuid, pk, info, ip, "user", status_online, last_online, created_at,
                                  is_deleted, is_banned, banned_at, banned_reason)
                SELECT
                    p.id,
                    COALESCE(p.uuid, ''),
                    p.pk,
                    json_build_object(
                        'hostname', COALESCE(p.hostname, ''),
                        'os',       COALESCE(p.os, ''),
                        'platform', COALESCE(p.os, ''),
                        'version',  COALESCE(p.version, '')
                    )::jsonb,
                    COALESCE(p.ip, ''),
                    COALESCE(p."user", ''),
                    (p.status = 'ONLINE'),
                    p.last_online,
                    COALESCE(p.created_at, NOW()),
                    FALSE,
                    COALESCE(p.banned, FALSE),
                    p.banned_at,
                    COALESCE(p.ban_reason, '')
                FROM peers p
                WHERE NOT p.soft_deleted
                ON CONFLICT(id) DO UPDATE SET
                    status_online = EXCLUDED.status_online,
                    last_online   = COALESCE(EXCLUDED.last_online, peer.last_online),
                    info          = CASE WHEN peer.info IS NULL OR peer.info = '{}' THEN EXCLUDED.info ELSE peer.info END,
                    is_deleted    = FALSE
            `);
            await q(`
                DELETE FROM peer WHERE id IN (
                    SELECT h.old_id FROM id_change_history h
                    LEFT JOIN peers p ON p.id = h.old_id AND NOT p.soft_deleted
                    WHERE p.id IS NULL
                )
            `);
            await syncPanelPeerIdRenamesFromGoPg();
        } catch (err) {
            // 'peers' table might not exist when Go server is not used
            if (!err.message.includes('does not exist')) {
                console.warn('[DB] syncGoPeers error:', err.message);
            }
        }
    }

    // ========= Adapter =========

    return {
        type: 'postgres',

        async init() {
            await ensureSchema();
            console.log('[DB] PostgreSQL adapter initialized');
        },

        async close() {
            if (pool) { await pool.end(); pool = null; }
        },

        // ---- Peers ----

        async getAllPeers(filters = {}) {
            await syncGoPeers();
            let where = 'WHERE NOT is_deleted';
            const params = [];
            let idx = 1;
            if (filters.online !== undefined) { where += ` AND status_online = $${idx++}`; params.push(!!filters.online); }
            if (filters.banned !== undefined) { where += ` AND is_banned = $${idx++}`; params.push(!!filters.banned); }
            if (filters.search) { where += ` AND (id ILIKE $${idx} ESCAPE '\\' OR note ILIKE $${idx} ESCAPE '\\' OR "user" ILIKE $${idx} ESCAPE '\\')`; params.push(`%${escapeLikePattern(filters.search)}%`); idx++; }
            if (filters.folder_id !== undefined) {
                if (filters.folder_id === null) { where += ' AND folder_id IS NULL'; }
                else { where += ` AND folder_id = $${idx++}`; params.push(filters.folder_id); }
            }
            return (await all(`SELECT * FROM peer ${where} ORDER BY id`, params)).map(parsePeer);
        },

        async getPeerById(id) {
            let row = await one('SELECT * FROM peer WHERE id = $1 AND NOT is_deleted', [id]);
            if (!row) {
                // Fallback: check Go server's 'peers' table (different schema).
                // When using PostgreSQL, the Go signal server registers devices in
                // 'peers' while the Node.js console uses 'peer'. Bridge them here.
                try {
                    const goRow = await one(
                        'SELECT * FROM peers WHERE id = $1 AND NOT soft_deleted', [id]
                    );
                    if (goRow) {
                        // Auto-sync: create the device in the Node.js 'peer' table
                        const info = JSON.stringify({
                            hostname: goRow.hostname || '',
                            os: goRow.os || '',
                            platform: goRow.os || '',
                            version: goRow.version || ''
                        });
                        await q(`
                            INSERT INTO peer (id, uuid, pk, info, ip, "user", status_online, last_online, created_at, is_deleted, is_banned, banned_at, banned_reason)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE, $10, $11, $12)
                            ON CONFLICT(id) DO UPDATE SET
                                uuid = COALESCE(NULLIF($2, ''), peer.uuid),
                                pk = COALESCE($3, peer.pk),
                                info = COALESCE(NULLIF($4, '{}'), peer.info),
                                ip = COALESCE(NULLIF($5, ''), peer.ip),
                                "user" = COALESCE(NULLIF($6, ''), peer."user"),
                                status_online = $7,
                                last_online = $8,
                                is_deleted = FALSE
                        `, [
                            goRow.id,
                            goRow.uuid || '',
                            goRow.pk || null,
                            info,
                            goRow.ip || '',
                            goRow.user || '',
                            goRow.status === 'ONLINE',
                            goRow.last_online || null,
                            goRow.created_at || new Date(),
                            !!goRow.banned,
                            goRow.banned_at || null,
                            goRow.ban_reason || ''
                        ]);
                        // Re-read the just-synced row
                        row = await one('SELECT * FROM peer WHERE id = $1 AND NOT is_deleted', [id]);
                    }
                } catch (err) {
                    // 'peers' table might not exist (SQLite mode, or Go server not used)
                    if (!err.message.includes('does not exist')) {
                        console.warn('[DB] Fallback peers lookup error:', err.message);
                    }
                }
            }
            return parsePeer(row);
        },

        async upsertPeer({ id, uuid, pk, info, ip }) {
            await q(`
                INSERT INTO peer (id, uuid, pk, info, ip, status_online, created_at)
                VALUES ($1, $2, $3, $4::jsonb, $5, TRUE, NOW())
                ON CONFLICT(id) DO UPDATE SET
                    uuid = COALESCE(NULLIF($2, ''), peer.uuid),
                    pk = COALESCE($3, peer.pk),
                    info = COALESCE(NULLIF(EXCLUDED.info, '{}'::jsonb), peer.info),
                    ip = COALESCE(NULLIF($5, ''), peer.ip),
                    status_online = TRUE,
                    last_online = NOW(),
                    is_deleted = FALSE
            `, [id, uuid || '', pk || null, info || '{}', ip || '']);
        },

        async updatePeer(id, data) {
            if (data.note !== undefined) await q('UPDATE peer SET note = $1 WHERE id = $2', [data.note, id]);
            if (data.user !== undefined) await q('UPDATE peer SET "user" = $1 WHERE id = $2', [data.user, id]);
            if (data.info !== undefined) await q('UPDATE peer SET info = $1 WHERE id = $2', [data.info, id]);
        },

        async softDeletePeer(id) {
            await q('UPDATE peer SET is_deleted = TRUE WHERE id = $1', [id]);
        },

        async cleanupDeletedPeerData(id) {
            await q('DELETE FROM peer_sysinfo WHERE peer_id = $1', [id]);
            await q('DELETE FROM peer_metrics WHERE peer_id = $1', [id]);
            await q('DELETE FROM device_folder_assignments WHERE peer_id = $1', [id]);
            await q('DELETE FROM device_group_peers WHERE peer_id = $1', [id]);
        },

        /**
         * Check if a peer ID was renamed to a new ID. Returns the new_id if found,
         * null otherwise. Used to reject registrations with stale/old IDs.
         */
        async getRenamedPeerId(oldId) {
            try {
                const row = await q1('SELECT new_id FROM id_change_history WHERE old_id = $1 ORDER BY id DESC LIMIT 1', [oldId]);
                return row ? row.new_id : null;
            } catch (_) { return null; }
        },

        async cascadePeerIdChange(oldId, newId) {
            await cascadePeerIdChangePg(oldId, newId);
        },

        async purgePanelPeerRecord(id) {
            await purgePanelPeerRecordPg(id);
        },

        async shouldRejectRenamedPeerRegistration(oldId, identity) {
            return shouldRejectRenamedPeerRegistrationPg(oldId, identity);
        },

        async setBanStatus(id, banned, reason = '') {
            await q(`
                UPDATE peer SET is_banned = $1, banned_at = CASE WHEN $1 THEN NOW() ELSE NULL END, banned_reason = $2
                WHERE id = $3
            `, [!!banned, reason, id]);
        },

        async getPeerStats() {
            await syncGoPeers();
            const r = await one(`
                SELECT
                    COUNT(*) FILTER (WHERE NOT is_deleted) as total,
                    COUNT(*) FILTER (WHERE NOT is_deleted AND status_online) as online,
                    COUNT(*) FILTER (WHERE NOT is_deleted AND is_banned) as banned
                FROM peer
            `);
            return { total: +r.total, online: +r.online, banned: +r.banned, offline: +r.total - +r.online };
        },

        async resetAllOnlineStatus() {
            await q('UPDATE peer SET status_online = FALSE');
        },

        async markPeersOnline(ids) {
            if (!ids.length) return;
            const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
            await q(`UPDATE peer SET status_online = TRUE, last_online = NOW() WHERE id IN (${placeholders})`, ids);
        },

        // ---- Users ----

        async getUserByUsername(username) { return one('SELECT * FROM users WHERE username = $1', [username]); },
        async getUserById(id) { return one('SELECT * FROM users WHERE id = $1', [id]); },
        async createUser(username, passwordHash, role = 'admin', authProvider = 'local') {
            const provider = authProvider || 'local';
            const r = await one(
                'INSERT INTO users (username, password_hash, role, auth_provider) VALUES ($1, $2, $3, $4) RETURNING id',
                [username, passwordHash, role, provider]
            );
            return { id: r.id, username, role, auth_provider: provider };
        },
        async syncUserFromGo(id, { role, authProvider, passwordHash } = {}) {
            const sets = [];
            const values = [];
            let idx = 1;
            if (role !== undefined && role !== null) {
                sets.push(`role = $${idx++}`);
                values.push(role);
            }
            if (authProvider !== undefined && authProvider !== null) {
                sets.push(`auth_provider = $${idx++}`);
                values.push(authProvider);
            }
            if (passwordHash !== undefined && passwordHash !== null) {
                sets.push(`password_hash = $${idx++}`);
                values.push(passwordHash);
            }
            if (!sets.length) return;
            values.push(id);
            await q(`UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}`, values);
        },
        async updateUserPassword(id, passwordHash) { await q('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, id]); },
        async touchLastLogin(id) { await q('UPDATE users SET last_login = NOW() WHERE id = $1', [id]); },
        async hasUsers() { return +(await one('SELECT COUNT(*) as c FROM users')).c > 0; },
        async getAllUsers() { return all('SELECT id, username, role, auth_provider, created_at, last_login, preferred_language, totp_enabled, email FROM users ORDER BY id'); },
        async updateUserRole(id, role) { await q('UPDATE users SET role = $1 WHERE id = $2', [role, id]); },
        async updateUserLanguage(id, lang) { await q('UPDATE users SET preferred_language = $1 WHERE id = $2', [lang, id]); },
        async updateUserProfile(id, fields) {
            const allowed = ['first_name', 'last_name', 'email', 'phone', 'role_display', 'avatar_url'];
            const sets = [];
            const values = [];
            let idx = 1;
            for (const k of allowed) {
                if (fields && Object.prototype.hasOwnProperty.call(fields, k)) {
                    sets.push(`${k} = $${idx++}`);
                    values.push(String(fields[k] == null ? '' : fields[k]).slice(0, 200));
                }
            }
            if (!sets.length) return;
            values.push(id);
            await q(`UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}`, values);
        },
        async deleteUser(id) {
            await q('DELETE FROM user_group_members WHERE user_id = $1', [id]);
            await q('DELETE FROM device_group_user_access WHERE user_id = $1', [id]);
            await q('DELETE FROM users WHERE id = $1', [id]);
        },
        async countAdmins() { return +(await one("SELECT COUNT(*) as c FROM users WHERE role IN ('admin', 'super_admin')")).c; },

        // ---- TOTP ----

        async saveTotpSecret(userId, secret) { await q('UPDATE users SET totp_secret = $1 WHERE id = $2', [secret, userId]); },
        async enableTotp(userId, recoveryCodes) { const codesJson = Array.isArray(recoveryCodes) ? JSON.stringify(recoveryCodes) : recoveryCodes; await q('UPDATE users SET totp_enabled = TRUE, totp_recovery_codes = $1 WHERE id = $2', [codesJson, userId]); },
        async disableTotp(userId) { await q('UPDATE users SET totp_enabled = FALSE, totp_secret = NULL, totp_recovery_codes = NULL WHERE id = $1', [userId]); },
        async useRecoveryCode(userId, updatedCodes) { const codesJson = Array.isArray(updatedCodes) ? JSON.stringify(updatedCodes) : updatedCodes; await q('UPDATE users SET totp_recovery_codes = $1 WHERE id = $2', [codesJson, userId]); },

        // ---- Access tokens ----

        async createAccessToken({ token, userId, clientId, clientUuid, expiresAt, ipAddress }) {
            const tokenHash = hashAccessToken(token);
            await q(`INSERT INTO access_tokens (token, token_hash, user_id, client_id, client_uuid, expires_at, ip_address)
                VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [token, tokenHash, userId, clientId || '', clientUuid || '', expiresAt, ipAddress || '']);
        },
        async getAccessToken(token) {
            const tokenHash = hashAccessToken(token);
            const byHash = await one(`
                SELECT * FROM access_tokens
                WHERE token_hash = $1 AND NOT revoked AND expires_at > NOW()
            `, [tokenHash]);
            if (byHash) return byHash;
            return one('SELECT * FROM access_tokens WHERE token = $1 AND NOT revoked AND expires_at > NOW()', [token]);
        },
        async touchAccessToken(token) {
            const tokenHash = hashAccessToken(token);
            await q('UPDATE access_tokens SET last_used = NOW() WHERE token_hash = $1 OR token = $2', [tokenHash, token]);
        },
        async revokeAccessToken(token) {
            const tokenHash = hashAccessToken(token);
            await q('UPDATE access_tokens SET revoked = TRUE WHERE token_hash = $1 OR token = $2', [tokenHash, token]);
        },
        async revokeUserClientTokens(userId, clientUuid) { await q('UPDATE access_tokens SET revoked = TRUE WHERE user_id = $1 AND client_uuid = $2', [userId, clientUuid]); },
        async revokeAllUserTokens(userId) { await q('UPDATE access_tokens SET revoked = TRUE WHERE user_id = $1', [userId]); },
        async cleanupExpiredTokens() { await q('DELETE FROM access_tokens WHERE expires_at < NOW() OR revoked'); },

        // ---- Login tracking ----

        async recordLoginAttempt(username, ipAddress, success) {
            await q('INSERT INTO login_attempts (username, ip_address, success) VALUES ($1, $2, $3)', [username, ipAddress, !!success]);
        },
        async countRecentFailedAttempts(username, windowMinutes) {
            return +(await one(`SELECT COUNT(*) as c FROM login_attempts WHERE username = $1 AND NOT success AND created_at > NOW() - INTERVAL '1 minute' * $2`, [username, windowMinutes])).c;
        },
        async countRecentFailedAttemptsFromIp(ipAddress, windowMinutes) {
            return +(await one(`SELECT COUNT(*) as c FROM login_attempts WHERE ip_address = $1 AND NOT success AND created_at > NOW() - INTERVAL '1 minute' * $2`, [ipAddress, windowMinutes])).c;
        },
        async lockAccount(username, lockedUntil, attemptCount) {
            await q(`INSERT INTO account_lockouts (username, locked_until, attempt_count) VALUES ($1, $2, $3)
                ON CONFLICT(username) DO UPDATE SET locked_until = $2, attempt_count = $3`, [username, lockedUntil, attemptCount]);
        },
        async getAccountLockout(username) { return one('SELECT * FROM account_lockouts WHERE username = $1 AND locked_until > NOW()', [username]); },
        async clearAccountLockout(username) { await q('DELETE FROM account_lockouts WHERE username = $1', [username]); },

        // ---- Folders ----

        async getAllFolders() { return all('SELECT * FROM folders ORDER BY sort_order, name'); },
        async getFolderById(id) { return one('SELECT * FROM folders WHERE id = $1', [id]); },
        async createFolder({ name, color, icon, sort_order }) {
            const r = await one('INSERT INTO folders (name, color, icon, sort_order) VALUES ($1, $2, $3, $4) RETURNING id', [name, color || '#6366f1', icon || 'folder', sort_order || 0]);
            return { id: r.id, name, color, icon, sort_order };
        },
        async updateFolder(id, { name, color, icon, sort_order }) {
            const sets = []; const params = []; let idx = 1;
            if (name !== undefined) { sets.push(`name = $${idx++}`); params.push(name); }
            if (color !== undefined) { sets.push(`color = $${idx++}`); params.push(color); }
            if (icon !== undefined) { sets.push(`icon = $${idx++}`); params.push(icon); }
            if (sort_order !== undefined) { sets.push(`sort_order = $${idx++}`); params.push(sort_order); }
            if (!sets.length) return;
            params.push(id);
            await q(`UPDATE folders SET ${sets.join(', ')} WHERE id = $${idx}`, params);
        },
        async deleteFolder(id) {
            // Clear folder assignments first
            await q('DELETE FROM device_folder_assignments WHERE folder_id = $1', [id]);
            await q('DELETE FROM folders WHERE id = $1', [id]);
        },
        async assignDeviceToFolder(deviceId, folderId) {
            // Update assignment tracking table (device_folder_assignments is the single source of truth)
            if (folderId === null || folderId === undefined) {
                await q('DELETE FROM device_folder_assignments WHERE device_id = $1', [deviceId]);
            } else {
                await q(`
                    INSERT INTO device_folder_assignments (device_id, folder_id)
                    VALUES ($1, $2)
                    ON CONFLICT(device_id) DO UPDATE SET folder_id = $2, assigned_at = NOW()
                `, [deviceId, folderId]);
            }
        },

        // ---- Address books ----
        // Go server creates address_books with (username, ab_type) PK — not user_id FK.
        // We look up the username from the user ID before querying.

        async getAddressBook(userId, abType = 'legacy') {
            const user = await one('SELECT username FROM users WHERE id = $1', [userId]);
            if (!user) return null;
            return one('SELECT * FROM address_books WHERE username = $1 AND ab_type = $2', [user.username, abType]);
        },
        async saveAddressBook(userId, abType, data) {
            const user = await one('SELECT username FROM users WHERE id = $1', [userId]);
            if (!user) return;
            await q(`INSERT INTO address_books (username, ab_type, data, updated_at) VALUES ($1, $2, $3, NOW())
                ON CONFLICT(username, ab_type) DO UPDATE SET data = $3, updated_at = NOW()`, [user.username, abType, data]);
        },

        // ---- Notification read state (navbar bell) ----

        async getReadNotificationIds(userId) {
            const rows = await all(
                'SELECT notification_id FROM notification_reads WHERE user_id = $1',
                [userId]
            );
            return new Set(rows.map((r) => String(r.notification_id)));
        },
        async markNotificationRead(userId, notificationId) {
            await q(
                `INSERT INTO notification_reads (user_id, notification_id, read_at)
                 VALUES ($1, $2, NOW())
                 ON CONFLICT (user_id, notification_id) DO NOTHING`,
                [userId, String(notificationId)]
            );
            const count = await one(
                'SELECT COUNT(*)::int AS c FROM notification_reads WHERE user_id = $1',
                [userId]
            );
            if (count && count.c > 500) {
                await q(
                    `DELETE FROM notification_reads
                     WHERE user_id = $1
                       AND (user_id, notification_id) NOT IN (
                           SELECT user_id, notification_id
                           FROM notification_reads
                           WHERE user_id = $1
                           ORDER BY read_at DESC
                           LIMIT 400
                       )`,
                    [userId]
                );
            }
        },
        async markAllNotificationsRead(userId, notificationIds) {
            for (const id of notificationIds) {
                await q(
                    `INSERT INTO notification_reads (user_id, notification_id, read_at)
                     VALUES ($1, $2, NOW())
                     ON CONFLICT (user_id, notification_id) DO NOTHING`,
                    [userId, String(id)]
                );
            }
            const count = await one(
                'SELECT COUNT(*)::int AS c FROM notification_reads WHERE user_id = $1',
                [userId]
            );
            if (count && count.c > 500) {
                await q(
                    `DELETE FROM notification_reads
                     WHERE user_id = $1
                       AND (user_id, notification_id) NOT IN (
                           SELECT user_id, notification_id
                           FROM notification_reads
                           WHERE user_id = $1
                           ORDER BY read_at DESC
                           LIMIT 400
                       )`,
                    [userId]
                );
            }
        },

        async hasEmailNotificationSent(eventType, eventId, recipient) {
            const row = await one(
                `SELECT 1 AS ok FROM email_notification_log
                 WHERE event_type = $1 AND event_id = $2 AND recipient = $3`,
                [String(eventType), String(eventId), String(recipient)]
            );
            return !!row;
        },
        async logEmailNotificationSent(eventType, eventId, recipient) {
            await q(
                `INSERT INTO email_notification_log (event_type, event_id, recipient, sent_at)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (event_type, event_id, recipient) DO NOTHING`,
                [String(eventType), String(eventId), String(recipient)]
            );
        },
        async getUsersEmailsByUsernames(usernames = []) {
            const list = Array.from(new Set((usernames || []).map(u => String(u || '').trim()).filter(Boolean)));
            if (!list.length) return [];
            const placeholders = list.map((_, i) => `$${i + 1}`).join(',');
            return all(
                `SELECT username, email FROM users
                 WHERE username IN (${placeholders}) AND email IS NOT NULL AND email != ''`,
                list
            );
        },
        async getUsernamesByUserGroupGuid(guid) {
            const groupGuid = String(guid || '').trim();
            if (!groupGuid) return [];
            const rows = await all(
                `SELECT u.username FROM users u
                 INNER JOIN user_group_members ugm ON ugm.user_id = u.id
                 INNER JOIN user_groups ug ON ug.id = ugm.user_group_id
                 WHERE ug.guid = $1
                 ORDER BY u.username ASC`,
                [groupGuid]
            );
            return rows.map(r => r.username);
        },

        // ---- Audit ----

        async logAction(userId, action, details, ipAddress) {
            const safeDetails = redactAuditDetails(details);
            await q('INSERT INTO audit_log (user_id, action, details, ip_address) VALUES ($1, $2, $3, $4)', [userId, action, safeDetails, ipAddress]);
        },
        async getAuditLogs(limit = 100, offset = 0) {
            return all(`SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON a.user_id = u.id ORDER BY a.created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
        },
        async cleanupOldAuditLogs(daysToKeep = 90) {
            const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();
            const result = await q('DELETE FROM audit_log WHERE created_at < $1', [cutoff]);
            return result.rowCount || 0;
        },

        // ---- Settings ----

        async getSetting(key) {
            const r = await one('SELECT value FROM settings WHERE key = $1', [key]);
            return r ? r.value : null;
        },
        async setSetting(key, value) {
            await q(`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
                ON CONFLICT(key) DO UPDATE SET value = $2, updated_at = NOW()`, [key, value]);
        },
        async getAllSettings() {
            const rows = await all('SELECT key, value FROM settings');
            const result = {};
            for (const r of rows) result[r.key] = r.value;
            return result;
        },

        // ---- Branding Config ----

        async getBrandingConfig() {
            return all('SELECT key, value FROM branding_config');
        },
        async saveBrandingConfigBatch(entries) {
            const client = await getPool().connect();
            try {
                await client.query('BEGIN');
                for (const { key, value } of entries) {
                    await client.query(
                        `INSERT INTO branding_config (key, value, updated_at) VALUES ($1, $2, NOW())
                         ON CONFLICT(key) DO UPDATE SET value = $2, updated_at = NOW()`,
                        [key, value]
                    );
                }
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        },
        async resetBrandingConfig() {
            await q('DELETE FROM branding_config');
        },

        async getBrandingConfigRevision() {
            const rows = await all('SELECT MAX(updated_at) AS rev FROM branding_config');
            return rows[0]?.rev || null;
        },

        async listBrandingProfiles() {
            return all(
                'SELECT id, name, description, is_active, created_at, updated_at FROM branding_profiles ORDER BY name'
            );
        },

        async getBrandingProfile(id) {
            const rows = await all('SELECT * FROM branding_profiles WHERE id = $1', [id]);
            return rows[0] || null;
        },

        async createBrandingProfile(name, description, data) {
            const json = typeof data === 'string' ? data : JSON.stringify(data);
            const rows = await all(
                `INSERT INTO branding_profiles (name, description, data, created_at, updated_at)
                 VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id`,
                [name, description || '', json]
            );
            return rows[0]?.id;
        },

        async updateBrandingProfile(id, name, description, data) {
            const json = typeof data === 'string' ? data : JSON.stringify(data);
            await q(
                `UPDATE branding_profiles
                 SET name = $1, description = $2, data = $3, updated_at = NOW()
                 WHERE id = $4`,
                [name, description || '', json, id]
            );
        },

        async setActiveBrandingProfile(id) {
            const client = await getPool().connect();
            try {
                await client.query('BEGIN');
                await client.query('UPDATE branding_profiles SET is_active = 0');
                await client.query(
                    'UPDATE branding_profiles SET is_active = 1, updated_at = NOW() WHERE id = $1',
                    [id]
                );
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        },

        async deleteBrandingProfile(id) {
            await q('DELETE FROM branding_profiles WHERE id = $1', [id]);
        },

        // ---- Backup Helpers ----

        async getAllUsersForBackup() {
            // SELECT * captures every column (incl. totp_secret, totp_recovery_codes,
            // is_server_admin, org_id, preferred_language) so account restore is lossless.
            return all('SELECT * FROM users ORDER BY id');
        },
        async getAllAddressBooks() {
            return all('SELECT username, ab_type, data, updated_at FROM address_books ORDER BY username');
        },
        async restoreUsers(users) {
            const client = await getPool().connect();
            try {
                await client.query('BEGIN');
                // Restore dynamically against the live schema so backups from a
                // newer schema (extra columns) still import.
                const colRes = await client.query(
                    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='users'`
                );
                const cols = new Set(colRes.rows.map((r) => r.column_name));
                await client.query('DELETE FROM users');
                for (const u of users) {
                    const keys = Object.keys(u).filter((k) => cols.has(k));
                    if (keys.length === 0) continue;
                    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
                    const updates = keys.filter((k) => k !== 'id').map((k) => `"${k}"=EXCLUDED."${k}"`).join(', ');
                    await client.query(
                        `INSERT INTO users (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${placeholders})
                         ON CONFLICT(id) DO UPDATE SET ${updates || '"username"=EXCLUDED."username"'}`,
                        keys.map((k) => u[k])
                    );
                }
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        },
        async getBackupStats() {
            const c = async (tbl) => {
                try { return +(await one(`SELECT COUNT(*) AS c FROM ${tbl}`)).c; }
                catch (_) { return 0; }
            };
            return {
                users: await c('users'), settings: await c('settings'), folders: await c('folders'),
                userGroups: await c('user_groups'), deviceGroups: await c('device_groups'),
                strategies: await c('strategies'), addressBooks: await c('address_books'),
            };
        },

        /**
         * PostgreSQL has no single local DB file to copy — full backups fall
         * back to the portable logical dump instead. Returns null.
         */
        getDatabaseFilePath() {
            return null;
        },

        /**
         * Logical dump of every public table. BYTEA values are encoded as
         * { __buf__: <base64> } so they survive JSON serialisation.
         */
        async dumpAllTables() {
            const tableRows = await all(
                `SELECT table_name FROM information_schema.tables
                 WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`
            );
            const tables = {};
            for (const { table_name } of tableRows) {
                if (!/^[A-Za-z0-9_]+$/.test(table_name)) continue;
                try {
                    const rows = await all(`SELECT * FROM "${table_name}"`);
                    tables[table_name] = rows.map((row) => {
                        const out = {};
                        for (const [k, v] of Object.entries(row)) {
                            out[k] = Buffer.isBuffer(v) ? { __buf__: v.toString('base64') } : v;
                        }
                        return out;
                    });
                } catch (_) { /* skip unreadable table */ }
            }
            return { _engine: 'postgres', tables };
        },

        /**
         * Logical restore of tables produced by dumpAllTables(). Each table is
         * wiped and re-populated. Only existing tables/columns are touched.
         * @returns {{ restored: string[], skipped: string[], warnings: string[] }}
         */
        async importAllTables(dump) {
            const result = { restored: [], skipped: [], warnings: [] };
            const tables = (dump && dump.tables) || {};
            const client = await getPool().connect();
            try {
                const liveRes = await client.query(
                    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`
                );
                const liveTables = new Set(liveRes.rows.map((r) => r.table_name));
                // Relax FK ordering for the bulk reload (best-effort; ignored if not permitted).
                try { await client.query("SET session_replication_role = 'replica'"); } catch (_) { /* ignore */ }
                for (const [name, rows] of Object.entries(tables)) {
                    if (!liveTables.has(name) || !Array.isArray(rows) || !/^[A-Za-z0-9_]+$/.test(name)) {
                        result.skipped.push(name); continue;
                    }
                    const colRes = await client.query(
                        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
                        [name]
                    );
                    const cols = new Set(colRes.rows.map((r) => r.column_name));
                    try {
                        await client.query('BEGIN');
                        await client.query(`DELETE FROM "${name}"`);
                        for (const row of rows) {
                            const keys = Object.keys(row).filter((k) => cols.has(k));
                            if (keys.length === 0) continue;
                            const vals = keys.map((k) => {
                                const v = row[k];
                                if (v && typeof v === 'object' && typeof v.__buf__ === 'string') {
                                    return Buffer.from(v.__buf__, 'base64');
                                }
                                return v;
                            });
                            const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
                            await client.query(
                                `INSERT INTO "${name}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${placeholders})`,
                                vals
                            );
                        }
                        await client.query('COMMIT');
                        result.restored.push(name);
                    } catch (err) {
                        try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
                        result.warnings.push(`Table ${name}: ${err.message}`);
                    }
                }
                try { await client.query("SET session_replication_role = 'origin'"); } catch (_) { /* ignore */ }
            } finally {
                client.release();
            }
            return result;
        },

        // ---- Tickets ----

        async createTicket({ title, description, priority, category, deviceId, createdBy, assignedTo, slaDueAt }) {
            const r = await one(`
                INSERT INTO tickets (title, description, priority, category, device_id, created_by, assigned_to, sla_due_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id
            `, [title, description || '', priority || 'medium', category || 'general', deviceId || null, createdBy, assignedTo || null, slaDueAt || null]);
            return { id: r.id, title };
        },

        async getTicketById(id) { return one('SELECT * FROM tickets WHERE id = $1', [id]); },

        async getAllTickets(filters = {}) {
            let where = 'WHERE 1=1';
            const params = [];
            let idx = 1;
            if (filters.status) { where += ` AND status = $${idx++}`; params.push(filters.status); }
            if (filters.priority) { where += ` AND priority = $${idx++}`; params.push(filters.priority); }
            if (filters.category) { where += ` AND category = $${idx++}`; params.push(filters.category); }
            if (filters.assigned_to) { where += ` AND assigned_to = $${idx++}`; params.push(filters.assigned_to); }
            if (filters.device_id) { where += ` AND device_id = $${idx++}`; params.push(filters.device_id); }
            if (filters.created_by) { where += ` AND created_by = $${idx++}`; params.push(filters.created_by); }
            if (filters.search) { where += ` AND (title ILIKE $${idx} ESCAPE '\\' OR description ILIKE $${idx} ESCAPE '\\')`; params.push(`%${escapeLikePattern(filters.search)}%`); idx++; }
            return all(`SELECT * FROM tickets ${where} ORDER BY created_at DESC`, params);
        },

        async updateTicket(id, data) {
            const sets = [];
            const params = [];
            let idx = 1;
            for (const key of ['title', 'description', 'status', 'priority', 'category', 'assigned_to', 'sla_due_at']) {
                if (data[key] !== undefined) { sets.push(`${key} = $${idx++}`); params.push(data[key]); }
            }
            if (data.status === 'resolved') { sets.push('resolved_at = NOW()'); }
            if (data.status === 'closed') { sets.push('closed_at = NOW()'); }
            sets.push('updated_at = NOW()');
            params.push(id);
            await q(`UPDATE tickets SET ${sets.join(', ')} WHERE id = $${idx}`, params);
        },

        async deleteTicket(id) {
            await q('DELETE FROM ticket_comments WHERE ticket_id = $1', [id]);
            await q('DELETE FROM ticket_attachments WHERE ticket_id = $1', [id]);
            await q('DELETE FROM tickets WHERE id = $1', [id]);
        },

        async getTicketStats() {
            const r = await one(`
                SELECT COUNT(*) as total,
                    COUNT(*) FILTER (WHERE status = 'open') as open,
                    COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
                    COUNT(*) FILTER (WHERE status = 'resolved') as resolved,
                    COUNT(*) FILTER (WHERE status = 'closed') as closed
                FROM tickets
            `);
            return { total: +r.total, open: +r.open, in_progress: +r.in_progress, resolved: +r.resolved, closed: +r.closed };
        },

        async addTicketComment(ticketId, author, body, isInternal = false) {
            const r = await one(`INSERT INTO ticket_comments (ticket_id, author, body, is_internal) VALUES ($1, $2, $3, $4) RETURNING id`, [ticketId, author, body, !!isInternal]);
            await q('UPDATE tickets SET updated_at = NOW() WHERE id = $1', [ticketId]);
            return { id: r.id };
        },

        async getTicketComments(ticketId) { return all('SELECT * FROM ticket_comments WHERE ticket_id = $1 ORDER BY created_at ASC', [ticketId]); },

        async addTicketAttachment(ticketId, { filename, mimetype, sizeBytes, storagePath, uploadedBy }) {
            const r = await one(`INSERT INTO ticket_attachments (ticket_id, filename, mimetype, size_bytes, storage_path, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
                [ticketId, filename, mimetype || 'application/octet-stream', sizeBytes || 0, storagePath, uploadedBy]);
            return { id: r.id };
        },

        async getTicketAttachments(ticketId) { return all('SELECT * FROM ticket_attachments WHERE ticket_id = $1 ORDER BY created_at ASC', [ticketId]); },

        async getAttachmentById(id) { return one('SELECT * FROM ticket_attachments WHERE id = $1', [id]); },

        // ---- Inventory ----

        async upsertInventory(deviceId, hardware, software, collectedAt) {
            await q(`
                INSERT INTO device_inventory (device_id, hardware, software, collected_at, received_at)
                VALUES ($1, $2, $3, $4, NOW())
                ON CONFLICT(device_id) DO UPDATE SET
                    hardware = $2, software = $3, collected_at = $4, received_at = NOW()
            `, [deviceId, JSON.stringify(hardware), JSON.stringify(software || {}), collectedAt || new Date().toISOString()]);
        },

        async getInventory(deviceId) {
            const row = await one('SELECT * FROM device_inventory WHERE device_id = $1', [deviceId]);
            if (!row) return null;
            return {
                device_id: row.device_id,
                hardware: typeof row.hardware === 'object' ? row.hardware : JSON.parse(row.hardware || '{}'),
                software: typeof row.software === 'object' ? row.software : JSON.parse(row.software || '{}'),
                collected_at: row.collected_at,
                received_at: row.received_at,
            };
        },

        async getAllInventories() {
            return (await all('SELECT * FROM device_inventory ORDER BY received_at DESC')).map(row => ({
                device_id: row.device_id,
                hardware: typeof row.hardware === 'object' ? row.hardware : JSON.parse(row.hardware || '{}'),
                software: typeof row.software === 'object' ? row.software : JSON.parse(row.software || '{}'),
                collected_at: row.collected_at,
                received_at: row.received_at,
            }));
        },

        async upsertTelemetry(deviceId, data) {
            await q(`
                INSERT INTO device_telemetry (device_id, cpu_usage_percent, memory_used_bytes, memory_total_bytes, uptime_secs, timestamp, received_at)
                VALUES ($1, $2, $3, $4, $5, $6, NOW())
                ON CONFLICT(device_id) DO UPDATE SET
                    cpu_usage_percent = $2, memory_used_bytes = $3, memory_total_bytes = $4,
                    uptime_secs = $5, timestamp = $6, received_at = NOW()
            `, [deviceId, data.cpu_usage_percent ?? 0, data.memory_used_bytes ?? 0, data.memory_total_bytes ?? 0, data.uptime_secs ?? 0, data.timestamp || new Date().toISOString()]);
        },

        async getTelemetry(deviceId) {
            const row = await one('SELECT * FROM device_telemetry WHERE device_id = $1', [deviceId]);
            if (!row) return null;
            return {
                device_id: row.device_id,
                cpu_usage_percent: +row.cpu_usage_percent,
                memory_used_bytes: +row.memory_used_bytes,
                memory_total_bytes: +row.memory_total_bytes,
                uptime_secs: +row.uptime_secs,
                timestamp: row.timestamp,
                received_at: row.received_at,
            };
        },

        // ---- Relay sessions ----

        async createSession({ id, initiatorId, targetId, initiatorPk, expiresAt }) {
            await q(`INSERT INTO relay_sessions (id, initiator_id, target_id, initiator_pk, status, expires_at)
                VALUES ($1, $2, $3, $4, 'pending', $5)`, [id, initiatorId, targetId, initiatorPk || null, expiresAt]);
        },
        async getSession(id) { return one('SELECT * FROM relay_sessions WHERE id = $1 AND expires_at > NOW()', [id]); },
        async updateSession(id, data) {
            const sets = []; const params = []; let idx = 1;
            if (data.status !== undefined) { sets.push(`status = $${idx++}`); params.push(data.status); }
            if (data.target_pk !== undefined) { sets.push(`target_pk = $${idx++}`); params.push(data.target_pk); }
            if (!sets.length) return;
            params.push(id);
            await q(`UPDATE relay_sessions SET ${sets.join(', ')} WHERE id = $${idx}`, params);
        },
        async deleteSession(id) { await q('DELETE FROM relay_sessions WHERE id = $1', [id]); },
        async cleanupExpiredSessions() { await q('DELETE FROM relay_sessions WHERE expires_at < NOW()'); },

        // ---- Alert rules & automation ----

        async getAlertRules(filters = {}) {
            let sql = 'SELECT * FROM alert_rules WHERE 1=1';
            const params = [];
            let idx = 1;
            if (filters.enabled !== undefined) { sql += ` AND enabled = $${idx++}`; params.push(!!filters.enabled); }
            if (filters.condition_type) { sql += ` AND condition_type = $${idx++}`; params.push(filters.condition_type); }
            sql += ' ORDER BY created_at DESC';
            return all(sql, params);
        },

        async getAlertRuleById(id) {
            return one('SELECT * FROM alert_rules WHERE id = $1', [id]);
        },

        async createAlertRule(rule) {
            const row = await one(`
                INSERT INTO alert_rules (name, description, enabled, condition_type, condition_op, condition_value,
                    severity, scope_device_id, cooldown_secs, notify_emails, created_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *
            `, [rule.name, rule.description || '', rule.enabled !== false,
                rule.condition_type, rule.condition_op || 'gt', rule.condition_value || 0,
                rule.severity || 'warning', rule.scope_device_id || null,
                rule.cooldown_secs || 300, rule.notify_emails || '', rule.created_by || null]);
            return row;
        },

        async updateAlertRule(id, data) {
            const sets = [];
            const params = [];
            let idx = 1;
            for (const key of ['name', 'description', 'condition_type', 'condition_op', 'condition_value',
                'severity', 'scope_device_id', 'cooldown_secs', 'notify_emails']) {
                if (data[key] !== undefined) { sets.push(`${key} = $${idx++}`); params.push(data[key]); }
            }
            if (data.enabled !== undefined) { sets.push(`enabled = $${idx++}`); params.push(!!data.enabled); }
            if (!sets.length) return;
            sets.push('updated_at = NOW()');
            params.push(id);
            await q(`UPDATE alert_rules SET ${sets.join(', ')} WHERE id = $${idx}`, params);
        },

        async deleteAlertRule(id) {
            await q('DELETE FROM alert_rules WHERE id = $1', [id]);
        },

        async createAlert(alert) {
            return one(`
                INSERT INTO alert_history (rule_id, device_id, severity, message, triggered_at)
                VALUES ($1, $2, $3, $4, $5) RETURNING *
            `, [alert.rule_id, alert.device_id || null, alert.severity || 'warning',
                alert.message || '', alert.triggered_at || new Date().toISOString()]);
        },

        async getRecentAlert(ruleId, deviceId, cooldownSecs) {
            return one(`
                SELECT * FROM alert_history
                WHERE rule_id = $1 AND device_id = $2
                  AND triggered_at > NOW() - INTERVAL '1 second' * $3
                ORDER BY triggered_at DESC LIMIT 1
            `, [ruleId, deviceId, cooldownSecs]);
        },

        async getAlertHistory(filters = {}) {
            let sql = 'SELECT h.*, r.name as rule_name FROM alert_history h LEFT JOIN alert_rules r ON h.rule_id = r.id WHERE 1=1';
            const params = [];
            let idx = 1;
            if (filters.device_id) { sql += ` AND h.device_id = $${idx++}`; params.push(filters.device_id); }
            if (filters.severity) { sql += ` AND h.severity = $${idx++}`; params.push(filters.severity); }
            if (filters.acknowledged !== undefined) { sql += ` AND h.acknowledged = $${idx++}`; params.push(!!filters.acknowledged); }
            sql += ' ORDER BY h.triggered_at DESC';
            if (filters.limit) { sql += ` LIMIT $${idx++}`; params.push(filters.limit); }
            return all(sql, params);
        },

        async acknowledgeAlert(id, username) {
            await q('UPDATE alert_history SET acknowledged = TRUE, acknowledged_by = $1, acknowledged_at = NOW() WHERE id = $2', [username, id]);
        },

        // ---- Remote commands ----

        async createRemoteCommand(cmd) {
            return one(`
                INSERT INTO remote_commands (device_id, command_type, payload, status, created_by)
                VALUES ($1, $2, $3, 'pending', $4) RETURNING *
            `, [cmd.device_id, cmd.command_type || 'shell', cmd.payload || '', cmd.created_by || 'admin']);
        },

        async getPendingCommands(deviceId) {
            return all("SELECT * FROM remote_commands WHERE device_id = $1 AND status = 'pending' ORDER BY created_at ASC", [deviceId]);
        },

        async updateRemoteCommand(id, data) {
            const sets = [];
            const params = [];
            let idx = 1;
            if (data.status) { sets.push(`status = $${idx++}`); params.push(data.status); }
            if (data.result !== undefined) { sets.push(`result = $${idx++}`); params.push(data.result); }
            if (data.status === 'running') { sets.push('executed_at = NOW()'); }
            if (data.status === 'completed' || data.status === 'failed') { sets.push('completed_at = NOW()'); }
            if (!sets.length) return;
            params.push(id);
            await q(`UPDATE remote_commands SET ${sets.join(', ')} WHERE id = $${idx}`, params);
        },

        async getRemoteCommands(filters = {}) {
            let sql = 'SELECT * FROM remote_commands WHERE 1=1';
            const params = [];
            let idx = 1;
            if (filters.device_id) { sql += ` AND device_id = $${idx++}`; params.push(filters.device_id); }
            if (filters.status) { sql += ` AND status = $${idx++}`; params.push(filters.status); }
            sql += ' ORDER BY created_at DESC';
            if (filters.limit) { sql += ` LIMIT $${idx++}`; params.push(filters.limit); }
            return all(sql, params);
        },

        async getRemoteCommandById(id) {
            return one('SELECT * FROM remote_commands WHERE id = $1', [id]);
        },

        // ---- Activity monitoring ----

        async insertActivitySessions(deviceId, sessions) {
            const client = await getPool().connect();
            try {
                await client.query('BEGIN');
                for (const s of sessions) {
                    await client.query(`
                        INSERT INTO activity_sessions (device_id, app_name, window_title, category, started_at, ended_at, duration_secs)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                    `, [deviceId, s.app_name || '', s.window_title || '', s.category || 'other',
                        s.started_at, s.ended_at, s.duration_secs || 0]);
                }
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        },

        async upsertActivitySummary(deviceId, data) {
            await q(`
                INSERT INTO activity_summaries (device_id, idle_seconds, session_count, total_active_secs, reported_at, received_at)
                VALUES ($1, $2, $3, $4, $5, NOW())
                ON CONFLICT(device_id, reported_at) DO UPDATE SET
                    idle_seconds = $2, session_count = $3, total_active_secs = $4, received_at = NOW()
            `, [deviceId, data.idle_seconds ?? 0, data.session_count ?? 0,
                data.total_active_secs ?? 0, data.reported_at || new Date().toISOString()]);
        },

        async getActivitySessions(deviceId, { from, to, limit } = {}) {
            let sql = 'SELECT * FROM activity_sessions WHERE device_id = $1';
            const params = [deviceId];
            let idx = 2;
            if (from) { sql += ` AND started_at >= $${idx++}`; params.push(from); }
            if (to) { sql += ` AND ended_at <= $${idx++}`; params.push(to); }
            sql += ' ORDER BY started_at DESC';
            if (limit) { sql += ` LIMIT $${idx++}`; params.push(limit); }
            return all(sql, params);
        },

        async getActivitySummaries(deviceId, { from, to } = {}) {
            let sql = 'SELECT * FROM activity_summaries WHERE device_id = $1';
            const params = [deviceId];
            let idx = 2;
            if (from) { sql += ` AND reported_at >= $${idx++}`; params.push(from); }
            if (to) { sql += ` AND reported_at <= $${idx++}`; params.push(to); }
            sql += ' ORDER BY reported_at DESC';
            return all(sql, params);
        },

        async getAllActivitySummaries({ from, to } = {}) {
            let sql = `SELECT s.*, (
                SELECT COUNT(*) FROM activity_sessions a
                WHERE a.device_id = s.device_id
                  AND a.started_at >= s.reported_at
            ) as detail_count
            FROM activity_summaries s WHERE 1=1`;
            const params = [];
            let idx = 1;
            if (from) { sql += ` AND s.reported_at >= $${idx++}`; params.push(from); }
            if (to) { sql += ` AND s.reported_at <= $${idx++}`; params.push(to); }
            sql += ' ORDER BY s.received_at DESC';
            return all(sql, params);
        },

        async getTopApps(deviceId, { from, to, limit } = {}) {
            let sql = `SELECT app_name, category,
                SUM(duration_secs) as total_secs,
                COUNT(*) as session_count
            FROM activity_sessions WHERE device_id = $1`;
            const params = [deviceId];
            let idx = 2;
            if (from) { sql += ` AND started_at >= $${idx++}`; params.push(from); }
            if (to) { sql += ` AND ended_at <= $${idx++}`; params.push(to); }
            sql += ' GROUP BY app_name, category ORDER BY total_secs DESC';
            if (limit) { sql += ` LIMIT $${idx++}`; params.push(limit || 10); }
            return all(sql, params);
        },

        // ---- Network monitoring ----

        async getNetworkTargets(filters = {}) {
            let sql = 'SELECT * FROM network_targets WHERE 1=1';
            const params = [];
            let idx = 1;
            if (filters.enabled !== undefined) { sql += ` AND enabled = $${idx++}`; params.push(!!filters.enabled); }
            if (filters.check_type) { sql += ` AND check_type = $${idx++}`; params.push(filters.check_type); }
            sql += ' ORDER BY name';
            return all(sql, params);
        },
        async getNetworkTargetById(id) {
            return one('SELECT * FROM network_targets WHERE id = $1', [id]);
        },
        async createNetworkTarget(data) {
            const r = await one(`
                INSERT INTO network_targets (name, host, port, url, check_type, timeout_ms, interval_ms, enabled)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *
            `, [data.name, data.host, data.port, data.url, data.check_type,
                data.timeout_ms || 5000, data.interval_ms || 60000, data.enabled !== false]);
            return r;
        },
        async updateNetworkTarget(id, data) {
            const sets = [];
            const params = [];
            let idx = 1;
            if (data.name !== undefined) { sets.push(`name = $${idx++}`); params.push(data.name); }
            if (data.host !== undefined) { sets.push(`host = $${idx++}`); params.push(data.host); }
            if (data.port !== undefined) { sets.push(`port = $${idx++}`); params.push(data.port); }
            if (data.url !== undefined) { sets.push(`url = $${idx++}`); params.push(data.url); }
            if (data.check_type !== undefined) { sets.push(`check_type = $${idx++}`); params.push(data.check_type); }
            if (data.timeout_ms !== undefined) { sets.push(`timeout_ms = $${idx++}`); params.push(data.timeout_ms); }
            if (data.interval_ms !== undefined) { sets.push(`interval_ms = $${idx++}`); params.push(data.interval_ms); }
            if (data.enabled !== undefined) { sets.push(`enabled = $${idx++}`); params.push(!!data.enabled); }
            if (data.last_status !== undefined) { sets.push(`last_status = $${idx++}`); params.push(data.last_status); }
            if (data.last_check_at !== undefined) { sets.push(`last_check_at = $${idx++}`); params.push(data.last_check_at); }
            if (data.last_rtt_ms !== undefined) { sets.push(`last_rtt_ms = $${idx++}`); params.push(data.last_rtt_ms); }
            if (!sets.length) return null;
            sets.push('updated_at = NOW()');
            params.push(id);
            return one(`UPDATE network_targets SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, params);
        },
        async deleteNetworkTarget(id) {
            const r = await q('DELETE FROM network_targets WHERE id = $1', [id]);
            return r.rowCount > 0;
        },
        async insertNetworkCheck(data) {
            await q(`
                INSERT INTO network_checks (target_id, status, rtt_ms, status_code, error_msg)
                VALUES ($1, $2, $3, $4, $5)
            `, [data.target_id, data.status, data.rtt_ms, data.status_code, data.error_msg]);
        },
        async getNetworkCheckHistory(targetId, { limit, from, to } = {}) {
            let sql = 'SELECT * FROM network_checks WHERE target_id = $1';
            const params = [targetId];
            let idx = 2;
            if (from) { sql += ` AND checked_at >= $${idx++}`; params.push(from); }
            if (to) { sql += ` AND checked_at <= $${idx++}`; params.push(to); }
            sql += ' ORDER BY checked_at DESC';
            if (limit) { sql += ` LIMIT $${idx++}`; params.push(limit); }
            return all(sql, params);
        },

        // -- DataGuard / DLP -------------------------------------------------
        async getDlpPolicies() {
            return all('SELECT * FROM dlp_policies ORDER BY id');
        },
        async getDlpPolicyById(id) {
            return one('SELECT * FROM dlp_policies WHERE id = $1', [id]);
        },
        async createDlpPolicy(data) {
            const rules = typeof data.rules === 'string' ? data.rules : JSON.stringify(data.rules || []);
            return one(`
                INSERT INTO dlp_policies (name, description, policy_type, action, scope, enabled, rules)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING *
            `, [
                data.name,
                data.description || '',
                data.policy_type || '',
                data.action || 'log',
                data.scope || '',
                data.enabled !== undefined ? data.enabled : true,
                rules
            ]);
        },
        async updateDlpPolicy(id, data) {
            const sets = [];
            const params = [];
            let idx = 1;
            if (data.name !== undefined) { sets.push(`name = $${idx++}`); params.push(data.name); }
            if (data.description !== undefined) { sets.push(`description = $${idx++}`); params.push(data.description); }
            if (data.policy_type !== undefined) { sets.push(`policy_type = $${idx++}`); params.push(data.policy_type); }
            if (data.action !== undefined) { sets.push(`action = $${idx++}`); params.push(data.action); }
            if (data.scope !== undefined) { sets.push(`scope = $${idx++}`); params.push(data.scope); }
            if (data.enabled !== undefined) { sets.push(`enabled = $${idx++}`); params.push(!!data.enabled); }
            if (data.rules !== undefined) {
                sets.push(`rules = $${idx++}`);
                params.push(typeof data.rules === 'string' ? data.rules : JSON.stringify(data.rules));
            }
            if (!sets.length) return null;
            sets.push(`updated_at = NOW()`);
            params.push(id);
            return one(`UPDATE dlp_policies SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, params);
        },
        async deleteDlpPolicy(id) {
            const { rowCount } = await q('DELETE FROM dlp_policies WHERE id = $1', [id]);
            return rowCount > 0;
        },
        async insertDlpEvent(data) {
            const details = typeof data.details === 'string' ? data.details : JSON.stringify(data.details || {});
            return one(`
                INSERT INTO dlp_events (device_id, event_source, event_type, policy_id, policy_name, action, details)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING id
            `, [
                data.device_id,
                data.event_source || 'unknown',
                data.event_type || 'info',
                data.policy_id || null,
                data.policy_name || '',
                data.action || 'log',
                details
            ]);
        },
        async getDlpEvents({ device_id, event_source, event_type, limit, from, to } = {}) {
            let sql = 'SELECT * FROM dlp_events WHERE 1=1';
            const params = [];
            let idx = 1;
            if (device_id) { sql += ` AND device_id = $${idx++}`; params.push(device_id); }
            if (event_source) { sql += ` AND event_source = $${idx++}`; params.push(event_source); }
            if (event_type) { sql += ` AND event_type = $${idx++}`; params.push(event_type); }
            if (from) { sql += ` AND created_at >= $${idx++}`; params.push(from); }
            if (to) { sql += ` AND created_at <= $${idx++}`; params.push(to); }
            sql += ' ORDER BY created_at DESC';
            if (limit) { sql += ` LIMIT $${idx++}`; params.push(limit); }
            return all(sql, params);
        },
        async getDlpEventStats() {
            return one(`
                SELECT
                    COUNT(*)::INTEGER AS total,
                    COUNT(*) FILTER (WHERE action = 'block')::INTEGER AS blocked,
                    COUNT(*) FILTER (WHERE action = 'log')::INTEGER AS logged,
                    COUNT(*) FILTER (WHERE event_source = 'usb')::INTEGER AS usb_events,
                    COUNT(*) FILTER (WHERE event_source = 'file')::INTEGER AS file_events
                FROM dlp_events
            `);
        },

        // -- Saved Reports ----------------------------------------------------
        async getSavedReports() {
            return all('SELECT * FROM saved_reports ORDER BY created_at DESC');
        },
        async getSavedReportById(id) {
            return one('SELECT * FROM saved_reports WHERE id = $1', [id]);
        },
        async createSavedReport(data) {
            return one(`
                INSERT INTO saved_reports (title, report_type, filters, payload, created_by)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING *
            `, [data.title, data.report_type, data.filters || '{}', data.payload || '{}', data.created_by || 'admin']);
        },
        async deleteSavedReport(id) {
            const { rowCount } = await q('DELETE FROM saved_reports WHERE id = $1', [id]);
            return rowCount > 0;
        },

        // -- Multi-Tenancy ----------------------------------------------------
        async getTenants() {
            return all('SELECT * FROM tenants ORDER BY name');
        },
        async getTenantById(id) {
            return one('SELECT * FROM tenants WHERE id = $1', [id]);
        },
        async createTenant(data) {
            return one(`
                INSERT INTO tenants (name, slug, contact_name, contact_email, max_devices, notes, active)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING *
            `, [
                data.name, data.slug, data.contact_name || '', data.contact_email || '',
                data.max_devices || 0, data.notes || '', data.active !== undefined ? data.active : true
            ]);
        },
        async updateTenant(id, data) {
            const sets = [];
            const params = [];
            let idx = 1;
            if (data.name !== undefined) { sets.push(`name = $${idx++}`); params.push(data.name); }
            if (data.slug !== undefined) { sets.push(`slug = $${idx++}`); params.push(data.slug); }
            if (data.contact_name !== undefined) { sets.push(`contact_name = $${idx++}`); params.push(data.contact_name); }
            if (data.contact_email !== undefined) { sets.push(`contact_email = $${idx++}`); params.push(data.contact_email); }
            if (data.max_devices !== undefined) { sets.push(`max_devices = $${idx++}`); params.push(data.max_devices); }
            if (data.notes !== undefined) { sets.push(`notes = $${idx++}`); params.push(data.notes); }
            if (data.active !== undefined) { sets.push(`active = $${idx++}`); params.push(!!data.active); }
            if (!sets.length) return this.getTenantById(id);
            sets.push('updated_at = NOW()');
            params.push(id);
            return one(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, params);
        },
        async deleteTenant(id) {
            const { rowCount } = await q('DELETE FROM tenants WHERE id = $1', [id]);
            return rowCount > 0;
        },
        async getTenantDevices(tenantId) {
            const rows = await all(`
                SELECT td.device_id, td.assigned_at, p.info, p.note, p.status_online, p.ip
                FROM tenant_devices td
                LEFT JOIN peer p ON p.id = td.device_id AND (NOT p.is_deleted OR p.is_deleted IS NULL)
                WHERE td.tenant_id = $1
                ORDER BY td.assigned_at DESC
            `, [tenantId]);
            return rows.map(r => ({
                device_id: r.device_id,
                assigned_at: r.assigned_at,
                online: !!r.status_online,
                hostname: r.note || '',
                ip: r.ip || '',
            }));
        },
        async assignDeviceToTenant(tenantId, deviceId) {
            try {
                await q(`
                    INSERT INTO tenant_devices (tenant_id, device_id) VALUES ($1, $2)
                    ON CONFLICT (tenant_id, device_id) DO NOTHING
                `, [tenantId, deviceId]);
                return true;
            } catch (_) { return false; }
        },
        async removeDeviceFromTenant(tenantId, deviceId) {
            const { rowCount } = await q('DELETE FROM tenant_devices WHERE tenant_id = $1 AND device_id = $2', [tenantId, deviceId]);
            return rowCount > 0;
        },
        async getTenantUsers(tenantId) {
            return all(`
                SELECT tu.user_id, tu.assigned_at
                FROM tenant_users tu
                WHERE tu.tenant_id = $1
                ORDER BY tu.assigned_at DESC
            `, [tenantId]);
        },
        async assignUserToTenant(tenantId, userId) {
            try {
                await q(`
                    INSERT INTO tenant_users (tenant_id, user_id) VALUES ($1, $2)
                    ON CONFLICT (tenant_id, user_id) DO NOTHING
                `, [tenantId, userId]);
                return true;
            } catch (_) { return false; }
        },
        async removeUserFromTenant(tenantId, userId) {
            const { rowCount } = await q('DELETE FROM tenant_users WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]);
            return rowCount > 0;
        },

        // ---- Pending Registrations ----

        async getPendingRegistrations(filters = {}) {
            let sql = 'SELECT * FROM pending_registrations WHERE 1=1';
            const params = [];
            let idx = 1;
            if (filters.status) { sql += ` AND status = $${idx++}`; params.push(filters.status); }
            if (filters.search) {
                sql += ` AND (device_id ILIKE $${idx} OR hostname ILIKE $${idx} OR ip_address ILIKE $${idx})`;
                params.push(`%${filters.search}%`);
                idx++;
            }
            sql += ' ORDER BY created_at DESC';
            return all(sql, params);
        },

        async getPendingRegistrationById(id) {
            return one('SELECT * FROM pending_registrations WHERE id = $1', [id]);
        },

        async getPendingRegistrationByDeviceId(deviceId) {
            return one('SELECT * FROM pending_registrations WHERE device_id = $1', [deviceId]);
        },

        async createPendingRegistration(data) {
            // Upsert: if already approved, return existing; otherwise update/insert
            const existing = await one('SELECT id, status FROM pending_registrations WHERE device_id = $1', [data.device_id]);
            if (existing) {
                if (existing.status === 'approved') {
                    return one('SELECT * FROM pending_registrations WHERE id = $1', [existing.id]);
                }
                return one(`
                    UPDATE pending_registrations
                    SET hostname = $1, platform = $2, version = $3, ip_address = $4, public_key = $5, uuid = $6,
                        status = 'pending', rejected_reason = '', updated_at = NOW()
                    WHERE id = $7
                    RETURNING *
                `, [data.hostname || '', data.platform || '', data.version || '', data.ip_address || '', data.public_key || '', data.uuid || '', existing.id]);
            }
            return one(`
                INSERT INTO pending_registrations (device_id, hostname, platform, version, ip_address, public_key, uuid)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING *
            `, [data.device_id, data.hostname || '', data.platform || '', data.version || '', data.ip_address || '', data.public_key || '', data.uuid || '']);
        },

        async approvePendingRegistration(id, approvedBy, serverConfig = {}) {
            return one(`
                UPDATE pending_registrations
                SET status = 'approved', approved_by = $1, approved_at = NOW(),
                    access_token = $2, console_url = $3, server_address = $4, server_key = $5,
                    updated_at = NOW()
                WHERE id = $6 AND status = 'pending'
                RETURNING *
            `, [approvedBy || 'admin', serverConfig.access_token || null, serverConfig.console_url || null, serverConfig.server_address || null, serverConfig.server_key || null, id]);
        },

        async rejectPendingRegistration(id, reason = '') {
            return one(`
                UPDATE pending_registrations
                SET status = 'rejected', rejected_reason = $1, updated_at = NOW()
                WHERE id = $2 AND status = 'pending'
                RETURNING *
            `, [reason, id]);
        },

        async deletePendingRegistration(id) {
            const { rowCount } = await q('DELETE FROM pending_registrations WHERE id = $1', [id]);
            return rowCount > 0;
        },

        async getPendingRegistrationCount() {
            const row = await one("SELECT COUNT(*)::INTEGER AS count FROM pending_registrations WHERE status = 'pending'");
            return row ? row.count : 0;
        },

        // ---- Peer Sysinfo ----

        async upsertPeerSysinfo(peerId, data) {
            await q(`
                INSERT INTO peer_sysinfo (peer_id, hostname, username, platform, version,
                    cpu_name, cpu_cores, cpu_freq_ghz, memory_gb, os_full,
                    displays, encoding, features, platform_additions, raw_json, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
                ON CONFLICT(peer_id) DO UPDATE SET
                    hostname = EXCLUDED.hostname, username = EXCLUDED.username,
                    platform = EXCLUDED.platform, version = EXCLUDED.version,
                    cpu_name = EXCLUDED.cpu_name, cpu_cores = EXCLUDED.cpu_cores,
                    cpu_freq_ghz = EXCLUDED.cpu_freq_ghz, memory_gb = EXCLUDED.memory_gb,
                    os_full = EXCLUDED.os_full, displays = EXCLUDED.displays,
                    encoding = EXCLUDED.encoding, features = EXCLUDED.features,
                    platform_additions = EXCLUDED.platform_additions,
                    raw_json = EXCLUDED.raw_json, updated_at = NOW()
            `, [peerId,
                data.hostname || '', data.username || '', data.platform || '', data.version || '',
                data.cpu_name || '', data.cpu_cores || 0, data.cpu_freq_ghz || 0, data.memory_gb || 0,
                data.os_full || '',
                JSON.stringify(data.displays || []), JSON.stringify(data.encoding || []),
                JSON.stringify(data.features || {}), JSON.stringify(data.platform_additions || {}),
                JSON.stringify(data)
            ]);
        },

        async getPeerSysinfo(peerId) {
            const row = await one('SELECT * FROM peer_sysinfo WHERE peer_id = $1', [peerId]);
            if (!row) return null;
            return parseSysinfoRow(row);
        },

        async getAllPeerSysinfo() {
            return (await all('SELECT * FROM peer_sysinfo')).map(parseSysinfoRow);
        },

        // ---- Peer Metrics ----

        async updatePeerOnlineStatus(peerId) {
            await q('UPDATE peer SET status_online = TRUE, last_online = NOW() WHERE id = $1', [peerId]);
        },

        async cleanupStaleOnlinePeers(thresholdSeconds = 90) {
            const r = await q(`
                UPDATE peer SET status_online = FALSE
                WHERE status_online = TRUE
                  AND last_online IS NOT NULL
                  AND last_online < NOW() - INTERVAL '1 second' * $1
            `, [thresholdSeconds]);
            return { changes: r.rowCount };
        },

        async insertPeerMetric(peerId, cpuUsage, memoryUsage, diskUsage) {
            await q('INSERT INTO peer_metrics (peer_id, cpu_usage, memory_usage, disk_usage) VALUES ($1, $2, $3, $4)',
                [peerId, cpuUsage || 0, memoryUsage || 0, diskUsage || 0]);
        },

        async getPeerMetrics(peerId, limit = 100) {
            return all('SELECT * FROM peer_metrics WHERE peer_id = $1 ORDER BY created_at DESC LIMIT $2', [peerId, limit]);
        },

        async getLatestPeerMetric(peerId) {
            return one('SELECT * FROM peer_metrics WHERE peer_id = $1 ORDER BY created_at DESC LIMIT 1', [peerId]);
        },

        async cleanupOldMetrics(days = 7) {
            const safeDays = Math.max(1, parseInt(days, 10) || 7);
            await q("DELETE FROM peer_metrics WHERE created_at < NOW() - INTERVAL '1 day' * $1", [safeDays]);
        },

        // ---- Audit: Connections ----

        async insertAuditConnection(data) {
            await q(`
                INSERT INTO audit_connections (host_id, host_uuid, peer_id, peer_name, action, conn_type, session_id, ip)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `, [data.host_id || '', data.host_uuid || '', data.peer_id || '', data.peer_name || '',
                data.action || '', data.conn_type || 0, data.session_id || '', data.ip || '']);
        },

        async getAuditConnections(filters = {}) {
            let sql = 'SELECT * FROM audit_connections WHERE 1=1';
            const params = [];
            let idx = 1;
            if (filters.host_id) { sql += ` AND host_id = $${idx++}`; params.push(filters.host_id); }
            if (filters.peer_id) { sql += ` AND peer_id = $${idx++}`; params.push(filters.peer_id); }
            if (filters.action) { sql += ` AND action = $${idx++}`; params.push(filters.action); }
            sql += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
            params.push(filters.limit || 100, filters.offset || 0);
            return all(sql, params);
        },

        async countAuditConnections(filters = {}) {
            let sql = 'SELECT COUNT(*)::INTEGER AS count FROM audit_connections WHERE 1=1';
            const params = [];
            let idx = 1;
            if (filters.host_id) { sql += ` AND host_id = $${idx++}`; params.push(filters.host_id); }
            if (filters.peer_id) { sql += ` AND peer_id = $${idx++}`; params.push(filters.peer_id); }
            if (filters.action) { sql += ` AND action = $${idx++}`; params.push(filters.action); }
            return +(await one(sql, params)).count;
        },

        // ---- Audit: File Transfers ----

        async insertAuditFile(data) {
            await q(`
                INSERT INTO audit_files (host_id, host_uuid, peer_id, direction, path, is_file, num_files, files_json, ip, peer_name)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [data.host_id || '', data.host_uuid || '', data.peer_id || '',
                data.direction || 0, data.path || '', data.is_file !== undefined ? data.is_file : true,
                data.num_files || 0, JSON.stringify(data.files || []), data.ip || '', data.peer_name || '']);
        },

        async getAuditFiles(filters = {}) {
            let sql = 'SELECT * FROM audit_files WHERE 1=1';
            const params = [];
            let idx = 1;
            if (filters.host_id) { sql += ` AND host_id = $${idx++}`; params.push(filters.host_id); }
            if (filters.peer_id) { sql += ` AND peer_id = $${idx++}`; params.push(filters.peer_id); }
            sql += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
            params.push(filters.limit || 100, filters.offset || 0);
            return all(sql, params);
        },

        async countAuditFiles(filters = {}) {
            let sql = 'SELECT COUNT(*)::INTEGER AS count FROM audit_files WHERE 1=1';
            const params = [];
            let idx = 1;
            if (filters.host_id) { sql += ` AND host_id = $${idx++}`; params.push(filters.host_id); }
            if (filters.peer_id) { sql += ` AND peer_id = $${idx++}`; params.push(filters.peer_id); }
            return +(await one(sql, params)).count;
        },

        // ---- Audit: Security Alarms ----

        async insertAuditAlarm(data) {
            await q(`
                INSERT INTO audit_alarms (alarm_type, alarm_name, host_id, peer_id, ip, details)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [data.alarm_type || 0, data.alarm_name || '', data.host_id || '',
                data.peer_id || '', data.ip || '',
                typeof data.details === 'string' ? data.details : JSON.stringify(data.details || {})]);
        },

        async getAuditAlarms(filters = {}) {
            let sql = 'SELECT * FROM audit_alarms WHERE 1=1';
            const params = [];
            let idx = 1;
            if (filters.alarm_type !== undefined) { sql += ` AND alarm_type = $${idx++}`; params.push(filters.alarm_type); }
            if (filters.host_id) { sql += ` AND host_id = $${idx++}`; params.push(filters.host_id); }
            sql += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
            params.push(filters.limit || 100, filters.offset || 0);
            return all(sql, params);
        },

        async countAuditAlarms(filters = {}) {
            let sql = 'SELECT COUNT(*)::INTEGER AS count FROM audit_alarms WHERE 1=1';
            const params = [];
            let idx = 1;
            if (filters.alarm_type !== undefined) { sql += ` AND alarm_type = $${idx++}`; params.push(filters.alarm_type); }
            if (filters.host_id) { sql += ` AND host_id = $${idx++}`; params.push(filters.host_id); }
            return +(await one(sql, params)).count;
        },

        // ---- User Groups ----

        async getAllUserGroups() {
            const groups = await all('SELECT * FROM user_groups ORDER BY name ASC');
            for (const group of groups) {
                group.member_count = +(await one('SELECT COUNT(*)::INTEGER AS c FROM user_group_members WHERE user_group_id = $1', [group.id])).c;
            }
            return groups;
        },

        async getUserGroupByGuid(guid) {
            return one('SELECT * FROM user_groups WHERE guid = $1', [guid]);
        },

        async createUserGroup(data) {
            const crypto = require('crypto');
            const guid = data.guid || crypto.randomUUID();
            return one('INSERT INTO user_groups (guid, name, note, team_id) VALUES ($1, $2, $3, $4) RETURNING *',
                [guid, data.name, data.note || '', data.team_id || '']);
        },

        async updateUserGroup(guid, data) {
            const sets = []; const params = []; let idx = 1;
            if (data.name !== undefined) { sets.push(`name = $${idx++}`); params.push(data.name); }
            if (data.note !== undefined) { sets.push(`note = $${idx++}`); params.push(data.note); }
            if (data.team_id !== undefined) { sets.push(`team_id = $${idx++}`); params.push(data.team_id); }
            if (!sets.length) return null;
            params.push(guid);
            return one(`UPDATE user_groups SET ${sets.join(', ')} WHERE guid = $${idx} RETURNING *`, params);
        },

        async deleteUserGroup(guid) {
            const group = await one('SELECT id FROM user_groups WHERE guid = $1', [guid]);
            if (!group) return;
            await q('DELETE FROM user_group_members WHERE user_group_id = $1', [group.id]);
            await q('DELETE FROM device_group_user_group_access WHERE user_group_id = $1', [group.id]);
            await q('DELETE FROM user_groups WHERE guid = $1', [guid]);
        },

        async getUserGroupsForUser(userId) {
            return all(`
                SELECT ug.* FROM user_groups ug
                INNER JOIN user_group_members ugm ON ug.id = ugm.user_group_id
                WHERE ugm.user_id = $1
                ORDER BY ug.name ASC
            `, [userId]);
        },

        async setUserGroupMemberships(userId, groupGuids = []) {
            const user = await one('SELECT id FROM users WHERE id = $1', [userId]);
            if (!user) return [];
            const uniqueGuids = Array.from(new Set((groupGuids || []).map(v => String(v || '').trim()).filter(Boolean))).slice(0, 100);
            const client = await getPool().connect();
            try {
                await client.query('BEGIN');
                await client.query('DELETE FROM user_group_members WHERE user_id = $1', [user.id]);
                for (const guid of uniqueGuids) {
                    const result = await client.query('SELECT id FROM user_groups WHERE guid = $1', [guid]);
                    const group = result.rows[0];
                    if (group) {
                        await client.query(
                            'INSERT INTO user_group_members (user_group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                            [group.id, user.id]
                        );
                    }
                }
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
            return this.getUserGroupsForUser(user.id);
        },

        // ---- Device Groups ----

        async getAllDeviceGroups() {
            const groups = await all('SELECT * FROM device_groups ORDER BY name ASC');
            for (const g of groups) {
                g.member_count = +(await one('SELECT COUNT(*)::INTEGER AS c FROM device_group_members WHERE device_group_id = $1', [g.id])).c;
                g.source_type = g.source_type || 'manual';
                g.tag_filter = g.tag_filter || '';
                g.allowed_users = (await all(`
                    SELECT u.username FROM device_group_user_access a
                    INNER JOIN users u ON u.id = a.user_id
                    WHERE a.device_group_id = $1
                    ORDER BY u.username ASC
                `, [g.id])).map(r => r.username);
                const allowedGroups = await all(`
                    SELECT ug.guid, ug.name FROM device_group_user_group_access a
                    INNER JOIN user_groups ug ON ug.id = a.user_group_id
                    WHERE a.device_group_id = $1
                    ORDER BY ug.name ASC
                `, [g.id]);
                g.allowed_groups = allowedGroups.map(r => r.guid);
                g.allowed_user_groups = allowedGroups;
            }
            return groups;
        },

        async getDeviceGroupByGuid(guid) {
            const group = await one('SELECT * FROM device_groups WHERE guid = $1', [guid]);
            if (!group) return null;
            group.source_type = group.source_type || 'manual';
            group.tag_filter = group.tag_filter || '';
            group.allowed_users = (await all(`
                SELECT u.username FROM device_group_user_access a
                INNER JOIN users u ON u.id = a.user_id
                WHERE a.device_group_id = $1
                ORDER BY u.username ASC
            `, [group.id])).map(r => r.username);
            const allowedGroups = await all(`
                SELECT ug.guid, ug.name FROM device_group_user_group_access a
                INNER JOIN user_groups ug ON ug.id = a.user_group_id
                WHERE a.device_group_id = $1
                ORDER BY ug.name ASC
            `, [group.id]);
            group.allowed_groups = allowedGroups.map(r => r.guid);
            group.allowed_user_groups = allowedGroups;
            return group;
        },

        async createDeviceGroup(data) {
            const crypto = require('crypto');
            const guid = data.guid || crypto.randomUUID();
            return one(`
                INSERT INTO device_groups (guid, name, note, team_id, source_type, tag_filter)
                VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
            `, [
                guid,
                data.name,
                data.note || '',
                data.team_id || '',
                data.source_type === 'tag' ? 'tag' : 'manual',
                data.source_type === 'tag' ? (data.tag_filter || '') : ''
            ]);
        },

        async updateDeviceGroup(guid, data) {
            const sets = []; const params = []; let idx = 1;
            if (data.name !== undefined) { sets.push(`name = $${idx++}`); params.push(data.name); }
            if (data.note !== undefined) { sets.push(`note = $${idx++}`); params.push(data.note); }
            if (data.team_id !== undefined) { sets.push(`team_id = $${idx++}`); params.push(data.team_id); }
            if (data.source_type !== undefined) { sets.push(`source_type = $${idx++}`); params.push(data.source_type === 'tag' ? 'tag' : 'manual'); }
            if (data.tag_filter !== undefined) { sets.push(`tag_filter = $${idx++}`); params.push(String(data.tag_filter || '').slice(0, 50)); }
            if (!sets.length) return null;
            params.push(guid);
            return one(`UPDATE device_groups SET ${sets.join(', ')} WHERE guid = $${idx} RETURNING *`, params);
        },

        async deleteDeviceGroup(guid) {
            const group = await one('SELECT id FROM device_groups WHERE guid = $1', [guid]);
            if (!group) return;
            await q('DELETE FROM device_group_members WHERE device_group_id = $1', [group.id]);
            await q('DELETE FROM device_group_user_access WHERE device_group_id = $1', [group.id]);
            await q('DELETE FROM device_group_user_group_access WHERE device_group_id = $1', [group.id]);
            await q('DELETE FROM device_groups WHERE guid = $1', [guid]);
        },

        async addDeviceToGroup(groupGuid, peerId) {
            const group = await one('SELECT id FROM device_groups WHERE guid = $1', [groupGuid]);
            if (!group) return null;
            await q('INSERT INTO device_group_members (device_group_id, peer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [group.id, peerId]);
        },

        async removeDeviceFromGroup(groupGuid, peerId) {
            const group = await one('SELECT id FROM device_groups WHERE guid = $1', [groupGuid]);
            if (!group) return null;
            await q('DELETE FROM device_group_members WHERE device_group_id = $1 AND peer_id = $2', [group.id, peerId]);
        },

        async getDeviceGroupMembers(groupGuid) {
            const group = await one('SELECT id FROM device_groups WHERE guid = $1', [groupGuid]);
            if (!group) return [];
            return (await all('SELECT peer_id FROM device_group_members WHERE device_group_id = $1', [group.id])).map(r => r.peer_id);
        },

        async getDeviceGroupsForPeer(peerId) {
            return all(`
                SELECT dg.* FROM device_groups dg
                INNER JOIN device_group_members dgm ON dg.id = dgm.device_group_id
                WHERE dgm.peer_id = $1
                ORDER BY dg.name ASC
            `, [peerId]);
        },

        async setDeviceGroupUserAccess(groupGuid, usernames = []) {
            const group = await one('SELECT id FROM device_groups WHERE guid = $1', [groupGuid]);
            if (!group) return null;
            const uniqueNames = Array.from(new Set((usernames || []).map(v => String(v || '').trim()).filter(Boolean)));
            const client = await getPool().connect();
            try {
                await client.query('BEGIN');
                await client.query('DELETE FROM device_group_user_access WHERE device_group_id = $1', [group.id]);
                for (const username of uniqueNames) {
                    const result = await client.query('SELECT id FROM users WHERE username = $1', [username]);
                    const user = result.rows[0];
                    if (user) {
                        await client.query(
                            'INSERT INTO device_group_user_access (device_group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                            [group.id, user.id]
                        );
                    }
                }
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
            return this.getDeviceGroupByGuid(groupGuid);
        },

        async setDeviceGroupUserGroupAccess(groupGuid, groupGuids = []) {
            const group = await one('SELECT id FROM device_groups WHERE guid = $1', [groupGuid]);
            if (!group) return null;
            const uniqueGuids = Array.from(new Set((groupGuids || []).map(v => String(v || '').trim()).filter(Boolean))).slice(0, 100);
            const client = await getPool().connect();
            try {
                await client.query('BEGIN');
                await client.query('DELETE FROM device_group_user_group_access WHERE device_group_id = $1', [group.id]);
                for (const guid of uniqueGuids) {
                    const result = await client.query('SELECT id FROM user_groups WHERE guid = $1', [guid]);
                    const userGroup = result.rows[0];
                    if (userGroup) {
                        await client.query(
                            'INSERT INTO device_group_user_group_access (device_group_id, user_group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                            [group.id, userGroup.id]
                        );
                    }
                }
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
            return this.getDeviceGroupByGuid(groupGuid);
        },

        async getDeviceGroupAccessForUser(userId) {
            return all(`
                SELECT DISTINCT dg.* FROM device_groups dg
                LEFT JOIN device_group_user_access a ON a.device_group_id = dg.id
                LEFT JOIN device_group_user_group_access ga ON ga.device_group_id = dg.id
                LEFT JOIN user_group_members ugm ON ugm.user_group_id = ga.user_group_id
                WHERE a.user_id = $1 OR ugm.user_id = $1
                ORDER BY dg.name ASC
            `, [userId]);
        },

        // ---- Strategies / Policies ----

        async getAllStrategies() {
            const rows = await all('SELECT * FROM strategies ORDER BY name ASC');
            return rows.map(r => ({
                ...r,
                permissions: typeof r.permissions === 'object' ? r.permissions : safeJsonParse(r.permissions, {})
            }));
        },

        async getStrategyByGuid(guid) {
            const row = await one('SELECT * FROM strategies WHERE guid = $1', [guid]);
            if (!row) return null;
            return { ...row, permissions: typeof row.permissions === 'object' ? row.permissions : safeJsonParse(row.permissions, {}) };
        },

        async createStrategy(data) {
            const crypto = require('crypto');
            const guid = data.guid || crypto.randomUUID();
            return one(`
                INSERT INTO strategies (guid, name, user_group_guid, device_group_guid, enabled, permissions)
                VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
            `, [guid, data.name, data.user_group_guid || '', data.device_group_guid || '',
                data.enabled !== undefined ? data.enabled : true,
                JSON.stringify(data.permissions || {})]);
        },

        async updateStrategy(guid, data) {
            const sets = []; const params = []; let idx = 1;
            if (data.name !== undefined) { sets.push(`name = $${idx++}`); params.push(data.name); }
            if (data.user_group_guid !== undefined) { sets.push(`user_group_guid = $${idx++}`); params.push(data.user_group_guid); }
            if (data.device_group_guid !== undefined) { sets.push(`device_group_guid = $${idx++}`); params.push(data.device_group_guid); }
            if (data.enabled !== undefined) { sets.push(`enabled = $${idx++}`); params.push(!!data.enabled); }
            if (data.permissions !== undefined) { sets.push(`permissions = $${idx++}`); params.push(JSON.stringify(data.permissions)); }
            if (!sets.length) return null;
            sets.push('updated_at = NOW()');
            params.push(guid);
            return one(`UPDATE strategies SET ${sets.join(', ')} WHERE guid = $${idx} RETURNING *`, params);
        },

        async deleteStrategy(guid) {
            await q('DELETE FROM strategy_assignments WHERE strategy_guid = $1', [guid]);
            await q('DELETE FROM strategies WHERE guid = $1', [guid]);
        },

        async _ensurePeerGuidPg(peerId) {
            await q("ALTER TABLE peers ADD COLUMN IF NOT EXISTS guid TEXT DEFAULT ''");
            const row = await one(`SELECT id, COALESCE(uuid, '') AS uuid, COALESCE(guid, '') AS guid FROM peers WHERE id = $1`, [peerId]);
            if (!row) return null;
            if (row.guid) return row.guid;
            const crypto = require('crypto');
            const isUuid = (s) => typeof s === 'string' && s.length === 36 && (s.match(/-/g) || []).length === 4;
            const guid = isUuid(row.uuid) ? row.uuid.toLowerCase() : crypto.randomUUID();
            await q('UPDATE peers SET guid = $1 WHERE id = $2', [guid, peerId]);
            return guid;
        },

        async resolvePeerAssignmentKey(ref) {
            const key = String(ref || '').trim();
            if (!key) throw new Error('empty peer reference');
            await q("ALTER TABLE peers ADD COLUMN IF NOT EXISTS guid TEXT DEFAULT ''");
            const row = await one(`
                SELECT id FROM peers
                WHERE id = $1 OR guid = $1 OR uuid = $1
                LIMIT 1
            `, [key]);
            if (!row) throw new Error('peer not found');
            const guid = await this._ensurePeerGuidPg(row.id);
            if (!guid) throw new Error('peer not found');
            return guid;
        },

        async resolveUserAssignmentKey(ref) {
            const key = String(ref || '').trim();
            if (!key) throw new Error('empty user reference');
            const row = await one(`
                SELECT id, COALESCE(guid, '') AS guid FROM users
                WHERE guid = $1 OR username = $1 OR id::text = $1
                LIMIT 1
            `, [key]);
            if (!row) throw new Error('user not found');
            if (row.guid) return row.guid;
            const crypto = require('crypto');
            const guid = crypto.randomUUID();
            await q('UPDATE users SET guid = $1 WHERE id = $2', [guid, row.id]);
            return guid;
        },

        async resolveDeviceGroupAssignmentKey(ref) {
            const key = String(ref || '').trim();
            if (!key) throw new Error('empty device group reference');
            const row = await one(`SELECT guid FROM device_groups WHERE guid = $1 OR name = $1 LIMIT 1`, [key]);
            if (!row) throw new Error('device group not found');
            return row.guid;
        },

        async assignStrategy(strategyGuid, { peers = [], users = [], groups = [] } = {}) {
            strategyGuid = String(strategyGuid || '').trim();
            if (strategyGuid) {
                const st = await this.getStrategyByGuid(strategyGuid);
                if (!st) throw new Error('strategy not found');
            }
            const upsert = async (targetType, keys) => {
                for (const raw of keys) {
                    const targetKey = String(raw || '').trim();
                    if (!targetKey) continue;
                    if (!strategyGuid) {
                        await q('DELETE FROM strategy_assignments WHERE target_type = $1 AND target_key = $2', [targetType, targetKey]);
                        continue;
                    }
                    await q(`
                        INSERT INTO strategy_assignments (target_type, target_key, strategy_guid, updated_at)
                        VALUES ($1, $2, $3, NOW())
                        ON CONFLICT (target_type, target_key) DO UPDATE SET
                            strategy_guid = EXCLUDED.strategy_guid,
                            updated_at = EXCLUDED.updated_at
                    `, [targetType, targetKey, strategyGuid]);
                }
            };
            await upsert('peer', peers);
            await upsert('user', users);
            await upsert('device_group', groups);
        },

        async getStrategyAssignmentSummary(strategyGuid) {
            const rows = await all(`
                SELECT target_type, target_key FROM strategy_assignments
                WHERE strategy_guid = $1 ORDER BY target_type, target_key
            `, [strategyGuid]);
            const summary = { peer_count: 0, user_count: 0, device_group_count: 0, peers: [], users: [], groups: [] };
            for (const row of rows) {
                if (row.target_type === 'peer') { summary.peer_count++; summary.peers.push(row.target_key); }
                else if (row.target_type === 'user') { summary.user_count++; summary.users.push(row.target_key); }
                else if (row.target_type === 'device_group') { summary.device_group_count++; summary.groups.push(row.target_key); }
            }
            return summary;
        },

        async getStrategyAssignmentDisplayRefs(strategyGuid) {
            const summary = await this.getStrategyAssignmentSummary(strategyGuid);
            const peerIds = [];
            const userNames = [];
            await q("ALTER TABLE peers ADD COLUMN IF NOT EXISTS guid TEXT DEFAULT ''");
            for (const guid of summary.peers) {
                const row = await one('SELECT id FROM peers WHERE guid = $1 LIMIT 1', [guid]);
                if (row?.id) peerIds.push(row.id);
            }
            for (const guid of summary.users) {
                const row = await one('SELECT username FROM users WHERE guid = $1 LIMIT 1', [guid]);
                if (row?.username) userNames.push(row.username);
            }
            return {
                ...summary,
                peer_ids: peerIds,
                user_names: userNames,
                group_guids: summary.groups,
            };
        },

        async getUserStrategyGuid(userId) {
            const userGuid = await this.ensureUserGuid(userId);
            if (!userGuid) return '';
            const row = await one(`
                SELECT strategy_guid FROM strategy_assignments
                WHERE target_type = 'user' AND target_key = $1
                LIMIT 1
            `, [userGuid]);
            return row?.strategy_guid || '';
        },

        async setUserStrategyAssignment(userId, strategyGuid) {
            const userGuid = await this.ensureUserGuid(userId);
            if (!userGuid) throw new Error('user not found');
            strategyGuid = String(strategyGuid || '').trim();
            if (!strategyGuid) {
                await q(`DELETE FROM strategy_assignments WHERE target_type = 'user' AND target_key = $1`, [userGuid]);
                return '';
            }
            const st = await this.getStrategyByGuid(strategyGuid);
            if (!st) throw new Error('strategy not found');
            await q(`
                INSERT INTO strategy_assignments (target_type, target_key, strategy_guid, updated_at)
                VALUES ('user', $1, $2, NOW())
                ON CONFLICT (target_type, target_key) DO UPDATE SET
                    strategy_guid = EXCLUDED.strategy_guid,
                    updated_at = EXCLUDED.updated_at
            `, [userGuid, strategyGuid]);
            return strategyGuid;
        },

        async getUserPeerGrants(userId) {
            const rows = await all(`
                SELECT peer_id FROM user_peer_grants WHERE user_id = $1 ORDER BY peer_id ASC
            `, [userId]);
            return rows.map(r => r.peer_id);
        },

        async setUserPeerGrants(userId, peerIds = []) {
            const normalized = Array.from(new Set(
                (peerIds || []).map(id => String(id || '').trim()).filter(Boolean)
            )).slice(0, 500);
            const client = await getPool().connect();
            try {
                await client.query('BEGIN');
                await client.query('DELETE FROM user_peer_grants WHERE user_id = $1', [userId]);
                for (const peerId of normalized) {
                    await client.query(
                        'INSERT INTO user_peer_grants (user_id, peer_id) VALUES ($1, $2)',
                        [userId, peerId]
                    );
                }
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
            return normalized;
        },

        async setStrategyEnabled(guid, enabled) {
            const row = await this.updateStrategy(guid, { enabled: !!enabled });
            if (!row) throw new Error('strategy not found');
            return row;
        },

        // ---- Folder batch operations ----

        async assignDevicesToFolder(deviceIds, folderId) {
            const client = await getPool().connect();
            try {
                await client.query('BEGIN');
                for (const id of deviceIds) {
                    if (folderId === null || folderId === undefined) {
                        await client.query('DELETE FROM device_folder_assignments WHERE device_id = $1', [id]);
                    } else {
                        await client.query(`
                            INSERT INTO device_folder_assignments (device_id, folder_id) VALUES ($1, $2)
                            ON CONFLICT(device_id) DO UPDATE SET folder_id = $2, assigned_at = NOW()
                        `, [id, folderId]);
                    }
                }
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        },

        async unassignDevicesFromFolder(folderId) {
            await q('DELETE FROM device_folder_assignments WHERE folder_id = $1', [folderId]);
        },

        async getUnassignedDeviceCount() {
            // Note: When using Go server, the peer count comes from Go server API (peers table)
            // This function will return -1 if the peer table doesn't exist or can't be queried
            // The UI should handle -1 by fetching count from serverBackend instead
            try {
                // Try 'peers' first (Go server schema), then 'peer' (legacy schema)
                let totalRes;
                try {
                    totalRes = await one('SELECT COUNT(*)::INTEGER AS count FROM peers WHERE NOT is_deleted');
                } catch {
                    totalRes = await one('SELECT COUNT(*)::INTEGER AS count FROM peer WHERE NOT is_deleted');
                }
                const total = +(totalRes?.count ?? 0);
                const assigned = +(await one('SELECT COUNT(*)::INTEGER AS count FROM device_folder_assignments')).count;
                return Math.max(0, total - assigned);
            } catch { return -1; }
        },

        async getAllFolderAssignments() {
            const rows = await all('SELECT device_id, folder_id FROM device_folder_assignments');
            const map = {};
            for (const row of rows) {
                const folderId = Number(row.folder_id);
                map[row.device_id] = Number.isFinite(folderId) ? folderId : row.folder_id;
            }
            return map;
        },

        // ---- Address Book Tags ----

        async getAddressBookTags(userId) {
            const user = await one('SELECT username FROM users WHERE id = $1', [userId]);
            if (!user) return [];
            const row = await one('SELECT data FROM address_books WHERE username = $1 AND ab_type = $2', [user.username, 'legacy']);
            if (!row) return [];
            try {
                const data = typeof row.data === 'object' ? row.data : JSON.parse(row.data);
                return data.tags || [];
            } catch { return []; }
        },

        // ---- Login Cleanup ----

        async cleanupOldLoginAttempts() {
            await q("DELETE FROM login_attempts WHERE created_at < NOW() - INTERVAL '24 hours'");
        },

        // ---- User Admin ----

        async resetAdminPassword(passwordHash) {
            const admin = await one("SELECT * FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1");
            if (admin) {
                await q('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, admin.id]);
                return admin;
            }
            return null;
        },

        async deleteAllUsers() {
            await q('DELETE FROM users');
        },

        // ---- Count Devices ----

        async countDevices(filters = {}) {
            let sql = 'SELECT COUNT(*)::INTEGER AS count FROM peer WHERE NOT is_deleted';
            const params = [];
            let idx = 1;
            if (filters.search) {
                sql += ` AND (id ILIKE $${idx} ESCAPE '\\' OR "user" ILIKE $${idx} ESCAPE '\\' OR note ILIKE $${idx} ESCAPE '\\')`;
                params.push(`%${escapeLikePattern(filters.search)}%`);
                idx++;
            }
            if (filters.status === 'online') sql += ' AND status_online = TRUE';
            else if (filters.status === 'offline') sql += ' AND status_online = FALSE';
            else if (filters.status === 'banned') sql += ' AND is_banned = TRUE';
            if (filters.hasNotes) sql += " AND note IS NOT NULL AND note != ''";
            return +(await one(sql, params)).count;
        },

        // ---- Agent installer bundles (Generator) ----

        async listAgentBundles({ includeRevoked = false } = {}) {
            const where = includeRevoked ? '' : 'WHERE revoked = FALSE';
            return all(`SELECT * FROM agent_bundles ${where} ORDER BY created_at DESC`);
        },

        async getAgentBundle(bundleId) {
            return one('SELECT * FROM agent_bundles WHERE bundle_id = $1', [bundleId]);
        },

        async getAgentBundleByPublicId(publicId) {
            return one('SELECT * FROM agent_bundles WHERE slug = $1 OR bundle_id = $1 LIMIT 1', [publicId]);
        },

        async isAgentBundleSlugTaken(slug, excludeBundleId = null) {
            if (!slug) return false;
            const row = await one('SELECT bundle_id FROM agent_bundles WHERE slug = $1 LIMIT 1', [slug]);
            if (!row) return false;
            return excludeBundleId ? row.bundle_id !== excludeBundleId : true;
        },

        async createAgentBundle({ bundleId, slug, name, branding, brandingHash, createdBy }) {
            return one(`
                INSERT INTO agent_bundles (bundle_id, slug, name, branding, branding_hash, created_by)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING *
            `, [bundleId, slug || null, name, branding, brandingHash, createdBy || null]);
        },

        async updateAgentBundle(bundleId, { name, slug, branding, brandingHash }) {
            return one(`
                UPDATE agent_bundles
                SET name = $1, slug = $2, branding = $3, branding_hash = $4, updated_at = NOW()
                WHERE bundle_id = $5
                RETURNING *
            `, [name, slug || null, branding, brandingHash, bundleId]);
        },

        async setAgentBundleRevoked(bundleId, revoked) {
            return one(`
                UPDATE agent_bundles SET revoked = $1, updated_at = NOW()
                WHERE bundle_id = $2 RETURNING *
            `, [!!revoked, bundleId]);
        },

        async deleteAgentBundle(bundleId) {
            const { rowCount } = await q('DELETE FROM agent_bundles WHERE bundle_id = $1', [bundleId]);
            return rowCount > 0;
        },

        async incrementAgentBundleDownload(bundleId) {
            await q(`
                UPDATE agent_bundles SET download_count = download_count + 1, updated_at = NOW()
                WHERE bundle_id = $1
            `, [bundleId]);
        },

        async listAgentBundleBuildsForHash(brandingHash) {
            return all(
                'SELECT * FROM agent_bundle_builds WHERE branding_hash = $1 ORDER BY platform, arch, format',
                [brandingHash]
            );
        },

        async getAgentBundleBuild({ brandingHash, platform, arch, format }) {
            return one(`
                SELECT * FROM agent_bundle_builds
                WHERE branding_hash = $1 AND platform = $2 AND arch = $3 AND format = $4
            `, [brandingHash, platform, arch, format]);
        },

        async upsertAgentBundleBuild({ brandingHash, platform, arch, format, status, artifactPath, artifactSize, artifactSha256, errorMessage }) {
            return one(`
                INSERT INTO agent_bundle_builds (
                    branding_hash, platform, arch, format, status,
                    artifact_path, artifact_size, artifact_sha256, error_message,
                    started_at, finished_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9,
                    CASE WHEN $5 = 'building' THEN NOW() ELSE NULL END,
                    CASE WHEN $5 IN ('ready','failed') THEN NOW() ELSE NULL END
                )
                ON CONFLICT (branding_hash, platform, arch, format) DO UPDATE SET
                    status = EXCLUDED.status,
                    artifact_path = COALESCE(EXCLUDED.artifact_path, agent_bundle_builds.artifact_path),
                    artifact_size = COALESCE(EXCLUDED.artifact_size, agent_bundle_builds.artifact_size),
                    artifact_sha256 = COALESCE(EXCLUDED.artifact_sha256, agent_bundle_builds.artifact_sha256),
                    error_message = EXCLUDED.error_message,
                    started_at = CASE WHEN EXCLUDED.status = 'building' THEN NOW() ELSE agent_bundle_builds.started_at END,
                    finished_at = CASE WHEN EXCLUDED.status IN ('ready','failed') THEN NOW() ELSE agent_bundle_builds.finished_at END,
                    updated_at = NOW()
                RETURNING *
            `, [brandingHash, platform, arch, format, status, artifactPath || null, artifactSize || 0, artifactSha256 || null, errorMessage || '']);
        },

        // ---- Integration Housekeeping ----

        async runIntegrationHousekeeping() {
            await q("DELETE FROM peer_metrics WHERE created_at < NOW() - INTERVAL '7 days'");
            await q("DELETE FROM audit_connections WHERE created_at < NOW() - INTERVAL '90 days'");
            await q("DELETE FROM audit_files WHERE created_at < NOW() - INTERVAL '90 days'");
            await q("DELETE FROM audit_alarms WHERE created_at < NOW() - INTERVAL '90 days'");
        },
    };
}

// =========================================================================
//  Factory
// =========================================================================

let _adapter = null;

/**
 * Get (or create) the database adapter singleton.
 * @param {Object} [config] - Configuration object (from config/config.js)
 * @returns {DbAdapter}
 */
function getAdapter(config) {
    if (_adapter) return _adapter;

    if (DB_TYPE === 'postgres' || DB_TYPE === 'postgresql') {
        if (!DATABASE_URL) {
            throw new Error('[DB] DB_TYPE=postgres requires DATABASE_URL environment variable');
        }
        _adapter = createPostgresAdapter();
    } else {
        if (!config) {
            config = require('../config/config');
        }
        _adapter = createSqliteAdapter(config);
    }

    return _adapter;
}

module.exports = { getAdapter, DB_TYPE };
