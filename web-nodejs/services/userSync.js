/**
 * BetterDesk Console - Node ↔ Go user sync service
 *
 * Background:
 *   The Node.js panel persists users in its own auth.db (or auth schema in
 *   PostgreSQL), while the Go server keeps a separate `users` table in
 *   db_v2.sqlite3 (or PostgreSQL). Org membership on the Go side links via
 *   `org_users.server_user_id` — i.e. only users present in the Go store can
 *   be linked to organizations through `Add User → Add Existing`
 *   (Issue #125).
 *
 *   Historically, the Node panel created users only locally, so the Go
 *   `users` table only contained the seeded admin. This service mirrors
 *   user create/update/delete operations to the Go server via its REST API,
 *   so the org "available users" dropdown stays consistent with the Users
 *   admin page.
 *
 *   All mirror calls are best-effort: failures are logged but do not break
 *   the panel-side request — users remain functional locally even when the
 *   Go server is unreachable. Backfill helpers are run at startup to
 *   reconcile drift in both directions. SQLite installs can recover local
 *   auth.db users from the Go db_v2.sqlite3 users table, preserving password
 *   hashes so panel login keeps working after an update recreated auth.db.
 */

const crypto = require('crypto');
const { apiClient } = require('./betterdeskApi');
const { assertSafeApiId } = require('../lib/goApiPath');
const db = require('./database');

// Roles supported by the Go server (auth/roles.go). Anything outside this
// list is downgraded to 'viewer' so the mirror call does not fail.
const GO_VALID_ROLES = new Set([
    'super_admin',
    'admin',
    'server_admin',
    'global_admin',
    'operator',
    'viewer',
    'pro',
]);

function normalizeRole(role) {
    return GO_VALID_ROLES.has(role) ? role : 'viewer';
}

function normalizeUsername(username) {
    return String(username || '').trim().toLowerCase();
}

/** Matches Go auth.IsSuperAdminRole / panel isSuperAdminRole (Discussion #99). */
function isSuperAdminRole(role) {
    return role === 'super_admin' || role === 'admin';
}

function usesSharedUserStore() {
    if (db.type === 'postgres') return true;
    try {
        return typeof db.getAuthDb === 'function' && db.getAuthDb() === db.getDb();
    } catch (_) {
        return false;
    }
}

function usesSharedSQLiteStore() {
    return db.type === 'sqlite' && usesSharedUserStore();
}

/**
 * Fetch Go users via API. Distinguishes empty list from API failure (Issue #315).
 * @returns {Promise<{ users: object[], ok: boolean, status?: number, error?: string }>}
 */
async function listGoUsers() {
    try {
        const { data } = await apiClient.get('/users');
        if (!Array.isArray(data)) {
            return { users: [], ok: false, status: 502, error: 'invalid_go_users_payload' };
        }
        return { users: data, ok: true };
    } catch (err) {
        const status = err.response?.status;
        console.warn(
            `[userSync] listGoUsers failed: status=${status} ${err.message}` +
            (status === 500
                ? ' — Go user list broken; admin-delete parity check cannot run'
                : '')
        );
        return { users: [], ok: false, status: status || 502, error: err.message };
    }
}

/**
 * Pre-flight for deleting a Super Admin on dual-SQLite installs (Issue #315).
 * Shared PostgreSQL uses one users table — local countAdmins is enough.
 *
 * @param {string} username
 * @returns {Promise<{ ok: boolean, status?: number, reason?: string, goAdminCount?: number }>}
 */
async function assertGoAllowsSuperAdminDelete(username) {
    if (!username) return { ok: true, reason: 'no-username' };
    if (usesSharedUserStore()) return { ok: true, reason: 'shared-db' };

    const listed = await listGoUsers();
    if (!listed.ok) {
        return { ok: false, status: listed.status || 502, reason: 'go_users_unavailable' };
    }

    const lower = normalizeUsername(username);
    const goUser = listed.users.find(u => normalizeUsername(u.username) === lower);
    if (!goUser) {
        // Panel-only row — nothing to mirror; local last-admin check still applies.
        return { ok: true, reason: 'not-on-go', goAdminCount: listed.users.filter(u => isSuperAdminRole(u.role)).length };
    }
    if (!isSuperAdminRole(goUser.role)) {
        return { ok: true, reason: 'not-go-super-admin' };
    }

    const goAdminCount = listed.users.filter(u => isSuperAdminRole(u.role)).length;
    if (goAdminCount <= 1) {
        // Node may have other super_admins that never mirrored — refuse before local delete.
        return { ok: false, status: 409, reason: 'last_admin_go', goAdminCount };
    }
    return { ok: true, goAdminCount };
}

