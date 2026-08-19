'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Regression test for the `database.js` facade silently dropping peer-grant
 * calls: `userScopeService.syncUserPeerGrants()` / `getUserPeerGrantIds()`
 * both guard on `typeof db.setUserPeerGrants !== 'function'` /
 * `typeof db.getUserPeerGrants !== 'function'` and quietly no-op (returning
 * `[]`, no error, no log) when the facade doesn't expose those methods —
 * even though the underlying adapter (dbAdapter.js) implements them fully
 * for both SQLite and Postgres. `POST /api/users` and `PATCH /api/users/:id`
 * both reported `{"success":true}` while never persisting a single row to
 * `user_peer_grants`.
 *
 * This is deliberately NOT a route-level test with a mocked `database`
 * module (see users.routes.test.js, which mocks `../services/database`
 * wholesale) — a mock can't catch the real facade omitting a method, which
 * is exactly how this slipped through. This test requires the real facade
 * against a temp SQLite file, the same way dbAdapter.singleStore.test.js
 * does for other facade/adapter wiring.
 */
describe('database facade — peer grants', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'betterdesk-peer-grants-'));
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

    it('exposes getUserPeerGrants/setUserPeerGrants as functions (guarded on by userScopeService)', () => {
        const db = require('../services/database');
        expect(typeof db.getUserPeerGrants).toBe('function');
        expect(typeof db.setUserPeerGrants).toBe('function');
    });

    it('round-trips a peer grant through the real facade, not just the adapter', async () => {
        const db = require('../services/database');
        await db.init();

        const user = await db.createUser('grant-test-user', 'hashed', 'operator');

        await db.setUserPeerGrants(user.id, ['1234567890', '1234567890', ' 42 ']);
        const grants = await db.getUserPeerGrants(user.id);

        expect(grants.sort()).toEqual(['1234567890', '42']);

        await db.close();
    });

    it('userScopeService.syncUserPeerGrants actually persists via the real facade', async () => {
        const db = require('../services/database');
        const userScopeService = require('../services/userScopeService');
        await db.init();

        const user = await db.createUser('grant-test-user-2', 'hashed', 'viewer');

        const normalized = await userScopeService.syncUserPeerGrants(db, user.id, ['999888777']);
        expect(normalized).toEqual(['999888777']);

        const stored = await userScopeService.getUserPeerGrantIds(db, user.id);
        expect(stored).toEqual(['999888777']);

        await db.close();
    });
});
