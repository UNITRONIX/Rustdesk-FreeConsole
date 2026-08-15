/**
 * BetterDesk Console — Remote Desktop WebSocket Relay
 *
 * Bridges the BetterDesk desktop agent (JPEG screen stream) and the operator
 * browser viewer (Canvas element).
 *
 * Endpoints:
 *   WS /ws/remote-agent/<device_id>    — agent standby + stream source
 *   WS /ws/remote-viewer/<device_id>   — operator browser viewer
 *
 * Flow:
 *   1. Agent connects to /ws/remote-agent/<id> and sends { "type": "agent-ready" }
 *   2. Operator opens /remote/<id> in the web console (browser)
 *   3. Browser connects to /ws/remote-viewer/<id>
 *   4. Server sends { "type": "start" } to the agent
 *   5. Agent starts capturing and sends binary JPEG frames
 *   6. Server forwards binary frames to all connected viewers
 *   7. Viewer sends JSON input events → server → agent
 *   8. Session ends when viewer disconnects or sends { "type": "stop" }
 *
 * Security:
 *   - Agent requires single-use token (POST /api/bd/remote-agent-token) or valid enrollment token
 *   - Viewer requires valid session cookie (admin or operator role)
 *   - Input events are forwarded verbatim — agent validates the whitelist
 *   - Max binary frame: 2 MB (covers 1920×1080 JPEG at high quality)
 *   - Max concurrent viewers per device: 5
 */

'use strict';

const WebSocket = require('ws');
const crypto = require('crypto');
const db = require('./database');
const { verifyDeviceWsAuth } = require('../lib/deviceTokenAuth');
const { roleHasPermission } = require('../middleware/auth');

const MAX_BINARY_FRAME  = 2 * 1024 * 1024; // 2 MB
const MAX_VIEWERS       = 5;
const PING_INTERVAL     = 20000; // ms
const AGENT_IDLE_TTL    = 90000; // close idle agent after 90 s of no viewer
const AGENT_TOKEN_TTL_MS = 60 * 1000;

// deviceId → { token, expiresAt }
const pendingAgentTokens = new Map();

const log = {
    info:  (...a) => console.log('[RemoteRelay]', ...a),
    warn:  (...a) => console.warn('[RemoteRelay]', ...a),
    error: (...a) => console.error('[RemoteRelay]', ...a),
};

// ---------------------------------------------------------------------------
//  State
// ---------------------------------------------------------------------------

// device_id → { agentWs, viewers: Set<WebSocket>, streaming: bool, idleTimer }
const sessions = new Map();

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

function getSession(deviceId) {
    if (!sessions.has(deviceId)) {
        sessions.set(deviceId, { agentWs: null, viewers: new Set(), streaming: false, idleTimer: null });
    }
    return sessions.get(deviceId);
}

function sendJson(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function broadcast(viewers, data, isBinary = false) {
    viewers.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data, { binary: isBinary });
        }
    });
}

function setupPing(ws) {
    const t = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
        else clearInterval(t);
    }, PING_INTERVAL);
    ws.on('close', () => clearInterval(t));
}

function startAgentStream(session, deviceId) {
    if (!session.agentWs || session.streaming) return;
    session.streaming = true;
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
    log.info(`Session ${deviceId}: sending START to agent`);
    sendJson(session.agentWs, { type: 'start' });
    // Notify viewers
    broadcast(session.viewers, JSON.stringify({ type: 'stream-started' }));
}

function stopAgentStream(session, deviceId, reason = 'no viewers') {
    if (!session.streaming) return;
    session.streaming = false;
    log.info(`Session ${deviceId}: sending STOP to agent (${reason})`);
    if (session.agentWs && session.agentWs.readyState === WebSocket.OPEN) {
        sendJson(session.agentWs, { type: 'stop' });
    }
    broadcast(session.viewers, JSON.stringify({ type: 'stream-stopped', reason }));
}

function scheduleIdleClose(session, deviceId) {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
        if (session.viewers.size === 0 && session.agentWs) {
            log.info(`Session ${deviceId}: idle timeout — closing agent`);
            session.agentWs.close(1000, 'Idle timeout');
        }
    }, AGENT_IDLE_TTL);
}

