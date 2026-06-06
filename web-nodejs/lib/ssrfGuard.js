'use strict';

const dns = require('dns').promises;
const net = require('net');

class SsrfBlockedError extends Error {
    constructor(message, code = 'SSRF_BLOCKED') {
        super(message);
        this.name = 'SsrfBlockedError';
        this.code = code;
    }
}

const BLOCKED_HOSTNAMES = new Set([
    'localhost',
    'localhost.localdomain',
    'metadata.google.internal',
    'metadata.goog',
]);

/**
 * True when the IP must not be reached by server-side outbound probes
 * (RFC1918, loopback, link-local, cloud metadata ranges, etc.).
 */
/**
 * @param {string} ip
 * @param {{ allowPrivate?: boolean }} [opts]
 *   allowPrivate=true → admin network tools may probe RFC1918 LAN hosts;
 *   loopback/link-local/cloud-metadata remain blocked (SSRF to localhost).
 */
function isBlockedIp(ip, opts = {}) {
    const allowPrivate = !!opts.allowPrivate;
    if (!ip || typeof ip !== 'string') return true;

    if (net.isIPv4(ip)) {
        const octets = ip.split('.').map((n) => parseInt(n, 10));
        if (octets.length !== 4 || octets.some((n) => Number.isNaN(n))) return true;
        const [a, b] = octets;
        if (a === 127) return true;
        if (a === 169 && b === 254) return true;
        if (allowPrivate) return false;
        if (a === 0 || a === 10 || a === 127) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 100 && b >= 64 && b <= 127) return true;
        if (a === 198 && (b === 18 || b === 19)) return true;
        return false;
    }

    if (net.isIPv6(ip)) {
        const normalized = ip.toLowerCase();
        if (normalized === '::1') return true;
        if (normalized.startsWith('fe80:')) return true;
        if (!allowPrivate && (normalized.startsWith('fc') || normalized.startsWith('fd'))) return true;
        if (normalized.startsWith('::ffff:')) {
            const mapped = normalized.slice(7);
            if (net.isIPv4(mapped)) return isBlockedIp(mapped, opts);
        }
    }

    return false;
}

function normalizeHostname(host) {
    if (!host || typeof host !== 'string') return '';
    let h = host.trim().toLowerCase();
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
    return h;
}

function assertSafeHostname(host, opts = {}) {
    const clean = normalizeHostname(host);
    if (!clean) {
        throw new SsrfBlockedError('Missing hostname');
    }
    if (BLOCKED_HOSTNAMES.has(clean)) {
        throw new SsrfBlockedError(`Blocked hostname: ${clean}`);
    }
    if (net.isIP(clean) && isBlockedIp(clean, opts)) {
        throw new SsrfBlockedError(`Blocked IP address: ${clean}`);
    }
    return clean;
}

async function assertSafeResolvedHost(host, opts = {}) {
    const clean = assertSafeHostname(host, opts);
    if (net.isIP(clean)) return clean;

    let records;
    try {
        records = await dns.lookup(clean, { all: true, verbatim: true });
    } catch (err) {
        throw new SsrfBlockedError(`DNS lookup failed for ${clean}: ${err.message}`);
    }

    if (!records || records.length === 0) {
        throw new SsrfBlockedError(`No DNS records for ${clean}`);
    }

    for (const rec of records) {
        if (isBlockedIp(rec.address, opts)) {
            throw new SsrfBlockedError(`Hostname ${clean} resolves to blocked address ${rec.address}`);
        }
    }

    return clean;
}

/**
 * Validate URL for authenticated admin network tools.
 * Allows RFC1918 LAN targets; still blocks loopback and cloud metadata.
 */
async function assertSafeMonitoringUrl(urlString) {
    return assertSafeHttpUrl(urlString, { allowPrivate: true });
}

/**
 * Validate a URL before server-side HTTP fetch (network monitor, etc.).
 * Allows only http/https; blocks private/reserved targets after DNS resolution.
 * @param {string} urlString
 * @param {{ allowPrivate?: boolean }} [opts]
 */
async function assertSafeHttpUrl(urlString, opts = {}) {
    if (!urlString || typeof urlString !== 'string') {
        throw new SsrfBlockedError('URL is required');
    }

    let parsed;
    try {
        parsed = new URL(urlString);
    } catch (_) {
        throw new SsrfBlockedError('Invalid URL');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new SsrfBlockedError('Only http and https URLs are allowed');
    }

    if (parsed.username || parsed.password) {
        throw new SsrfBlockedError('Credentials in URL are not allowed');
    }

    await assertSafeResolvedHost(parsed.hostname, opts);
    return parsed;
}

module.exports = {
    SsrfBlockedError,
    isBlockedIp,
    assertSafeHostname,
    assertSafeResolvedHost,
    assertSafeHttpUrl,
    assertSafeMonitoringUrl,
};
