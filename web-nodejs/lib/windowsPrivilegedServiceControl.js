'use strict';

/**
 * Invoke LocalSystem scheduled task BetterDeskServiceControl so the panel
 * (NT SERVICE\\BetterDeskConsole) can stop/kill/deploy BetterDeskServer.
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const TASK_NAME = 'BetterDeskServiceControl';
const DEFAULT_POLL_MS = 250;
const DEFAULT_TIMEOUT_MS = 120000;

function controlDir(consoleRoot) {
    return path.join(consoleRoot, 'data', 'service-control');
}

function resolveNodePath(deps = {}) {
    if (deps.nodePath) return deps.nodePath;
    try {
        return execFileSync('where', ['node'], {
            encoding: 'utf8',
            timeout: 5000,
            windowsHide: true,
        }).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || process.execPath;
    } catch (_e) {
        return process.execPath;
    }
}

function taskExists(execSyncFn = execSync) {
    try {
        const out = execSyncFn(`schtasks /Query /TN "${TASK_NAME}"`, {
            encoding: 'utf8',
            timeout: 10000,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        return /BetterDeskServiceControl/i.test(String(out || ''));
    } catch (_e) {
        return false;
    }
}

/**
 * Create/update the on-demand SYSTEM task (requires elevation — installer / Admin).
 */
function ensureWindowsServiceControlTask(opts = {}) {
    const consoleRoot = opts.consoleRoot;
    if (!consoleRoot) {
        return { ok: false, error: 'consoleRoot required' };
    }
    const scriptPath = path.join(consoleRoot, 'scripts', 'windows-service-control.js');
    if (!fs.existsSync(scriptPath)) {
        return { ok: false, error: `missing helper script: ${scriptPath}` };
    }

    const nodePath = resolveNodePath(opts);
    const watchDir = controlDir(consoleRoot);
    fs.mkdirSync(watchDir, { recursive: true });

    // /SC ONCE with far-future start — task is only started via /Run.
    const tr = `"${nodePath}" "${scriptPath}" --watch-dir "${watchDir}"`;
    const createCmd = [
        'schtasks', '/Create',
        '/TN', TASK_NAME,
        '/TR', tr,
        '/SC', 'ONCE',
        '/ST', '23:59',
        '/SD', '01/01/2099',
        '/RU', 'SYSTEM',
        '/RL', 'HIGHEST',
        '/F',
    ];

    try {
        execFileSync(createCmd[0], createCmd.slice(1), {
            encoding: 'utf8',
            timeout: 30000,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        return { ok: true, task: TASK_NAME, created: true };
    } catch (err) {
        if (taskExists(opts.execSync || execSync)) {
            return { ok: true, task: TASK_NAME, created: false, warning: err.message };
        }
        return {
            ok: false,
            error: err.message || String(err),
            hint: 'Run Admin PowerShell: betterdesk.ps1 (Update/Repair) or: '
                + `schtasks /Create /TN ${TASK_NAME} ... as SYSTEM`,
        };
    }
}

function sleepSync(ms) {
    const n = Math.max(0, Number(ms) || 0);
    if (n <= 0) return;
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
    } catch (_e) {
        const end = Date.now() + n;
        while (Date.now() < end) { /* spin */ }
    }
}

/**
 * Queue a job for the SYSTEM task and wait for result.json.
 *
 * @returns {{ success: boolean, error?: string, [key: string]: any }}
 */
function runWindowsPrivilegedServiceJob(job, opts = {}) {
    const consoleRoot = opts.consoleRoot;
    if (!consoleRoot) {
        return { success: false, error: 'consoleRoot required' };
    }
    if (process.platform !== 'win32') {
        return { success: false, error: 'Windows only' };
    }

    const ensure = opts.skipEnsure
        ? (taskExists(opts.execSync || execSync) ? { ok: true } : { ok: false, error: 'task missing' })
        : ensureWindowsServiceControlTask({ consoleRoot, nodePath: opts.nodePath, execSync: opts.execSync });

    if (!ensure.ok && !taskExists(opts.execSync || execSync)) {
        return {
            success: false,
            error: ensure.error || 'BetterDeskServiceControl task not installed',
            hint: ensure.hint,
            needTaskInstall: true,
        };
    }

    const dir = controlDir(consoleRoot);
    fs.mkdirSync(dir, { recursive: true });
    const id = `${Date.now()}.${process.pid}`;
    const requestPath = path.join(dir, `req-${id}.json`);
    const resultPath = path.join(dir, `res-${id}.json`);
    const pointerPath = path.join(dir, 'current-request.json');

    const payload = {
        ...job,
        resultPath,
        requestedAt: new Date().toISOString(),
    };
    fs.writeFileSync(requestPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.writeFileSync(pointerPath, `${JSON.stringify({ requestPath, resultPath })}\n`, 'utf8');
    try { fs.unlinkSync(resultPath); } catch (_e) { /* ok */ }

    const exec = opts.execSync || execSync;
    try {
        exec(`schtasks /Run /TN "${TASK_NAME}"`, {
            encoding: 'utf8',
            timeout: 30000,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
    } catch (err) {
        return {
            success: false,
            error: `schtasks /Run failed: ${err.message || err}`,
            hint: 'Install/repair BetterDeskServiceControl as Administrator (betterdesk.ps1 Update)',
            needTaskInstall: true,
        };
    }

    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const pollMs = opts.pollMs || DEFAULT_POLL_MS;
    const sleep = typeof opts.sleep === 'function' ? opts.sleep : sleepSync;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (fs.existsSync(resultPath)) {
            try {
                const raw = fs.readFileSync(resultPath, 'utf8');
                const parsed = JSON.parse(raw);
                return parsed && typeof parsed === 'object'
                    ? parsed
                    : { success: false, error: 'invalid helper result' };
            } catch (err) {
                return { success: false, error: `invalid helper result: ${err.message}` };
            }
        }
        sleep(pollMs);
    }

    return {
        success: false,
        error: `timed out waiting for ${TASK_NAME} (${timeoutMs}ms)`,
        hint: 'Check Task Scheduler history for BetterDeskServiceControl',
    };
}

function privilegedStopService(serviceName, opts = {}) {
    return runWindowsPrivilegedServiceJob({
        action: 'stop',
        service: serviceName || 'BetterDeskServer',
    }, opts);
}

function privilegedStartService(serviceName, opts = {}) {
    return runWindowsPrivilegedServiceJob({
        action: 'start',
        service: serviceName || 'BetterDeskServer',
    }, opts);
}

function privilegedDeployServerBinary(source, target, opts = {}) {
    return runWindowsPrivilegedServiceJob({
        action: 'deploy-server',
        service: opts.service || 'BetterDeskServer',
        source,
        target,
        startAfter: opts.startAfter !== false,
    }, opts);
}

module.exports = {
    TASK_NAME,
    controlDir,
    taskExists,
    ensureWindowsServiceControlTask,
    runWindowsPrivilegedServiceJob,
    privilegedStopService,
    privilegedStartService,
    privilegedDeployServerBinary,
};
