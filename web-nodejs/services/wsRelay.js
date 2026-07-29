/**
 * BetterDesk Console - WebSocket Relay Proxy
 * Bridges browser WebSocket connections to hbbs/hbbr.
 *
 * Provides two WebSocket endpoints:
 *   /ws/rendezvous - proxies to hbbs TCP (port 21116) or Go WSS (21118) when rdTransport=ws
 *   /ws/relay      - proxies to hbbr TCP (port 21117) or Go WSS (21119) when rdTransport=ws
 *
 * IMPORTANT: hbbr treats loopback TCP connections as admin command interface
 * (relay_server.rs: `if !ws && ip.is_loopback()`). The TCP relay proxy must
 * connect via a non-loopback IP so hbbr handles it as a relay request.
 *
 * WebSocket Mode agents (allow-websocket=Y) use ConnWS on :21118/:21119 with
 * raw protobuf per WS frame (no BytesCodec). Web Remote must bridge WS→WS for
 * those targets (#314); mixing TCP and WS relay is rejected (#290).
 */

const WebSocket = require('ws');
const net = require('net');
const os = require('os');
const config = require('../config/config');
const { enforceOrigin } = require('../middleware/wsOrigin');
const { registerUpgradeHandler } = require('./wsUpgradeRouter');

// Maximum concurrent relay connections per IP
const MAX_CONNECTIONS_PER_IP = 5;
// Connection timeout (no data for 2 minutes = close)
const IDLE_TIMEOUT_MS = 120000;

// Track connections per IP
const connectionsPerIp = new Map();

/**
 * Check if a hostname resolves to a loopback address
 * @param {string} host
 * @returns {boolean}
 */
function isLoopbackHost(host) {
    if (!host) return false;
    const lower = host.toLowerCase();
    return lower === 'localhost' || lower === '127.0.0.1' || lower === '::1'
        || lower.startsWith('127.');
}

/**
 * Get first non-loopback IPv4 address of the machine.
 * Used to avoid hbbr's loopback command-mode check when proxying relay connections.
 * @returns {string|null}
 */
function getNonLoopbackIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return null;
}

/**
 * @param {http.IncomingMessage} req
 * @returns {boolean}
 */
function wantsWsTransport(req) {
    try {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        return String(url.searchParams.get('rdTransport') || '').toLowerCase() === 'ws';
    } catch {
        return false;
    }
}

/**
 * Initialize WebSocket proxy servers and attach to HTTP server
 * @param {http.Server} server - The HTTP/HTTPS server instance
 * @param {Function} sessionMiddleware - Express session middleware to validate WS upgrades
 */
