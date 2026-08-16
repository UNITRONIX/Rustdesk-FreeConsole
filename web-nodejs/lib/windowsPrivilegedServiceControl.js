'use strict';

/**
 * Ask LocalSystem BetterDeskServiceControl to stop/kill/deploy BetterDeskServer.
 *
 * Preferred path: persistent NSSM service in --watch-loop mode. The panel only
 * writes request JSON under data/service-control (writable by BetterDeskConsole).
 * No schtasks /Run — that often fails for NT SERVICE\BetterDeskConsole.
 *
 * Legacy fallback: on-demand scheduled task via schtasks /Run.
 */

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const TASK_NAME = 'BetterDeskServiceControl';
const SERVICE_NAME = 'BetterDeskServiceControl';
const DEFAULT_POLL_MS = 250;
const DEFAULT_TIMEOUT_MS = 120000;
const HEARTBEAT_MAX_AGE_MS = 15000;

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

function serviceExists(execSyncFn = execSync) {
    try {
        const out = execSyncFn(`sc query "${SERVICE_NAME}"`, {
            encoding: 'utf8',
            timeout: 10000,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        return /SERVICE_NAME:\s*BetterDeskServiceControl/i.test(String(out || ''))
            || /STATE\s*:/i.test(String(out || ''));
    } catch (err) {
        const blob = `${err.stdout || ''}\n${err.message || ''}`;
        // sc query prints STATE even on some non-zero exits when service exists
        return /SERVICE_NAME:\s*BetterDeskServiceControl/i.test(blob)
            || /STATE\s*:/i.test(blob);
    }
}

function readHeartbeat(consoleRoot) {
    const hbPath = path.join(controlDir(consoleRoot), 'heartbeat.json');
    try {
        if (!fs.existsSync(hbPath)) return null;
        const raw = fs.readFileSync(hbPath, 'utf8');
        const parsed = JSON.parse(raw);
        const at = parsed && parsed.at ? Date.parse(parsed.at) : 0;
        const ageMs = Number.isFinite(at) ? (Date.now() - at) : Number.POSITIVE_INFINITY;
        return {
            ...parsed,
            ageMs,
            fresh: ageMs >= 0 && ageMs <= HEARTBEAT_MAX_AGE_MS,
            path: hbPath,
        };
    } catch (_e) {
        return null;
    }
}

function isWatchLoopAlive(consoleRoot) {
    const hb = readHeartbeat(consoleRoot);
    return !!(hb && hb.fresh);
}

/**
 * Best-effort: create legacy scheduled task (Admin). Prefer NSSM watcher from betterdesk.ps1.
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

    const watchDir = controlDir(consoleRoot);
    fs.mkdirSync(watchDir, { recursive: true });

    if (isWatchLoopAlive(consoleRoot) || serviceExists(opts.execSync || execSync)) {
        return {
            ok: true,
            task: SERVICE_NAME,
            mode: isWatchLoopAlive(consoleRoot) ? 'watch-loop' : 'service',
            created: false,
        };
    }

    if (taskExists(opts.execSync || execSync)) {
        return { ok: true, task: TASK_NAME, mode: 'schtasks', created: false };
    }

    const nodePath = resolveNodePath(opts);
    // Legacy one-shot task (watch-dir). New installs use NSSM --watch-loop via betterdesk.ps1.
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
        return { ok: true, task: TASK_NAME, mode: 'schtasks', created: true };
    } catch (err) {
        if (taskExists(opts.execSync || execSync) || serviceExists(opts.execSync || execSync)) {
            return { ok: true, task: TASK_NAME, created: false, warning: err.message };
        }
        return {
            ok: false,
            error: err.message || String(err),
            needTaskInstall: true,
            hint: 'Admin PowerShell once: betterdesk.ps1 → Update (installs BetterDeskServiceControl SYSTEM watcher service)',
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

function tryStartHelper(opts = {}) {
    const exec = opts.execSync || execSync;
    const tried = [];

    // Persistent NSSM/service watcher — just ensure it is running.
    if (serviceExists(exec)) {
        try {
            exec(`sc start "${SERVICE_NAME}"`, {
                encoding: 'utf8',
                timeout: 30000,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
            tried.push('sc-start');
        } catch (_e) {
            tried.push('sc-start-failed');
        }
        // Give heartbeat a moment to appear.
        const sleep = typeof opts.sleep === 'function' ? opts.sleep : sleepSync;
        for (let i = 0; i < 20; i += 1) {
            if (isWatchLoopAlive(opts.consoleRoot)) {
                return { ok: true, method: 'watch-loop', tried };
            }
            sleep(250);
        }
    }

    // Legacy scheduled task.
    if (taskExists(exec)) {
        try {
            exec(`schtasks /Run /TN "${TASK_NAME}"`, {
                encoding: 'utf8',
                timeout: 30000,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
            return { ok: true, method: 'schtasks', tried: tried.concat(['schtasks-run']) };
        } catch (err) {
            return {
                ok: false,
                method: 'schtasks',
                tried: tried.concat(['schtasks-run-failed']),
                error: `schtasks /Run failed: ${err.message || err}`,
                needTaskInstall: true,
                hint: 'Admin once: betterdesk.ps1 → Update (registers BetterDeskServiceControl as SYSTEM watcher — panel no longer needs schtasks /Run)',
            };
        }
    }

    return {
        ok: false,
        tried,
        error: 'BetterDeskServiceControl watcher not installed',
        needTaskInstall: true,
        hint: 'Admin PowerShell once: betterdesk.ps1 → Update (or Repair services). Installs LocalSystem watcher so panel updates can stop/deploy BetterDeskServer.',
    };
}

/**
 * Queue a job for the SYSTEM helper and wait for result.json.
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

    if (!opts.skipEnsure) {
        ensureWindowsServiceControlTask({
            consoleRoot,
            nodePath: opts.nodePath,
            execSync: opts.execSync,
        });
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

    const alive = isWatchLoopAlive(consoleRoot);
    if (!alive) {
        const started = tryStartHelper({ ...opts, consoleRoot });
        if (!started.ok && !isWatchLoopAlive(consoleRoot)) {
            // schtasks /Run may still process the pointer asynchronously
            if (!(started.method === 'schtasks' && started.ok !== false && !started.error)) {
                if (started.error && started.method !== 'schtasks') {
                    return {
                        success: false,
                        error: started.error,
                        hint: started.hint,
                        needTaskInstall: true,
                        tried: started.tried,
                    };
                }
                if (started.error) {
                    // Continue polling briefly in case Run actually queued
                }
            }
        }
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

    const hb = readHeartbeat(consoleRoot);
    return {
        success: false,
        error: `timed out waiting for ${SERVICE_NAME} (${timeoutMs}ms)`
            + (hb && hb.fresh ? '' : ' — watcher heartbeat missing'),
        hint: hb && hb.fresh
            ? 'Watcher is alive but did not process the job — check BetterDeskServiceControl logs'
            : 'Admin PowerShell once: betterdesk.ps1 → Update (installs BetterDeskServiceControl SYSTEM watcher)',
        needTaskInstall: !(hb && hb.fresh),
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
    SERVICE_NAME,
    HEARTBEAT_MAX_AGE_MS,
    controlDir,
    taskExists,
    serviceExists,
    readHeartbeat,
    isWatchLoopAlive,
    ensureWindowsServiceControlTask,
    tryStartHelper,
    runWindowsPrivilegedServiceJob,
    privilegedStopService,
    privilegedStartService,
    privilegedDeployServerBinary,
};
