/**
 * Connection profile helpers for the support-agent bundle generator.
 * Operators supply a public hostname/IP; the console injects API URLs,
 * server public key, and a backend-issued enrollment token.
 */

'use strict';

const config = require('../config/config');

const HOST_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,253}[a-zA-Z0-9])?$/;
const IP_V4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function clip(s, max) {
    if (typeof s !== 'string') return '';
    return s.trim().slice(0, max);
}

/** Default API port from console config (BetterDesk Go API). */
function defaultApiPort() {
    try {
        const raw = config.hbbsApiUrl || config.betterdeskApiUrl || '';
        const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
        if (u.port) return u.port;
        return u.protocol === 'https:' ? '443' : '21114';
    } catch (_) {
        return '21114';
    }
}

/** CDAP WebSocket gateway port (BetterDesk Go server). */
function defaultCdapPort() {
    const fromEnv = parseInt(process.env.CDAP_PORT || process.env.SIGNAL_PORT, 10);
    if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
    return 21122;
}

/** Node.js console HTTP port. */
function defaultConsolePort() {
    const p = parseInt(config.port, 10);
    return Number.isFinite(p) && p > 0 ? p : 5000;
}

function formatOrigin(scheme, hostPart, port) {
    const omitPort = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80);
    return omitPort ? `${scheme}://${hostPart}` : `${scheme}://${hostPart}:${port}`;
}

/** Suggested host prefill from local server config. */
function defaultServerHost() {
    try {
        const raw = config.hbbsApiUrl || config.betterdeskApiUrl || '';
        const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
        return u.hostname || '';
    } catch (_) {
        return '';
    }
}

function defaultUseHttps() {
    try {
        const raw = config.hbbsApiUrl || config.betterdeskApiUrl || '';
        const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
        return u.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

/**
 * Normalize operator input: strip scheme/path/port — keep hostname or IPv4.
 */
function normalizeServerHost(input) {
    let host = clip(input, 253);
    if (!host) return { valid: false, error: 'server_host_required', host: '' };

    host = host.replace(/^https?:\/\//i, '');
    host = host.split('/')[0];
    host = host.split(':')[0];
    host = host.replace(/^\[|\]$/g, '');

    const valid = HOST_RE.test(host) || IP_V4_RE.test(host);
    if (!valid) {
        return { valid: false, error: 'server_host_invalid', host: '' };
    }
    return { valid: true, host };
}

/**
 * Build server { address, api_url, cdap/console ports and URLs } from host + TLS.
 */
function buildServerUrls(host, useHttps, apiPort) {
    const port = String(apiPort || defaultApiPort());
    const scheme = useHttps ? 'https' : 'http';
    const wsScheme = useHttps ? 'wss' : 'ws';
    const omitPort = (scheme === 'https' && port === '443') || (scheme === 'http' && port === '80');
    const hostPart = host.includes(':') ? `[${host}]` : host;
    const authority = omitPort ? hostPart : `${hostPart}:${port}`;
    const origin = `${scheme}://${authority}`;

    const cdapPort = defaultCdapPort();
    const consolePort = defaultConsolePort();
    const cdapUrl = `${wsScheme}://${hostPart}:${cdapPort}/cdap`;
    const consoleUrl = formatOrigin(scheme, hostPart, consolePort);

    return {
        address: origin,
        api_url: `${origin}/api`,
        cdap_port: cdapPort,
        console_port: consolePort,
        cdap_url: cdapUrl,
        console_url: consoleUrl,
    };
}

function hostFromBranding(branding) {
    if (branding?.server_host) return branding.server_host;
    const addr = branding?.server?.address;
    if (!addr) return '';
    try {
        return new URL(addr).hostname;
    } catch (_) {
        return String(addr).replace(/^https?:\/\//i, '').split(/[/:]/)[0];
    }
}

function tlsFromBranding(branding) {
    if (typeof branding?.use_https === 'boolean') return branding.use_https;
    const addr = branding?.server?.address || '';
    return addr.startsWith('https://');
}

function connectionFingerprint(branding) {
    return `${hostFromBranding(branding)}|${tlsFromBranding(branding)}`;
}

module.exports = {
    defaultApiPort,
    defaultCdapPort,
    defaultConsolePort,
    defaultServerHost,
    defaultUseHttps,
    normalizeServerHost,
    buildServerUrls,
    connectionFingerprint,
};
