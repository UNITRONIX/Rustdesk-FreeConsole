'use strict';

/**
 * Persistent express-session store backed by the selected BetterDesk database.
 * It keeps console sessions revocable across process restarts without creating
 * a separate auth database.
 */

const session = require('express-session');

class DatabaseSessionStore extends session.Store {
    constructor({ config, ttlMs }) {
        super();
        this.config = config;
        this.ttlMs = Math.max(60_000, Number(ttlMs) || 24 * 60 * 60 * 1000);
        this.type = /^(postgres|postgresql)$/i.test(process.env.DB_TYPE || '')
            || /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL || '')
            ? 'postgres'
            : 'sqlite';
        this.sqlite = null;
        this.pool = null;
        this.ready = this.initialize();
    }

    async initialize() {
        if (this.type === 'postgres') {
            const { Pool } = require('pg');
            this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
            await this.pool.query(`
                CREATE TABLE IF NOT EXISTS panel_sessions (
                    sid TEXT PRIMARY KEY,
                    session_json TEXT NOT NULL,
                    expires_at TIMESTAMPTZ NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS idx_panel_sessions_expires ON panel_sessions (expires_at);
            `);
            return;
        }
        const Database = require('better-sqlite3');
        this.sqlite = new Database(this.config.dbPath, { readonly: false, fileMustExist: false });
        this.sqlite.pragma('busy_timeout = 5000');
        this.sqlite.pragma('journal_mode = WAL');
        this.sqlite.exec(`
            CREATE TABLE IF NOT EXISTS panel_sessions (
                sid TEXT PRIMARY KEY,
                session_json TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_panel_sessions_expires ON panel_sessions (expires_at);
        `);
    }

    expiresAt(sess) {
        const raw = sess?.cookie?.expires;
        const fromCookie = raw ? new Date(raw).getTime() : NaN;
        return Number.isFinite(fromCookie) ? fromCookie : Date.now() + this.ttlMs;
    }

    get(sid, callback) {
        this.ready.then(async () => {
            let raw;
            if (this.type === 'postgres') {
                const result = await this.pool.query(
                    'SELECT session_json FROM panel_sessions WHERE sid = $1 AND expires_at > NOW()',
                    [sid]
                );
                raw = result.rows[0]?.session_json;
            } else {
                raw = this.sqlite.prepare(
                    'SELECT session_json FROM panel_sessions WHERE sid = ? AND expires_at > ?'
                ).get(sid, Date.now())?.session_json;
            }
            callback(null, raw ? JSON.parse(raw) : null);
        }).catch((err) => callback(err));
    }

    set(sid, sess, callback = () => {}) {
        this.ready.then(async () => {
            const serialized = JSON.stringify(sess);
            const expiresAt = this.expiresAt(sess);
            if (this.type === 'postgres') {
                await this.pool.query(`
                    INSERT INTO panel_sessions (sid, session_json, expires_at, updated_at)
                    VALUES ($1, $2, to_timestamp($3 / 1000.0), NOW())
                    ON CONFLICT(sid) DO UPDATE SET
                        session_json = EXCLUDED.session_json,
                        expires_at = EXCLUDED.expires_at,
                        updated_at = NOW()
                `, [sid, serialized, expiresAt]);
            } else {
                this.sqlite.prepare(`
                    INSERT INTO panel_sessions (sid, session_json, expires_at, updated_at)
                    VALUES (?, ?, ?, datetime('now'))
                    ON CONFLICT(sid) DO UPDATE SET
                        session_json = excluded.session_json,
                        expires_at = excluded.expires_at,
                        updated_at = datetime('now')
                `).run(sid, serialized, expiresAt);
            }
            callback(null);
        }).catch((err) => callback(err));
    }

    touch(sid, sess, callback = () => {}) {
        this.ready.then(async () => {
            const expiresAt = this.expiresAt(sess);
            if (this.type === 'postgres') {
                await this.pool.query(
                    'UPDATE panel_sessions SET expires_at = to_timestamp($2 / 1000.0), updated_at = NOW() WHERE sid = $1',
                    [sid, expiresAt]
                );
            } else {
                this.sqlite.prepare(
                    "UPDATE panel_sessions SET expires_at = ?, updated_at = datetime('now') WHERE sid = ?"
                ).run(expiresAt, sid);
            }
            callback(null);
        }).catch((err) => callback(err));
    }

    destroy(sid, callback = () => {}) {
        this.ready.then(async () => {
            if (this.type === 'postgres') {
                await this.pool.query('DELETE FROM panel_sessions WHERE sid = $1', [sid]);
            } else {
                this.sqlite.prepare('DELETE FROM panel_sessions WHERE sid = ?').run(sid);
            }
            callback(null);
        }).catch((err) => callback(err));
    }

    cleanup(callback = () => {}) {
        this.ready.then(async () => {
            if (this.type === 'postgres') {
                await this.pool.query('DELETE FROM panel_sessions WHERE expires_at <= NOW()');
            } else {
                this.sqlite.prepare('DELETE FROM panel_sessions WHERE expires_at <= ?').run(Date.now());
            }
            callback(null);
        }).catch((err) => callback(err));
    }

    async close() {
        await this.ready;
        if (this.pool) await this.pool.end();
        if (this.sqlite) this.sqlite.close();
    }
}

module.exports = { DatabaseSessionStore };