function sqliteTableExists(sqliteDb, tableName) {
    if (!/^[a-zA-Z0-9_]+$/.test(tableName)) return false;
    try {
        return !!sqliteDb
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(tableName);
    } catch (_) {
        return false;
    }
}

function sqliteColumns(sqliteDb, tableName) {
    if (!/^[a-zA-Z0-9_]+$/.test(tableName)) return new Set();
    try {
        return new Set(sqliteDb.prepare(`PRAGMA table_info(${tableName})`).all().map(c => c.name));
    } catch (_) {
        return new Set();
    }
}

function readGoUsersFromSqlite() {
    if (db.type !== 'sqlite') return [];
    if (typeof db.getDb !== 'function') return [];

    let goDb;
    try {
        goDb = db.getDb();
    } catch (err) {
        console.warn(`[userSync] Go->Node backfill: cannot open Go SQLite DB: ${err.message}`);
        return [];
    }

    if (!sqliteTableExists(goDb, 'users')) return [];
    const cols = sqliteColumns(goDb, 'users');
    if (!cols.has('username') || !cols.has('password_hash')) return [];

    const select = [
        cols.has('id') ? 'id' : '0 AS id',
        'username',
        'password_hash',
        cols.has('role') ? "COALESCE(role, 'viewer') AS role" : "'viewer' AS role",
        cols.has('auth_provider') ? "COALESCE(auth_provider, 'local') AS auth_provider" : "'local' AS auth_provider",
        cols.has('totp_secret') ? "COALESCE(totp_secret, '') AS totp_secret" : "'' AS totp_secret",
        cols.has('totp_enabled') ? 'COALESCE(totp_enabled, 0) AS totp_enabled' : '0 AS totp_enabled',
        cols.has('created_at') ? 'created_at' : "datetime('now') AS created_at",
        cols.has('last_login') ? 'last_login' : 'NULL AS last_login',
    ];

    try {
        return goDb.prepare(`SELECT ${select.join(', ')} FROM users ORDER BY id`).all();
    } catch (err) {
        console.warn(`[userSync] Go->Node backfill: cannot read Go users: ${err.message}`);
        return [];
    }
}

function getGoSqliteDbForWrite() {
    if (db.type !== 'sqlite') return null;
    if (typeof db.getDb !== 'function') return null;

    try {
        return db.getDb();
    } catch (err) {
        console.warn(`[userSync] Go SQLite write unavailable: ${err.message}`);
        return null;
    }
}

function localUserHasTotp(user) {
    return !!(user && user.totp_enabled && String(user.totp_secret || '').trim() !== '');
}

function mirrorTotpToGoSqlite(username, { enabled, secret } = {}) {
    const normalized = normalizeUsername(username);
    if (!normalized) return false;

    const goDb = getGoSqliteDbForWrite();
    if (!goDb) return false;
    if (!sqliteTableExists(goDb, 'users')) return false;

    const cols = sqliteColumns(goDb, 'users');
    if (!cols.has('username') || !cols.has('totp_secret') || !cols.has('totp_enabled')) {
        console.warn('[userSync] TOTP mirror skipped: Go users table lacks TOTP columns');
        return false;
    }

    const row = goDb.prepare('SELECT id FROM users WHERE lower(username) = ?').get(normalized);
    if (!row) {
        console.warn(`[userSync] TOTP mirror skipped: Go user '${username}' not found`);
        return false;
    }

    if (enabled) {
        const totpSecret = String(secret || '').trim();
        if (!totpSecret) {
            console.warn(`[userSync] TOTP enable mirror skipped for '${username}': missing secret`);
            return false;
        }
        const recoverySql = cols.has('totp_recovery_codes') ? ', totp_recovery_codes = NULL' : '';
        goDb.prepare(`UPDATE users SET totp_secret = ?, totp_enabled = 1${recoverySql} WHERE id = ?`).run(totpSecret, row.id);
        console.log(`[userSync] Mirrored TOTP enable -> Go SQLite: '${username}'`);
        return true;
    }

    const recoverySql = cols.has('totp_recovery_codes') ? ', totp_recovery_codes = NULL' : '';
    goDb.prepare(`UPDATE users SET totp_secret = '', totp_enabled = 0${recoverySql} WHERE id = ?`).run(row.id);
    console.log(`[userSync] Mirrored TOTP disable -> Go SQLite: '${username}'`);
    return true;
}

