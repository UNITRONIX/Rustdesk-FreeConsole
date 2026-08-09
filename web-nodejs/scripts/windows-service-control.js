'use strict';

/**
 * SYSTEM-level Windows service control for panel updates.
 *
 * Invoked by scheduled task BetterDeskServiceControl (LocalSystem).
 * Reads a request JSON, performs stop/start/deploy, writes result JSON.
 *
 * Usage:
 *   node windows-service-control.js --request <path.json>
 *   node windows-service-control.js --watch-dir <dir>
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const {
    stopWindowsNssmService,
    startWindowsNssmService,
} = require('../lib/windowsNssmRestart');

function writeResult(resultPath, payload) {
    if (!resultPath) return;
    try {
        fs.mkdirSync(path.dirname(resultPath), { recursive: true });
        fs.writeFileSync(resultPath, `${JSON.stringify(payload)}\n`, 'utf8');
    } catch (err) {
        console.error(`[windows-service-control] write result failed: ${err.message}`);
    }
}

function deployBinary(source, target) {
    if (!source || !fs.existsSync(source)) {
        throw new Error(`source binary missing: ${source || '(empty)'}`);
    }
    if (!target) {
        throw new Error('target path required');
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const backupPath = fs.existsSync(target)
        ? `${target}.bak.${Date.now()}`
        : null;
    if (backupPath) {
        fs.copyFileSync(target, backupPath);
    }
    const staging = `${target}.new.${process.pid}.${Date.now()}`;
    fs.copyFileSync(source, staging);
    try {
        fs.renameSync(staging, target);
    } catch (_e) {
        fs.copyFileSync(staging, target);
        try { fs.unlinkSync(staging); } catch (_u) { /* ok */ }
    }
    return { backupPath };
}

function handleRequest(req) {
    const action = String(req.action || '').trim().toLowerCase();
    const service = String(req.service || 'BetterDeskServer').trim();

    if (action === 'stop') {
        const win = stopWindowsNssmService(service, {
            // Running as SYSTEM — force-kill must be allowed.
            allowForceKill: true,
            stopTimeoutMs: req.stopTimeoutMs || 60000,
            forceKillWaitMs: req.forceKillWaitMs || 15000,
        });
        return { success: true, action, service, method: win.method, escalation: win.escalation };
    }

    if (action === 'start') {
        const win = startWindowsNssmService(service, {
            startTimeoutMs: req.startTimeoutMs || 30000,
        });
        return { success: true, action, service, method: win.method };
    }

    if (action === 'deploy-server') {
        const source = req.source;
        const target = req.target;
        // Always force-stop before replacing a running Go binary.
        const stop = stopWindowsNssmService(service, {
            allowForceKill: true,
            stopTimeoutMs: req.stopTimeoutMs || 60000,
            forceKillWaitMs: req.forceKillWaitMs || 15000,
        });
        const deployed = deployBinary(source, target);
        let start = null;
        if (req.startAfter !== false) {
            start = startWindowsNssmService(service, {
                startTimeoutMs: req.startTimeoutMs || 30000,
            });
        }
        return {
            success: true,
            action,
            service,
            stopMethod: stop.method,
            backupPath: deployed.backupPath,
            startMethod: start ? start.method : null,
        };
    }

    if (action === 'stop-both') {
        const server = stopWindowsNssmService('BetterDeskServer', {
            allowForceKill: true,
            stopTimeoutMs: req.stopTimeoutMs || 60000,
            forceKillWaitMs: req.forceKillWaitMs || 15000,
        });
        const consoleStop = stopWindowsNssmService('BetterDeskConsole', {
            allowForceKill: true,
            stopTimeoutMs: req.stopTimeoutMs || 60000,
            forceKillWaitMs: req.forceKillWaitMs || 15000,
        });
        return {
            success: true,
            action,
            serverMethod: server.method,
            consoleMethod: consoleStop.method,
        };
    }

    throw new Error(`unknown action: ${action || '(empty)'}`);
}

function loadRequest(requestPath) {
    const raw = fs.readFileSync(requestPath, 'utf8');
    return JSON.parse(raw);
}

function main() {
    const args = process.argv.slice(2);
    let requestPath = null;
    let watchDir = null;
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '--request' && args[i + 1]) {
            requestPath = args[++i];
        } else if (args[i] === '--watch-dir' && args[i + 1]) {
            watchDir = args[++i];
        }
    }

    if (watchDir) {
        const pointer = path.join(watchDir, 'current-request.json');
        if (!fs.existsSync(pointer)) {
            throw new Error(`missing ${pointer}`);
        }
        const ptr = JSON.parse(fs.readFileSync(pointer, 'utf8'));
        requestPath = ptr.requestPath || ptr.path;
    }

    if (!requestPath) {
        throw new Error('usage: windows-service-control.js --request <file> | --watch-dir <dir>');
    }

    const req = loadRequest(requestPath);
    const resultPath = req.resultPath || (watchDir ? path.join(watchDir, 'last-result.json') : null);

    try {
        const result = handleRequest(req);
        writeResult(resultPath, result);
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (err) {
        const failure = {
            success: false,
            error: err.message || String(err),
        };
        writeResult(resultPath, failure);
        process.stdout.write(`${JSON.stringify(failure)}\n`);
        process.exitCode = 1;
    }
}

if (require.main === module) {
    try {
        main();
    } catch (err) {
        const failure = { success: false, error: err.message || String(err) };
        process.stdout.write(`${JSON.stringify(failure)}\n`);
        process.exit(1);
    }
}

module.exports = {
    handleRequest,
    deployBinary,
};
