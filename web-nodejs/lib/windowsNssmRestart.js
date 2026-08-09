'use strict';

/**
 * Robust NSSM service stop/start for Windows panel updates.
 *
 * Prefer stop → replace binary → start over bare `nssm restart`.
 * NSSM enters SERVICE_PAUSED while restart-throttling after the monitored
 * app exits too soon (common when the Go binary is swapped under a running
 * service). `nssm restart` then fails with:
 *   Unexpected status SERVICE_PAUSED in response to START control
 *
 * Recovery: clear pause via `nssm continue`, then stop → wait → start, and
 * verify SERVICE_RUNNING.
 *
 * When `nssm stop` leaves the service SERVICE_RUNNING (Go ignoring control /
 * hung accept loop), escalate: `sc stop` → taskkill by PID / Application exe
 * so the panel can replace betterdesk-server.exe without locking / PAUSED wedges.
 */

const path = require('path');

const DEFAULT_POLL_MS = 250;
const DEFAULT_STOP_TIMEOUT_MS = 45000;
const DEFAULT_START_TIMEOUT_MS = 20000;
const DEFAULT_FORCE_KILL_WAIT_MS = 8000;

function sleepSync(ms) {
    const n = Math.max(0, Number(ms) || 0);
    if (n <= 0) return;
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
    } catch (_e) {
        const end = Date.now() + n;
        while (Date.now() < end) { /* spin fallback */ }
    }
}

function normalizeStatus(raw) {
    return String(raw || '').trim().toUpperCase();
}

function isStatusRunning(status) {
    return normalizeStatus(status) === 'SERVICE_RUNNING';
}

function isStatusStopped(status) {
    return normalizeStatus(status) === 'SERVICE_STOPPED';
}

function isStatusPaused(status) {
    return normalizeStatus(status) === 'SERVICE_PAUSED';
}

function extractNssmStdout(err) {
    if (!err) return '';
    if (err.stdout != null) return String(err.stdout);
    // execSync often embeds stderr/stdout in Error.message
    const msg = String(err.message || err);
    const m = msg.match(/SERVICE_[A-Z_]+/);
    return m ? m[0] : '';
}

/**
 * `nssm status` exits non-zero for non-running states; read stdout anyway.
 */
