'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { DatabaseSessionStore } = require('../services/databaseSessionStore');

function invoke(method, ...args) {
    return new Promise((resolve, reject) => {
        method(...args, (err, value) => err ? reject(err) : resolve(value));
    });
}

describe('DatabaseSessionStore', () => {
    let tempDir;
    let store;
    let previousDbType;
    let previousDatabaseUrl;

    beforeEach(async () => {
        previousDbType = process.env.DB_TYPE;
        previousDatabaseUrl = process.env.DATABASE_URL;
        process.env.DB_TYPE = 'sqlite';
        delete process.env.DATABASE_URL;
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'betterdesk-session-store-'));
        store = new DatabaseSessionStore({
            config: { dbPath: path.join(tempDir, 'db_v2.sqlite3') },
            ttlMs: 60_000
        });
        await store.ready;
    });

    afterEach(async () => {
        if (store) await store.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
        store = null;
        if (previousDbType === undefined) delete process.env.DB_TYPE;
        else process.env.DB_TYPE = previousDbType;
        if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previousDatabaseUrl;
    });

    it('persists, expires and destroys console sessions in SQLite', async () => {
        const sid = 'session-id';
        const session = {
            user: { id: 7, username: 'alice', role: 'operator' },
            cookie: { expires: new Date(Date.now() + 60_000).toISOString() }
        };

        await invoke(store.set.bind(store), sid, session);
        expect(await invoke(store.get.bind(store), sid)).toEqual(session);

        await invoke(store.touch.bind(store), sid, {
            ...session,
            cookie: { expires: new Date(Date.now() + 120_000).toISOString() }
        });
        expect(await invoke(store.get.bind(store), sid)).toEqual(session);

        await invoke(store.destroy.bind(store), sid);
        expect(await invoke(store.get.bind(store), sid)).toBeNull();
    });
});
