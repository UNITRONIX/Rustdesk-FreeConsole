/**
 * Guest Access Links — temporary RdClient allowlist auth (no panel session).
 * Cookie bd.guest holds the opaque grant token for WS + subsequent page loads.
 */

const crypto = require('crypto');
const config = require('../config/config');

const GUEST_COOKIE = config.httpsEnabled ? 'betterdesk.guest' : 'bd.guest';
const MAX_COOKIE_AGE_MS = 24 * 60 * 60 * 1000;

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Explicit guest link query (?guest= / ?t=) — conscious navigation. */
function getGuestTokenFromQuery(req) {
    return String(req.query?.guest || req.query?.t || '').trim();
}

function getGuestTokenFromCookie(req) {
    const c = req.cookies && req.cookies[GUEST_COOKIE];
    return c ? String(c).trim() : '';
}

function getGuestToken(req) {
    return getGuestTokenFromQuery(req) || getGuestTokenFromCookie(req);
}

function setGuestCookie(res, token, expiresAt) {
    let maxAge = MAX_COOKIE_AGE_MS;
    if (expiresAt) {
        const ms = new Date(expiresAt).getTime() - Date.now();
        if (Number.isFinite(ms) && ms > 0) maxAge = Math.min(ms, MAX_COOKIE_AGE_MS);
    }
    res.cookie(GUEST_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: !!config.httpsEnabled,
        path: '/',
        maxAge,
    });
}

function clearGuestCookie(res) {
    res.clearCookie(GUEST_COOKIE, {
        httpOnly: true,
        sameSite: 'lax',
        secure: !!config.httpsEnabled,
        path: '/',
    });
}

/**
 * Attach req.guestGrant when token is valid (optional peer check via req.params.deviceId).
 * Does not reject — caller decides.
 */
async function attachGuestGrant(req, betterdeskApi, peerId) {
    const token = getGuestToken(req);
    if (!token) return null;
    try {
        const params = { token };
        if (peerId) params.peer_id = peerId;
        const result = await betterdeskApi.apiClient.get('/guest/access-links/validate', { params });
        const data = result.data || {};
        if (!data.valid) return null;
        req.guestGrant = data;
        req.guestToken = token;
        return data;
    } catch {
        return null;
    }
}

function peerAllowedByGrant(grant, peerId) {
    if (!grant || !peerId) return false;
    const ids = grant.peer_ids || grant.allowed_peer_ids || [];
    return ids.includes(peerId);
}

module.exports = {
    GUEST_COOKIE,
    hashToken,
    getGuestToken,
    getGuestTokenFromQuery,
    getGuestTokenFromCookie,
    setGuestCookie,
    clearGuestCookie,
    attachGuestGrant,
    peerAllowedByGrant,
};
