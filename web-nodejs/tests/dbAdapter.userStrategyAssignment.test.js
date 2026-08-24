'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

describe('dbAdapter user strategy assignment (Issue #384)', () => {
    let tempDir;
    let adapter;

    beforeEach(async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'betterdesk-user-strategy-'));
        process.env.DATA_DIR = path.join(tempDir, 'panel-data');
        process.env.DB_PATH = path.join(tempDir, 'db_v2.sqlite3');
        process.env.DB_TYPE = 'sqlite';
        jest.resetModules();

        const { getAdapter } = require('../services/dbAdapter');
        adapter = getAdapter();
        await adapter.init();
    });

    afterEach(async () => {
        if (adapter && typeof adapter.close === 'function') {
            await adapter.close();
        }
        delete process.env.DATA_DIR;
        delete process.env.DB_PATH;
        delete process.env.DB_TYPE;
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('assigns a strategy to a user without guid and auto-generates user guid', async () => {
        const user = await adapter.createUser('operator1', 'hash-placeholder', 'operator');
        expect(user.id).toBeTruthy();

        const strategy = await adapter.createStrategy({
            name: 'Remote Operator',
            permissions: { remote_control: true },
        });
        expect(strategy.guid).toBeTruthy();

        await expect(
            adapter.setUserStrategyAssignment(user.id, strategy.guid)
        ).resolves.toBe(strategy.guid);

        await expect(adapter.getUserStrategyGuid(user.id)).resolves.toBe(strategy.guid);

        const db = new Database(process.env.DB_PATH, { readonly: true });
        const row = db.prepare('SELECT guid FROM users WHERE id = ?').get(user.id);
        db.close();
        expect(row.guid).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        );
    });

    it('clears strategy assignment when strategyGuid is empty', async () => {
        const user = await adapter.createUser('viewer1', 'hash-placeholder', 'viewer');
        const strategy = await adapter.createStrategy({ name: 'Viewer Role' });

        await adapter.setUserStrategyAssignment(user.id, strategy.guid);
        expect(await adapter.getUserStrategyGuid(user.id)).toBe(strategy.guid);

        await expect(adapter.setUserStrategyAssignment(user.id, '')).resolves.toBe('');
        expect(await adapter.getUserStrategyGuid(user.id)).toBe('');
    });
});