function queryNssmStatus(execSync, serviceName, options = {}) {
    const timeout = options.timeout || 10000;
    try {
        const out = execSync(`nssm status "${serviceName}"`, {
            timeout,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        return normalizeStatus(out);
    } catch (err) {
        const fromStdout = normalizeStatus(extractNssmStdout(err));
        if (fromStdout) return fromStdout;
        throw err;
    }
}

function runNssm(execSync, args, options = {}) {
    const timeout = options.timeout || 30000;
    const cmd = `nssm ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
    try {
        execSync(cmd, {
            timeout,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        return { ok: true, output: '' };
    } catch (err) {
        return {
            ok: false,
            error: err,
            output: extractNssmStdout(err),
            message: err.message || String(err),
        };
    }
}

function waitForNssmStatus(execSync, serviceName, predicate, timeoutMs, sleepFn, pollMs) {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
        try {
            last = queryNssmStatus(execSync, serviceName);
        } catch (_e) {
            last = '';
        }
        if (predicate(last)) return last;
        sleepFn(pollMs);
    }
    return last;
}

function resolveDeps(deps = {}) {
    return {
        execSync: deps.execSync || require('child_process').execSync,
        sleep: typeof deps.sleep === 'function' ? deps.sleep : sleepSync,
        pollMs: deps.pollMs || DEFAULT_POLL_MS,
        stopTimeoutMs: deps.stopTimeoutMs || DEFAULT_STOP_TIMEOUT_MS,
        startTimeoutMs: deps.startTimeoutMs || DEFAULT_START_TIMEOUT_MS,
        forceKillWaitMs: deps.forceKillWaitMs || DEFAULT_FORCE_KILL_WAIT_MS,
        allowForceKill: deps.allowForceKill !== false,
    };
}

/**
 * Parse PID from `sc queryex` output (0 when absent / SERVICE_STOPPED).
 * @param {string} raw
 * @returns {number}
 */
function parseScQueryExPid(raw) {
    const m = String(raw || '').match(/\bPID\s*:\s*(\d+)/i);
    if (!m) return 0;
    const pid = Number.parseInt(m[1], 10);
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
}

function queryServicePid(execSync, serviceName, options = {}) {
    const timeout = options.timeout || 10000;
    try {
        const out = execSync(`sc queryex "${serviceName}"`, {
            timeout,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        return parseScQueryExPid(out);
    } catch (err) {
        const blob = `${extractNssmStdout(err)}\n${err.stdout || ''}\n${err.message || ''}`;
        return parseScQueryExPid(blob);
    }
}

function queryNssmApplication(execSync, serviceName, options = {}) {
    const timeout = options.timeout || 10000;
    try {
        const out = execSync(`nssm get "${serviceName}" Application`, {
            timeout,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        return String(out || '').trim().replace(/^"|"$/g, '');
    } catch (err) {
        const fromOut = String(err.stdout || extractNssmStdout(err) || '').trim();
        return fromOut.replace(/^"|"$/g, '');
    }
}

/**
 * Last-resort stop when NSSM leave the service RUNNING after a graceful stop.
 * Safe for BetterDeskServer updates: kills only the service PID / Application exe.
 *
 * @returns {{ attempted: boolean, methods: string[] }}
 */
function forceKillWindowsServiceProcess(serviceName, d) {
    const methods = [];
    if (!d.allowForceKill) {
        return { attempted: false, methods };
    }

    try {
        d.execSync(`sc stop "${serviceName}"`, {
            timeout: 15000,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        methods.push('sc-stop');
    } catch (_e) {
        methods.push('sc-stop-failed');
    }

    d.sleep(Math.min(1500, d.pollMs * 4));

    const pid = queryServicePid(d.execSync, serviceName);
    if (pid > 0) {
        try {
            d.execSync(`taskkill /F /PID ${pid} /T`, {
                timeout: 15000,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
            methods.push(`taskkill-pid:${pid}`);
        } catch (_e) {
            methods.push(`taskkill-pid-failed:${pid}`);
        }
    }

    const application = queryNssmApplication(d.execSync, serviceName);
    const base = application ? path.basename(application) : '';
    // Only kill known BetterDesk / configured service binaries (never bare "node.exe").
    if (base && /\.exe$/i.test(base) && !/^node\.exe$/i.test(base)) {
        try {
            d.execSync(`taskkill /F /IM "${base}" /T`, {
                timeout: 15000,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
            methods.push(`taskkill-im:${base}`);
        } catch (_e) {
            methods.push(`taskkill-im-failed:${base}`);
        }
    }

    return { attempted: methods.length > 0, methods };
}

function assertServiceName(serviceName) {
    if (!serviceName || typeof serviceName !== 'string') {
        throw new Error('serviceName is required');
    }
}

/**
 * Clear NSSM restart-throttle pause so stop/start can proceed.
 */
function clearPausedIfNeeded(serviceName, d) {
    let status = queryNssmStatus(d.execSync, serviceName);
    if (!isStatusPaused(status)) return status;

    runNssm(d.execSync, ['continue', serviceName]);
    status = waitForNssmStatus(
        d.execSync,
        serviceName,
        (s) => isStatusRunning(s) || isStatusStopped(s),
        Math.min(5000, d.startTimeoutMs),
        d.sleep,
        d.pollMs
    );
    return status;
}

/**
 * Stop an NSSM-managed Windows service (SERVICE_STOPPED).
 *
 * @returns {{ success: true, service: string, method: string, wasAlreadyStopped?: boolean }}
 */
function stopWindowsNssmService(serviceName, deps = {}) {
    assertServiceName(serviceName);
    const d = resolveDeps(deps);

    let status = clearPausedIfNeeded(serviceName, d);

    if (isStatusStopped(status)) {
        return { success: true, service: serviceName, method: 'stop', wasAlreadyStopped: true };
    }

    runNssm(d.execSync, ['stop', serviceName]);
    status = waitForNssmStatus(d.execSync, serviceName, isStatusStopped, d.stopTimeoutMs, d.sleep, d.pollMs);

    if (isStatusPaused(status)) {
        runNssm(d.execSync, ['continue', serviceName]);
        d.sleep(d.pollMs);
        runNssm(d.execSync, ['stop', serviceName]);
        status = waitForNssmStatus(d.execSync, serviceName, isStatusStopped, d.stopTimeoutMs, d.sleep, d.pollMs);
    }

    let method = 'stop';
    if (!isStatusStopped(status) && (isStatusRunning(status) || isStatusPaused(status))) {
        // Graceful NSSM stop ignored the process (common under load during panel
        // updates). Escalate before callers try to overwrite betterdesk-server.exe.
        const forced = forceKillWindowsServiceProcess(serviceName, d);
        if (forced.attempted) {
            method = 'force-stop';
            status = waitForNssmStatus(
                d.execSync,
                serviceName,
                isStatusStopped,
                d.forceKillWaitMs,
                d.sleep,
                d.pollMs
            );
            // NSSM may still report RUNNING briefly after taskkill; ask it to stop again.
            if (!isStatusStopped(status)) {
                runNssm(d.execSync, ['stop', serviceName]);
                status = waitForNssmStatus(
                    d.execSync,
                    serviceName,
                    isStatusStopped,
                    d.forceKillWaitMs,
                    d.sleep,
                    d.pollMs
                );
            }
        }
    }

    if (!isStatusStopped(status)) {
        throw new Error(
            `Service ${serviceName} did not reach SERVICE_STOPPED (status: ${status || 'unknown'})`
        );
    }

    return { success: true, service: serviceName, method };
}

/**
 * Start an NSSM-managed Windows service and verify SERVICE_RUNNING.
 *
 * @returns {{ success: true, service: string, method: string }}
 */
function startWindowsNssmService(serviceName, deps = {}) {
    assertServiceName(serviceName);
    const d = resolveDeps(deps);

    let status = clearPausedIfNeeded(serviceName, d);

    if (isStatusRunning(status)) {
        return { success: true, service: serviceName, method: 'already-running' };
    }

    const start = runNssm(d.execSync, ['start', serviceName]);
    if (!start.ok) {
        const blob = `${start.message} ${start.output}`;
        if (/SERVICE_PAUSED/i.test(blob) || isStatusPaused(queryNssmStatus(d.execSync, serviceName))) {
            runNssm(d.execSync, ['continue', serviceName]);
        } else if (!/already/i.test(blob)) {
            // Retry once after a short wait (pending stop → start race).
            d.sleep(500);
            const retry = runNssm(d.execSync, ['start', serviceName]);
            if (!retry.ok && /SERVICE_PAUSED/i.test(`${retry.message} ${retry.output}`)) {
                runNssm(d.execSync, ['continue', serviceName]);
            } else if (!retry.ok) {
                throw new Error(retry.message || `nssm start "${serviceName}" failed`);
            }
        }
    }

    status = waitForNssmStatus(d.execSync, serviceName, isStatusRunning, d.startTimeoutMs, d.sleep, d.pollMs);
    if (!isStatusRunning(status)) {
        if (isStatusPaused(status)) {
            runNssm(d.execSync, ['continue', serviceName]);
            status = waitForNssmStatus(d.execSync, serviceName, isStatusRunning, d.startTimeoutMs, d.sleep, d.pollMs);
        }
    }

    if (!isStatusRunning(status)) {
        throw new Error(
            `Service ${serviceName} did not reach SERVICE_RUNNING (status: ${status || 'unknown'})`
        );
    }

    return { success: true, service: serviceName, method: 'start' };
}

/**
 * Restart an NSSM-managed Windows service: stop → start (never bare `nssm restart`
 * as the primary path). Recovers from SERVICE_PAUSED.
 *
 * @returns {{ success: true, service: string, method: string }}
 */
function restartWindowsNssmService(serviceName, deps = {}) {
    assertServiceName(serviceName);
    const d = resolveDeps(deps);

    let status;
    try {
        status = queryNssmStatus(d.execSync, serviceName);
    } catch (err) {
        throw err;
    }

    // If stop fails mid-way but service is wedged, fall back to restart+continue.
    try {
        stopWindowsNssmService(serviceName, deps);
    } catch (stopErr) {
        const restart = runNssm(d.execSync, ['restart', serviceName]);
        if (!restart.ok && /SERVICE_PAUSED/i.test(restart.message + restart.output)) {
            runNssm(d.execSync, ['continue', serviceName]);
        }
        status = waitForNssmStatus(
            d.execSync,
            serviceName,
            isStatusRunning,
            d.startTimeoutMs,
            d.sleep,
            d.pollMs
        );
        if (isStatusRunning(status)) {
            return { success: true, service: serviceName, method: 'restart-continue' };
        }
        throw stopErr;
    }

    const started = startWindowsNssmService(serviceName, deps);
    return {
        success: true,
        service: serviceName,
        method: started.method === 'already-running' ? 'stop-start' : 'stop-start',
    };
}

module.exports = {
    restartWindowsNssmService,
    stopWindowsNssmService,
    startWindowsNssmService,
    forceKillWindowsServiceProcess,
    queryNssmStatus,
    queryServicePid,
    parseScQueryExPid,
    isStatusRunning,
    isStatusStopped,
    isStatusPaused,
    normalizeStatus,
    sleepSync,
};
