'use strict';

/**
 * Linux post-update hook: dedicated console system user (audit H-7).
 * Idempotent — safe to run on every update/repair.
 *
 * Usage:
 *   node scripts/linux-ensure-console-user.js
 *   (also loaded from services/updateService.js after panel updates)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const config = require('../config/config');

const SVC_USER = 'betterdesk';
const CONSOLE_PATH = path.join(__dirname, '..');
const RUSTDESK_PATH = config.keysPath || config.rustdeskDir || '/opt/rustdesk';
const CONSOLE_SERVICE = 'betterdesk-console';
const SERVER_SERVICE = 'betterdesk-server';
const UPDATE_SUDOERS_PATH = '/etc/sudoers.d/betterdesk-console-updates';
const UPDATE_SUDOERS_MARKER = '# Managed by BetterDesk linux-ensure-console-user.js';

function buildUpdateSudoersContent() {
    return [
        UPDATE_SUDOERS_MARKER,
        `${SVC_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl`,
        `${SVC_USER} ALL=(root) NOPASSWD: /usr/bin/journalctl`,
        '',
    ].join('\n');
}

/** Install passwordless sudo for panel service restarts (Linux updates). */
function ensureConsoleUpdateSudoers() {
    if (!isRoot() && !canUseSudo()) {
        return { changed: false, skipped: true, reason: 'no root/sudo for sudoers install' };
    }
    const desired = buildUpdateSudoersContent();
    let existing = '';
    try {
        if (fs.existsSync(UPDATE_SUDOERS_PATH)) {
            existing = isRoot()
                ? fs.readFileSync(UPDATE_SUDOERS_PATH, 'utf8')
                : runPrivileged(`cat ${JSON.stringify(UPDATE_SUDOERS_PATH)}`);
        }
    } catch (_) {
        existing = '';
    }
    if (existing === desired) {
        return { changed: false, reason: 'sudoers already current' };
    }
    const tmp = `/tmp/betterdesk-console-updates.${Date.now()}.sudoers`;
    fs.writeFileSync(tmp, desired, 'utf8');
    runPrivileged(`visudo -cf ${JSON.stringify(tmp)}`);
    if (isRoot()) {
        fs.copyFileSync(tmp, UPDATE_SUDOERS_PATH);
        fs.chmodSync(UPDATE_SUDOERS_PATH, 0o440);
    } else {
        runPrivileged(`cp ${JSON.stringify(tmp)} ${JSON.stringify(UPDATE_SUDOERS_PATH)}`);
        runPrivileged(`chmod 440 ${JSON.stringify(UPDATE_SUDOERS_PATH)}`);
    }
    try { fs.unlinkSync(tmp); } catch (_) { /* ok */ }
    return { changed: true, path: UPDATE_SUDOERS_PATH };
}

function isRoot() {
    return typeof process.getuid === 'function' && process.getuid() === 0;
}

function canUseSudo() {
    if (isRoot()) return true;
    try {
        execSync('sudo -n systemctl --version', { stdio: 'pipe', timeout: 5000 });
        return true;
    } catch (_) {
        return false;
    }
}

function runPrivileged(cmd, opts = {}) {
    if (!isRoot() && !canUseSudo()) {
        throw new Error('Privileged command requires root or passwordless sudo');
    }
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
        execSync(`getent passwd ${name}`, { stdio: 'pipe', timeout: 5000 });
        return true;
    } catch (_) {
        return false;
    }
}

function ensureSystemUser() {
    if (userExists(SVC_USER)) {
        return;
    }
    if (!isRoot() && !canUseSudo()) {
        throw new Error(`System user ${SVC_USER} is missing and console cannot create it without root/sudo`);
    }
    runPrivileged(
        `useradd -r -s /usr/sbin/nologin -d /var/lib/betterdesk -c "BetterDesk web console" ${SVC_USER}`
    );
    runPrivileged('mkdir -p /var/lib/betterdesk');
}

