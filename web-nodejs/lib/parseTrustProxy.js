'use strict';

/**
 * Parse TRUST_PROXY for Express app.set('trust proxy', …).
 * Env vars are always strings — the literal "true" is not valid for Express
 * (proxy-addr throws "invalid IP address: true").
 *
 * @param {string|undefined|null} raw
 * @returns {boolean|number|string}
 */
function parseTrustProxy(raw) {
    if (raw === undefined || raw === null) return false;
    const trimmed = String(raw).trim();
    if (!trimmed) return false;

    const lower = trimmed.toLowerCase();
    if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'off') {
        return false;
    }
    if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'y' || lower === 'on') {
        return 1;
    }

    const asNum = parseInt(trimmed, 10);
    if (!Number.isNaN(asNum) && String(asNum) === trimmed) {
        return asNum;
    }

    // Express keywords (loopback, linklocal, uniquelocal) or CIDR/IP list
    return trimmed;
}

module.exports = { parseTrustProxy };
