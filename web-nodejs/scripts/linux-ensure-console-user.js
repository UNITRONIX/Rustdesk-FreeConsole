'use strict';

/**
 * Linux post-update hook: dedicated console system user (audit H-7).
 * Idempotent — safe to run on every update/repair.
 *
 * Usage:
 *   node scripts/linux-ensure-console-user.js
 *   require('./scripts/linux-ensure-console-user') from updateService
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const config = require('../config/config');

const SVC_USER = 'betterdesk';
const CONSOLE_PATH = path.join(__dirname, '..');
const RUSTDESK_PATH = config.keysPath || config.rustdeskDir || '/opt/rustdesk';
const CONSOLE_SERVICE = 'betterdesk-console';

function isRoot() {
    return typeof process.getuid === 'function' && process.getuid() === 0;
}

function runPrivileged(cmd, opts = {}) {
    const prefix = isRoot() ? '' : 'sudo ';
    return execSync(prefix + cmd, {
        encoding: 'utf8',
        stdio: opts.stdio || 'pipe',
        timeout: opts.timeout || 30000,
    });
}

function readServiceFile() {
    try {
        const fragment = runPrivileged(
            `systemctl show ${CONSOLE_SERVICE} --property=FragmentPath --value 2>/dev/null || true`
        ).trim();
        const servicePath = fragment || `/etc/systemd/system/${CONSOLE_SERVICE}.service`;
        if (!fs.existsSync(servicePath)) return { servicePath: null, content: '' };
        const content = isRoot()
            ? fs.readFileSync(servicePath, 'utf8')
            : runPrivileged(`cat ${JSON.stringify(servicePath)}`);
        return { servicePath, content };
    } catch (_) {
        return { servicePath: null, content: '' };
    }
}

function writeServiceFile(servicePath, content) {
    if (isRoot()) {
        fs.writeFileSync(servicePath, content, 'utf8');
    } else {
        const tmp = `/tmp/${CONSOLE_SERVICE}.${Date.now()}.service`;
        fs.writeFileSync(tmp, content, 'utf8');
        runPrivileged(`cp ${JSON.stringify(tmp)} ${JSON.stringify(servicePath)}`);
        try { fs.unlinkSync(tmp); } catch (_) { /* ok */ }
    }
}

function userExists(name) {
    try {
        runPrivileged(`id ${name} 2>/dev/null`);
        return true;
    } catch (_) {
        return false;
    }
}

function ensureSystemUser() {
    if (!userExists(SVC_USER)) {
        runPrivileged(
            `useradd -r -s /usr/sbin/nologin -d /var/lib/betterdesk -c "BetterDesk web console" ${SVC_USER}`
        );
    }
    runPrivileged('mkdir -p /var/lib/betterdesk');
}

function fixSharedPermissions() {
    runPrivileged(`mkdir -p ${JSON.stringify(path.join(CONSOLE_PATH, 'data'))}`);
    runPrivileged(`chown -R ${SVC_USER}:${SVC_USER} ${JSON.stringify(CONSOLE_PATH)}`);

    const shared = [
        path.join(RUSTDESK_PATH, '.api_key'),
        path.join(RUSTDESK_PATH, 'id_ed25519.pub'),
        path.join(RUSTDESK_PATH, 'db_v2.sqlite3'),
        path.join(RUSTDESK_PATH, 'db_v2.sqlite3-wal'),
        path.join(RUSTDESK_PATH, 'db_v2.sqlite3-shm'),
        path.join(RUSTDESK_PATH, 'ssl', 'betterdesk.crt'),
        path.join(RUSTDESK_PATH, 'ssl', 'betterdesk.key'),
    ];
    for (const filePath of shared) {
        if (!fs.existsSync(filePath)) continue;
        runPrivileged(`chown root:${SVC_USER} ${JSON.stringify(filePath)}`);
        runPrivileged(`chmod g+r ${JSON.stringify(filePath)}`);
        if (filePath.includes('db_v2') || filePath.endsWith('.api_key') || filePath.includes('/ssl/')) {
            runPrivileged(`chmod g+rw ${JSON.stringify(filePath)}`);
        } else {
            runPrivileged(`chmod 640 ${JSON.stringify(filePath)}`);
        }
    }
}

function patchServiceUserLine() {
    const { servicePath, content } = readServiceFile();
    if (!servicePath || !content) {
        return { changed: false, reason: 'service unit not found' };
    }
    if (!/^User=root/m.test(content)) {
        return { changed: false, reason: 'User is not root (already patched or custom)' };
    }
    const updated = content.replace(/^User=root/m, `User=${SVC_USER}`);
    writeServiceFile(servicePath, updated);
    runPrivileged('systemctl daemon-reload');
    return { changed: true, user: SVC_USER, servicePath };
}

/**
 * @returns {{ changed: boolean, user?: string, changes: string[], error?: string, skipped?: boolean }}
 */
function ensureLinuxConsoleServiceUser() {
    const result = { changed: false, changes: [] };
    if (process.platform !== 'linux') {
        return { ...result, skipped: true, reason: 'not-linux' };
    }
    try {
        ensureSystemUser();
        fixSharedPermissions();
        const patch = patchServiceUserLine();
        if (patch.changed) {
            result.changed = true;
            result.user = patch.user;
            result.changes.push(`console service User=${patch.user}`);
        } else if (patch.reason) {
            result.changes.push(patch.reason);
        }
        result.changes.push('permissions synced for betterdesk console user');
    } catch (err) {
        result.error = err.message || String(err);
    }
    return result;
}

if (require.main === module) {
    const out = ensureLinuxConsoleServiceUser();
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.error ? 1 : 0);
}

module.exports = { ensureLinuxConsoleServiceUser, SVC_USER };
