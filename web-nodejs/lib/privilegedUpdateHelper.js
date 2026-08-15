'use strict';

const { execFileSync } = require('child_process');

const PRIVILEGED_UPDATE_HELPER_PATH = '/usr/local/libexec/betterdesk/betterdesk-privileged-update.js';
const ALLOWED_SERVICES = new Set(['betterdesk-console', 'betterdesk-server']);

function isRoot() {
    return typeof process.getuid === 'function' && process.getuid() === 0;
}

function invokePrivilegedUpdate(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Invalid privileged update request');
    }

    const command = isRoot() ? process.execPath : 'sudo';
    const args = isRoot()
        ? [PRIVILEGED_UPDATE_HELPER_PATH]
        : ['-n', process.execPath, PRIVILEGED_UPDATE_HELPER_PATH];

    // The command is fixed; the helper validates the JSON action and service.
    const output = execFileSync(command, args, {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        timeout: 35_000,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const result = JSON.parse(String(output || '').trim() || '{}');
    if (!result.success) {
        throw new Error(result.error || 'Privileged update failed');
    }
    return result;
}

function canUsePrivilegedUpdate() {
    try {
        if (isRoot()) return true;
        const output = execFileSync(
            'sudo',
            ['-n', process.execPath, PRIVILEGED_UPDATE_HELPER_PATH],
            {
                input: JSON.stringify({ action: 'check' }),
                encoding: 'utf8',
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe'],
            },
        );
        return JSON.parse(String(output || '{}')).success === true;
    } catch (_) {
        return false;
    }
}

function restartService(service) {
    if (!ALLOWED_SERVICES.has(service)) {
        throw new Error('Service is not allowlisted');
    }
    return invokePrivilegedUpdate({ action: 'restart', service });
}

function daemonReload() {
    return invokePrivilegedUpdate({ action: 'daemon_reload' });
}

module.exports = {
    PRIVILEGED_UPDATE_HELPER_PATH,
    ALLOWED_SERVICES,
    canUsePrivilegedUpdate,
    daemonReload,
    invokePrivilegedUpdate,
    isRoot,
    restartService,
};
