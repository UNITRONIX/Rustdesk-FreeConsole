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
    const scriptPath = resolveSystemdUnitScriptPath(consoleRoot);
    if (!fs.existsSync(scriptPath)) {
        throw new Error('Systemd unit helper not installed');
    }

    const runOpts = {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
    };

    let out;
    if (isRoot()) {
        out = execFileSync(process.execPath, [scriptPath], runOpts);
    } else {
        out = execFileSync('sudo', ['-n', process.execPath, scriptPath], runOpts);
    }

    const parsed = JSON.parse(String(out || '').trim() || '{}');
    if (!parsed.success) {
        throw new Error(parsed.error || 'Privileged systemd unit operation failed');
    }
    return parsed;
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

    const result = invokeSystemdUnitScript({ action: 'read', path: normalized }, consoleRoot);
    return result.content || '';
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

    invokeSystemdUnitScript({ action: 'write', path: normalized, content }, consoleRoot);
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
