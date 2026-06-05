/**
 * BetterDesk Console - Auth Service
 * Handles user authentication, password hashing, session management
 */

const bcrypt = require('bcrypt');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const config = require('../config/config');

const SALT_ROUNDS = 12;

// Pre-computed dummy hash for timing-safe comparison (prevents user enumeration)
const DUMMY_HASH = '$2b$12$KiXeOj5vHpJRJHGMhWzadeKfRJLvJRaRHQbMGBBdkpu.jQfXAzgWS';

const http = require('http');
const https = require('https');

// ---------------------------------------------------------------------------
//  Go Server Health Cache (Phase A: Auth Delegation)
// ---------------------------------------------------------------------------
// Caches the Go server health status for 10 seconds to avoid hammering
// /api/health on every login attempt.
let _goHealthCache = { healthy: null, checkedAt: 0 };
const GO_HEALTH_CACHE_TTL = 10_000;   // 10s
const GO_HEALTH_TIMEOUT   = 2_000;    // 2s connect+read timeout

/**
 * Check whether the Go server is reachable.
 * Result is cached for GO_HEALTH_CACHE_TTL ms.
 * @returns {Promise<boolean>}
 */
async function checkGoServerHealth() {
    const now = Date.now();
    if (_goHealthCache.healthy !== null && now - _goHealthCache.checkedAt < GO_HEALTH_CACHE_TTL) {
        return _goHealthCache.healthy;
    }

    const apiUrl = config.betterdeskApiUrl || config.hbbsApiUrl || 'http://localhost:21114/api';
    let healthUrl;
    try {
        const base = new URL(apiUrl);
        healthUrl = new URL('/api/health', base.origin);
    } catch (_) {
        _goHealthCache = { healthy: false, checkedAt: now };
        return false;
    }

    const mod = healthUrl.protocol === 'https:' ? https : http;

    return new Promise((resolve) => {
        const req = mod.request(healthUrl, {
            method: 'GET',
            timeout: GO_HEALTH_TIMEOUT,
            rejectUnauthorized: !config.allowSelfSignedCerts,
        }, (res) => {
            // Drain response body
            res.resume();
            const ok = res.statusCode >= 200 && res.statusCode < 400;
            _goHealthCache = { healthy: ok, checkedAt: Date.now() };
            resolve(ok);
        });
        req.on('error', () => {
            _goHealthCache = { healthy: false, checkedAt: Date.now() };
            resolve(false);
        });
        req.on('timeout', () => {
            req.destroy();
            _goHealthCache = { healthy: false, checkedAt: Date.now() };
            resolve(false);
        });
        req.end();
    });
}

/**
 * Authenticate against Go server's POST /api/auth/login.
 * Returns the full Go response on success, or null on failure/unreachable.
 * The response shape is one of:
 *   { token, role, username }          — credentials accepted, no 2FA
 *   { requires_2fa, partial_token }    — 2FA required
 *   null                               — rejected or unreachable
 *
 * @param {string} username
 * @param {string} password
 * @returns {Promise<Object|null>}
 */
function authenticateViaGo(username, password) {
    const apiUrl = config.betterdeskApiUrl || config.hbbsApiUrl || 'http://localhost:21114/api';
    let authUrl;
    try {
        const base = new URL(apiUrl);
        authUrl = new URL('/api/auth/login', base.origin);
    } catch (_) {
        return Promise.resolve(null);
    }

    const body = JSON.stringify({ username, password });
    const mod = authUrl.protocol === 'https:' ? https : http;
    const timeout = Math.min(config.betterdeskApiTimeout || 5000, 5000);

    return new Promise((resolve) => {
        const req = mod.request(authUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout,
            rejectUnauthorized: !config.allowSelfSignedCerts,
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (res.statusCode === 200) {
                        resolve(parsed);
                        return;
                    }
                    // 401/400 = Go explicitly rejected
                    if (res.statusCode === 401 || res.statusCode === 400) {
                        resolve({ rejected: true, status: res.statusCode, error: parsed.error });
                        return;
                    }
                    // 429 = rate limited
                    if (res.statusCode === 429) {
                        resolve({ rejected: true, rateLimited: true, error: parsed.error });
                        return;
                    }
                } catch (_) { /* JSON parse error */ }
                resolve(null); // unexpected response — treat as unreachable
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.write(body);
        req.end();
    });
}

/**
 * Verify TOTP code via Go server's POST /api/auth/login/2fa.
 * @param {string} partialToken — JWT partial token from Go login
 * @param {string} code         — TOTP code or recovery code
 * @returns {Promise<Object|null>} — { token, role, username } or null
 */
function verifyTotpViaGo(partialToken, code) {
    const apiUrl = config.betterdeskApiUrl || config.hbbsApiUrl || 'http://localhost:21114/api';
    let url;
    try {
        const base = new URL(apiUrl);
        url = new URL('/api/auth/login/2fa', base.origin);
    } catch (_) {
        return Promise.resolve(null);
    }

    const body = JSON.stringify({ partial_token: partialToken, code });
    const mod = url.protocol === 'https:' ? https : http;
    const timeout = Math.min(config.betterdeskApiTimeout || 5000, 5000);

    return new Promise((resolve) => {
        const req = mod.request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout,
            rejectUnauthorized: !config.allowSelfSignedCerts,
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (res.statusCode === 200 && parsed.token) {
                        resolve(parsed);
                        return;
                    }
                    if (res.statusCode === 401 || res.statusCode === 400) {
                        resolve({ rejected: true, error: parsed.error });
                        return;
                    }
                    if (res.statusCode === 429) {
                        resolve({ rejected: true, rateLimited: true, error: parsed.error });
                        return;
                    }
                } catch (_) { /* JSON parse error */ }
                resolve(null);
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.write(body);
        req.end();
    });
}

