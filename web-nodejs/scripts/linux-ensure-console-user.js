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
const { execFileSync, execSync } = require('child_process');
const config = require('../config/config');
const {
    readConsoleEnvPortSettings,
    consoleEnvUsesPrivilegedPorts,
    ensureBindCapabilityInServiceUnit,
} = require('../lib/privilegedPorts');
const { resolveDeployScriptPath } = require('../lib/linuxServerBinaryDeploy');
const {
    resolveSystemdUnitScriptPath,
    readSystemdUnitPrivileged,
    writeSystemdUnitPrivileged,
    isAllowedSystemdUnitPath,
} = require('../lib/linuxSystemdUnitPrivileged');

const SVC_USER = 'betterdesk';
const CONSOLE_PATH = path.join(__dirname, '..');
const RUSTDESK_PATH = config.keysPath || config.rustdeskDir || '/opt/rustdesk';
const CONSOLE_SERVICE = 'betterdesk-console';
const SERVER_SERVICE = 'betterdesk-server';
const UPDATE_SUDOERS_PATH = '/etc/sudoers.d/betterdesk-console-updates';
const UPDATE_SUDOERS_MARKER = '# Managed by BetterDesk linux-ensure-console-user.js';
/** setgid + group rwx — new Go-server files inherit group betterdesk (#206) */
const SHARED_GO_DATA_DIR_MODE = '2775';
/** setgid + group rx — console reads TLS material written by root */
const SHARED_GO_SSL_DIR_MODE = '2750';

function resolveSystemctlPath() {
    for (const candidate of ['/usr/bin/systemctl', '/bin/systemctl']) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return '/usr/bin/systemctl';
}

function resolveJournalctlPath() {
    for (const candidate of ['/usr/bin/journalctl', '/bin/journalctl']) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return '/usr/bin/journalctl';
}

function resolveEnsureConsoleUserScriptPath(consoleRoot) {
    return path.join(consoleRoot || CONSOLE_PATH, 'scripts/linux-ensure-console-user.js');
}

function buildUpdateSudoersContent() {
    const systemctl = resolveSystemctlPath();
    const journalctl = resolveJournalctlPath();
    const deployScript = resolveDeployScriptPath(CONSOLE_PATH);
    const systemdUnitScript = resolveSystemdUnitScriptPath(CONSOLE_PATH);
    const ensureScript = resolveEnsureConsoleUserScriptPath(CONSOLE_PATH);
    return [
        UPDATE_SUDOERS_MARKER,
        `${SVC_USER} ALL=(root) NOPASSWD: ${systemctl}`,
        `${SVC_USER} ALL=(root) NOPASSWD: ${journalctl}`,
        `${SVC_USER} ALL=(root) NOPASSWD: ${deployScript}`,
        `${SVC_USER} ALL=(root) NOPASSWD: ${process.execPath} ${systemdUnitScript}`,
        `${SVC_USER} ALL=(root) NOPASSWD: ${process.execPath} ${ensureScript}`,
        '',
    ].join('\n');
}

function ensureDeployScriptExecutable() {
    const deployScript = resolveDeployScriptPath(CONSOLE_PATH);
    if (!fs.existsSync(deployScript)) {
        return { changed: false, reason: 'deploy script not present yet' };
    }
    try {
        const mode = fs.statSync(deployScript).mode & 0o777;
        if ((mode & 0o111) === 0) {
            fs.chmodSync(deployScript, 0o755);
            return { changed: true, path: deployScript };
        }
        return { changed: false, path: deployScript };
    } catch (err) {
        return { changed: false, error: err.message || String(err) };
    }
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
                : runPrivilegedArgv('cat', [UPDATE_SUDOERS_PATH]);
        }
    } catch (_) {
        existing = '';
    }
    if (existing === desired) {
        return { changed: false, reason: 'sudoers already current' };
    }
    const tmp = `/tmp/betterdesk-console-updates.${Date.now()}.sudoers`;
    fs.writeFileSync(tmp, desired, 'utf8');
    runPrivilegedArgv('visudo', ['-cf', tmp]);
    if (isRoot()) {
        fs.copyFileSync(tmp, UPDATE_SUDOERS_PATH);
        fs.chmodSync(UPDATE_SUDOERS_PATH, 0o440);
    } else {
        runPrivilegedArgv('cp', [tmp, UPDATE_SUDOERS_PATH]);
        runPrivilegedArgv('chmod', ['440', UPDATE_SUDOERS_PATH]);
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
        execFileSync('sudo', ['-n', resolveSystemctlPath(), '--version'], { stdio: 'pipe', timeout: 5000 });
        return true;
    } catch (_) {
        return false;
    }
}