function randomPassword() {
    // 32 hex chars — used only as a Go-side placeholder when the panel hash
    // cannot be copied (API-only path). Prefer insertGoUserWithPasswordHash.
    return crypto.randomBytes(16).toString('hex');
}

/**
 * Insert a missing Go SQLite user with the panel password_hash so RustDesk
 * client login (Go /api/login) accepts the same local password as the panel.
 * Returns true on success.
 */
function insertGoUserWithPasswordHash(username, passwordHash, role, authProvider = 'local') {
    const normalized = String(username || '').trim();
    const hash = String(passwordHash || '').trim();
    if (!normalized || !hash) return false;

    const goDb = getGoSqliteDbForWrite();
    if (!goDb) return false;
    if (!sqliteTableExists(goDb, 'users')) return false;

    const cols = sqliteColumns(goDb, 'users');
    if (!cols.has('username') || !cols.has('password_hash') || !cols.has('role')) {
        console.warn('[userSync] Go hash insert skipped: users table missing required columns');
        return false;
    }

    const provider = ['local', 'ldap', 'oidc'].includes(String(authProvider || '').trim())
        ? String(authProvider).trim()
        : 'local';
    const goRole = normalizeRole(role);

    try {
        if (cols.has('auth_provider')) {
            goDb.prepare(
                `INSERT INTO users (username, password_hash, role, auth_provider) VALUES (?, ?, ?, ?)`
            ).run(normalized, hash, goRole, provider);
        } else {
            goDb.prepare(
                `INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`
            ).run(normalized, hash, goRole);
        }
        console.log(`[userSync] backfill: inserted Go SQLite user '${normalized}' with panel password hash (${goRole})`);
        return true;
    } catch (err) {
        // UNIQUE username — already present (race with API or concurrent startup).
        if (String(err.message || '').includes('UNIQUE')) return true;
        console.warn(`[userSync] Go hash insert failed for '${normalized}': ${err.message}`);
        return false;
    }
}

async function readGoUsersFromApi() {
    const listed = await listGoUsers();
    return listed.users;
}

async function findGoUserByUsername(username) {
    if (!username) return null;
    const users = await readGoUsersFromApi();
    const lower = normalizeUsername(username);
    return users.find(u => normalizeUsername(u.username) === lower) || null;
}

async function resolveGoUserId(localUserId) {
    const id = Number(localUserId);
    if (!Number.isInteger(id) || id <= 0) return null;

    let localUser;
    try {
        localUser = await db.getUserById(id);
    } catch (err) {
        console.warn(`[userSync] resolveGoUserId(${localUserId}) local lookup failed: ${err.message}`);
        return null;
    }
    if (!localUser) return null;
    if (usesSharedUserStore()) return localUser.id;

    const goUser = await findGoUserByUsername(localUser.username);
    return goUser?.id || localUser.id;
}

/**
 * Mirror a freshly created Node user into the Go users table.
 * Safe to call when the user already exists on the Go side (logged + ignored).
 *
 * PostgreSQL shared-DB: the panel INSERT already wrote the row Go reads — skip
 * POST /users (would always 409). Issue #301.
 */
async function mirrorCreate(username, password, role) {
    if (!username || !password) return;
    if (usesSharedUserStore()) {
        return;
    }
    try {
        await apiClient.post('/users', {
            username,
            password,
            role: normalizeRole(role),
        });
        console.log(`[userSync] Mirrored create -> Go: '${username}' (${normalizeRole(role)})`);
    } catch (err) {
        const status = err.response?.status;
        // 409 = username already exists on Go side → still sync the role/password.
        // allowCreate:false prevents mirrorUpdate → mirrorCreate recursion (Issue #301).
        if (status === 409) {
            await mirrorUpdate(username, { password, role, allowCreate: false });
            return;
        }
        console.warn(`[userSync] mirrorCreate('${username}') failed: status=${status} ${err.message}`);
    }
}

