'use strict';

/**
 * Bring the Windows web console back after panel update / restore exits Node.
 *
 * Two run modes:
 * 1) NSSM service (`BETTERDESK_SERVICE=1` or no TTY): rely on AppExit=Restart
 *    and a best-effort detached `nssm start` (may Access Denied under least privilege).
 * 2) Interactive `npm` / `node` window (TTY): NSSM cannot revive that process —
 *    spawn a detached `node server.js` before exit so the panel comes back.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_CONSOLE_SERVICE = 'BetterDeskConsole';
const DEFAULT_DELAY_SEC = 3;
const SERVICE_ENV_FLAG = 'BETTERDESK_SERVICE';

/**
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {boolean|null} [opts.stdoutIsTTY]
 * @param {boolean|null} [opts.stderrIsTTY]
 * @param {string} [opts.platform]
 */
function isWindowsConsoleServiceContext(opts = {}) {
    const platform = opts.platform || process.platform;
    if (platform !== 'win32') return false;

    const env = opts.env || process.env;
    if (String(env[SERVICE_ENV_FLAG] || '').trim() === '1') return true;
    if (String(env.BETTERDESK_CONSOLE_SERVICE || '').trim() === '1') return true;

    const stdoutIsTTY = opts.stdoutIsTTY !== undefined
        ? opts.stdoutIsTTY
        : !!(process.stdout && process.stdout.isTTY);
    const stderrIsTTY = opts.stderrIsTTY !== undefined
        ? opts.stderrIsTTY
        : !!(process.stderr && process.stderr.isTTY);

    // Visible npm/node consoles are interactive; NSSM usually redirects logs (no TTY).
    if (stdoutIsTTY || stderrIsTTY) return false;
    return true;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.serviceName]
 * @param {number} [opts.delaySec]
 * @param {Function} [opts.spawnFn]
 * @param {string} [opts.platform]
 */
