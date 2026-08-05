/**
 * BetterDesk Console - Configuration
 * Loads settings from environment variables with sensible defaults
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ===== Load .env file as fallback (for Windows NSSM compatibility) =====
// On Linux, systemd uses EnvironmentFile to load .env; on Windows (NSSM) there
// is no such mechanism, so we parse .env manually here.  Existing env vars
// (set by NSSM AppEnvironmentExtra or the OS) are never overridden.
const _envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(_envFile)) {
    try {
        const _lines = fs.readFileSync(_envFile, 'utf8').split(/\r?\n/);
        for (const _line of _lines) {
            const _trimmed = _line.trim();
            if (!_trimmed || _trimmed.startsWith('#')) continue;
            const _eq = _trimmed.indexOf('=');
            if (_eq > 0) {
                const _key = _trimmed.substring(0, _eq).trim();
                const _val = _trimmed.substring(_eq + 1).trim();
                if (!process.env[_key]) {
                    process.env[_key] = _val;
                }
            }
        }
    } catch (_e) { /* .env read failed — continue with existing env vars */ }
}

const { readProductVersion } = require('../lib/productVersion');
const pkgVersion = readProductVersion({ consoleDir: path.join(__dirname, '..') });

// Environment / platform detection
const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';
const isDocker = fs.existsSync('/.dockerenv') || process.env.DOCKER === 'true';
const isWindows = process.platform === 'win32';

// Base paths
// Support multiple env var names for compatibility with different install scripts
const DATA_DIR = process.env.DATA_DIR || (isDocker ? '/app/data' : path.join(__dirname, '..', 'data'));

// KEYS_PATH: directory where Go server writes .api_key, id_ed25519, id_ed25519.pub
// Priority: env vars → auto-detect existing directory → platform default
function resolveKeysPath() {
    const fromEnv = process.env.KEYS_PATH || process.env.RUSTDESK_DIR || process.env.RUSTDESK_PATH;
    if (fromEnv) return fromEnv;
    if (isDocker) return '/opt/rustdesk';
    if (isWindows) {
        // Prefer C:\BetterDesk, fall back to C:\RustDesk for legacy installs
        if (fs.existsSync('C:\\BetterDesk\\id_ed25519')) return 'C:\\BetterDesk';
        if (fs.existsSync('C:\\RustDesk\\id_ed25519')) return 'C:\\RustDesk';
        return 'C:\\BetterDesk';
    }
    // Linux: check both paths, prefer /opt/betterdesk (new), fall back to /opt/rustdesk (legacy)
    if (fs.existsSync('/opt/betterdesk/id_ed25519')) return '/opt/betterdesk';
    if (fs.existsSync('/opt/rustdesk/id_ed25519')) return '/opt/rustdesk';
    // Neither exists yet — use new default
    return '/opt/betterdesk';
}
const KEYS_PATH = resolveKeysPath();
const RUSTDESK_DIR = KEYS_PATH;

// Warn if KEYS_PATH was auto-detected and looks wrong
if (process.env.NODE_ENV !== 'test'
    && !process.env.KEYS_PATH && !process.env.RUSTDESK_DIR && !process.env.RUSTDESK_PATH) {
    const apiKeyFile = path.join(KEYS_PATH, '.api_key');
    const keyFile = path.join(KEYS_PATH, 'id_ed25519');
    if (!fs.existsSync(apiKeyFile) && !fs.existsSync(keyFile)) {
        console.warn(`⚠️  KEYS_PATH auto-detected as "${KEYS_PATH}" but no .api_key or id_ed25519 found there.`);
        console.warn('   Set KEYS_PATH in .env to point to the Go server data directory.');
    }
}

// Database path
const DB_PATH = process.env.DB_PATH || path.join(RUSTDESK_DIR, 'db_v2.sqlite3');
// Legacy SQLite panel store. Existing installations retain this file until the
// versioned consolidation has completed; new installs never create it.
const AUTH_DB_PATH = process.env.AUTH_DB_PATH || path.join(DATA_DIR, 'auth.db');

// Key paths
const PUB_KEY_PATH = process.env.PUB_KEY_PATH || path.join(KEYS_PATH, 'id_ed25519.pub');
const API_KEY_PATH = process.env.API_KEY_PATH || path.join(KEYS_PATH, '.api_key');

// Read API key from file if exists
let apiKey = process.env.BETTERDESK_API_KEY || process.env.HBBS_API_KEY || '';
if (!apiKey && fs.existsSync(API_KEY_PATH)) {
    try {
        apiKey = fs.readFileSync(API_KEY_PATH, 'utf8').trim();
    } catch (err) {
        console.warn('Warning: Could not read API key file:', err.message);
    }
}