/** Admin roles allowed to log in during emergency mode */
const EMERGENCY_ADMIN_ROLES = new Set(['admin', 'super_admin']);

// PBKDF2 parameters matching Go server's auth.HashPassword().
// Two formats are supported when verifying hashes that originated on the
// Go server (panel can fall back to those when migrating users):
//   - Legacy: "hex(salt):hex(hash)"               — 100_000 iter, SHA-256
//   - Modern: "pbkdf2-sha256$<iter>$<salt>$<hash>" — variable iter, SHA-256
const PBKDF2_LEGACY_ITERATIONS = 100_000;
const PBKDF2_KEY_LENGTH = 32;        // SHA-256 output size
const PBKDF2_DIGEST = 'sha256';
const PBKDF2_MODERN_PREFIX = 'pbkdf2-sha256$';

/**
 * Detect whether a stored hash is bcrypt or PBKDF2 (Go server format).
 * Accepts both the legacy "salt:hash" and modern "pbkdf2-sha256$..." forms.
 */
function isPBKDF2Hash(hash) {
    if (!hash || hash.startsWith('$2b$') || hash.startsWith('$2a$')) return false;
    if (hash.startsWith(PBKDF2_MODERN_PREFIX)) return true;
    const parts = hash.split(':');
    return parts.length === 2
        && /^[0-9a-f]{32}$/i.test(parts[0])
        && /^[0-9a-f]{64}$/i.test(parts[1]);
}

/**
 * Verify a password against a PBKDF2-HMAC-SHA256 hash (Go server format).
 * Supports both legacy "salt:hash" (100k iterations) and modern
 * "pbkdf2-sha256$<iter>$<salt>$<hash>" formats.
 */
function verifyPBKDF2(password, stored) {
    if (stored.startsWith(PBKDF2_MODERN_PREFIX)) {
        const parts = stored.split('$');
        // parts[0] === "pbkdf2-sha256", [1]=iter, [2]=hex-salt, [3]=hex-hash
        if (parts.length !== 4) return false;
        const iter = parseInt(parts[1], 10);
        if (!Number.isFinite(iter) || iter <= 0 || iter > 10_000_000) return false;
        let salt, expected;
        try {
            salt = Buffer.from(parts[2], 'hex');
            expected = Buffer.from(parts[3], 'hex');
        } catch (_) {
            return false;
        }
        if (salt.length === 0 || expected.length === 0) return false;
        const derived = crypto.pbkdf2Sync(password, salt, iter, expected.length, PBKDF2_DIGEST);
        return derived.length === expected.length && crypto.timingSafeEqual(expected, derived);
    }
    const parts = stored.split(':');
    if (parts.length !== 2) return false;
    const salt = Buffer.from(parts[0], 'hex');
    const expected = Buffer.from(parts[1], 'hex');
    const derived = crypto.pbkdf2Sync(password, salt, PBKDF2_LEGACY_ITERATIONS, PBKDF2_KEY_LENGTH, PBKDF2_DIGEST);
    return crypto.timingSafeEqual(expected, derived);
}

/**
 * Hash a password using bcrypt
 */
async function hashPassword(password) {
    return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify password against hash (supports both bcrypt and PBKDF2).
 * Returns { valid: boolean, needsMigration: boolean }
 */
async function verifyPasswordEx(password, hash) {
    if (isPBKDF2Hash(hash)) {
        return { valid: verifyPBKDF2(password, hash), needsMigration: true };
    }
    return { valid: await bcrypt.compare(password, hash), needsMigration: false };
}

/**
 * Verify password against hash (simple boolean, backward compatible)
 */
async function verifyPassword(password, hash) {
    const result = await verifyPasswordEx(password, hash);
    return result.valid;
}

/**
 * Cached lookup of the Go server's SSO status. Used to decide whether
 * unknown-user logins should be delegated to Go (for LDAP/OIDC users who
 * don't have a local account yet). Cache lasts 60s to avoid hammering the
 * Go server on every login attempt. Returns { ldap, oidc, any } booleans.
 */
let _ssoStatusCache = { at: 0, value: null };
const SSO_STATUS_TTL_MS = 60_000;

function getGoSSOStatus() {
    const now = Date.now();
    if (_ssoStatusCache.value && (now - _ssoStatusCache.at) < SSO_STATUS_TTL_MS) {
        return Promise.resolve(_ssoStatusCache.value);
    }
    const apiUrl = config.betterdeskApiUrl || config.hbbsApiUrl || 'http://localhost:21114/api';
    let statusUrl;
    try {
        const base = new URL(apiUrl);
        statusUrl = new URL('/api/auth/sso/status', base.origin);
    } catch (_) {
        return Promise.resolve({ ldap: false, oidc: false, any: false });
    }
    const mod = statusUrl.protocol === 'https:' ? https : http;
    const timeout = config.betterdeskApiTimeout || 3000;

    return new Promise((resolve) => {
        const req = mod.request(statusUrl, {
            method: 'GET',
            timeout,
            rejectUnauthorized: !config.allowSelfSignedCerts,
        }, (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                let value = { ldap: false, oidc: false, any: false };
                if (res.statusCode === 200) {
                    try {
                        const parsed = JSON.parse(data);
                        value = {
                            ldap: !!parsed.ldap_enabled,
                            oidc: !!parsed.oidc_enabled,
                            any: !!parsed.any_enabled,
                        };
                    } catch (_) { /* keep defaults */ }
                }
                _ssoStatusCache = { at: now, value };
                resolve(value);
            });
        });
        req.on('error', () => resolve({ ldap: false, oidc: false, any: false }));
        req.on('timeout', () => { req.destroy(); resolve({ ldap: false, oidc: false, any: false }); });
        req.end();
    });
}

