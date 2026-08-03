'use strict';

/**
 * Robust NSSM service restart for Windows panel updates.
 *
 * NSSM enters SERVICE_PAUSED while restart-throttling after the monitored
 * app exits too soon (common when the Go binary is swapped under a running
 * service). `nssm restart` then fails with:
 *   Unexpected status SERVICE_PAUSED in response to START control
 *
 * Recovery: clear pause via `nssm continue`, then stop → wait → start, and
 * verify SERVICE_RUNNING.
 */

const DEFAULT_POLL_MS = 250;
const DEFAULT_STOP_TIMEOUT_MS = 20000;
const DEFAULT_START_TIMEOUT_MS = 20000;

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

/**
 * Restart an NSSM-managed Windows service, recovering from SERVICE_PAUSED.
 *
 * @param {string} serviceName
 * @param {object} [deps]
 * @param {Function} [deps.execSync]
 * @param {Function} [deps.sleep]
 * @param {number} [deps.pollMs]
 * @param {number} [deps.stopTimeoutMs]
 * @param {number} [deps.startTimeoutMs]
 * @returns {{ success: true, service: string, method: string }}
 */
function restartWindowsNssmService(serviceName, deps = {}) {
    if (!serviceName || typeof serviceName !== 'string') {
        throw new Error('serviceName is required');
    }

    const execSync = deps.execSync || require('child_process').execSync;
    const sleep = typeof deps.sleep === 'function' ? deps.sleep : sleepSync;
    const pollMs = deps.pollMs || DEFAULT_POLL_MS;
    const stopTimeoutMs = deps.stopTimeoutMs || DEFAULT_STOP_TIMEOUT_MS;
    const startTimeoutMs = deps.startTimeoutMs || DEFAULT_START_TIMEOUT_MS;

    let status = queryNssmStatus(execSync, serviceName);

    // NSSM throttle: Continue cancels the delay and starts the app immediately.
    if (isStatusPaused(status)) {
        runNssm(execSync, ['continue', serviceName]);
        status = waitForNssmStatus(
            execSync,
            serviceName,
            (s) => isStatusRunning(s) || isStatusStopped(s),
            Math.min(5000, startTimeoutMs),
            sleep,
            pollMs
        );
        if (isStatusRunning(status)) {
            // Still stop/start so a freshly deployed binary is loaded.
            // Fall through unless caller only needed a wake — always reload.
        }
    }

    // Prefer stop → start over `nssm restart` (fragile when already PAUSED).
    runNssm(execSync, ['stop', serviceName]);
    status = waitForNssmStatus(execSync, serviceName, isStatusStopped, stopTimeoutMs, sleep, pollMs);

    if (isStatusPaused(status)) {
        runNssm(execSync, ['continue', serviceName]);
        sleep(pollMs);
        runNssm(execSync, ['stop', serviceName]);
        status = waitForNssmStatus(execSync, serviceName, isStatusStopped, stopTimeoutMs, sleep, pollMs);
    }

    if (!isStatusStopped(status) && !isStatusRunning(status)) {
        // Last resort: classic restart, then recover pause.
        const restart = runNssm(execSync, ['restart', serviceName]);
        if (!restart.ok && /SERVICE_PAUSED/i.test(restart.message + restart.output)) {
            runNssm(execSync, ['continue', serviceName]);
        }
        status = waitForNssmStatus(execSync, serviceName, isStatusRunning, startTimeoutMs, sleep, pollMs);
        if (isStatusRunning(status)) {
            return { success: true, service: serviceName, method: 'restart-continue' };
        }
        throw new Error(
            `Command failed: nssm restart "${serviceName}" `
            + `${serviceName}: Unexpected status ${status || 'SERVICE_PAUSED'} in response to START control.`
        );
    }

    const start = runNssm(execSync, ['start', serviceName]);
    if (!start.ok) {
        const blob = `${start.message} ${start.output}`;
        if (/SERVICE_PAUSED/i.test(blob) || isStatusPaused(queryNssmStatus(execSync, serviceName))) {
            runNssm(execSync, ['continue', serviceName]);
        } else if (!/already/i.test(blob)) {
            // Retry once after a short wait (pending stop → start race).
            sleep(500);
            const retry = runNssm(execSync, ['start', serviceName]);
            if (!retry.ok && /SERVICE_PAUSED/i.test(`${retry.message} ${retry.output}`)) {
                runNssm(execSync, ['continue', serviceName]);
            } else if (!retry.ok) {
                throw new Error(retry.message || `nssm start "${serviceName}" failed`);
            }
        }
    }

    status = waitForNssmStatus(execSync, serviceName, isStatusRunning, startTimeoutMs, sleep, pollMs);
    if (!isStatusRunning(status)) {
        // One more continue pass for throttle after a crash-loop exit.
        if (isStatusPaused(status)) {
            runNssm(execSync, ['continue', serviceName]);
            status = waitForNssmStatus(execSync, serviceName, isStatusRunning, startTimeoutMs, sleep, pollMs);
        }
    }

    if (!isStatusRunning(status)) {
        throw new Error(
            `Service ${serviceName} did not reach SERVICE_RUNNING (status: ${status || 'unknown'})`
        );
    }

    return { success: true, service: serviceName, method: 'stop-start' };
}

module.exports = {
    restartWindowsNssmService,
    queryNssmStatus,
    isStatusRunning,
    isStatusStopped,
    isStatusPaused,
    normalizeStatus,
    sleepSync,
};
