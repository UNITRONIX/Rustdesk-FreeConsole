#!/usr/bin/env node
/**
 * Restore Go SQLite user password_hash values from the panel auth.db.
 *
 * Use after a dual-SQLite backfill created Go users with random placeholder
 * passwords (RustDesk login fails, console login still works).
 *
 * Does NOT recover plaintext — copies the hashes the console already stores
 * so the same passwords work again for RustDesk /api/login.
 *
 * Usage (from console install dir, as Administrator if needed):
 *   node scripts/restore-go-password-hashes.js
 *   node scripts/restore-go-password-hashes.js --auth C:\betterdesk-console\data\auth.db --go C:\Betterdesk-server\db_v2.sqlite3
 *
 * Optional env:
 *   DATA_DIR / DB_PATH / KEYS_PATH / RUSTDESK_DIR — same as the console .env
 *
 * Tip: if the Go DB is locked, stop BetterDeskServer, run this, then start it.
 */

'use strict';

const path = require('path');
const fs = require('fs');

function loadEnvFile() {
    const envFile = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envFile)) return;
    try {
        for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq <= 0) continue;
            const key = trimmed.slice(0, eq).trim();
            const val = trimmed.slice(eq + 1).trim();
            if (!process.env[key]) process.env[key] = val;
        }
    } catch (_) { /* ignore */ }
}

function parseArgs(argv) {
    const out = { auth: '', go: '' };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if ((a === '--auth' || a === '--auth-db') && argv[i + 1]) {
            out.auth = argv[++i];
        } else if ((a === '--go' || a === '--go-db') && argv[i + 1]) {
            out.go = argv[++i];
        }
    }
    return out;
}

function firstExisting(candidates) {
    for (const p of candidates) {
        if (p && fs.existsSync(p)) return p;
    }
    return candidates.find(Boolean) || '';
}

function main() {
    loadEnvFile();
    const args = parseArgs(process.argv.slice(2));

    const dbType = String(process.env.DB_TYPE || '').toLowerCase();
    if (dbType === 'postgres' || dbType === 'postgresql' ||
        /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL || '')) {
        console.log('Shared PostgreSQL — panel and Go already use the same users table. Nothing to restore.');
        process.exit(0);
    }

    const Database = require('better-sqlite3');
    const consoleRoot = path.join(__dirname, '..');
    const dataDir = process.env.DATA_DIR || path.join(consoleRoot, 'data');
    const rustdeskDir = process.env.KEYS_PATH || process.env.RUSTDESK_DIR || process.env.RUSTDESK_PATH || '';

    const authPath = firstExisting([
        args.auth,
        path.join(dataDir, 'auth.db'),
        path.join(consoleRoot, 'data', 'auth.db'),
        'C:\\betterdesk-console\\data\\auth.db',
        'C:\\BetterDeskConsole\\data\\auth.db',
    ]);

    const goDbPath = firstExisting([
        args.go,
        process.env.DB_PATH,
        rustdeskDir ? path.join(rustdeskDir, 'db_v2.sqlite3') : '',
        'C:\\Betterdesk-server\\db_v2.sqlite3',
        'C:\\BetterDesk\\db_v2.sqlite3',
    ]);

    if (!authPath || !fs.existsSync(authPath)) {
        console.error('Panel auth.db not found. Tried DATA_DIR and common Windows paths.');
        console.error('Pass explicitly: --auth C:\\betterdesk-console\\data\\auth.db');
        process.exit(1);
    }
    if (!goDbPath || !fs.existsSync(goDbPath)) {
        console.error('Go DB not found. Tried DB_PATH / KEYS_PATH and common Windows paths.');
        console.error('Pass explicitly: --go C:\\Betterdesk-server\\db_v2.sqlite3');
        process.exit(1);
    }

    console.log(`Panel auth.db: ${authPath}`);
    console.log(`Go DB:         ${goDbPath}`);

    const authDb = new Database(authPath, { readonly: true, fileMustExist: true });
    const goDb = new Database(goDbPath, { readonly: false, fileMustExist: true });
    goDb.pragma('busy_timeout = 5000');

    const panelUsers = authDb.prepare(
        `SELECT username, password_hash, COALESCE(auth_provider, 'local') AS auth_provider FROM users`
    ).all();

    let restored = 0;
    let skipped = 0;
    const failed = [];

    const update = goDb.prepare(
        'UPDATE users SET password_hash = ? WHERE lower(username) = lower(?)'
    );

    for (const u of panelUsers) {
        const username = String(u.username || '').trim();
        const hash = String(u.password_hash || '').trim();
        const provider = String(u.auth_provider || 'local').trim() || 'local';
        if (!username || !hash || provider === 'ldap' || provider === 'oidc') {
            skipped += 1;
            continue;
        }
        try {
            const info = update.run(hash, username);
            if (info.changes < 1) {
                failed.push(`${username} (not on Go)`);
                continue;
            }
            restored += 1;
            console.log(`  restored: ${username}`);
        } catch (err) {
            failed.push(`${username} (${err.message})`);
        }
    }

    authDb.close();
    goDb.close();

    console.log(`Done. restored=${restored} skipped=${skipped} failed=${failed.length}`);
    if (failed.length) {
        console.warn('Failed:', failed.join(', '));
        process.exit(2);
    }
}

main();
