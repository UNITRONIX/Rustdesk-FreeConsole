'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

describe('dbAdapter SQLite single-store topology', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'betterdesk-single-store-'));
        process.env.DATA_DIR = path.join(tempDir, 'panel-data');
        process.env.DB_PATH = path.join(tempDir, 'db_v2.sqlite3');
        process.env.DB_TYPE = 'sqlite';
        jest.resetModules();
    });

    afterEach(() => {
        delete process.env.DATA_DIR;
        delete process.env.DB_PATH;
        delete process.env.DB_TYPE;
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('uses db_v2.sqlite3 on a fresh install and never creates auth.db', async () => {
        const { getAdapter } = require('../services/dbAdapter');
        const adapter = getAdapter();
        await adapter.init();

        const legacyAuthPath = path.join(process.env.DATA_DIR, 'auth.db');
        expect(fs.existsSync(legacyAuthPath)).toBe(false);

        const main = new Database(process.env.DB_PATH, { readonly: true });
        expect(main.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'`).get()).toBeTruthy();
        main.close();
        await adapter.close();
    });
});
