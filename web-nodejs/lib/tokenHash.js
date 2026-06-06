'use strict';

const crypto = require('crypto');

/**
 * SHA-256 hash of a RustDesk client access token for at-rest storage.
 * Plaintext token is returned to the client once at issuance; DB stores hash only
 * (Phase 1: dual-write with legacy `token` column for backward compatibility).
 */
function hashAccessToken(token) {
    return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

module.exports = { hashAccessToken };
