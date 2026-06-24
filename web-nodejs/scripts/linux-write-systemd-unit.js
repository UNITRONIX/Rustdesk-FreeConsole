#!/usr/bin/env node
'use strict';

/**
 * Privileged read/write for BetterDesk systemd unit files.
 * Invoked via passwordless sudo from the panel update service.
 *
 * Stdin JSON:
 *   { "action": "read", "path": "/etc/systemd/system/betterdesk-server.service" }
 *   { "action": "write", "path": "...", "content": "..." }
 *
 * Or `--check` to verify the caller can run this script via sudo (exit 0).
 */

const fs = require('fs');
const path = require('path');
const {
    isAllowedSystemdUnitPath,
    normalizeUnitPath,
} = require('../lib/linuxSystemdUnitPrivileged');

function readStdinPayload() {
    if (process.stdin.isTTY) {
        throw new Error('Expected JSON payload on stdin');
    }
    const data = fs.readFileSync(0, 'utf8').trim();
    if (!data) {
        throw new Error('Empty payload');
    }
    return JSON.parse(data);
}

function assertRoot() {
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        throw new Error('Systemd unit helper must run as root (via sudo)');
    }
}

function runCheck() {
    assertRoot();
    process.stdout.write(JSON.stringify({ success: true, mode: 'check' }));
}

function runAction(payload) {
    assertRoot();

    const unitPath = normalizeUnitPath(payload.path);
    if (!unitPath || !isAllowedSystemdUnitPath(unitPath)) {
        throw new Error(`Systemd unit path not allowed: ${payload.path}`);
    }

    const action = String(payload.action || '').toLowerCase();
    if (action === 'read') {
        const content = fs.readFileSync(unitPath, 'utf8');
        process.stdout.write(JSON.stringify({ success: true, path: unitPath, content }));
        return;
    }

    if (action === 'write') {
        if (typeof payload.content !== 'string') {
            throw new Error('Write payload requires string content');
        }
        const tmp = `${unitPath}.betterdesk.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, payload.content, { encoding: 'utf8', mode: 0o644 });
        fs.renameSync(tmp, unitPath);
        process.stdout.write(JSON.stringify({ success: true, path: unitPath }));
        return;
    }

    throw new Error(`Unknown action: ${payload.action}`);
}

try {
    if (process.argv.includes('--check')) {
        runCheck();
        process.exit(0);
    }
    runAction(readStdinPayload());
} catch (err) {
    process.stdout.write(JSON.stringify({
        success: false,
        error: err.message || String(err),
    }));
    process.exit(1);
}
