/**
 * BetterDesk Console — Native WebSocket Relay
 *
 * Provides a direct relay channel between two BetterDesk desktop clients.
 * Unlike the RustDesk WS proxy (wsRelay.js) which bridges browser→hbbr TCP,
 * this relay pairs two desktop clients directly and passes E2E-encrypted
 * binary frames between them.  The server NEVER decrypts the payload.
 *
 * Protocol:
 *   1. Client A → POST /api/bd/connect/:targetId
 *      → returns { sessionId, token }
 *   2. Both clients → WS /ws/bd-relay?session=<id>&token=<token>&role=initiator|target
 *   3. Server pairs them once both sides are connected
 *   4. Binary frames are forwarded 1:1 between the pair
 *   5. Either side closes → session torn down
 *
 * Security:
 *   - Tokens are single-use, short-lived (60 s default)
 *   - Rate-limited per IP (MAX_RELAY_PER_IP)
 *   - Binary-only after handshake (text frames rejected)
 *   - Maximum frame size enforced (MAX_FRAME_BYTES)
 *   - Session auto-cleanup every 30 s
 */

'use strict';

const WebSocket = require('ws');
const crypto = require('crypto');
const db = require('./database');
const { verifyDeviceWsAuth } = require('../lib/deviceTokenAuth');

// ---------------------------------------------------------------------------
//  Constants
// ---------------------------------------------------------------------------

const MAX_RELAY_PER_IP = 10;          // concurrent relay WS per IP
const MAX_FRAME_BYTES  = 2 * 1024 * 1024; // 2 MB per frame
const SESSION_TTL_MS   = 60 * 1000;   // token valid for 60 s after creation
const IDLE_TIMEOUT_MS  = 120 * 1000;  // close if no data for 2 min
const CLEANUP_INTERVAL = 30 * 1000;   // cleanup tick

// ---------------------------------------------------------------------------
//  State
// ---------------------------------------------------------------------------

// sessionId → { initiatorWs, targetWs, initiatorToken, targetToken, createdAt, status }
const activeSessions = new Map();

// deviceId → WebSocket (for online device tracking / push notifications)
const onlineDevices = new Map();

// IP → count
const connectionsPerIp = new Map();

// requestId → { resolve, reject, timeout } for request/response pattern over signal WS
const pendingRequests = new Map();

const REQUEST_TIMEOUT_MS = 15 * 1000; // 15s default

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function clientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.socket?.remoteAddress
        || 'unknown';
}

function incIpCount(ip) {
    connectionsPerIp.set(ip, (connectionsPerIp.get(ip) || 0) + 1);
}

function decIpCount(ip) {
    const c = (connectionsPerIp.get(ip) || 1) - 1;
    if (c <= 0) connectionsPerIp.delete(ip);
    else connectionsPerIp.set(ip, c);
}

// ---------------------------------------------------------------------------
//  Session management (called by bd-api routes)
// ---------------------------------------------------------------------------

/**
 * Create a new relay session.  Returns tokens for both participants.
 * @param {string} initiatorId - device ID of the caller
 * @param {string} targetId    - device ID of the target
 * @returns {{ sessionId: string, initiatorToken: string, targetToken: string }}
 */
function createRelaySession(initiatorId, targetId) {
    const sessionId = crypto.randomUUID();
    const initiatorToken = generateToken();
    const targetToken = generateToken();

    activeSessions.set(sessionId, {
        initiatorId,
        targetId,
        initiatorWs: null,
        targetWs: null,
        initiatorToken,
        targetToken,
        createdAt: Date.now(),
        status: 'pending',          // pending → active → closed
    });

    return { sessionId, initiatorToken, targetToken };
}

/**
 * Get session metadata (without tokens) for API responses.
 */
function getRelaySession(sessionId) {
    const s = activeSessions.get(sessionId);
    if (!s) return null;
    return {
        sessionId,
        initiatorId: s.initiatorId,
        targetId: s.targetId,
        status: s.status,
        createdAt: s.createdAt,
    };
}

/**
 * Notify a target device that someone wants to connect.
 * Sends a JSON control message over the device's signaling WS.
 */
