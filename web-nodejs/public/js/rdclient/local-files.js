/**
 * Local filesystem helpers for Web Remote file transfer modal.
 * Browser: File System Access API when available (Chrome/Edge + HTTPS).
 * RdClient desktop: native folder picker + path-based reads via Tauri.
 */
(function () {
    'use strict';

    function isFsAccessSupported() {
        return typeof window.showDirectoryPicker === 'function'
            && window.isSecureContext === true;
    }

    function isDesktopBridge() {
        return window.__BETTERDESK_RDCLIENT_DESKTOP__ === true
            && window.__TAURI__
            && window.__TAURI__.core
            && typeof window.__TAURI__.core.invoke === 'function';
    }

    function desktopInvoke(cmd, args) {
        return window.__TAURI__.core.invoke(cmd, args || {});
    }

    /**
     * Build a duck-typed File-like object backed by a native read handle.
     * @param {Object} info - { handle, name, size, modifiedTime|modified_time }
     * @returns {Object}
     */
    function createNativeUploadFile(info) {
        if (!info || !info.handle) return null;
        var modified = info.modifiedTime != null
            ? info.modifiedTime
            : (info.modified_time != null ? info.modified_time * 1000 : 0);
        return {
            name: info.name || 'file',
            size: Number(info.size || 0),
            lastModified: modified,
            __rdNativeHandle: info.handle,
            slice: function (start, end) {
                var handle = info.handle;
                var offset = Math.max(0, Number(start || 0));
                var length = Math.max(0, Number(end || 0) - offset);
                return {
                    arrayBuffer: function () {
                        return desktopInvoke('desktop_read_file_chunk', {
                            handle: handle,
                            offset: offset,
                            length: length
                        }).then(function (bytes) {
                            if (bytes instanceof ArrayBuffer) return bytes;
                            if (bytes instanceof Uint8Array) return bytes.buffer;
                            return new Uint8Array(bytes || []).buffer;
                        });
                    }
                };
            }
        };
    }

    function LocalFiles() {
        this._mode = null; // 'fsa' | 'desktop'
        this._rootHandle = null;
        this._currentHandle = null;
        this._pathStack = [];
        this._rootPath = '';
        this._currentPath = '';
    }

    LocalFiles.isSupported = function () {
        return isFsAccessSupported() || isDesktopBridge();
    };

    LocalFiles.isDesktopBridge = isDesktopBridge;
    LocalFiles.createNativeUploadFile = createNativeUploadFile;

    Object.defineProperty(LocalFiles.prototype, 'currentPath', {
        get: function () { return this._currentPath; }
    });
    Object.defineProperty(LocalFiles.prototype, 'hasRoot', {
        get: function () {
            return this._mode === 'fsa' ? !!this._rootHandle : !!this._rootPath;
        }
    });

    LocalFiles.prototype.pickRoot = async function () {
        if (isDesktopBridge()) {
            var folder = await desktopInvoke('desktop_pick_folder');
            if (!folder || !folder.path) {
                throw new Error('AbortError');
            }
            this._mode = 'desktop';
            this._rootPath = folder.path;
            this._currentPath = folder.path;
            this._pathStack = [];
            return this._currentPath;
        }
        if (!isFsAccessSupported()) {
            throw new Error('unsupported');
        }
        this._mode = 'fsa';
        this._rootHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        this._currentHandle = this._rootHandle;
        this._pathStack = [];
        this._currentPath = this._rootHandle.name || '';
        return this._currentPath;
    };

    LocalFiles.prototype.listCurrent = async function () {
        if (this._mode === 'desktop') {
            if (!this._currentPath) return [];
            var entries = await desktopInvoke('desktop_list_directory', { path: this._currentPath });
            return (entries || []).map(function (e) {
                return {
                    name: e.name,
                    path: e.path,
                    isDir: !!e.isDir || !!e.is_dir,
                    size: Number(e.size || 0),
                    modifiedTime: Number(e.modifiedTime != null ? e.modifiedTime : (e.modified_time || 0))
                };
            });
        }
        if (!this._currentHandle) return [];
        const entries = [];
        for await (const entry of this._currentHandle.values()) {
            entries.push({
                name: entry.name,
                isDir: entry.kind === 'directory',
                size: 0,
                modifiedTime: 0,
                handle: entry
            });
        }
        entries.sort((a, b) => {
            if (a.isDir && !b.isDir) return -1;
            if (!a.isDir && b.isDir) return 1;
            return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });
        for (const e of entries) {
            if (!e.isDir && e.handle) {
                try {
                    const file = await e.handle.getFile();
                    e.size = file.size;
                    e.modifiedTime = file.lastModified ? Math.floor(file.lastModified / 1000) : 0;
                } catch { /* ignore */ }
            }
        }
        return entries;
    };

    LocalFiles.prototype.enterDir = async function (entry) {
        if (this._mode === 'desktop') {
            if (!entry || !entry.isDir || !entry.path) return;
            this._pathStack.push(this._currentPath);
            this._currentPath = entry.path;
            return this._currentPath;
        }
        if (!entry || !entry.isDir || !entry.handle) return;
        this._pathStack.push({ handle: this._currentHandle, path: this._currentPath });
        this._currentHandle = entry.handle;
        this._currentPath = this._currentPath + (this._currentPath.endsWith('/') ? '' : '/') + entry.name;
        return this._currentPath;
    };

    LocalFiles.prototype.goUp = async function () {
        if (this._mode === 'desktop') {
            if (!this._pathStack.length) return this._currentPath;
            this._currentPath = this._pathStack.pop();
            return this._currentPath;
        }
        if (!this._pathStack.length) return this._currentPath;
        const prev = this._pathStack.pop();
        this._currentHandle = prev.handle;
        this._currentPath = prev.path;
        return this._currentPath;
    };

    LocalFiles.prototype.goHome = async function () {
        if (this._mode === 'desktop') {
            if (!this._rootPath) return '';
            this._currentPath = this._rootPath;
            this._pathStack = [];
            return this._currentPath;
        }
        if (!this._rootHandle) return '';
        this._currentHandle = this._rootHandle;
        this._pathStack = [];
        this._currentPath = this._rootHandle.name || '';
        return this._currentPath;
    };

    LocalFiles.prototype.readFile = async function (entry) {
        if (this._mode === 'desktop') {
            if (!entry || entry.isDir) return null;
            var path = entry.path;
            if (!path) return null;
            var info = await desktopInvoke('desktop_open_file', { path: path });
            return createNativeUploadFile(info);
        }
        if (!entry || entry.isDir || !entry.handle) return null;
        return entry.handle.getFile();
    };

    LocalFiles.prototype.saveDownload = async function (fileName, blob) {
        if (isDesktopBridge()) {
            var buf = await blob.arrayBuffer();
            var data = Array.from(new Uint8Array(buf));
            var result = await desktopInvoke('desktop_save_download', {
                file_name: fileName,
                data: data
            });
            return !!(result && result.saved);
        }
        if (!this._currentHandle || !isFsAccessSupported()) return false;
        try {
            const fh = await this._currentHandle.getFileHandle(fileName, { create: true });
            const w = await fh.createWritable();
            await w.write(blob);
            await w.close();
            return true;
        } catch (e) {
            console.warn('[LocalFiles] save to folder failed:', e);
            return false;
        }
    };

    /** Pick one or more local files via native dialog (desktop only). */
    LocalFiles.pickNativeFiles = async function () {
        if (!isDesktopBridge()) return [];
        var picked = await desktopInvoke('desktop_pick_files');
        return (picked || []).map(createNativeUploadFile).filter(Boolean);
    };

    window.LocalFiles = LocalFiles;
})();
