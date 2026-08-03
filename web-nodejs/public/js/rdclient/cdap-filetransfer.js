/**
 * CDAP file transfer adapter — RDFileTransfer-compatible surface over the
 * existing /api/cdap/devices/:id/files WebSocket (same protocol as cdap-filebrowser.js).
 */
/* global */
// eslint-disable-next-line no-unused-vars
class CDAPFileTransfer {
    /**
     * @param {Object} opts
     * @param {string} opts.deviceId
     * @param {Function} opts.emit - (event, data) => void on the parent CDAPSession
     */
    constructor(opts) {
        this._deviceId = opts.deviceId;
        this._emit = opts.emit;
        this._ws = null;
        this._connected = false;
        this._currentPath = '/';
        this._entries = [];
        this._pending = {};
        this._nextId = 1;
        this._enabled = true;
        this._showHidden = false;
        this._connectPromise = null;
        this._saveDownload = null;
    }

    get currentPath() { return this._currentPath; }
    get enabled() { return this._enabled; }

    _needsFileConnection() {
        return !this._ws || this._ws.readyState !== WebSocket.OPEN;
    }

    ensureConnected() {
        if (!this._needsFileConnection()) return Promise.resolve();
        if (this._connectPromise) return this._connectPromise;

        this._emit('file_connecting');
        this._connectPromise = new Promise((resolve, reject) => {
            const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const url = `${proto}//${window.location.host}/api/cdap/devices/${encodeURIComponent(this._deviceId)}/files`;
            let ws;
            try {
                ws = new WebSocket(url, ['cdap-filebrowser']);
            } catch (err) {
                this._connectPromise = null;
                this._emit('file_connect_error', { error: err.message || String(err) });
                reject(err);
                return;
            }
            this._ws = ws;
            const timer = setTimeout(() => {
                try { ws.close(); } catch (_) { /* ok */ }
                this._connectPromise = null;
                this._emit('file_connect_error', { error: 'timeout' });
                reject(new Error('File transfer connection timeout'));
            }, 15000);

            ws.onopen = () => {
                clearTimeout(timer);
                this._connected = true;
                this._connectPromise = null;
                resolve();
            };
            ws.onmessage = (ev) => {
                try {
                    this._handleMessage(JSON.parse(ev.data));
                } catch (_) { /* ignore */ }
            };
            ws.onerror = () => {
                clearTimeout(timer);
                this._connectPromise = null;
                this._emit('file_connect_error', { error: 'websocket error' });
            };
            ws.onclose = () => {
                this._connected = false;
                this._ws = null;
                this._connectPromise = null;
            };
        });
        return this._connectPromise;
    }

