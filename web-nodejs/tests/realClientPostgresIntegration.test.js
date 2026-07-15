'use strict';

const runPostgres = process.env.REAL_CLIENT_TEST_POSTGRES_URL ? describe : describe.skip;

runPostgres('Real Client PostgreSQL persistence', () => {
    const configId = '88888888-8888-4888-8888-888888888888';
    const buildId = '99999999-9999-4999-8999-999999999999';
    let adapter;
    let previousType;
    let previousUrl;

    beforeAll(async () => {
        previousType = process.env.DB_TYPE;
        previousUrl = process.env.DATABASE_URL;
        process.env.DB_TYPE = 'postgres';
        process.env.DATABASE_URL = process.env.REAL_CLIENT_TEST_POSTGRES_URL;
        jest.resetModules();
        adapter = require('../services/dbAdapter').getAdapter(require('../config/config'));
        await adapter.init();
        await adapter.deleteRealClientBuild(buildId);
        await adapter.deleteRealClientConfig(configId);
    }, 30000);

    afterAll(async () => {
        if (adapter) {
            await adapter.deleteRealClientBuild(buildId).catch(() => {});
            await adapter.deleteRealClientConfig(configId).catch(() => {});
            await adapter.close();
        }
        if (previousType == null) delete process.env.DB_TYPE;
        else process.env.DB_TYPE = previousType;
        if (previousUrl == null) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previousUrl;
    });

    test('bootstraps, restarts and preserves detached build history', async () => {
        await adapter.createRealClientConfig({
            id: configId,
            name: 'PostgreSQL client',
            ownerUserId: 7,
            organizationId: '42',
            configJson: '{"target":"windows-x64-exe"}',
            assetsJson: '{}',
            targetPlatform: 'windows',
            targetArch: 'x86_64',
            targetPackage: 'exe',
            buildProvider: 'github',
            rustdeskVersion: '1.4.7',
        });
        await adapter.createRealClientBuild({
            id: buildId,
            configId,
            configName: 'PostgreSQL client',
            requestedBy: 7,
            ownerUserId: 7,
            organizationId: '42',
            batchId: '77777777-7777-4777-8777-777777777777',
            clientVariant: 'quicksupport',
            platform: 'windows',
            arch: 'x86_64',
            packageType: 'exe',
            provider: 'github',
            rustdeskVersion: '1.4.7',
            sourceCommit: 'b'.repeat(40),
            status: 'building',
        });
        await adapter.updateRealClientBuild(buildId, {
            status: 'ready',
            providerStatus: 'success',
            errorMessage: '',
            finishedAt: new Date().toISOString(),
        });

        await adapter.close();
        await adapter.init();
        expect(await adapter.getRealClientConfig(configId)).toEqual(expect.objectContaining({
            target_platform: 'windows',
            target_arch: 'x86_64',
            target_package: 'exe',
        }));
        expect(await adapter.getRealClientBuild(buildId)).toEqual(expect.objectContaining({
            status: 'ready',
            provider_status: 'success',
            error_message: '',
            batch_id: '77777777-7777-4777-8777-777777777777',
            client_variant: 'quicksupport',
            source_commit: 'b'.repeat(40),
        }));
        await expect(adapter.listRealClientBuilds({ batchId: '77777777-7777-4777-8777-777777777777' }))
            .resolves.toEqual([expect.objectContaining({ id: buildId })]);

        await adapter.deleteRealClientConfig(configId);
        expect(await adapter.getRealClientBuild(buildId)).toEqual(expect.objectContaining({
            config_id: null,
            config_name: 'PostgreSQL client',
            owner_user_id: 7,
            organization_id: '42',
        }));
    }, 30000);
});
