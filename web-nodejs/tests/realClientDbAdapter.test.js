'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

describe('Real Client SQLite persistence', () => {
    let root;
    let adapter;

    beforeEach(async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-real-client-db-'));
        process.env.DATA_DIR = path.join(root, 'data');
        process.env.DB_PATH = path.join(root, 'main.sqlite3');
        process.env.DB_TYPE = 'sqlite';
        fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
        jest.resetModules();
        const module = require('../services/dbAdapter');
        adapter = module.getAdapter(require('../config/config'));
        await adapter.init();
    });

    afterEach(async () => {
        if (adapter) await adapter.close();
        delete process.env.DATA_DIR;
        delete process.env.DB_PATH;
        delete process.env.DB_TYPE;
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('creates dedicated tables and preserves build history after config deletion', async () => {
        const sqlite = new Database(process.env.DB_PATH, { readonly: true });
        const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
        sqlite.close();
        expect(tables).toEqual(expect.arrayContaining(['real_client_configs', 'real_client_builds']));

        await adapter.createRealClientConfig({
            id: '11111111-1111-4111-8111-111111111111', name: 'Support client', ownerUserId: 7,
            organizationId: '42',
            configJson: '{"target":"windows-x64-exe"}', assetsJson: '{}',
            targetPlatform: 'windows', targetArch: 'x86_64', targetPackage: 'exe',
            buildProvider: 'github', rustdeskVersion: '1.4.7',
        });
        const savedConfig = await adapter.getRealClientConfig('11111111-1111-4111-8111-111111111111');
        expect(savedConfig).toEqual(expect.objectContaining({
            owner_user_id: 7, target_platform: 'windows', target_arch: 'x86_64',
            target_package: 'exe', build_provider: 'github', rustdesk_version: '1.4.7',
        }));
        const writer = new Database(process.env.DB_PATH);
        writer.prepare("UPDATE real_client_configs SET updated_at = '2000-01-02 03:04:05' WHERE id = ?")
            .run('11111111-1111-4111-8111-111111111111');
        writer.close();
        await adapter.setRealClientConfigLastBuild('11111111-1111-4111-8111-111111111111', {
            id: '22222222-2222-4222-8222-222222222222', platform: 'windows', arch: 'x86_64',
            packageType: 'exe', provider: 'github', rustdeskVersion: '1.4.7', status: 'queued',
        });
        const configWithBuild = await adapter.getRealClientConfig('11111111-1111-4111-8111-111111111111');
        expect(configWithBuild.updated_at).toBe('2000-01-02 03:04:05');
        expect(configWithBuild.last_status).toBe('queued');
        await adapter.createRealClientBuild({
            id: '22222222-2222-4222-8222-222222222222', configId: '11111111-1111-4111-8111-111111111111',
            configName: 'Support client', requestedBy: 7, ownerUserId: 7, organizationId: '42',
            batchId: '33333333-3333-4333-8333-333333333333', clientVariant: 'quicksupport',
            platform: 'windows', arch: 'x86_64',
            packageType: 'exe', provider: 'github', rustdeskVersion: '1.4.7',
            sourceCommit: 'a'.repeat(40), status: 'queued',
        });
        await adapter.deleteRealClientConfig('11111111-1111-4111-8111-111111111111');
        const build = await adapter.getRealClientBuild('22222222-2222-4222-8222-222222222222');
        expect(build).not.toBeNull();
        expect(build.config_id).toBeNull();
        expect(build.owner_user_id).toBe(7);
        expect(build.organization_id).toBe('42');
        expect(build.batch_id).toBe('33333333-3333-4333-8333-333333333333');
        expect(build.client_variant).toBe('quicksupport');
        expect(build.source_commit).toBe('a'.repeat(40));
        await expect(adapter.listRealClientBuilds({ batchId: build.batch_id })).resolves.toEqual([
            expect.objectContaining({ id: build.id, client_variant: 'quicksupport' }),
        ]);
    });

    test('migrates owner and tenant audit columns into an existing Real Client build table', async () => {
        await adapter.close();
        const sqlite = new Database(process.env.DB_PATH);
        sqlite.exec(`
            DROP INDEX IF EXISTS idx_real_client_builds_owner;
            DROP INDEX IF EXISTS idx_real_client_builds_batch;
            ALTER TABLE real_client_builds DROP COLUMN owner_user_id;
            ALTER TABLE real_client_builds DROP COLUMN organization_id;
            ALTER TABLE real_client_builds DROP COLUMN batch_id;
            ALTER TABLE real_client_builds DROP COLUMN client_variant;
            ALTER TABLE real_client_builds DROP COLUMN source_commit;
        `);
        sqlite.close();

        await adapter.init();
        const migrated = new Database(process.env.DB_PATH, { readonly: true });
        const columns = migrated.prepare('PRAGMA table_info(real_client_builds)').all().map((column) => column.name);
        const indexes = migrated.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='real_client_builds'")
            .all().map((row) => row.name);
        migrated.close();
        expect(columns).toEqual(expect.arrayContaining(['owner_user_id', 'organization_id', 'batch_id', 'client_variant', 'source_commit']));
        expect(indexes).toContain('idx_real_client_builds_owner');
        expect(indexes).toContain('idx_real_client_builds_batch');
    });
});
