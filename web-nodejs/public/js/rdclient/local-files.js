/**
 * Local filesystem helpers for Web Remote file transfer modal.
 * Uses File System Access API when available (Chrome/Edge + HTTPS).
 */
(function () {
    'use strict';

    function isSupported() {
        return typeof window.showDirectoryPicker === 'function'
            && window.isSecureContext === true;
    }

    function LocalFiles() {
        this._rootHandle = null;
        this._currentHandle = null;
        this._pathStack = [];
        this._currentPath = '';
    }

    LocalFiles.isSupported = isSupported;

    Object.defineProperty(LocalFiles.prototype, 'currentPath', {
        get: function () { return this._currentPath; }
    });
    Object.defineProperty(LocalFiles.prototype, 'hasRoot', {
        get: function () { return !!this._rootHandle; }
    });

    LocalFiles.prototype.pickRoot = async function () {
        if (!isSupported()) {
            throw new Error('unsupported');
        }
        this._rootHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        this._currentHandle = this._rootHandle;
        this._pathStack = [];
        this._currentPath = this._rootHandle.name || '';
        return this._currentPath;
    };

    LocalFiles.prototype.listCurrent = async function () {
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
        if (!entry || !entry.isDir || !entry.handle) return;
        this._pathStack.push({ handle: this._currentHandle, path: this._currentPath });
        this._currentHandle = entry.handle;
        this._currentPath = this._currentPath + (this._currentPath.endsWith('/') ? '' : '/') + entry.name;
        return this._currentPath;
    };

    LocalFiles.prototype.goUp = async function () {
        if (!this._pathStack.length) return this._currentPath;
        const prev = this._pathStack.pop();
        this._currentHandle = prev.handle;
        this._currentPath = prev.path;
        return this._currentPath;
    };

    LocalFiles.prototype.goHome = async function () {
        if (!this._rootHandle) return '';
        this._currentHandle = this._rootHandle;
        this._pathStack = [];
        this._currentPath = this._rootHandle.name || '';
        return this._currentPath;
    };

    LocalFiles.prototype.readFile = async function (entry) {
        if (!entry || entry.isDir || !entry.handle) return null;
        return entry.handle.getFile();
    };

    LocalFiles.prototype.saveDownload = async function (fileName, blob) {
        if (!this._currentHandle || !isSupported()) return false;
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

    window.LocalFiles = LocalFiles;
})();
