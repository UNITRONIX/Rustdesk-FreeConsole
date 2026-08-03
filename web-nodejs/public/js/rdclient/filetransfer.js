/**
 * BetterDesk Web Remote Client - File Transfer Module
 * Handles RustDesk file transfer protocol: browse, download, upload, manage
 *
 * Protocol flow (RustDesk client io_loop — operator pulls from / pushes to peer):
 *   Browse:   FileAction.read_dir → FileResponse.dir
 *   Download: FileAction.send (full remote file path) → FileResponse.digest → FileAction.send_confirm → FileResponse.block* → FileResponse.done
 *   Upload:   FileAction.receive → FileResponse.digest (operator) → FileAction.send_confirm (peer) → FileResponse.block* → FileResponse.done
 *             (overwrite: peer may reply with FileResponse.digest is_upload=true → FileAction.send_confirm → blocks)
 *   Cancel:   FileAction.cancel
 */

/* global RDProtocol, RDCompress */

// eslint-disable-next-line no-unused-vars
class RDFileTransfer {
    /**
     * @param {Object} opts
     * @param {RDProtocol} opts.proto - Protocol handler
     * @param {Function} opts.sendMessage - Function to send peer message: (msgObj) => void
     * @param {Function} opts.emit - Event emitter: (event, ...args) => void
     * @param {Function} [opts.ensureConnected] - Async hook before browse/upload
     * @param {Function} [opts.isConnected] - Returns true when file relay is ready
     */
    constructor(opts) {
        this._proto = opts.proto;
        this._sendMessage = opts.sendMessage;
        this._emit = opts.emit;
        this._ensureConnected = opts.ensureConnected || null;
        this._isConnected = opts.isConnected || null;

        /** @type {string} Current remote directory path */
        this._currentPath = '';

        /** @type {Array<Object>} Current directory entries */
        this._entries = [];

        /** @type {Map<number, Object>} Active transfers by ID */
        this._transfers = new Map();

        /** @type {number} Transfer ID counter */
        this._nextId = 1;

        /** @type {boolean} Whether file transfer is enabled */
        this._enabled = false;

        /** @type {boolean} Show hidden files */
        this._showHidden = false;

        // File type constants from proto
        this.FILE_TYPE = {
            DIR: 0,
            DIR_LINK: 2,
            DIR_DRIVE: 3,
            FILE: 4,
            FILE_LINK: 5
        };

        // Block size for uploads (128KB, matching hbb_common BUF_SIZE)
        this.BLOCK_SIZE = 131072;
        this.TRANSFER_STALL_MS = 15000;

        /** @type {'overwrite'|'skip'|null} Session-wide overwrite strategy */
        this._overwriteStrategy = null;

        /** @type {Map<number, Object>} Pending overwrite prompts */
        this._pendingOverwrite = new Map();

        /** @type {Map<string, Object>} Pending background read_dir promises (folder walk) */
        this._pendingDirReads = new Map();

        /** @type {Map<number, Object>} Pending remote mkdir promises */
        this._pendingCreates = new Map();

        /** @type {Array<Object>} Queued folder jobs (max one active) */
        this._folderJobQueue = [];

        /** @type {Object|null} Active folder job */
        this._activeFolderJob = null;
    }

    _supportsStreamDownload() {
        return !!(window.__BETTERDESK_RDCLIENT_DESKTOP__
            && window.__TAURI__
            && window.__TAURI__.core
            && typeof window.__TAURI__.core.invoke === 'function'
            && typeof LocalFiles !== 'undefined'
            && LocalFiles.beginDownload);
    }

    _bytesToBase64(data) {
        if (typeof LocalFiles !== 'undefined' && LocalFiles.bytesToBase64) {
            return LocalFiles.bytesToBase64(data);
        }
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || []);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    _normalizeRemotePathKey(path) {
        return String(path || '').replace(/[\\/]+$/, '');
    }

    /**
     * Join remote directory + relative path (uses remote separator).
     * @param {string} remoteDir
     * @param {string} relativePath - uses `/` separators
     * @returns {string}
     */
    static buildRemoteRelativePath(remoteDir, relativePath) {
        const rel = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (!rel) return remoteDir || '';
        const parts = rel.split('/').filter(Boolean);
        let out = remoteDir || '';
        for (let i = 0; i < parts.length; i++) {
            out = RDFileTransfer.buildRemoteFilePath(out, parts[i]);
        }
        return out;
    }

