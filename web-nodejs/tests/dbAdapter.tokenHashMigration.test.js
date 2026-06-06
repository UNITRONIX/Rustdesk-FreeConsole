'use strict';

/**
 * Legacy auth.db without access_tokens.token_hash must migrate on init (issue #158).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

describe('dbAdapter token_hash SQLite migration', () => {
    let tmpDir;
    let dataDir;
    let authPath;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-token-hash-'));
        dataDir = path.join(tmpDir, 'data');
        fs.mkdirSync(dataDir);
        authPath = path.join(dataDir, 'auth.db');

        const db = new Database(authPath);
        db.exec(`
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT DEFAULT 'admin',
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE access_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token TEXT UNIQUE NOT NULL,
                user_id INTEGER NOT NULL,
                client_id TEXT DEFAULT '',
                client_uuid TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now')),
                expires_at TEXT NOT NULL,
                last_used TEXT,
                ip_address TEXT DEFAULT '',
                revoked INTEGER DEFAULT 0
            );
            INSERT INTO users (username, password_hash) VALUES ('admin', 'hash');
            INSERT INTO access_tokens (token, user_id, expires_at)
            VALUES ('legacytoken123456789012345678901234567890', 1, datetime('now', '+1 day'));
        `);
        db.close();

        process.env.DATA_DIR = dataDir;
        process.env.DB_TYPE = 'sqlite';
        process.env.DB_PATH = path.join(dataDir, 'db_v2.sqlite3');
        jest.resetModules();
    });

    afterEach(() => {
        delete process.env.DATA_DIR;
        delete process.env.DB_TYPE;
        delete process.env.DB_PATH;
        if (tmpDir && fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('adds token_hash column and backfills legacy tokens', async () => {
        const { getAdapter } = require('../services/dbAdapter');
        await getAdapter().init();

        const auth = new Database(authPath);
        const cols = auth.prepare('PRAGMA table_info(access_tokens)').all().map((c) => c.name);
        const row = auth.prepare('SELECT token_hash FROM access_tokens WHERE id = 1').get();
        const indexes = auth.prepare(`
            SELECT name FROM sqlite_master
            WHERE type = 'index' AND tbl_name = 'access_tokens' AND name = 'idx_access_tokens_hash'
        `).all();
        auth.close();

        expect(cols).toContain('token_hash');
        expect(row.token_hash).toHaveLength(64);
        expect(indexes).toHaveLength(1);
    });
});
