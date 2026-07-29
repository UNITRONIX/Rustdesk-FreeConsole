/**
 * BetterDesk Web Remote Client - Connection Manager
 * Handles WebSocket connections to hbbs (rendezvous) and hbbr (relay)
 * via the Node.js WS proxy endpoints.
 *
 * When opts.rdTransport === 'ws', appends ?rdTransport=ws so the panel
 * bridges to Go WSS (:21118/:21119) for WebSocket Mode agents (#314).
 */

// eslint-disable-next-line no-unused-vars
class RDConnection {
    /**
     * @param {Object} opts
     * @param {string} opts.baseUrl  - Base URL of the BetterDesk server (auto-detected)
     * @param {'native'|'ws'} [opts.rdTransport='native'] - Panel bridge mode
     */
    constructor(opts = {}) {
        const loc = window.location;
        const wsProtocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
        this.wsBase = opts.baseUrl || `${wsProtocol}//${loc.host}`;
        /** @type {'native'|'ws'} */
        this.rdTransport = opts.rdTransport === 'ws' ? 'ws' : 'native';

        /** @type {WebSocket|null} */
        this.rendezvousWs = null;
        /** @type {WebSocket|null} */
        this.relayWs = null;

        this._state = 'disconnected'; // disconnected | rendezvous | relay | connected | error
        this._listeners = {};
    }

    get state() { return this._state; }

    /**
     * Query string for WS auth (?guest=) and optional rdTransport=ws.
     * @returns {string} empty or "?…"
     */
    _wsQuerySuffix() {
        const params = new URLSearchParams();
        try {
            const q = new URLSearchParams(window.location.search);
            const token = q.get('guest') || q.get('t') || window.__guestToken || '';
            if (token) params.set('guest', token);
        } catch (_) { /* ignore */ }
        if (this.rdTransport === 'ws') {
            params.set('rdTransport', 'ws');
        }
        const s = params.toString();
        return s ? `?${s}` : '';
    }

    /**
     * @deprecated use _wsQuerySuffix
     * @returns {string}
     */
    _guestQuerySuffix() {
        return this._wsQuerySuffix();
    }

    // ---- Event emitter ----

    on(event, fn) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(fn);
        return this;
    }

    off(event, fn) {
        const arr = this._listeners[event];
        if (arr) this._listeners[event] = arr.filter(f => f !== fn);
        return this;
    }

    _emit(event, ...args) {
        const arr = this._listeners[event];
        if (arr) arr.forEach(fn => fn(...args));
    }

    // ---- Rendezvous connection ----

    /**
     * Connect to hbbs rendezvous server via WS proxy
     * @returns {Promise<WebSocket>}
     */
    connectRendezvous() {
        return new Promise((resolve, reject) => {
            this._setState('rendezvous');
            const url = `${this.wsBase}/ws/rendezvous${this._wsQuerySuffix()}`;

            const ws = new WebSocket(url);
            ws.binaryType = 'arraybuffer';

            ws.onopen = () => {
                this.rendezvousWs = ws;
                this._emit('rendezvous:open');
                resolve(ws);
            };

            ws.onerror = (e) => {
                this._emit('rendezvous:error', e);
                reject(new Error('Rendezvous connection failed'));
            };

            ws.onclose = (e) => {
                this.rendezvousWs = null;
                this._emit('rendezvous:close', e.code, e.reason);
            };

            ws.onmessage = (e) => {
                this._emit('rendezvous:message', e.data);
            };
        });
    }

    /**
     * Send binary data to rendezvous server
     * @param {Uint8Array} data
     */
    sendRendezvous(data) {
        if (this.rendezvousWs && this.rendezvousWs.readyState === WebSocket.OPEN) {
            this.rendezvousWs.send(data);
        }
    }

    /**
     * Close rendezvous connection
     */
    closeRendezvous() {
        if (this.rendezvousWs) {
            this.rendezvousWs.close();
            this.rendezvousWs = null;
        }
    }

    // ---- Relay connection ----

    /**
     * Connect to hbbr relay server via WS proxy
     * @returns {Promise<WebSocket>}
     */
    connectRelay() {
        return new Promise((resolve, reject) => {
            this._setState('relay');
            const url = `${this.wsBase}/ws/relay${this._wsQuerySuffix()}`;

            const ws = new WebSocket(url);
            ws.binaryType = 'arraybuffer';

            ws.onopen = () => {
                this.relayWs = ws;
                this._emit('relay:open');
                resolve(ws);
            };

            ws.onerror = (e) => {
                this._emit('relay:error', e);
                reject(new Error('Relay connection failed'));
            };

            ws.onclose = (e) => {
                this.relayWs = null;
                this._emit('relay:close', e.code, e.reason);
                if (this._state === 'connected') {
                    this._setState('disconnected');
                    this._emit('disconnected', e.reason || 'Connection closed');
                }
            };

            ws.onmessage = (e) => {
                this._emit('relay:message', e.data);
            };
        });
    }

    /**
     * Send binary data to relay server
     * @param {Uint8Array} data
     */
    sendRelay(data) {
        if (this.relayWs && this.relayWs.readyState === WebSocket.OPEN) {
            this.relayWs.send(data);
        }
    }

    /**
     * Mark connection as established
     */
    setConnected() {
        this._setState('connected');
    }

    /**
     * Close all connections
     */
    close() {
        this.closeRendezvous();
        if (this.relayWs) {
            this.relayWs.close();
            this.relayWs = null;
        }
        this._setState('disconnected');
    }

    _setState(state) {
        if (this._state !== state) {
            const prev = this._state;
            this._state = state;
            this._emit('state', state, prev);
        }
    }
}

// Export for browser
window.RDConnection = RDConnection;
