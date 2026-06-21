/**
 * BetterViewer — BetterDesk browser remote desktop (MNG_KVM protocol, AGPL-3.0).
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (c) BetterDesk contributors
 */
(function (global) {
    'use strict';

    var CMD_TILE = 3;
    var CMD_SCREEN = 7;
    var CMD_GET_DISPLAYS = 11;
    var CMD_INPUT_LOCK = 87;
    var CMD_KEYSTATE = 18;

    var INPUT_KEY = 1;
    var INPUT_MOUSE = 2;
    var INPUT_CTRLALTDEL = 10;
    var INPUT_TOUCH = 15;
    var INPUT_KEYUNICODE = 85;

    var KEY_DOWN = 1;
    var KEY_UP = 2;
    var KEY_SCROLL = 3;

    var MOUSE_LEFT = 0x02;
    var MOUSE_RIGHT = 0x08;
    var MOUSE_MIDDLE = 0x20;

    var MESH_KVM_MAGIC = [0x11, 0xFE, 0x00, 0x00, 0x4D, 0x45, 0x53, 0x48, 0x00, 0x00, 0x00, 0x00, 0x02];

    function shortToBytes(v) {
        return [(v >> 8) & 0xFF, v & 0xFF];
    }

    function BetterViewer(canvas, opts) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.opts = opts || {};
        this._ws = null;
        this._relayReady = false;
        this._protocolSent = false;
        this._accum = new Uint8Array(0);
        this._state = 0;
        this._screenW = 0;
        this._screenH = 0;
        this._tilesPending = [];
        this._tilesDrawn = 0;
        this._tilesReceived = 0;
        this._killDraw = 0;
        this._imageType = 1;
        this._compression = 50;
        this._scaling = 1024;
        this._frameTimer = 100;
        this._handlers = {};
        this._stats = { fps: 0, bitrate: 0, frames: 0, bytes: 0 };
        this._statsTimer = null;
        this._lastStats = Date.now();
        this._inputGrabbed = false;
        this._pressedKeys = [];
    }

    BetterViewer.prototype.on = function (event, fn) {
        if (!this._handlers[event]) this._handlers[event] = [];
        this._handlers[event].push(fn);
    };

    BetterViewer.prototype._emit = function (event, data) {
        var list = this._handlers[event] || [];
        for (var i = 0; i < list.length; i++) list[i](data);
    };

    BetterViewer.prototype.attachWebSocket = function (ws) {
        var self = this;
        this._ws = ws;
        this._relayReady = false;
        this._protocolSent = false;
        this._accum = new Uint8Array(0);
        this._state = 0;

        ws.binaryType = 'arraybuffer';

        ws.addEventListener('message', function (ev) {
            if (typeof ev.data === 'string') {
                if (ev.data === 'c' || ev.data === 'cr') {
                    self._onRelayReady();
                }
                return;
            }
            self._onBinary(ev.data);
        });
    };

    BetterViewer.prototype._onRelayReady = function () {
        if (this._relayReady) return;
        this._relayReady = true;
        if (!this._protocolSent && this._ws && this._ws.readyState === 1) {
            this._ws.send('2');
            this._protocolSent = true;
        }
        this._state = 3;
        this._emit('state', 'streaming');
        this._emit('ready');
        this._emit('session_start');
        this._grabInput();
        this._startStats();
    };

    BetterViewer.prototype._startStats = function () {
        var self = this;
        if (this._statsTimer) clearInterval(this._statsTimer);
        this._statsTimer = setInterval(function () {
            var now = Date.now();
            var elapsed = (now - self._lastStats) / 1000;
            if (elapsed > 0) {
                self._stats.fps = Math.round(self._stats.frames / elapsed);
                self._stats.bitrate = Math.round((self._stats.bytes * 8) / elapsed);
            }
            self._stats.frames = 0;
            self._stats.bytes = 0;
            self._lastStats = now;
            self._emit('stats', { fps: self._stats.fps, bitrate: self._stats.bitrate });
        }, 1000);
    };

    BetterViewer.prototype._sendRaw = function (bytes) {
        if (!this._ws || this._ws.readyState !== 1) return;
        this._ws.send(bytes);
    };

    BetterViewer.prototype._sendPacket = function (cmd, payload) {
        var plen = payload ? payload.length : 0;
        var total = 4 + plen;
        var buf = new Uint8Array(total);
        buf[0] = 0;
        buf[1] = cmd & 0xFF;
        buf[2] = (total >> 8) & 0xFF;
        buf[3] = total & 0xFF;
        if (payload) buf.set(payload, 4);
        this._sendRaw(buf);
    };

    BetterViewer.prototype._sendCompression = function () {
        var payload = new Uint8Array(6);
        payload[0] = this._imageType;
        payload[1] = this._compression;
        payload[2] = (this._scaling >> 8) & 0xFF;
        payload[3] = this._scaling & 0xFF;
        payload[4] = (this._frameTimer >> 8) & 0xFF;
        payload[5] = this._frameTimer & 0xFF;
        this._sendPacket(5, payload);
    };

    BetterViewer.prototype._sendUnpause = function () {
        var payload = new Uint8Array(1);
        payload[0] = 0;
        this._sendPacket(8, payload);
    };

    BetterViewer.prototype._sendRemoteInputLockQuery = function () {
        var payload = new Uint8Array(1);
        payload[0] = 2;
        this._sendPacket(87, payload);
    };

    BetterViewer.prototype._mergeAccum = function (chunk) {
        var incoming = new Uint8Array(chunk);
        var merged = new Uint8Array(this._accum.length + incoming.length);
        merged.set(this._accum);
        merged.set(incoming, this._accum.length);
        this._accum = merged;
    };

    BetterViewer.prototype._onBinary = function (chunk) {
        if (!this._relayReady) {
            this._onRelayReady();
        }
        this._stats.bytes += chunk.byteLength || chunk.length || 0;
        this._mergeAccum(chunk);
        this._processAccum();
    };

    BetterViewer.prototype._processAccum = function () {
        while (this._accum.length >= 4) {
            if (this._accum[0] === 0x11 && this._accum[1] === 0xFE) {
                var skip = Math.min(this._accum.length, 13);
                this._accum = this._accum.slice(skip);
                continue;
            }
            if (this._accum[0] !== 0) {
                this._accum = this._accum.slice(1);
                continue;
            }
            var total = (this._accum[2] << 8) | this._accum[3];
            if (total < 4 || total > 65535) {
                this._accum = this._accum.slice(1);
                continue;
            }
            if (this._accum.length < total) break;
            var packet = this._accum.slice(0, total);
            this._accum = this._accum.slice(total);
            this._handlePacket(packet);
        }
    };

    BetterViewer.prototype._handlePacket = function (view) {
        if (view.length < 4) return;
        var cmd = view[1];

        if (cmd === CMD_TILE) {
            var x = (view[4] << 8) | view[5];
            var y = (view[6] << 8) | view[7];
            var jpeg = view.slice(8);
            this._drawTile(jpeg, x, y);
        } else if (cmd === CMD_SCREEN) {
            var w = (view[4] << 8) | view[5];
            var h = (view[6] << 8) | view[7];
            this._setScreenSize(w, h);
        } else if (cmd === CMD_GET_DISPLAYS) {
            /* optional multi-display UI */
        } else if (cmd === CMD_KEYSTATE && view.length >= 5) {
            this._emit('keyboardState', view[4]);
        } else if (cmd === CMD_INPUT_LOCK && view.length >= 5) {
            this._emit('inputLock', view[4] !== 0);
        }
    };

    BetterViewer.prototype._setScreenSize = function (w, h) {
        if (w <= 0 || h <= 0) return;
        this._screenW = w;
        this._screenH = h;
        this.canvas.width = w;
        this.canvas.height = h;
        this._tilesPending = [];
        this._tilesDrawn = 0;
        this._tilesReceived = 0;
        this._killDraw = 0;
        this._sendCompression();
        this._sendUnpause();
        this._sendRemoteInputLockQuery();
        this._emit('videoFrame', { width: w, height: h });
    };

    BetterViewer.prototype._drawTile = function (jpegBytes, x, y) {
        var self = this;
        var seq = ++this._tilesReceived;
        var blob = new Blob([jpegBytes], { type: 'image/jpeg' });
        createImageBitmap(blob).then(function (img) {
            self._tilesPending.push({ seq: seq, img: img, x: x, y: y });
            self._drainTiles();
        }).catch(function () { /* skip bad tile */ });
    };

    BetterViewer.prototype._drainTiles = function () {
        while (this._tilesPending.length > 0) {
            var next = this._tilesPending[0];
            if (next.seq !== this._tilesDrawn + 1) break;
            this._tilesPending.shift();
            this.ctx.drawImage(next.img, next.x, next.y);
            this._tilesDrawn++;
            this._stats.frames++;
            this._emit('videoFrame', { width: this._screenW, height: this._screenH });
        }
    };

    BetterViewer.prototype.sendCtrlAltDel = function () {
        this._sendPacket(INPUT_CTRLALTDEL, new Uint8Array(0));
    };

    BetterViewer.prototype._sendKeyKC = function (action, kc, extended) {
        var up = action - 1;
        if (extended) up = action === KEY_DOWN ? 3 : 4;
        var payload = new Uint8Array(2);
        payload[0] = up;
        payload[1] = kc & 0xFF;
        this._sendPacket(INPUT_KEY, payload);
    };

    BetterViewer.prototype._sendMouse = function (action, x, y, button, delta) {
        var payload = new Uint8Array(delta != null ? 8 : 6);
        payload[0] = 0;
        payload[1] = button;
        payload[2] = (x >> 8) & 0xFF;
        payload[3] = x & 0xFF;
        payload[4] = (y >> 8) & 0xFF;
        payload[5] = y & 0xFF;
        if (delta != null) {
            var d = delta < 0 ? (0x10000 + delta) : delta;
            payload[6] = (d >> 8) & 0xFF;
            payload[7] = d & 0xFF;
            this._sendPacket(INPUT_MOUSE, payload);
        } else {
            this._sendPacket(INPUT_MOUSE, payload);
        }
    };

    BetterViewer.prototype._canvasCoords = function (ev) {
        var rect = this.canvas.getBoundingClientRect();
        var scaleX = this.canvas.width / rect.width;
        var scaleY = this.canvas.height / rect.height;
        var x = Math.floor((ev.clientX - rect.left) * scaleX);
        var y = Math.floor((ev.clientY - rect.top) * scaleY);
        return { x: x, y: y };
    };

    BetterViewer.prototype._grabInput = function () {
        if (this._inputGrabbed) return;
        var self = this;
        this._inputGrabbed = true;

        this.canvas.addEventListener('mousedown', function (e) {
            var c = self._canvasCoords(e);
            var btn = e.button === 2 ? MOUSE_RIGHT : (e.button === 1 ? MOUSE_MIDDLE : MOUSE_LEFT);
            self._sendMouse(KEY_DOWN, c.x, c.y, btn);
            e.preventDefault();
        });
        this.canvas.addEventListener('mouseup', function (e) {
            var c = self._canvasCoords(e);
            var btn = e.button === 2 ? MOUSE_RIGHT : (e.button === 1 ? MOUSE_MIDDLE : MOUSE_LEFT);
            self._sendMouse(KEY_UP, c.x, c.y, btn * 2);
            e.preventDefault();
        });
        this.canvas.addEventListener('mousemove', function (e) {
            var c = self._canvasCoords(e);
            self._sendMouse(0, c.x, c.y, 0);
            e.preventDefault();
        });
        this.canvas.addEventListener('wheel', function (e) {
            var c = self._canvasCoords(e);
            var delta = e.deltaY * -3;
            self._sendMouse(KEY_SCROLL, c.x, c.y, 0, delta);
            e.preventDefault();
        }, { passive: false });

        document.addEventListener('keydown', function (e) {
            if (self._state !== 3) return;
            self._sendKeyKC(KEY_DOWN, e.keyCode, false);
            e.preventDefault();
        });
        document.addEventListener('keyup', function (e) {
            if (self._state !== 3) return;
            self._sendKeyKC(KEY_UP, e.keyCode, false);
            e.preventDefault();
        });
    };

    BetterViewer.prototype.disconnect = function () {
        if (this._statsTimer) {
            clearInterval(this._statsTimer);
            this._statsTimer = null;
        }
        if (this._ws) {
            try { this._ws.close(); } catch (e) { /* ignore */ }
            this._ws = null;
        }
        this._state = 0;
        this._emit('state', 'disconnected');
        this._emit('disconnected');
    };

    global.BetterViewer = BetterViewer;
})(typeof window !== 'undefined' ? window : this);