function issueRemoteAgentToken(deviceId) {
    const token = crypto.randomBytes(32).toString('hex');
    pendingAgentTokens.set(deviceId, { token, expiresAt: Date.now() + AGENT_TOKEN_TTL_MS });
    return { token, expires_in: Math.floor(AGENT_TOKEN_TTL_MS / 1000) };
}

function consumeRemoteAgentToken(deviceId, token) {
    const entry = pendingAgentTokens.get(deviceId);
    if (!entry || !token) return false;
    if (Date.now() > entry.expiresAt) {
        pendingAgentTokens.delete(deviceId);
        return false;
    }
    try {
        const a = Buffer.from(entry.token);
        const b = Buffer.from(String(token));
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    } catch (_) {
        return false;
    }
    pendingAgentTokens.delete(deviceId);
    return true;
}

async function verifyAgentConnection(deviceId, token) {
    if (!token) return false;
    if (consumeRemoteAgentToken(deviceId, token)) return true;
    return verifyDeviceWsAuth(deviceId, token, db);
}

// ---------------------------------------------------------------------------
//  Agent connection handler (/ws/remote-agent/:device_id)
// ---------------------------------------------------------------------------

function handleAgentConnection(ws, deviceId) {
    const session = getSession(deviceId);

    // Replace any previous stale agent connection
    if (session.agentWs && session.agentWs.readyState !== WebSocket.CLOSED) {
        session.agentWs.close(1001, 'New agent connected');
    }
    session.streaming = false;
    session.agentWs = ws;

    log.info(`Agent connected: ${deviceId}`);

    // Notify waiting viewers that the agent is ready
    broadcast(session.viewers, JSON.stringify({ type: 'agent-ready', device_id: deviceId }));

    // If viewers are already waiting, start immediately
    if (session.viewers.size > 0) {
        startAgentStream(session, deviceId);
    } else {
        scheduleIdleClose(session, deviceId);
    }

    setupPing(ws);

    ws.on('message', (data, isBinary) => {
        if (isBinary) {
            // Binary = JPEG frame — forward to all viewers
            if (data.length > MAX_BINARY_FRAME) return;
            broadcast(session.viewers, data, true);
        } else {
            // JSON control frame from agent
            let frame;
            try { frame = JSON.parse(data.toString()); } catch { return; }
            // Forward status events to viewers
            if (frame.type === 'pong' || frame.type === 'status') {
                broadcast(session.viewers, JSON.stringify(frame));
            }
        }
    });

    ws.on('close', () => {
        if (session.agentWs === ws) {
            session.agentWs = null;
            session.streaming = false;
            clearTimeout(session.idleTimer);
            log.info(`Agent disconnected: ${deviceId}`);
            broadcast(session.viewers, JSON.stringify({ type: 'agent-disconnected' }));
        }
    });

    ws.on('error', (err) => {
        log.warn(`Agent WS error for ${deviceId}: ${err.message}`);
    });
}

// ---------------------------------------------------------------------------
//  Viewer connection handler (/ws/remote-viewer/:device_id)
// ---------------------------------------------------------------------------

function handleViewerConnection(ws, deviceId, operatorName) {
    const session = getSession(deviceId);

    if (session.viewers.size >= MAX_VIEWERS) {
        ws.close(1008, 'Max viewers reached');
        return;
    }

    session.viewers.add(ws);
    log.info(`Viewer ${operatorName} joined session ${deviceId} (${session.viewers.size} total)`);

    // Notify viewer of current state
    const agentReady = !!session.agentWs && session.agentWs.readyState === WebSocket.OPEN;
    sendJson(ws, { type: 'session-info', agent_ready: agentReady, streaming: session.streaming });

    // Start agent stream if agent is ready and not yet streaming
    if (agentReady && !session.streaming) {
        startAgentStream(session, deviceId);
    }

    setupPing(ws);

    ws.on('message', (data, isBinary) => {
        if (isBinary) return; // Viewers only send JSON

        let frame;
        try { frame = JSON.parse(data.toString()); } catch { return; }

        switch (frame.type) {
            case 'stop':
                stopAgentStream(session, deviceId, 'operator requested stop');
                break;

            case 'input':
                // Transform viewer event into agent InputEvent format.
                // Viewer sends { type: 'input', event_type: 'mouse_move', x, y, ... }
                // Agent expects { type: 'mouse_move', x, y, ... } (Rust InputEvent struct)
                if (session.agentWs && session.agentWs.readyState === WebSocket.OPEN) {
                    const agentEvent = { ...frame, type: frame.event_type || frame.kind || 'unknown' };
                    delete agentEvent.event_type;
                    sendJson(session.agentWs, agentEvent);
                }
                break;

            default:
                break;
        }
    });

    ws.on('close', () => {
        session.viewers.delete(ws);
        log.info(`Viewer ${operatorName} left session ${deviceId} (${session.viewers.size} remaining)`);

        if (session.viewers.size === 0) {
            stopAgentStream(session, deviceId, 'last viewer left');
            scheduleIdleClose(session, deviceId);
        }
    });

    ws.on('error', (err) => {
        log.warn(`Viewer WS error for ${deviceId}: ${err.message}`);
    });
}

