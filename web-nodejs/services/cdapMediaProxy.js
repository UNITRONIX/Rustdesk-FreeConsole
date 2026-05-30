/**
 * BetterDesk Console — CDAP Media WebSocket Proxy
 * Proxies desktop/video/file-browser WebSocket connections from the
 * browser to the Go server's CDAP endpoints.
 *
 * Browser  ←WS→  Node.js (:5000)  ←WS→  Go API (:21121)
 */

const WebSocket = require('ws');
const config = require('../config/config');

/**
 * Create a CDAP media proxy for a specific channel type.
 * @param {import('http').Server} server
 * @param {Function} sessionMiddleware
 * @param {object} opts
 * @param {string} opts.channel     - URL segment: desktop, video, files
 * @param {string} opts.subprotocol - WebSocket subprotocol name
 * @param {string} opts.minRole     - Minimum required role: admin, operator, viewer
 * @param {string} opts.label       - Log label
 */
function createCdapMediaProxy(server, sessionMiddleware, opts) {
    const { channel, subprotocol, minRole, label } = opts;

    const pattern = new RegExp(
        `^\\/api\\/cdap\\/devices\\/([A-Za-z0-9_-]{1,64})\\/${channel}$`
    );

    // Role levels — keep in sync with middleware/auth.js DEFAULT_ROLE_PERMISSIONS
    // super_admin and admin (legacy alias) are the highest. global_admin and
    // server_admin sit just below (parallel branches). operator/viewer/pro below.
    const roleLevel = {
        super_admin: 5,
        admin: 5,
        global_admin: 4,
        server_admin: 4,
        operator: 2,
        viewer: 1,
        pro: 1
    };

    const wss = new WebSocket.Server({ noServer: true });
    const { enforceOrigin } = require('../middleware/wsOrigin');

    server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const match = url.pathname.match(pattern);
        if (!match) return;

        const deviceId = match[1];

        // CSWSH protection — reject before validating session.
        if (!enforceOrigin(req, socket, `cdap-${label} ${url.pathname}`)) return;

        sessionMiddleware(req, {}, () => {
            if (!req.session || !req.session.userId) {
                console.warn(`[CDAP ${label}] 401 upgrade rejected for ${url.pathname} (no session; ip=${req.socket?.remoteAddress})`);
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            // Session stores the user under req.session.user; older code paths
            // also write flat fields. Accept either shape.
            const sessUser = req.session.user || {};
            const userRole = sessUser.role || req.session.role || '';
            const userName = sessUser.username || req.session.username || `user#${req.session.userId}`;

            const userLevel = roleLevel[userRole] || 0;
            const requiredLevel = roleLevel[minRole] || 3;
            if (userLevel < requiredLevel) {
                console.warn(`[CDAP ${label}] 403 upgrade rejected for ${url.pathname} (user=${userName} role=${userRole} level=${userLevel} < required=${requiredLevel})`);
                socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                socket.destroy();
                return;
            }

            console.log(`[CDAP ${label}] Upgrade accepted for device=${deviceId} user=${userName} role=${userRole}`);

            // Attach normalized fields so the connection handler can use them.
            req._cdapUserName = userName;
            req._cdapUserRole = userRole;

            wss.handleUpgrade(req, socket, head, (ws) => {
                wss.emit('connection', ws, req, deviceId);
            });
        });
    });

    wss.on('connection', (browserWs, req, deviceId) => {
        const username = req._cdapUserName || req.session?.user?.username || req.session?.username || 'admin';
        const role = req._cdapUserRole || req.session?.user?.role || req.session?.role || 'admin';
        console.log(`[CDAP ${label}] Proxy started for device ${deviceId} by ${username} (role=${role})`);

        const goApiBase = config.betterdeskApiUrl || 'http://localhost:21121/api';
        const goWsUrl = goApiBase
            .replace(/^http/, 'ws')
            .replace(/\/api\/?$/, '') +
            `/api/cdap/devices/${encodeURIComponent(deviceId)}/${channel}`;

        const goWs = new WebSocket(goWsUrl, [subprotocol], {
            headers: {
                'X-API-Key': config.betterdeskApiKey || '',
                'X-Username': username,
                'X-Role': role
            },
            rejectUnauthorized: !config.allowSelfSignedCerts
        });

        let goConnected = false;
        // Buffer messages from browser that arrive before the upstream
        // Go WS connection is open. The browser sends an "init" frame
        // immediately on ws.onopen — without buffering, that message is
        // silently dropped and the Go server never replies with "ready",
        // so the UI hangs at "Connecting...".
        const pendingBrowserMsgs = [];

        goWs.on('open', () => {
            goConnected = true;
            while (pendingBrowserMsgs.length > 0) {
                const { data, binary } = pendingBrowserMsgs.shift();
                try { goWs.send(data, { binary }); } catch (_) { /* ignore */ }
            }
        });

        browserWs.on('message', (data, isBinary) => {
            if (goConnected && goWs.readyState === WebSocket.OPEN) {
                goWs.send(data, { binary: isBinary });
            } else if (goWs.readyState === WebSocket.CONNECTING) {
                pendingBrowserMsgs.push({ data, binary: isBinary });
            }
        });

        // CRITICAL: forward isBinary flag. Without it, `ws` defaults to
        // sending Buffer payloads as BINARY frames, but the Go server emits
        // JSON text frames (e.g. {"type":"ready"}, {"type":"frame"}).
        // The browser would receive Blobs that JSON.parse cannot handle,
        // so the "ready" handshake never fires and the overlay stays at
        // "Connecting..." while frames silently arrive as garbled binary.
        goWs.on('message', (data, isBinary) => {
            if (browserWs.readyState === WebSocket.OPEN) {
                browserWs.send(data, { binary: isBinary });
            }
        });

        browserWs.on('close', () => {
            console.log(`[CDAP ${label}] Browser disconnected for device ${deviceId}`);
            if (goWs.readyState === WebSocket.OPEN || goWs.readyState === WebSocket.CONNECTING) {
                goWs.close();
            }
        });

        goWs.on('close', () => {
            if (browserWs.readyState === WebSocket.OPEN) {
                browserWs.close();
            }
        });

        goWs.on('error', (err) => {
            console.error(`[CDAP ${label}] Go WS error for ${deviceId}:`, err.message);
            if (browserWs.readyState === WebSocket.OPEN) {
                browserWs.send(JSON.stringify({ type: 'error', error: 'Server connection failed' }));
                browserWs.close();
            }
        });

        browserWs.on('error', (err) => {
            console.error(`[CDAP ${label}] Browser WS error for ${deviceId}:`, err.message);
            if (goWs.readyState === WebSocket.OPEN) {
                goWs.close();
            }
        });
    });

    return wss;
}

/**
 * Initialize all CDAP media WebSocket proxies (desktop, video, file browser).
 * @param {import('http').Server} server
 * @param {Function} sessionMiddleware
 */
function initCdapMediaProxies(server, sessionMiddleware) {
    createCdapMediaProxy(server, sessionMiddleware, {
        channel: 'desktop',
        subprotocol: 'cdap-desktop',
        minRole: 'admin',
        label: 'Desktop'
    });

    createCdapMediaProxy(server, sessionMiddleware, {
        channel: 'video',
        subprotocol: 'cdap-video',
        minRole: 'operator',
        label: 'Video'
    });

    createCdapMediaProxy(server, sessionMiddleware, {
        channel: 'files',
        subprotocol: 'cdap-filebrowser',
        minRole: 'admin',
        label: 'FileBrowser'
    });

    createCdapMediaProxy(server, sessionMiddleware, {
        channel: 'audio',
        subprotocol: 'cdap-audio',
        minRole: 'operator',
        label: 'Audio'
    });

    console.log('[CDAP Media] WebSocket proxies initialized (desktop, video, files, audio)');
}

module.exports = { initCdapMediaProxies };