function scheduleWindowsConsoleServiceStart(opts = {}) {
    const platform = opts.platform || process.platform;
    if (platform !== 'win32') {
        return { scheduled: false, service: '', delaySec: 0 };
    }

    const serviceName = String(opts.serviceName || DEFAULT_CONSOLE_SERVICE).trim() || DEFAULT_CONSOLE_SERVICE;
    const delaySec = Math.max(1, Math.min(30, Number(opts.delaySec) || DEFAULT_DELAY_SEC));
    const spawnFn = typeof opts.spawnFn === 'function' ? opts.spawnFn : spawn;

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
        if (child && typeof child.unref === 'function') child.unref();
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
 * Spawn a replacement Node console process (interactive installs).
 * Delayed so the parent can release the listen port before the child binds.
 * @param {object} [opts]
 * @param {string} [opts.consoleRoot]
 * @param {string} [opts.nodePath]
 * @param {number} [opts.delaySec]
 * @param {Function} [opts.spawnFn]
 * @param {string} [opts.platform]
 * @param {NodeJS.ProcessEnv} [opts.env]
 */
function spawnDetachedConsoleProcess(opts = {}) {
    const platform = opts.platform || process.platform;
    if (platform !== 'win32') {
        return { spawned: false };
    }

    const consoleRoot = path.resolve(opts.consoleRoot || path.join(__dirname, '..'));
    const serverJs = path.join(consoleRoot, 'server.js');
    if (!fs.existsSync(serverJs)) {
        return { spawned: false, error: `server.js not found at ${serverJs}` };
    }

    const nodePath = opts.nodePath || process.execPath;
    const delaySec = Math.max(1, Math.min(30, Number(opts.delaySec) || DEFAULT_DELAY_SEC));
    const spawnFn = typeof opts.spawnFn === 'function' ? opts.spawnFn : spawn;
    const env = { ...(opts.env || process.env) };
    delete env[SERVICE_ENV_FLAG];
    delete env.BETTERDESK_CONSOLE_SERVICE;

    // Quote paths for cmd.exe; delay avoids EADDRINUSE while parent still listens.
    const quotedNode = `"${String(nodePath).replace(/"/g, '')}"`;
    const quotedJs = `"${String(serverJs).replace(/"/g, '')}"`;
    const inner = `timeout /t ${delaySec} /nobreak >nul & ${quotedNode} ${quotedJs}`;

    try {
        const child = spawnFn('cmd.exe', ['/d', '/s', '/c', inner], {
            detached: true,
            stdio: 'ignore',
            cwd: consoleRoot,
            env,
            windowsHide: true,
        });
        if (child && typeof child.unref === 'function') child.unref();
        return { spawned: true, serverJs, delaySec, pid: child && child.pid };
    } catch (err) {
        return { spawned: false, error: err.message || String(err) };
    }
}

/**
 * Ensure NSSM restarts the console when the Node process exits.
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

/**
 * Ensure NSSM console env marks the process as service-managed.
 */
function ensureWindowsConsoleServiceEnvFlag(deps = {}) {
    const serviceName = deps.serviceName || DEFAULT_CONSOLE_SERVICE;
    const execSync = deps.execSync || require('child_process').execSync;
    const execFileSync = deps.execFileSync || require('child_process').execFileSync;
    const result = { changed: false, changes: [] };

    try {
        let envRaw = '';
        try {
            envRaw = String(execSync(`nssm get "${serviceName}" AppEnvironmentExtra`, {
                timeout: 10000,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            }));
        } catch (err) {
            envRaw = String((err && err.stdout) || '');
        }

        const normalized = envRaw.replace(/\r\n/g, '\n');
        if (new RegExp(`^${SERVICE_ENV_FLAG}=1\\s*$`, 'm').test(normalized)) {
            return result;
        }

        const trimmed = normalized.replace(/\n+$/, '');
        const next = trimmed ? `${trimmed}\n${SERVICE_ENV_FLAG}=1` : `${SERVICE_ENV_FLAG}=1`;
        execFileSync('nssm', ['set', serviceName, 'AppEnvironmentExtra', next], {
            timeout: 10000,
            stdio: 'pipe',
            windowsHide: true,
        });
        result.changed = true;
        result.changes.push(`${serviceName} ${SERVICE_ENV_FLAG}=1`);
        return result;
    } catch (err) {
        result.error = err.message || String(err);
        return result;
    }
}

/**
 * Choose interactive re-exec vs NSSM restart, then caller should process.exit(0).
 * @param {object} [opts]
 * @param {string} [opts.consoleRoot]
 * @param {string} [opts.reason]
 */
function prepareWindowsConsoleRestart(opts = {}) {
    const platform = opts.platform || process.platform;
    const out = {
        mode: 'none',
        serviceContext: false,
        appExit: null,
        serviceEnv: null,
        scheduled: null,
        reexec: null,
    };

    if (platform !== 'win32') return out;

    out.serviceContext = isWindowsConsoleServiceContext(opts);

    if (out.serviceContext) {
        out.mode = 'service';
        out.appExit = ensureWindowsConsoleAppExitRestart(opts);
        out.serviceEnv = ensureWindowsConsoleServiceEnvFlag(opts);
        out.scheduled = scheduleWindowsConsoleServiceStart(opts);

        // If we cannot touch NSSM (Access Denied) and AppExit may still be Exit,
        // fall back to spawning a replacement process so the panel recovers.
        const appExitDenied = out.appExit && out.appExit.error
            && /access is denied|OpenService/i.test(out.appExit.error);
        const alreadyRestart = out.appExit && !out.appExit.changed && !out.appExit.error;
        if (appExitDenied && !alreadyRestart) {
            out.reexec = spawnDetachedConsoleProcess(opts);
            if (out.reexec.spawned) out.mode = 'service-fallback-reexec';
        }
        return out;
    }

    out.mode = 'interactive-reexec';
    out.reexec = spawnDetachedConsoleProcess(opts);
    return out;
}

module.exports = {
    scheduleWindowsConsoleServiceStart,
    ensureWindowsConsoleAppExitRestart,
    ensureWindowsConsoleServiceEnvFlag,
    spawnDetachedConsoleProcess,
    isWindowsConsoleServiceContext,
    prepareWindowsConsoleRestart,
    DEFAULT_CONSOLE_SERVICE,
    SERVICE_ENV_FLAG,
};
