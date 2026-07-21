'use strict';

const fs = require('fs');
const path = require('path');
const { upsertEnvKey } = require('../lib/envMerge');
const conn = require('./agentBundleConnection');

const CONSOLE_ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(CONSOLE_ROOT, '.env');
const DURABLE_BASENAME = 'public-endpoints.env';
const PANEL_PUBLIC_HOST_KEY = 'PANEL_PUBLIC_HOST';

const ENV_KEYS = {
    public_server_id: 'PUBLIC_SERVER_ID',
    public_relay_server: 'PUBLIC_RELAY_SERVER',
    public_api_url: 'PUBLIC_API_URL',
};

/** Keys persisted in the durable volume-backed file (non-secrets only). */
const DURABLE_KEYS = [
    ENV_KEYS.public_server_id,
    ENV_KEYS.public_relay_server,
    ENV_KEYS.public_api_url,
    PANEL_PUBLIC_HOST_KEY,
];

let _migrated = false;
/** @type {{ envPath?: string, durablePath?: string, dataDir?: string } | null} */
let _testPaths = null;

function getEnvPath() {
    if (_testPaths && _testPaths.envPath) return _testPaths.envPath;
    return ENV_PATH;
}

function getDataDir() {
    if (_testPaths && _testPaths.dataDir) return _testPaths.dataDir;
    // Lazy require avoids load-order issues with config.js
    const config = require('../config/config');
    return config.dataDir;
}

function getDurableEnvPath() {
    if (_testPaths && _testPaths.durablePath) return _testPaths.durablePath;
    return path.join(getDataDir(), DURABLE_BASENAME);
}

function parseEnvFile(content) {
    const out = {};
    if (!content) return out;
    for (const line of String(content).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return out;
}

function readEnvFileMap(filePath) {
    if (!fs.existsSync(filePath)) return {};
    try {
        return parseEnvFile(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return {};
    }
}

function nonEmpty(value) {
    if (value === undefined || value === null) return '';
    const trimmed = String(value).trim();
    return trimmed === '' ? '' : trimmed;
}

/**
 * Read precedence: non-empty process.env → durable file → console .env
 * Empty process.env must NOT mask durable/.env values (Docker Compose empty keys).
 */
function resolveEnvKey(key, durableMap, legacyMap) {
    const fromProcess = nonEmpty(process.env[key]);
    if (fromProcess) return fromProcess;
    const fromDurable = nonEmpty(durableMap[key]);
    if (fromDurable) return fromDurable;
    return nonEmpty(legacyMap[key]);
}

function assertNoEnvInjection(value) {
    if (value === undefined || value === null || value === '') return;
    if (/[\r\n\0]/.test(String(value))) {
        throw new Error('invalid_env_value');
    }
}

function normalizeHostField(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    assertNoEnvInjection(raw);
    const normalized = conn.normalizeServerHost(raw);
    if (!normalized.valid) {
        throw new Error('invalid_host');
    }
    assertNoEnvInjection(normalized.host);
    return normalized.host;
}

function normalizeApiUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    assertNoEnvInjection(raw);
    let urlStr = raw;
    if (!/^https?:\/\//i.test(urlStr)) {
        throw new Error('invalid_api_url');
    }
    try {
        const u = new URL(urlStr);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            throw new Error('invalid_api_url');
        }
        const pathPart = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '');
        const portPart = u.port ? `:${u.port}` : '';
        const out = `${u.protocol}//${u.hostname}${portPart}${pathPart}${u.search || ''}`;
        assertNoEnvInjection(out);
        return out;
    } catch (err) {
        if (err.message === 'invalid_api_url' || err.message === 'invalid_env_value') throw err;
        throw new Error('invalid_api_url');
    }
}

function normalizeSettings(raw = {}) {
    return {
        public_server_id: normalizeHostField(raw.public_server_id),
        public_relay_server: normalizeHostField(raw.public_relay_server),
        public_api_url: normalizeApiUrl(raw.public_api_url),
    };
}

function validateSettings(settings) {
    try {
        return normalizeSettings(settings);
    } catch (err) {
        if (err.message === 'invalid_host' || err.message === 'invalid_env_value') {
            throw new Error('invalid_public_host');
        }
        if (err.message === 'invalid_api_url') throw new Error('invalid_public_api_url');
        throw err;
    }
}

function durableHasAnyPublicKeys(durableMap) {
    return DURABLE_KEYS.some((key) => nonEmpty(durableMap[key]));
}

