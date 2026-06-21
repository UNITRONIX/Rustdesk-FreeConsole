/**
 * BetterDesk Web Remote Client — MeshCentral transport adapter.
 * Uses BetterViewer (MNG_KVM) over meshrelay.
 */
(function () {
    'use strict';

    function MeshSession(canvas, opts) {
        this.canvas = canvas;
        this.opts = opts || {};
        this._handlers = {};
        this._state = 'idle';
        this._ws = null;
        this._desktop = null;
        this._deviceId = opts.deviceId || '';
    }

    MeshSession.prototype.on = function (event, fn) {
        if (!this._handlers[event]) this._handlers[event] = [];
        this._handlers[event].push(fn);
    };

    MeshSession.prototype._emit = function (event, data) {
        const list = this._handlers[event] || [];
        for (let i = 0; i < list.length; i++) list[i](data);
    };

    MeshSession.prototype._bindDesktop = function (desktop) {
        const self = this;
        desktop.on('state', function (s) { self._state = s; self._emit('state', s); });
        desktop.on('ready', function () { self._emit('ready'); });
        desktop.on('session_start', function () {
            self._emit('session_start');
            self._onStreaming();
        });
        desktop.on('disconnected', function () { self._emit('disconnected'); });
        desktop.on('videoFrame', function (f) { self._emit('videoFrame', f); });
        desktop.on('stats', function (s) { self._emit('stats', s); });
        desktop.on('inputLock', function (locked) { self._emit('cursorUpdate', { locked: locked }); });
        desktop.on('keyboardState', function (state) { self._emit('keyboardState', state); });
    };

    MeshSession.prototype.connect = async function () {
        this._state = 'connecting';
        this._emit('state', 'connecting');
        this._emit('log', 'Mesh: requesting desktop tunnel…');

        if (typeof BetterViewer !== 'function') {
            throw new Error('BetterViewer not loaded');
        }

        var self = this;
        this.fileTransfer = typeof MeshFileTransfer === 'function'
            ? new MeshFileTransfer(this._deviceId, function (event, data) { self._emit(event, data); })
            : {
                browseParent: function () {},
                browseDir: function () {},
                cancelTransfer: function () { return false; },
            };

        const relayBase = window.location.origin + '/';
        const resp = await fetch(`/api/mesh/devices/${encodeURIComponent(this._deviceId)}/desktop?relay_base=${encodeURIComponent(relayBase)}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.error || 'Mesh tunnel request failed');
        }
        const data = await resp.json();
        const url = data.browser_url || data.data?.browser_url;
        if (!url) throw new Error('No mesh relay URL');

        const wsUrl = url.startsWith('http') ? url.replace(/^http/, 'ws') : (window.location.origin + url);
        this._ws = new WebSocket(wsUrl);
        this._ws.binaryType = 'arraybuffer';

        this._desktop = new BetterViewer(this.canvas, this.opts);
        this._bindDesktop(this._desktop);
        this._desktop.attachWebSocket(this._ws);

        this._ws.onerror = () => this._emit('error', { message: 'Mesh relay error' });
        this._ws.onclose = () => this.disconnect();
    };

    MeshSession.prototype._onStreaming = function () {
        if (this.fileTransfer && typeof this.fileTransfer.enable === 'function') {
            this.fileTransfer.enable();
        }
    };

    MeshSession.prototype.disconnect = function () {
        if (this.fileTransfer && typeof this.fileTransfer.disable === 'function') {
            this.fileTransfer.disable();
        }
        if (this._desktop) {
            this._desktop.disconnect();
            this._desktop = null;
        }
        if (this._ws) {
            try { this._ws.close(); } catch { /* ignore */ }
            this._ws = null;
        }
        this._state = 'disconnected';
        this._emit('state', 'disconnected');
        this._emit('disconnected');
    };

    MeshSession.prototype.authenticate = function () { return Promise.resolve(); };
    MeshSession.prototype.verify2fa = function () { return Promise.resolve(); };

    window.MeshSession = MeshSession;
})();
