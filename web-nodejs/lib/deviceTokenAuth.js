'use strict';

/**
 * Verify device WebSocket credentials (bd-signal, remote-agent).
 * Accepts enrollment device_token (Go device_tokens table) or panel access tokens.
 */

const crypto = require('crypto');
const config = require('../config/config');
const { hashAccessToken } = require('./tokenHash');

function hashDeviceToken(token) {
    return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function validateEnrollmentRow(row, deviceId) {
    if (!row) return false;
    if (row.status === 'revoked' || row.status === 'expired') return false;
    if (row.max_uses > 0 && row.use_count >= row.max_uses) return false;
    if (row.expires_at) {
        const exp = new Date(row.expires_at);
        if (!Number.isNaN(exp.getTime()) && exp < new Date()) return false;
    }
    if (row.peer_id && row.peer_id !== deviceId) return false;
    return true;
}

async function lookupEnrollmentTokenSqlite(tokenHash) {
    // Use the shared adapter handle — open/close churn on better-sqlite3
    // races Node 24 N-API cleanup hooks (#353).
    const { getAdapter } = require('../services/dbAdapter');
    const db = getAdapter(config).getSqliteMainDb();
    try {
        return db.prepare(`
            SELECT peer_id, status, max_uses, use_count, expires_at
            FROM device_tokens WHERE token_hash = ?
        `).get(tokenHash);
    } catch (err) {
        if (String(err.message || '').includes('no such table')) return null;
        throw err;
    }
}

async function lookupEnrollmentTokenPostgres(tokenHash) {
    const { Client } = require('pg');
    const client = new Client({ connectionString: config.databaseUrl });
    await client.connect();
    try {
        const res = await client.query(
            `SELECT peer_id, status, max_uses, use_count, expires_at
             FROM device_tokens WHERE token_hash = $1`,
            [tokenHash]
        );
        return res.rows[0] || null;
    } finally {
        await client.end();
    }
}

async function verifyEnrollmentToken(deviceId, plainToken) {
    const tokenHash = hashDeviceToken(plainToken);
    const row = config.dbType === 'postgres'
        ? await lookupEnrollmentTokenPostgres(tokenHash)
        : await lookupEnrollmentTokenSqlite(tokenHash);
    return validateEnrollmentRow(row, deviceId);
}

/**
 * @param {string} deviceId
 * @param {string} plainToken
 * @param {{ getAccessToken?: function }} [db] optional database facade for access-token fallback
 */
async function verifyDeviceWsAuth(deviceId, plainToken, db) {
    if (!deviceId || !plainToken || String(plainToken).length < 8) {
        return false;
    }
    if (await verifyEnrollmentToken(deviceId, plainToken)) {
        return true;
    }
    if (db && typeof db.getAccessToken === 'function') {
        try {
            const row = await db.getAccessToken(plainToken);
            if (row && row.client_id === deviceId) {
                return true;
            }
            const hashed = hashAccessToken(plainToken);
            const rowHash = await db.getAccessToken(hashed);
            if (rowHash && rowHash.client_id === deviceId) {
                return true;
            }
        } catch (_) {
            /* ignore */
        }
    }
    return false;
}

module.exports = {
    hashDeviceToken,
    verifyDeviceWsAuth,
    verifyEnrollmentToken,
};
