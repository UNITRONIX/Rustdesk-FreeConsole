'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { upsertEnvKey } = require('../lib/envMerge');
const updateService = require('./updateService');
const serverConnectionConfigService = require('./serverConnectionConfigService');

const CONSOLE_ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(CONSOLE_ROOT, '.env');

const ENV_KEYS = {
    ntp_servers: 'NTP_SERVERS',
    max_skew_ms: 'BILLING_MAX_CLOCK_SKEW_MS',
    require_synced_clock: 'BILLING_REQUIRE_SYNCED_CLOCK',
    trust_os_ntp: 'BILLING_TRUST_OS_NTP',
};

const DEFAULTS = {
    ntp_servers: 'pool.ntp.org,time.google.com,time.cloudflare.com',
    max_skew_ms: 2000,
    require_synced_clock: true,
    trust_os_ntp: process.platform === 'linux',
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

function envToBool(value, defaultValue) {
    if (value === undefined || value === null || value === '') return defaultValue;
    const v = String(value).trim().toUpperCase();
    if (['Y', 'YES', '1', 'TRUE', 'ON'].includes(v)) return true;
    if (['N', 'NO', '0', 'FALSE', 'OFF'].includes(v)) return false;
    return defaultValue;
}

function boolToEnv(value) {
    return value ? '1' : '0';
}

function isValidNTPServerEntry(entry) {
    const s = String(entry || '').trim();
    if (!s || s.length > 253) return false;
    if (net.isIP(s)) return true;
    return /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(s);
}

function normalizeSettings(raw = {}) {
    const servers = String(raw.ntp_servers ?? DEFAULTS.ntp_servers)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const maxSkew = Number.parseInt(raw.max_skew_ms, 10);
    return {
        ntp_servers: servers.join(','),
        max_skew_ms: Number.isFinite(maxSkew) && maxSkew > 0 ? maxSkew : DEFAULTS.max_skew_ms,
        require_synced_clock: raw.require_synced_clock !== undefined
            ? !!raw.require_synced_clock
            : DEFAULTS.require_synced_clock,
        trust_os_ntp: raw.trust_os_ntp !== undefined
            ? !!raw.trust_os_ntp
            : DEFAULTS.trust_os_ntp,
    };
}

function validateSettings(settings) {
    const normalized = normalizeSettings(settings);
    const servers = normalized.ntp_servers.split(',').map((s) => s.trim()).filter(Boolean);
    if (!servers.length) {
        throw new Error('invalid_ntp_servers');
    }
    for (const server of servers) {
        if (!isValidNTPServerEntry(server)) {
            throw new Error('invalid_ntp_servers');
        }
    }
    if (normalized.max_skew_ms <= 0 || normalized.max_skew_ms > 600000) {
        throw new Error('invalid_max_skew');
    }
    return normalized;
}

function settingsFromEnvContent(content) {
    const env = parseEnvFile(content);
    return normalizeSettings({
        ntp_servers: env[ENV_KEYS.ntp_servers] || DEFAULTS.ntp_servers,
        max_skew_ms: env[ENV_KEYS.max_skew_ms] || DEFAULTS.max_skew_ms,
        require_synced_clock: envToBool(env[ENV_KEYS.require_synced_clock], DEFAULTS.require_synced_clock),
        trust_os_ntp: envToBool(env[ENV_KEYS.trust_os_ntp], DEFAULTS.trust_os_ntp),
    });
}

function getClockSettings() {
    const content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    return settingsFromEnvContent(content);
}

function writeClockSettingsToEnv(settings) {
    const normalized = validateSettings(settings);
    let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    content = upsertEnvKey(content, ENV_KEYS.ntp_servers, normalized.ntp_servers);
    content = upsertEnvKey(content, ENV_KEYS.max_skew_ms, String(normalized.max_skew_ms));
    content = upsertEnvKey(content, ENV_KEYS.require_synced_clock, boolToEnv(normalized.require_synced_clock));
    content = upsertEnvKey(content, ENV_KEYS.trust_os_ntp, boolToEnv(normalized.trust_os_ntp));
    fs.writeFileSync(ENV_PATH, content, { encoding: 'utf8', mode: 0o600 });
    return normalized;
}

async function saveClockSettings(settings, opts = {}) {
    const normalized = writeClockSettingsToEnv(settings);
    const serviceConfig = updateService.sanitizeGoServerServiceConfig();
    const result = {
        settings: normalized,
        serviceConfig,
        restart: null,
    };
    if (opts.restart !== false) {
        result.restart = serverConnectionConfigService.restartServer();
    }
    return result;
}

module.exports = {
    DEFAULTS,
    ENV_PATH,
    ENV_KEYS,
    parseEnvFile,
    envToBool,
    boolToEnv,
    isValidNTPServerEntry,
    normalizeSettings,
    validateSettings,
    settingsFromEnvContent,
    getClockSettings,
    saveClockSettings,
};