const VALID_AUTH_PROVIDERS = new Set(['local', 'ldap', 'oidc']);

function normalizeAuthProvider(provider) {
    const value = String(provider || 'local').trim().toLowerCase();
    return VALID_AUTH_PROVIDERS.has(value) ? value : 'local';
}

function inferAuthProviderFromSSO(goResult, ssoStatus) {
    if (goResult && goResult.auth_provider) {
        return normalizeAuthProvider(goResult.auth_provider);
    }
    if (ssoStatus && ssoStatus.ldap && !ssoStatus.oidc) return 'ldap';
    if (ssoStatus && ssoStatus.oidc && !ssoStatus.ldap) return 'oidc';
    return 'local';
}

/** Random bcrypt hash that cannot match a real password (Issue #148). */
async function unusablePasswordHash() {
    return hashPassword(crypto.randomBytes(32).toString('hex'));
}

function isExternalAuthProvider(provider) {
    const p = normalizeAuthProvider(provider);
    return p === 'ldap' || p === 'oidc';
}

function isExternalAuthResult(goResult) {
    if (!goResult) return false;
    return isExternalAuthProvider(goResult.auth_provider);
}

async function syncLocalUserFromGoResult(localUser, goResult, password, ssoStatus) {
    if (!localUser || !goResult) return localUser;

    const authProvider = inferAuthProviderFromSSO(goResult, ssoStatus);
    const role = goResult.role || localUser.role;
    const sync = {};

    if (authProvider !== normalizeAuthProvider(localUser.auth_provider)) {
        sync.authProvider = authProvider;
    }
    if (role && role !== localUser.role) {
        sync.role = role;
    }
    // Never store IdP passwords in auth.db for LDAP/OIDC accounts.
    if (password && authProvider === 'local') {
        sync.passwordHash = await hashPassword(password);
    } else if (authProvider !== 'local'
        && authProvider !== normalizeAuthProvider(localUser.auth_provider)) {
        sync.passwordHash = await unusablePasswordHash();
    }

    if (Object.keys(sync).length === 0) {
        return localUser;
    }

    await db.syncUserFromGo(localUser.id, sync);
    console.log(`[AUTH] Synced '${localUser.username}' from Go (provider=${authProvider}, role=${role})`);
    return {
        ...localUser,
        role: sync.role || localUser.role,
        auth_provider: sync.authProvider || localUser.auth_provider || 'local',
    };
}

async function provisionLocalUserFromGo(username, password, goResult, ssoStatus) {
    const authProvider = inferAuthProviderFromSSO(goResult, ssoStatus);
    const role = goResult.role || 'viewer';
    const passwordHash = authProvider === 'local'
        ? await hashPassword(password)
        : await unusablePasswordHash();

    let user = await db.getUserByUsername(username);
    if (user) {
        return syncLocalUserFromGoResult(user, goResult, null, ssoStatus);
    }

    try {
        await db.createUser(username, passwordHash, role, authProvider);
    } catch (err) {
        // Shared PostgreSQL users table: Go may have created the row first.
        user = await db.getUserByUsername(username);
        if (!user) throw err;
        return syncLocalUserFromGoResult(user, goResult, null, ssoStatus);
    }

    user = await db.getUserByUsername(username);
    if (user && (user.auth_provider !== authProvider || user.role !== role)) {
        await db.syncUserFromGo(user.id, { authProvider, role });
        user = { ...user, auth_provider: authProvider, role };
    }
    return user;
}

/**
 * Build a successful authenticate() response from a local user row.
 */
function authSuccessFromUser(user, goResult) {
    if (user.role === 'pro') {
        return null;
    }
    if (user.totp_enabled) {
        return {
            id: user.id,
            username: user.username,
            role: user.role,
            preferred_language: user.preferred_language || null,
            totpRequired: true,
            goPartialToken: goResult && goResult.partial_token,
        };
    }
    return {
        id: user.id,
        username: user.username,
        role: user.role,
        preferred_language: user.preferred_language || null,
        totpRequired: !!(goResult && goResult.requires2fa),
    };
}

/**
 * Fallback authentication against Go server's /api/auth/login endpoint.
 * Used when local (Node.js) auth fails — the Go server may have a different
 * password hash (e.g., after fresh install race condition, or manual password
 * change on Go server side).
 * Returns { role, auth_provider } on success, or null on failure.
 */