function writeEnvFileAtomic(filePath, content) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    try {
        fs.chmodSync(filePath, 0o600);
    } catch (_) { /* ignore on platforms that cannot chmod */ }
}

function upsertKeysToFile(filePath, keyValues) {
    let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    for (const [key, value] of Object.entries(keyValues)) {
        assertNoEnvInjection(value);
        content = upsertEnvKey(content, key, value || '');
    }
    writeEnvFileAtomic(filePath, content);
}

/**
 * One-shot migration: if durable file has no PUBLIC_* or PANEL_PUBLIC_HOST,
 * copy from console .env and/or non-empty process.env. Never overwrites
 * an already-populated durable file.
 */
function ensureMigratedPublicEndpoints() {
    if (_migrated) return;
    _migrated = true;

    const durablePath = getDurableEnvPath();
    const durableMap = readEnvFileMap(durablePath);
    if (durableHasAnyPublicKeys(durableMap)) return;

    const legacyMap = readEnvFileMap(getEnvPath());
    const toWrite = {};
    let any = false;
    for (const key of DURABLE_KEYS) {
        const value = nonEmpty(process.env[key]) || nonEmpty(legacyMap[key]);
        if (value) {
            try {
                assertNoEnvInjection(value);
                toWrite[key] = value;
                any = true;
            } catch (_) {
                // skip unsafe values during migration
            }
        }
    }
    if (!any) return;

    try {
        upsertKeysToFile(durablePath, toWrite);
    } catch (err) {
        console.warn('[public-endpoints] durable migration failed:', err.message);
    }
}

function readPublicEndpointEnv() {
    ensureMigratedPublicEndpoints();
    const durableMap = readEnvFileMap(getDurableEnvPath());
    const legacyMap = readEnvFileMap(getEnvPath());
    return {
        public_server_id: resolveEnvKey(ENV_KEYS.public_server_id, durableMap, legacyMap),
        public_relay_server: resolveEnvKey(ENV_KEYS.public_relay_server, durableMap, legacyMap),
        public_api_url: resolveEnvKey(ENV_KEYS.public_api_url, durableMap, legacyMap),
    };
}

/**
 * PANEL_PUBLIC_HOST with same precedence as PUBLIC_*.
 */
function readPanelPublicHostValue() {
    ensureMigratedPublicEndpoints();
    const durableMap = readEnvFileMap(getDurableEnvPath());
    const legacyMap = readEnvFileMap(getEnvPath());
    return resolveEnvKey(PANEL_PUBLIC_HOST_KEY, durableMap, legacyMap);
}

function syncProcessEnv(settings) {
    for (const [field, envKey] of Object.entries(ENV_KEYS)) {
        const value = settings[field] || '';
        if (value) {
            process.env[envKey] = value;
        } else {
            delete process.env[envKey];
        }
    }
}

function getPublicEndpointSettings() {
    return readPublicEndpointEnv();
}

function isEnvOverrideActive(env = readPublicEndpointEnv()) {
    return Boolean(env.public_server_id || env.public_relay_server || env.public_api_url);
}

function writePublicEndpointSettingsToEnv(settings) {
    const normalized = validateSettings(settings);
    const keyValues = {};
    for (const [field, envKey] of Object.entries(ENV_KEYS)) {
        keyValues[envKey] = normalized[field] || '';
    }

    // Primary: volume-backed durable file (survives Docker recreate)
    upsertKeysToFile(getDurableEnvPath(), keyValues);

    // Mirror: console .env for bare-metal / Advanced editor / install scripts
    upsertKeysToFile(getEnvPath(), keyValues);

    syncProcessEnv(normalized);
    return normalized;
}

async function savePublicEndpointSettings(settings) {
    const normalized = writePublicEndpointSettingsToEnv(settings);
    return { settings: normalized };
}

/** Test helpers */
function _resetMigrationForTests() {
    _migrated = false;
}

function _setPathsForTests(paths) {
    _testPaths = paths || null;
    _migrated = false;
}

module.exports = {
    ENV_PATH,
    ENV_KEYS,
    PANEL_PUBLIC_HOST_KEY,
    DURABLE_BASENAME,
    getDurableEnvPath,
    getEnvPath,
    parseEnvFile,
    readPublicEndpointEnv,
    readPanelPublicHostValue,
    normalizeSettings,
    validateSettings,
    syncProcessEnv,
    getPublicEndpointSettings,
    isEnvOverrideActive,
    writePublicEndpointSettingsToEnv,
    savePublicEndpointSettings,
    ensureMigratedPublicEndpoints,
    _resetMigrationForTests,
    _setPathsForTests,
};
