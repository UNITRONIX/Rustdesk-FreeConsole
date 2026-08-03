'use strict';

/**
 * After a panel update the console calls process.exit(0) so the service
 * manager can bring it back. On Windows that only works when NSSM AppExit
 * is Restart — and never when the process was started interactively
 * (visible `npm` / `node` console window). Schedule a detached start so
 * BetterDeskConsole comes back even if AppExit is Exit or the previous
 * process was not service-managed.
 */

const { spawn } = require('child_process');

const DEFAULT_CONSOLE_SERVICE = 'BetterDeskConsole';
const DEFAULT_DELAY_SEC = 3;

/**
 * @param {object} [opts]
 * @param {string} [opts.serviceName]
 * @param {number} [opts.delaySec]  Seconds to wait after spawn before start
 * @param {Function} [opts.spawnFn]  Injectable for tests
 * @returns {{ scheduled: boolean, service: string, delaySec: number, error?: string }}
 */
function scheduleWindowsConsoleServiceStart(opts = {}) {
    const platform = opts.platform || process.platform;
    if (platform !== 'win32') {
        return { scheduled: false, service: '', delaySec: 0 };
    }

    const serviceName = String(opts.serviceName || DEFAULT_CONSOLE_SERVICE).trim() || DEFAULT_CONSOLE_SERVICE;
    const delaySec = Math.max(1, Math.min(30, Number(opts.delaySec) || DEFAULT_DELAY_SEC));
    const spawnFn = typeof opts.spawnFn === 'function' ? opts.spawnFn : spawn;

    // continue clears NSSM restart-throttle pause; start brings the unit up;
    // sc start is a fallback when nssm is missing from PATH for the child.
    const inner = [
        `timeout /t ${delaySec} /nobreak >nul`,
        `nssm continue "${serviceName}" >nul 2>&1`,
        `nssm start "${serviceName}" >nul 2>&1`,
        `sc start "${serviceName}" >nul 2>&1`,
    ].join(' & ');

    try {
        const child = spawnFn('cmd.exe', ['/d', '/s', '/c', inner], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        });
        if (child && typeof child.unref === 'function') {
            child.unref();
        }
        return { scheduled: true, service: serviceName, delaySec };
    } catch (err) {
        return {
            scheduled: false,
            service: serviceName,
            delaySec,
            error: err.message || String(err),
        };
    }
}

/**
 * Ensure NSSM restarts the console when the Node process exits (panel update).
 * @param {object} [deps]
 * @param {Function} [deps.execSync]
 * @param {Function} [deps.execFileSync]
 * @param {string} [deps.serviceName]
 * @returns {{ changed: boolean, changes: string[], error?: string }}
 */
function ensureWindowsConsoleAppExitRestart(deps = {}) {
    const serviceName = deps.serviceName || DEFAULT_CONSOLE_SERVICE;
    const execSync = deps.execSync || require('child_process').execSync;
    const execFileSync = deps.execFileSync || require('child_process').execFileSync;
    const result = { changed: false, changes: [] };

    try {
        let current = '';
        try {
            current = String(execSync(`nssm get "${serviceName}" AppExit Default`, {
                timeout: 10000,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            })).trim();
        } catch (err) {
            current = String((err && err.stdout) || '').trim();
        }

        if (/^Restart$/i.test(current)) {
            return result;
        }

        execFileSync('nssm', ['set', serviceName, 'AppExit', 'Default', 'Restart'], {
            timeout: 10000,
            stdio: 'pipe',
            windowsHide: true,
        });
        result.changed = true;
        result.changes.push(`${serviceName} AppExit Default=Restart`);
        return result;
    } catch (err) {
        result.error = err.message || String(err);
        return result;
    }
}

module.exports = {
    scheduleWindowsConsoleServiceStart,
    ensureWindowsConsoleAppExitRestart,
    DEFAULT_CONSOLE_SERVICE,
};
