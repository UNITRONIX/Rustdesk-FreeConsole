'use strict';

/**
 * SYSTEM-level Windows service control for panel updates.
 *
 * Preferred: NSSM service BetterDeskServiceControl running as LocalSystem with
 *   --watch-loop <console>\data\service-control
 * The panel only writes request JSON into that directory (no schtasks /Run).
 *
 * Legacy: scheduled task BetterDeskServiceControl started via schtasks /Run.
 *
 * Usage:
 *   node windows-service-control.js --request <path.json>
 *   node windows-service-control.js --watch-dir <dir>
 *   node windows-service-control.js --watch-loop <dir>
 */

const fs = require('fs');
const path = require('path');

const {
    stopWindowsNssmService,
    startWindowsNssmService,
} = require('../lib/windowsNssmRestart');

const HEARTBEAT_NAME = 'heartbeat.json';
const POINTER_NAME = 'current-request.json';
const LOCK_NAME = 'processing.lock';

function writeJson(filePath, payload) {
    if (!filePath) return;
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const tmp = `${filePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, 'utf8');
        try {
            fs.renameSync(tmp, filePath);
        } catch (_e) {
            fs.writeFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
            try { fs.unlinkSync(tmp); } catch (_u) { /* ok */ }
        }
    } catch (err) {
        console.error(`[windows-service-control] write failed (${filePath}): ${err.message}`);
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
    if (fs.existsSync(target)) {
        const aside = `${target}.old.${Date.now()}`;
        try {
            fs.renameSync(target, aside);
        } catch (_e) {
            // Running image may refuse rename on some volumes; try overwrite below.
        }
    }
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

    if (action === 'ping') {
        return { success: true, action: 'ping', pid: process.pid };
    }

    throw new Error(`unknown action: ${action || '(empty)'}`);
}

function loadRequest(requestPath) {
    const raw = fs.readFileSync(requestPath, 'utf8');
    return JSON.parse(raw);
}

function resultIsFresh(requestPath, resultPath) {
    if (!resultPath || !fs.existsSync(resultPath) || !fs.existsSync(requestPath)) {
        return false;
    }
    try {
        const reqM = fs.statSync(requestPath).mtimeMs;
        const resM = fs.statSync(resultPath).mtimeMs;
        return resM >= reqM;
    } catch (_e) {
        return false;
    }
}

function processPointer(watchDir) {
    const pointerPath = path.join(watchDir, POINTER_NAME);
    if (!fs.existsSync(pointerPath)) return false;

    let ptr;
    try {
        ptr = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
    } catch (_e) {
        return false;
    }

    const requestPath = ptr.requestPath || ptr.path;
    const resultPath = ptr.resultPath
        || (requestPath ? requestPath.replace(/req-/, 'res-') : null);
    if (!requestPath || !fs.existsSync(requestPath)) return false;
    if (resultIsFresh(requestPath, resultPath)) return false;

    const lockPath = path.join(watchDir, LOCK_NAME);
    try {
        fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' });
    } catch (_e) {
        return false; // another worker
    }

    try {
        const req = loadRequest(requestPath);
        const outPath = req.resultPath || resultPath;
        try {
            const result = handleRequest(req);
            writeJson(outPath, result);
            process.stdout.write(`${JSON.stringify(result)}\n`);
        } catch (err) {
            const failure = { success: false, error: err.message || String(err) };
            writeJson(outPath, failure);
            process.stdout.write(`${JSON.stringify(failure)}\n`);
        }
        return true;
    } finally {
        try { fs.unlinkSync(lockPath); } catch (_e) { /* ok */ }
    }
}

function watchLoop(watchDir) {
    if (!watchDir) {
        throw new Error('--watch-loop requires a directory');
    }
    fs.mkdirSync(watchDir, { recursive: true });
    const heartbeatPath = path.join(watchDir, HEARTBEAT_NAME);
    console.log(`[windows-service-control] watch-loop dir=${watchDir} pid=${process.pid}`);

    const beat = () => {
        writeJson(heartbeatPath, {
            ok: true,
            pid: process.pid,
            at: new Date().toISOString(),
            mode: 'watch-loop',
        });
    };
    beat();
    setInterval(beat, 2000);

    const tick = () => {
        try {
            processPointer(watchDir);
        } catch (err) {
            console.error(`[windows-service-control] tick error: ${err.message}`);
        }
    };
    tick();
    setInterval(tick, 250);
}

function runOnceFromWatchDir(watchDir) {
    const pointer = path.join(watchDir, POINTER_NAME);
    if (!fs.existsSync(pointer)) {
        throw new Error(`missing ${pointer}`);
    }
    const ptr = JSON.parse(fs.readFileSync(pointer, 'utf8'));
    const requestPath = ptr.requestPath || ptr.path;
    if (!requestPath) {
        throw new Error('current-request.json missing requestPath');
    }
    const req = loadRequest(requestPath);
    const resultPath = req.resultPath || ptr.resultPath || path.join(watchDir, 'last-result.json');
    try {
        const result = handleRequest(req);
        writeJson(resultPath, result);
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (err) {
        const failure = { success: false, error: err.message || String(err) };
        writeJson(resultPath, failure);
        process.stdout.write(`${JSON.stringify(failure)}\n`);
        process.exitCode = 1;
    }
}

function main() {
    const args = process.argv.slice(2);
    let requestPath = null;
    let watchDir = null;
    let watchLoopDir = null;
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '--request' && args[i + 1]) {
            requestPath = args[++i];
        } else if (args[i] === '--watch-dir' && args[i + 1]) {
            watchDir = args[++i];
        } else if (args[i] === '--watch-loop' && args[i + 1]) {
            watchLoopDir = args[++i];
        }
    }

    if (watchLoopDir) {
        watchLoop(watchLoopDir);
        return; // keep process alive
    }

    if (watchDir) {
        runOnceFromWatchDir(watchDir);
        return;
    }

    if (!requestPath) {
        throw new Error('usage: windows-service-control.js --request <file> | --watch-dir <dir> | --watch-loop <dir>');
    }

    const req = loadRequest(requestPath);
    const resultPath = req.resultPath || null;
    try {
        const result = handleRequest(req);
        writeJson(resultPath, result);
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (err) {
        const failure = { success: false, error: err.message || String(err) };
        writeJson(resultPath, failure);
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
    processPointer,
    watchLoop,
    HEARTBEAT_NAME,
};
