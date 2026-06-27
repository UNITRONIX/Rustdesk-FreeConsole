'use strict';

const fs = require('fs');
const path = require('path');
const { upsertEnvKey } = require('../lib/envMerge');
const conn = require('./agentBundleConnection');

const CONSOLE_ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(CONSOLE_ROOT, '.env');

const ENV_KEYS = {
    public_server_id: 'PUBLIC_SERVER_ID',
    public_relay_server: 'PUBLIC_RELAY_SERVER',
    public_api_url: 'PUBLIC_API_URL',
};

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

function readEnvValue(envMap, key) {
    const fromFile = envMap[key];
    if (fromFile !== undefined && fromFile !== '') {
        return String(fromFile).trim();
    }
    const fromProcess = process.env[key];
    if (fromProcess !== undefined && fromProcess !== '') {
        return String(fromProcess).trim();
    }
    return '';
}

function readPublicEndpointEnv() {
    const content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    const envMap = parseEnvFile(content);
    return {
        public_server_id: readEnvValue(envMap, ENV_KEYS.public_server_id),
        public_relay_server: readEnvValue(envMap, ENV_KEYS.public_relay_server),
        public_api_url: readEnvValue(envMap, ENV_KEYS.public_api_url),
    };
}

function normalizeHostField(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const normalized = conn.normalizeServerHost(raw);
    if (!normalized.valid) {
        throw new Error('invalid_host');
    }
    return normalized.host;
}

function normalizeApiUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
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
        return `${u.protocol}//${u.hostname}${portPart}${pathPart}${u.search || ''}`;
    } catch (err) {
        if (err.message === 'invalid_api_url') throw err;
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
        if (err.message === 'invalid_host') throw new Error('invalid_public_host');
        if (err.message === 'invalid_api_url') throw new Error('invalid_public_api_url');
        throw err;
    }
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
    let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    for (const [field, envKey] of Object.entries(ENV_KEYS)) {
        content = upsertEnvKey(content, envKey, normalized[field] || '');
    }
    fs.writeFileSync(ENV_PATH, content, { encoding: 'utf8', mode: 0o600 });
    syncProcessEnv(normalized);
    return normalized;
}

async function savePublicEndpointSettings(settings) {
    const normalized = writePublicEndpointSettingsToEnv(settings);
    return { settings: normalized };
}

module.exports = {
    ENV_PATH,
    ENV_KEYS,
    parseEnvFile,
    readPublicEndpointEnv,
    normalizeSettings,
    validateSettings,
    syncProcessEnv,
    getPublicEndpointSettings,
    isEnvOverrideActive,
    writePublicEndpointSettingsToEnv,
    savePublicEndpointSettings,
};
