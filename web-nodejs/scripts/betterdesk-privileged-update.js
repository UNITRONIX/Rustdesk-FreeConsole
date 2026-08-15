#!/usr/bin/env node
'use strict';

/**
 * Root-owned Linux update broker.
 *
 * This file is copied to /usr/local/libexec/betterdesk by the root installer.
 * The panel must never execute a JavaScript file from its writable application
 * directory as root. Only the fixed, argument-validated service operations
 * below are exposed through sudo.
 */

const fs = require('fs');
const { execFileSync } = require('child_process');

const ALLOWED_SERVICES = new Set(['betterdesk-console', 'betterdesk-server']);
const SYSTEMCTL_PATHS = ['/usr/bin/systemctl', '/bin/systemctl'];
const MAX_PAYLOAD_BYTES = 16 * 1024;

function isRoot() {
    return typeof process.getuid === 'function' && process.getuid() === 0;
}

function systemctlPath() {
    return SYSTEMCTL_PATHS.find((candidate) => fs.existsSync(candidate)) || '/usr/bin/systemctl';
}

function runSystemctl(args) {
    return execFileSync(systemctlPath(), args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
        env: {
            PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
            LANG: 'C',
        },
    });
}

function readPayload() {
    const data = fs.readFileSync(0);
    if (data.length > MAX_PAYLOAD_BYTES) {
        throw new Error('Privileged update payload is too large');
    }
    const parsed = JSON.parse(data.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Invalid privileged update payload');
    }
    return parsed;
}

function handle(payload) {
    if (!isRoot()) {
        throw new Error('Privileged update broker must run as root');
    }

    switch (payload.action) {
        case 'check':
            return { success: true, action: 'check' };
        case 'daemon_reload':
            runSystemctl(['daemon-reload']);
            return { success: true, action: payload.action };
        case 'restart':
            if (!ALLOWED_SERVICES.has(payload.service)) {
                throw new Error('Service is not allowlisted');
            }
            runSystemctl(['restart', payload.service]);
            return { success: true, action: payload.action, service: payload.service };
        default:
            throw new Error('Privileged update action is not allowlisted');
    }
}

try {
    if (process.argv.includes('--check')) {
        process.stdout.write(JSON.stringify(handle({ action: 'check' })));
    } else {
        process.stdout.write(JSON.stringify(handle(readPayload())));
    }
} catch (err) {
    process.stdout.write(JSON.stringify({
        success: false,
        error: err.message || String(err),
    }));
    process.exitCode = 1;
}