function runPrivilegedArgv(binary, args, opts = {}) {
    if (!isRoot() && !canUseSudo()) {
        throw new Error('Privileged command requires root or passwordless sudo');
    }
    const runOpts = {
        encoding: opts.encoding || 'utf8',
        stdio: opts.stdio || 'pipe',
        timeout: opts.timeout || 30000,
    };
    if (isRoot()) {
        return execFileSync(binary, args, runOpts);
    }
    return execFileSync('sudo', ['-n', binary, ...args], runOpts);
}

function readServiceFile() {
    try {
        const fragment = runPrivilegedArgv(resolveSystemctlPath(), [
            'show', CONSOLE_SERVICE, '--property=FragmentPath', '--value',
        ]).trim();
        const servicePath = fragment || `/etc/systemd/system/${CONSOLE_SERVICE}.service`;
        if (!fs.existsSync(servicePath)) return { servicePath: null, content: '' };
        const content = isAllowedSystemdUnitPath(servicePath)
            ? readSystemdUnitPrivileged(servicePath, CONSOLE_PATH)
            : (isRoot()
                ? fs.readFileSync(servicePath, 'utf8')
                : runPrivilegedArgv('cat', [servicePath]));
        return { servicePath, content };
    } catch (_) {
        return { servicePath: null, content: '' };
    }
}

function writeServiceFile(servicePath, content) {
    if (isAllowedSystemdUnitPath(servicePath)) {
        writeSystemdUnitPrivileged(servicePath, content, CONSOLE_PATH);
        return;
    }
    if (isRoot()) {
        fs.writeFileSync(servicePath, content, 'utf8');
    } else {
        const tmp = `/tmp/${CONSOLE_SERVICE}.${Date.now()}.service`;
        fs.writeFileSync(tmp, content, 'utf8');
        runPrivilegedArgv('cp', [tmp, servicePath]);
        try { fs.unlinkSync(tmp); } catch (_) { /* ok */ }
    }
}

