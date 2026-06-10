/**
 * BetterDesk Console — Network Monitor Service
 *
 * Server-side service for monitoring network infrastructure:
 * - ICMP Ping checks (availability)
 * - TCP port checks (service availability)
 * - HTTP/HTTPS endpoint health checks
 * - Performance history tracking
 *
 * Targets and their check results are stored via dbAdapter.
 * Periodic checks are driven by a configurable polling loop.
 *
 * @author UNITRONIX
 * @version 1.0.0
 */

'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns');
const { spawn } = require('child_process');
const os = require('os');
const config = require('../config/config');
const { assertSafeResolvedHost, assertSafeMonitoringUrl, SsrfBlockedError } = require('../lib/ssrfGuard');

const MONITOR_OPTS = { allowPrivate: true };

// ---------------------------------------------------------------------------
//  Config
// ---------------------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 60_000;    // 1 minute
const DEFAULT_TIMEOUT_MS       = 5_000;     // 5 seconds
const MAX_HISTORY_ROWS         = 10_000;    // per target
const CLEANUP_INTERVAL_MS      = 3600_000;  // 1 hour

// Security: Strict hostname/IP validation regex
// Matches: IPv4, IPv6, valid domain names (no shell metacharacters)
const VALID_HOST_REGEX = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$|^(?:\d{1,3}\.){3}\d{1,3}$|^(?:[a-fA-F0-9:]+)$/;

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

/**
 * Validate hostname/IP to prevent command injection.
 * @param {string} host - Hostname or IP to validate
 * @returns {boolean} - True if valid and safe
 */
