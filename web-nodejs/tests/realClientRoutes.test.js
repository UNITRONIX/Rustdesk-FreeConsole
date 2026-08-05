'use strict';

const express = require('express');
const request = require('supertest');

const mockBuildService = {
    readPublicPayload: jest.fn(),
    capabilities: jest.fn(),
    listConfigs: jest.fn(),
    getConfig: jest.fn(),
    createConfig: jest.fn(),
    updateConfig: jest.fn(),
    duplicateConfig: jest.fn(),
    deleteConfig: jest.fn(),
    listBuilds: jest.fn(),
    planBuildMatrix: jest.fn(),
    syncBuild: jest.fn(),
    createBuild: jest.fn(),
    createBuildBatch: jest.fn(),
    cancelBuild: jest.fn(),
    artifactForDownload: jest.fn(),
};

jest.mock('../services/realClientBuildService', () => mockBuildService);
jest.mock('../services/realClientAssetService', () => ({
    MAX_ASSET_BYTES: 5 * 1024 * 1024,
    saveAsset: jest.fn(),
}));
jest.mock('../services/clientConfigHost', () => ({
    resolveRustDeskEndpoints: jest.fn(() => ({
        host: 'id.example.test:443',
        relay: 'relay.example.test:443',
        api: 'https://api.example.test',
    })),
}));
jest.mock('../services/database', () => ({
    logAction: jest.fn().mockResolvedValue(undefined),
    getRealClientConfig: jest.fn(),
    listAgentBundles: jest.fn().mockResolvedValue([]),
}));