function initWsProxy(server, sessionMiddleware) {
    // Rendezvous proxy (hbbs)
    const rendezvousWss = new WebSocket.Server({ noServer: true });
    // Relay proxy (hbbr)
    const relayWss = new WebSocket.Server({ noServer: true });

    // Handle upgrade requests — verify session cookie before allowing WebSocket.
    // Paths owned: /ws/rendezvous, /ws/relay (shared upgrade router — #295).
    registerUpgradeHandler(
        server,
        (pathname) => pathname === '/ws/rendezvous' || pathname === '/ws/relay',
        (request, socket, head) => {
            const url = new URL(request.url, `http://${request.headers.host}`);
            const pathname = url.pathname;

            // CSWSH protection: reject cross-origin upgrades before touching session
            if (!enforceOrigin(request, socket, `ws-proxy ${pathname}`)) return;

            // Validate the session against the real Express session store.
            // Using sessionMiddleware (from server.js) populates req.session, which
            // we then check for an authenticated userId. This replaces the old
            // cookie-name-only check that could be bypassed with a fake cookie.
            if (typeof sessionMiddleware !== 'function') {
                console.warn('WS proxy: sessionMiddleware not provided — rejecting upgrade');
                socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
                socket.destroy();
                return;
            }

            // Attach a minimal fake response so session middleware can call next()
            const fakeRes = Object.create(null);
            fakeRes.getHeader = () => undefined;
            fakeRes.setHeader = () => {};
            fakeRes.end = () => {};
            fakeRes.on = () => {};

            sessionMiddleware(request, fakeRes, () => {
                void (async () => {
                    const hasUser = request.session && request.session.userId;
                    let hasGuest = false;
                    if (!hasUser) {
                        let guestToken = '';
                        try {
                            // Prefer ?guest= on WS URL (session pages always append it for guests)
                            guestToken = String(
                                url.searchParams.get('guest') || url.searchParams.get('t') || ''
                            ).trim();
                            if (!guestToken) {
                                const { GUEST_COOKIE } = require('../middleware/guestAccess');
                                const raw = request.headers.cookie || '';
                                const names = [GUEST_COOKIE, 'bd.guest', 'betterdesk.guest'];
                                for (const cookieName of names) {
                                    const match = raw.split(';').map((p) => p.trim()).find((p) => p.startsWith(cookieName + '='));
                                    if (match) {
                                        guestToken = decodeURIComponent(match.slice(cookieName.length + 1) || '').trim();
                                        if (guestToken) break;
                                    }
                                }
                            }
                        } catch {
                            guestToken = '';
                        }

                        if (guestToken) {
                            try {
                                // Must validate against Go store — non-empty guest= alone is not auth.
                                const betterdeskApi = require('./betterdeskApi');
                                const result = await betterdeskApi.apiClient.get('/guest/access-links/validate', {
                                    params: { token: guestToken },
                                    timeout: 5000,
                                });
                                const data = result.data || {};
                                if (data.valid) {
                                    hasGuest = true;
                                    request.guestToken = guestToken;
                                    request.guestGrant = data;
                                }
                            } catch (err) {
                                console.warn(
                                    `WS proxy: guest token validation failed for ${pathname}: ${err.message || err}`
                                );
                            }
                        }
                    }
                    if (!hasUser && !hasGuest) {
                        console.warn(`WS proxy: Rejected upgrade to ${pathname} — no authenticated session (ip: ${request.socket?.remoteAddress})`);
                        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                        socket.destroy();
                        return;
                    }

                    if (pathname === '/ws/rendezvous') {
                        rendezvousWss.handleUpgrade(request, socket, head, (ws) => {
                            rendezvousWss.emit('connection', ws, request);
                        });
                    } else {
                        relayWss.handleUpgrade(request, socket, head, (ws) => {
                            relayWss.emit('connection', ws, request);
                        });
                    }
                })();
            });
        }
    );

    // Parse target host/port from config
    const hbbsHost = config.wsProxy?.hbbsHost || 'localhost';
    const hbbsPort = config.wsProxy?.hbbsPort || 21116;
    let hbbrHost = config.wsProxy?.hbbrHost || 'localhost';
    const hbbrPort = config.wsProxy?.hbbrPort || 21117;
    const wsUpstreamTls = /^(1|true|yes|y)$/i.test(String(process.env.WS_UPSTREAM_TLS || ''));
    const wsScheme = wsUpstreamTls ? 'wss' : 'ws';

    // CRITICAL: hbbr treats loopback TCP connections as admin command interface
    // and will NOT process relay requests from 127.0.0.0/8.
    // If hbbrHost is loopback, replace with the machine's non-loopback IP.
    // (WS Mode upstream to :21119 does not use this TCP admin path.)
    if (isLoopbackHost(hbbrHost)) {
        const nonLoopback = getNonLoopbackIp();
        if (nonLoopback) {
            console.log(`  WebSocket proxy: hbbr host changed from '${hbbrHost}' to '${nonLoopback}' (avoiding loopback command mode)`);
            hbbrHost = nonLoopback;
        } else {
            console.warn('  WebSocket proxy: WARNING - could not find non-loopback IP for hbbr, relay connections may fail!');
        }
    }

    // Rendezvous connections
    rendezvousWss.on('connection', (ws, req) => {
        if (wantsWsTransport(req)) {
            const url = `${wsScheme}://${hbbsHost}:${hbbsPort + 2}/ws/id`;
            handleWsBridge(ws, req, url, 'rendezvous-ws');
            return;
        }
        handleProxyConnection(ws, req, hbbsHost, hbbsPort, 'rendezvous');
    });

    // Relay connections
    relayWss.on('connection', (ws, req) => {
        if (wantsWsTransport(req)) {
            // Prefer configured hbbr host; for WS Mode loopback is fine (no TCP admin gate).
            const wsRelayHost = config.wsProxy?.hbbrHost || 'localhost';
            const url = `${wsScheme}://${wsRelayHost}:${hbbrPort + 2}/ws/relay`;
            handleWsBridge(ws, req, url, 'relay-ws');
            return;
        }
        handleProxyConnection(ws, req, hbbrHost, hbbrPort, 'relay');
    });

    console.log(`  WebSocket proxy: /ws/rendezvous -> ${hbbsHost}:${hbbsPort} (TCP) / :${hbbsPort + 2} (WS)`);
    console.log(`  WebSocket proxy: /ws/relay -> ${hbbrHost}:${hbbrPort} (TCP) / :${hbbrPort + 2} (WS)`);

    return { rendezvousWss, relayWss };
}

/**
 * Acquire a connection slot for rate limiting. Returns client IP or null if rejected.
 * @param {http.IncomingMessage} req
 * @param {WebSocket} ws
 * @param {string} label
 * @returns {string|null}
 */
function acquireConnectionSlot(req, ws, label) {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.socket.remoteAddress
        || 'unknown';

    const currentCount = connectionsPerIp.get(clientIp) || 0;
    if (currentCount >= MAX_CONNECTIONS_PER_IP) {
        console.warn(`WS proxy [${label}]: Connection limit reached for ${clientIp}`);
        ws.close(1008, 'Too many connections');
        return null;
    }
    connectionsPerIp.set(clientIp, currentCount + 1);
    return clientIp;
}

/**
 * Release a connection slot.
 * @param {string} clientIp
 */
