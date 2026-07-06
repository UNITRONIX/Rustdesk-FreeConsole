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
            type: transfer.type
        });
    }

    _needsFileConnection() {
        return this._ensureConnected && (!this._isConnected || !this._isConnected());
    }

    _runWithConnection(run) {
        const self = this;
        if (this._ensureConnected) {
            if (this._needsFileConnection()) {
                this._emit('file_connecting');
            }
            return this._ensureConnected().then(function () {
                run();
            }).catch(function (err) {
                throw err;
            });
        }
        run();
        return Promise.resolve();
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
                    const fullPath = RDFileTransfer.buildRemoteFilePath(
                        transfer.remotePath, transfer.fileName
                    );
                    self._sendMessageSafe(self._proto.buildFileSendRequest(
                        id, fullPath, self._showHidden, transfer.fileNum || 0
                    ));
                    self._armTransferTimeout(id);
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
     * @returns {number} Transfer ID
     */
    downloadFile(remotePath, fileEntry) {
        if (!this._enabled) return -1;

        const id = this._nextId++;
        const transfer = {
            id: id,
            type: 'download',
            remotePath: remotePath,
            fileName: fileEntry.name,
            fileSize: Number(fileEntry.size || 0),
            receivedBytes: 0,
            blocks: [],
            startTime: Date.now(),
            status: 'pending',
            fileNum: 0,
            stallTimer: null
        };
        this._transfers.set(id, transfer);

        this._emit('file_transfer_start', {
            id: id,
            type: 'download',
            fileName: fileEntry.name,
            fileSize: transfer.fileSize
        });

        const self = this;
        this._runWithConnection(function () {
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

        return id;
    }

    /**
     * Upload a file to remote
     * @param {File} file - Browser File object
     * @param {string} remotePath - Remote destination directory
     * @returns {number} Transfer ID
     */
    uploadFile(file, remotePath) {
        if (!this._enabled) return -1;

        const id = this._nextId++;
        const transfer = {
            id: id,
            type: 'upload',
            remotePath: remotePath,
            fileName: file.name,
            fileSize: file.size,
            sentBytes: 0,
            file: file,
            startTime: Date.now(),
            status: 'pending',
            fileNum: 0,
            currentBlk: 0,
            stallTimer: null
        };
        this._transfers.set(id, transfer);

        this._emit('file_transfer_start', {
            id: id,
            type: 'upload',
            fileName: file.name,
            fileSize: file.size
        });

        const self = this;
        this._runWithConnection(function () {
            try {
                const files = [{
                    entryType: self.FILE_TYPE.FILE,
                    name: file.name,
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
     * Cancel a transfer
     * @param {number} id
     */
    cancelTransfer(id) {
        const transfer = this._transfers.get(id);
        if (!transfer) return;

        transfer.status = 'cancelled';
        this._clearTransferTimeout(id);
        try {
            this._sendMessageSafe(this._proto.buildFileCancel(id));
        } catch (_) { /* ignore */ }
        this._transfers.delete(id);

        this._emit('file_transfer_cancelled', { id: id, fileName: transfer.fileName });
    }

    /**
     * Cancel all active transfers
     */
    cancelAll() {
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
        this._currentPath = dir.path || '';
        this._entries = (dir.entries || []).map(e => ({
            name: e.name,
            entryType: e.entryType != null ? e.entryType : (e.entry_type != null ? e.entry_type : 0),
            isHidden: !!e.isHidden,
            size: Number(e.size || 0),
            modifiedTime: Number(e.modifiedTime || e.modified_time || 0),
            isDir: (e.entryType || e.entry_type || 0) <= 3
        }));

        // Sort: directories first, then by name
        this._entries.sort((a, b) => {
            if (a.isDir && !b.isDir) return -1;
            if (!a.isDir && b.isDir) return 1;
            return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });

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
                this._transfers.delete(id);
                this._emit('file_transfer_complete', {
                    id: id,
                    fileName: transfer.fileName,
                    fileSize: transfer.fileSize,
                    type: 'upload',
                    elapsed: (Date.now() - transfer.startTime) / 1000
                });
                return;
            }
            const self = this;
            const proceedUpload = function (skip) {
                if (skip) {
                    self._sendMessageSafe(self._proto.buildFileSendConfirm(id, fileNum, true, 0));
                    self._transfers.delete(id);
                    self._emit('file_transfer_complete', {
                        id: id,
                        fileName: transfer.fileName,
                        fileSize: transfer.fileSize,
                        type: 'upload',
                        elapsed: (Date.now() - transfer.startTime) / 1000,
                        skipped: true
                    });
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
            this._transfers.delete(id);
            this._emit('file_transfer_complete', {
                id: id,
                fileName: transfer.fileName,
                fileSize: transfer.fileSize,
                type: 'upload',
                elapsed: (Date.now() - transfer.startTime) / 1000
            });
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
        const applyBlock = function (data) {
            if (data && data.length > 0) {
                transfer.blocks.push(data);
                transfer.receivedBytes += data.length;
            }
            const percent = transfer.fileSize > 0
                ? Math.min(100, Math.round((transfer.receivedBytes / transfer.fileSize) * 100))
                : 0;
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

        if (transfer.type === 'download') {
            this._emit('file_transfer_progress', {
                id: id,
                fileName: transfer.fileName,
                fileSize: transfer.fileSize,
                transferred: transfer.receivedBytes,
                percent: 100,
                type: 'download',
                phase: 'saving'
            });
            this._triggerDownload(transfer);
        }

        this._emit('file_transfer_complete', {
            id: id,
            fileName: transfer.fileName,
            fileSize: transfer.fileSize,
            type: transfer.type,
            elapsed: elapsed
        });

        this._transfers.delete(id);

        if (transfer.type === 'upload') {
            this.browseDir(this._currentPath);
        }
    }

    /**
     * Handle transfer error
     * @param {Object} error - FileTransferError { id, error, file_num }
     */
    _handleError(error) {
        const id = Number(error.id);
        const transfer = this._transfers.get(id);
        const fileName = transfer ? transfer.fileName : 'unknown';

        if (transfer) {
            this._clearTransferTimeout(id);
            transfer.status = 'error';
            transfer.resumable = (transfer.receivedBytes || transfer.sentBytes || 0) > 0;
            if (!transfer.resumable) {
                this._transfers.delete(id);
            }
        }

        this._emit('file_transfer_error', {
            id: id,
            fileName: fileName,
            error: error.error || 'Unknown error',
            resumable: transfer ? transfer.resumable : false,
            type: transfer ? transfer.type : null
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

        try {
            let offset = Math.max(0, Number(startOffset || 0));
            let blkId = RDFileTransfer.computeOffsetBlk(offset, this.BLOCK_SIZE);

            while (offset < file.size && transfer.status === 'transferring') {
                const end = Math.min(offset + this.BLOCK_SIZE, file.size);
                const slice = file.slice(offset, end);
                const raw = new Uint8Array(await slice.arrayBuffer());
                const packed = await this._tryCompressBlock(raw, file.name);

                this._sendMessageSafe(this._proto.buildFileBlock(
                    transfer.id, transfer.fileNum, packed.data, packed.compressed, blkId
                ));

                transfer.sentBytes = end;
                blkId++;
                offset = end;

                const percent = Math.min(100, Math.round((end / file.size) * 100));
                this._emit('file_transfer_progress', {
                    id: transfer.id,
                    fileName: transfer.fileName,
                    fileSize: transfer.fileSize,
                    transferred: end,
                    percent: percent,
                    type: 'upload'
                });

                // Yield to event loop every 16 blocks to avoid blocking UI
                if (blkId % 16 === 0) {
                    await new Promise(r => setTimeout(r, 0));
                }
            }

            // Send done
            if (transfer.status === 'transferring') {
                this._sendMessageSafe(this._proto.buildFileDone(transfer.id, transfer.fileNum));
            }
        } catch (err) {
            transfer.status = 'error';
            transfer.resumable = (transfer.sentBytes || 0) > 0 && (transfer.sentBytes || 0) < file.size;
            this._emit('file_transfer_error', {
                id: transfer.id,
                fileName: transfer.fileName,
                error: err.message || 'Upload failed',
                resumable: transfer.resumable,
                type: 'upload'
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
        if (!transfer.blocks.length) return;

        const self = this;
        try {
            const blob = new Blob(transfer.blocks, { type: 'application/octet-stream' });
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
