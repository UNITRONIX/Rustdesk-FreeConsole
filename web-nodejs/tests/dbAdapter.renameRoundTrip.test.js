'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

jest.setTimeout(20000);

describe('dbAdapter round-trip ID rename guard', () => {
    let tmpDir;
    let dataDir;
    let dbPath;
    let adapter;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-rename-roundtrip-'));
        dataDir = path.join(tmpDir, 'data');
        fs.mkdirSync(dataDir);
        dbPath = path.join(dataDir, 'db_v2.sqlite3');

        process.env.DATA_DIR = dataDir;
        process.env.DB_TYPE = 'sqlite';
        process.env.DB_PATH = dbPath;
        jest.resetModules();

        const { getAdapter } = require('../services/dbAdapter');
        adapter = getAdapter();
        await adapter.init();

        const db = new Database(dbPath);
        db.exec(`
            CREATE TABLE peers (
                id TEXT PRIMARY KEY,
                uuid TEXT DEFAULT '',
                pk BLOB,
                ip TEXT DEFAULT '',
                soft_deleted INTEGER DEFAULT 0
            );
            CREATE TABLE id_change_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                old_id TEXT NOT NULL,
                new_id TEXT NOT NULL
            );
            INSERT INTO id_change_history (old_id, new_id) VALUES
                ('ROUND_A', 'ROUND_B'),
                ('ROUND_B', 'ROUND_A');
        `);
        db.prepare('INSERT INTO peers (id, uuid, pk, ip) VALUES (?, ?, ?, ?)')
            .run('ROUND_A', 'device-uuid', Buffer.alloc(32, 0x42), '203.0.113.50');
        db.close();
    });

    afterEach(async () => {
        if (adapter) await adapter.close();
        delete process.env.DATA_DIR;
        delete process.env.DB_TYPE;
        delete process.env.DB_PATH;
        if (tmpDir && fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('does not reject or redirect an ID that became current again', async () => {
        expect(adapter.shouldRejectRenamedPeerRegistration('ROUND_A', {
            uuid: 'unrelated-request-data',
            ip: '198.51.100.25',
        })).toEqual({ reject: false });
        expect(adapter.getRenamedPeerId('ROUND_A')).toBeNull();
    });

    test('still redirects the stale intermediate ID to the current peer', async () => {
        expect(adapter.shouldRejectRenamedPeerRegistration('ROUND_B', {
            uuid: 'device-uuid',
        })).toEqual({ reject: false, redirect_id: 'ROUND_A' });
        expect(adapter.getRenamedPeerId('ROUND_B')).toBe('ROUND_A');
    });
});
