/**
 * BetterDesk Console - Dashboard Routes
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const keyService = require('../services/keyService');
const clientConfigHost = require('../services/clientConfigHost');
const config = require('../config/config');
const serverBackend = require('../services/serverBackend');
const { requireAuth } = require('../middleware/auth');

/**
 * GET / - Dashboard page
 */
router.get('/', requireAuth, (req, res) => {
    res.render('dashboard', {
        title: req.t('nav.dashboard'),
        activePage: 'dashboard'
    });
});

/**
 * GET /api/stats - Get dashboard statistics
 */
router.get('/api/stats', requireAuth, async (req, res) => {
    try {
        // Get device stats (delegates to Go API or local DB based on backend)
        const stats = await serverBackend.getStats();
        
        // Get server health
        const hbbsHealth = await serverBackend.getHealth();
        
        // Get public key info (file or live Go key)
        const publicKey = await keyService.resolvePublicKey();

        res.json({
            success: true,
            data: {
                devices: stats,
                hbbs: hbbsHealth,
                backend: serverBackend.getActiveBackend(),
                publicKey: publicKey ? true : false
            }
        });
    } catch (err) {
        console.error('Stats error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * GET /api/server/status - Get server status
 * In betterdesk mode: probes the Go server /api/health (single binary serves all).
 * In rustdesk mode: probes hbbs (health) + hbbr (TCP connect).
 * Returns a unified shape consumed by dashboard.js.
 */
router.get('/api/server/status', requireAuth, async (req, res) => {
    try {
        const isBD = serverBackend.isBetterDesk();

        // Primary check: always try the API health endpoint
        const hbbsHealth = await serverBackend.getHealth();
        const apiRunning = hbbsHealth && hbbsHealth.status === 'running';

        // In BetterDesk mode, all services run in a single binary.
        // If the API health check passes, signal + relay are also running.
        // Raw TCP probes on signal/relay ports would cause spurious
        // NaCl handshake failure log entries in the Go server.
        let relayStatus = { status: 'unknown' };
        let signalStatus = { status: 'unknown' };

        if (isBD && apiRunning) {
            // Single binary — derive from API health
            relayStatus = { status: 'running' };
            signalStatus = { status: 'running' };
        } else {
            // Legacy rustdesk mode or API unreachable — probe ports individually
            // Secondary check: TCP probe on relay port (21117)
            try {
                const net = require('net');
                relayStatus = await new Promise((resolve) => {
                    const socket = new net.Socket();
                    socket.setTimeout(2000);
                    socket.on('connect', () => { socket.destroy(); resolve({ status: 'running' }); });
                    socket.on('error', () => resolve({ status: 'stopped' }));
                    socket.on('timeout', () => { socket.destroy(); resolve({ status: 'stopped' }); });
                    socket.connect(config.wsProxy.hbbrPort, config.wsProxy.hbbrHost);
                });
            } catch { relayStatus = { status: 'unknown' }; }

            // Signal port probe (21116 TCP)
            try {
                const net = require('net');
                signalStatus = await new Promise((resolve) => {
                    const socket = new net.Socket();
                    socket.setTimeout(2000);
                    socket.on('connect', () => { socket.destroy(); resolve({ status: 'running' }); });
                    socket.on('error', () => resolve({ status: 'stopped' }));
                    socket.on('timeout', () => { socket.destroy(); resolve({ status: 'stopped' }); });
                    socket.connect(config.wsProxy.hbbsPort, config.wsProxy.hbbsHost);
                });
            } catch { signalStatus = { status: 'unknown' }; }
        }

        // Build port map for the UI
        const apiPort = parseInt(new URL(
            isBD ? config.betterdeskApiUrl : config.hbbsApiUrl
        ).port, 10) || config.goApiPort || 21114;

        res.json({
            success: true,
            data: {
                backend: isBD ? 'betterdesk' : 'rustdesk',
                uptime: Math.floor(process.uptime()),
                // Main status indicators
                hbbs: apiRunning ? { status: 'running' } : { status: 'stopped' },
                hbbr: relayStatus,
                signal: signalStatus,
                // Port values
                api_port: apiPort,
                signal_port: config.wsProxy.hbbsPort,
                relay_port: config.wsProxy.hbbrPort,
                nat_port: (config.wsProxy.hbbsPort - 1),      // 21115
                ws_signal_port: (config.wsProxy.hbbsPort + 2), // 21118
                ws_relay_port: (config.wsProxy.hbbrPort + 2),  // 21119
                client_api_port: config.apiEnabled ? config.apiPort : apiPort,
                console_port: config.port                       // 5000
            }
        });
    } catch (err) {
        console.error('Server status error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * GET /api/dashboard/client-config - RustDesk client fields for the dashboard
 */
router.get('/api/dashboard/client-config', requireAuth, async (req, res) => {
    try {
        const queryHost = typeof req.query.host === 'string' ? req.query.host : '';
        const endpoints = clientConfigHost.resolveRustDeskEndpoints(req, queryHost);
        const clientConfig = await keyService.getClientConfig(endpoints);
        const qr = await keyService.getServerConfigQR(endpoints);

        res.json({
            success: true,
            data: {
                ...clientConfig,
                client_server_host: endpoints.host,
                endpoint_sources: endpoints.sources,
                env_override_active: endpoints.env_override_active,
                phone_unreachable_host: clientConfigHost.isPhoneUnreachableHost(endpoints.host),
                qr
            }
        });
    } catch (err) {
        console.error('Dashboard client config error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * GET /api/server/bandwidth - Get relay/bandwidth metrics from Go server
 */
router.get('/api/server/bandwidth', requireAuth, async (req, res) => {
    try {
        const betterdeskApi = require('../services/betterdeskApi');
        const stats = await betterdeskApi.getServerStats();
        if (!stats || !stats.success) {
            return res.json({ success: true, data: { relay_active: 0, total_relayed: 0, bytes_transferred: 0, active_sessions: 0, throttle_hits: 0 } });
        }
        const d = stats.data || {};
        res.json({
            success: true,
            data: {
                relay_active: d.relay_active_sessions || 0,
                total_relayed: d.relay_total_relayed || 0,
                bytes_transferred: d.bandwidth_bytes_transferred || 0,
                active_sessions: d.bandwidth_active_sessions || 0,
                throttle_hits: d.bandwidth_throttle_hits || 0
            }
        });
    } catch (err) {
        console.error('Bandwidth stats error:', err);
        res.json({ success: true, data: { relay_active: 0, total_relayed: 0, bytes_transferred: 0, active_sessions: 0, throttle_hits: 0 } });
    }
});

/**
 * POST /api/sync-status - Sync online status from HBBS API
 */
router.post('/api/sync-status', requireAuth, async (req, res) => {
    try {
        const result = await serverBackend.syncOnlineStatus();
        
        res.json({
            success: true,
            data: result
        });
    } catch (err) {
        console.error('Sync status error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * GET /api/dashboard/activity - Recent activity feed for dashboard
 * Returns last 10 events from audit log (connections, logins, bans)
 */
router.get('/api/dashboard/activity', requireAuth, async (req, res) => {
    try {
        const events = [];
        
        // Try Go server audit endpoint
        try {
            const betterdeskApi = require('../services/betterdeskApi');
            const audit = await betterdeskApi.getAuditEvents(10);
            const entries = audit?.data?.entries || audit?.entries || (Array.isArray(audit?.data) ? audit.data : []);
            for (const entry of entries.slice(0, 10)) {
                events.push({
                    action: entry.action || 'info',
                    action_label: entry.action || 'Event',
                    device_id: entry.peer_id || entry.details?.peer_id || '',
                    details: entry.details?.message || '',
                    timestamp: entry.timestamp || entry.created_at
                });
            }
        } catch {}
        
        // Fallback: recent connections from local DB
        if (events.length === 0) {
            try {
                const conns = await db.getRecentConnections(10);
                for (const c of (conns || [])) {
                    events.push({
                        action: 'conn_start',
                        action_label: 'Connection',
                        device_id: c.peer_id || c.host_id || '',
                        details: '',
                        timestamp: c.created_at || c.timestamp
                    });
                }
            } catch {}
        }
        
        res.json({ success: true, events });
    } catch (err) {
        console.error('Dashboard activity error:', err);
        res.json({ success: true, events: [] });
    }
});

module.exports = router;
