'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function decryptEnvelope(raw, privateKey) {
    const envelope = JSON.parse(raw.toString('utf8'));
    const aesKey = crypto.privateDecrypt({
        key: privateKey,
        oaepHash: 'sha256',
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    }, Buffer.from(envelope.wrapped_key, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.auth_tag, 'base64'));
    return JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
    ]).toString('utf8'));
}

describe('Real Client persistent build lifecycle', () => {
    let root;
    let privateKey;
    let db;
    let buildService;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-real-client-lifecycle-'));
        const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
        privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
        process.env.DATA_DIR = path.join(root, 'data');
        process.env.DB_PATH = path.join(root, 'main.sqlite3');
        process.env.DB_TYPE = 'sqlite';
        process.env.REAL_CLIENT_PAYLOAD_PUBLIC_KEY = Buffer.from(
            pair.publicKey.export({ type: 'spki', format: 'pem' }),
        ).toString('base64');
        process.env.REAL_CLIENT_PUBLIC_BASE_URL = 'https://console.example.com';
    });

    afterEach(async () => {
        if (buildService) buildService.stop();
        if (db) await db.close();
        for (const key of Object.keys(process.env)) {
            if (key.startsWith('REAL_CLIENT_')) delete process.env[key];
        }
        delete process.env.DATA_DIR;
        delete process.env.DB_PATH;
        delete process.env.DB_TYPE;
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('keeps secrets encrypted, survives restart and removes the payload after completion', async () => {
        jest.resetModules();
        db = require('../services/database');
        await db.init();
        buildService = require('../services/realClientBuildService');
        const configService = require('../services/realClientConfigService');
        const target = configService.targetById('windows-x64-exe');
        const dispatch = jest.fn(async () => ({
            status: 'dispatching', providerRunId: '1234', providerStatus: 'dispatched',
        }));
        buildService.providers.set('github', {
            id: 'github',
            sourceCommitFor: () => 'a'.repeat(40),
            capabilities: () => ({ id: 'github', label: 'GitHub', enabled: true, reason: '', targets: [target], versions: ['1.4.6'], combinations: ['windows-x64-exe@1.4.6'] }),
            dispatch,
        });

        const configResult = await buildService.createConfig({
            name: 'Lifecycle client',
            config: {
                ...configService.defaultConfig(),
                rustdeskVersion: '1.4.6',
                idServer: 'id.example.com:21116',
                relayServer: 'relay.example.com:21117',
                apiServer: 'https://api.example.com',
                publicKey: Buffer.alloc(32, 9).toString('base64'),
            },
        }, 7);
        expect(configResult.valid).toBe(true);

        const password = 'one-build-only-password';
        const started = await buildService.createBuild({
            configId: configResult.data.id,
            oneTimeSecrets: { permanentPassword: password },
        }, 7);
        expect(started.ok).toBe(true);
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(dispatch.mock.calls[0][0])).not.toContain(password);
        expect(JSON.stringify(started)).not.toContain(password);

        const storedConfig = await db.getRealClientConfig(configResult.data.id);
        const storedBuild = await db.getRealClientBuild(started.build.id);
        expect(JSON.stringify(storedConfig)).not.toContain(password);
        expect(JSON.stringify(storedBuild)).not.toContain(password);
        const encrypted = await buildService.readPublicPayload(started.build.id);
        expect(encrypted.toString('utf8')).not.toContain(password);
        const decrypted = decryptEnvelope(encrypted, privateKey);
        expect(decrypted.rustdeskCustomConfig.custom.password).toBe(password);

        buildService.stop();
        await db.close();
        db = null;
        buildService = null;
        jest.resetModules();

        db = require('../services/database');
        await db.init();
        buildService = require('../services/realClientBuildService');
        const artifactDir = path.join(process.env.DATA_DIR, 'real-client-artifacts', started.build.id);
        const artifactPath = path.join(artifactDir, 'client.exe');
        fs.mkdirSync(artifactDir, { recursive: true });
        fs.writeFileSync(artifactPath, 'finished-client');
        const inspect = jest.fn(async () => ({
            status: 'ready',
            providerRunId: '1234',
            providerStatus: 'success',
            artifactName: 'client.exe',
            artifactPath,
            artifactSize: fs.statSync(artifactPath).size,
            artifactSha256: crypto.createHash('sha256').update('finished-client').digest('hex'),
        }));
        buildService.providers.set('github', {
            id: 'github',
            sourceCommitFor: () => 'a'.repeat(40),
            capabilities: () => ({ id: 'github', enabled: true, targets: [target], versions: ['1.4.6'], combinations: ['windows-x64-exe@1.4.6'] }),
            inspect,
        });

        const activeAfterRestart = await db.listActiveRealClientBuilds();
        expect(activeAfterRestart.map((item) => item.id)).toContain(started.build.id);
        const completed = await buildService.syncBuild(started.build.id);
        expect(inspect).toHaveBeenCalledTimes(1);
        expect(completed.status).toBe('ready');
        expect(completed.expires_at).toBeTruthy();
        await expect(buildService.readPublicPayload(started.build.id)).resolves.toBeNull();
        expect((await db.getRealClientBuild(started.build.id)).status).toBe('ready');
        await expect(buildService.artifactForDownload(started.build.id)).resolves.toEqual(expect.objectContaining({
            path: artifactPath,
            sha256: completed.artifact.sha256,
        }));
        fs.writeFileSync(artifactPath, 'tampered-client');
        expect(fs.statSync(artifactPath).size).toBe(completed.artifact.size);
        await expect(buildService.artifactForDownload(started.build.id)).rejects.toThrow(/SHA-256/);
    }, 30000);

    test('fans one saved configuration and password into an auditable Client/QuickSupport batch', async () => {
        jest.resetModules();
        db = require('../services/database');
        await db.init();
        buildService = require('../services/realClientBuildService');
        const configService = require('../services/realClientConfigService');
        const windowsTarget = configService.targetById('windows-x64-exe');
        const linuxTarget = configService.targetById('linux-x64-deb');
        const dispatch = jest.fn(async () => ({
            status: 'dispatching', providerStatus: 'dispatched',
        }));
        buildService.providers.set('github', {
            id: 'github',
            sourceCommitFor: () => 'a'.repeat(40),
            capabilities: () => ({
                id: 'github', label: 'GitHub', enabled: true, reason: '',
                targets: [windowsTarget, linuxTarget],
                versions: ['1.4.6'],
                combinations: ['windows-x64-exe@1.4.6', 'linux-x64-deb@1.4.6'],
            }),
            dispatch,
        });

        const configResult = await buildService.createConfig({
            name: 'One source configuration',
            config: {
                ...configService.defaultConfig(),
                rustdeskVersion: '1.4.6',
                idServer: 'id.example.com:21116',
                relayServer: 'relay.example.com:21117',
                apiServer: 'https://api.example.com',
                publicKey: Buffer.alloc(32, 9).toString('base64'),
                appName: 'Acme Remote',
                executableName: 'acme-remote',
            },
        }, 7);
        expect(configResult.valid).toBe(true);

        const password = 'shared-only-inside-envelopes';
        const batch = await buildService.createBuildBatch({
            configId: configResult.data.id,
            providerId: 'github',
            targetIds: ['windows-x64-exe', 'linux-x64-deb'],
            clientVariants: ['client', 'quicksupport'],
            oneTimeSecrets: { permanentPassword: password },
        }, 7);

        expect(batch.ok).toBe(true);
        expect(batch.partial).toBe(false);
        expect(batch.builds).toHaveLength(4);
        expect(new Set(batch.builds.map((build) => build.batch_id))).toEqual(new Set([batch.batchId]));
        expect(new Set(batch.builds.map((build) => build.client_variant))).toEqual(new Set(['client', 'quicksupport']));
        expect(new Set(batch.builds.map((build) => build.source_commit))).toEqual(new Set(['a'.repeat(40)]));
        expect(new Set(batch.builds.map((build) => `${build.platform}/${build.package}`))).toEqual(new Set(['windows/exe', 'linux/deb']));
        expect(dispatch).toHaveBeenCalledTimes(4);
        expect(JSON.stringify(batch)).not.toContain(password);

        const stored = await db.listRealClientBuilds({ batchId: batch.batchId, limit: 10 });
        expect(stored).toHaveLength(4);
        expect(JSON.stringify(stored)).not.toContain(password);
        expect(JSON.stringify(await db.getRealClientConfig(configResult.data.id))).not.toContain(password);

        const payloads = {};
        for (const build of batch.builds) {
            const encrypted = await buildService.readPublicPayload(build.id);
            expect(encrypted.toString('utf8')).not.toContain(password);
            payloads[`${build.client_variant}-${build.platform}`] = decryptEnvelope(encrypted, privateKey);
        }
        expect(payloads['client-windows'].configuration).toEqual(expect.objectContaining({
            appName: 'Acme Remote', executableName: 'acme-remote', direction: 'both',
        }));
        expect(payloads['quicksupport-windows'].configuration).toEqual(expect.objectContaining({
            appName: 'Acme Remote QuickSupport',
            executableName: 'acme-remote-quicksupport',
            direction: 'incoming', disableInstallation: true, hideConnectionManager: false,
        }));
        expect(payloads['client-linux'].configuration.target).toBe('linux-x64-deb');
        expect(payloads['quicksupport-linux'].configuration).toEqual(expect.objectContaining({
            target: 'linux-x64-deb', direction: 'incoming', disableInstallation: true,
        }));
        for (const payload of Object.values(payloads)) {
            expect(payload.build.sourceCommit).toBe('a'.repeat(40));
            expect(payload.rustdeskCustomConfig.custom.password).toBe(password);
        }
    }, 30000);

    test('retains the encrypted payload while cancellation is pending and deletes it only after terminal confirmation', async () => {
        jest.resetModules();
        db = require('../services/database');
        await db.init();
        buildService = require('../services/realClientBuildService');
        const configService = require('../services/realClientConfigService');
        const target = configService.targetById('windows-x64-exe');
        const provider = {
            id: 'github',
            sourceCommitFor: () => 'a'.repeat(40),
            capabilities: () => ({
                id: 'github', label: 'GitHub', enabled: true, reason: '',
                targets: [target], versions: ['1.4.6'], combinations: ['windows-x64-exe@1.4.6'],
            }),
            dispatch: jest.fn(async () => ({ status: 'dispatching', providerStatus: 'dispatched' })),
            cancel: jest.fn(async () => ({ status: 'cancelling', providerStatus: 'waiting_to_cancel' })),
            inspect: jest.fn(async () => ({ status: 'cancelled', providerStatus: 'cancelled' })),
        };
        buildService.providers.set('github', provider);
        const configResult = await buildService.createConfig({
            name: 'Cancellation lifecycle',
            config: {
                ...configService.defaultConfig(),
                rustdeskVersion: '1.4.6',
                idServer: 'id.example.com:21116',
                publicKey: Buffer.alloc(32, 9).toString('base64'),
            },
        }, 7);
        const started = await buildService.createBuild({ configId: configResult.data.id }, 7);
        expect(started.ok).toBe(true);
        await expect(buildService.readPublicPayload(started.build.id)).resolves.not.toBeNull();

        const cancelling = await buildService.cancelBuild(started.build.id);
        expect(cancelling.status).toBe('cancelling');
        await expect(buildService.readPublicPayload(started.build.id)).resolves.not.toBeNull();

        const cancelled = await buildService.syncBuild(started.build.id);
        expect(cancelled.status).toBe('cancelled');
        await expect(buildService.readPublicPayload(started.build.id)).resolves.toBeNull();
    }, 30000);
});