// ---------------------------------------------------------------------------
//  Init — attach to existing HTTP server
// ---------------------------------------------------------------------------

function initRemoteRelay(server, sessionMiddleware) {
    const wss = new WebSocket.Server({ noServer: true });
    const { enforceOrigin } = require('../middleware/wsOrigin');
    const { registerUpgradeHandler } = require('./wsUpgradeRouter');

    registerUpgradeHandler(
        server,
        (path) => /^\/ws\/remote-agent\/[^/]+$/.test(path) || /^\/ws\/remote-viewer\/[^/]+$/.test(path),
        (req, socket, head) => {
            const url    = new URL(req.url, `http://${req.headers.host}`);
            const path   = url.pathname;

            // Agent: /ws/remote-agent/<device_id>
            const agentMatch = path.match(/^\/ws\/remote-agent\/([^/]+)$/);
            if (agentMatch) {
                if (!enforceOrigin(req, socket, `remote-agent ${path}`)) return;
                const deviceId = decodeURIComponent(agentMatch[1]);
                const token = url.searchParams.get('token') || '';
                // Validate device ID format (reject path traversal etc.)
                if (!/^[A-Za-z0-9_-]{3,64}$/.test(deviceId)) {
                    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
                    socket.destroy();
                    return;
                }
                verifyAgentConnection(deviceId, token).then((ok) => {
                    if (!ok) {
                        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                        socket.destroy();
                        return;
                    }
                    wss.handleUpgrade(req, socket, head, (ws) => {
                        handleAgentConnection(ws, deviceId);
                    });
                }).catch(() => {
                    try {
                        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
                        socket.destroy();
                    } catch (_) { /* closed */ }
                });
                return;
            }

            // Viewer (operator): /ws/remote-viewer/<device_id>
            const viewerMatch = path.match(/^\/ws\/remote-viewer\/([^/]+)$/);
            if (viewerMatch) {
                if (!enforceOrigin(req, socket, `remote-viewer ${path}`)) return;
                sessionMiddleware(req, {}, () => {
                    if (!req.session || !req.session.userId) {
                        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                        socket.destroy();
                        return;
                    }
                    if (!roleHasPermission(req.session.user?.role, 'device.connect')) {
                        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                        socket.destroy();
                        return;
                    }
                    wss.handleUpgrade(req, socket, head, (ws) => {
                        const opName = req.session.username || 'operator';
                        handleViewerConnection(ws, viewerMatch[1], opName);
                    });
                });
            }
        }
    );

    log.info('Remote relay initialized (/ws/remote-agent/:id, /ws/remote-viewer/:id)');
    return wss;
}

// ---------------------------------------------------------------------------
//  Exports
// ---------------------------------------------------------------------------

module.exports = {
    initRemoteRelay,
    issueRemoteAgentToken,
    /** Get session state (for admin REST API) */
    getSessionState(deviceId) {
        const s = sessions.get(deviceId);
        if (!s) return null;
        return {
            agentConnected: !!s.agentWs && s.agentWs.readyState === WebSocket.OPEN,
            viewerCount: s.viewers.size,
            streaming: s.streaming,
        };
    },
    getActiveSessions: () => [...sessions.keys()],
};