function isValidHost(host) {
    if (!host || typeof host !== 'string') return false;
    if (host.length > 253) return false;
    // Check for shell metacharacters
    if (/[;&|`$(){}[\]<>\\!#*?'"~]/.test(host)) return false;
    // Must match our safe pattern
    return VALID_HOST_REGEX.test(host) || net.isIP(host);
}

/**
 * Resolve hostname to IP address.
 */
function resolveHost(host) {
    return new Promise((resolve, reject) => {
        if (!isValidHost(host)) {
            return reject(new Error('Invalid host format'));
        }
        assertSafeResolvedHost(host, MONITOR_OPTS)
            .then((clean) => {
                dns.lookup(clean, (err, address) => {
                    if (err) return reject(err);
                    resolve(address);
                });
            })
            .catch(reject);
    });
}

/**
 * Ping a host using OS-level ICMP ping.
 * Uses spawn() with array arguments to prevent command injection.
 * Returns { success, rtt_ms, error }
 */
function pingHost(host, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve) => {
        // Security: Validate host format before using in command
        if (!isValidHost(host)) {
            return resolve({ success: false, rtt_ms: null, error: 'Invalid host format' });
        }

        assertSafeResolvedHost(host, MONITOR_OPTS).then(() => {
            const isWin = os.platform() === 'win32';
            const timeoutSec = Math.ceil(timeoutMs / 1000);

            const args = isWin
                ? ['-n', '1', '-w', String(timeoutMs), host]
                : ['-c', '1', '-W', String(timeoutSec), host];

            const start = Date.now();
            const proc = spawn('ping', args, { timeout: timeoutMs + 2000 });

            let stdout = '';

            proc.stdout.on('data', (data) => { stdout += data.toString(); });
            proc.stderr.on('data', () => {});

            proc.on('error', (err) => {
                resolve({ success: false, rtt_ms: null, error: err.message });
            });

            proc.on('close', (code) => {
                const elapsed = Date.now() - start;
                if (code !== 0) {
                    return resolve({ success: false, rtt_ms: null, error: 'Host unreachable' });
                }

                let rtt = null;
                if (isWin) {
                    const m = stdout.match(/time[=<](\d+)ms/i);
                    if (m) rtt = parseInt(m[1], 10);
                } else {
                    const m = stdout.match(/time=(\d+\.?\d*)\s*ms/i);
                    if (m) rtt = parseFloat(m[1]);
                }

                resolve({ success: true, rtt_ms: rtt ?? elapsed, error: null });
            });
        }).catch((err) => {
            const msg = err instanceof SsrfBlockedError ? err.message : err.message;
            resolve({ success: false, rtt_ms: null, error: msg });
        });
    });
}

/**
 * Check if a TCP port is open.
 * Returns { success, rtt_ms, error }
 */
function checkTcpPort(host, port, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve) => {
        if (!isValidHost(host)) {
            return resolve({ success: false, rtt_ms: null, error: 'Invalid host format' });
        }

        assertSafeResolvedHost(host, MONITOR_OPTS).then(() => resolveHost(host)).then((resolvedHost) => {
            const start = Date.now();
            const socket = new net.Socket();

            socket.setTimeout(timeoutMs);

            socket.on('connect', () => {
                const rtt = Date.now() - start;
                socket.destroy();
                resolve({ success: true, rtt_ms: rtt, error: null });
            });

            socket.on('timeout', () => {
                socket.destroy();
                resolve({ success: false, rtt_ms: null, error: 'Connection timeout' });
            });

            socket.on('error', (err) => {
                socket.destroy();
                resolve({ success: false, rtt_ms: null, error: err.message });
            });

            socket.connect(port, resolvedHost);
        }).catch((err) => {
            const msg = err instanceof SsrfBlockedError ? err.message : err.message;
            resolve({ success: false, rtt_ms: null, error: msg });
        });
    });
}

/**
 * Check an HTTP/HTTPS endpoint.
 * Returns { success, rtt_ms, status_code, error }
 */
function checkHttp(url, timeoutMs = DEFAULT_TIMEOUT_MS, expectedStatus = 200) {
    return new Promise((resolve) => {
        assertSafeMonitoringUrl(url).then((parsed) => {
            const start = Date.now();
            const lib = parsed.protocol === 'https:' ? https : http;
            const port = parsed.port
                ? parseInt(parsed.port, 10)
                : (parsed.protocol === 'https:' ? 443 : 80);
            const reqPath = `${parsed.pathname || '/'}${parsed.search || ''}`;

            const req = lib.request({
                protocol: parsed.protocol,
                hostname: parsed.hostname,
                port,
                path: reqPath,
                method: 'GET',
                timeout: timeoutMs,
                rejectUnauthorized: !config.allowSelfSignedCerts,
            }, (res) => {
                const rtt = Date.now() - start;
                res.resume();
                res.on('end', () => {
                    resolve({
                        success: res.statusCode === expectedStatus || (res.statusCode >= 200 && res.statusCode < 400),
                        rtt_ms: rtt,
                        status_code: res.statusCode,
                        error: null,
                    });
                });
            });

            req.on('timeout', () => {
                req.destroy();
                resolve({ success: false, rtt_ms: null, status_code: null, error: 'Timeout' });
            });

            req.on('error', (err) => {
                resolve({ success: false, rtt_ms: null, status_code: null, error: err.message });
            });

            req.end();
        }).catch((err) => {
            const msg = err instanceof SsrfBlockedError ? err.message : err.message;
            resolve({ success: false, rtt_ms: null, status_code: null, error: msg });
        });
    });
}

// ---------------------------------------------------------------------------
//  NetworkMonitor class
// ---------------------------------------------------------------------------

class NetworkMonitor {
    /**
     * @param {Object} dbAdapter — initialized BetterDesk dbAdapter instance
     */
    constructor(dbAdapter) {
        this.db = dbAdapter;
        this.running = false;
        this.timer = null;
        this.pollInterval = DEFAULT_POLL_INTERVAL_MS;
    }

    /**
     * Start the periodic monitoring loop.
     */
    start(intervalMs) {
        if (this.running) return;
        this.pollInterval = intervalMs || DEFAULT_POLL_INTERVAL_MS;
        this.running = true;
        console.log(`[NetworkMonitor] Started with interval ${this.pollInterval}ms`);
        this._poll();
    }

    /**
     * Stop the monitoring loop.
     */
    stop() {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        console.log('[NetworkMonitor] Stopped');
    }

    /**
     * Run a single check for a specific target.
     */
    async checkTarget(target) {
        const { id, check_type, host, port, url, timeout_ms } = target;
        const timeout = timeout_ms || DEFAULT_TIMEOUT_MS;
        let result;

        try {
            switch (check_type) {
                case 'ping':
                    result = await pingHost(host, timeout);
                    break;

                case 'tcp':
                    result = await checkTcpPort(host, port || 80, timeout);
                    break;

                case 'http':
                case 'https':
                    result = await checkHttp(url || `${check_type}://${host}:${port || (check_type === 'https' ? 443 : 80)}`, timeout);
                    break;

                default:
                    result = { success: false, rtt_ms: null, error: `Unknown check type: ${check_type}` };
            }
        } catch (err) {
            result = { success: false, rtt_ms: null, error: err.message };
        }

        // Determine status
        const status = result.success ? 'up' : 'down';

        // Save result to DB
        try {
            await this.db.insertNetworkCheck({
                target_id: id,
                status,
                rtt_ms: result.rtt_ms,
                status_code: result.status_code || null,
                error_msg: result.error,
            });

            // Update target last status
            await this.db.updateNetworkTarget(id, {
                last_status: status,
                last_check_at: new Date().toISOString(),
                last_rtt_ms: result.rtt_ms,
            });
        } catch (dbErr) {
            console.error(`[NetworkMonitor] DB save error for target ${id}:`, dbErr.message);
        }

        return { target_id: id, ...result, status };
    }

    /**
     * Run checks for all enabled targets.
     */
    async checkAll() {
        try {
            const targets = await this.db.getNetworkTargets({ enabled: true });
            if (!targets || targets.length === 0) return [];

            const results = [];
            for (const target of targets) {
                const result = await this.checkTarget(target);
                results.push(result);
            }
            return results;
        } catch (err) {
            console.error('[NetworkMonitor] checkAll error:', err.message);
            return [];
        }
    }

    // --- Internal ---

    async _poll() {
        if (!this.running) return;

        try {
            await this.checkAll();
        } catch (err) {
            console.error('[NetworkMonitor] Poll error:', err.message);
        }

        if (this.running) {
            this.timer = setTimeout(() => this._poll(), this.pollInterval);
        }
    }
}

// ---------------------------------------------------------------------------
//  Exports
// ---------------------------------------------------------------------------

module.exports = {
    NetworkMonitor,
    pingHost,
    checkTcpPort,
    checkHttp,
    resolveHost,
    DEFAULT_POLL_INTERVAL_MS,
    DEFAULT_TIMEOUT_MS,
};
