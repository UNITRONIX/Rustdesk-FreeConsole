'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config/config');

const root = path.resolve(config.dataDir, 'real-client-payloads');
const MAX_PLAINTEXT_BYTES = 32 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function payloadPath(buildId) {
    if (!UUID.test(String(buildId || ''))) {
        throw Object.assign(new Error('Invalid build id'), { statusCode: 400 });
    }
    return path.join(root, `${buildId}.payload.json`);
}

function configured() {
    if (!config.realClient.payloadPublicKey) return false;
    try {
        const key = crypto.createPublicKey(config.realClient.payloadPublicKey);
        return key.asymmetricKeyType === 'rsa'
            && Number(key.asymmetricKeyDetails && key.asymmetricKeyDetails.modulusLength || 0) >= 3072;
    } catch (_) {
        return false;
    }
}

async function createEncryptedPayload(buildId, payload) {
    if (!configured()) throw new Error('REAL_CLIENT_PAYLOAD_PUBLIC_KEY is missing or invalid');
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error('Encrypted build payload exceeds 32 MiB');

    const aesKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const wrappedKey = crypto.publicEncrypt({
        key: config.realClient.payloadPublicKey,
        oaepHash: 'sha256',
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    }, aesKey);

    const envelope = {
        schema: 'betterdesk-real-client-payload/v1',
        key_algorithm: 'RSA-OAEP-SHA256',
        content_algorithm: 'AES-256-GCM',
        wrapped_key: wrappedKey.toString('base64'),
        iv: iv.toString('base64'),
        auth_tag: tag.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        plaintext_sha256: crypto.createHash('sha256').update(plaintext).digest('hex'),
    };

    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    const destination = payloadPath(buildId);
    const temp = `${destination}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        await fs.promises.writeFile(temp, JSON.stringify(envelope), { mode: 0o600, flag: 'wx' });
        await fs.promises.rename(temp, destination);
    } finally {
        // A failed write/rename must not leave encrypted payload fragments behind.
        await fs.promises.rm(temp, { force: true }).catch(() => {});
    }
    return { path: destination, bytes: ciphertext.length };
}

async function readEncryptedPayload(buildId) {
    return fs.promises.readFile(payloadPath(buildId));
}

async function deleteEncryptedPayload(buildId) {
    try { await fs.promises.unlink(payloadPath(buildId)); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

module.exports = {
    MAX_PLAINTEXT_BYTES,
    configured,
    createEncryptedPayload,
    readEncryptedPayload,
    deleteEncryptedPayload,
};
