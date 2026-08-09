'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

describe('dbAdapter generator bundle compatibility', () => {
    let tempDir;
    let dbPath;
    let adapter;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-generator-bundles-'));
        dbPath = path.join(tempDir, 'db_v2.sqlite3');
        process.env.DATA_DIR = path.join(tempDir, 'data');
        process.env.DB_PATH = dbPath;
        process.env.DB_TYPE = 'sqlite';
        jest.resetModules();
    });

    afterEach(async () => {
        if (adapter) await adapter.close();
        adapter = null;
        delete process.env.DATA_DIR;
        delete process.env.DB_PATH;
        delete process.env.DB_TYPE;
        jest.resetModules();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('migrates legacy bundles and canonicalizes product and queue values', async () => {
        const legacy = new Database(dbPath);
        legacy.exec(`
            CREATE TABLE agent_bundles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                bundle_id TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                branding TEXT NOT NULL DEFAULT '{}',
                branding_hash TEXT NOT NULL DEFAULT '',
                created_by INTEGER DEFAULT NULL,
                revoked INTEGER NOT NULL DEFAULT 0,
                download_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            INSERT INTO agent_bundles (bundle_id, name, branding_hash)
            VALUES ('legacy-bundle', 'Legacy bundle', 'legacy-hash');
        `);
        legacy.close();

        const { getAdapter } = require('../services/dbAdapter');
        adapter = getAdapter();
        await adapter.init();

        const created = await adapter.createAgentBundle({
            bundleId: 'support-bundle',
            slug: 'support-bundle',
            name: 'Support bundle',
            branding: '{}',
            brandingHash: 'support-hash',
            productType: 'agent',
        });
        const client = await adapter.createAgentBundle({
            bundleId: 'client-bundle',
            slug: 'client-bundle',
            name: 'Client bundle',
            branding: '{}',
            brandingHash: 'client-hash',
            productType: 'agent_client',
        });
        const build = await adapter.upsertAgentBundleBuild({
            brandingHash: 'support-hash',
            platform: 'linux',
            arch: 'x64',
            format: 'portable',
            status: 'pending',
            artifactPath: null,
            artifactSize: 0,
            artifactSha256: null,
            errorMessage: '',
        });

        const check = new Database(dbPath, { readonly: true });
        const columns = check.prepare('PRAGMA table_info(agent_bundles)').all().map((column) => column.name);
        const legacyRow = check.prepare(
            'SELECT product_type FROM agent_bundles WHERE bundle_id = ?'
        ).get('legacy-bundle');
        check.close();

        expect(columns).toContain('product_type');
        expect(legacyRow.product_type).toBe('support-agent');
        expect(created.product_type).toBe('support-agent');
        expect(client.product_type).toBe('agent-client');
        expect(build.status).toBe('queued');
    });
});
