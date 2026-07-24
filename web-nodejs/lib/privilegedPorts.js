'use strict';

const fs = require('fs');

const PRIVILEGED_PORT_MAX = 1023;
/** Linux capability.h — CAP_NET_BIND_SERVICE */
const CAP_NET_BIND_SERVICE = 12;
const BIND_SERVICE_ENV = 'BETTERDESK_HAS_BIND_SERVICE';

function isPrivilegedPort(port) {
    const n = Number(port);
    return Number.isInteger(n) && n > 0 && n <= PRIVILEGED_PORT_MAX;
}

function isRootProcess() {
    return typeof process.getuid === 'function' && process.getuid() === 0;
}

function isTruthyEnvFlag(value) {
    const v = String(value || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'y';
}

/**
 * True when the process may bind ports <= 1023 (root, ambient CAP_NET_BIND_SERVICE, or env hint).
 */
function processHasBindServiceCapability() {
    if (isTruthyEnvFlag(process.env[BIND_SERVICE_ENV])) {
        return true;
    }
    if (process.platform !== 'linux' || typeof process.getuid !== 'function') {
        return false;
    }
    try {
        const status = fs.readFileSync('/proc/self/status', 'utf8');
        const match = status.match(/^CapEff:\s*([0-9a-fA-F]+)/m);
        if (!match) return false;
        const capEff = BigInt(`0x${match[1].trim()}`);
        return (capEff & (1n << BigInt(CAP_NET_BIND_SERVICE))) !== 0n;
    } catch {
        return false;
    }
}

function canBindPrivilegedPorts() {
    return isRootProcess() || processHasBindServiceCapability();
}

/**
 * Non-root processes cannot bind ports <= 1023 unless CAP_NET_BIND_SERVICE is granted.
 * Fall back to a high port only when binding would fail; otherwise trust systemd + EACCES handler.
 */
function resolvePortForCurrentUser(configuredPort, fallbackPort, label) {
    const port = Number(configuredPort);
    if (!Number.isInteger(port) || port <= 0) {
        return fallbackPort;
    }
    if (!canBindPrivilegedPorts() && isPrivilegedPort(port)) {
        console.warn(`WARNING: ${label} port ${port} requires root or CAP_NET_BIND_SERVICE; using ${fallbackPort} instead`);
        console.warn('  → Set HTTPS_PORT=5443 (or PORT=5000) in .env, use a reverse proxy on :443, or grant CAP_NET_BIND_SERVICE in the systemd unit');
        return fallbackPort;
    }
    return port;
}

function parseEnvPortSettings(envContent) {
    const get = (key, fallback) => {
        const match = String(envContent || '').match(new RegExp(`^${key}=(.+)$`, 'm'));
        if (!match) return fallback;
        return match[1].trim().replace(/^["']|["']$/g, '');
    };
    return {
        port: parseInt(get('PORT', '5000'), 10) || 5000,
        httpsPort: parseInt(get('HTTPS_PORT', '5443'), 10) || 5443,
        httpsEnabled: (get('HTTPS_ENABLED', 'false') || 'false').toLowerCase() === 'true',
        httpRedirect: (get('HTTP_REDIRECT_HTTPS', 'true') || 'true').toLowerCase() === 'true',
    };
}

function resolvePanelHealthPort(settings) {
    const s = settings || {};
    if (s.httpsEnabled) {
        const httpsPort = Number(s.httpsPort);
        return Number.isInteger(httpsPort) && httpsPort > 0 ? httpsPort : 5443;
    }
    const port = Number(s.port);
    return Number.isInteger(port) && port > 0 ? port : 5000;
}

function readConsoleEnvPortSettings(envPath) {
    if (!envPath || !fs.existsSync(envPath)) {
        return parseEnvPortSettings('');
    }
    return parseEnvPortSettings(fs.readFileSync(envPath, 'utf8'));
}

function consoleEnvUsesPrivilegedPorts(envSettings) {
    const settings = envSettings || {};
    if (settings.httpsEnabled) {
        if (isPrivilegedPort(settings.httpsPort)) return true;
        if (settings.httpRedirect && isPrivilegedPort(settings.port)) return true;
        return false;
    }
    return isPrivilegedPort(settings.port);
}

const BIND_CAPABILITY_LINES = [
    'AmbientCapabilities=CAP_NET_BIND_SERVICE',
    'CapabilityBoundingSet=CAP_NET_BIND_SERVICE',
];
const BIND_SERVICE_ENV_LINE = `Environment=${BIND_SERVICE_ENV}=1`;

function serviceUnitHasBindCapability(content) {
    return /^AmbientCapabilities=.*CAP_NET_BIND_SERVICE/m.test(String(content || ''));
}

function serviceUnitHasBindServiceEnv(content) {
    return new RegExp(`^Environment=${BIND_SERVICE_ENV}=1`, 'm').test(String(content || ''));
}

/**
 * Idempotently add CAP_NET_BIND_SERVICE so User=betterdesk can bind :443/:80.
 */
function ensureBindCapabilityInServiceUnit(content) {
    const unit = String(content || '');
    if (!unit.trim()) {
        return { content: unit, changed: false };
    }
    const lines = unit.split('\n');
    let insertAt = -1;
    for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].startsWith('User=')) {
            insertAt = i + 1;
            break;
        }
    }
    if (insertAt === -1) {
        for (let i = 0; i < lines.length; i += 1) {
            if (lines[i].trim() === '[Service]') {
                insertAt = i + 1;
                break;
            }
        }
    }
    if (insertAt === -1) {
        return { content: unit, changed: false };
    }

    let changed = false;
    if (!serviceUnitHasBindCapability(unit)) {
        lines.splice(insertAt, 0, ...BIND_CAPABILITY_LINES);
        insertAt += BIND_CAPABILITY_LINES.length;
        changed = true;
    }
    if (!serviceUnitHasBindServiceEnv(lines.join('\n'))) {
        lines.splice(insertAt, 0, BIND_SERVICE_ENV_LINE);
        changed = true;
    }
    return { content: lines.join('\n'), changed };
}