function tryGoServerAuth(username, password) {
    const apiUrl = config.betterdeskApiUrl || config.hbbsApiUrl || 'http://localhost:21114/api';
    let authUrl;
    try {
        const base = new URL(apiUrl);
        authUrl = new URL('/api/auth/login', base.origin);
    } catch (_) {
        return Promise.resolve(null);
    }

    const body = JSON.stringify({ username, password });
    const mod = authUrl.protocol === 'https:' ? https : http;
    const timeout = config.betterdeskApiTimeout || 3000;

    return new Promise((resolve) => {
        const req = mod.request(authUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout,
            rejectUnauthorized: !config.allowSelfSignedCerts,
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const parsed = JSON.parse(data);
                        // Go server returns { token, role, username, auth_provider } on success
                        if (parsed.token && parsed.role) {
                            resolve({
                                role: parsed.role,
                                auth_provider: parsed.auth_provider,
                            });
                            return;
                        }
                        // 2FA required — credentials are valid but need second factor
                        if (parsed.requires_2fa) {
                            resolve({ role: 'admin', requires2fa: true });
                            return;
                        }
                    } catch (_) { /* JSON parse error */ }
                }
                resolve(null);
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.write(body);
        req.end();
    });
}

/**
 * Authenticate user with username and password.
 *
 * Provider-bound flow (Issue #148, mirrors Go server):
 *   - oidc accounts: password login rejected
 *   - ldap accounts: always authenticate via Go (role/provider synced each login)
 *   - local accounts: local password only; never fall through to LDAP
 *   - unknown users: provision via Go when SSO or BETTERDESK_AUTH_AUTOCREATE is on
 *
 * Returns user object with totpRequired flag if 2FA is enabled.
 */
async function authenticate(username, password) {
    // Safeguard: reject empty username immediately (Issue #104)
    if (!username || typeof username !== 'string' || username.trim() === '') {
        console.log(`[AUTH] Rejected authenticate() with empty/invalid username: ${JSON.stringify(username)}`);
        return null;
    }

    const ssoStatus = await getGoSSOStatus();
    let user = await db.getUserByUsername(username);

    if (user) {
        const provider = normalizeAuthProvider(user.auth_provider);

        if (provider === 'oidc') {
            console.log(`[AUTH] Login failed: '${username}' is an SSO account (password login not allowed)`);
            return null;
        }

        if (provider === 'ldap') {
            const goResult = await tryGoServerAuth(username, password);
            if (!goResult) {
                console.log(`[AUTH] Login failed: LDAP credentials rejected for '${username}'`);
                return null;
            }
            console.log(`[AUTH] Go server accepted LDAP login for '${username}' — syncing local account`);
            user = await syncLocalUserFromGoResult(user, goResult, null, ssoStatus);
            const result = authSuccessFromUser(user, goResult);
            if (!result) return null;
            if (!result.totpRequired) {
                await db.updateLastLogin(user.id);
            }
            return result;
        }

        // Local account — verify password locally only (no LDAP fallthrough).
        const hashType = isPBKDF2Hash(user.password_hash) ? 'PBKDF2'
            : (user.password_hash && user.password_hash.startsWith('$2')) ? 'bcrypt'
            : 'unknown';
        console.log(`[AUTH] Verifying password for '${username}' (hash type: ${hashType}, length: ${(user.password_hash || '').length})`);

        const { valid, needsMigration } = await verifyPasswordEx(password, user.password_hash);

        if (!valid) {
            // Go may hold a newer hash after a password change on the server side.
            const goResult = await tryGoServerAuth(username, password);
            if (goResult) {
                // Collision hardening: never auto-convert a local account to LDAP/OIDC.
                // If Go accepted the password via an external provider, treat this as a
                // username collision and require admin intervention (Issue #148 follow-up).
                if (isExternalAuthResult(goResult)) {
                    console.log(`[AUTH] Login blocked: username collision for local '${username}' (Go provider=${normalizeAuthProvider(goResult.auth_provider)})`);
                    return null;
                }
                console.log(`[AUTH] Go server accepted password for local '${username}' — syncing hash`);
                user = await syncLocalUserFromGoResult(user, goResult, password, ssoStatus);
            } else {
                console.log(`[AUTH] Login failed: password mismatch for '${username}' (hash type: ${hashType})`);
                return null;
            }
        } else {
            console.log(`[AUTH] Login successful for '${username}'`);
            if (needsMigration) {
                try {
                    const bcryptHash = await hashPassword(password);
                    await db.updateUserPassword(user.id, bcryptHash);
                    console.log(`[AUTH] Migrated password hash from PBKDF2 to bcrypt for user: ${username}`);
                } catch (err) {
                    console.warn(`[AUTH] Failed to migrate password hash for ${username}:`, err.message);
                }
            }
        }

        const result = authSuccessFromUser(user, null);
        if (!result) return null;
        if (!result.totpRequired) {
            await db.updateLastLogin(user.id);
        }
        return result;
    }

    // Unknown user — timing-safe dummy compare, then Go provisioning.
    await bcrypt.compare(password, DUMMY_HASH);

    const autoCreateEnv = process.env.BETTERDESK_AUTH_AUTOCREATE === 'true';
    const autoCreateEnabled = autoCreateEnv || ssoStatus.any;

    if (autoCreateEnabled) {
        const goResult = await tryGoServerAuth(username, password);
        if (goResult) {
            const reason = autoCreateEnv ? 'BETTERDESK_AUTH_AUTOCREATE=true'
                : ssoStatus.ldap && ssoStatus.oidc ? 'LDAP+OIDC enabled on Go server'
                : ssoStatus.ldap ? 'LDAP enabled on Go server'
                : 'OIDC enabled on Go server';
            console.log(`[AUTH] Go server accepted credentials for '${username}' — provisioning local user (${reason})`);
            const created = await provisionLocalUserFromGo(username, password, goResult, ssoStatus);
            if (created) {
                const result = authSuccessFromUser(created, goResult);
                if (!result) return null;
                if (!result.totpRequired) {
                    await db.updateLastLogin(created.id);
                }
                return result;
            }
        }
    }

    console.log(`[AUTH] Login failed: user '${username}' not found in database`);
    return null;
}

