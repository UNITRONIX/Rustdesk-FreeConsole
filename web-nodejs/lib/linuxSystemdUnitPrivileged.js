'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ALLOWED_SYSTEMD_UNITS = new Set([
    '/etc/systemd/system/betterdesk-server.service',
    '/etc/systemd/system/betterdesk-console.service',
]);

function resolveSystemdUnitScriptPath(consoleRoot) {
    return path.join(consoleRoot, 'scripts/linux-write-systemd-unit.js');
}

function normalizeUnitPath(filePath) {
    if (!filePath || typeof filePath !== 'string') return null;
    const trimmed = filePath.trim();
    if (!path.isAbsolute(trimmed)) return null;
    return path.resolve(trimmed);
}

function isAllowedSystemdUnitPath(filePath) {
    const normalized = normalizeUnitPath(filePath);
    if (!normalized) return false;
    try {
        const real = fs.existsSync(normalized) ? fs.realpathSync(normalized) : normalized;
        return ALLOWED_SYSTEMD_UNITS.has(real);
    } catch (_) {
        return ALLOWED_SYSTEMD_UNITS.has(normalized);
    }
}

function isRoot() {
    return typeof process.getuid === 'function' && process.getuid() === 0;
}

function canUsePasswordlessSudo() {
    if (isRoot()) return true;
    try {
        execFileSync('sudo', ['-n', 'true'], { stdio: 'pipe', timeout: 3000 });
        return true;
    } catch (_) {
        return false;
    }
}

function invokeSystemdUnitScript(payload, consoleRoot) {
    void payload;
    void consoleRoot;
    throw new Error(
        'Systemd unit access requires a root maintenance run; '
        + 'the panel must not execute repository scripts as root',
    );
}

function readSystemdUnitPrivileged(filePath, consoleRoot) {
    if (!isAllowedSystemdUnitPath(filePath)) {
        throw new Error(`Systemd unit path not allowed: ${filePath}`);
    }
    const normalized = normalizeUnitPath(filePath);

    try {
        return fs.readFileSync(normalized, 'utf8');
    } catch (err) {
        if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
    }

    throw new Error(
        `Cannot read protected systemd unit as the console user: ${normalized}. `
        + privilegedSystemdUnitHint(),
    );
}

function writeSystemdUnitPrivileged(filePath, content, consoleRoot) {
    if (!isAllowedSystemdUnitPath(filePath)) {
        throw new Error(`Systemd unit path not allowed: ${filePath}`);
    }
    const normalized = normalizeUnitPath(filePath);

    try {
        fs.writeFileSync(normalized, content, { encoding: 'utf8', mode: 0o644 });
        return;
    } catch (err) {
        if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;
    }

    void content;
    throw new Error(
        `Cannot write protected systemd unit as the console user: ${normalized}. `
        + privilegedSystemdUnitHint(),
    );
}

function privilegedSystemdUnitHint() {
    return 'Run once as root: sudo node web-nodejs/scripts/linux-ensure-console-user.js';
}

module.exports = {
    ALLOWED_SYSTEMD_UNITS,
    resolveSystemdUnitScriptPath,
    normalizeUnitPath,
    isAllowedSystemdUnitPath,
    canUsePasswordlessSudo,
    readSystemdUnitPrivileged,
    writeSystemdUnitPrivileged,
    privilegedSystemdUnitHint,
};
