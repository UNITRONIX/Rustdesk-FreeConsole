/**
 * Security tests for WebSocket relay upgrade handler.
 * 
 * Verifies that /ws/rendezvous and /ws/relay reject unauthenticated requests
 * and that only sessions with a valid userId are allowed to upgrade.
 * 
 * These tests cover BD-2026-003 (wsRelay session validation bypass).
 */

const http = require('http');
const net = require('net');

// ──────────────────────────────────────────────────────────────────────────────
// Helper: send a raw HTTP upgrade request to a server and collect the response
// Returns Promise<{ statusLine: string, headers: string, raw: string }>
// ──────────────────────────────────────────────────────────────────────────────
function rawUpgrade(serverAddress, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const { port } = serverAddress;
        const socket = net.createConnection(port, '127.0.0.1');
        let data = '';

        socket.setTimeout(3000);
        socket.on('timeout', () => { socket.destroy(); reject(new Error('timeout')); });
        socket.on('error', reject);

        socket.on('data', chunk => {
            data += chunk.toString();
            // Once we have the response line+headers, stop
            if (data.includes('\r\n\r\n')) {
                socket.destroy();
                const [statusLine, ...rest] = data.split('\r\n');
                resolve({ statusLine, headers: rest.join('\r\n'), raw: data });
            }
        });

        socket.on('connect', () => {
            const headerLines = Object.entries(headers)
                .map(([k, v]) => `${k}: ${v}`)
                .join('\r\n');

            socket.write(
                `GET ${path} HTTP/1.1\r\n` +
                `Host: 127.0.0.1:${port}\r\n` +
                `Upgrade: websocket\r\n` +
                `Connection: Upgrade\r\n` +
                `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
                `Sec-WebSocket-Version: 13\r\n` +
                (headerLines ? headerLines + '\r\n' : '') +
                '\r\n'
            );
        });
    });
}

// ──────────────────────────────────────────────────────────────────────────────
// Build a minimal HTTP server wired with initWsProxy
// ──────────────────────────────────────────────────────────────────────────────
function buildServer(sessionStub) {
    const server = http.createServer((req, res) => {
        res.writeHead(404); res.end();
    });

    const { initWsProxy } = require('../services/wsRelay');
    initWsProxy(server, sessionStub);
    return server;
}

describe('wsRelay — security: session validation on WS upgrade', () => {
    let server;
    let address;

    afterEach(done => {
        if (server && server.listening) {
            // Force-close keep-alive or unhandled connections before calling done()
            if (typeof server.closeAllConnections === 'function') {
                server.closeAllConnections();
            }
            server.close(done);
        } else {
            done();
        }
    });

    // Clears module cache so each test gets a fresh initWsProxy instance
    beforeEach(() => {
        jest.resetModules();
    });

    // ── Test: unauthenticated request is rejected with 401 ────────────────────
    test('rejects upgrade without a session (no cookie)', async () => {
        const noSession = (req, _res, next) => {
            // Simulate session store finding no session
            req.session = null;
            next();
        };

        const { initWsProxy } = require('../services/wsRelay');
        server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
        initWsProxy(server, noSession);

        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        address = server.address();

        const result = await rawUpgrade(address, '/ws/rendezvous');
        expect(result.statusLine).toBe('HTTP/1.1 401 Unauthorized');
    });

    // ── Test: empty session (no userId) is rejected with 401 ─────────────────
    test('rejects upgrade when session exists but has no userId', async () => {
        const emptySession = (req, _res, next) => {
            req.session = {}; // session populated, but no userId
            next();
        };

        const { initWsProxy } = require('../services/wsRelay');
        server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
        initWsProxy(server, emptySession);

        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        address = server.address();

        const result = await rawUpgrade(address, '/ws/rendezvous');
        expect(result.statusLine).toBe('HTTP/1.1 401 Unauthorized');
    });

    // ── Test: relay path also rejected without session ────────────────────────
    test('rejects /ws/relay upgrade without userId', async () => {
        const emptySession = (req, _res, next) => {
            req.session = {};
            next();
        };

        const { initWsProxy } = require('../services/wsRelay');
        server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
        initWsProxy(server, emptySession);

        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        address = server.address();

        const result = await rawUpgrade(address, '/ws/relay');
        expect(result.statusLine).toBe('HTTP/1.1 401 Unauthorized');
    });

    // ── Test: missing sessionMiddleware returns 503 ───────────────────────────
    test('returns 503 when sessionMiddleware is not provided', async () => {
        const { initWsProxy } = require('../services/wsRelay');
        server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
        initWsProxy(server, undefined); // no middleware

        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        address = server.address();

        const result = await rawUpgrade(address, '/ws/rendezvous');
        expect(result.statusLine).toBe('HTTP/1.1 503 Service Unavailable');
    });

    // ── Test: authenticated session is passed through (101 upgrade attempted) ─
    test('allows upgrade when session has a valid userId', async () => {
        // Middleware that simulates an authenticated session
        const authSession = (req, _res, next) => {
            req.session = { userId: 42, user: { username: 'admin', role: 'admin' } };
            next();
        };

        const { initWsProxy } = require('../services/wsRelay');
        server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
        initWsProxy(server, authSession);

        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        address = server.address();

        // The upgrade will attempt to connect to the Go server TCP port which may
        // be unavailable in CI. We expect either:
        //   101 Switching Protocols  — server running, upgrade accepted
        //   502 / 503 / closed       — backend not available (CI)
        // What we must NOT see is 401 Unauthorized.
        let statusLine = '';
        try {
            const result = await rawUpgrade(address, '/ws/rendezvous');
            statusLine = result.statusLine;
        } catch {
            // Socket closed by server before sending a response = backend refused
            // the TCP proxy target. That's fine — we just need to confirm auth passed.
            statusLine = 'SOCKET_CLOSED';
        }

        expect(statusLine).not.toBe('HTTP/1.1 401 Unauthorized');
        expect(statusLine).not.toBe('HTTP/1.1 503 Service Unavailable');
    });

    // ── Test: non-empty guest= without valid grant is rejected ───────────────
    test('rejects upgrade when guest query is present but token is invalid', async () => {
        jest.resetModules();
        jest.doMock('../services/betterdeskApi', () => ({
            apiClient: {
                get: jest.fn().mockResolvedValue({ data: { valid: false, error: 'invalid' } }),
            },
        }));

        const noSession = (req, _res, next) => {
            req.session = null;
            next();
        };

        const { initWsProxy } = require('../services/wsRelay');
        server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
        initWsProxy(server, noSession);

        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        address = server.address();

        const result = await rawUpgrade(address, '/ws/rendezvous?guest=not-a-real-token');
        expect(result.statusLine).toBe('HTTP/1.1 401 Unauthorized');
    });

    // ── Test: non-ws-relay paths are not handled by initWsProxy ──────────────
    test('does not intercept paths outside /ws/rendezvous and /ws/relay', () => {
        const EventEmitter = require('events');
        const { initWsProxy } = require('../services/wsRelay');

        // Use an EventEmitter as a stand-in for an HTTP server — no TCP socket needed
        const fakeServer = new EventEmitter();

        const middlewareCalled = [];
        const stubMiddleware = (req, _res, next) => {
            middlewareCalled.push(req.url);
            next();
        };

        initWsProxy(fakeServer, stubMiddleware);

        // Simulate an upgrade event for a path that wsRelay does NOT own
        const fakeSocket = { write: jest.fn(), destroy: jest.fn() };
        const fakeRequest = {
            url: '/ws/chat',
            headers: { host: 'localhost:5000' },
            socket: { remoteAddress: '127.0.0.1' }
        };

        fakeServer.emit('upgrade', fakeRequest, fakeSocket, Buffer.alloc(0));

        // wsRelay returns early for non-owned paths — session middleware never called
        expect(middlewareCalled).toHaveLength(0);
        // No 401 or 503 written to socket for an unrelated path
        expect(fakeSocket.write).not.toHaveBeenCalled();

        // No server to close — no async cleanup needed
        server = null;
    });
});