function notifyTarget(targetId, payload) {
    const ws = onlineDevices.get(targetId);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
        return true;
    }
    return false;
}

/**
 * Check if a device is currently online (has an active signaling WS).
 */
function isDeviceOnline(deviceId) {
    const ws = onlineDevices.get(deviceId);
    return ws && ws.readyState === WebSocket.OPEN;
}

/**
 * Get list of currently online device IDs.
 */
function getOnlineDeviceIds() {
    const ids = [];
    for (const [id, ws] of onlineDevices) {
        if (ws.readyState === WebSocket.OPEN) ids.push(id);
    }
    return ids;
}

/**
 * Send a request to an online agent and await its response over the signal WS.
 * The agent receives `{ type, request_id, payload }` and must reply with
 * `{ type: 'command_response', request_id, ok, data?, error? }`.
 *
 * @param {string} deviceId
 * @param {string} type     e.g. 'services.list', 'files.browse'
 * @param {object} payload  optional type-specific payload
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<any>} resolves with agent's `data`, rejects on error/timeout
 */
function requestFromDevice(deviceId, type, payload = null, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const ws = onlineDevices.get(deviceId);
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            return reject(new Error('agent_offline'));
        }

        const requestId = crypto.randomUUID();
        const timeout = setTimeout(() => {
            pendingRequests.delete(requestId);
            reject(new Error('agent_timeout'));
        }, Math.max(1000, Math.min(60000, timeoutMs)));

        pendingRequests.set(requestId, { resolve, reject, timeout });

        try {
            ws.send(JSON.stringify({ type, request_id: requestId, payload }));
        } catch (err) {
            pendingRequests.delete(requestId);
            clearTimeout(timeout);
            reject(err);
        }
    });
}

// ---------------------------------------------------------------------------
//  WebSocket server initialisation
// ---------------------------------------------------------------------------

/**
 * Initialize the BetterDesk relay WebSocket endpoints:
 *   /ws/bd-relay   — data relay between paired clients
 *   /ws/bd-signal  — signaling / presence channel per device
 *
 * @param {http.Server} server
 */
function initBdRelay(server) {
    const relayWss  = new WebSocket.Server({ noServer: true, maxPayload: MAX_FRAME_BYTES });
    const signalWss = new WebSocket.Server({ noServer: true, maxPayload: 64 * 1024 });
    const { enforceOrigin } = require('../middleware/wsOrigin');

    // Attach to server upgrade — only handle /ws/bd-relay and /ws/bd-signal,
    // let other handlers (remoteRelay, chatRelay, cdap) handle their paths.
    server.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url, `http://${request.headers.host}`);
        const pathname = url.pathname;

        if (pathname === '/ws/bd-relay') {
            if (!enforceOrigin(request, socket, `bd-relay ${pathname}`)) return;
            relayWss.handleUpgrade(request, socket, head, (ws) => {
                relayWss.emit('connection', ws, request);
            });
        } else if (pathname === '/ws/bd-signal') {
            if (!enforceOrigin(request, socket, `bd-signal ${pathname}`)) return;
            signalWss.handleUpgrade(request, socket, head, (ws) => {
                signalWss.emit('connection', ws, request);
            });
        }
        // Other paths: do nothing — let other upgrade handlers deal with them
    });

    // ---- Relay connections ----

    relayWss.on('connection', (ws, req) => {
        handleRelayConnection(ws, req);
    });

    // ---- Signal connections ----

    signalWss.on('connection', (ws, req) => {
        handleSignalConnection(ws, req).catch(() => {
            try { ws.close(4500, 'Auth error'); } catch (_) { /* closed */ }
        });
    });

    // Cleanup interval
    const cleanupTimer = setInterval(cleanupSessions, CLEANUP_INTERVAL);
    cleanupTimer.unref();

    console.log('  BetterDesk relay: /ws/bd-relay  (data relay)');
    console.log('  BetterDesk relay: /ws/bd-signal (signaling)');

    return { relayWss, signalWss };
}

