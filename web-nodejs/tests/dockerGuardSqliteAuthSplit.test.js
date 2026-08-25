'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const guardScript = path.resolve(__dirname, '..', '..', 'docker', 'guard-sqlite-auth-split.sh');
const hasPosixShell = spawnSync('sh', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0;

function runGuard(env) {
    const script = `
        . "${guardScript}"
        guard_sqlite_auth_split
    `;
    return spawnSync('sh', ['-c', script], {
        env: { ...process.env, ...env },
        encoding: 'utf8',
    });
}

(hasPosixShell ? describe : describe.skip)('Docker guard_sqlite_auth_split', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'betterdesk-guard-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('removes empty orphan auth.db on fresh primary DB', () => {
        const dataDir = path.join(tempDir, 'panel');
        const rustdeskDir = path.join(tempDir, 'rustdesk');
        fs.mkdirSync(dataDir, { recursive: true });
        fs.mkdirSync(rustdeskDir, { recursive: true });

        const authDb = path.join(dataDir, 'auth.db');
        const primaryDb = path.join(rustdeskDir, 'db_v2.sqlite3');
        const db = require('better-sqlite3');
        const auth = new db(authDb);
        auth.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT)');
        auth.close();
        const main = new db(primaryDb);
        main.exec('CREATE TABLE peers (id TEXT PRIMARY KEY)');
        main.close();

        const result = runGuard({
            DATA_DIR: dataDir,
            AUTH_DB_PATH: authDb,
            DB_PATH: primaryDb,
            DB_TYPE: 'sqlite',
        });

        expect(result.status).toBe(0);
        expect(fs.existsSync(authDb)).toBe(false);
        expect(result.stderr).toContain('Removing empty orphan auth.db');
    });

    test('exits when auth.db has users but primary DB is empty', () => {
        const dataDir = path.join(tempDir, 'panel');
        const rustdeskDir = path.join(tempDir, 'rustdesk');
        fs.mkdirSync(dataDir, { recursive: true });
        fs.mkdirSync(rustdeskDir, { recursive: true });

        const authDb = path.join(dataDir, 'auth.db');
        const primaryDb = path.join(rustdeskDir, 'db_v2.sqlite3');
        const db = require('better-sqlite3');
        const auth = new db(authDb);
        auth.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT)');
        auth.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('admin', 'hash');
        auth.close();

        const result = runGuard({
            DATA_DIR: dataDir,
            AUTH_DB_PATH: authDb,
            DB_PATH: primaryDb,
            DB_TYPE: 'sqlite',
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Split Docker volume state detected');
        expect(fs.existsSync(authDb)).toBe(true);
    });
});