    static joinLocalPath(base, relativePath) {
        const rel = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (!base) return rel.replace(/\//g, '/');
        const sep = base.includes('\\') ? '\\' : '/';
        if (!rel) return base;
        const parts = rel.split('/').filter(Boolean);
        let out = base.replace(/[\\/]+$/, '');
        for (let i = 0; i < parts.length; i++) {
            out += sep + parts[i];
        }
        return out;
    }

    /** Extensions that skip zstd compression (RustDesk is_compressed_file parity) */
    static get COMPRESSED_EXTENSIONS() {
        return new Set(['xz', 'gz', 'zip', '7z', 'rar', 'bz2', 'tgz', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'mp3', 'avi', 'mkv']);
    }

    /**
     * @param {string} fileName
     * @returns {boolean}
     */
    static isPreCompressedFileName(fileName) {
        const ext = String(fileName || '').split('.').pop().toLowerCase();
        return RDFileTransfer.COMPRESSED_EXTENSIONS.has(ext);
    }

    /**
     * @param {number} transferredSize
     * @param {number} blockSize
     * @returns {number}
     */
    static computeOffsetBlk(transferredSize, blockSize) {
        const size = Number(transferredSize || 0);
        const blk = Number(blockSize || 131072);
        if (!size || !blk) return 0;
        return Math.floor(size / blk);
    }

    /**
     * Build full remote destination path for upload (RustDesk expects file path, not directory).
     * @param {string} remoteDir
     * @param {string} fileName
     * @returns {string}
     */
    static buildRemoteUploadPath(remoteDir, fileName) {
        return RDFileTransfer.buildRemoteFilePath(remoteDir, fileName);
    }

    /**
     * Join remote directory + file name (Windows or Unix separators).
     * Used for download source paths and upload destination paths in send().
     * @param {string} remoteDir
     * @param {string} fileName
     * @returns {string}
     */
    static buildRemoteFilePath(remoteDir, fileName) {
        const dir = remoteDir || '';
        const sep = dir.includes('\\') ? '\\' : '/';
        if (!dir) return fileName || '';
        return dir + (dir.endsWith(sep) ? '' : sep) + (fileName || '');
    }

    _failTransfer(id, message, opts) {
        const options = opts || {};
        const transfer = this._transfers.get(id);
        if (!transfer) return;
        this._clearTransferTimeout(id);
        const fileName = transfer.fileName;
        const resumable = !!options.resumable;
        if (transfer.file && transfer.file.__rdNativeHandle && window.__TAURI__ && window.__TAURI__.core) {
            window.__TAURI__.core.invoke('desktop_release_file_handles', {
                handles: [transfer.file.__rdNativeHandle]
            }).catch(function () { /* ignore */ });
        }
        if (transfer.downloadHandle && typeof LocalFiles !== 'undefined' && LocalFiles.abortDownload) {
            const keep = resumable;
            LocalFiles.abortDownload(transfer.downloadHandle, !keep).catch(function () { /* ignore */ });
            if (!keep) {
                transfer.downloadHandle = null;
            }
        }
        if (typeof transfer._folderWait === 'function') {
            const resolve = transfer._folderWait;
            transfer._folderWait = null;
            resolve(false);
        }
        if (resumable) {
            transfer.status = 'error';
            transfer.errorMessage = message || 'Transfer failed';
            transfer.resumable = true;
        } else {
            this._transfers.delete(id);
        }
        this._emit('file_transfer_error', {
            id: id,
            fileName: fileName,
            error: message || 'Transfer failed',
            resumable: resumable,
            type: transfer.type,
            folderJobId: transfer.folderJobId || null,
            currentFile: transfer.currentFile || null
        });
    }

    _needsFileConnection() {
        return this._ensureConnected && (!this._isConnected || !this._isConnected());
    }

    _runWithConnection(run) {
        if (this._ensureConnected) {
            if (this._needsFileConnection()) {
                this._emit('file_connecting');
            }
            return this._ensureConnected().then(function () {
                return run();
            });
        }
        // Run synchronously so callers can register pending state before the next
        // event-loop turn (e.g. readDirAsync before an immediate FileResponse).
        try {
            return Promise.resolve(run());
        } catch (err) {
            return Promise.reject(err);
        }
    }

    _sendMessageSafe(msgObj) {
        try {
            this._sendMessage(msgObj);
        } catch (err) {
            throw err;
        }
    }

    _armTransferTimeout(id) {
        const self = this;
        const transfer = this._transfers.get(id);
        if (!transfer) return;
        if (transfer.stallTimer) clearTimeout(transfer.stallTimer);
        transfer.stallTimer = setTimeout(function () {
            const t = self._transfers.get(id);
            if (!t || t.status !== 'pending') return;
            t.status = 'error';
            t.resumable = (t.type === 'upload' && (t.sentBytes || 0) > 0)
                || (t.type === 'download' && (t.receivedBytes || 0) > 0);
            if (!t.resumable) {
                self._transfers.delete(id);
            }
            self._emit('file_transfer_error', {
                id: id,
                fileName: t.fileName,
                error: 'Remote did not start transfer',
                resumable: t.resumable,
                type: t.type
            });
        }, this.TRANSFER_STALL_MS);
    }

    _clearTransferTimeout(id) {
        const transfer = this._transfers.get(id);
        if (transfer && transfer.stallTimer) {
            clearTimeout(transfer.stallTimer);
            transfer.stallTimer = null;
        }
    }

    /**
     * Enable file transfer (called after successful login)
     */
    enable() {
        this._enabled = true;
    }

    /**
     * Disable file transfer
     */
    disable() {
        this._enabled = false;
        this.cancelAll();
    }

    get enabled() { return this._enabled; }
    get currentPath() { return this._currentPath; }
    get entries() { return this._entries; }
    get showHidden() { return this._showHidden; }

    /**
     * Respond to overwrite prompt from UI.
     * @param {number} id
     * @param {boolean} skip
     * @param {boolean} [applyToAll]
     */
    confirmOverwrite(id, skip, applyToAll) {
        const pending = this._pendingOverwrite.get(id);
        if (!pending) return;
        this._pendingOverwrite.delete(id);
        if (applyToAll) {
            this._overwriteStrategy = skip ? 'skip' : 'overwrite';
        }
        pending.resolve(!!skip);
    }

    /**
     * Resume a failed transfer when checkpoint data is available.
     * @param {number} id
     */
    resumeTransfer(id) {
        const transfer = this._transfers.get(id);
        if (!transfer || !transfer.resumable) return;

        transfer.status = 'pending';
        transfer.errorMessage = null;
        transfer.resumable = false;
        const self = this;

        this._emit('file_transfer_start', {
            id: id,
            type: transfer.type,
            fileName: transfer.fileName,
            fileSize: transfer.fileSize
        });

        this._runWithConnection(function () {
            try {
                if (transfer.type === 'upload') {
                    const modified = transfer.file && transfer.file.lastModified
                        ? Math.floor(transfer.file.lastModified / 1000) : 0;
                    const startOffset = transfer.sentBytes || 0;
                    const isResume = startOffset > 0;
                    if (!isResume) {
                        const file = transfer.file;
                        const files = [{
                            entryType: self.FILE_TYPE.FILE,
                            name: file.name,
                            size: file.size,
                            modifiedTime: modified
                        }];
                        self._sendMessageSafe(self._proto.buildFileReceiveRequest(
                            id, transfer.remotePath, files, transfer.fileNum || 0, Number(file.size)
                        ));
                    }
                    self._sendMessageSafe(self._proto.buildFileDigest(
                        id, transfer.fileNum || 0, transfer.fileSize, modified,
                        { isUpload: true, isResume: isResume, transferredSize: startOffset }
                    ));
                    self._armTransferTimeout(id);
                } else if (transfer.type === 'download') {
                    const remoteName = transfer.remoteFileName || transfer.fileName;
                    const fullPath = RDFileTransfer.buildRemoteFilePath(
                        transfer.remotePath, remoteName
                    );
                    const startSend = function () {
                        self._sendMessageSafe(self._proto.buildFileSendRequest(
                            id, fullPath, self._showHidden, transfer.fileNum || 0
                        ));
                        self._armTransferTimeout(id);
                    };
                    if (transfer.streamDownload && transfer.localPath
                        && typeof LocalFiles !== 'undefined' && LocalFiles.beginDownload) {
                        LocalFiles.beginDownload({
                            absolutePath: transfer.localPath,
                            appendOffset: transfer.receivedBytes || 0
                        }).then(function (result) {
                            if (!result || !result.started || !result.handle) {
                                self._failTransfer(id, 'Download cancelled');
                                return;
                            }
                            transfer.downloadHandle = result.handle;
                            startSend();
                        }).catch(function (err) {
                            self._failTransfer(id, err.message || 'Could not resume download');
                        });
                    } else {
                        startSend();
                    }
                }
            } catch (err) {
                self._failTransfer(id, err.message || String(err));
            }
        }).catch(function (err) {
            self._failTransfer(id, err.message || 'Could not connect file transfer session');
        });
    }

    /**
     * Browse a directory on the remote machine
     * @param {string} [path=''] - Path to browse (empty = root/drives)
     */
    browseDir(path) {
        if (!this._enabled) {
            console.warn('[FileTransfer] browseDir called but file transfer not enabled');
            return;
        }
        const dir = path != null ? path : '';
        const self = this;
        const run = function () {
            console.log('[FileTransfer] browseDir:', JSON.stringify(dir));
            self._sendMessageSafe(self._proto.buildReadDir(dir, self._showHidden));
            self._emit('file_browsing', { path: dir });
            if (self._browseTimeout) clearTimeout(self._browseTimeout);
            self._browseTimedOut = false;
            self._browseTimeout = setTimeout(function () {
                if (!self._browseTimedOut) {
                    self._browseTimedOut = true;
                    console.warn('[FileTransfer] browseDir timeout — no response from peer after 5s');
                    self._emit('file_browse_timeout', { path: dir });
                }
            }, 5000);
        };
        if (this._ensureConnected) {
            if (this._needsFileConnection()) {
                this._emit('file_connecting');
            }
            this._ensureConnected().then(run).catch(function (err) {
                self._emit('file_connect_error', { error: err.message || String(err) });
            });
        } else {
            run();
        }
    }

    /**
     * Navigate up to parent directory
     */
    browseParent() {
        if (!this._currentPath) return;
        // Handle both Windows and Unix paths
        let parent = this._currentPath.replace(/[\\/]+$/, '');
        const sep = parent.includes('\\') ? '\\' : '/';
        const lastSep = parent.lastIndexOf(sep);
        if (lastSep > 0) {
            parent = parent.substring(0, lastSep);
        } else if (lastSep === 0) {
            parent = sep; // Unix root
        } else {
            parent = ''; // Drive list on Windows
        }
        this.browseDir(parent);
    }

    /**
     * Toggle hidden file visibility
     * @param {boolean} show
     */
    setShowHidden(show) {
        this._showHidden = !!show;
        // Refresh current directory
        if (this._enabled && this._currentPath !== undefined) {
            this.browseDir(this._currentPath);
        }
    }

    /**
     * Download a file from remote
     * @param {string} remotePath - Remote directory path
     * @param {Object} fileEntry - FileEntry { name, size, modified_time, entry_type }
     * @param {Object} [opts]
     * @param {string} [opts.localDir] - Desktop: write into this dir (no Save dialog)
     * @param {string} [opts.localFileName] - Override save name / relative file name
     * @param {string} [opts.absolutePath] - Desktop: exact output path
     * @param {number} [opts.folderJobId]
     * @param {boolean} [opts.silent] - Skip top-level start event (folder child)
     * @returns {number} Transfer ID
     */
    downloadFile(remotePath, fileEntry, opts) {
        if (!this._enabled) return -1;
        const options = opts || {};

        const id = this._nextId++;
        const transfer = {
            id: id,
            type: 'download',
            remotePath: remotePath,
            fileName: options.localFileName || fileEntry.name,
            remoteFileName: fileEntry.name,
            fileSize: Number(fileEntry.size || 0),
            receivedBytes: 0,
            blocks: this._supportsStreamDownload() ? null : [],
            streamDownload: this._supportsStreamDownload(),
            downloadHandle: null,
            localPath: null,
            localDir: options.localDir || null,
            absolutePath: options.absolutePath || null,
            folderJobId: options.folderJobId || null,
            writeChain: Promise.resolve(),
            startTime: Date.now(),
            status: 'pending',
            fileNum: 0,
            stallTimer: null
        };
        this._transfers.set(id, transfer);

        if (!options.silent) {
            this._emit('file_transfer_start', {
                id: id,
                type: 'download',
                fileName: transfer.fileName,
                fileSize: transfer.fileSize,
                folderJobId: transfer.folderJobId
            });
        }

        const self = this;
        const startSend = function () {
            self._runWithConnection(function () {
                try {
                    const fullPath = RDFileTransfer.buildRemoteFilePath(remotePath, fileEntry.name);
                    self._sendMessageSafe(self._proto.buildFileSendRequest(
                        id, fullPath, self._showHidden, 0
                    ));
                    self._armTransferTimeout(id);
                } catch (err) {
                    self._failTransfer(id, err.message || String(err));
                }
            }).catch(function (err) {
                self._failTransfer(id, err.message || 'Could not connect file transfer session');
            });
        };

        if (transfer.streamDownload) {
            const beginOpts = {
                suggestedName: transfer.fileName,
                defaultDir: transfer.localDir,
                absolutePath: transfer.absolutePath,
                appendOffset: 0
            };
            LocalFiles.beginDownload(beginOpts).then(function (result) {
                if (!result || !result.started || !result.handle) {
                    self._failTransfer(id, 'Download cancelled');
                    return;
                }
                transfer.downloadHandle = result.handle;
                transfer.localPath = result.path || null;
                startSend();
            }).catch(function (err) {
                self._failTransfer(id, err.message || 'Could not start download');
            });
        } else {
            startSend();
        }

        return id;
    }

    /**
     * Upload a file to remote
     * @param {File} file - Browser File object
     * @param {string} remotePath - Remote destination directory
     * @param {Object} [opts]
     * @param {string} [opts.remoteFileName] - Relative name under remotePath (may include `/` or `\`)
     * @param {number} [opts.folderJobId]
     * @param {boolean} [opts.silent]
     * @returns {number} Transfer ID
     */
    uploadFile(file, remotePath, opts) {
        if (!this._enabled) return -1;
        const options = opts || {};
        const remoteName = options.remoteFileName || file.name;

        const id = this._nextId++;
        const transfer = {
            id: id,
            type: 'upload',
            remotePath: remotePath,
            fileName: remoteName,
            fileSize: file.size,
            sentBytes: 0,
            file: file,
            folderJobId: options.folderJobId || null,
            startTime: Date.now(),
            status: 'pending',
            fileNum: 0,
            currentBlk: 0,
            stallTimer: null
        };
        this._transfers.set(id, transfer);

        if (!options.silent) {
            this._emit('file_transfer_start', {
                id: id,
                type: 'upload',
                fileName: remoteName,
                fileSize: file.size,
                folderJobId: transfer.folderJobId
            });
        }

        const self = this;
        this._runWithConnection(function () {
            try {
                const files = [{
                    entryType: self.FILE_TYPE.FILE,
                    name: remoteName,
                    size: file.size,
                    modifiedTime: file.lastModified ? Math.floor(file.lastModified / 1000) : 0
                }];
                self._sendMessageSafe(self._proto.buildFileReceiveRequest(
                    id, remotePath, files, 0, Number(file.size)
                ));
                const modified = file.lastModified ? Math.floor(file.lastModified / 1000) : 0;
                self._sendMessageSafe(self._proto.buildFileDigest(id, 0, file.size, modified));
                self._armTransferTimeout(id);
            } catch (err) {
                self._failTransfer(id, err.message || String(err));
            }
        }).catch(function (err) {
            self._failTransfer(id, err.message || 'Could not connect file transfer session');
        });

        return id;
    }

    /**
     * Cancel a transfer (folder job id cancels the whole folder tree).
     * @param {number} id
     */
    cancelTransfer(id) {
        if (this._activeFolderJob && this._activeFolderJob.id === id) {
            this._cancelFolderJob(id);
            return;
        }
        for (let i = 0; i < this._folderJobQueue.length; i++) {
            if (this._folderJobQueue[i].id === id) {
                const job = this._folderJobQueue.splice(i, 1)[0];
                this._emit('file_transfer_cancelled', {
                    id: id,
                    fileName: job.fileName,
                    isFolder: true
                });
                return;
            }
        }

        const transfer = this._transfers.get(id);
        if (!transfer) return;

        transfer.status = 'cancelled';
        this._clearTransferTimeout(id);
        try {
            this._sendMessageSafe(this._proto.buildFileCancel(id));
        } catch (_) { /* ignore */ }
        if (transfer.downloadHandle && typeof LocalFiles !== 'undefined' && LocalFiles.abortDownload) {
            LocalFiles.abortDownload(transfer.downloadHandle, true).catch(function () { /* ignore */ });
            transfer.downloadHandle = null;
        }
        this._transfers.delete(id);

        this._emit('file_transfer_cancelled', {
            id: id,
            fileName: transfer.fileName,
            folderJobId: transfer.folderJobId || null
        });
        if (transfer.folderJobId) {
            this._onChildTransferSettled(transfer.folderJobId, id, false);
        }
    }

    /**
     * Cancel all active transfers
     */
    cancelAll() {
        if (this._activeFolderJob) {
            this._cancelFolderJob(this._activeFolderJob.id);
        }
        this._folderJobQueue = [];
        for (const [id] of this._transfers) {
            this.cancelTransfer(id);
        }
    }

    /**
     * Create directory on remote
     * @param {string} path
     */
    createDir(path) {
        if (!this._enabled) return;
        const id = this._nextId++;
        this._sendMessage(this._proto.buildFileDirCreate(id, path));
        this._emit('file_action', { action: 'create_dir', path: path });
    }

    /**
     * Create remote directory and resolve when peer acks or times out.
     * @param {string} path
     * @returns {Promise<void>}
     */
    createDirAsync(path) {
        const self = this;
        if (!this._enabled) return Promise.reject(new Error('File transfer not enabled'));
        return this._runWithConnection(function () {
            const id = self._nextId++;
            return new Promise(function (resolve, reject) {
                const timer = setTimeout(function () {
                    self._pendingCreates.delete(id);
                    resolve();
                }, 2000);
                self._pendingCreates.set(id, { resolve: resolve, reject: reject, timer: timer, path: path });
                try {
                    self._sendMessageSafe(self._proto.buildFileDirCreate(id, path));
                } catch (err) {
                    clearTimeout(timer);
                    self._pendingCreates.delete(id);
                    reject(err);
                }
            });
        });
    }

    /**
     * Background read_dir that does not clobber the modal's current listing.
     * @param {string} path
     * @returns {Promise<Array>}
     */
    readDirAsync(path) {
        const self = this;
        if (!this._enabled) return Promise.reject(new Error('File transfer not enabled'));
        const key = this._normalizeRemotePathKey(path);
        return this._runWithConnection(function () {
            return new Promise(function (resolve, reject) {
                if (self._pendingDirReads.has(key)) {
                    const prev = self._pendingDirReads.get(key);
                    clearTimeout(prev.timer);
                }
                const timer = setTimeout(function () {
                    self._pendingDirReads.delete(key);
                    reject(new Error('Remote directory listing timed out'));
                }, 10000);
                self._pendingDirReads.set(key, { resolve: resolve, reject: reject, timer: timer });
                try {
                    self._sendMessageSafe(self._proto.buildReadDir(path || '', self._showHidden));
                } catch (err) {
                    clearTimeout(timer);
                    self._pendingDirReads.delete(key);
                    reject(err);
                }
            });
        });
    }

    /**
     * Upload a local folder tree as one folder job (sequential children).
     * @param {Object} walk - { rootName, dirs[], files[] } from LocalFiles.walk*
     * @param {string} remoteDest - Remote parent directory
     * @returns {number} Folder job id
     */
    uploadFolder(walk, remoteDest) {
        if (!this._enabled || !walk) return -1;
        const rootName = walk.rootName || 'folder';
        const dirs = walk.dirs || [];
        const files = walk.files || [];
        let totalSize = 0;
        for (let i = 0; i < files.length; i++) totalSize += Number(files[i].size || 0);

        const id = this._nextId++;
        const job = {
            id: id,
            type: 'upload',
            isFolder: true,
            fileName: rootName,
            fileSize: totalSize,
            transferred: 0,
            status: 'queued',
            remoteDest: remoteDest || '',
            rootName: rootName,
            dirs: dirs,
            files: files,
            currentFile: null,
            childId: null,
            fileIndex: 0
        };
        this._enqueueFolderJob(job);
        return id;
    }

    /**
     * Download a remote folder tree as one folder job.
     * @param {string} remotePath - Parent directory of the folder
     * @param {Object} folderEntry - { name, isDir }
     * @param {string} localRoot - Absolute local destination directory (parent)
     * @returns {number} Folder job id
     */
    downloadFolder(remotePath, folderEntry, localRoot) {
        if (!this._enabled || !folderEntry || !localRoot) return -1;
        const id = this._nextId++;
        const job = {
            id: id,
            type: 'download',
            isFolder: true,
            fileName: folderEntry.name,
            fileSize: 0,
            transferred: 0,
            status: 'queued',
            remotePath: remotePath || '',
            folderEntry: folderEntry,
            localRoot: localRoot,
            currentFile: null,
            childId: null,
            pendingFiles: [],
            fileIndex: 0
        };
        this._enqueueFolderJob(job);
        return id;
    }

    _enqueueFolderJob(job) {
        this._emit('file_transfer_start', {
            id: job.id,
            type: job.type,
            fileName: job.fileName,
            fileSize: job.fileSize,
            isFolder: true,
            percent: 0
        });
        this._folderJobQueue.push(job);
        this._pumpFolderJobs();
    }

    _pumpFolderJobs() {
        if (this._activeFolderJob) return;
        const job = this._folderJobQueue.shift();
        if (!job) return;
        this._activeFolderJob = job;
        job.status = 'transferring';
        const self = this;
        const run = job.type === 'upload'
            ? this._runFolderUpload(job)
            : this._runFolderDownload(job);
        Promise.resolve(run).catch(function (err) {
            if (self._activeFolderJob && self._activeFolderJob.id === job.id) {
                job.status = 'error';
                self._emit('file_transfer_error', {
                    id: job.id,
                    fileName: job.fileName,
                    error: err.message || String(err),
                    resumable: false,
                    type: job.type,
                    isFolder: true
                });
                self._activeFolderJob = null;
                self._pumpFolderJobs();
            }
        });
    }

    _cancelFolderJob(id) {
        const job = this._activeFolderJob;
        if (!job || job.id !== id) return;
        job.status = 'cancelled';
        if (job.childId != null) {
            const child = this._transfers.get(job.childId);
            if (child) {
                child.folderJobId = null;
                this.cancelTransfer(job.childId);
            }
        }
        this._activeFolderJob = null;
        this._emit('file_transfer_cancelled', {
            id: id,
            fileName: job.fileName,
            isFolder: true
        });
        this._pumpFolderJobs();
    }

    _emitFolderProgress(job) {
        const percent = job.fileSize > 0
            ? Math.min(100, Math.round((job.transferred / job.fileSize) * 100))
            : 0;
        this._emit('file_transfer_progress', {
            id: job.id,
            fileName: job.fileName,
            fileSize: job.fileSize,
            transferred: job.transferred,
            percent: percent,
            type: job.type,
            isFolder: true,
            currentFile: job.currentFile,
            phase: 'transferring'
        });
    }

    _finishFolderJob(job, ok) {
        if (this._activeFolderJob && this._activeFolderJob.id === job.id) {
            this._activeFolderJob = null;
        }
        if (job.status === 'cancelled') {
            this._pumpFolderJobs();
            return;
        }
        if (ok) {
            job.status = 'complete';
            this._emit('file_transfer_complete', {
                id: job.id,
                fileName: job.fileName,
                fileSize: job.fileSize,
                type: job.type,
                isFolder: true,
                elapsed: (Date.now() - (job.startTime || Date.now())) / 1000
            });
            if (job.type === 'upload') {
                this.browseDir(this._currentPath);
            }
        }
        this._pumpFolderJobs();
    }

    _waitForChildTransfer(childId) {
        const self = this;
        return new Promise(function (resolve) {
            const transfer = self._transfers.get(childId);
            if (!transfer) {
                resolve(false);
                return;
            }
            transfer._folderWait = resolve;
        });
    }

    _onChildTransferSettled(folderJobId, childId, ok) {
        const job = this._activeFolderJob;
        if (!job || job.id !== folderJobId) return;
        const transfer = this._transfers.get(childId);
        if (transfer && typeof transfer._folderWait === 'function') {
            const resolve = transfer._folderWait;
            transfer._folderWait = null;
            resolve(ok);
        }
    }

    async _runFolderUpload(job) {
        job.startTime = Date.now();
        const remoteRoot = RDFileTransfer.buildRemoteFilePath(job.remoteDest || '', job.rootName);
        try {
            await this.createDirAsync(remoteRoot);
            await new Promise(function (r) { setTimeout(r, 0); });

            for (let i = 0; i < job.dirs.length; i++) {
                if (job.status === 'cancelled') return this._finishFolderJob(job, false);
                const rel = job.dirs[i].relativePath || job.dirs[i].name;
                const remoteDir = RDFileTransfer.buildRemoteRelativePath(remoteRoot, rel);
                job.currentFile = rel;
                this._emitFolderProgress(job);
                await this.createDirAsync(remoteDir);
                await new Promise(function (r) { setTimeout(r, 0); });
            }

            for (let i = 0; i < job.files.length; i++) {
                if (job.status === 'cancelled') return this._finishFolderJob(job, false);
                const item = job.files[i];
                const rel = item.relativePath || item.name;
                job.currentFile = rel;
                job.fileIndex = i;
                this._emitFolderProgress(job);

                let file = item.file || null;
                if (!file && item.path && typeof LocalFiles !== 'undefined') {
                    const info = await window.__TAURI__.core.invoke('desktop_open_file', { path: item.path });
                    file = LocalFiles.createNativeUploadFile(info);
                }
                if (!file) {
                    throw new Error('Could not open local file: ' + rel);
                }

                // Upload into remoteRoot with relative name so peer creates nested path.
                const parentRel = rel.includes('/') ? rel.replace(/\/[^/]+$/, '') : '';
                const remoteParent = parentRel
                    ? RDFileTransfer.buildRemoteRelativePath(remoteRoot, parentRel)
                    : remoteRoot;
                const baseName = rel.includes('/') ? rel.split('/').pop() : rel;

                const childId = this.uploadFile(file, remoteParent, {
                    remoteFileName: baseName,
                    folderJobId: job.id,
                    silent: true
                });
                job.childId = childId;
                const ok = await this._waitForChildTransfer(childId);
                job.childId = null;
                if (job.status === 'cancelled') return this._finishFolderJob(job, false);
                if (!ok) {
                    throw new Error('Failed to upload ' + rel);
                }
                job.transferred += Number(item.size || file.size || 0);
                this._emitFolderProgress(job);
                await new Promise(function (r) { setTimeout(r, 0); });
            }

            this._finishFolderJob(job, true);
        } catch (err) {
            if (job.status === 'cancelled') return this._finishFolderJob(job, false);
            job.status = 'error';
            this._emit('file_transfer_error', {
                id: job.id,
                fileName: job.fileName,
                error: err.message || String(err),
                resumable: false,
                type: 'upload',
                isFolder: true,
                currentFile: job.currentFile
            });
            this._finishFolderJob(job, false);
        }
    }

    async _expandRemoteFolder(remoteFolderPath) {
        const dirs = [];
        const files = [];
        let totalSize = 0;
        const queue = [remoteFolderPath];
        while (queue.length) {
            const dirPath = queue.shift();
            const entries = await this.readDirAsync(dirPath);
            for (let i = 0; i < entries.length; i++) {
                const e = entries[i];
                const childPath = RDFileTransfer.buildRemoteFilePath(dirPath, e.name);
                const rel = remoteFolderPath
                    ? childPath.slice(this._normalizeRemotePathKey(remoteFolderPath).length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
                    : e.name;
                if (e.isDir) {
                    dirs.push({ name: e.name, path: childPath, relativePath: rel });
                    queue.push(childPath);
                } else {
                    files.push({
                        name: e.name,
                        path: childPath,
                        relativePath: rel,
                        size: Number(e.size || 0),
                        modifiedTime: Number(e.modifiedTime || 0),
                        entry: e,
                        parentPath: dirPath
                    });
                    totalSize += Number(e.size || 0);
                }
            }
            await new Promise(function (r) { setTimeout(r, 0); });
        }
        dirs.sort(function (a, b) {
            return a.relativePath.length - b.relativePath.length
                || a.relativePath.localeCompare(b.relativePath);
        });
        return { dirs: dirs, files: files, totalSize: totalSize };
    }

    async _runFolderDownload(job) {
        job.startTime = Date.now();
        const remoteFolder = RDFileTransfer.buildRemoteFilePath(
            job.remotePath || '', job.folderEntry.name
        );
        const localFolder = RDFileTransfer.joinLocalPath(job.localRoot, job.folderEntry.name);
        try {
            if (typeof LocalFiles !== 'undefined' && LocalFiles.isDesktopBridge()) {
                await window.__TAURI__.core.invoke('desktop_mkdir_p', { path: localFolder });
            }

            job.currentFile = '';
            this._emit('file_transfer_progress', {
                id: job.id,
                fileName: job.fileName,
                fileSize: 0,
                transferred: 0,
                percent: 0,
                type: 'download',
                isFolder: true,
                phase: 'transferring',
                currentFile: '…'
            });

            const tree = await this._expandRemoteFolder(remoteFolder);
            if (job.status === 'cancelled') return this._finishFolderJob(job, false);
            job.fileSize = tree.totalSize;
            job.pendingFiles = tree.files;
            this._emitFolderProgress(job);

            for (let i = 0; i < tree.dirs.length; i++) {
                if (job.status === 'cancelled') return this._finishFolderJob(job, false);
                const localDir = RDFileTransfer.joinLocalPath(localFolder, tree.dirs[i].relativePath);
                await window.__TAURI__.core.invoke('desktop_mkdir_p', { path: localDir });
            }

            for (let i = 0; i < tree.files.length; i++) {
                if (job.status === 'cancelled') return this._finishFolderJob(job, false);
                const item = tree.files[i];
                job.currentFile = item.relativePath;
                job.fileIndex = i;
                this._emitFolderProgress(job);

                const localParent = RDFileTransfer.joinLocalPath(
                    localFolder,
                    item.relativePath.includes('/')
                        ? item.relativePath.replace(/\/[^/]+$/, '')
                        : ''
                );
                if (localParent && localParent !== localFolder) {
                    await window.__TAURI__.core.invoke('desktop_mkdir_p', { path: localParent });
                }
                const absolutePath = RDFileTransfer.joinLocalPath(localFolder, item.relativePath);

                const childId = this.downloadFile(item.parentPath, item.entry || {
                    name: item.name,
                    size: item.size,
                    modifiedTime: item.modifiedTime
                }, {
                    absolutePath: absolutePath,
                    folderJobId: job.id,
                    silent: true,
                    localFileName: item.relativePath
                });
                job.childId = childId;
                const ok = await this._waitForChildTransfer(childId);
                job.childId = null;
                if (job.status === 'cancelled') return this._finishFolderJob(job, false);
                if (!ok) {
                    throw new Error('Failed to download ' + item.relativePath);
                }
                job.transferred += Number(item.size || 0);
                this._emitFolderProgress(job);
                await new Promise(function (r) { setTimeout(r, 0); });
            }

            this._finishFolderJob(job, true);
        } catch (err) {
            if (job.status === 'cancelled') return this._finishFolderJob(job, false);
            job.status = 'error';
            this._emit('file_transfer_error', {
                id: job.id,
                fileName: job.fileName,
                error: err.message || String(err),
                resumable: false,
                type: 'download',
                isFolder: true,
                currentFile: job.currentFile
            });
            this._finishFolderJob(job, false);
        }
    }

    /**
     * Delete file on remote
     * @param {string} path
     */
    removeFile(path) {
        if (!this._enabled) return;
        const id = this._nextId++;
        this._sendMessage(this._proto.buildFileRemove(id, path, 0));
        this._emit('file_action', { action: 'remove_file', path: path });
    }

    /**
     * Delete directory on remote
     * @param {string} path
     * @param {boolean} recursive
     */
    removeDir(path, recursive) {
        if (!this._enabled) return;
        const id = this._nextId++;
        this._sendMessage(this._proto.buildFileRemoveDir(id, path, recursive));
        this._emit('file_action', { action: 'remove_dir', path: path });
    }

    /**
     * Rename file/directory on remote
     * @param {string} path
     * @param {string} newName
     */
    rename(path, newName) {
        if (!this._enabled) return;
        const id = this._nextId++;
        this._sendMessage(this._proto.buildFileRename(id, path, newName));
        this._emit('file_action', { action: 'rename', path: path, newName: newName });
    }

    // ---- Incoming message handlers ----

    /**
     * Handle FileResponse from peer
     * @param {Object} resp - Decoded FileResponse protobuf
     */
    handleFileResponse(resp) {
        console.log('[FileTransfer] handleFileResponse:', Object.keys(resp).filter(k => resp[k] != null).join(', '));
        if (resp.dir) {
            this._handleDir(resp.dir);
        } else if (resp.block) {
            this._handleBlock(resp.block);
        } else if (resp.digest) {
            this._handleDigest(resp.digest);
        } else if (resp.done) {
            this._handleDone(resp.done);
        } else if (resp.error) {
            this._handleError(resp.error);
        }
    }

    /**
     * Handle directory listing response
     * @param {Object} dir - FileDirectory { id, path, entries[] }
     */
    _handleDir(dir) {
        // Clear browse timeout — we got a response
        if (this._browseTimeout) {
            clearTimeout(this._browseTimeout);
            this._browseTimeout = null;
        }
        this._browseTimedOut = false;

        console.log('[FileTransfer] _handleDir: path=%s entries=%d', dir.path || '(root)', (dir.entries || []).length);
        const entries = (dir.entries || []).map(e => ({
            name: e.name,
            entryType: e.entryType != null ? e.entryType : (e.entry_type != null ? e.entry_type : 0),
            isHidden: !!e.isHidden,
            size: Number(e.size || 0),
            modifiedTime: Number(e.modifiedTime || e.modified_time || 0),
            isDir: (e.entryType || e.entry_type || 0) <= 3
        }));

        // Sort: directories first, then by name
        entries.sort((a, b) => {
            if (a.isDir && !b.isDir) return -1;
            if (!a.isDir && b.isDir) return 1;
            return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });

        const pathKey = this._normalizeRemotePathKey(dir.path || '');
        let pending = null;
        if (this._pendingDirReads.has(pathKey)) {
            pending = this._pendingDirReads.get(pathKey);
            this._pendingDirReads.delete(pathKey);
        } else if (this._pendingDirReads.size === 1) {
            // Peers may return a slightly different path string — match the sole pending read.
            const onlyKey = this._pendingDirReads.keys().next().value;
            pending = this._pendingDirReads.get(onlyKey);
            this._pendingDirReads.delete(onlyKey);
        }
        if (pending) {
            clearTimeout(pending.timer);
            pending.resolve(entries);
            return;
        }

        this._currentPath = dir.path || '';
        this._entries = entries;
        this._emit('file_dir', {
            path: this._currentPath,
            entries: this._entries
        });
    }

    /**
     * Handle transfer digest (file metadata before data blocks)
     * @param {Object} digest - FileTransferDigest
     */
    _handleDigest(digest) {
        const id = Number(digest.id);
        const transfer = this._transfers.get(id);
        if (!transfer) return;

        this._clearTransferTimeout(id);
        transfer.fileSize = Number(digest.fileSize || digest.file_size || transfer.fileSize || 0);
        transfer.fileNum = Number(digest.fileNum != null ? digest.fileNum : (digest.file_num || 0));
        transfer.status = 'transferring';

        const fileNum = transfer.fileNum;
        const isIdentical = !!(digest.isIdentical || digest.is_identical);
        const transferredSize = Number(
            digest.transferredSize != null ? digest.transferredSize : (digest.transferred_size || 0)
        );
        const isResume = !!(digest.isResume || digest.is_resume);

        if (transfer.type === 'download') {
            let offsetBlk = 0;
            if (isResume && transferredSize > 0) {
                offsetBlk = RDFileTransfer.computeOffsetBlk(transferredSize, this.BLOCK_SIZE);
                transfer.receivedBytes = transferredSize;
            } else if (transfer.receivedBytes > 0) {
                offsetBlk = RDFileTransfer.computeOffsetBlk(transfer.receivedBytes, this.BLOCK_SIZE);
            }
            this._sendMessageSafe(this._proto.buildFileSendConfirm(id, fileNum, false, offsetBlk));
        } else if (transfer.type === 'upload') {
            // Peer-initiated digest (overwrite check) — operator already sent initial digest.
            if (!(digest.isUpload || digest.is_upload)) return;
            if (isIdentical) {
                this._sendMessageSafe(this._proto.buildFileSendConfirm(id, fileNum, true, 0));
                if (typeof transfer._folderWait === 'function') {
                    const resolve = transfer._folderWait;
                    transfer._folderWait = null;
                    resolve(true);
                } else {
                    this._emit('file_transfer_complete', {
                        id: id,
                        fileName: transfer.fileName,
                        fileSize: transfer.fileSize,
                        type: 'upload',
                        elapsed: (Date.now() - transfer.startTime) / 1000
                    });
                }
                this._transfers.delete(id);
                return;
            }
            const self = this;
            const proceedUpload = function (skip) {
                if (skip) {
                    self._sendMessageSafe(self._proto.buildFileSendConfirm(id, fileNum, true, 0));
                    if (typeof transfer._folderWait === 'function') {
                        const resolve = transfer._folderWait;
                        transfer._folderWait = null;
                        resolve(true);
                    } else {
                        self._emit('file_transfer_complete', {
                            id: id,
                            fileName: transfer.fileName,
                            fileSize: transfer.fileSize,
                            type: 'upload',
                            elapsed: (Date.now() - transfer.startTime) / 1000,
                            skipped: true
                        });
                    }
                    self._transfers.delete(id);
                    return;
                }
                self._sendMessageSafe(self._proto.buildFileSendConfirm(id, fileNum, false, 0));
                self._sendUploadBlocks(transfer, transfer.sentBytes || 0);
            };

            if (this._overwriteStrategy === 'skip') {
                proceedUpload(true);
                return;
            }
            if (this._overwriteStrategy === 'overwrite') {
                proceedUpload(false);
                return;
            }

            this._pendingOverwrite.set(id, {
                resolve: proceedUpload
            });
            this._emit('file_transfer_overwrite_prompt', {
                id: id,
                fileName: transfer.fileName,
                fileSize: transfer.fileSize,
                remotePath: transfer.remotePath
            });
            return;
        }

        const startTransferred = transfer.type === 'download'
            ? (transfer.receivedBytes || transferredSize || 0)
            : (transfer.sentBytes || 0);
        this._emit('file_transfer_progress', {
            id: id,
            fileName: transfer.fileName,
            fileSize: transfer.fileSize,
            transferred: startTransferred,
            percent: transfer.fileSize > 0
                ? Math.min(100, Math.round((startTransferred / transfer.fileSize) * 100))
                : 0,
            type: transfer.type,
            phase: 'transferring'
        });
    }

    /**
     * Handle FileAction.send_confirm from peer (upload ready to stream).
     * @param {Object} confirm - FileTransferSendConfirmRequest
     */
    handleSendConfirm(confirm) {
        const id = Number(confirm.id);
        const transfer = this._transfers.get(id);
        if (!transfer || transfer.type !== 'upload') return;

        this._clearTransferTimeout(id);
        transfer.fileNum = Number(confirm.fileNum != null ? confirm.fileNum : (confirm.file_num || 0));

        if (confirm.skip === true) {
            if (typeof transfer._folderWait === 'function') {
                const resolve = transfer._folderWait;
                transfer._folderWait = null;
                resolve(true);
            } else {
                this._emit('file_transfer_complete', {
                    id: id,
                    fileName: transfer.fileName,
                    fileSize: transfer.fileSize,
                    type: 'upload',
                    elapsed: (Date.now() - transfer.startTime) / 1000
                });
            }
            this._transfers.delete(id);
            return;
        }

        const offsetBlk = Number(
            confirm.offsetBlk != null ? confirm.offsetBlk : (confirm.offset_blk || 0)
        );
        const startOffset = offsetBlk > 0
            ? offsetBlk * this.BLOCK_SIZE
            : (transfer.sentBytes || 0);

        transfer.status = 'transferring';
        this._emit('file_transfer_progress', {
            id: id,
            fileName: transfer.fileName,
            fileSize: transfer.fileSize,
            transferred: startOffset,
            percent: transfer.fileSize > 0
                ? Math.min(100, Math.round((startOffset / transfer.fileSize) * 100))
                : 0,
            type: 'upload',
            phase: 'transferring'
        });
        this._sendUploadBlocks(transfer, startOffset);
    }

    /**
     * Handle data block (download)
     * @param {Object} block - FileTransferBlock { id, file_num, data, compressed, blk_id }
     */
    _handleBlock(block) {
        const id = Number(block.id);
        const transfer = this._transfers.get(id);
        if (!transfer || transfer.type !== 'download') return;

        const self = this;
        const emitProgress = function () {
            const percent = transfer.fileSize > 0
                ? Math.min(100, Math.round((transfer.receivedBytes / transfer.fileSize) * 100))
                : 0;
            if (transfer.folderJobId && self._activeFolderJob
                && self._activeFolderJob.id === transfer.folderJobId) {
                const job = self._activeFolderJob;
                const childTransferred = transfer.receivedBytes || 0;
                self._emit('file_transfer_progress', {
                    id: job.id,
                    fileName: job.fileName,
                    fileSize: job.fileSize,
                    transferred: job.transferred + childTransferred,
                    percent: job.fileSize > 0
                        ? Math.min(100, Math.round(((job.transferred + childTransferred) / job.fileSize) * 100))
                        : percent,
                    type: 'download',
                    isFolder: true,
                    currentFile: job.currentFile,
                    phase: 'transferring'
                });
                return;
            }
            self._emit('file_transfer_progress', {
                id: id,
                fileName: transfer.fileName,
                fileSize: transfer.fileSize,
                transferred: transfer.receivedBytes,
                percent: percent,
                type: 'download',
                phase: 'transferring'
            });
        };

        const applyBlock = function (data) {
            const bytes = data && data.length
                ? (data instanceof Uint8Array ? data : new Uint8Array(data))
                : null;
            if (transfer.streamDownload && transfer.downloadHandle) {
                transfer.writeChain = transfer.writeChain.then(function () {
                    if (!bytes || !bytes.length) {
                        emitProgress();
                        return null;
                    }
                    return LocalFiles.writeDownload(transfer.downloadHandle, bytes).then(function () {
                        transfer.receivedBytes += bytes.length;
                        emitProgress();
                    });
                }).catch(function (err) {
                    self._failTransfer(id, 'Failed to write download: ' + (err.message || String(err)));
                });
                return;
            }
            if (bytes && bytes.length) {
                if (!transfer.blocks) transfer.blocks = [];
                transfer.blocks.push(bytes);
                transfer.receivedBytes += bytes.length;
            }
            emitProgress();
        };

        const raw = block.data;
        if (block.compressed && raw && raw.length) {
            this._decompressBlock(raw).then(applyBlock).catch(function (err) {
                self._failTransfer(id, 'Failed to decompress block: ' + (err.message || String(err)));
            });
            return;
        }
        applyBlock(raw);
    }

    /**
     * Decompress a zstd block from the RustDesk peer (when compressed=true).
     * @param {Uint8Array|Buffer|Array} data
     * @returns {Promise<Uint8Array>}
     */
    async _decompressBlock(data) {
        return RDCompress.decompressZstd(data, { force: true });
    }

    /**
     * Handle transfer done
     * @param {Object} done - FileTransferDone { id, file_num }
     */
    _handleDone(done) {
        const id = Number(done.id);
        const transfer = this._transfers.get(id);
        if (!transfer) return;

        this._clearTransferTimeout(id);
        transfer.status = 'complete';
        const elapsed = (Date.now() - transfer.startTime) / 1000;
        const self = this;
        const folderJobId = transfer.folderJobId || null;

        const finishComplete = function () {
            if (!folderJobId) {
                self._emit('file_transfer_complete', {
                    id: id,
                    fileName: transfer.fileName,
                    fileSize: transfer.fileSize,
                    type: transfer.type,
                    elapsed: elapsed
                });
            }

            if (typeof transfer._folderWait === 'function') {
                const resolve = transfer._folderWait;
                transfer._folderWait = null;
                resolve(true);
            }

            self._transfers.delete(id);

            if (transfer.type === 'upload' && !folderJobId) {
                self.browseDir(self._currentPath);
            }
        };

        if (transfer.type === 'download') {
            if (transfer.streamDownload && transfer.downloadHandle) {
                if (!folderJobId) {
                    this._emit('file_transfer_progress', {
                        id: id,
                        fileName: transfer.fileName,
                        fileSize: transfer.fileSize,
                        transferred: transfer.receivedBytes,
                        percent: 100,
                        type: 'download',
                        phase: 'saving'
                    });
                }
                transfer.writeChain.then(function () {
                    return LocalFiles.finishDownload(transfer.downloadHandle);
                }).then(function () {
                    transfer.downloadHandle = null;
                    finishComplete();
                }).catch(function (err) {
                    self._failTransfer(id, 'Failed to save file: ' + (err.message || String(err)));
                });
                return;
            }
            if (!folderJobId) {
                this._emit('file_transfer_progress', {
                    id: id,
                    fileName: transfer.fileName,
                    fileSize: transfer.fileSize,
                    transferred: transfer.receivedBytes,
                    percent: 100,
                    type: 'download',
                    phase: 'saving'
                });
            }
            this._triggerDownload(transfer);
        }

        finishComplete();
    }

    /**
     * Handle transfer error
     * @param {Object} error - FileTransferError { id, error, file_num }
     */
    _handleError(error) {
        const id = Number(error.id);
        const pendingCreate = this._pendingCreates.get(id);
        if (pendingCreate) {
            clearTimeout(pendingCreate.timer);
            this._pendingCreates.delete(id);
            // Remote mkdir failed — still resolve so upload can attempt file create,
            // unless the message clearly indicates a hard failure.
            const msg = String(error.error || '');
            if (/denied|not allowed|permission|no such/i.test(msg)) {
                pendingCreate.reject(new Error(msg || 'Could not create remote folder'));
            } else {
                pendingCreate.resolve();
            }
            return;
        }

        const transfer = this._transfers.get(id);
        const fileName = transfer ? transfer.fileName : 'unknown';

        if (transfer) {
            this._clearTransferTimeout(id);
            transfer.status = 'error';
            transfer.resumable = !transfer.folderJobId
                && (transfer.receivedBytes || transfer.sentBytes || 0) > 0;
            if (transfer.downloadHandle && typeof LocalFiles !== 'undefined' && LocalFiles.abortDownload) {
                LocalFiles.abortDownload(transfer.downloadHandle, !transfer.resumable)
                    .catch(function () { /* ignore */ });
                if (!transfer.resumable) transfer.downloadHandle = null;
            }
            if (typeof transfer._folderWait === 'function') {
                const resolve = transfer._folderWait;
                transfer._folderWait = null;
                resolve(false);
            }
            if (!transfer.resumable) {
                this._transfers.delete(id);
            }
        }

        this._emit('file_transfer_error', {
            id: id,
            fileName: fileName,
            error: error.error || 'Unknown error',
            resumable: transfer ? transfer.resumable : false,
            type: transfer ? transfer.type : null,
            folderJobId: transfer ? transfer.folderJobId : null
        });
    }

    // ---- Upload block streaming ----

    async _tryCompressBlock(data, fileName) {
        if (RDFileTransfer.isPreCompressedFileName(fileName)) {
            return { data: data, compressed: false };
        }
        const result = await RDCompress.compressZstd(data);
        return { data: result.content, compressed: result.compress };
    }

    /**
     * Stream file blocks for upload
     * @param {Object} transfer
     * @param {number} [startOffset=0]
     */
    async _sendUploadBlocks(transfer, startOffset) {
        const file = transfer.file;
        if (!file) return;

        const readSlice = async function (offset, end) {
            if (file.__rdNativeHandle) {
                const length = end - offset;
                const bytes = await (window.__TAURI__ && window.__TAURI__.core
                    ? window.__TAURI__.core.invoke('desktop_read_file_chunk', {
                        handle: file.__rdNativeHandle,
                        offset: offset,
                        length: length
                    })
                    : Promise.reject(new Error('Desktop bridge unavailable')));
                if (bytes instanceof Uint8Array) return bytes;
                return new Uint8Array(bytes || []);
            }
            const slice = file.slice(offset, end);
            return new Uint8Array(await slice.arrayBuffer());
        };

        try {
            let offset = Math.max(0, Number(startOffset || 0));
            let blkId = RDFileTransfer.computeOffsetBlk(offset, this.BLOCK_SIZE);

            while (offset < file.size && transfer.status === 'transferring') {
                const end = Math.min(offset + this.BLOCK_SIZE, file.size);
                const raw = await readSlice(offset, end);
                const packed = await this._tryCompressBlock(raw, file.name);

                this._sendMessageSafe(this._proto.buildFileBlock(
                    transfer.id, transfer.fileNum, packed.data, packed.compressed, blkId
                ));

                transfer.sentBytes = end;
                blkId++;
                offset = end;

                const percent = Math.min(100, Math.round((end / file.size) * 100));
                if (transfer.folderJobId && this._activeFolderJob
                    && this._activeFolderJob.id === transfer.folderJobId) {
                    const job = this._activeFolderJob;
                    this._emit('file_transfer_progress', {
                        id: job.id,
                        fileName: job.fileName,
                        fileSize: job.fileSize,
                        transferred: job.transferred + end,
                        percent: job.fileSize > 0
                            ? Math.min(100, Math.round(((job.transferred + end) / job.fileSize) * 100))
                            : percent,
                        type: 'upload',
                        isFolder: true,
                        currentFile: job.currentFile,
                        phase: 'transferring'
                    });
                } else {
                    this._emit('file_transfer_progress', {
                        id: transfer.id,
                        fileName: transfer.fileName,
                        fileSize: transfer.fileSize,
                        transferred: end,
                        percent: percent,
                        type: 'upload'
                    });
                }

                // Yield to event loop every 16 blocks to avoid blocking UI
                if (blkId % 16 === 0) {
                    await new Promise(r => setTimeout(r, 0));
                }
            }

            // Send done
            if (transfer.status === 'transferring') {
                this._sendMessageSafe(this._proto.buildFileDone(transfer.id, transfer.fileNum));
            }

            if (file.__rdNativeHandle && window.__TAURI__ && window.__TAURI__.core) {
                window.__TAURI__.core.invoke('desktop_release_file_handles', {
                    handles: [file.__rdNativeHandle]
                }).catch(function () { /* ignore */ });
            }
        } catch (err) {
            transfer.status = 'error';
            transfer.resumable = !transfer.folderJobId
                && (transfer.sentBytes || 0) > 0 && (transfer.sentBytes || 0) < file.size;
            if (typeof transfer._folderWait === 'function') {
                const resolve = transfer._folderWait;
                transfer._folderWait = null;
                resolve(false);
            }
            this._emit('file_transfer_error', {
                id: transfer.id,
                fileName: transfer.fileName,
                error: err.message || 'Upload failed',
                resumable: transfer.resumable,
                type: 'upload',
                folderJobId: transfer.folderJobId || null
            });
            if (!transfer.resumable) {
                this._transfers.delete(transfer.id);
            }
        }
    }

    // ---- Browser download trigger ----

    /**
     * Assemble received blocks into a Blob and trigger download
     * @param {Object} transfer
     */
    _triggerDownload(transfer) {
        if (transfer.streamDownload) return;
        const blocks = transfer.blocks || [];

        const self = this;
        try {
            const blob = new Blob(blocks, { type: 'application/octet-stream' });
            const finishBrowserDownload = function () {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = transfer.fileName;
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                setTimeout(function () {
                    URL.revokeObjectURL(url);
                    a.remove();
                }, 5000);
            };

            if (typeof this._saveDownload === 'function') {
                Promise.resolve(this._saveDownload(transfer.fileName, blob)).then(function (savedToFolder) {
                    if (!savedToFolder) finishBrowserDownload();
                }).catch(function (err) {
                    self._emit('file_transfer_error', {
                        id: transfer.id,
                        fileName: transfer.fileName,
                        error: 'Failed to save file: ' + (err.message || 'unknown error')
                    });
                });
                return;
            }
            finishBrowserDownload();
        } catch (err) {
            this._emit('file_transfer_error', {
                id: transfer.id,
                fileName: transfer.fileName,
                error: 'Failed to save file: ' + (err.message || 'unknown error')
            });
        }
    }

    // ---- Utility ----

    /**
     * Format file size for display
     * @param {number} bytes
     * @returns {string}
     */
    static formatSize(bytes) {
        if (bytes === 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
    }

    /**
     * Format timestamp to locale string
     * @param {number} ts - Unix timestamp in seconds
     * @returns {string}
     */
    static formatTime(ts) {
        if (!ts) return '';
        return new Date(ts * 1000).toLocaleString();
    }

    /**
     * Get icon name for file entry type
     * @param {Object} entry
     * @returns {string} Material Icons name
     */
    static getFileIcon(entry) {
        if (entry.isDir) {
            if (entry.entryType === 3) return 'storage'; // Drive
            return 'folder';
        }
        const ext = (entry.name || '').split('.').pop().toLowerCase();
        const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico'];
        const videoExts = ['mp4', 'avi', 'mkv', 'mov', 'wmv', 'flv', 'webm'];
        const audioExts = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'wma', 'm4a'];
        const docExts = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'csv'];
        const codeExts = ['js', 'ts', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'css', 'html', 'json', 'xml', 'yml', 'yaml', 'toml', 'sh', 'bat', 'ps1'];
        const archiveExts = ['zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz'];

        if (imageExts.includes(ext)) return 'image';
        if (videoExts.includes(ext)) return 'movie';
        if (audioExts.includes(ext)) return 'music_note';
        if (docExts.includes(ext)) return 'description';
        if (codeExts.includes(ext)) return 'code';
        if (archiveExts.includes(ext)) return 'archive';
        if (ext === 'exe' || ext === 'msi') return 'apps';
        return 'insert_drive_file';
    }

    /**
     * Get transfer statistics
     * @returns {Object}
     */
    getStats() {
        const active = [];
        for (const [, t] of this._transfers) {
            const transferred = t.type === 'download' ? t.receivedBytes : (t.sentBytes || 0);
            const elapsed = (Date.now() - t.startTime) / 1000;
            active.push({
                id: t.id,
                type: t.type,
                fileName: t.fileName,
                fileSize: t.fileSize,
                transferred: transferred,
                percent: t.fileSize > 0 ? Math.round((transferred / t.fileSize) * 100) : 0,
                speed: elapsed > 0 ? transferred / elapsed : 0,
                status: t.status
            });
        }
        return { active: active, count: active.length };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports.RDFileTransfer = RDFileTransfer;
}
