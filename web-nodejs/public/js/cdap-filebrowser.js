/**
 * BetterDesk Console — CDAP File Browser Widget
 * Provides file browsing, download, upload, and deletion via WebSocket.
 * Uses request-response pattern (file_list, file_read, file_write, file_delete).
 */

(function () {
    'use strict';

    const activeSessions = {};

    // ── Utilities ────────────────────────────────────────────────────────

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    function formatSize(bytes) {
        if (bytes == null || bytes < 0) return '-';
        if (bytes === 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
    }

    function formatDate(ts) {
        if (!ts) return '-';
        const d = new Date(ts);
        if (isNaN(d.getTime())) return '-';
        return d.toLocaleString();
    }

    function t(key) {
        return window.BetterDesk?.t?.(key) || key.split('.').pop();
    }

    // ── File Browser Session Manager ─────────────────────────────────────

    function openFileBrowser(deviceId, widgetId) {
        const key = `${deviceId}:${widgetId}`;
        if (activeSessions[key]) return;

        const widgetEl = document.getElementById(`wval-${CSS.escape(widgetId)}`);
        if (!widgetEl) return;

        const pathEl = widgetEl.querySelector('.cdap-file-path');
        const listEl = widgetEl.querySelector('.cdap-file-list');
        const upBtn = widgetEl.querySelector('.cdap-file-up');

        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${window.location.host}/api/cdap/devices/${encodeURIComponent(deviceId)}/files`;
        let ws;
        try {
            ws = new WebSocket(wsUrl, ['cdap-filebrowser']);
        } catch (err) {
            console.error('[CDAPFileBrowser] WS creation failed:', err);
            return;
        }

        const session = {
            ws,
            widgetEl,
            widgetId,
            deviceId,
            pathEl,
            listEl,
            upBtn,
            currentPath: '/',
            connected: false,
            sessionId: null,
            _pendingCallbacks: {}
        };
        activeSessions[key] = session;

        ws.onopen = () => {
            session.connected = true;
            navigate(session, '/');
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                handleMessage(session, msg);
            } catch (_) {}
        };

        ws.onerror = () => {
            console.error('[CDAPFileBrowser] WS error for', deviceId);
        };

        ws.onclose = () => {
            if (activeSessions[key]) {
                session.connected = false;
                showError(session, 'Disconnected');
                delete activeSessions[key];
            }
            // Show connect button again
            const connectDiv = widgetEl.querySelector('.cdap-file-connect');
            if (connectDiv) connectDiv.classList.remove('hidden');
        };

        // Bind up button
        if (upBtn) {
            upBtn.addEventListener('click', () => {
                navigateUp(session);
            });
        }
    }

    function handleMessage(session, msg) {
        switch (msg.type) {
            case 'ready':
                session.sessionId = msg.session_id;
                break;

            case 'file_list_response':
                handleListResponse(session, msg);
                break;

            case 'file_read_response':
                handleReadResponse(session, msg);
                break;

            case 'file_write_response':
            case 'file_delete_response':
                handleOperationResponse(session, msg);
                break;

            case 'error':
                showError(session, msg.error || 'Unknown error');
                break;

            case 'end':
                closeFileBrowser(session.deviceId, session.widgetId);
                break;
        }
    }

    // ── Navigation ───────────────────────────────────────────────────────

    function navigate(session, path) {
        if (!session.connected) return;
        session.currentPath = path;
        if (session.pathEl) {
            session.pathEl.textContent = path;
        }
        // Show loading
        if (session.listEl) {
            session.listEl.innerHTML = '<div class="cdap-file-loading">Loading...</div>';
        }
        sendRequest(session, 'file_list', { path });
    }

    function navigateUp(session) {
        const parts = session.currentPath.split('/').filter(Boolean);
        parts.pop();
        navigate(session, '/' + parts.join('/'));
    }

    function handleListResponse(session, msg) {
        const entries = msg.entries || [];
        if (!session.listEl) return;

        if (entries.length === 0) {
            session.listEl.innerHTML = '<div class="cdap-file-empty">Empty directory</div>';
            return;
        }

        // Sort: directories first, then alphabetical
        entries.sort((a, b) => {
            if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
            return (a.name || '').localeCompare(b.name || '');
        });

        const html = entries.map(entry => {
            const icon = entry.is_dir ? 'folder' : getFileIcon(entry.name);
            const size = entry.is_dir ? '-' : formatSize(entry.size);
            const modified = formatDate(entry.modified);
            return `
                <div class="cdap-file-entry ${entry.is_dir ? 'cdap-file-dir' : 'cdap-file-file'}"
                     data-name="${escapeHtml(entry.name)}"
                     data-is-dir="${entry.is_dir}">
                    <span class="material-icons cdap-file-icon">${icon}</span>
                    <span class="cdap-file-name">${escapeHtml(entry.name)}</span>
                    <span class="cdap-file-size">${size}</span>
                    <span class="cdap-file-modified">${modified}</span>
                    <div class="cdap-file-actions">
                        ${!entry.is_dir ? `
                            <button class="btn btn-sm cdap-file-download" title="Download">
                                <span class="material-icons">download</span>
                            </button>
                        ` : ''}
                        <button class="btn btn-sm cdap-file-delete" title="Delete">
                            <span class="material-icons">delete</span>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        session.listEl.innerHTML = html;

        // Bind click events
        session.listEl.querySelectorAll('.cdap-file-entry').forEach(el => {
            const name = el.dataset.name;
            const isDir = el.dataset.isDir === 'true';

            // Double-click to navigate into directory
            if (isDir) {
                el.addEventListener('dblclick', () => {
                    const newPath = session.currentPath.replace(/\/$/, '') + '/' + name;
                    navigate(session, newPath);
                });
            }

            // Download button
            const downloadBtn = el.querySelector('.cdap-file-download');
            if (downloadBtn) {
                downloadBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    downloadFile(session, name);
                });
            }

            // Delete button
            const deleteBtn = el.querySelector('.cdap-file-delete');
            if (deleteBtn) {
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const confirmMsg = `Delete "${name}"?`;
                    if (confirm(confirmMsg)) {
                        deleteFile(session, name);
                    }
                });
            }
        });

        // Add upload button at bottom
        const uploadHtml = `
            <div class="cdap-file-upload-area">
                <button class="btn cdap-file-upload-btn">
                    <span class="material-icons">upload</span>
                    <span>${t('cdap.upload_file')}</span>
                </button>
                <input type="file" class="cdap-file-upload-input" style="display:none" multiple>
            </div>
        `;
        session.listEl.insertAdjacentHTML('afterend', uploadHtml);

        // Remove previous upload area if exists
        const prevUpload = session.widgetEl.querySelectorAll('.cdap-file-upload-area');
        if (prevUpload.length > 1) {
            prevUpload[0].remove();
        }

        // Bind upload
        const uploadBtn = session.widgetEl.querySelector('.cdap-file-upload-btn');
        const uploadInput = session.widgetEl.querySelector('.cdap-file-upload-input');
        if (uploadBtn && uploadInput) {
            uploadBtn.addEventListener('click', () => uploadInput.click());
            uploadInput.addEventListener('change', () => {
                const files = uploadInput.files;
                if (!files || files.length === 0) return;
                for (const file of files) {
                    uploadFile(session, file);
                }
                uploadInput.value = '';
            });
        }
    }

    // ── File Operations ──────────────────────────────────────────────────

    function downloadFile(session, name) {
        const path = session.currentPath.replace(/\/$/, '') + '/' + name;
        const requestId = 'dl_' + Date.now();

        session._pendingCallbacks[requestId] = (msg) => {
            if (msg.error) {
                showError(session, msg.error);
                return;
            }
            // msg.data is base64-encoded content
            if (msg.data) {
                const binary = atob(msg.data);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) {
                    bytes[i] = binary.charCodeAt(i);
                }
                const blob = new Blob([bytes]);
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = name;
                a.click();
                URL.revokeObjectURL(url);
            }
        };

        sendRequest(session, 'file_read', { path, request_id: requestId });
    }

    function uploadFile(session, file) {
        const reader = new FileReader();
        reader.onload = () => {
            const base64 = reader.result.split(',')[1] || '';
            const path = session.currentPath.replace(/\/$/, '') + '/' + file.name;
            sendRequest(session, 'file_write', { path, data: base64 });
        };
        reader.readAsDataURL(file);
    }

    function deleteFile(session, name) {
        const path = session.currentPath.replace(/\/$/, '') + '/' + name;
        sendRequest(session, 'file_delete', { path });
        // Refresh listing after short delay
        setTimeout(() => navigate(session, session.currentPath), 500);
    }

    function handleReadResponse(session, msg) {
        const requestId = msg.request_id;
        if (requestId && typeof requestId === 'string' && /^[\w-]{1,64}$/.test(requestId)) {
            const cb = Object.prototype.hasOwnProperty.call(session._pendingCallbacks, requestId)
                ? session._pendingCallbacks[requestId]
                : null;
            if (cb) {
                cb(msg);
                delete session._pendingCallbacks[requestId];
            }
        }
    }

    function handleOperationResponse(session, msg) {
        if (msg.error) {
            showError(session, msg.error);
        }
        // Refresh current directory
        navigate(session, session.currentPath);
    }

    // ── Send Request ─────────────────────────────────────────────────────

    function sendRequest(session, type, data) {
        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(JSON.stringify({ type, ...data }));
        }
    }

    // ── UI Helpers ───────────────────────────────────────────────────────

    function getFileIcon(name) {
        if (!name) return 'insert_drive_file';
        const ext = name.split('.').pop()?.toLowerCase();
        const iconMap = {
            jpg: 'image', jpeg: 'image', png: 'image', gif: 'image',
            svg: 'image', bmp: 'image', webp: 'image',
            mp4: 'movie', avi: 'movie', mkv: 'movie', mov: 'movie', webm: 'movie',
            mp3: 'audiotrack', wav: 'audiotrack', flac: 'audiotrack', ogg: 'audiotrack',
            pdf: 'picture_as_pdf',
            zip: 'archive', tar: 'archive', gz: 'archive', rar: 'archive', '7z': 'archive',
            txt: 'description', log: 'description', md: 'description',
            js: 'code', ts: 'code', py: 'code', go: 'code', rs: 'code',
            json: 'data_object', xml: 'data_object', yaml: 'data_object', yml: 'data_object',
            sh: 'terminal', bash: 'terminal', ps1: 'terminal', bat: 'terminal',
            exe: 'apps', dll: 'apps', so: 'apps',
            conf: 'settings', cfg: 'settings', ini: 'settings', env: 'settings'
        };
        return iconMap[ext] || 'insert_drive_file';
    }

    function showError(session, message) {
        if (session.listEl) {
            const errEl = document.createElement('div');
            errEl.className = 'cdap-file-error';
            errEl.textContent = message;
            session.listEl.prepend(errEl);
            setTimeout(() => errEl.remove(), 5000);
        }
    }

    function closeFileBrowser(deviceId, widgetId) {
        const key = `${deviceId}:${widgetId}`;
        const session = activeSessions[key];
        if (!session) return;

        if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(JSON.stringify({ type: 'close' }));
            session.ws.close();
        }
        session.connected = false;
        delete activeSessions[key];
    }

    // ── Public API ───────────────────────────────────────────────────────

    window.CDAPFileBrowser = {
        open: openFileBrowser,
        close: closeFileBrowser,
        isActive: (deviceId, widgetId) => !!activeSessions[`${deviceId}:${widgetId}`]
    };

})();