function releaseConnectionSlot(clientIp) {
    const count = connectionsPerIp.get(clientIp) || 1;
    if (count <= 1) {
        connectionsPerIp.delete(clientIp);
    } else {
        connectionsPerIp.set(clientIp, count - 1);
    }
}

/**
 * Bridge browser WebSocket ↔ Go WebSocket (one binary frame in = one out).
 * Used when the target peer is ConnWS (#314).
 *
 * @param {WebSocket} ws - browser side
 * @param {http.IncomingMessage} req
 * @param {string} upstreamUrl - e.g. ws://127.0.0.1:21118/ws/id
 * @param {string} label
 */
function handleWsBridge(ws, req, upstreamUrl, label) {
    const clientIp = acquireConnectionSlot(req, ws, label);
    if (!clientIp) return;

    let idleTimer = null;
    const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            console.log(`WS proxy [${label}]: Idle timeout for ${clientIp}`);
            cleanup();
        }, IDLE_TIMEOUT_MS);
    };

    const upstreamOpts = {};
    if (upstreamUrl.startsWith('wss://') && config.allowSelfSignedCerts) {
        upstreamOpts.rejectUnauthorized = false;
    }

    const upstream = new WebSocket(upstreamUrl, upstreamOpts);
    upstream.binaryType = 'nodebuffer';

    /** @type {Array<{data: any, binary: boolean}>} */
    const pendingToUpstream = [];
    let upstreamOpen = false;

    let cleaned = false;
    function cleanup() {
        if (cleaned) return;
        cleaned = true;
        if (idleTimer) clearTimeout(idleTimer);
        pendingToUpstream.length = 0;
        try {
            if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
                upstream.close();
            }
        } catch (_e) { /* ignore */ }
        try {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.close();
            }
        } catch (_e) { /* ignore */ }
        releaseConnectionSlot(clientIp);
    }

    function sendToUpstream(data, isBinary) {
        const binary = !!(isBinary || Buffer.isBuffer(data) || data instanceof ArrayBuffer);
        if (!upstreamOpen || upstream.readyState !== WebSocket.OPEN) {
            pendingToUpstream.push({ data, binary });
            return;
        }
        upstream.send(data, { binary });
    }

    upstream.on('open', () => {
        upstreamOpen = true;
        resetIdleTimer();
        while (pendingToUpstream.length > 0) {
            const item = pendingToUpstream.shift();
            if (upstream.readyState === WebSocket.OPEN) {
                upstream.send(item.data, { binary: item.binary });
            }
        }
    });

    upstream.on('message', (data, isBinary) => {
        resetIdleTimer();
        if (ws.readyState !== WebSocket.OPEN) return;
        // Preserve binary message boundaries (critical for WS Mode / #293).
        if (isBinary || Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
            ws.send(data, { binary: true });
        } else {
            ws.send(data);
        }
    });

    upstream.on('error', (err) => {
        console.error(`WS proxy [${label}]: upstream error (${upstreamUrl}):`, err.message);
        cleanup();
    });

    upstream.on('close', () => {
        cleanup();
    });

    ws.on('message', (data, isBinary) => {
        resetIdleTimer();
        sendToUpstream(data, isBinary);
    });

    ws.on('close', () => {
        cleanup();
    });

    ws.on('error', (err) => {
        console.error(`WS proxy [${label}]: WebSocket error:`, err.message);
        cleanup();
    });
}

/**
 * Handle a single proxied WebSocket → TCP connection (native TCP/UDP agents).
 */
function handleProxyConnection(ws, req, targetHost, targetPort, label) {
    const clientIp = acquireConnectionSlot(req, ws, label);
    if (!clientIp) return;

    // Idle timeout
    let idleTimer = null;
    const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            console.log(`WS proxy [${label}]: Idle timeout for ${clientIp}`);
            cleanup();
        }, IDLE_TIMEOUT_MS);
    };

    // Connect to target TCP server
    const tcp = net.createConnection({ host: targetHost, port: targetPort }, () => {
        resetIdleTimer();
    });

    tcp.on('error', (err) => {
        console.error(`WS proxy [${label}]: TCP error (${targetHost}:${targetPort}):`, err.message);
        cleanup();
    });

    tcp.on('close', () => {
        cleanup();
    });

    // TCP -> WebSocket
    tcp.on('data', (data) => {
        resetIdleTimer();
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    });

    // WebSocket -> TCP
    ws.on('message', (data) => {
        resetIdleTimer();
        if (!tcp.destroyed) {
            // Ensure we send Buffer, not string
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            tcp.write(buf);
        }
    });

    ws.on('close', () => {
        cleanup();
    });

    ws.on('error', (err) => {
        console.error(`WS proxy [${label}]: WebSocket error:`, err.message);
        cleanup();
    });

    let cleaned = false;
    function cleanup() {
        if (cleaned) return;
        cleaned = true;

        if (idleTimer) clearTimeout(idleTimer);

        if (!tcp.destroyed) {
            tcp.destroy();
        }
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
        }

        releaseConnectionSlot(clientIp);
    }
}

module.exports = { initWsProxy, wantsWsTransport, handleWsBridge };
