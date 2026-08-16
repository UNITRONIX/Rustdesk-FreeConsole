'use strict';

/**
 * Resolves the private Ed25519 key used to sign Support Agent branding
 * profiles. The generated public half is embedded in each signed binary by
 * the Go build helper; the private half never belongs in the bundle or the
 * artifact cache.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DEFAULT_KEY_FILE = 'support-agent-branding-ed25519.pem';

async function validateSigningKeyFile(keyFile) {
    const pem = await fsp.readFile(keyFile);
    const key = crypto.createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') {
        throw new Error(`Support Agent branding key must be Ed25519, got ${key.asymmetricKeyType || 'unknown'}`);
    }
}

async function resolveBundleSigningKeyFile({ keysPath, env = process.env } = {}) {
    const configured = String(env.BETTERDESK_BUNDLE_SIGNING_KEY_FILE || '').trim();
    if (configured) {
        await validateSigningKeyFile(configured);
        return configured;
    }
    if (!keysPath) {
        throw new Error('keysPath is required to create the Support Agent branding signing key');
    }

    const keyFile = path.join(keysPath, DEFAULT_KEY_FILE);
    try {
        await validateSigningKeyFile(keyFile);
        return keyFile;
    } catch {
        // Create below. The final link-safe write handles concurrent workers.
    }

    await fsp.mkdir(keysPath, { recursive: true, mode: 0o700 });
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    try {
        const handle = await fsp.open(keyFile, 'wx', 0o600);
        try {
            await handle.writeFile(pem);
        } finally {
            await handle.close();
        }
    } catch (err) {
        if (!err || err.code !== 'EEXIST') throw err;
    }
    await fsp.chmod(keyFile, 0o600).catch(() => {});
    await validateSigningKeyFile(keyFile);
    return keyFile;
}

module.exports = {
    DEFAULT_KEY_FILE,
    resolveBundleSigningKeyFile,
    validateSigningKeyFile,
};
