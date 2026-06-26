#!/usr/bin/env node
'use strict';

/**
 * Privileged Go server binary deploy (issue #182).
 * Invoked via passwordless sudo from the panel update service.
 *
 * Reads a JSON payload from stdin:
 *   { "source": "...", "target": "...", "consoleRoot": "...", "serverSourceRoot": "..." }
 *
 * Or `--check` to verify the caller can run this script via sudo (exit 0).
 */

const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const {
    validateDeployRequest,
    deployServerBinaryAtomic,
    resolveServerSourceRoot,
} = require('../lib/linuxServerBinaryDeploy');

function readStdinPayload() {
    if (process.stdin.isTTY) {
        throw new Error('Expected JSON payload on stdin');
    }
    const data = fs.readFileSync(0, 'utf8').trim();
    if (!data) {
        throw new Error('Empty deploy payload');
    }
    return JSON.parse(data);
}

function runCheck() {
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        throw new Error('Privileged deploy check must run as root (via sudo)');
    }
    process.stdout.write(JSON.stringify({ success: true, mode: 'check' }));
}

function runDeploy(payload) {
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        throw new Error('Deploy must run as root (via sudo)');
    }

    const consoleRoot = payload.consoleRoot || path.join(__dirname, '..');
    const projectRoot = payload.projectRoot || path.join(consoleRoot, '..');
    const serverSourceRoot = payload.serverSourceRoot
        || resolveServerSourceRoot(consoleRoot, projectRoot);

    const validated = validateDeployRequest(payload.source, payload.target, {
        consoleRoot,
        projectRoot,
        serverSourceRoot,
        keysPath: config.keysPath,
        rustdeskDir: config.rustdeskDir,
        extraTarget: process.env.BETTERDESK_SERVER_BINARY || null,
    });

    const result = deployServerBinaryAtomic(validated.sourceReal, validated.targetPath);

    // Running as root — refresh sudoers so panel updates pick up new privileged helpers.
    let sudoersSync = null;
    try {
        const modPath = path.join(__dirname, 'linux-ensure-console-user.js');
        delete require.cache[require.resolve(modPath)];
        sudoersSync = require('./linux-ensure-console-user').ensureConsoleUpdateSudoers();
    } catch (err) {
        sudoersSync = { error: err.message || String(err) };
    }

    process.stdout.write(JSON.stringify({
        success: result.success,
        backupPath: result.backupPath || null,
        error: result.error || null,
        method: 'privileged',
        targetPath: validated.targetPath,
        sudoersSync,
    }));
    if (!result.success) {
        process.exit(1);
    }
}

try {
    if (process.argv.includes('--check')) {
        runCheck();
        process.exit(0);
    }
    runDeploy(readStdinPayload());
} catch (err) {
    process.stdout.write(JSON.stringify({
        success: false,
        error: err.message || String(err),
    }));
    process.exit(1);
}