/**
 * Ensure a user record exists in the local database for session storage.
 * If the user doesn't exist locally, create it. If it exists, update the
 * password hash (for emergency fallback) and role.
 *
 * @param {string} username
 * @param {string} password   — plaintext (available only during login)
 * @param {string} role
 * @returns {Promise<Object|null>} — local user record
 */
async function ensureLocalUserFromGo(username, password, role, authProvider = 'local') {
    let localUser = await db.getUserByUsername(username);
    const provider = normalizeAuthProvider(authProvider);

    // Sync password hash for emergency fallback (only for admin roles)
    const shouldSyncHash = EMERGENCY_ADMIN_ROLES.has(role) && provider === 'local';

    if (!localUser) {
        // Auto-create local user from Go server data
        try {
            const bcryptHash = provider === 'local'
                ? await hashPassword(password)
                : await unusablePasswordHash();
            await db.createUser(username, bcryptHash, role, provider);
            localUser = await db.getUserByUsername(username);
            if (localUser) {
                console.log(`[AUTH] Auto-created local user '${username}' (role: ${role}, provider: ${provider}) for session storage`);
            }
        } catch (err) {
            console.warn(`[AUTH] Failed to auto-create local user '${username}': ${err.message}`);
        }
    } else if (shouldSyncHash) {
        // Update local hash so emergency fallback always has current password
        try {
            const bcryptHash = await hashPassword(password);
            await db.updateUserPassword(localUser.id, bcryptHash);
        } catch (err) {
            console.warn(`[AUTH] Failed to sync local hash for '${username}': ${err.message}`);
        }
        // Sync role if changed on Go side
        if (localUser.role !== role) {
            try {
                await db.updateUserRole(localUser.id, role);
                localUser.role = role;
            } catch (_) { /* updateUserRole may not exist in all adapters */ }
        }
    }

    return localUser;
}

/**
 * Check if the installation scripts requested a forced password update.
 * Two mechanisms: sentinel file (.force_password_update) or env var FORCE_PASSWORD_UPDATE.
 * Returns true if force update is requested, and removes the sentinel file.
 */
function checkForcePasswordUpdate() {
    // Env var (Docker installs set FORCE_PASSWORD_UPDATE=true in compose)
    if (process.env.FORCE_PASSWORD_UPDATE === 'true') {
        console.log(`[AUTH] FORCE_PASSWORD_UPDATE env var detected — will force admin password update`);
        // Clear the env var so it only takes effect once per startup
        delete process.env.FORCE_PASSWORD_UPDATE;
        return true;
    }
    // Sentinel file (native installs create .force_password_update in data dir)
    const sentinelPath = path.join(config.dataDir || '.', '.force_password_update');
    try {
        if (fs.existsSync(sentinelPath)) {
            console.log(`[AUTH] .force_password_update sentinel file detected — will force admin password update`);
            fs.unlinkSync(sentinelPath);
            return true;
        }
    } catch (_) { /* ignore fs errors */ }
    return false;
}

/**
 * Try to read the admin password from the Go server's .admin_credentials file.
 * The Go server writes this file on first run (main.go) when it auto-generates
 * a random admin password. Format:
 *   Admin Username: admin
 *   Admin Password: <plaintext>
 *   ...
 * Returns the password string or null if file is missing/unreadable.
 */
function readAdminCredentialsFile() {
    // Search multiple candidate directories (Go server's DB dir may differ from keysPath)
    const candidates = [
        config.dataDir,
        config.keysPath,
        path.join(config.keysPath, 'data'),
        '/opt/betterdesk',
        '/opt/betterdesk/data',
        '/opt/rustdesk',
        '/opt/rustdesk/data',
    ];
    if (process.platform === 'win32') {
        candidates.push('C:\\BetterDesk', 'C:\\BetterDesk\\data',
                         'C:\\RustDesk', 'C:\\RustDesk\\data');
    }
    // Docker: also check /app/data if not already covered
    if (fs.existsSync('/.dockerenv') || process.env.DOCKER === 'true') {
        if (!candidates.includes('/app/data')) candidates.push('/app/data');
    }
    for (const dir of candidates) {
        if (!dir) continue;
        const filePath = path.join(dir, '.admin_credentials');
        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                const match = content.match(/^Admin Password:\s*(.+)$/m);
                if (match && match[1].trim()) {
                    console.log(`[AUTH] Read admin password from ${filePath}`);
                    return match[1].trim();
                }
            }
        } catch (_) { /* permission denied or read error — try next */ }
    }
    return null;
}