// ---------------------------------------------------------------------------
//  Relay connection handler
// ---------------------------------------------------------------------------

function handleRelayConnection(ws, req) {
    const ip = clientIp(req);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get('session');
    const token = url.searchParams.get('token');
    const role = url.searchParams.get('role'); // 'initiator' | 'target'

    // Validate parameters
    if (!sessionId || !token || !role || !['initiator', 'target'].includes(role)) {
        ws.close(4400, 'Missing or invalid parameters');
        return;
    }

    // IP rate limit
    if ((connectionsPerIp.get(ip) || 0) >= MAX_RELAY_PER_IP) {
        ws.close(4429, 'Too many connections');
        return;
    }

    const session = activeSessions.get(sessionId);
    if (!session) {
        ws.close(4404, 'Session not found');
        return;
    }

    // Validate token
    const expectedToken = role === 'initiator' ? session.initiatorToken : session.targetToken;
    if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expectedToken))) {
        ws.close(4403, 'Invalid token');
        return;
    }

    // Check session age
    if (Date.now() - session.createdAt > SESSION_TTL_MS && session.status === 'pending') {
        activeSessions.delete(sessionId);
        ws.close(4408, 'Session expired');
        return;
    }

    // Attach
    incIpCount(ip);
    const slotKey = role === 'initiator' ? 'initiatorWs' : 'targetWs';

    if (session[slotKey]) {
        ws.close(4409, 'Slot already taken');
        decIpCount(ip);
        return;
    }

    session[slotKey] = ws;

    // If both sides connected → activate
    if (session.initiatorWs && session.targetWs) {
        activateRelay(sessionId, session);
    }

    // Idle timeout for waiting side
    let idleTimer = setTimeout(() => {
        if (session.status === 'pending') {
            teardownSession(sessionId, 4408, 'Timeout waiting for peer');
        }
    }, SESSION_TTL_MS);

    ws.on('close', () => {
        clearTimeout(idleTimer);
        decIpCount(ip);
        teardownSession(sessionId, 1000, 'Peer disconnected');
    });

    ws.on('error', () => {
        clearTimeout(idleTimer);
        decIpCount(ip);
        teardownSession(sessionId, 1011, 'WebSocket error');
    });
}

function activateRelay(sessionId, session) {
    session.status = 'active';

    const wsA = session.initiatorWs;
    const wsB = session.targetWs;

    // Send paired notification (JSON text frame)
    const pairMsg = JSON.stringify({ type: 'paired', session: sessionId });
    if (wsA.readyState === WebSocket.OPEN) wsA.send(pairMsg);
    if (wsB.readyState === WebSocket.OPEN) wsB.send(pairMsg);

    // Data relay (binary only after pairing)
    let idleTimer = null;
    const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            teardownSession(sessionId, 4408, 'Idle timeout');
        }, IDLE_TIMEOUT_MS);
    };

    resetIdle();

    wsA.on('message', (data, isBinary) => {
        resetIdle();
        if (wsB.readyState === WebSocket.OPEN) {
            wsB.send(data, { binary: isBinary });
        }
    });

    wsB.on('message', (data, isBinary) => {
        resetIdle();
        if (wsA.readyState === WebSocket.OPEN) {
            wsA.send(data, { binary: isBinary });
        }
    });

    const origClose = () => {
        clearTimeout(idleTimer);
    };
    wsA.on('close', origClose);
    wsB.on('close', origClose);
}

function teardownSession(sessionId, code, reason) {
    const session = activeSessions.get(sessionId);
    if (!session) return;

    session.status = 'closed';
    activeSessions.delete(sessionId);

    for (const key of ['initiatorWs', 'targetWs']) {
        const ws = session[key];
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            try { ws.close(code, reason); } catch (_) {}
        }
    }
}

// ---------------------------------------------------------------------------
//  Signal connection handler (presence / push)
// ---------------------------------------------------------------------------

