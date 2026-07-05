/**
 * BetterDesk Console — Real-time Device Status Push
 *
 * Connects to Go server's WebSocket event bus and pushes device status
 * changes to browser clients in real time.
 *
 * Go server endpoint: GET /api/ws/events
 * Browser endpoint:   WS /ws/device-status
 */

'use strict';

const WebSocket = require('ws');
const db = require('./database');

const log = {
    info:  (...a) => console.log('[DeviceStatus]', ...a),
    warn:  (...a) => console.warn('[DeviceStatus]', ...a),
    error: (...a) => console.error('[DeviceStatus]', ...a),
};

const PING_INTERVAL = 30000;
const RECONNECT_BASE = 3000;
const RECONNECT_MAX = 60000;

/**
 * Initialize real-time device status push.
 * @param {import('http').Server} httpServer - The HTTP server to attach WS to
 * @param {Function} sessionMiddleware - Express session middleware for auth
 * @param {string} goApiUrl - Go server base URL (e.g. http://localhost:21121/api)
 * @param {string} apiKey - API key for Go server authentication
 */
function initDeviceStatusPush(httpServer, sessionMiddleware, goApiUrl, apiKey) {
    // Browser-facing WebSocket server
    const wss = new WebSocket.Server({ noServer: true });
    const clients = new Set();

    // Handle upgrade requests
    httpServer.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (url.pathname !== '/ws/device-status') return;

        // Authenticate via session
        sessionMiddleware(req, {}, () => {
            if (!req.session || !req.session.userId) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }
            wss.handleUpgrade(req, socket, head, (ws) => {
                wss.emit('connection', ws, req);
            });
        });
    });

    wss.on('connection', (ws) => {
        clients.add(ws);

        // Ping to keep alive
        const pingTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.ping();
            else clearInterval(pingTimer);
        }, PING_INTERVAL);

        ws.on('close', () => {
            clients.delete(ws);
            clearInterval(pingTimer);
        });

        ws.on('error', () => {
            clients.delete(ws);
            clearInterval(pingTimer);
        });
    });

    // Broadcast to all connected browser clients
    function broadcast(data) {
        const text = JSON.stringify(data);
        for (const ws of clients) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(text);
            }
        }
    }

    // Connect to Go server event bus
    let retryDelay = RECONNECT_BASE;

    function connectToGoEventBus() {
        const wsUrl = goApiUrl
            .replace(/^http:/, 'ws:')
            .replace(/^https:/, 'wss:')
            .replace(/\/api$/, '');

        const url = `${wsUrl}/api/ws/events?api_key=${encodeURIComponent(apiKey)}`;

        log.info('Connecting to Go event bus...');

        // Only set TLS options when connecting via wss://
        const wsOpts = { headers: { 'X-API-Key': apiKey } };
        if (wsUrl.startsWith('wss://')) {
            wsOpts.rejectUnauthorized = !require('../config/config').allowSelfSignedCerts;
        }

        const goWs = new WebSocket(url, wsOpts);

        goWs.on('open', () => {
            log.info('Connected to Go event bus');
            retryDelay = RECONNECT_BASE;
        });

        goWs.on('message', (data) => {
            try {
                const event = JSON.parse(data.toString());
                const payload = event.data || {};

                if (event.type === 'peer_id_changed') {
                    const oldId = payload.old_id;
                    const newId = payload.new_id;
                    if (oldId && newId && typeof db.cascadePeerIdChange === 'function') {
                        Promise.resolve(db.cascadePeerIdChange(oldId, newId)).catch((err) => {
                            log.warn('Panel ID cascade failed:', err.message || err);
                        });
                    }
                    broadcast({
                        type: 'device_id_changed',
                        old_id: oldId,
                        new_id: newId,
                        source: payload.source || '',
                        timestamp: event.timestamp || Date.now(),
                    });
                    return;
                }

                // Forward peer status events to browser clients
                if (event.type === 'peer_online' || event.type === 'peer_offline' ||
                    event.type === 'peer_status_changed' || event.type === 'peer_registered') {
                    broadcast({
                        type: 'device_status',
                        device_id: payload.peer_id || payload.id || event.peer_id || event.id || event.device_id,
                        status: payload.status || event.status || (event.type === 'peer_online' ? 'online' : 'offline'),
                        timestamp: event.timestamp || Date.now(),
                        details: event,
                    });
                }
            } catch (_) {
                // Ignore unparseable frames
            }
        });

        goWs.on('close', () => {
            log.warn('Go event bus disconnected, retrying in ' + retryDelay + 'ms');
            setTimeout(connectToGoEventBus, retryDelay);
            retryDelay = Math.min(retryDelay * 2, RECONNECT_MAX);
        });

        goWs.on('error', (err) => {
            const msg = err.message || '';
            // Detect TLS mismatch (Go server has TLS_API=Y but we connect via ws://) — issue #104
            if (msg.includes('unexpected server response: 400') || msg.includes('Parse Error') ||
                msg.includes('ECONNRESET') || msg.includes('socket hang up')) {
                log.error('Go event bus error: ' + msg +
                    ' — If Go server has TLS_API=Y enabled, the API port must stay HTTP. See issue #104.');
            } else {
                log.error('Go event bus error:', msg);
            }
            goWs.close();
        });
    }

    // Only connect if we have the Go API URL
    if (goApiUrl && apiKey) {
        connectToGoEventBus();
    } else {
        log.warn('Go API URL or API key not configured, device status push disabled');
    }

    log.info('Device status push initialized');
    return wss;
}

module.exports = { initDeviceStatusPush };