/**
 * Create default admin user if no users exist.
 * In PostgreSQL mode, the Go server may have already created the admin user
 * with a PBKDF2 hash. In that case, we migrate the hash to bcrypt format
 * using the password from DEFAULT_ADMIN_PASSWORD env var.
 */
async function ensureDefaultAdmin() {
    const defaultUsername = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
    let defaultPassword = process.env.DEFAULT_ADMIN_PASSWORD || '';

    // If no password from env, try reading from Go server's .admin_credentials file.
    // The Go server writes this file on first run when it generates a random password.
    // Format: "Admin Username: admin\nAdmin Password: <password>\n..."
    if (!defaultPassword) {
        defaultPassword = readAdminCredentialsFile() || '';
    }

    const forceUpdate = checkForcePasswordUpdate();

    console.log(`[AUTH] ensureDefaultAdmin: checking for existing users...`);

    if (await db.hasUsers()) {
        // Users exist — check if the admin's hash needs migration from PBKDF2 to bcrypt.
        // This handles the case where the Go server created the user first (PostgreSQL shared DB).
        if (defaultPassword) {
            const admin = await db.getUserByUsername(defaultUsername);
            if (admin && isPBKDF2Hash(admin.password_hash)) {
                console.log(`[AUTH] Found admin user with PBKDF2 hash (created by Go server). Migrating to bcrypt...`);
                if (verifyPBKDF2(defaultPassword, admin.password_hash)) {
                    const bcryptHash = await hashPassword(defaultPassword);
                    await db.updateUserPassword(admin.id, bcryptHash);
                    console.log(`[AUTH] Admin password hash migrated from PBKDF2 to bcrypt successfully`);
                } else {
                    console.warn(`[AUTH] DEFAULT_ADMIN_PASSWORD does not match existing PBKDF2 hash — skipping migration`);
                }
            } else if (admin) {
                const hashType = (admin.password_hash || '').startsWith('$2') ? 'bcrypt' : 'unknown';
                // Only force password write on explicit fresh-install sentinel (issue #158).
                // Routine updates must never change users.password_hash in auth.db / PostgreSQL.
                if (forceUpdate && defaultPassword) {
                    console.log(`[AUTH] Force password update requested — updating admin password`);
                    const bcryptHash = await hashPassword(defaultPassword);
                    await db.updateUserPassword(admin.id, bcryptHash);
                    console.log(`[AUTH] Admin password hash force-updated to match DEFAULT_ADMIN_PASSWORD`);
                } else {
                    console.log(`[AUTH] Admin user '${defaultUsername}' exists (${hashType}) — password unchanged`);
                }
            }
        } else {
            console.log(`[AUTH] Users exist, no DEFAULT_ADMIN_PASSWORD set — skipping admin check`);
        }
        return false;
    }
    
    // No users at all — create the default admin.
    // If no password from env or credential file, retry reading multiple times.
    // The Go server may still be starting up and hasn't written .admin_credentials yet.
    if (!defaultPassword) {
        const retryDelays = [2000, 3000, 5000, 5000, 10000]; // 5 retries: 2s, 3s, 5s, 5s, 10s (total 25s max)
        for (let i = 0; i < retryDelays.length; i++) {
            console.log(`[AUTH] No admin password found. Waiting for Go server (attempt ${i + 1}/${retryDelays.length})...`);
            await new Promise(resolve => setTimeout(resolve, retryDelays[i]));
            defaultPassword = readAdminCredentialsFile() || '';
            if (defaultPassword) {
                console.log(`[AUTH] Found admin password from Go server on retry ${i + 1}`);
                break;
            }
        }
    }

    const password = defaultPassword || require('crypto').randomBytes(16).toString('hex');
    
    // If we generated the password (not from env or Go server), write it to a shared location
    // so it can be discovered by users or other services.
    if (!defaultPassword) {
        const credsPath = path.join(config.dataDir, '.admin_credentials');
        try {
            const credsContent = `Admin Username: ${defaultUsername}\nAdmin Password: ${password}\nGenerated by: BetterDesk Console (Node.js)\nTimestamp: ${new Date().toISOString()}\n`;
            fs.writeFileSync(credsPath, credsContent, { mode: 0o600 });
            console.log(`[AUTH] Wrote generated admin credentials to ${credsPath}`);
        } catch (e) {
            console.warn(`[AUTH] Could not write .admin_credentials to ${credsPath}: ${e.message}`);
        }
    }

    const hash = await hashPassword(password);
    await db.createUser(defaultUsername, hash, 'admin');
    
    // Verify the hash was stored correctly (self-test)
    const created = await db.getUserByUsername(defaultUsername);
    if (created) {
        const selfTest = await bcrypt.compare(password, created.password_hash);
        if (selfTest) {
            console.log(`[AUTH] Admin user '${defaultUsername}' created and verified successfully`);
        } else {
            console.error(`[AUTH] CRITICAL: Admin password self-test FAILED! Hash may be corrupted. Re-hashing...`);
            const retryHash = await hashPassword(password);
            await db.updateUserPassword(created.id, retryHash);
            const retryTest = await bcrypt.compare(password, retryHash);
            console.log(`[AUTH] Re-hash result: ${retryTest ? 'OK' : 'STILL FAILING — bcrypt may be broken'}`);
        }
    } else {
        console.error(`[AUTH] CRITICAL: createUser succeeded but getUserByUsername returned null for '${defaultUsername}'`);
    }
    
    if (!defaultPassword) {
        console.log(`Generated admin password: ${password}`);
    }
    console.log('IMPORTANT: Change the default password immediately!');
    
    return true;
}

