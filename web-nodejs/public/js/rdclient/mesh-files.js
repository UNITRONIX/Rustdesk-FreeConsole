/**
 * MeshCentral remote files protocol (relay p=5) for BetterDesk mesh transport.
 */
(function () {
    'use strict';

    var CTRL = '102938';
    var PROTOCOL = '5';

    function MeshFileTransfer(deviceId, emit) {
        this._deviceId = deviceId;
        this._emit = emit || function () {};
        this._ws = null;
        this._enabled = false;
        this._currentPath = '';
        this._showHidden = false;
        this._nextId = 1;
        this._nextReqId = 1;
        this._transfers = new Map();
        this._browseTimeout = null;
        this._browseTimedOut = false;
        this._connecting = null;
        this._relayReady = false;
        this._protocolSent = false;
    }

    MeshFileTransfer.prototype.enable = function () {
        this._enabled = true;
    };

    MeshFileTransfer.prototype.disable = function () {
        this._enabled = false;
        this.cancelAll();
        if (this._ws) {
            try { this._ws.close(); } catch { /* ignore */ }
            this._ws = null;
        }
        this._relayReady = false;
        this._protocolSent = false;
    };

    Object.defineProperty(MeshFileTransfer.prototype, 'enabled', {
        get: function () { return this._enabled; }
    });
    Object.defineProperty(MeshFileTransfer.prototype, 'currentPath', {
        get: function () { return this._currentPath; }
    });

    MeshFileTransfer.prototype._ensureConnected = function () {
        if (this._ws && this._ws.readyState === WebSocket.OPEN && this._relayReady) {
            return Promise.resolve();
        }
        if (this._connecting) return this._connecting;

        var self = this;
        this._connecting = (async function () {
            var relayBase = window.location.origin + '/';
            var resp = await fetch(
                '/api/mesh/devices/' + encodeURIComponent(self._deviceId) + '/files?relay_base=' + encodeURIComponent(relayBase),
                {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                }
            );
            if (!resp.ok) {
                var err = await resp.json().catch(function () { return {}; });
                throw new Error(err.error || 'Mesh files tunnel failed');
            }
            var data = await resp.json();
            var url = data.browser_url || data.data && data.data.browser_url;
            if (!url) throw new Error('No mesh relay URL');
            var wsUrl = url.indexOf('http') === 0 ? url.replace(/^http/, 'ws') : window.location.origin + url;

            return new Promise(function (resolve, reject) {
                var ws = new WebSocket(wsUrl);
                ws.binaryType = 'arraybuffer';
                self._ws = ws;
                self._relayReady = false;
                self._protocolSent = false;

                ws.onopen = function () { /* wait for c */ };
                ws.onerror = function () {
                    reject(new Error('Mesh files relay error'));
                };
                ws.onclose = function () {
                    self._relayReady = false;
                    self._ws = null;
                };
                ws.onmessage = function (ev) {
                    if (typeof ev.data === 'string') {
                        if (ev.data === 'c' || ev.data === 'cr') {
                            if (!self._relayReady) {
                                self._relayReady = true;
                                ws.send(PROTOCOL);
                                self._protocolSent = true;
                                resolve();
                            }
                        }
                        return;
                    }
                    self._onBinary(ev.data);
                };

                setTimeout(function () {
                    if (!self._relayReady) {
                        reject(new Error('Mesh files relay timeout'));
                        try { ws.close(); } catch { /* ignore */ }
                    }
                }, 30000);
            });
        })().finally(function () {
            self._connecting = null;
        });

        return this._connecting;
    };

    MeshFileTransfer.prototype._sendJson = function (obj) {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
        this._ws.send(JSON.stringify(obj));
    };

    MeshFileTransfer.prototype._onBinary = function (data) {
        var buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer || data);
        if (buf.length === 0) return;

        if (buf[0] === 123) {
            try {
                var text = new TextDecoder().decode(buf);
                this._onJson(text);
            } catch { /* ignore */ }
            return;
        }

        for (var id of this._transfers.keys()) {
            var t = this._transfers.get(id);
            if (t && t.type === 'download' && t.status === 'transferring') {
                var off = buf[0] === 0 ? 1 : 0;
                t.receivedBytes += buf.length - off;
                t.chunks.push(buf.slice(off));
                this._emit('file_transfer_progress', {
                    id: id,
                    received: t.receivedBytes,
                    total: t.fileSize,
                });
                if (t.fileSize > 0 && t.receivedBytes >= t.fileSize) {
                    this._finishDownload(id);
                }
                return;
            }
        }
    };

    MeshFileTransfer.prototype._onJson = function (text) {
        var msg;
        try { msg = JSON.parse(text); } catch { return; }

        if (msg.ctrlChannel === CTRL) return;

        if (msg.action === 'ls' && msg.dir) {
            this._browseTimedOut = true;
            if (this._browseTimeout) clearTimeout(this._browseTimeout);
            this._currentPath = msg.path || '';
            var entries = (msg.dir || []).map(function (e) {
                var name = e.n || '';
                var isDir = name.indexOf('.') === -1 && (e.s === 0 || e.s === undefined);
                return {
                    name: name,
                    size: e.s || 0,
                    modifiedTime: (e.dt || 0) * 1000,
                    isDir: isDir,
                    entry_type: isDir ? 0 : 4,
                };
            });
            this._emit('file_dir', { path: this._currentPath, entries: entries });
            return;
        }

        if (msg.action === 'uploadack' && msg.reqid) {
            var upload = null;
            for (var id of this._transfers.keys()) {
                var t = this._transfers.get(id);
                if (t && t.type === 'upload' && t.reqid === msg.reqid) {
                    upload = t;
                    break;
                }
            }
            if (upload && upload.pendingChunk) {
                this._sendUploadChunk(upload.pendingChunk);
                upload.pendingChunk = null;
                if (upload.offset >= upload.fileSize) {
                    this._emit('file_transfer_complete', { id: upload.id, type: 'upload' });
                    this._transfers.delete(upload.id);
                }
            }
            return;
        }

        if (msg.action === 'uploaderror' || msg.action === 'downloaderror') {
            this._emit('file_transfer_error', { id: msg.reqid, error: msg.action });
        }
    };

    MeshFileTransfer.prototype.browseDir = function (path) {
        if (!this._enabled) return;
        var dir = path != null ? path : '';
        var self = this;
        this._emit('file_browsing', { path: dir });
        this._browseTimedOut = false;
        if (this._browseTimeout) clearTimeout(this._browseTimeout);
        this._browseTimeout = setTimeout(function () {
            if (!self._browseTimedOut) {
                self._browseTimedOut = true;
                self._emit('file_browse_timeout', { path: dir });
            }
        }, 8000);

        this._ensureConnected().then(function () {
            var reqid = self._nextReqId++;
            self._sendJson({ action: 'ls', path: dir, reqid: reqid });
        }).catch(function (err) {
            self._emit('error', { message: err.message });
        });
    };

    MeshFileTransfer.prototype.browseParent = function () {
        if (!this._currentPath) return;
        var parent = this._currentPath.replace(/[\\/]+$/, '');
        var sep = parent.indexOf('\\') >= 0 ? '\\' : '/';
        var lastSep = parent.lastIndexOf(sep);
        if (lastSep > 0) parent = parent.substring(0, lastSep);
        else if (lastSep === 0) parent = sep;
        else parent = '';
        this.browseDir(parent);
    };

    MeshFileTransfer.prototype.createDir = function (path) {
        var self = this;
        this._ensureConnected().then(function () {
            self._sendJson({ action: 'mkdir', path: path });
        }).catch(function () {});
    };

    MeshFileTransfer.prototype.removeFile = function (path) {
        var parts = path.replace(/\\/g, '/').split('/');
        var name = parts.pop();
        var dir = parts.join('/') || '/';
        var self = this;
        this._ensureConnected().then(function () {
            self._sendJson({ action: 'rm', path: dir, delfiles: [name] });
        }).catch(function () {});
    };

    MeshFileTransfer.prototype.removeDir = function (path, recursive) {
        var parts = path.replace(/\\/g, '/').split('/');
        var name = parts.pop();
        var dir = parts.join('/') || '/';
        var self = this;
        this._ensureConnected().then(function () {
            self._sendJson({ action: 'rm', path: dir, delfiles: [name], rec: recursive ? 1 : 0 });
        }).catch(function () {});
    };

    MeshFileTransfer.prototype.rename = function () { /* not supported by BetterCore files */ };

    MeshFileTransfer.prototype.downloadFile = function (remotePath, fileEntry) {
        if (!this._enabled) return -1;
        var id = this._nextId++;
        var self = this;
        var transfer = {
            id: id,
            type: 'download',
            remotePath: remotePath,
            fileName: fileEntry.name,
            fileSize: Number(fileEntry.size || 0),
            receivedBytes: 0,
            chunks: [],
            status: 'pending',
            reqid: this._nextReqId++,
        };
        this._transfers.set(id, transfer);
        var sep = remotePath.indexOf('\\') >= 0 ? '\\' : '/';
        var fullPath = remotePath + (remotePath.endsWith(sep) ? '' : sep) + fileEntry.name;

        this._emit('file_transfer_start', {
            id: id,
            type: 'download',
            fileName: fileEntry.name,
            fileSize: transfer.fileSize,
        });

        this._ensureConnected().then(function () {
            transfer.status = 'transferring';
            self._sendJson({ action: 'download', path: fullPath, reqid: transfer.reqid });
        }).catch(function (err) {
            self._emit('file_transfer_error', { id: id, error: err.message });
            self._transfers.delete(id);
        });

        return id;
    };

    MeshFileTransfer.prototype._finishDownload = function (id) {
        var t = this._transfers.get(id);
        if (!t) return;
        var blob = new Blob(t.chunks);
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = t.fileName;
        a.click();
        URL.revokeObjectURL(url);
        this._emit('file_transfer_complete', { id: id, type: 'download' });
        this._transfers.delete(id);
    };

    MeshFileTransfer.prototype.uploadFile = function (file, remotePath) {
        if (!this._enabled) return -1;
        var id = this._nextId++;
        var self = this;
        var sep = remotePath.indexOf('\\') >= 0 ? '\\' : '/';
        var fullPath = remotePath + (remotePath.endsWith(sep) ? '' : sep) + file.name;
        var transfer = {
            id: id,
            type: 'upload',
            file: file,
            fileSize: file.size,
            offset: 0,
            reqid: this._nextReqId++,
            pendingChunk: null,
        };
        this._transfers.set(id, transfer);

        this._emit('file_transfer_start', {
            id: id,
            type: 'upload',
            fileName: file.name,
            fileSize: file.size,
        });

        this._ensureConnected().then(function () {
            self._sendJson({ action: 'upload', path: fullPath, reqid: transfer.reqid });
            self._readUploadChunk(transfer);
        }).catch(function (err) {
            self._emit('file_transfer_error', { id: id, error: err.message });
            self._transfers.delete(id);
        });

        return id;
    };

    MeshFileTransfer.prototype._readUploadChunk = function (transfer) {
        var chunkSize = 65536;
        var start = transfer.offset;
        var end = Math.min(start + chunkSize, transfer.fileSize);
        var slice = transfer.file.slice(start, end);
        var self = this;
        slice.arrayBuffer().then(function (buf) {
            transfer.offset = end;
            transfer.pendingChunk = new Uint8Array(buf);
            if (transfer.pendingChunk.length === 0) return;
            self._sendUploadChunk(transfer.pendingChunk);
        });
    };

    MeshFileTransfer.prototype._sendUploadChunk = function (chunk) {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
        var out = new Uint8Array(chunk.length + 1);
        out[0] = 0;
        out.set(chunk, 1);
        this._ws.send(out);
    };

    MeshFileTransfer.prototype.cancelTransfer = function (id) {
        if (this._transfers.has(id)) {
            this._transfers.delete(id);
            this._emit('file_transfer_cancelled', { id: id });
            return true;
        }
        return false;
    };

    MeshFileTransfer.prototype.cancelAll = function () {
        this._transfers.clear();
    };

    window.MeshFileTransfer = MeshFileTransfer;
})();
