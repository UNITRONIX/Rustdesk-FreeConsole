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

function randomPassword() {
    // 32 hex chars — used only as a Go-side placeholder. Panel login keeps
    // using the Node bcrypt hash; admin can later reset the password through
    // the panel which mirrors the new password to Go.
    return crypto.randomBytes(16).toString('hex');
}

async function readGoUsersFromApi() {
    try {
        const { data } = await apiClient.get('/users');
        return Array.isArray(data) ? data : [];
    } catch (err) {
        const status = err.response?.status;
        console.warn(`[userSync] readGoUsersFromApi failed: status=${status} ${err.message}`);
        return [];
    }
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

    const goUser = await findGoUserByUsername(localUser.username);
    return goUser?.id || localUser.id;
}

/**
 * Mirror a freshly created Node user into the Go users table.
 * Safe to call when the user already exists on the Go side (logged + ignored).
 */
async function mirrorCreate(username, password, role) {
    if (!username || !password) return;
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
        if (status === 409) {
            await mirrorUpdate(username, { password, role });
            return;
        }
        console.warn(`[userSync] mirrorCreate('${username}') failed: status=${status} ${err.message}`);
    }
}

/**
 * Mirror an update (role and/or password) to the Go side.
 * Looks up the Go user by username (IDs differ between stores).
 */
async function mirrorUpdate(username, { password, role } = {}) {
    if (!username) return;
    if (!password && !role) return;

    let goUser = await findGoUserByUsername(username);

    // If the user does not yet exist on Go and we have a plaintext password,
    // create the record so subsequent operations (org linking) work.
    if (!goUser && password) {
        await mirrorCreate(username, password, role);
        return;
    }
    if (!goUser) {
        // No Go record and no plaintext password — nothing we can do safely.
        return;
    }

    const body = {};
    if (password) body.password = password;
    if (role) body.role = normalizeRole(role);
    if (Object.keys(body).length === 0) return;

    try {
        await apiClient.put(`/users/${goUser.id}`, body);
        console.log(`[userSync] Mirrored update -> Go: '${username}'${body.role ? ` role=${body.role}` : ''}${body.password ? ' password=***' : ''}`);
    } catch (err) {
        const status = err.response?.status;
        console.warn(`[userSync] mirrorUpdate('${username}') failed: status=${status} ${err.message}`);
    }
}

/**
 * Mirror a delete to the Go side. Looks up the user by username first.
 */
async function mirrorDelete(username) {
    if (!username) return;
    const goUser = await findGoUserByUsername(username);
    if (!goUser) return;
    try {
        await apiClient.delete(`/users/${goUser.id}`);
        console.log(`[userSync] Mirrored delete -> Go: '${username}'`);
    } catch (err) {
        const status = err.response?.status;
        // 409 = "Cannot delete the last admin user" — keep the panel record
        // anyway so the operator can react. Already logged here.
        console.warn(`[userSync] mirrorDelete('${username}') failed: status=${status} ${err.message}`);
    }
}

/**
 * Backfill: ensure every Node panel user has a matching Go-side user record.
 * Called once at startup. Missing users are created on the Go side with a
 * random throwaway password (panel login keeps using the Node bcrypt hash —
 * the Go password is irrelevant unless the operator later resets it).
 */
async function backfillFromNode() {
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
        return;
    }

    console.log(`[userSync] backfill: mirroring ${missing.length} panel user(s) to Go server`);
    for (const u of missing) {
        try {
            await apiClient.post('/users', {
                username: u.username,
                password: randomPassword(),
                role: normalizeRole(u.role),
            });
            console.log(`[userSync] backfill: created Go user '${u.username}' (${normalizeRole(u.role)})`);
        } catch (err) {
            const status = err.response?.status;
            if (status === 409) continue; // race — already exists, fine.
            console.warn(`[userSync] backfill: failed to create '${u.username}': status=${status} ${err.message}`);
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
 * Backfill: recover Node auth.db users from the Go server SQLite database.
 *
 * SQLite dual-DB installs read db_v2.sqlite3 directly (preserves password hashes).
 * PostgreSQL uses the Go REST API to reconcile auth_provider/role only.
 */
async function backfillFromGo() {
    if (db.type === 'postgres') {
        return backfillFromGoPostgres();
    }
    if (typeof db.getAuthDb !== 'function') return { imported: 0, skipped: 'no-auth-db' };

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

    let authDb;
    try {
        authDb = db.getAuthDb();
    } catch (err) {
        console.warn(`[userSync] Go->Node backfill: cannot open local auth DB: ${err.message}`);
        return { imported: 0, error: err.message };
    }

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
    mirrorCreate,
    mirrorUpdate,
    mirrorDelete,
    backfillFromGo,
    backfillFromNode,
};