// Session secret - generate if not provided
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
    const secretFile = path.join(DATA_DIR, '.session_secret');
    if (fs.existsSync(secretFile)) {
        sessionSecret = fs.readFileSync(secretFile, 'utf8').trim();
    } else {
        sessionSecret = crypto.randomBytes(32).toString('hex');
        try {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            fs.writeFileSync(secretFile, sessionSecret, { mode: 0o600 });
        } catch (err) {
            console.warn('Warning: Could not save session secret:', err.message);
        }
    }
}

// Go API default port (signal_port - 2). :21121 is optional backward-compat proxy only.
const GO_API_PORT_DEFAULT = 21114;
const CLIENT_API_PORT_DEFAULT = 21121;

function parseApiUrlPort(urlString, fallback) {
    try {
        const u = new URL(urlString);
        if (u.port) return parseInt(u.port, 10);
        return u.protocol === 'https:' ? 443 : 80;
    } catch {
        return fallback;
    }
}

const _betterdeskApiUrlRaw = process.env.BETTERDESK_API_URL || process.env.HBBS_API_URL
    || `http://127.0.0.1:${GO_API_PORT_DEFAULT}/api`;
const goApiPort = parseInt(process.env.GO_API_PORT, 10)
    || parseApiUrlPort(_betterdeskApiUrlRaw, GO_API_PORT_DEFAULT);

