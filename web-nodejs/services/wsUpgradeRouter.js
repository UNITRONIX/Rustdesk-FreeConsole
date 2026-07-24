/**
 * Shared WebSocket upgrade router for the BetterDesk console HTTP server.
 *
 * Previously each WS service called server.on('upgrade'), which stacked 11
 * listeners and triggered Node's MaxListenersExceededWarning (default max=10).
 * Reconnects never added listeners — the warning was a false-positive leak
 * signal (GitHub #295). This module attaches exactly one upgrade listener per
 * server and dispatches by pathname.
 */

'use strict';

/** @type {WeakMap<object, { routes: Array<{ match: Function, handle: Function }> }>} */
const routers = new WeakMap();

/**
 * Ensure a single upgrade dispatcher is attached to the given server.
 * @param {import('http').Server|import('events').EventEmitter} server
 */
function ensureRouter(server) {
    let state = routers.get(server);
    if (state) return state;

    state = { routes: [] };
    routers.set(server, state);

    server.on('upgrade', (req, socket, head) => {
        let pathname;
        try {
            pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
        } catch {
            try {
                socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            } catch (_) { /* closed */ }
            try { socket.destroy(); } catch (_) { /* closed */ }
            return;
        }

        for (const route of state.routes) {
            if (route.match(pathname, req)) {
                route.handle(req, socket, head);
                return;
            }
        }
        // No registered route — leave the socket alone (same as the old
        // multi-listener chain when every handler early-returned).
    });

    return state;
}

/**
 * Register a WebSocket upgrade handler on the shared per-server router.
 * Idempotent with respect to the HTTP listener: only one server.on('upgrade')
 * is ever attached per server instance.
 *
 * @param {import('http').Server|import('events').EventEmitter} server
 * @param {(pathname: string, req: import('http').IncomingMessage) => boolean} match
 * @param {(req: import('http').IncomingMessage, socket: import('net').Socket, head: Buffer) => void} handle
 */
function registerUpgradeHandler(server, match, handle) {
    if (!server || typeof server.on !== 'function') {
        throw new TypeError('registerUpgradeHandler: server must be an EventEmitter');
    }
    if (typeof match !== 'function' || typeof handle !== 'function') {
        throw new TypeError('registerUpgradeHandler: match and handle must be functions');
    }
    const state = ensureRouter(server);
    state.routes.push({ match, handle });
}

/**
 * Number of routes registered for this server (for tests / diagnostics).
 * @param {object} server
 * @returns {number}
 */
function registeredRouteCount(server) {
    const state = routers.get(server);
    return state ? state.routes.length : 0;
}

module.exports = {
    registerUpgradeHandler,
    registeredRouteCount,
};