function userExists(name) {
    try {
        execFileSync('getent', ['passwd', name], { stdio: 'pipe', timeout: 5000 });
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
    runPrivilegedArgv('useradd', [
        '-r', '-s', '/usr/sbin/nologin', '-d', '/var/lib/betterdesk',
        '-c', 'BetterDesk web console', SVC_USER,
    ]);
    runPrivilegedArgv('mkdir', ['-p', '/var/lib/betterdesk']);
}

function ensureDataDir() {
    const dataDir = path.join(CONSOLE_PATH, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    return dataDir;
}

/**
 * Privileged argv steps for shared Go data directory group access (#206).
 * Exported for unit tests.
 * @param {string} rustdeskPath
 * @param {string} [svcUser]
 * @returns {Array<{ bin: string, args: string[] }>}
 */
function getSharedGoDataDirPermissionSteps(rustdeskPath, svcUser = SVC_USER) {
    const sslDir = path.join(rustdeskPath, 'ssl');
    return [
        { bin: 'mkdir', args: ['-p', rustdeskPath] },
        { bin: 'chown', args: [`root:${svcUser}`, rustdeskPath] },
        { bin: 'chmod', args: [SHARED_GO_DATA_DIR_MODE, rustdeskPath] },
        { bin: 'mkdir', args: ['-p', sslDir] },
        { bin: 'chown', args: [`root:${svcUser}`, sslDir] },
        { bin: 'chmod', args: [SHARED_GO_SSL_DIR_MODE, sslDir] },
    ];
}

function listSharedGoDataFiles(rustdeskPath) {
    const files = [
        path.join(rustdeskPath, '.api_key'),
        path.join(rustdeskPath, 'id_ed25519.pub'),
        path.join(rustdeskPath, 'ssl', 'betterdesk.crt'),
        path.join(rustdeskPath, 'ssl', 'betterdesk.key'),
    ];
    const dbBase = path.join(rustdeskPath, 'db_v2.sqlite3');
    files.push(dbBase);
    for (const suffix of ['-wal', '-shm', '-journal']) {
        files.push(dbBase + suffix);
    }
    return files;
}

function applySharedGoFilePermissions(filePath, svcUser, runFn = runPrivilegedArgv) {
    if (!fs.existsSync(filePath)) return;
    runFn('chown', [`root:${svcUser}`, filePath]);
    runFn('chmod', ['g+r', filePath]);
    if (filePath.includes('db_v2') || filePath.endsWith('.api_key') || filePath.includes(`${path.sep}ssl${path.sep}`)) {
        runFn('chmod', ['g+rw', filePath]);
    } else {
        runFn('chmod', ['640', filePath]);
    }
}

function readEnvFileValue(key, envPath = path.join(CONSOLE_PATH, '.env')) {
    try {
        if (!fs.existsSync(envPath)) return '';
        const prefix = `${key}=`;
        for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
            if (line.startsWith(prefix)) {
                return line.slice(prefix.length).trim();
            }
        }
        return '';
    } catch (_) {
        return '';
    }
}

function isTruthyEnvValue(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'on' || normalized === 'yes';
}

function upsertEnvFileValue(key, value, envPath = path.join(CONSOLE_PATH, '.env')) {
    const prefix = `${key}=`;
    let lines = [];
    if (fs.existsSync(envPath)) {
        lines = fs.readFileSync(envPath, 'utf8').split('\n');
        if (lines.length && lines[lines.length - 1] === '') {
            lines.pop();
        }
    }
    let found = false;
    lines = lines.map((line) => {
        if (line.startsWith(prefix)) {
            found = true;
            return `${key}=${value}`;
        }
        return line;
    });
    if (!found) {
        lines.push(`${key}=${value}`);
    }
    fs.writeFileSync(envPath, `${lines.join('\n')}\n`, 'utf8');
}

function upsertSystemdEnvValue(servicePath, key, value, runFn = runPrivilegedArgv) {
    if (!servicePath || !fs.existsSync(servicePath)) return false;
    const content = isRoot()
        ? fs.readFileSync(servicePath, 'utf8')
        : runFn('cat', [servicePath]);
    const envLine = `Environment=${key}=${value}`;
    let updated;
    if (new RegExp(`^Environment=${key}=`, 'm').test(content)) {
        updated = content.replace(new RegExp(`^Environment=${key}=.*$`, 'm'), envLine);
    } else {
        updated = content.replace(/^(\[Service\]\s*\n)/m, `$1${envLine}\n`);
    }
    if (updated === content) return false;
    if (isRoot()) {
        fs.writeFileSync(servicePath, updated, 'utf8');
    } else {
        const tmp = `/tmp/${CONSOLE_SERVICE}.${Date.now()}.service`;
        fs.writeFileSync(tmp, updated, 'utf8');
        runFn('cp', [tmp, servicePath]);
        try { fs.unlinkSync(tmp); } catch (_) { /* ok */ }
    }
    runFn(resolveSystemctlPath(), ['daemon-reload']);
    return true;
}

function tlsKeyReadableByConsoleUser(keyPath, svcUser = SVC_USER, runFn = runPrivilegedArgv) {
    if (!keyPath || !fs.existsSync(keyPath) || !userExists(svcUser)) {
        return false;
    }
    try {
        if (isRoot()) {
            execFileSync('runuser', ['-u', svcUser, '--', 'test', '-r', keyPath], {
                stdio: 'pipe',
                timeout: 5000,
            });
            return true;
        }
        if (typeof process.getuid === 'function') {
            const uid = execFileSync('id', ['-u', svcUser], {
                encoding: 'utf8',
                stdio: 'pipe',
                timeout: 5000,
            }).trim();
            if (String(process.getuid()) === uid) {
                fs.accessSync(keyPath, fs.constants.R_OK);
                return true;
            }
        }
        runFn('runuser', ['-u', svcUser, '--', 'test', '-r', keyPath]);
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * Infer /etc/letsencrypt/live/<domain> from certificate SAN (#219).
 * @param {string} certPath
 * @returns {string}
 */
function inferLeLiveDirFromCertSan(certPath) {
    if (!certPath || !fs.existsSync(certPath)) return '';
    try {
        const out = execFileSync('openssl', [
            'x509', '-in', certPath, '-noout', '-ext', 'subjectAltName',
        ], { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
        const match = out.match(/DNS:([^,\s]+)/);
        if (!match || !match[1]) return '';
        const candidate = path.join('/etc/letsencrypt/live', match[1]);
        if (fs.existsSync(path.join(candidate, 'fullchain.pem'))
            && fs.existsSync(path.join(candidate, 'privkey.pem'))) {
            return candidate;
        }
    } catch (_) { /* ok */ }
    return '';
}

/**
 * Resolve LE live directory from env / cert path hints (#219).
 * @param {object} opts
 * @returns {string}
 */
function resolveLetsEncryptLiveDir(opts = {}) {
    const envPath = opts.envPath || path.join(CONSOLE_PATH, '.env');
    const sslCertPath = opts.sslCertPath || readEnvFileValue('SSL_CERT_PATH', envPath);
    const sslKeyPath = opts.sslKeyPath || readEnvFileValue('SSL_KEY_PATH', envPath);
    let leLiveDir = opts.leCertLiveDir || readEnvFileValue('LE_CERT_LIVE_DIR', envPath);
    if (!leLiveDir && sslCertPath.includes('/etc/letsencrypt/')) {
        leLiveDir = path.dirname(sslCertPath);
    }
    if (!leLiveDir && sslKeyPath.includes('/etc/letsencrypt/')) {
        leLiveDir = path.dirname(sslKeyPath);
    }
    if (!leLiveDir) {
        const leDomain = opts.leCertDomain || readEnvFileValue('LE_CERT_DOMAIN', envPath);
        if (leDomain) {
            leLiveDir = path.join('/etc/letsencrypt/live', leDomain);
        }
    }
    if (!leLiveDir) {
        leLiveDir = inferLeLiveDirFromCertSan(sslCertPath)
            || inferLeLiveDirFromCertSan(path.join(RUSTDESK_PATH, 'ssl', 'betterdesk.crt'));
    }
    return leLiveDir;
}

/**
 * Whether LE material should be re-copied into $RUSTDESK_PATH/ssl/.
 * @param {object} opts
 * @returns {boolean}
 */
function shouldRedeployLetsEncryptMaterial(opts = {}) {
    if (!isTruthyEnvValue(opts.httpsEnabled)) return false;
    const sslDir = path.join(opts.rustdeskPath || RUSTDESK_PATH, 'ssl');
    const deployedKey = path.join(sslDir, 'betterdesk.key');
    const sslKeyPath = opts.sslKeyPath || deployedKey;
    const sslCertPath = opts.sslCertPath || path.join(sslDir, 'betterdesk.crt');
    if (sslKeyPath.includes('/etc/letsencrypt/') || sslCertPath.includes('/etc/letsencrypt/')) {
        return true;
    }
    if (fs.existsSync(deployedKey)) {
        try {
            if (fs.lstatSync(deployedKey).isSymbolicLink()) {
                const target = fs.realpathSync(deployedKey);
                if (target.includes('/etc/letsencrypt/')) return true;
            }
        } catch (_) { /* ok */ }
    }
    if (opts.keyReadable === false) return true;
    if (opts.keyReadable === true) return false;
    return !tlsKeyReadableByConsoleUser(sslKeyPath, opts.svcUser || SVC_USER, opts.runFn);
}

/**
 * Copy TLS src to dest as a real file; remove dest when it resolves to the same path (#219).
 * @param {string} src
 * @param {string} dest
 * @param {(bin: string, args: string[]) => void} runFn
 */
function safeCopyTlsFile(src, dest, runFn = runPrivilegedArgv) {
    if (!src || !dest || !fs.existsSync(src)) {
        throw new Error(`TLS source missing: ${src || '(empty)'}`);
    }
    let srcReal = src;
    try {
        srcReal = fs.realpathSync(src);
    } catch (_) { /* ok */ }
    if (fs.existsSync(dest)) {
        let destReal = dest;
        try {
            destReal = fs.realpathSync(dest);
        } catch (_) { /* ok */ }
        if (srcReal === destReal) {
            runFn('rm', ['-f', dest]);
        }
    }
    const tmp = `${dest}.betterdesk.${process.pid}.tmp`;
    runFn('cp', ['-L', src, tmp]);
    runFn('mv', ['-f', tmp, dest]);
}

/**
 * Copy LE cert/key into shared ssl dir with console-user permissions (#219).
 * @returns {{ changed: boolean, skipped?: boolean, reason?: string, error?: string }}
 */
function repairLetsEncryptSslMaterial(opts = {}) {
    const rustdeskPath = opts.rustdeskPath || RUSTDESK_PATH;
    const envPath = opts.envPath || path.join(CONSOLE_PATH, '.env');
    const svcUser = opts.svcUser || SVC_USER;
    const runFn = opts.runFn || runPrivilegedArgv;
    const httpsEnabled = opts.httpsEnabled != null
        ? opts.httpsEnabled
        : readEnvFileValue('HTTPS_ENABLED', envPath);

    if (!isTruthyEnvValue(httpsEnabled)) {
        return { changed: false, skipped: true, reason: 'https-not-enabled' };
    }

    const sslDir = path.join(rustdeskPath, 'ssl');
    const deployedCrt = path.join(sslDir, 'betterdesk.crt');
    const deployedKey = path.join(sslDir, 'betterdesk.key');
    const sslKeyPath = readEnvFileValue('SSL_KEY_PATH', envPath) || deployedKey;
    const sslCertPath = readEnvFileValue('SSL_CERT_PATH', envPath) || deployedCrt;
    const keyReadable = tlsKeyReadableByConsoleUser(sslKeyPath, svcUser, runFn);

    if (!shouldRedeployLetsEncryptMaterial({
        httpsEnabled,
        sslKeyPath,
        sslCertPath,
        keyReadable,
        rustdeskPath,
        svcUser,
        runFn,
    })) {
        return { changed: false, skipped: true, reason: 'tls-key-readable' };
    }

    const leLiveDir = resolveLetsEncryptLiveDir({ envPath, sslCertPath, sslKeyPath });
    const leCert = leLiveDir ? path.join(leLiveDir, 'fullchain.pem') : '';
    const leKey = leLiveDir ? path.join(leLiveDir, 'privkey.pem') : '';
    if (!leLiveDir || !fs.existsSync(leCert) || !fs.existsSync(leKey)) {
        if (!keyReadable) {
            return { changed: false, error: 'tls-key-unreadable-no-le-source' };
        }
        return { changed: false, skipped: true, reason: 'no-le-live-dir' };
    }

    if (!isRoot() && !canUseSudo()) {
        return { changed: false, skipped: true, error: 'no root/sudo for LE cert redeploy' };
    }

    try {
        for (const step of getSharedGoDataDirPermissionSteps(rustdeskPath, svcUser)) {
            runFn(step.bin, step.args);
        }
        safeCopyTlsFile(leCert, deployedCrt, runFn);
        safeCopyTlsFile(leKey, deployedKey, runFn);
        runFn('chown', [`root:${svcUser}`, deployedCrt, deployedKey]);
        runFn('chmod', ['640', deployedCrt, deployedKey]);

        upsertEnvFileValue('SSL_CERT_PATH', deployedCrt, envPath);
        upsertEnvFileValue('SSL_KEY_PATH', deployedKey, envPath);
        upsertEnvFileValue('LE_CERT_LIVE_DIR', leLiveDir, envPath);

        const { servicePath } = readServiceFile();
        if (servicePath) {
            upsertSystemdEnvValue(servicePath, 'SSL_CERT_PATH', deployedCrt, runFn);
            upsertSystemdEnvValue(servicePath, 'SSL_KEY_PATH', deployedKey, runFn);
        }

        if (!tlsKeyReadableByConsoleUser(deployedKey, svcUser, runFn)) {
            return { changed: true, error: 'deployed tls key still unreadable by console user' };
        }
        return { changed: true, sslCertPath: deployedCrt, sslKeyPath: deployedKey };
    } catch (err) {
        return { changed: false, error: err.message || String(err) };
    }
}

/**
 * @returns {{ ok: boolean, error?: string, skipped?: boolean }}
 */
function fixSharedPermissions() {
    if (!isRoot() && !canUseSudo()) {
        return { ok: false, skipped: true, error: 'no root/sudo for permission sync' };
    }
    try {
        runPrivilegedArgv('mkdir', ['-p', '/var/lib/betterdesk']);
        runPrivilegedArgv('mkdir', ['-p', path.join(CONSOLE_PATH, 'data')]);
        runPrivilegedArgv('mkdir', ['-p', path.join(CONSOLE_PATH, 'data', 'go-cache', 'mod')]);
        runPrivilegedArgv('mkdir', ['-p', path.join(CONSOLE_PATH, 'data', 'go-cache', 'build')]);
        runPrivilegedArgv('mkdir', ['-p', '/var/lib/betterdesk/.npm']);
        runPrivilegedArgv('chown', ['-R', `${SVC_USER}:${SVC_USER}`, '/var/lib/betterdesk']);
        runPrivilegedArgv('chown', ['-R', `${SVC_USER}:${SVC_USER}`, CONSOLE_PATH]);

        for (const step of getSharedGoDataDirPermissionSteps(RUSTDESK_PATH, SVC_USER)) {
            runPrivilegedArgv(step.bin, step.args);
        }
        for (const filePath of listSharedGoDataFiles(RUSTDESK_PATH)) {
            applySharedGoFilePermissions(filePath, SVC_USER);
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
}

/** @returns {{ ok: boolean, error?: string }} */
function verifyDirWritableByUser(dirPath, label = 'directory') {
    try {
        if (typeof process.getuid === 'function' && process.getuid() === 0) {
            execFileSync('runuser', ['-u', SVC_USER, '--', 'test', '-w', dirPath], {
                stdio: 'pipe',
                timeout: 5000,
            });
        } else if (typeof process.getuid === 'function') {
            const uid = execFileSync('id', ['-u', SVC_USER], {
                encoding: 'utf8',
                stdio: 'pipe',
                timeout: 5000,
            }).trim();
            if (String(process.getuid()) === uid) {
                fs.accessSync(dirPath, fs.constants.W_OK);
            } else {
                return { ok: false, error: `cannot verify ${SVC_USER} access to ${label} from uid ${process.getuid()}` };
            }
        } else {
            fs.accessSync(dirPath, fs.constants.W_OK);
        }
        return { ok: true };
    } catch (_) {
        return { ok: false, error: `${SVC_USER} cannot write ${label} (${dirPath})` };
    }
}

/** Verify the console service user can write console data and Go server data dirs. */
function verifyConsoleUserAccess() {
    if (!userExists(SVC_USER)) {
        return { ok: false, error: `system user ${SVC_USER} does not exist` };
    }
    const dataDir = path.join(CONSOLE_PATH, 'data');
    const dataCheck = verifyDirWritableByUser(dataDir, 'console data');
    if (!dataCheck.ok) return dataCheck;
    return verifyDirWritableByUser(RUSTDESK_PATH, 'Go server data');
}

const VALID_CONSOLE_SERVICE_USERS = new Set(['root', SVC_USER]);

/** @returns {boolean} */
function serviceUserLineIsValid(content) {
    const matches = String(content || '').match(/^User=(.*)$/gm) || [];
    if (matches.length !== 1) return false;
    const user = matches[0].replace(/^User=/, '').trim();
    return VALID_CONSOLE_SERVICE_USERS.has(user);
}

/**
 * Replace malformed User= lines (e.g. stdout pollution from ensure_betterdesk_console_user).
 * @param {string} content
 * @param {string} [wantUser]
 * @returns {{ content: string, changed: boolean }}
 */
function repairInvalidServiceUserLine(content, wantUser = SVC_USER) {
    const unit = String(content || '');
    if (!unit.trim()) {
        return { content: unit, changed: false };
    }
    if (serviceUserLineIsValid(unit)) {
        return { content: unit, changed: false };
    }

    let updated = unit.replace(/^User=.*\n?/gm, '');
    if (/^\[Service\]/m.test(updated)) {
        updated = updated.replace(/^\[Service\]/m, `[Service]\nUser=${wantUser}`);
    } else {
        updated = `User=${wantUser}\n${updated}`;
    }
    return { content: updated, changed: true };
}

function patchServiceUserLine() {
    const { servicePath, content } = readServiceFile();
    if (!servicePath || !content) {
        return { changed: false, reason: 'service unit not found' };
    }

    const envPorts = readConsoleEnvPortSettings(path.join(CONSOLE_PATH, '.env'));
    const needsBindCapability = consoleEnvUsesPrivilegedPorts(envPorts);

    let updated = content;
    let changed = false;

    const userRepair = repairInvalidServiceUserLine(updated, SVC_USER);
    if (userRepair.changed) {
        updated = userRepair.content;
        changed = true;
    } else if (/^User=root/m.test(updated)) {
        updated = updated.replace(/^User=root/m, `User=${SVC_USER}`);
        changed = true;
    }

    if (needsBindCapability) {
        const capPatch = ensureBindCapabilityInServiceUnit(updated);
        updated = capPatch.content;
        changed = changed || capPatch.changed;
    }

    if (!changed) {
        if (serviceUserLineIsValid(content)) {
            return { changed: false, reason: 'User is not root (already patched or custom)' };
        }
        return { changed: false, reason: 'service unit already current' };
    }

    writeServiceFile(servicePath, updated);
    runPrivilegedArgv(resolveSystemctlPath(), ['daemon-reload']);
    const result = { changed: true, user: SVC_USER, servicePath };
    if (userRepair.changed) {
        result.repairedInvalidUser = true;
    }
    if (needsBindCapability) {
        result.bindCapability = true;
    }
    return result;
}

/**
 * @returns {{ changed: boolean, user?: string, changes: string[], warnings?: string[], error?: string, fatal?: boolean, skipped?: boolean, permissionsOk?: boolean }}
 */
function ensureLinuxConsoleServiceUser() {
    const result = { changed: false, changes: [], warnings: [], permissionsOk: false, fatal: false };
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
            const deployScript = ensureDeployScriptExecutable();
            if (deployScript.changed) {
                result.changes.push('server binary deploy helper marked executable');
            } else if (deployScript.error) {
                result.warnings.push(`deploy helper chmod skipped: ${deployScript.error}`);
            }
            const sudoers = ensureConsoleUpdateSudoers();
            if (sudoers.changed) {
                result.changes.push('passwordless sudo for panel updates (services + server binary deploy)');
            } else if (sudoers.reason) {
                result.changes.push(sudoers.reason);
            }
            if (perm.ok) {
                result.permissionsOk = true;
                result.changes.push('permissions synced for betterdesk console user');
            } else if (perm.error) {
                result.fatal = true;
                result.error = perm.error;
            }
            const leRepair = repairLetsEncryptSslMaterial({ runFn: runPrivilegedArgv });
            if (leRepair.changed) {
                result.changes.push("Let's Encrypt TLS material redeployed for console user (#219)");
            } else if (leRepair.error && leRepair.error !== 'no root/sudo for LE cert redeploy') {
                result.warnings.push(`LE TLS repair: ${leRepair.error}`);
            }
        } else if (userExists(SVC_USER)) {
            const access = verifyConsoleUserAccess();
            result.permissionsOk = access.ok;
            if (access.ok) {
                result.changes.push(`${SVC_USER} user present; data dir writable`);
            } else {
                result.changes.push(`${SVC_USER} user present; permission sync skipped (no sudo)`);
                result.fatal = true;
                result.error = access.error || 'permission sync requires root/sudo';
            }
        } else {
            result.fatal = true;
            result.error = `System user ${SVC_USER} is missing and cannot be created without root/sudo`;
        }

        const access = verifyConsoleUserAccess();
        if (access.ok) {
            result.permissionsOk = true;
        } else if (!result.fatal) {
            result.fatal = true;
            result.error = access.error || `console user ${SVC_USER} cannot access required directories`;
        }

        // Repair User= / root→betterdesk when permissions are verified.
        if (result.permissionsOk && privileged) {
            const patch = patchServiceUserLine();
            if (patch.changed) {
                result.changed = true;
                result.user = patch.user;
                if (patch.repairedInvalidUser) {
                    result.changes.push(`repaired invalid console service User=${patch.user} (#219)`);
                } else {
                    result.changes.push(`console service User=${patch.user}`);
                }
                if (patch.bindCapability) {
                    result.changes.push('CAP_NET_BIND_SERVICE added for privileged HTTPS/HTTP ports');
                }
            } else if (patch.reason) {
                result.changes.push(patch.reason);
            }
        } else if (!result.permissionsOk && !result.fatal) {
            result.changes.push('skipped service User= patch until permissions are fixed');
        }
    } catch (err) {
        result.fatal = true;
        result.error = err.message || String(err);
    }
    return result;
}

if (require.main === module) {
    const out = ensureLinuxConsoleServiceUser();
    if (out.warnings && out.warnings.length) {
        for (const w of out.warnings) {
            console.error(`[linux-ensure-console-user] warning: ${w}`);
        }
    }
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.fatal ? 1 : 0);
}

module.exports = {
    ensureLinuxConsoleServiceUser,
    ensureConsoleUpdateSudoers,
    ensureDataDir,
    fixSharedPermissions,
    verifyConsoleUserAccess,
    verifyDirWritableByUser,
    getSharedGoDataDirPermissionSteps,
    listSharedGoDataFiles,
    applySharedGoFilePermissions,
    buildUpdateSudoersContent,
    ensureDeployScriptExecutable,
    resolveSystemctlPath,
    resolveEnsureConsoleUserScriptPath,
    patchServiceUserLine,
    repairInvalidServiceUserLine,
    serviceUserLineIsValid,
    readEnvFileValue,
    isTruthyEnvValue,
    inferLeLiveDirFromCertSan,
    resolveLetsEncryptLiveDir,
    shouldRedeployLetsEncryptMaterial,
    repairLetsEncryptSslMaterial,
    safeCopyTlsFile,
    tlsKeyReadableByConsoleUser,
    upsertEnvFileValue,
    upsertSystemdEnvValue,
    SHARED_GO_DATA_DIR_MODE,
    SHARED_GO_SSL_DIR_MODE,
    SVC_USER,
};