/**
 * Change user password
 */
async function changePassword(userId, currentPassword, newPassword) {
    const user = await db.getUserById(userId);
    if (!user) {
        return { success: false, error: 'User not found' };
    }
    
    const valid = await verifyPassword(currentPassword, user.password_hash);
    if (!valid) {
        return { success: false, error: 'Current password is incorrect' };
    }
    
    // Validate new password strength
    if (newPassword.length < 8) {
        return { success: false, error: 'Password must be at least 8 characters' };
    }
    
    const newHash = await hashPassword(newPassword);
    await db.updateUserPassword(userId, newHash);
    
    return { success: true };
}

/**
 * Validate password strength
 */
function validatePasswordStrength(password) {
    const result = {
        score: 0,
        feedback: []
    };
    
    if (password.length >= 8) result.score += 1;
    else result.feedback.push('Use at least 8 characters');
    
    if (password.length >= 12) result.score += 1;
    
    if (/[a-z]/.test(password)) result.score += 1;
    else result.feedback.push('Add lowercase letters');
    
    if (/[A-Z]/.test(password)) result.score += 1;
    else result.feedback.push('Add uppercase letters');
    
    if (/[0-9]/.test(password)) result.score += 1;
    else result.feedback.push('Add numbers');
    
    if (/[^a-zA-Z0-9]/.test(password)) result.score += 1;
    else result.feedback.push('Add special characters');
    
    result.strength = result.score <= 2 ? 'weak' : result.score <= 4 ? 'medium' : 'strong';
    
    return result;
}

// ==================== TOTP (2FA) Functions ====================

/**
 * Generate TOTP secret and QR code for user setup
 */
async function generateTotpSetup(userId) {
    const user = await db.getUserById(userId);
    if (!user) {
        return { success: false, error: 'User not found' };
    }
    
    // Generate secret
    const secret = authenticator.generateSecret();
    
    // Save secret to DB (not yet enabled)
    await db.saveTotpSecret(userId, secret);
    
    // Generate otpauth URI
    const otpauthUrl = authenticator.keyuri(user.username, 'BetterDesk Console', secret);
    
    // Generate QR code as data URL
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl, {
        width: 256,
        margin: 2,
        color: {
            dark: '#000000',
            light: '#ffffff'
        }
    });
    
    return {
        success: true,
        secret,
        qrCode: qrCodeDataUrl,
        otpauthUrl
    };
}

/**
 * Verify TOTP code and enable 2FA
 */
async function verifyAndEnableTotp(userId, token) {
    const user = await db.getUserById(userId);
    if (!user || !user.totp_secret) {
        return { success: false, error: 'TOTP not set up' };
    }
    
    // Verify the token against the stored secret
    const isValid = authenticator.verify({
        token,
        secret: user.totp_secret
    });
    
    if (!isValid) {
        return { success: false, error: 'Invalid verification code' };
    }
    
    // Generate recovery codes
    const recoveryCodes = generateRecoveryCodes(8);
    
    // Enable TOTP
    await db.enableTotp(userId, recoveryCodes);
    
    return {
        success: true,
        recoveryCodes
    };
}

/**
 * Verify TOTP code during login
 */
async function verifyTotpCode(userId, token) {
    const user = await db.getUserById(userId);
    if (!user || !user.totp_enabled || !user.totp_secret) {
        return false;
    }
    
    const isValid = authenticator.verify({
        token,
        secret: user.totp_secret
    });
    
    return isValid;
}

/**
 * Verify recovery code during login
 */
async function verifyRecoveryCode(userId, code) {
    const user = await db.getUserById(userId);
    if (!user || !user.totp_enabled || !user.totp_recovery_codes) {
        return false;
    }
    
    let codes;
    try {
        codes = JSON.parse(user.totp_recovery_codes);
    } catch (e) {
        return false;
    }
    
    const normalizedCode = code.trim().toUpperCase();
    const index = codes.findIndex(c => c.toUpperCase() === normalizedCode);
    
    if (index === -1) {
        return false;
    }
    
    // Remove used code
    codes.splice(index, 1);
    await db.useRecoveryCode(userId, codes);
    
    return true;
}

/**
 * Disable TOTP for user
 */
async function disableTotp(userId) {
    await db.disableTotp(userId);
    return { success: true };
}

/**
 * Check if user has TOTP enabled
 */
async function isTotpEnabled(userId) {
    const user = await db.getUserById(userId);
    return user ? !!user.totp_enabled : false;
}

/**
 * Generate random recovery codes
 */
function generateRecoveryCodes(count = 8) {
    const codes = [];
    for (let i = 0; i < count; i++) {
        const code = crypto.randomBytes(4).toString('hex').toUpperCase();
        codes.push(code.slice(0, 4) + '-' + code.slice(4));
    }
    return codes;
}

