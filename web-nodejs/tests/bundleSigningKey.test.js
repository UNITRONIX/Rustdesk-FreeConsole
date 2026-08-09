'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    DEFAULT_KEY_FILE,
    resolveBundleSigningKeyFile,
    validateSigningKeyFile,
} = require('../services/bundleSigningKey');

describe('Support Agent branding signing key', () => {
    let rootDir;

    beforeEach(() => {
        rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-branding-key-'));
    });

    afterEach(() => {
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    test('creates a persistent Ed25519 key outside a bundle workspace', async () => {
        const keysPath = path.join(rootDir, 'keys');
        const first = await resolveBundleSigningKeyFile({ keysPath, env: {} });
        const firstPem = fs.readFileSync(first, 'utf8');
        const second = await resolveBundleSigningKeyFile({ keysPath, env: {} });

        expect(first).toBe(path.join(keysPath, DEFAULT_KEY_FILE));
        expect(second).toBe(first);
        expect(fs.readFileSync(second, 'utf8')).toBe(firstPem);
        await expect(validateSigningKeyFile(first)).resolves.toBeUndefined();
        expect(crypto.createPrivateKey(firstPem).asymmetricKeyType).toBe('ed25519');
    });

    test('rejects a configured key that is not Ed25519', async () => {
        const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const keyPath = path.join(rootDir, 'rsa.pem');
        fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));

        await expect(resolveBundleSigningKeyFile({
            keysPath: path.join(rootDir, 'keys'),
            env: { BETTERDESK_BUNDLE_SIGNING_KEY_FILE: keyPath },
        })).rejects.toThrow('Ed25519');
    });
});