/**
 * Mirror an update (role and/or password) to the Go side.
 * Looks up the Go user by username (IDs differ between stores).
 *
 * @param {object} [opts]
 * @param {string} [opts.password]
 * @param {string} [opts.role]
 * @param {boolean} [opts.allowCreate=true] When false (e.g. after POST 409), never
 *   call mirrorCreate — avoids unbounded INSERT loops when GET /users fails.
 */
async function mirrorUpdate(username, { password, role, allowCreate = true } = {}) {
    if (!username) return;
    if (!password && !role) return;
    if (usesSharedUserStore()) return;

    let goUser = await findGoUserByUsername(username);

    // If the user does not yet exist on Go and we have a plaintext password,
    // create the record so subsequent operations (org linking) work.
    if (!goUser && password && allowCreate) {
        await mirrorCreate(username, password, role);
        return;
    }
    if (!goUser) {
        // No Go record: either no plaintext password, or create was forbidden
        // after a 409 (list API broken / empty) — do not retry INSERT.
        if (!allowCreate) {
            console.warn(
                `[userSync] mirrorUpdate('${username}'): conflict (409) but GET /users ` +
                'could not resolve the user; skipping create to avoid retry loop (issue #301)'
            );
        }
        return;
    }

    const body = {};
    if (password) body.password = password;
    if (role) body.role = normalizeRole(role);
    if (Object.keys(body).length === 0) return;

    try {
        const safeId = assertSafeApiId(goUser.id, 'userId');
        await apiClient.put(`/users/${encodeURIComponent(safeId)}`, body);
        console.log(`[userSync] Mirrored update -> Go: '${username}'${body.role ? ` role=${body.role}` : ''}${body.password ? ' password=***' : ''}`);
    } catch (err) {
        const status = err.response?.status;
        console.warn(`[userSync] mirrorUpdate('${username}') failed: status=${status} ${err.message}`);
    }
}

/**
 * Mirror a delete to the Go side. Looks up the user by username first.
 *
 * Issue #315: returns a result object so the panel can fail closed (no local
 * delete / rollback) when Go refuses last-admin (409). Shared PostgreSQL skips
 * the HTTP mirror — local delete already removes the shared row.
 *
 * @returns {Promise<{ ok: boolean, skipped?: boolean|string, status?: number, conflict?: boolean }>}
 */
async function mirrorDelete(username) {
    if (!username) return { ok: true, skipped: true };
    if (usesSharedUserStore()) return { ok: true, skipped: 'shared-db' };

    const goUser = await findGoUserByUsername(username);
    if (!goUser) return { ok: true, skipped: 'not-on-go' };
    try {
        const safeId = assertSafeApiId(goUser.id, 'userId');
        await apiClient.delete(`/users/${encodeURIComponent(safeId)}`);
        console.log(`[userSync] Mirrored delete -> Go: '${username}'`);
        return { ok: true };
    } catch (err) {
        const status = err.response?.status;
        // 409 = "Cannot delete the last admin user" — caller must not leave
        // panel/Go desynced (false success + backfill restore).
        console.warn(`[userSync] mirrorDelete('${username}') failed: status=${status} ${err.message}`);
        return {
            ok: false,
            status: status || 502,
            conflict: status === 409,
        };
    }
}

async function mirrorTotpEnable(username, { secret } = {}) {
    if (!username || !secret) return;
    if (usesSharedUserStore()) return;
    mirrorTotpToGoSqlite(username, { enabled: true, secret });
}

async function mirrorTotpDisable(username) {
    if (!username) return;
    if (usesSharedUserStore()) return;
    mirrorTotpToGoSqlite(username, { enabled: false });
}

/**
 * Backfill: ensure every Node panel user has a matching Go-side user record.
 * Called once at startup. On SQLite dual-DB installs, missing Go users are
 * created with the panel password_hash so RustDesk client login accepts the
 * same local password. Falls back to a random API password only when the hash
 * cannot be copied (then a panel password reset is required for client login).
 * PostgreSQL shared-DB installs normally already share the users table.
 */