describe('Real Client generator routes', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            if (req.get('x-test-admin') === '1') {
                req.session = { userId: 9, user: { id: 9, username: 'admin', role: 'admin' } };
            } else if (req.get('x-test-user') === '1') {
                req.session = { userId: 8, user: { id: 8, username: 'operator', role: 'user' } };
            }
            next();
        });
        app.use(require('../routes/generator.routes'));
    });

    test('serves only encrypted active payload bytes without a panel session', async () => {
        const payload = Buffer.from('{"schema":"betterdesk-real-client-payload/v1","ciphertext":"opaque"}');
        mockBuildService.readPublicPayload.mockResolvedValue(payload);
        const response = await request(app).get('/api/generator/real-client/payload/11111111-1111-4111-8111-111111111111');
        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toContain('no-store');
        expect(response.text).toContain('ciphertext');
    });

    test('keeps configuration data behind the existing admin session model', async () => {
        mockBuildService.listConfigs.mockResolvedValue([]);
        expect((await request(app).get('/api/generator/real-client/configs')).status).toBe(401);
        expect((await request(app).get('/api/generator/real-client/configs').set('x-test-user', '1')).status).toBe(403);
        const response = await request(app).get('/api/generator/real-client/configs').set('x-test-admin', '1');
        expect(response.status).toBe(200);
        expect(response.body.data.configs).toEqual([]);
    });

    test('lists retained build history without requiring an existing configuration', async () => {
        const detachedBuild = {
            id: 'detached-build',
            config_id: null,
            config_name: 'Deleted config',
            status: 'completed',
        };
        mockBuildService.listBuilds.mockResolvedValue([detachedBuild]);

        const response = await request(app)
            .get('/api/generator/real-client/builds?limit=500')
            .set('x-test-admin', '1');

        expect(response.status).toBe(200);
        expect(mockBuildService.listBuilds).toHaveBeenCalledWith({
            configId: null,
            batchId: null,
            limit: '500',
        });
        expect(response.body.data.builds).toEqual([detachedBuild]);
    });

    test('prefills all public RustDesk endpoints without deployment-specific constants', async () => {
        const response = await request(app)
            .get('/api/generator/defaults')
            .set('x-test-admin', '1');

        expect(response.status).toBe(200);
        expect(response.body.data).toMatchObject({
            server_host: 'id.example.test:443',
            relay_server: 'relay.example.test:443',
            api_url: 'https://api.example.test',
        });
        const clientConfigHost = require('../services/clientConfigHost');
        expect(clientConfigHost.resolveRustDeskEndpoints).toHaveBeenCalledWith(expect.any(Object));
    });

    test('creates a config with the authenticated owner and writes an audit event', async () => {
        mockBuildService.createConfig.mockResolvedValue({ valid: true, data: { id: 'config-id' }, warnings: [] });
        const response = await request(app)
            .post('/api/generator/real-client/configs')
            .set('x-test-admin', '1')
            .send({ name: 'Client', config: {} });
        expect(response.status).toBe(201);
        expect(mockBuildService.createConfig).toHaveBeenCalledWith(expect.any(Object), 9);
        const db = require('../services/database');
        expect(db.logAction).toHaveBeenCalledWith(9, 'real_client_config_created', expect.stringContaining('config-id'), expect.any(String));
    });

    test('starts and cancels builds without returning a one-time password', async () => {
        mockBuildService.createBuild.mockResolvedValue({
            ok: true,
            build: { id: 'build-id', status: 'dispatching' },
            warnings: [],
        });
        mockBuildService.cancelBuild.mockResolvedValue({ id: 'build-id', status: 'cancelling' });
        const password = 'never-return-this';
        const created = await request(app)
            .post('/api/generator/real-client/builds')
            .set('x-test-admin', '1')
            .send({ config_id: 'config-id', provider: 'github', permanent_password: password });
        expect(created.status).toBe(202);
        expect(mockBuildService.createBuild).toHaveBeenCalledWith(expect.objectContaining({
            configId: 'config-id',
            providerId: 'github',
            oneTimeSecrets: { permanentPassword: password },
        }), 9);
        expect(JSON.stringify(created.body)).not.toContain(password);

        const cancelled = await request(app)
            .post('/api/generator/real-client/builds/build-id/cancel')
            .set('x-test-admin', '1')
            .send({});
        expect(cancelled.status).toBe(200);
        expect(cancelled.body.data.build.status).toBe('cancelling');
    });

    test('plans and starts an audited multi-platform batch from one password entry', async () => {
        mockBuildService.planBuildMatrix.mockResolvedValue({
            config_id: 'config-id', provider: 'github', provider_enabled: true,
            entries: [{ target: 'windows-x64-exe', variant: 'client', enabled: true }],
        });
        const plan = await request(app)
            .get('/api/generator/real-client/build-plan?config_id=config-id&provider=github')
            .set('x-test-admin', '1');
        expect(plan.status).toBe(200);
        expect(plan.body.data.plan.entries[0].enabled).toBe(true);

        const password = 'one-entry-many-builds';
        mockBuildService.createBuildBatch.mockResolvedValue({
            ok: true,
            batchId: '33333333-3333-4333-8333-333333333333',
            builds: [
                { id: 'build-1', client_variant: 'client', status: 'dispatching' },
                { id: 'build-2', client_variant: 'quicksupport', status: 'dispatching' },
            ],
            warnings: [], errors: [], partial: false,
        });
        const created = await request(app)
            .post('/api/generator/real-client/builds/batch')
            .set('x-test-admin', '1')
            .send({
                config_id: 'config-id', provider: 'github',
                targets: ['windows-x64-exe'], variants: ['client', 'quicksupport'],
                permanent_password: password,
            });
        expect(created.status).toBe(202);
        expect(mockBuildService.createBuildBatch).toHaveBeenCalledWith(expect.objectContaining({
            configId: 'config-id',
            targetIds: ['windows-x64-exe'],
            clientVariants: ['client', 'quicksupport'],
            oneTimeSecrets: { permanentPassword: password },
        }), 9);
        expect(JSON.stringify(created.body)).not.toContain(password);
        const db = require('../services/database');
        expect(db.logAction).toHaveBeenCalledWith(
            9,
            'real_client_build_batch_started',
            expect.stringContaining('2 build(s)'),
            expect.any(String),
        );
    });
});