function ensureDataDir() {
    const dataDir = path.join(CONSOLE_PATH, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    return dataDir;
}

/**
 * @returns {{ ok: boolean, error?: string, skipped?: boolean }}
 */
function fixSharedPermissions() {
    if (!isRoot() && !canUseSudo()) {
        return { ok: false, skipped: true, error: 'no root/sudo for permission sync' };
    }
    try {
        runPrivileged('mkdir -p /var/lib/betterdesk');
        runPrivileged(`mkdir -p ${JSON.stringify(path.join(CONSOLE_PATH, 'data'))}`);
        runPrivileged(`mkdir -p ${JSON.stringify(path.join(CONSOLE_PATH, 'data', 'go-cache', 'mod'))}`);
        runPrivileged(`mkdir -p ${JSON.stringify(path.join(CONSOLE_PATH, 'data', 'go-cache', 'build'))}`);
        runPrivileged(`mkdir -p /var/lib/betterdesk/.npm`);
        runPrivileged(`chown -R ${SVC_USER}:${SVC_USER} /var/lib/betterdesk`);
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
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
}

/** Verify the console service user can write the data directory. */
function verifyConsoleUserAccess() {
    if (!userExists(SVC_USER)) {
        return { ok: false, error: `system user ${SVC_USER} does not exist` };
    }
    const dataDir = path.join(CONSOLE_PATH, 'data');
    try {
        if (typeof process.getuid === 'function' && process.getuid() === 0) {
            execSync(
                `runuser -u ${SVC_USER} -- test -w ${JSON.stringify(dataDir)}`,
                { stdio: 'pipe', timeout: 5000 }
            );
        } else if (typeof process.getuid === 'function') {
            const uid = execSync(`id -u ${SVC_USER}`, { encoding: 'utf8', stdio: 'pipe', timeout: 5000 }).trim();
            if (String(process.getuid()) === uid) {
                fs.accessSync(dataDir, fs.constants.W_OK);
            } else {
                return { ok: false, error: `cannot verify ${SVC_USER} access from uid ${process.getuid()}` };
            }
        } else {
            fs.accessSync(dataDir, fs.constants.W_OK);
        }
        return { ok: true };
    } catch (_) {
        return { ok: false, error: `${SVC_USER} cannot write ${dataDir}` };
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
    const result = { changed: false, changes: [], permissionsOk: false };
    if (process.platform !== 'linux') {
        return { ...result, skipped: true, reason: 'not-linux' };
    }
    try {
        ensureDataDir();
        ensureSystemUser();

        const privileged = isRoot() || canUseSudo();
        let perm = { ok: false, skipped: !privileged };
        if (privileged) {
            perm = fixSharedPermissions();
            const sudoers = ensureConsoleUpdateSudoers();
            if (sudoers.changed) {
                result.changes.push('passwordless sudo for panel service restarts');
            } else if (sudoers.reason) {
                result.changes.push(sudoers.reason);
            }
            if (perm.ok) {
                result.permissionsOk = true;
                result.changes.push('permissions synced for betterdesk console user');
            } else if (perm.error) {
                result.error = perm.error;
            }
        } else if (userExists(SVC_USER)) {
            const access = verifyConsoleUserAccess();
            result.permissionsOk = access.ok;
            if (access.ok) {
                result.changes.push(`${SVC_USER} user present; data dir writable`);
            } else {
                result.changes.push(`${SVC_USER} user present; permission sync skipped (no sudo)`);
                result.error = access.error || 'permission sync requires root/sudo';
            }
        } else {
            result.error = `System user ${SVC_USER} is missing and cannot be created without root/sudo`;
        }

        const access = verifyConsoleUserAccess();
        if (access.ok) result.permissionsOk = true;

        // Only switch User=root → betterdesk when permissions are verified.
        if (result.permissionsOk && privileged) {
            const patch = patchServiceUserLine();
            if (patch.changed) {
                result.changed = true;
                result.user = patch.user;
                result.changes.push(`console service User=${patch.user}`);
            } else if (patch.reason) {
                result.changes.push(patch.reason);
            }
        } else if (!result.permissionsOk) {
            result.changes.push('skipped service User= patch until permissions are fixed');
        }
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

module.exports = {
    ensureLinuxConsoleServiceUser,
    ensureDataDir,
    fixSharedPermissions,
    verifyConsoleUserAccess,
    SVC_USER,
};