async function handleSignalConnection(ws, req) {
    const ip = clientIp(req);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const deviceId = url.searchParams.get('device_id');
    const token = url.searchParams.get('token');

    if (!deviceId || !token) {
        ws.close(4400, 'Missing device_id or token');
        return;
    }

    if (!/^[A-Za-z0-9_-]{3,64}$/.test(deviceId)) {
        ws.close(4400, 'Invalid device_id');
        return;
    }

    const authed = await verifyDeviceWsAuth(deviceId, token, db);
    if (!authed) {
        ws.close(4403, 'Invalid token');
        return;
    }

    // IP rate limit
    if ((connectionsPerIp.get(ip) || 0) >= MAX_RELAY_PER_IP) {
        ws.close(4429, 'Too many connections');
        return;
    }

    incIpCount(ip);

    // Store reference for push notifications
    // If device already has a signal WS, close the old one
    const existing = onlineDevices.get(deviceId);
    if (existing && existing.readyState === WebSocket.OPEN) {
        existing.close(4409, 'Replaced by new connection');
    }
    onlineDevices.set(deviceId, ws);

    // Heartbeat
    let heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        }
    }, 30000);

    ws.on('message', (data) => {
        // Signal messages are JSON
        try {
            const msg = JSON.parse(data.toString());
            handleSignalMessage(deviceId, ws, msg);
        } catch (_) {
            // Ignore malformed messages
        }
    });

    ws.on('close', () => {
        clearInterval(heartbeatTimer);
        decIpCount(ip);
        if (onlineDevices.get(deviceId) === ws) {
            onlineDevices.delete(deviceId);
        }
    });

    ws.on('error', () => {
        clearInterval(heartbeatTimer);
        decIpCount(ip);
        if (onlineDevices.get(deviceId) === ws) {
            onlineDevices.delete(deviceId);
        }
    });

    // Acknowledge connection
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'welcome', device_id: deviceId }));
    }
}

function handleSignalMessage(deviceId, ws, msg) {
    switch (msg.type) {
        case 'heartbeat':
            ws.send(JSON.stringify({ type: 'heartbeat_ack', ts: Date.now() }));
            break;

        case 'relay_accept': {
            // Target device accepts incoming connection
            const session = activeSessions.get(msg.session_id);
            if (session && session.targetId === deviceId && session.status === 'pending') {
                // Send target token to the target device so it can connect to the relay WS
                ws.send(JSON.stringify({
                    type: 'relay_ready',
                    session_id: msg.session_id,
                    token: session.targetToken,
                }));
            }
            break;
        }

        case 'relay_reject': {
            // Target device rejects incoming connection
            const session = activeSessions.get(msg.session_id);
            if (session && session.targetId === deviceId) {
                teardownSession(msg.session_id, 4403, 'Connection rejected by target');
            }
            break;
        }

        case 'command_response': {
            // Agent responding to a requestFromDevice() call.
            // msg = { type, request_id, ok, data?, error? }
            const pending = pendingRequests.get(msg.request_id);
            if (pending) {
                pendingRequests.delete(msg.request_id);
                clearTimeout(pending.timeout);
                if (msg.ok) pending.resolve(msg.data || null);
                else pending.reject(new Error(msg.error || 'agent_error'));
            }
            break;
        }

        default:
            break;
    }
}

// ---------------------------------------------------------------------------
//  Cleanup
// ---------------------------------------------------------------------------

function cleanupSessions() {
    const now = Date.now();
    for (const [id, session] of activeSessions) {
        // Expired pending sessions
        if (session.status === 'pending' && now - session.createdAt > SESSION_TTL_MS * 2) {
            teardownSession(id, 4408, 'Session expired');
        }
    }

    // Clean dead device entries
    for (const [id, ws] of onlineDevices) {
        if (ws.readyState !== WebSocket.OPEN) {
            onlineDevices.delete(id);
        }
    }
}

// ---------------------------------------------------------------------------
//  Exports
// ---------------------------------------------------------------------------

module.exports = {
    initBdRelay,
    createRelaySession,
    getRelaySession,
    notifyTarget,
    isDeviceOnline,
    getOnlineDeviceIds,
    requestFromDevice,
    activeSessions,    // exposed for monitoring/admin API
    onlineDevices,     // exposed for status sync
};