async function backfillFromNode() {
    if (usesSharedSQLiteStore()) return { skipped: 'shared-store' };
    let nodeUsers;
    try {
        nodeUsers = await db.getAllUsers();
    } catch (err) {
        console.warn(`[userSync] backfill: cannot read Node users: ${err.message}`);
        return;
    }
    if (!Array.isArray(nodeUsers) || nodeUsers.length === 0) return;

    let goUsers;
    try {
        const { data } = await apiClient.get('/users');
        goUsers = Array.isArray(data) ? data : [];
    } catch (err) {
        const status = err.response?.status;
        console.warn(`[userSync] backfill: cannot read Go users: status=${status} ${err.message}`);
        return;
    }

    const goUsernames = new Set(goUsers.map(u => String(u.username || '').toLowerCase()));
    const missing = nodeUsers.filter(u => !goUsernames.has(String(u.username || '').toLowerCase()));
    if (missing.length === 0) {
        console.log(`[userSync] backfill: all ${nodeUsers.length} panel users already present on Go side`);
        if (db.type === 'sqlite') {
            for (const u of nodeUsers) {
                if (localUserHasTotp(u)) {
                    mirrorTotpToGoSqlite(u.username, { enabled: true, secret: u.totp_secret });
                }
            }
        }
        return;
    }

    console.log(`[userSync] backfill: mirroring ${missing.length} panel user(s) to Go server`);
    for (const u of missing) {
        const hash = String(u.password_hash || '').trim();
        if (db.type === 'sqlite' && hash && insertGoUserWithPasswordHash(u.username, hash, u.role, u.auth_provider)) {
            continue;
        }
        try {
            await apiClient.post('/users', {
                username: u.username,
                password: randomPassword(),
                role: normalizeRole(u.role),
            });
            console.log(`[userSync] backfill: created Go user '${u.username}' (${normalizeRole(u.role)}) via API (placeholder password)`);
        } catch (err) {
            const status = err.response?.status;
            if (status === 409) continue; // race — already exists, fine.
            console.warn(`[userSync] backfill: failed to create '${u.username}': status=${status} ${err.message}`);
        }
    }

    if (db.type === 'sqlite') {
        for (const u of nodeUsers) {
            if (localUserHasTotp(u)) {
                mirrorTotpToGoSqlite(u.username, { enabled: true, secret: u.totp_secret });
            }
        }
    }
}

/**
 * PostgreSQL / shared-DB: reconcile auth_provider and role from Go REST API.
 */
async function backfillFromGoPostgres() {
    const goUsers = await readGoUsersFromApi();
    if (goUsers.length === 0) return { imported: 0, synced: 0 };

    let localUsers;
    try {
        localUsers = await db.getAllUsers();
    } catch (err) {
        console.warn(`[userSync] Go->Node API sync: cannot read local users: ${err.message}`);
        return { imported: 0, error: err.message };
    }

    let synced = 0;
    const localByName = new Map((localUsers || []).map(u => [normalizeUsername(u.username), u]));

    for (const goUser of goUsers) {
        const local = localByName.get(normalizeUsername(goUser.username));
        if (!local) continue;

        const goProvider = String(goUser.auth_provider || 'local').trim() || 'local';
        const goRole = normalizeRole(goUser.role);
        const localProvider = String(local.auth_provider || 'local').trim() || 'local';

        if (goProvider !== localProvider || goRole !== local.role) {
            try {
                await db.syncUserFromGo(local.id, { authProvider: goProvider, role: goRole });
                synced++;
            } catch (err) {
                console.warn(`[userSync] Go->Node API sync failed for '${local.username}': ${err.message}`);
            }
        }
    }

    if (synced > 0) {
        console.log(`[userSync] Go->Node API sync: updated auth_provider/role for ${synced} user(s)`);
    }
    return { imported: 0, synced };
}

/**
 * Backfill only legacy dual-store SQLite deployments.
 *
 * Consolidated SQLite and PostgreSQL already share one users table and must
 * not run best-effort reconciliation over that source of truth.
 */