// ==================== RustDesk Client API Token Functions ====================

const TOKEN_EXPIRY_DAYS = parseInt(process.env.API_TOKEN_EXPIRY_DAYS, 10) || 7;
const MAX_FAILED_ATTEMPTS = parseInt(process.env.API_MAX_FAILED_ATTEMPTS, 10) || 10;
const LOCKOUT_MINUTES = parseInt(process.env.API_LOCKOUT_MINUTES, 10) || 15;
const IP_RATE_LIMIT = parseInt(process.env.API_IP_RATE_LIMIT, 10) || 30;
const ATTEMPT_WINDOW_MINUTES = parseInt(process.env.API_ATTEMPT_WINDOW, 10) || 15;

/**
 * Generate a secure access token for RustDesk client
 * Token format: 64 hex chars (256 bits of entropy)
 */
async function generateAccessToken(userId, clientId, clientUuid, ipAddress) {
    // Revoke old tokens for the same client device
    await db.revokeUserClientTokens(userId, clientId, clientUuid);

    // Generate cryptographically secure token
    const token = crypto.randomBytes(32).toString('hex');

    // Calculate expiry
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000)
        .toISOString().replace('T', ' ').replace('Z', '');

    await db.createAccessToken(token, userId, clientId, clientUuid, expiresAt, ipAddress);

    return token;
}

/**
 * Validate an access token and return associated user
 */
async function validateAccessToken(token) {
    if (!token || typeof token !== 'string' || token.length !== 64) {
        return null;
    }

    const tokenRecord = await db.getAccessToken(token);
    if (!tokenRecord) {
        return null;
    }

    const user = await db.getUserById(tokenRecord.user_id);
    if (!user) {
        return null;
    }

    // Update last_used
    await db.touchAccessToken(token);

    return {
        id: user.id,
        username: user.username,
        role: user.role,
        clientId: tokenRecord.client_id,
        clientUuid: tokenRecord.client_uuid
    };
}

/**
 * Revoke all tokens for a user+client during logout
 */
async function revokeClientTokens(userId, clientId, clientUuid) {
    if (clientId && clientUuid) {
        await db.revokeUserClientTokens(userId, clientId, clientUuid);
    } else {
        await db.revokeAllUserTokens(userId);
    }
}

// ==================== Brute-Force Protection ====================

/**
 * Check if login should be blocked (account lockout or IP rate limit)
 * Returns { blocked: boolean, reason: string, retryAfter: number }
 */
async function checkBruteForce(username, ipAddress) {
    // Check account lockout
    if (username) {
        const lockout = await db.getAccountLockout(username);
        if (lockout) {
            const retryAfter = Math.ceil(
                (new Date(lockout.locked_until + 'Z').getTime() - Date.now()) / 1000
            );
            return {
                blocked: true,
                reason: 'Account temporarily locked due to too many failed attempts',
                retryAfter: Math.max(retryAfter, 1)
            };
        }
    }

    // Check IP rate limiting
    if (ipAddress) {
        const ipAttempts = await db.countRecentFailedAttemptsFromIp(ipAddress, ATTEMPT_WINDOW_MINUTES);
        if (ipAttempts >= IP_RATE_LIMIT) {
            return {
                blocked: true,
                reason: 'Too many failed attempts from this IP address',
                retryAfter: ATTEMPT_WINDOW_MINUTES * 60
            };
        }
    }

    return { blocked: false };
}

/**
 * Record a login attempt and potentially lock account
 */
async function recordAttempt(username, ipAddress, success) {
    await db.recordLoginAttempt(username, ipAddress, success);

    if (success) {
        // Clear lockout on successful login
        await db.clearAccountLockout(username);
        return;
    }

    // Check if we need to lock the account
    const failedCount = await db.countRecentFailedAttempts(username, ATTEMPT_WINDOW_MINUTES);
    if (failedCount >= MAX_FAILED_ATTEMPTS) {
        const lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
            .toISOString().replace('T', ' ').replace('Z', '');
        await db.lockAccount(username, lockedUntil, failedCount);
    }
}

/**
 * Run periodic housekeeping (expired tokens, old attempts)
 */
async function cleanupHousekeeping() {
    try {
        await db.cleanupExpiredTokens();
        await db.cleanupOldLoginAttempts();
    } catch (err) {
        console.error('Housekeeping error:', err.message);
    }
}

module.exports = {
    hashPassword,
    verifyPassword,
    authenticate,
    ensureDefaultAdmin,
    changePassword,
    validatePasswordStrength,
    // Go server delegation (Phase A)
    checkGoServerHealth,
    authenticateViaGo,
    verifyTotpViaGo,
    // TOTP
    generateTotpSetup,
    verifyAndEnableTotp,
    verifyTotpCode,
    verifyRecoveryCode,
    disableTotp,
    isTotpEnabled,
    // RustDesk Client API tokens
    generateAccessToken,
    validateAccessToken,
    revokeClientTokens,
    // Brute-force protection
    checkBruteForce,
    recordAttempt,
    cleanupHousekeeping,
    // Issue #148 — exported for unit tests
    normalizeAuthProvider,
    inferAuthProviderFromSSO,
    isExternalAuthProvider,
    isExternalAuthResult,
};
