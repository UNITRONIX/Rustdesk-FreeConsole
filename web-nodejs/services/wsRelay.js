/**
 * BetterDesk Console - WebSocket Relay Proxy
 * Bridges browser WebSocket connections to TCP connections for hbbs/hbbr
 * 
 * Provides two WebSocket endpoints:
 *   /ws/rendezvous - proxies to hbbs TCP (port 21116)
 *   /ws/relay      - proxies to hbbr TCP (port 21117)
 * 
 * IMPORTANT: hbbr treats loopback TCP connections as admin command interface
 * (relay_server.rs: `if !ws && ip.is_loopback()`). The relay proxy must
 * connect via a non-loopback IP so hbbr handles it as a relay request.
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
// RustDesk allows large encoded desktop frames on relay connections.
const MAX_RELAY_FRAME_SIZE = 64 * 1024 * 1024;

// Track connections per IP
const connectionsPerIp = new Map();

/** Encode one raw WebSocket message as a RustDesk BytesCodec TCP frame. */
function encodeRelayFrame(data) {
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const len = payload.length;
    if (len <= 0 || len > MAX_RELAY_FRAME_SIZE) {
        throw new Error(`invalid relay frame size: ${len}`);
    }

    let header;
    if (len <= 0x3F) {
        header = Buffer.from([len << 2]);
    } else if (len <= 0x3FFF) {
        header = Buffer.allocUnsafe(2);
        header.writeUInt16LE((len << 2) | 0x01);
    } else if (len <= 0x3FFFFF) {
        const value = (len * 4) + 0x02;
        header = Buffer.allocUnsafe(3);
        header[0] = value & 0xFF;
        header[1] = (value >>> 8) & 0xFF;
        header[2] = (value >>> 16) & 0xFF;
    } else {
        header = Buffer.allocUnsafe(4);
        header.writeUInt32LE(((len * 4) + 0x03) >>> 0);
    }
    return Buffer.concat([header, payload], header.length + len);
}

/**
 * Decode arbitrary TCP chunks into complete RustDesk BytesCodec payloads.
 * The returned payloads are copies because the backing buffer is reused.
 */
function createRelayFrameDecoder() {
    let buffer = Buffer.alloc(0);
    let dataLen = 0;

    return {
        feed(chunk) {
            const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const needed = dataLen + incoming.length;
            if (needed > MAX_RELAY_FRAME_SIZE + 4) {
                throw new Error('relay frame buffer exceeds maximum size');
            }
            if (needed > buffer.length) {
                const capacity = Math.min(
                    MAX_RELAY_FRAME_SIZE + 4,
                    Math.max(needed, buffer.length * 2, 4096)
                );
                const grown = Buffer.allocUnsafe(capacity);
                if (dataLen > 0) buffer.copy(grown, 0, 0, dataLen);
                buffer = grown;
            }
            incoming.copy(buffer, dataLen);
            dataLen += incoming.length;

            const frames = [];
            let offset = 0;
            while (offset < dataLen) {
                const headerLen = (buffer[offset] & 0x03) + 1;
                if (dataLen - offset < headerLen) break;

                let encoded = 0;
                for (let i = 0; i < headerLen; i++) {
                    encoded += buffer[offset + i] * (2 ** (8 * i));
                }
                const payloadLen = Math.floor(encoded / 4);
                if (payloadLen <= 0 || payloadLen > MAX_RELAY_FRAME_SIZE) {
                    throw new Error(`invalid relay payload length: ${payloadLen}`);
                }
                if (dataLen - offset - headerLen < payloadLen) break;

                const start = offset + headerLen;
                frames.push(Buffer.from(buffer.subarray(start, start + payloadLen)));
                offset = start + payloadLen;
            }

            if (offset > 0) {
                const remaining = dataLen - offset;
                if (remaining > 0) buffer.copy(buffer, 0, offset, dataLen);
                dataLen = remaining;
            }
            if (dataLen === 0 && buffer.length > 1024 * 1024) buffer = Buffer.alloc(0);
            return frames;
        }
    };
}

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
                            ws._betterdeskMessageTransport = false;
                            rendezvousWss.emit('connection', ws, request);
                        });
                    } else {
                        relayWss.handleUpgrade(request, socket, head, (ws) => {
                            // Browser RdClient uses native WebSocket message framing.
                            // If this request reaches the Node TCP bridge, translate
                            // each WS message to/from RustDesk BytesCodec frames.
                            ws._betterdeskMessageTransport = url.searchParams.get('transport') === 'message';
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

    // CRITICAL: hbbr treats loopback TCP connections as admin command interface
    // and will NOT process relay requests from 127.0.0.0/8.
    // If hbbrHost is loopback, replace with the machine's non-loopback IP.
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
        handleProxyConnection(ws, req, hbbsHost, hbbsPort, 'rendezvous');
    });

    // Relay connections
    relayWss.on('connection', (ws, req) => {
        handleProxyConnection(ws, req, hbbrHost, hbbrPort, 'relay', {
            messageTransport: ws._betterdeskMessageTransport === true
        });
    });

    console.log(`  WebSocket proxy: /ws/rendezvous -> ${hbbsHost}:${hbbsPort}`);
    console.log(`  WebSocket proxy: /ws/relay -> ${hbbrHost}:${hbbrPort}`);

    return { rendezvousWss, relayWss };
}

/**
 * Handle a single proxied WebSocket connection
 */
function handleProxyConnection(ws, req, targetHost, targetPort, label, options = {}) {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.socket.remoteAddress
        || 'unknown';

    // Rate limit connections per IP
    const currentCount = connectionsPerIp.get(clientIp) || 0;
    if (currentCount >= MAX_CONNECTIONS_PER_IP) {
        console.warn(`WS proxy [${label}]: Connection limit reached for ${clientIp}`);
        ws.close(1008, 'Too many connections');
        return;
    }
    connectionsPerIp.set(clientIp, currentCount + 1);

    // Idle timeout
    let idleTimer = null;
    const messageTransport = options.messageTransport === true;
    const relayDecoder = messageTransport ? createRelayFrameDecoder() : null;
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
            if (!messageTransport) {
                ws.send(data);
                return;
            }
            try {
                for (const payload of relayDecoder.feed(data)) {
                    ws.send(payload, { binary: true });
                }
            } catch (err) {
                console.error(`WS proxy [${label}]: invalid relay TCP frame:`, err.message);
                cleanup();
            }
        }
    });

    // WebSocket -> TCP
    ws.on('message', (data) => {
        resetIdleTimer();
        if (!tcp.destroyed) {
            // Ensure we send Buffer, not string
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            if (messageTransport && buf.length === 0) return;
            try {
                tcp.write(messageTransport ? encodeRelayFrame(buf) : buf);
            } catch (err) {
                console.error(`WS proxy [${label}]: invalid relay WS frame:`, err.message);
                cleanup();
            }
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

        // Decrement connection counter
        const count = connectionsPerIp.get(clientIp) || 1;
        if (count <= 1) {
            connectionsPerIp.delete(clientIp);
        } else {
            connectionsPerIp.set(clientIp, count - 1);
        }
    }
}

module.exports = {
    initWsProxy,
    // Exported for deterministic framing tests; not part of the HTTP API.
    _relayFraming: { encodeRelayFrame, createRelayFrameDecoder, MAX_RELAY_FRAME_SIZE }
};
