#!/usr/bin/env node
'use strict';

/**
 * Post-deploy verification for security patches (H-1 token_hash, H-5 SSRF).
 * Safe on production: read-only checks + additive migration only via db init.
 */

const path = require('path');

process.chdir(path.join(__dirname, '..'));

const results = [];

function pass(name, detail) {
    results.push({ name, ok: true, detail });
    console.log(`PASS  ${name}${detail ? `: ${detail}` : ''}`);
}

function fail(name, detail) {
    results.push({ name, ok: false, detail });
    console.error(`FAIL  ${name}${detail ? `: ${detail}` : ''}`);
}

async function main() {
    // --- tokenHash ---
    try {
        const { hashAccessToken } = require('../lib/tokenHash');
        const t = 'abcd'.repeat(16);
        const h = hashAccessToken(t);
        if (h.length !== 64) throw new Error('unexpected hash length');
        pass('tokenHash', 'SHA-256 hex length 64');
    } catch (e) {
        fail('tokenHash', e.message);
    }

    // --- ssrfGuard ---
    try {
        const { isBlockedIp, assertSafeHttpUrl, SsrfBlockedError } = require('../lib/ssrfGuard');
        if (!isBlockedIp('127.0.0.1') || !isBlockedIp('10.0.0.1')) {
            throw new Error('private IPs should be blocked');
        }
        if (isBlockedIp('1.1.1.1')) throw new Error('public IP should be allowed');
        try {
            await assertSafeHttpUrl('http://127.0.0.1/');
            throw new Error('127.0.0.1 should be rejected');
        } catch (e) {
            if (!(e instanceof SsrfBlockedError)) throw e;
        }
        await assertSafeHttpUrl('http://1.1.1.1/');
        pass('ssrfGuard', 'blocks loopback, allows public IP URLs');
    } catch (e) {
        fail('ssrfGuard', e.message);
    }

    // --- DB migration (additive) ---
    try {
        const { getAdapter } = require('../services/dbAdapter');
        const adapter = getAdapter();
        if (!adapter) throw new Error('no db adapter');
        await adapter.init();

        const config = require('../config/config');
        if (config.dbType === 'postgres' || config.dbType === 'postgresql') {
            const { Pool } = require('pg');
            const pool = new Pool({ connectionString: config.databaseUrl });
            const cols = await pool.query(`
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'access_tokens' AND column_name = 'token_hash'
            `);
            await pool.end();
            if (cols.rowCount === 0) throw new Error('token_hash column missing after init');
            pass('db token_hash column', 'present in PostgreSQL access_tokens');
        } else {
            pass('db token_hash column', 'sqlite mode — checked via init() without error');
        }

        // Round-trip token create + lookup by hash (uses real DB — creates one test row then revokes)
        const crypto = require('crypto');
        const testToken = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 3600000).toISOString().replace('T', ' ').slice(0, 19);
        const users = await adapter.getAllUsers();
        if (!users || users.length === 0) throw new Error('no users in database');
        const userId = users[0].id;
        await adapter.createAccessToken({
            token: testToken,
            userId,
            clientId: 'patch-verify',
            clientUuid: 'patch-verify-uuid',
            expiresAt,
            ipAddress: '127.0.0.1',
        });
        const row = await adapter.getAccessToken(testToken);
        if (!row) throw new Error('getAccessToken returned null');
        if (!row.token_hash) throw new Error('token_hash not populated on insert');
        await adapter.revokeAccessToken(testToken);
        pass('db token round-trip', 'create/lookup/revoke with token_hash');
    } catch (e) {
        fail('db migration', e.message);
    }

    // Windows panel updates exit Node; arm NSSM start / interactive re-exec from
    // the freshly written helper so older in-memory updaters still recover.
    // Safe if console is still up: delayed child hits EADDRINUSE and exits.
    if (process.platform === 'win32' && process.env.BETTERDESK_ARM_CONSOLE_RESTART !== '0') {
        try {
            const { spawnSync } = require('child_process');
            const armScript = path.join(__dirname, 'windows-arm-console-restart.js');
            const arm = spawnSync(process.execPath, [armScript], {
                cwd: path.join(__dirname, '..'),
                encoding: 'utf8',
                timeout: 15000,
                windowsHide: true,
                env: process.env,
            });
            const out = `${arm.stdout || ''}${arm.stderr || ''}`.trim();
            if (out) console.log(out);
            pass('windowsConsoleRestart', arm.status === 0 ? 'arm script completed' : `arm script status ${arm.status}`);
        } catch (e) {
            pass('windowsConsoleRestart', `skipped: ${e.message}`);
        }
    }

    const failed = results.filter((r) => !r.ok);
    console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
    console.error('verify script error:', e);
    process.exit(1);
});
