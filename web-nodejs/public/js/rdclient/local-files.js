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
     * Encode bytes as standard base64 (chunked to avoid call stack limits).
     * @param {Uint8Array|Array|ArrayBuffer} data
     * @returns {string}
     */
    function bytesToBase64(data) {
        var bytes = data instanceof Uint8Array
            ? data
            : new Uint8Array(data || []);
        var binary = '';
        var chunk = 0x8000;
        for (var i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    function base64ToBytes(b64) {
        if (!b64) return new Uint8Array(0);
        // Legacy: older desktop builds returned Vec<u8> as a number array.
        if (Array.isArray(b64) || b64 instanceof Uint8Array || b64 instanceof ArrayBuffer) {
            return b64 instanceof Uint8Array ? b64 : new Uint8Array(b64);
        }
        if (typeof b64 !== 'string') return new Uint8Array(0);
        var binary = atob(b64);
        var out = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return out;
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
            __rdNativePath: info.path || null,
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
                        }).then(function (payload) {
                            var bytes = base64ToBytes(payload);
                            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
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
    LocalFiles.bytesToBase64 = bytesToBase64;
    LocalFiles.base64ToBytes = base64ToBytes;

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
            var desktopEntries = await desktopInvoke('desktop_list_directory', { path: this._currentPath });
            return (desktopEntries || []).map(function (e) {
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
        var entries = [];
        for await (var entry of this._currentHandle.values()) {
            entries.push({
                name: entry.name,
                isDir: entry.kind === 'directory',
                size: 0,
                modifiedTime: 0,
                handle: entry
            });
        }
        entries.sort(function (a, b) {
            if (a.isDir && !b.isDir) return -1;
            if (!a.isDir && b.isDir) return 1;
            return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (!e.isDir && e.handle) {
                try {
                    var file = await e.handle.getFile();
                    e.size = file.size;
                    e.modifiedTime = file.lastModified ? Math.floor(file.lastModified / 1000) : 0;
                } catch (_err) { /* ignore */ }
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

    /**
     * Recursively expand a local directory (desktop path or FSA handle).
     * @param {Object} entry - { path?, name, isDir, handle? }
     * @returns {Promise<{rootName:string, dirs:Array, files:Array}>}
     */
    LocalFiles.prototype.walkFolder = async function (entry) {
        if (!entry || !entry.isDir) {
            return { rootName: '', dirs: [], files: [] };
        }
        if (this._mode === 'desktop' || (isDesktopBridge() && entry.path)) {
            var walked = await desktopInvoke('desktop_walk_paths', { path: entry.path });
            var dirs = [];
            var files = [];
            var rootName = entry.name || '';
            (walked || []).forEach(function (e) {
                var rel = e.relativePath != null ? e.relativePath : (e.relative_path || '');
                var isDir = !!(e.isDir || e.is_dir);
                if (rel === '') {
                    rootName = e.name || rootName;
                    return;
                }
                if (isDir) {
                    dirs.push({
                        name: e.name,
                        path: e.path,
                        relativePath: rel,
                        isDir: true
                    });
                } else {
                    files.push({
                        name: e.name,
                        path: e.path,
                        relativePath: rel,
                        size: Number(e.size || 0),
                        modifiedTime: Number(e.modifiedTime != null ? e.modifiedTime : (e.modified_time || 0)),
                        isDir: false
                    });
                }
            });
            dirs.sort(function (a, b) {
                return a.relativePath.length - b.relativePath.length
                    || a.relativePath.localeCompare(b.relativePath);
            });
            return { rootName: rootName, dirs: dirs, files: files };
        }

        // File System Access API walk
        var rootNameFsa = entry.name || 'folder';
        var dirsFsa = [];
        var filesFsa = [];
        async function walkHandle(dirHandle, relPrefix) {
            for await (const child of dirHandle.values()) {
                var rel = relPrefix ? (relPrefix + '/' + child.name) : child.name;
                if (child.kind === 'directory') {
                    dirsFsa.push({ name: child.name, relativePath: rel, isDir: true, handle: child });
                    await walkHandle(child, rel);
                } else {
                    var file = await child.getFile();
                    filesFsa.push({
                        name: child.name,
                        relativePath: rel,
                        size: file.size,
                        modifiedTime: file.lastModified ? Math.floor(file.lastModified / 1000) : 0,
                        isDir: false,
                        file: file,
                        handle: child
                    });
                }
            }
        }
        await walkHandle(entry.handle, '');
        dirsFsa.sort(function (a, b) {
            return a.relativePath.length - b.relativePath.length
                || a.relativePath.localeCompare(b.relativePath);
        });
        return { rootName: rootNameFsa, dirs: dirsFsa, files: filesFsa };
    };

    /** Walk an absolute desktop path (folder drop / pick). */
    LocalFiles.walkDesktopPath = async function (path) {
        if (!isDesktopBridge() || !path) {
            return { rootName: '', dirs: [], files: [], isFile: false };
        }
        var walked = await desktopInvoke('desktop_walk_paths', { path: path });
        var dirs = [];
        var files = [];
        var rootName = '';
        var isFile = false;
        (walked || []).forEach(function (e) {
            var rel = e.relativePath != null ? e.relativePath : (e.relative_path || '');
            var isDir = !!(e.isDir || e.is_dir);
            if (rel === '' && isDir) {
                rootName = e.name || rootName;
                return;
            }
            if (!isDir && (walked.length === 1 || (rel && rel.indexOf('/') === -1 && files.length === 0 && dirs.length === 0 && walked.length === 1))) {
                // single file walk
            }
            if (isDir) {
                dirs.push({
                    name: e.name,
                    path: e.path,
                    relativePath: rel,
                    isDir: true
                });
            } else {
                if (walked.length === 1) {
                    isFile = true;
                    rootName = e.name || rootName;
                }
                files.push({
                    name: e.name,
                    path: e.path,
                    relativePath: rel || e.name,
                    size: Number(e.size || 0),
                    modifiedTime: Number(e.modifiedTime != null ? e.modifiedTime : (e.modified_time || 0)),
                    isDir: false
                });
            }
        });
        if (!rootName && files.length === 1 && dirs.length === 0) {
            isFile = true;
            rootName = files[0].name;
        }
        dirs.sort(function (a, b) {
            return a.relativePath.length - b.relativePath.length
                || a.relativePath.localeCompare(b.relativePath);
        });
        return { rootName: rootName, dirs: dirs, files: files, isFile: isFile };
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

    LocalFiles.prototype.mkdirp = async function (path) {
        if (isDesktopBridge()) {
            await desktopInvoke('desktop_mkdir_p', { path: path });
            return true;
        }
        return false;
    };

    /**
     * Streaming download helpers (desktop only).
     */
    LocalFiles.beginDownload = async function (opts) {
        if (!isDesktopBridge()) return null;
        var args = {
            suggestedName: opts && opts.suggestedName != null ? opts.suggestedName : null,
            defaultDir: opts && opts.defaultDir != null ? opts.defaultDir : null,
            absolutePath: opts && opts.absolutePath != null ? opts.absolutePath : null,
            appendOffset: opts && opts.appendOffset != null ? Number(opts.appendOffset) : 0
        };
        // Tauri rename_all: camelCase in JS maps to snake in some versions; pass both styles via camelCase (serde rename).
        return desktopInvoke('desktop_download_begin', {
            suggestedName: args.suggestedName,
            defaultDir: args.defaultDir,
            absolutePath: args.absolutePath,
            appendOffset: args.appendOffset
        });
    };

    LocalFiles.writeDownload = async function (handle, data) {
        if (!isDesktopBridge() || !handle) return;
        var bytes = data instanceof Uint8Array ? data : new Uint8Array(data || []);
        await desktopInvoke('desktop_download_write', {
            handle: handle,
            dataBase64: bytesToBase64(bytes)
        });
    };

    LocalFiles.finishDownload = async function (handle) {
        if (!isDesktopBridge() || !handle) return { saved: false };
        return desktopInvoke('desktop_download_finish', { handle: handle });
    };

    LocalFiles.abortDownload = async function (handle, deleteFile) {
        if (!isDesktopBridge() || !handle) return;
        await desktopInvoke('desktop_download_abort', {
            handle: handle,
            deleteFile: deleteFile !== false
        });
    };

    LocalFiles.pickFolder = async function () {
        if (!isDesktopBridge()) return null;
        return desktopInvoke('desktop_pick_folder');
    };

    /** Pick one or more local files via native dialog (desktop only). */
    LocalFiles.pickNativeFiles = async function () {
        if (!isDesktopBridge()) return [];
        var picked = await desktopInvoke('desktop_pick_files');
        return (picked || []).map(createNativeUploadFile).filter(Boolean);
    };

    window.LocalFiles = LocalFiles;
})();