async function backfillFromGo() {
    if (db.type === 'postgres') {
        return backfillFromGoPostgres();
    }
    if (typeof db.getAuthDb !== 'function') return { imported: 0, skipped: 'no-auth-db' };
    let authDb;
    try {
        authDb = db.getAuthDb();
        if (authDb === db.getDb()) {
            return { imported: 0, skipped: 'shared-sqlite-store' };
        }
    } catch (err) {
        console.warn(`[userSync] Go->Node backfill: cannot open local auth DB: ${err.message}`);
        return { imported: 0, error: err.message };
    }

    const goUsers = readGoUsersFromSqlite()
        .filter(u => normalizeUsername(u.username) && String(u.password_hash || '').trim() !== '');
    if (goUsers.length === 0) return { imported: 0 };

    let localUsers;
    try {
        localUsers = await db.getAllUsersForBackup();
    } catch (err) {
        console.warn(`[userSync] Go->Node backfill: cannot read local users: ${err.message}`);
        return { imported: 0, error: err.message };
    }

    const localByUsername = new Set((localUsers || []).map(u => normalizeUsername(u.username)));
    const localIds = new Set((localUsers || []).map(u => Number(u.id)).filter(Number.isInteger));
    const missing = goUsers.filter(u => !localByUsername.has(normalizeUsername(u.username)));

    const insertWithId = authDb.prepare(`
        INSERT INTO users (id, username, password_hash, role, auth_provider, created_at, last_login, totp_secret, totp_enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertWithoutId = authDb.prepare(`
        INSERT INTO users (username, password_hash, role, auth_provider, created_at, last_login, totp_secret, totp_enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let imported = 0;
    for (const user of missing) {
        const username = String(user.username || '').trim();
        const passwordHash = String(user.password_hash || '').trim();
        const role = normalizeRole(user.role);
        const authProvider = String(user.auth_provider || 'local').trim() || 'local';
        const createdAt = user.created_at || new Date().toISOString();
        const lastLogin = user.last_login || null;
        const totpSecret = user.totp_secret || null;
        const totpEnabled = user.totp_enabled ? 1 : 0;
        const goId = Number(user.id);

        try {
            if (Number.isInteger(goId) && goId > 0 && !localIds.has(goId)) {
                insertWithId.run(goId, username, passwordHash, role, authProvider, createdAt, lastLogin, totpSecret, totpEnabled);
                localIds.add(goId);
            } else {
                insertWithoutId.run(username, passwordHash, role, authProvider, createdAt, lastLogin, totpSecret, totpEnabled);
            }
            localByUsername.add(normalizeUsername(username));
            imported++;
            console.log(`[userSync] Go->Node backfill: restored local user '${username}' (${role})`);
        } catch (err) {
            console.warn(`[userSync] Go->Node backfill: failed to restore '${username}': ${err.message}`);
        }
    }

    if (imported > 0) {
        console.log(`[userSync] Go->Node backfill: restored ${imported} user(s) into local auth DB`);
        try {
            localUsers = await db.getAllUsersForBackup();
        } catch (_) { /* keep previous snapshot */ }
    }

    const synced = syncExistingAuthFromGo(authDb, goUsers, localUsers);
    if (synced > 0) {
        console.log(`[userSync] Go->Node backfill: synced auth_provider/role for ${synced} existing user(s)`);
    }

    return { imported, synced };
}

function syncExistingAuthFromGo(authDb, goUsers, localUsers) {
    if (!authDb || !Array.isArray(goUsers) || goUsers.length === 0) return 0;
    const localByName = new Map((localUsers || []).map(u => [normalizeUsername(u.username), u]));
    const updateStmt = authDb.prepare('UPDATE users SET role = ?, auth_provider = ? WHERE id = ?');
    let synced = 0;

    for (const goUser of goUsers) {
        const local = localByName.get(normalizeUsername(goUser.username));
        if (!local) continue;

        const goProvider = String(goUser.auth_provider || 'local').trim() || 'local';
        const goRole = normalizeRole(goUser.role);
        const localProvider = String(local.auth_provider || 'local').trim() || 'local';

        if (goProvider !== localProvider || goRole !== local.role) {
            try {
                updateStmt.run(goRole, goProvider, local.id);
                synced++;
            } catch (err) {
                console.warn(`[userSync] Go->Node sync failed for '${local.username}': ${err.message}`);
            }
        }
    }

    return synced;
}

module.exports = {
    findGoUserByUsername,
    resolveGoUserId,
    isSuperAdminRole,
    listGoUsers,
    assertGoAllowsSuperAdminDelete,
    mirrorCreate,
    mirrorUpdate,
    mirrorDelete,
    mirrorTotpEnable,
    mirrorTotpDisable,
    insertGoUserWithPasswordHash,
    backfillFromGo,
    backfillFromNode,
};
