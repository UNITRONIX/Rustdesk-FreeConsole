/**
 * MeshCentral .ashx WebSocket proxy — panel HTTPS → Go API listener.
 * MeshAgent connects to wss://panel:5443/agent.ashx (no panel session; binary auth on Go).
 */

const WebSocket = require('ws');
const config = require('../config/config');
const { enforceOrigin } = require('../middleware/wsOrigin');
const { registerUpgradeHandler } = require('./wsUpgradeRouter');

const MESH_PATHS = new Set([
    '/agent.ashx',
    '/meshrelay.ashx',
    '/control.ashx',
]);

function goWsBase() {
    const base = config.betterdeskApiUrl || `http://127.0.0.1:${config.goApiPort || 21114}/api`;
    return base.replace(/^http/, 'ws').replace(/\/api\/?$/, '');
}

function initMeshAshxProxy(server, sessionMiddleware) {
    const wss = new WebSocket.Server({ noServer: true });

    registerUpgradeHandler(
        server,
        (pathname) => MESH_PATHS.has(pathname),
        (req, socket, head) => {
            const url = new URL(req.url, `http://${req.headers.host}`);

            const needsSession = url.pathname === '/control.ashx';
            const label = `mesh-${url.pathname}`;

            if (!enforceOrigin(req, socket, label)) return;

            const connect = () => {
                wss.handleUpgrade(req, socket, head, (browserWs) => {
                    const target = goWsBase() + url.pathname + (url.search || '');
                    const goWs = new WebSocket(target, {
                        headers: {
                            'x-forwarded-for': req.socket?.remoteAddress || '',
                        },
                    });

                    goWs.on('open', () => {
                        browserWs.on('message', (data, isBinary) => {
                            if (goWs.readyState === WebSocket.OPEN) {
                                goWs.send(data, { binary: isBinary });
                            }
                        });
                        goWs.on('message', (data, isBinary) => {
                            if (browserWs.readyState === WebSocket.OPEN) {
                                browserWs.send(data, { binary: isBinary });
                            }
                        });
                    });

                    goWs.on('error', (err) => {
                        console.warn('[mesh proxy]', url.pathname, err.message);
                        browserWs.close();
                    });
                    browserWs.on('close', () => goWs.close());
                    goWs.on('close', () => browserWs.close());
                    browserWs.on('error', () => goWs.close());
                });
            };

            if (needsSession) {
                sessionMiddleware(req, {}, () => {
                    if (!req.session || !req.session.userId) {
                        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                        socket.destroy();
                        return;
                    }
                    connect();
                });
            } else {
                connect();
            }
        }
    );
}

module.exports = { initMeshAshxProxy };
