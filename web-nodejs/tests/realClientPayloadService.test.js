'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

describe('Real Client encrypted payload', () => {
    let root;
    let privateKey;
    let service;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-real-client-payload-'));
        const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
        privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
        process.env.DATA_DIR = root;
        process.env.REAL_CLIENT_PAYLOAD_PUBLIC_KEY = Buffer.from(pair.publicKey.export({ type: 'spki', format: 'pem' })).toString('base64');
        jest.resetModules();
        service = require('../services/realClientPayloadService');
    });

    afterEach(() => {
        delete process.env.DATA_DIR;
        delete process.env.REAL_CLIENT_PAYLOAD_PUBLIC_KEY;
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('stores only authenticated ciphertext and decrypts with the build-repository key', async () => {
        const buildId = '33333333-3333-4333-8333-333333333333';
        const payload = { schema: 'betterdesk-real-client-build/v1', build: { id: buildId }, password: 'never-plaintext' };
        await service.createEncryptedPayload(buildId, payload);
        const raw = await service.readEncryptedPayload(buildId);
        expect(raw.toString('utf8')).not.toContain('never-plaintext');

        const envelope = JSON.parse(raw.toString('utf8'));
        const aesKey = crypto.privateDecrypt({ key: privateKey, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(envelope.wrapped_key, 'base64'));
        const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(envelope.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(envelope.auth_tag, 'base64'));
        const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
        expect(JSON.parse(plaintext.toString('utf8'))).toEqual(payload);
    });

    test('removes the private temporary payload when the atomic rename fails', async () => {
        const buildId = '33333333-3333-4333-8333-333333333334';
        const rename = jest.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('simulated rename failure'));

        await expect(service.createEncryptedPayload(buildId, { password: 'never-plaintext' }))
            .rejects.toThrow('simulated rename failure');

        rename.mockRestore();
        const payloadRoot = path.join(root, 'real-client-payloads');
        expect(fs.readdirSync(payloadRoot)).toEqual([]);
    });
});
