#!/usr/bin/env node
/**
 * BetterDesk Console - Password Reset Script
 * Usage: node reset-password.js <new-password> [username]
 * 
 * Resets the password for a user. If username is not provided, defaults to 'admin'.
 * If user doesn't exist, creates a new admin user.
 *
 * Supports both the selected SQLite db_v2.sqlite3 store and PostgreSQL.
 * DB_TYPE env var controls the mode: "postgres" or "sqlite" (default).
 */

const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 12;

/**
 * Load .env file from the console root so that DB_TYPE / DATABASE_URL
 * are available even when the script is called outside of systemd.
 */
function loadEnvFile() {
    const envFile = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envFile)) return;
    try {
        const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq > 0) {
                const key = trimmed.substring(0, eq).trim();
                const val = trimmed.substring(eq + 1).trim();
                if (!process.env[key]) process.env[key] = val;
            }
        }
    } catch (_) { /* ignore */ }
}

// ---- SQLite helpers ----

function openSQLite(dbPath) {
    const Database = require('better-sqlite3');
    console.log(`Auth database (SQLite): ${dbPath}`);
    const db = new Database(dbPath, { fileMustExist: false });
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT DEFAULT 'admin',
            auth_provider TEXT NOT NULL DEFAULT 'local',
            created_at TEXT DEFAULT (datetime('now')),
            last_login TEXT,
            totp_secret TEXT DEFAULT '',
            totp_enabled INTEGER DEFAULT 0,
            totp_recovery_codes TEXT DEFAULT NULL
        )
    `);
    return {
        getUser(username) { return db.prepare('SELECT id FROM users WHERE username = ?').get(username); },
        updatePassword(username, hash) { db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, username); },
        createUser(username, hash, role) { db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, hash, role); },
        deleteAll() { return db.prepare('DELETE FROM users').run().changes; },
        close() { db.close(); },
    };
}

// ---- PostgreSQL helpers ----

async function openPostgres() {
    const { Pool } = require('pg');
    const dsn = process.env.DATABASE_URL;
    if (!dsn) {
        console.error('DB_TYPE=postgres but DATABASE_URL is not set');
        process.exit(1);
    }
    console.log(`Auth database (PostgreSQL): ${new URL(dsn).hostname}`);
    const pool = new Pool({ connectionString: dsn });
    // Ensure users table exists
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT DEFAULT 'admin',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            last_login TIMESTAMPTZ,
            totp_secret TEXT DEFAULT NULL,
            totp_enabled BOOLEAN DEFAULT FALSE,
            totp_recovery_codes TEXT DEFAULT NULL
        )
    `);
    return {
        async getUser(username) { return (await pool.query('SELECT id FROM users WHERE username = $1', [username])).rows[0] || null; },
        async updatePassword(username, hash) { await pool.query('UPDATE users SET password_hash = $1 WHERE username = $2', [hash, username]); },
        async createUser(username, hash, role) { await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)', [username, hash, role]); },
        async deleteAll() { return (await pool.query('DELETE FROM users')).rowCount; },
        async close() { await pool.end(); },
    };
}

async function main() {
    loadEnvFile();

    const args = process.argv.slice(2);
    
    if (args.length < 1) {
        console.error('Usage: node reset-password.js <new-password> [username]');
        console.error('       node reset-password.js --delete-all');
        process.exit(1);
    }
    
    // Detect database type
    const dbType = (process.env.DB_TYPE || 'sqlite').toLowerCase();
    let store;

    if (dbType === 'postgres' || dbType === 'postgresql') {
        store = await openPostgres();
    } else {
        const dataDir = process.env.DATA_DIR || findDataDir();
        const dbPath = process.env.DB_PATH || process.env.DB_URL
            || path.join(process.env.KEYS_PATH || process.env.RUSTDESK_DIR || dataDir, 'db_v2.sqlite3');
        store = openSQLite(dbPath);
    }

    try {
        // Handle --delete-all flag (for fresh install)
        if (args[0] === '--delete-all') {
            const count = await store.deleteAll();
            console.log(`Deleted ${count} user(s)`);
            await store.close();
            process.exit(0);
        }
        
        const newPassword = args[0];
        const username = args[1] || 'admin';
        
        // Validate password
        if (newPassword.length < 6) {
            console.error('Password must be at least 6 characters');
            process.exit(1);
        }
        
        // Hash password with bcrypt
        const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
        
        // Self-test: verify the hash we just created is valid
        const selfTest = await bcrypt.compare(newPassword, passwordHash);
        if (!selfTest) {
            console.error('CRITICAL: bcrypt self-test failed! The generated hash cannot verify the password.');
            console.error('This may indicate a broken bcrypt native module. Try: npm rebuild bcrypt');
            process.exit(1);
        }
        
        // Check if user exists
        const existingUser = await store.getUser(username);
        
        if (existingUser) {
            await store.updatePassword(username, passwordHash);
            console.log(`Password updated for user: ${username}`);
        } else {
            await store.createUser(username, passwordHash, 'admin');
            console.log(`Created admin user: ${username}`);
        }
        
        console.log(`Hash type: bcrypt, length: ${passwordHash.length}`);
    } finally {
        await store.close();
    }
    
    console.log('Done');
    process.exit(0);
}

function findDataDir() {
    const isWindows = process.platform === 'win32';
    const possiblePaths = [
        process.env.RUSTDESK_DATA,
        process.env.DATA_DIR,
        // BetterDesk Console standard data directories (Windows)
        'C:\\BetterDeskConsole\\data',
        'C:\\BetterDesk\\BetterDeskConsole\\data',
        'C:\\BetterDesk\\data',
        // BetterDesk Console standard data directories (Linux)
        '/opt/BetterDeskConsole/data',
        // Legacy paths
        '/opt/rustdesk',
        '/var/lib/rustdesk',
        'C:\\RustDesk',
        path.join(process.cwd(), 'data')
    ];
    
    for (const p of possiblePaths) {
        if (p && fs.existsSync(p)) {
            return p;
        }
    }
    
    // Default to data subdirectory of current working directory
    return path.join(process.cwd(), 'data');
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
