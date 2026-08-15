'use strict';

/**
 * Authentication for device-facing HTTP endpoints.
 *
 * X-Device-Id is an identifier, not a credential. Device endpoints that
 * read or mutate device state must require a server-issued Bearer token bound
 * to the same client_id.
 */

const db = require('../services/database');

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

function extractBearerToken(req) {
    const auth = req.headers && req.headers.authorization;
    const match = typeof auth === 'string' && /^Bearer\s+(\S+)$/.exec(auth);
    return match ? match[1] : null;
}

async function requireDeviceToken(req, res, next) {
    const token = extractBearerToken(req);
    if (!token) {
        return res.status(401).json({ error: 'Bearer access token required' });
    }

    let tokenRow;
    try {
        tokenRow = await db.getAccessToken(token);
    } catch (_) {
        return res.status(401).json({ error: 'Invalid or expired access token' });
    }

    if (!tokenRow || !tokenRow.client_id || !DEVICE_ID_PATTERN.test(String(tokenRow.client_id))) {
        return res.status(401).json({ error: 'Invalid or unbound access token' });
    }

    req.deviceId = String(tokenRow.client_id);
    req.deviceToken = tokenRow;

    try {
        await db.touchAccessToken(token);
    } catch (_) {
        // Token validation already succeeded; telemetry must not invalidate it.
    }

    return next();
}

/**
 * Ensure an optional device_id claim belongs to the authenticated token.
 * If no claim is supplied, the authenticated token remains authoritative.
 */
function requireTokenDeviceMatch(req, res, next) {
    const claimed = req.body?.device_id
        || req.query?.device_id
        || req.headers?.['x-device-id'];

    if (claimed !== undefined && String(claimed) !== req.deviceId) {
        return res.status(403).json({ error: 'Device ID mismatch' });
    }
    return next();
}

module.exports = {
    DEVICE_ID_PATTERN,
    extractBearerToken,
    requireDeviceToken,
    requireTokenDeviceMatch,
};