/**
 * Build Location URL for HTTP→HTTPS redirect. Omits :443 (and :80 on HTTP side is implicit).
 */
function formatHttpsRedirectUrl(hostname, httpsPort, urlPath) {
    const host = String(hostname || 'localhost');
    const path = urlPath != null && urlPath !== '' ? urlPath : '/';
    const port = Number(httpsPort);
    const suffix = Number.isInteger(port) && port > 0 && port !== 443 ? `:${port}` : '';
    return `https://${host}${suffix}${path}`;
}

function attachPrivilegedPortErrorHandler(server, { port, label }) {
    if (!server || typeof server.on !== 'function') return;
    server.on('error', (err) => {
        if (err && err.code === 'EACCES') {
            console.error(`ERROR: Cannot bind ${label} port ${port} — permission denied`);
            console.error('  → Ports below 1024 require root or CAP_NET_BIND_SERVICE in the systemd unit');
            console.error('  → Or set HTTPS_PORT=5443 / PORT=5000 in .env and use a reverse proxy on :443');
            process.exit(1);
        }
        if (err && err.code === 'EADDRINUSE') {
            console.error(`ERROR: ${label} port ${port} is already in use`);
            process.exit(1);
        }
        throw err;
    });
}

module.exports = {
    PRIVILEGED_PORT_MAX,
    CAP_NET_BIND_SERVICE,
    BIND_SERVICE_ENV,
    isPrivilegedPort,
    isRootProcess,
    isTruthyEnvFlag,
    processHasBindServiceCapability,
    canBindPrivilegedPorts,
    resolvePortForCurrentUser,
    parseEnvPortSettings,
    resolvePanelHealthPort,
    readConsoleEnvPortSettings,
    consoleEnvUsesPrivilegedPorts,
    serviceUnitHasBindCapability,
    serviceUnitHasBindServiceEnv,
    ensureBindCapabilityInServiceUnit,
    formatHttpsRedirectUrl,
    attachPrivilegedPortErrorHandler,
};
