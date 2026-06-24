/**
 * RustDesk-style centered file transfer modal for Web Remote.
 */
(function () {
    'use strict';

    function t(key, fallback) {
        if (typeof window.t === 'function') {
            var val = window.t(key);
            if (val && val !== key) return val;
        }
        return fallback !== undefined ? fallback : key;
    }

    function escapeHtml(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function formatSize(bytes) {
        if (typeof RDFileTransfer !== 'undefined' && RDFileTransfer.formatSize) {
            return RDFileTransfer.formatSize(bytes);
        }
        if (!bytes) return '0 B';
        var i = Math.floor(Math.log(bytes) / Math.log(1024));
        return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + ['B', 'KB', 'MB', 'GB'][i];
    }

    function FileTransferModal() {
        this._el = null;
        this._session = null;
        this._local = new LocalFiles();
        this._localEntries = [];
        this._remoteEntries = [];
        this._selectedLocal = null;
        this._selectedRemote = null;
        this._transfers = new Map();
        this._wiredSessionId = null;
    }

    FileTransferModal.prototype._ensureDom = function () {
        if (this._el) return;
        var el = document.createElement('div');
        el.className = 'file-transfer-modal-overlay';
        el.id = 'file-transfer-modal';
        el.style.display = 'none';
        el.innerHTML =
            '<div class="file-transfer-modal" role="dialog" aria-modal="true">' +
                '<div class="ft-modal-header">' +
                    '<span class="material-icons">folder_open</span>' +
                    '<span class="ft-modal-title"></span>' +
                    '<button type="button" class="ft-modal-close"><span class="material-icons">close</span></button>' +
                '</div>' +
                '<div class="ft-modal-body">' +
                    '<div class="ft-pane ft-pane-local">' +
                        '<div class="ft-pane-head"><span class="material-icons">computer</span><span class="ft-pane-label"></span></div>' +
                        '<div class="ft-pane-toolbar">' +
                            '<button type="button" class="ft-btn ft-local-pick"><span class="material-icons">folder_open</span></button>' +
                            '<button type="button" class="ft-btn ft-local-up"><span class="material-icons">arrow_upward</span></button>' +
                            '<button type="button" class="ft-btn ft-local-home"><span class="material-icons">home</span></button>' +
                            '<span class="ft-path ft-local-path"></span>' +
                            '<button type="button" class="ft-btn ft-btn-action ft-local-send"></button>' +
                        '</div>' +
                        '<div class="ft-local-hint"></div>' +
                        '<div class="ft-list ft-local-list"></div>' +
                        '<input type="file" class="ft-local-file-input" multiple hidden />' +
                    '</div>' +
                    '<div class="ft-pane ft-pane-remote">' +
                        '<div class="ft-pane-head"><span class="material-icons">desktop_windows</span><span class="ft-pane-label"></span></div>' +
                        '<div class="ft-pane-toolbar">' +
                            '<button type="button" class="ft-btn ft-remote-up"><span class="material-icons">arrow_upward</span></button>' +
                            '<button type="button" class="ft-btn ft-remote-home"><span class="material-icons">home</span></button>' +
                            '<span class="ft-path ft-remote-path"></span>' +
                            '<button type="button" class="ft-btn ft-btn-action ft-remote-download"></button>' +
                        '</div>' +
                        '<div class="ft-list ft-remote-list"></div>' +
                    '</div>' +
                    '<div class="ft-pane ft-pane-queue">' +
                        '<div class="ft-pane-head"><span class="material-icons">swap_vert</span><span class="ft-pane-label"></span></div>' +
                        '<div class="ft-queue-list"></div>' +
                        '<div class="ft-queue-empty"><span class="material-icons">sync_alt</span><span></span></div>' +
                    '</div>' +
                '</div>' +
            '</div>';
        document.body.appendChild(el);
        this._el = el;
        el.querySelector('.ft-pane-local .ft-pane-label').textContent = t('remote.file_local', 'Local computer');
        el.querySelector('.ft-pane-remote .ft-pane-label').textContent = t('remote.file_remote', 'Remote computer');
        el.querySelector('.ft-pane-queue .ft-pane-label').textContent = t('remote.file_transfers', 'Transfers');
        el.querySelector('.ft-local-send').innerHTML = t('remote.file_send', 'Send') + ' <span class="material-icons">chevron_right</span>';
        el.querySelector('.ft-remote-download').innerHTML = '<span class="material-icons">chevron_left</span> ' + t('remote.file_download', 'Download');
        el.querySelector('.ft-queue-empty span:last-child').textContent = t('remote.file_queue_empty', 'No transfers in progress');

        var self = this;
        el.querySelector('.ft-modal-close').addEventListener('click', function () { self.close(); });
        el.addEventListener('click', function (e) { if (e.target === el) self.close(); });
        el.querySelector('.ft-local-pick').addEventListener('click', function () { self._pickLocalFolder(); });
        el.querySelector('.ft-local-up').addEventListener('click', function () { self._localGoUp(); });
        el.querySelector('.ft-local-home').addEventListener('click', function () { self._localGoHome(); });
        el.querySelector('.ft-local-send').addEventListener('click', function () { self._sendSelectedLocal(); });
        el.querySelector('.ft-remote-up').addEventListener('click', function () { self._remoteGoUp(); });
        el.querySelector('.ft-remote-home').addEventListener('click', function () { self._remoteGoHome(); });
        el.querySelector('.ft-remote-download').addEventListener('click', function () { self._downloadSelectedRemote(); });
        el.querySelector('.ft-local-file-input').addEventListener('change', function (e) {
            self._uploadFiles(e.target.files);
            e.target.value = '';
        });
        var remotePane = el.querySelector('.ft-pane-remote');
        remotePane.addEventListener('dragover', function (e) { e.preventDefault(); remotePane.classList.add('ft-drag-over'); });
        remotePane.addEventListener('dragleave', function () { remotePane.classList.remove('ft-drag-over'); });
        remotePane.addEventListener('drop', function (e) {
            e.preventDefault();
            remotePane.classList.remove('ft-drag-over');
            if (e.dataTransfer && e.dataTransfer.files.length) self._uploadFiles(e.dataTransfer.files);
        });
    };

    FileTransferModal.prototype.open = function (session) {
        this._ensureDom();
        this._session = session;
        if (!session.client || !session.client.fileTransfer) return;
        this._el.querySelector('.ft-modal-title').textContent =
            t('remote.file_transfer', 'File Transfer') + ' — ' + (session.deviceName || session.deviceId);
        this._updateLocalHint();
        this._el.style.display = 'flex';
        document.getElementById('btn-file-transfer')?.classList.add('active');
        if (this._wiredSessionId !== session.deviceId) {
            this._wireClient(session);
            this._wiredSessionId = session.deviceId;
        }
        var ft = session.client.fileTransfer;
        var self = this;
        ft._saveDownload = function (fileName, blob) {
            return self._local.saveDownload(fileName, blob);
        };
        session.client.fileTransfer.browseDir('');
    };

    FileTransferModal.prototype.close = function () {
        if (this._el) this._el.style.display = 'none';
        document.getElementById('btn-file-transfer')?.classList.remove('active');
        if (this._session && this._session.client && this._session.client.fileTransfer) {
            this._session.client.fileTransfer._saveDownload = null;
        }
        if (this._session && this._session.client && this._session.client.disconnectFileConnection) {
            this._session.client.disconnectFileConnection();
        }
    };

    FileTransferModal.prototype.isOpen = function () {
        return this._el && this._el.style.display !== 'none';
    };

    FileTransferModal.prototype._wireClient = function (session) {
        var self = this;
        var client = session.client;
        client.on('file_browsing', function () { self._renderRemoteLoading(); });
        client.on('file_connecting', function () {
            self._renderRemoteLoading(t('remote.file_connecting', 'Connecting file transfer session…'));
        });
        client.on('file_connect_error', function (data) {
            self._renderRemoteError(data.error || t('remote.file_connect_failed', 'Could not open file transfer session'));
        });
        client.on('file_dir', function (data) {
            self._remoteEntries = data.entries || [];
            self._selectedRemote = null;
            self._el.querySelector('.ft-remote-path').textContent = data.path || '/';
            self._renderRemoteList();
        });
        client.on('file_browse_timeout', function () {
            self._renderRemoteError(t('remote.file_timeout', 'Remote device did not respond.'));
        });
        client.on('file_transfer_start', function (data) { self._addTransfer(data); });
        client.on('file_transfer_progress', function (data) { self._updateTransfer(data); });
        client.on('file_transfer_complete', function (data) { self._completeTransfer(data); });
        client.on('file_transfer_error', function (data) { self._errorTransfer(data); });
        client.on('file_transfer_cancelled', function (data) { self._removeTransfer(data.id); });
    };

    FileTransferModal.prototype._updateLocalHint = function () {
        var hint = this._el.querySelector('.ft-local-hint');
        if (LocalFiles.isSupported()) {
            hint.innerHTML = '<button type="button" class="btn btn-sm btn-secondary ft-local-pick-inline">' +
                escapeHtml(t('remote.file_pick_folder', 'Choose folder')) + '</button>';
            hint.querySelector('.ft-local-pick-inline').addEventListener('click', () => this._pickLocalFolder());
        } else {
            hint.innerHTML = '<span class="ft-hint-text">' +
                escapeHtml(t('remote.file_local_limited', 'Full local folder browsing requires Chrome/Edge over HTTPS. Upload still works.')) +
                '</span> <button type="button" class="btn btn-sm btn-secondary ft-local-upload-fallback">' +
                escapeHtml(t('remote.file_upload', 'Upload')) + '</button>';
            hint.querySelector('.ft-local-upload-fallback').addEventListener('click', () => {
                this._el.querySelector('.ft-local-file-input').click();
            });
        }
    };

    FileTransferModal.prototype._pickLocalFolder = async function () {
        try {
            await this._local.pickRoot();
            this._el.querySelector('.ft-local-path').textContent = this._local.currentPath;
            this._localEntries = await this._local.listCurrent();
            this._selectedLocal = null;
            this._renderLocalList();
            this._el.querySelector('.ft-local-hint').innerHTML = '';
        } catch (e) {
            if (e.name !== 'AbortError' && e.message !== 'unsupported') console.warn('[FileModal]', e);
        }
    };

    FileTransferModal.prototype._localGoUp = async function () {
        if (!this._local.hasRoot) return;
        await this._local.goUp();
        this._el.querySelector('.ft-local-path').textContent = this._local.currentPath;
        this._localEntries = await this._local.listCurrent();
        this._selectedLocal = null;
        this._renderLocalList();
    };

    FileTransferModal.prototype._localGoHome = async function () {
        if (!this._local.hasRoot) return;
        await this._local.goHome();
        this._el.querySelector('.ft-local-path').textContent = this._local.currentPath;
        this._localEntries = await this._local.listCurrent();
        this._selectedLocal = null;
        this._renderLocalList();
    };

    FileTransferModal.prototype._renderLocalList = function () {
        var list = this._el.querySelector('.ft-local-list');
        list.innerHTML = '';
        if (!this._localEntries.length) {
            list.innerHTML = '<div class="ft-empty">' + escapeHtml(t('remote.file_empty', 'No files')) + '</div>';
            return;
        }
        var self = this;
        this._localEntries.forEach(function (entry) {
            var row = document.createElement('div');
            row.className = 'ft-row' + (entry.isDir ? ' ft-row-dir' : '');
            if (self._selectedLocal === entry) row.classList.add('selected');
            row.innerHTML = '<span class="material-icons ft-row-icon">' + (entry.isDir ? 'folder' : 'insert_drive_file') + '</span>' +
                '<span class="ft-row-name">' + escapeHtml(entry.name) + '</span>' +
                '<span class="ft-row-size">' + (entry.isDir ? '' : formatSize(entry.size)) + '</span>';
            row.addEventListener('click', function () {
                if (entry.isDir) {
                    self._local.enterDir(entry).then(function () {
                        self._el.querySelector('.ft-local-path').textContent = self._local.currentPath;
                        return self._local.listCurrent();
                    }).then(function (entries) {
                        self._localEntries = entries;
                        self._selectedLocal = null;
                        self._renderLocalList();
                    });
                } else {
                    self._selectedLocal = entry;
                    self._renderLocalList();
                }
            });
            row.addEventListener('dblclick', function () {
                if (!entry.isDir) self._uploadLocalEntry(entry);
            });
            list.appendChild(row);
        });
    };

    FileTransferModal.prototype._renderRemoteLoading = function (msg) {
        this._el.querySelector('.ft-remote-list').innerHTML =
            '<div class="ft-empty"><span class="material-icons spinning">sync</span> ' +
            escapeHtml(msg || t('remote.file_loading', 'Loading…')) + '</div>';
    };

    FileTransferModal.prototype._renderRemoteError = function (msg) {
        this._el.querySelector('.ft-remote-list').innerHTML =
            '<div class="ft-empty ft-error"><span class="material-icons">warning</span> ' + escapeHtml(msg) +
            '<br><button type="button" class="btn btn-sm btn-primary ft-retry">' +
            escapeHtml(t('actions.retry', 'Retry')) + '</button></div>';
        var self = this;
        this._el.querySelector('.ft-retry')?.addEventListener('click', function () {
            var ft = self._session.client?.fileTransfer;
            if (ft) ft.browseDir(ft.currentPath || '');
        });
    };

    FileTransferModal.prototype._renderRemoteList = function () {
        var list = this._el.querySelector('.ft-remote-list');
        list.innerHTML = '';
        if (!this._remoteEntries.length) {
            list.innerHTML = '<div class="ft-empty">' + escapeHtml(t('remote.file_empty', 'No files')) + '</div>';
            return;
        }
        var self = this;
        var ft = this._session.client.fileTransfer;
        this._remoteEntries.forEach(function (entry) {
            var row = document.createElement('div');
            row.className = 'ft-row' + (entry.isDir ? ' ft-row-dir' : '');
            if (self._selectedRemote === entry) row.classList.add('selected');
            var icon = typeof RDFileTransfer !== 'undefined' ? RDFileTransfer.getFileIcon(entry) : (entry.isDir ? 'folder' : 'insert_drive_file');
            row.innerHTML = '<span class="material-icons ft-row-icon">' + icon + '</span>' +
                '<span class="ft-row-name">' + escapeHtml(entry.name) + '</span>' +
                '<span class="ft-row-size">' + (entry.isDir ? '' : formatSize(entry.size)) + '</span>';
            row.addEventListener('click', function () {
                if (entry.isDir) {
                    var sep = (ft.currentPath || '').includes('\\') ? '\\' : '/';
                    var base = ft.currentPath || '';
                    var next = base ? (base.replace(/[\\/]+$/, '') + sep + entry.name) : entry.name;
                    ft.browseDir(next);
                } else {
                    self._selectedRemote = entry;
                    self._renderRemoteList();
                }
            });
            row.addEventListener('dblclick', function () {
                if (!entry.isDir) self._downloadRemoteEntry(entry);
            });
            list.appendChild(row);
        });
    };

    FileTransferModal.prototype._remoteGoUp = function () {
        this._session.client?.fileTransfer?.browseParent();
    };

    FileTransferModal.prototype._remoteGoHome = function () {
        this._session.client?.fileTransfer?.browseDir('');
    };

    FileTransferModal.prototype._sendSelectedLocal = function () {
        if (this._selectedLocal && !this._selectedLocal.isDir) this._uploadLocalEntry(this._selectedLocal);
    };

    FileTransferModal.prototype._uploadLocalEntry = async function (entry) {
        var ft = this._session.client?.fileTransfer;
        if (!ft) return;
        var file = await this._local.readFile(entry);
        if (file) ft.uploadFile(file, ft.currentPath || '');
    };

    FileTransferModal.prototype._uploadFiles = function (fileList) {
        var ft = this._session.client?.fileTransfer;
        if (!ft || !fileList) return;
        for (var i = 0; i < fileList.length; i++) ft.uploadFile(fileList[i], ft.currentPath || '');
    };

    FileTransferModal.prototype._downloadSelectedRemote = function () {
        if (this._selectedRemote && !this._selectedRemote.isDir) this._downloadRemoteEntry(this._selectedRemote);
    };

    FileTransferModal.prototype._downloadRemoteEntry = function (entry) {
        var ft = this._session.client?.fileTransfer;
        if (!ft) return;
        ft.downloadFile(ft.currentPath || '', entry);
    };

    FileTransferModal.prototype._addTransfer = function (data) {
        this._el.querySelector('.ft-queue-empty').style.display = 'none';
        var row = document.createElement('div');
        row.className = 'ft-transfer-row';
        row.id = 'ftm-' + data.id;
        row.innerHTML = '<span class="material-icons">' + (data.type === 'download' ? 'download' : 'upload') + '</span>' +
            '<div class="ft-transfer-info"><div class="ft-transfer-name">' + escapeHtml(data.fileName) + '</div>' +
            '<div class="ft-transfer-bar"><div class="ft-transfer-fill"></div></div>' +
            '<div class="ft-transfer-pct">0%</div></div>';
        this._el.querySelector('.ft-queue-list').appendChild(row);
        this._transfers.set(data.id, row);
    };

    FileTransferModal.prototype._updateTransfer = function (data) {
        var row = this._transfers.get(data.id);
        if (!row) return;
        row.querySelector('.ft-transfer-fill').style.width = (data.percent || 0) + '%';
        row.querySelector('.ft-transfer-pct').textContent = (data.percent || 0) + '%';
    };

    FileTransferModal.prototype._completeTransfer = function (data) {
        var row = this._transfers.get(data.id);
        if (row) {
            row.querySelector('.ft-transfer-pct').textContent = t('remote.file_complete', 'Complete');
            row.classList.add('done');
        }
    };

    FileTransferModal.prototype._errorTransfer = function (data) {
        var row = this._transfers.get(data.id);
        if (row) {
            row.querySelector('.ft-transfer-pct').textContent = t('remote.file_error', 'Failed');
            row.classList.add('error');
        }
    };

    FileTransferModal.prototype._removeTransfer = function (id) {
        var row = this._transfers.get(id);
        if (row) row.remove();
        this._transfers.delete(id);
        if (!this._el.querySelector('.ft-queue-list').children.length) {
            this._el.querySelector('.ft-queue-empty').style.display = '';
        }
    };

    window.FileTransferModal = FileTransferModal;
    window.__fileTransferModal = new FileTransferModal();
})();
