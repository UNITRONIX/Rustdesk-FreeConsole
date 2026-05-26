/**
 * BetterDesk Console — WebSocket Origin validation
 *
 * Mitigates Cross-Site WebSocket Hijacking (CSWSH).
 *
 * Browsers do not enforce Same-Origin Policy on WebSocket upgrades — without
 * explicit Origin validation, a malicious site can open a ws:// connection
 * to the panel using the victim's session cookie.
 *
 * Allowed origins:
 *   1. Always accept same-host upgrades (Origin scheme://host[:port] === request Host)
 *   2. Optional whitelist via WS_ALLOWED_ORIGINS env (comma-separated, exact match)
 *   3. Optional `BD_ALLOW_MISSING_ORIGIN=true` to allow non-browser clients
 *      that omit Origin (default: only allowed when there is no session cookie
 *      attached to the request — token-based clients should send Bearer).
 *
 * Returns true if the upgrade should proceed, false otherwise.
 */

'use strict';

const ALLOWED_FROM_ENV = (process.env.WS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// Allow missing Origin only for clearly non-browser clients. Browsers always
// send Origin on WebSocket upgrades, so absent Origin + session cookie is
// suspicious. Opt-in only for niche reverse-proxy setups.
const ALLOW_MISSING_ORIGIN = process.env.BD_ALLOW_MISSING_ORIGIN === 'true';

function sameHostOrigin(request) {
    const host = request.headers && request.headers.host;
    if (!host) return null;
    // Cannot know if the panel was served via HTTPS from inside upgrade handler,
    // so accept both schemes for the request's own host. This is safe because
    // an attacker cannot make the browser send a forged Host header.
    return [`http://${host}`, `https://${host}`];
}

/**
 * Validate WebSocket upgrade Origin.
 * @param {http.IncomingMessage} request
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function validateOrigin(request) {
    const origin = (request.headers && request.headers.origin) || '';
    const cookies = (request.headers && request.headers.cookie) || '';
    const sameHost = sameHostOrigin(request);

    if (!origin) {
        // No Origin: browsers always send it. Allow only when there is no
        // session cookie (token-based client) OR when explicitly opted-in.
        const hasSessionCookie = /bd\.sid=|betterdesk\.sid=/.test(cookies);
        if (!hasSessionCookie || ALLOW_MISSING_ORIGIN) {
            return { ok: true };
        }
        return { ok: false, reason: 'missing Origin with session cookie present' };
    }

    if (sameHost && sameHost.includes(origin)) {
        return { ok: true };
    }
    if (ALLOWED_FROM_ENV.includes(origin)) {
        return { ok: true };
    }
    return { ok: false, reason: `Origin not in allow-list: ${origin}` };
}

/**
 * Helper that rejects a WebSocket upgrade if the Origin is not allowed.
 * Writes HTTP 403 and destroys the socket.
 * @returns {boolean} true if accepted (caller should continue), false if rejected.
 */
function enforceOrigin(request, socket, label) {
    const result = validateOrigin(request);
    if (result.ok) return true;
    const ip = (request.socket && request.socket.remoteAddress) || '?';
    // eslint-disable-next-line no-console
    console.warn(`[WS-ORIGIN] Rejected upgrade (${label || 'unknown'}) from ${ip}: ${result.reason}`);
    try {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
    } catch (_) { /* socket already closed */ }
    return false;
}

module.exports = { validateOrigin, enforceOrigin, ALLOWED_FROM_ENV };