module.exports = {
    // Environment
    nodeEnv: NODE_ENV,
    isProduction,
    isDocker,

    // Server
    port: parseInt(process.env.PORT, 10) || 5000,
    host: process.env.HOST || '127.0.0.1',

    // Go server HTTP API (REST + RustDesk handlers) — default :21114
    goApiPort,

    // Compatibility listener :21121 — reverse-proxy to Go (no business logic in Node).
    // Keeps existing RustDesk client configs on http://host:21121 unchanged.
    apiPort: parseInt(process.env.API_PORT, 10) || CLIENT_API_PORT_DEFAULT,
    apiHost: process.env.API_HOST || '0.0.0.0',
    apiEnabled: (process.env.API_ENABLED ?? 'true').toLowerCase() === 'true',
    apiProxyToGo: (process.env.RUSTDESK_API_PROXY ?? 'true').toLowerCase() === 'true',
    rustdeskApiTls: (process.env.RUSTDESK_API_TLS || 'auto').toLowerCase(),

    // Issue #104 mitigation:
    // Stock RustDesk OSS clients (e.g. v1.4.6) do not implement the
    // `tfa_check` 2FA challenge response shape returned by this API when a
    // user has TOTP enabled — they reject it as "bad response from server".
    // Setting RUSTDESK_API_DISABLE_TOTP=true makes /api/login on the
    // dedicated client API port (:21121) skip TOTP enforcement and issue an
    // access token directly after password auth. The web panel (port 5000 /
    // HTTPS 5443) is unaffected — TOTP is still enforced there.
    // Trade-off: any caller of /api/login with a valid username+password
    // will obtain a token without 2FA. Mitigations:
    //   - keep :21121 firewalled to LAN/VPN where possible,
    //   - use a dedicated low-privilege RustDesk service account,
    //   - rely on device bans / API key for admin endpoints.
    rustdeskApiDisableTotp: (process.env.RUSTDESK_API_DISABLE_TOTP || 'false').toLowerCase() === 'true',

    // H-04 mitigation (audit 2026-04-10):
    // Setting RUSTDESK_API_DISABLE_TOTP=true alone is no longer sufficient —
    // the operator must also opt in explicitly with
    // RUSTDESK_API_DISABLE_TOTP_ACKNOWLEDGED=true, confirming they have read
    // and accepted the WAN-port 2FA bypass risk. Without the ACK flag the
    // bypass is ignored and TOTP is enforced normally on :21121.
    rustdeskApiDisableTotpAck: (process.env.RUSTDESK_API_DISABLE_TOTP_ACKNOWLEDGED || 'false').toLowerCase() === 'true',

    // Device visibility for non-admin roles: open (legacy overlay ACL) or restricted (default-deny).
    deviceScopeDefault: (process.env.DEVICE_SCOPE_DEFAULT || 'open').toLowerCase(),

    // HTTPS / SSL
    httpsEnabled: (process.env.HTTPS_ENABLED || 'false').toLowerCase() === 'true',
    httpsPort: parseInt(process.env.HTTPS_PORT, 10) || 5443,
    sslCertPath: process.env.SSL_CERT_PATH || '',
    sslKeyPath: process.env.SSL_KEY_PATH || '',
    sslCaPath: process.env.SSL_CA_PATH || '',
    httpRedirect: (process.env.HTTP_REDIRECT_HTTPS || 'true').toLowerCase() === 'true',
    // Optional SHA-256 certificate pin embedded in signed Support Agent
    // bundles. This is public verifier material, never a private key.
    agentServerCertPin: String(process.env.BETTERDESK_AGENT_SERVER_CERT_PIN || '').trim(),

    // Paths
    dataDir: DATA_DIR,
    keysPath: KEYS_PATH,
    rustdeskDir: RUSTDESK_DIR,
    dbPath: DB_PATH,
    authDbPath: AUTH_DB_PATH,
    pubKeyPath: PUB_KEY_PATH,
    apiKeyPath: API_KEY_PATH,

    // Server backend (BetterDesk Go server)
    serverBackend: 'betterdesk',

    // BetterDesk Go Server API
    hbbsApiUrl: _betterdeskApiUrlRaw,
    hbbsApiKey: apiKey,
    hbbsApiTimeout: parseInt(process.env.BETTERDESK_API_TIMEOUT || process.env.HBBS_API_TIMEOUT, 10) || 3000,

    // BetterDesk Go Server API (preferred names)
    betterdeskApiUrl: _betterdeskApiUrlRaw,
    betterdeskApiKey: process.env.BETTERDESK_API_KEY || apiKey,
    betterdeskApiTimeout: parseInt(process.env.BETTERDESK_API_TIMEOUT, 10) || 5000,

    // TLS certificate verification (BD-2026-002)
    // Default is false (reject self-signed certs) for production safety.
    // Set ALLOW_SELF_SIGNED_CERTS=true only in dev/local environments where
    // the Go API is accessed over HTTPS with a self-signed cert.
    allowSelfSignedCerts: (process.env.ALLOW_SELF_SIGNED_CERTS || 'false').toLowerCase() === 'true',
    // SMTP TLS verification — separate control for outbound email.
    // Set to 'true' when using a trusted SMTP server with valid certificates.
    smtpTlsVerify: (process.env.SMTP_TLS_VERIFY || 'false').toLowerCase() === 'true',

    // Session
    sessionSecret: sessionSecret,
    sessionMaxAge: parseInt(process.env.SESSION_MAX_AGE, 10) || 24 * 60 * 60 * 1000, // 24 hours

    // Rate limiting
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60 * 1000, // 1 minute
    rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX, 10) || 100,
    loginRateLimitMax: parseInt(process.env.LOGIN_RATE_LIMIT_MAX, 10) || 5,

    // i18n
    defaultLanguage: process.env.DEFAULT_LANGUAGE || 'en',
    langDir: path.join(__dirname, '..', 'lang'),

    // WebSocket Proxy (for remote desktop web client)
    wsProxy: {
        hbbsHost: process.env.WS_HBBS_HOST || 'localhost',
        hbbsPort: parseInt(process.env.WS_HBBS_PORT, 10) || 21116,
        hbbrHost: process.env.WS_HBBR_HOST || 'localhost',
        hbbrPort: parseInt(process.env.WS_HBBR_PORT, 10) || 21117
    },

    // Database type: 'sqlite' (default) or 'postgres' (auto-detected from DATABASE_URL)
    dbType: (() => {
        const explicit = (process.env.DB_TYPE || '').toLowerCase();
        if (explicit === 'postgres' || explicit === 'postgresql') return 'postgres';
        if (explicit === 'sqlite') return 'sqlite';
        if (!explicit && process.env.DATABASE_URL && /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL)) return 'postgres';
        return 'sqlite';
    })(),
    databaseUrl: process.env.DATABASE_URL || '',

    // App info
    appName: 'BetterDesk Console',
    appVersion: pkgVersion,

    // Logging (default warn in production — see lib/logger.js)
    logLevel: (process.env.LOG_LEVEL || '').trim().toLowerCase() || (isProduction ? 'warn' : 'info'),
};

// H-2: warn when console→Go API traffic leaves localhost in production.
if (isProduction) {
    try {
        const raw = module.exports.betterdeskApiUrl || '';
        const apiUrl = new URL(raw.endsWith('/') ? raw : `${raw}/`);
        const host = apiUrl.hostname.toLowerCase();
        const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
        const isDockerBridge = host === 'betterdesk-server' || host.endsWith('.betterdesk-net');
        if (!localHosts.has(host) && !isDockerBridge) {
            console.warn(
                `[SECURITY] BETTERDESK_API_URL host is "${host}" — console→Go traffic should stay on localhost or the Docker internal network.`
            );
        }
    } catch (_) { /* invalid URL — other startup checks will surface it */ }
}