    _send(payload) {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify(payload));
            return true;
        }
        return false;
    }

    _handleMessage(msg) {
        switch (msg.type) {
            case 'ready':
                break;
            case 'file_list_response':
                this._onList(msg);
                break;
            case 'file_read_response': {
                const cb = msg.request_id && this._pending[msg.request_id];
                if (cb) {
                    cb(msg);
                    delete this._pending[msg.request_id];
                }
                break;
            }
            case 'file_write_response':
            case 'file_delete_response':
                if (msg.error) {
                    this._emit('file_transfer_error', { id: 0, error: msg.error });
                } else {
                    this._emit('file_action');
                    this.browseDir(this._currentPath);
                }
                break;
            case 'error':
                this._emit('file_transfer_error', { id: 0, error: msg.error || 'Unknown error' });
                break;
            default:
                break;
        }
    }

    _onList(msg) {
        const path = msg.path || this._currentPath || '/';
        this._currentPath = path;
        const raw = msg.entries || [];
        this._entries = raw
            .filter((e) => this._showHidden || !(e.name || '').startsWith('.'))
            .map((e) => ({
                name: e.name,
                size: Number(e.size || 0),
                modifiedTime: e.modified || e.modified_time || 0,
                entryType: e.is_dir ? 0 : 4,
                isDir: !!e.is_dir,
            }))
            .sort((a, b) => {
                if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
                return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
            });
        this._emit('file_dir', { path: this._currentPath, entries: this._entries });
    }

    browseDir(path) {
        const dir = (path == null || path === '') ? '/' : path;
        this._emit('file_browsing', { path: dir });
        this.ensureConnected().then(() => {
            this._currentPath = dir;
            this._send({ type: 'file_list', path: dir });
        }).catch((err) => {
            this._emit('file_connect_error', { error: err.message || String(err) });
        });
    }

    browseParent() {
        if (!this._currentPath || this._currentPath === '/') {
            this.browseDir('/');
            return;
        }
        const parts = this._currentPath.split('/').filter(Boolean);
        parts.pop();
        this.browseDir('/' + parts.join('/'));
    }

    setShowHidden(show) {
        this._showHidden = !!show;
        this.browseDir(this._currentPath || '/');
    }

    downloadFile(remotePath, fileEntry) {
        const id = this._nextId++;
        const base = remotePath || this._currentPath || '/';
        const full = (base.replace(/\/$/, '') + '/' + (fileEntry && fileEntry.name || '')).replace(/\/+/g, '/');
        const requestId = 'dl_' + id + '_' + Date.now();

        this._emit('file_transfer_start', {
            id,
            type: 'download',
            fileName: fileEntry.name,
            fileSize: Number(fileEntry.size || 0),
        });

        this.ensureConnected().then(() => {
            this._pending[requestId] = (msg) => {
                if (msg.error) {
                    this._emit('file_transfer_error', { id, error: msg.error });
                    return;
                }
                if (!msg.data) {
                    this._emit('file_transfer_error', { id, error: 'empty file' });
                    return;
                }
                try {
                    const binary = atob(msg.data);
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                    const blob = new Blob([bytes]);
                    if (typeof this._saveDownload === 'function') {
                        this._saveDownload(blob, fileEntry.name);
                    } else {
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = fileEntry.name;
                        a.click();
                        URL.revokeObjectURL(url);
                    }
                    this._emit('file_transfer_progress', {
                        id, transferred: bytes.length, total: bytes.length,
                    });
                    this._emit('file_transfer_complete', { id, type: 'download', fileName: fileEntry.name });
                } catch (err) {
                    this._emit('file_transfer_error', { id, error: err.message || String(err) });
                }
            };
            this._send({ type: 'file_read', path: full, request_id: requestId });
        }).catch((err) => {
            this._emit('file_transfer_error', { id, error: err.message || String(err) });
        });
        return id;
    }

    uploadFile(file, remotePath) {
        const id = this._nextId++;
        const base = remotePath || this._currentPath || '/';
        const full = (base.replace(/\/$/, '') + '/' + file.name).replace(/\/+/g, '/');

        this._emit('file_transfer_start', {
            id,
            type: 'upload',
            fileName: file.name,
            fileSize: file.size || 0,
        });

        this.ensureConnected().then(() => {
            const reader = new FileReader();
            reader.onload = () => {
                const base64 = String(reader.result || '').split(',')[1] || '';
                this._emit('file_transfer_progress', {
                    id, transferred: file.size || 0, total: file.size || 0,
                });
                const ok = this._send({ type: 'file_write', path: full, data: base64 });
                if (!ok) {
                    this._emit('file_transfer_error', { id, error: 'not connected' });
                    return;
                }
                this._emit('file_transfer_complete', { id, type: 'upload', fileName: file.name });
                setTimeout(() => this.browseDir(this._currentPath), 400);
            };
            reader.onerror = () => {
                this._emit('file_transfer_error', { id, error: 'read failed' });
            };
            reader.readAsDataURL(file);
        }).catch((err) => {
            this._emit('file_transfer_error', { id, error: err.message || String(err) });
        });
        return id;
    }

    cancelTransfer() { return false; }

    close() {
        if (this._ws) {
            try {
                if (this._ws.readyState === WebSocket.OPEN) {
                    this._ws.send(JSON.stringify({ type: 'close' }));
                }
                this._ws.close();
            } catch (_) { /* ok */ }
        }
        this._ws = null;
        this._connected = false;
        this._pending = {};
    }
}
