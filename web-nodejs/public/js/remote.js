/**
 * BetterDesk Console - Remote Desktop Session Manager
 * Multi-tab remote desktop viewer with shared toolbar
 * Supports multiple concurrent RDClient sessions
 */

/* global RDClient, RDVideo, CDAPSession */

(function () {
    'use strict';

    // ---- i18n helper ----
    // window.t (from i18n-client.js) returns the key itself when missing;
    // wrap it so callers can provide an English fallback string.
    function t(key, fallback) {
        if (typeof window.t === 'function') {
            const val = window.t(key);
            if (val && val !== key) return val;
        }
        return fallback !== undefined ? fallback : key;
    }

    // ---- Transport selection (PR 2.3) ----
    // The unified web client picks the right transport per-device based
    // on `window.__capabilities.transport` (set server-side from the Go
    // peer record). RustDesk peers go through `RDClient`; OS-agent /
    // CDAP-connected peers use `CDAPSession`, which exposes the same
    // public surface so the rest of the session manager is transport-
    // agnostic.
    function getTransportName() {
        const caps = window.__capabilities || {};
        return String(caps.transport || 'rd').toLowerCase() === 'cdap' ? 'cdap' : 'rd';
    }
    function createTransportClient(canvas, opts) {
        if (getTransportName() === 'cdap' && typeof CDAPSession === 'function') {
            return new CDAPSession(canvas, opts);
        }
        return new RDClient(canvas, opts);
    }

    // ---- Simple toast notification ----
    function showToast(message, type) {
        const toast = document.createElement('div');
        toast.className = 'rd-toast rd-toast-' + (type || 'info');
        toast.textContent = message;
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    }

    // ---- Session storage ----
    const sessions = new Map(); // deviceId → SessionInfo
    let activeSessionId = null;

    const Prefs = window.RemoteViewerPrefs || {};
    const globalViewerPrefs = typeof Prefs.loadRemoteViewerPrefs === 'function'
        ? Prefs.loadRemoteViewerPrefs(window.BetterDesk?.user?.id)
        : { quality: 'Best', scale: 'fit', codec: 'Auto', adaptiveQuality: true, backgroundFps: 1 };

    function cloneViewerPrefs(prefs) {
        return Object.assign({
            quality: 'Best',
            scale: 'fit',
            codec: 'Auto',
            adaptiveQuality: true,
            backgroundFps: 1,
        }, prefs || globalViewerPrefs);
    }

    function persistGlobalViewerPrefs(prefs) {
        Object.assign(globalViewerPrefs, prefs);
        if (typeof Prefs.saveRemoteViewerPrefs === 'function') {
            Prefs.saveRemoteViewerPrefs(window.BetterDesk?.user?.id, globalViewerPrefs);
        }
    }

    function buildClientOpts(session) {
        const prefs = session.viewerPrefs || globalViewerPrefs;
        const userName = (window.BetterDesk.user && (window.BetterDesk.user.display_name || window.BetterDesk.user.username)) || 'BetterDesk Web';
        const activeFps = typeof Prefs.getActiveFpsForQuality === 'function'
            ? Prefs.getActiveFpsForQuality(prefs.quality)
            : 60;
        return {
            deviceId: session.deviceId,
            serverPubKey: window.BetterDesk.serverPubKey || '',
            myName: userName,
            scaleMode: prefs.scale || 'fit',
            fps: activeFps,
            imageQuality: prefs.quality || 'Best',
            qualityPreset: typeof Prefs.getPresetForQuality === 'function'
                ? Prefs.getPresetForQuality(prefs.quality)
                : 'best',
            adaptiveQuality: prefs.adaptiveQuality !== false,
            preferCodec: prefs.codec || 'Auto',
            disableAudio: false,
        };
    }

    function applyViewerPrefsToClient(client, prefs) {
        if (!client || !prefs) return;
        if (typeof client.setBackgroundFps === 'function') {
            client.setBackgroundFps(prefs.backgroundFps || 1);
        }
        if (client._state === 'streaming' || client.state === 'streaming') {
            const preset = typeof Prefs.getPresetForQuality === 'function'
                ? Prefs.getPresetForQuality(prefs.quality)
                : ({ Best: 'best', Balanced: 'balanced', Low: 'speed' }[prefs.quality] || 'best');
            if (typeof client.setQualityPreset === 'function') {
                client.setQualityPreset(preset);
            }
            if (typeof client.setScaleMode === 'function') {
                client.setScaleMode(prefs.scale || 'fit');
            }
            if (prefs.codec && prefs.codec !== 'Auto' && typeof client.setCodec === 'function') {
                client.setCodec(prefs.codec);
            }
        }
    }

    function updateSessionViewerPref(session, patch) {
        if (!session) return;
        session.viewerPrefs = Object.assign({}, session.viewerPrefs || cloneViewerPrefs(), patch);
        persistGlobalViewerPrefs(session.viewerPrefs);
    }

    /**
     * Session info wrapper for a single remote connection
     */
    class SessionInfo {
        constructor(deviceId, deviceName, panel) {
            this.deviceId = deviceId;
            this.deviceName = deviceName || '';
            this.panel = panel;
            this.canvas = panel.querySelector('.session-canvas');
            this.connectionOverlay = panel.querySelector('.session-connection-overlay');
            this.passwordOverlay = panel.querySelector('.session-password-overlay');
            this.passwordInput = panel.querySelector('.session-password-input');
            this.loginError = panel.querySelector('.session-login-error');
            this.statusText = panel.querySelector('.session-status-text');
            this.overlayActions = panel.querySelector('.session-overlay-actions');
            this.chatPanel = panel.querySelector('.session-chat-panel');
            this.chatMessages = panel.querySelector('.session-chat-messages');
            this.chatInput = panel.querySelector('.session-chat-input');
            this.filePanel = panel.querySelector('.session-file-panel');
            this.fileList = panel.querySelector('.session-file-list');
            this.filePathText = panel.querySelector('.session-file-path-text');
            this.fileTransfersPanel = panel.querySelector('.session-file-transfers');
            this.fileTransfersList = panel.querySelector('.session-file-transfers-list');
            this.fileUploadInput = panel.querySelector('.session-file-upload-input');
            this.tfaOverlay = panel.querySelector('.session-2fa-overlay');
            this.tfaInput = panel.querySelector('.session-2fa-input');
            this.tfaError = panel.querySelector('.session-2fa-error');
            this.cdapFallbackBtn = panel.querySelector('.session-btn-cdap-fallback');
            this.client = null;
            this.state = 'idle';
            this.latency = 0;
            this.lastStats = null;
            this.audioMuted = false;
            this.viewerPrefs = cloneViewerPrefs();
            this.mediaRecorder = null;
            this.recordedChunks = [];
        }
    }

    // ---- DOM References (shared) ----
    const viewerContainer = document.getElementById('viewer-container');
    const toolbar = document.getElementById('viewer-toolbar');
    const toolbarStatus = document.getElementById('toolbar-status');
    const toolbarStats = document.getElementById('toolbar-stats');
    const toolbarDeviceId = document.getElementById('toolbar-device-id');
    const tabBar = document.getElementById('session-tabs');

    // ---- Floating toolbar (collapsible RustDesk-style pill) ----
    // The compact handle is always visible; the action pill expands only on an
    // explicit click of the expand button. There is NO hover-to-open behaviour.
    let toolbarPinned = false;

    function expandToolbar() {
        toolbar.classList.add('expanded');
        const exp = document.getElementById('btn-toolbar-expand');
        if (exp) {
            exp.classList.add('active');
            const ic = exp.querySelector('.material-icons');
            if (ic) ic.textContent = 'expand_less';
        }
    }

    function collapseToolbar() {
        if (toolbarPinned) return;
        if (document.querySelector('.toolbar-dropdown-menu.open')) return;
        toolbar.classList.remove('expanded');
        const exp = document.getElementById('btn-toolbar-expand');
        if (exp) {
            exp.classList.remove('active');
            const ic = exp.querySelector('.material-icons');
            if (ic) ic.textContent = 'expand_more';
        }
    }

    function toggleToolbar() {
        if (toolbar.classList.contains('expanded')) {
            // Force-collapse (ignore pin) when the user explicitly clicks.
            toolbar.classList.remove('expanded');
            const exp = document.getElementById('btn-toolbar-expand');
            if (exp) {
                exp.classList.remove('active');
                const ic = exp.querySelector('.material-icons');
                if (ic) ic.textContent = 'expand_more';
            }
        } else {
            expandToolbar();
        }
    }

    // Legacy compatibility shims — older code paths call these to surface the
    // status while overlays are visible. They now drive expand/collapse only,
    // never an auto-hide timer.
    function showToolbar() { expandToolbar(); }
    function setToolbarAutoHide(enable) {
        // enable === true  -> session is streaming, keep the pill collapsed.
        // enable === false -> an overlay is shown, expand so status is visible.
        if (enable) {
            collapseToolbar();
        } else {
            expandToolbar();
        }
    }

    // ---- Independent "back to devices" navigation ----
    // The rdclient page is opened as a script-launched tab (window.open) from
    // the web panel. Navigating THIS tab to /devices spawned duplicate panel
    // tabs that accumulated over time. Instead, close this tab and re-focus the
    // opener; only fall back to navigation when there is no opener (e.g. the
    // page was opened directly via URL).
    function returnToDevices() {
        try {
            if (window.opener && !window.opener.closed) {
                try { window.opener.focus(); } catch { /* ignore */ }
                window.close();
                // If the browser blocked window.close() (not script-opened),
                // fall through to navigation after a short delay.
                setTimeout(() => {
                    if (!window.closed) window.location.href = '/devices';
                }, 150);
                return;
            }
        } catch { /* ignore */ }
        window.location.href = '/devices';
    }

    // ---- Automatic clipboard sync (local -> remote) ----
    // Native RustDesk pushes the controlling side's clipboard to the peer
    // automatically, so a plain Ctrl+V on the remote pastes local content.
    // The browser cannot observe clipboard changes, but it can read the
    // clipboard once the tab regains focus (with transient activation), so we
    // push the current local clipboard to the active streaming session then.
    let _lastSyncedClipboard = '';
    async function syncLocalClipboardToRemote() {
        const session = getActiveSession();
        if (!session || !session.client || session.state !== 'streaming') return;
        if (!navigator.clipboard || !navigator.clipboard.readText) return;
        try {
            const text = await navigator.clipboard.readText();
            if (text && text !== _lastSyncedClipboard) {
                _lastSyncedClipboard = text;
                session.client.sendClipboard(text);
            }
        } catch {
            // Permission denied or not focused — ignore, the manual paste
            // button remains available as a fallback.
        }
    }
    window.addEventListener('focus', syncLocalClipboardToRemote);
    if (viewerContainer) {
        viewerContainer.addEventListener('mousedown', syncLocalClipboardToRemote);
    }


    // ---- Tab Bar ----

    function createTab(deviceId, deviceName) {
        const tab = document.createElement('div');
        tab.className = 'session-tab';
        // Store RAW device ID in dataset — findTab() applies CSS.escape() once
        // when building the selector. Storing the escaped value caused a
        // double-escape for IDs that needed escaping (digits-first, symbols)
        // and `tab.remove()` silently failed.
        tab.dataset.sessionId = deviceId;

        const dot = document.createElement('span');
        dot.className = 'session-tab-dot';
        tab.appendChild(dot);

        const label = document.createElement('span');
        label.className = 'session-tab-label';
        label.textContent = deviceName || deviceId;
        label.title = deviceId;
        tab.appendChild(label);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'session-tab-close';
        closeBtn.innerHTML = '<span class="material-icons" style="font-size:14px">close</span>';
        closeBtn.title = _('actions.close');
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeSession(deviceId);
        });
        tab.appendChild(closeBtn);

        tab.addEventListener('click', () => switchSession(deviceId));
        tabBar.appendChild(tab);
    }

    function updateTabState(deviceId, state) {
        const tab = findTab(deviceId);
        if (!tab) return;
        const dot = tab.querySelector('.session-tab-dot');
        if (!dot) return;
        dot.className = 'session-tab-dot';
        switch (state) {
        case 'streaming': dot.classList.add('dot-online'); break;
        case 'connecting':
        case 'authenticating':
        case 'waiting_password': dot.classList.add('dot-connecting'); break;
        case 'error': dot.classList.add('dot-error'); break;
        default: dot.classList.add('dot-offline'); break;
        }
    }

    function setActiveTab(deviceId) {
        tabBar.querySelectorAll('.session-tab').forEach(t => t.classList.remove('active'));
        const tab = findTab(deviceId);
        if (tab) tab.classList.add('active');
    }

    function findTab(deviceId) {
        return tabBar.querySelector('[data-session-id="' + CSS.escape(deviceId) + '"]');
    }

    // ---- Session Lifecycle ----

    function createSession(deviceId, deviceName) {
        if (sessions.has(deviceId)) {
            switchSession(deviceId);
            return;
        }

        // Clone template
        const template = document.getElementById('session-panel-template');
        const panel = template.content.firstElementChild.cloneNode(true);

        // Fill device labels
        panel.querySelector('.session-device-label').textContent = deviceId;
        panel.querySelector('.session-device-name').textContent = deviceName || '';
        panel.querySelector('.session-password-label').textContent =
            (_('remote.enter_password_for') || 'Enter password for') + ' ' + deviceId;

        viewerContainer.appendChild(panel);

        const session = new SessionInfo(deviceId, deviceName, panel);

        // Show HTTP / WebCodecs warning once
        if (!RDVideo.isSupported()) {
            const isInsecure = window.location.protocol === 'http:' &&
                window.location.hostname !== 'localhost' &&
                window.location.hostname !== '127.0.0.1';
            if (isInsecure) showHttpWarningBanner();
        }

        // Create transport client from saved operator prefs (Best = 60fps).
        wireNewClient(session);
        sessions.set(deviceId, session);
        createTab(deviceId, deviceName);
        switchSession(deviceId);

        session.client.renderer.resize();
        session.client.connect().catch(err => {
            setSessionStatus(session, 'error', err.message);
            showSessionActions(session);
        });
    }

    function wireNewClient(session) {
        session.client = createTransportClient(session.canvas, buildClientOpts(session));
        if (typeof session.client.setBackgroundFps === 'function') {
            session.client.setBackgroundFps((session.viewerPrefs || globalViewerPrefs).backgroundFps || 1);
        }
        wireSessionEvents(session);
        wireSessionDomEvents(session);
        wireFileTransferEvents(session);
    }

    function switchSession(deviceId) {
        if (!sessions.has(deviceId)) return;
        activeSessionId = deviceId;
        const session = sessions.get(deviceId);

        // Hide all, show active
        viewerContainer.querySelectorAll('.session-panel').forEach(p => {
            p.style.display = 'none';
        });
        session.panel.style.display = '';

        setActiveTab(deviceId);
        toolbarDeviceId.textContent = deviceId;

        // Sync toolbar state
        syncToolbarToSession(session);
        syncToolbarFromSession(session);

        if (session.state === 'streaming') {
            session.canvas.focus();
            session.client.renderer.resize();
            setToolbarAutoHide(true);
        } else {
            setToolbarAutoHide(false);
        }

        syncSessionMediaCapture();

        if (session.state === 'streaming' && session.client) {
            session.client.setAudioMuted(session.audioMuted);
        }
    }

    function closeSession(deviceId) {
        const session = sessions.get(deviceId);
        if (!session) {
            // Session already cleaned up but stale tab still around — remove it.
            const tab = findTab(deviceId);
            if (tab) tab.remove();
            return;
        }

        try { if (session.client) session.client.disconnect(); } catch { /* ignore */ }
        if (session.mediaRecorder && session.mediaRecorder.state === 'recording') {
            try { session.mediaRecorder.stop(); } catch { /* ignore */ }
        }

        if (session.panel) session.panel.remove();
        const tab = findTab(deviceId);
        if (tab) tab.remove();
        sessions.delete(deviceId);

        if (activeSessionId === deviceId) {
            activeSessionId = null;
            if (sessions.size > 0) {
                switchSession(sessions.keys().next().value);
            } else {
                returnToDevices();
            }
        } else {
            syncSessionMediaCapture();
        }
    }

    function reconnectSession(session) {
        if (session.client) session.client.disconnect();
        session.connectionOverlay.style.display = 'flex';
        session.passwordOverlay.style.display = 'none';
        session.overlayActions.style.display = 'none';
        if (session.cdapFallbackBtn) session.cdapFallbackBtn.style.display = 'none';
        const spinner = session.connectionOverlay.querySelector('.spinner');
        if (spinner) spinner.style.display = 'block';
        session.statusText.textContent = _('remote.connecting');

        wireNewClient(session);
        session.client.renderer.resize();
        session.client.connect().catch(err => {
            setSessionStatus(session, 'error', err.message);
            showSessionActions(session);
        });
    }

    function getActiveSession() {
        return activeSessionId ? sessions.get(activeSessionId) : null;
    }

    // ---- Wire session events ----

    function wireSessionEvents(session) {
        const c = session.client;

        c.on('state', (state) => {
            session.state = state;
            updateTabState(session.deviceId, state);
            if (isActive(session)) syncToolbarToSession(session);
            handleSessionState(session, state);
        });

        c.on('log', (msg) => {
            if (isActive(session) && (session.state === 'connecting' || session.state === 'authenticating')) {
                session.statusText.textContent = msg;
            }
        });

        c.on('error', (msg, meta) => {
            setSessionStatus(session, 'error', msg);
            showSessionActions(session);
            if (meta && meta.cdapFallback) showCdapFallback(session);
            if (isActive(session)) setToolbarAutoHide(false);
        });

        c.on('cdap_fallback_available', () => {
            showCdapFallback(session);
        });

        c.on('disconnected', (reason) => {
            setSessionStatus(session, 'info', reason || _('remote.disconnected'));
            showSessionActions(session);
            if (isActive(session)) setToolbarAutoHide(false);
            if (typeof window.BillingReport !== 'undefined') {
                window.BillingReport.promptAfterSession(session.deviceId, session.deviceName)
                    .then((submitted) => {
                        if (submitted) showToast(t('commercialization.report.saved', 'Work report saved'), 'success');
                    })
                    .catch(() => {});
            }
        });

        c.on('password_required', () => {
            session.connectionOverlay.style.display = 'none';
            session.passwordOverlay.style.display = 'flex';
            session.loginError.style.display = 'none';
            session.passwordInput.value = '';
            if (isActive(session)) session.passwordInput.focus();
        });

        c.on('login_error', (error) => {
            if (session.state === 'waiting_2fa' || session.tfaOverlay.style.display === 'flex') {
                session.tfaError.textContent = error;
                session.tfaError.style.display = 'block';
                session.tfaInput.value = '';
                if (isActive(session)) session.tfaInput.focus();
                return;
            }
            session.loginError.textContent = error;
            session.loginError.style.display = 'block';
            session.passwordInput.value = '';
            if (isActive(session)) session.passwordInput.focus();
        });

        c.on('2fa_error', (error) => {
            session.tfaError.textContent = error || (_('remote.2fa_invalid') || 'Invalid code');
            session.tfaError.style.display = 'block';
            session.tfaInput.value = '';
            session.tfaOverlay.style.display = 'flex';
            if (isActive(session)) session.tfaInput.focus();
        });

        c.on('2fa_required', () => {
            session.passwordOverlay.style.display = 'none';
            session.connectionOverlay.style.display = 'none';
            session.tfaOverlay.style.display = 'flex';
            session.tfaError.style.display = 'none';
            session.tfaInput.value = '';
            if (isActive(session)) session.tfaInput.focus();
        });

        c.on('login_success', () => {
            session.passwordOverlay.style.display = 'none';
            session.tfaOverlay.style.display = 'none';
            session.passwordInput.blur();
        });

        c.on('session_start', () => {
            session.connectionOverlay.style.display = 'none';
            session.passwordOverlay.style.display = 'none';
            session.client.renderer.resize();
            if (isActive(session)) {
                applyViewerPrefsToClient(session.client, session.viewerPrefs);
            }
            syncSessionMediaCapture();
            if (isActive(session)) {
                session.canvas.focus();
                setToolbarAutoHide(true);
                try { refreshMonitorButton(session); } catch { /* not ready */ }
            }
            if (session.client.video) {
                session.client.video.onAutoplayBlocked = () => {
                    if (isActive(session)) showAutoplayOverlay(session);
                };
            }
        });

        c.on('stats', (stats) => {
            session.lastStats = stats;
            if (isActive(session)) updateStats(stats, session.latency);
        });

        c.on('latency', (rtt) => { session.latency = rtt; });

        c.on('chat', (text) => addChatMessage(session, text, 'received'));

        // CDAP transport: agent emits `monitors` after `monitor_list`. Show
        // the toolbar dropdown on multi-display agents and refresh contents.
        c.on('monitors', (list) => {
            const btn = document.getElementById('btn-monitors');
            if (btn) btn.style.display = (Array.isArray(list) && list.length > 1) ? '' : 'none';
            if (isActive(session)) {
                try { updateMonitorMenu(); } catch { /* menu not yet built */ }
            }
        });

        // Native RustDesk transport: the rdclient emits `peer_info` once the
        // login completes. Reveal the monitors dropdown when the peer has more
        // than one display OR supports virtual displays, then rebuild it.
        c.on('peer_info', () => {
            if (isActive(session)) {
                try { refreshMonitorButton(session); } catch { /* not ready */ }
            }
        });
        c.on('display_switched', () => {
            if (isActive(session)) {
                try { updateMonitorMenu(); } catch { /* menu not yet built */ }
            }
        });
        c.on('virtual_display_toggled', () => {
            if (isActive(session)) {
                try { updateMonitorMenu(); } catch { /* menu not yet built */ }
            }
        });

        // Security events: show warnings for E2E encryption issues
        c.on('signature_warning', (msg) => {
            console.warn('[Remote] Signature warning:', msg);
            showSecurityWarning(session, msg, 'warning');
        });
        c.on('encryption_warning', (msg) => {
            console.warn('[Remote] Encryption warning:', msg);
            showSecurityWarning(session, msg, 'error');
        });
    }

    /**
     * Show a security warning banner in the session panel
     */
    function showSecurityWarning(session, message, level) {
        let banner = session.panel.querySelector('.security-warning-banner');
        if (!banner) {
            banner = document.createElement('div');
            banner.className = 'security-warning-banner security-' + level;
            banner.innerHTML = '<span class="material-icons">'
                + (level === 'error' ? 'lock_open' : 'warning')
                + '</span> <span class="security-warning-text"></span>'
                + '<button class="security-warning-dismiss" title="Dismiss">&times;</button>';
            banner.querySelector('.security-warning-dismiss').addEventListener('click', () => banner.remove());
            session.panel.appendChild(banner);
        }
        banner.querySelector('.security-warning-text').textContent = message;
    }

    function wireSessionDomEvents(session) {
        session.panel.querySelector('.session-btn-reconnect')
            ?.addEventListener('click', () => reconnectSession(session));

        session.panel.querySelector('.session-btn-cdap-fallback')
            ?.addEventListener('click', () => {
                window.location.href = '/remote-cdap/' + encodeURIComponent(session.deviceId);
            });

        session.panel.querySelector('.session-btn-authenticate')
            ?.addEventListener('click', () => {
                const pw = session.passwordInput.value;
                if (!pw) { session.passwordInput.focus(); return; }
                if (session.client) session.client.authenticate(pw);
            });

        session.passwordInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                session.panel.querySelector('.session-btn-authenticate')?.click();
            }
        });

        // 2FA verification
        session.panel.querySelector('.session-btn-verify-2fa')
            ?.addEventListener('click', () => {
                const code = session.tfaInput.value.replace(/\s/g, '');
                if (!code || code.length !== 6) {
                    session.tfaError.textContent = _('remote.2fa_invalid') || 'Enter a valid 6-digit code';
                    session.tfaError.style.display = 'block';
                    session.tfaInput.focus();
                    return;
                }
                session.tfaError.style.display = 'none';
                if (session.client) session.client.submit2FA(code);
            });

        session.tfaInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                session.panel.querySelector('.session-btn-verify-2fa')?.click();
            }
        });

        // Only allow digits in 2FA input
        session.tfaInput?.addEventListener('input', () => {
            session.tfaInput.value = session.tfaInput.value.replace(/[^0-9]/g, '');
        });

        session.panel.querySelector('.session-btn-chat-close')
            ?.addEventListener('click', () => {
                session.chatPanel.style.display = 'none';
                document.getElementById('btn-chat')?.classList.remove('active');
            });

        session.panel.querySelector('.session-btn-chat-send')
            ?.addEventListener('click', () => sendChat(session));

        session.chatInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') sendChat(session);
            e.stopPropagation();
        });

        // File transfer panel listeners
        session.panel.querySelector('.session-file-btn-close')
            ?.addEventListener('click', () => {
                session.filePanel.style.display = 'none';
                document.getElementById('btn-file-transfer')?.classList.remove('active');
            });

        session.panel.querySelector('.session-file-btn-up')
            ?.addEventListener('click', () => {
                if (session.client) session.client.fileTransfer.browseParent();
            });

        session.panel.querySelector('.session-file-btn-home')
            ?.addEventListener('click', () => {
                if (session.client) session.client.fileTransfer.browseDir('');
            });

        session.panel.querySelector('.session-file-btn-hidden')
            ?.addEventListener('click', function () {
                if (!session.client) return;
                const ft = session.client.fileTransfer;
                ft._showHidden = !ft._showHidden;
                this.classList.toggle('active', ft._showHidden);
                ft.browseDir(ft.currentPath);
            });

        session.panel.querySelector('.session-file-btn-newdir')
            ?.addEventListener('click', () => {
                if (!session.client) return;
                const name = prompt(_('remote.file_new_folder_prompt') || 'Enter folder name:');
                if (name && name.trim()) {
                    const ft = session.client.fileTransfer;
                    const sep = ft.currentPath.includes('\\') ? '\\' : '/';
                    ft.createDir(ft.currentPath + sep + name.trim());
                    setTimeout(() => ft.browseDir(ft.currentPath), 500);
                }
            });

        session.panel.querySelector('.session-file-btn-upload')
            ?.addEventListener('click', () => {
                session.fileUploadInput?.click();
            });

        session.fileUploadInput?.addEventListener('change', (e) => {
            if (!session.client || !e.target.files.length) return;
            const ft = session.client.fileTransfer;
            for (const file of e.target.files) {
                ft.uploadFile(file, ft.currentPath);
            }
            e.target.value = '';
        });
    }

    /**
     * Wire file transfer events from RDClient to UI
     */
    function wireFileTransferEvents(session) {
        const client = session.client;
        if (!client) return;

        client.on('file_dir', (data) => {
            renderFileList(session, data.path, data.entries);
        });

        client.on('file_browsing', () => {
            // Show loading state
            if (session.fileList) {
                session.fileList.innerHTML = '<div class="file-empty"><span class="material-icons spinning">sync</span> ' +
                    (_('remote.file_loading') || 'Loading...') + '</div>';
            }
        });

        client.on('file_browse_timeout', (data) => {
            // Peer didn't respond — show timeout message with retry button
            if (session.fileList) {
                session.fileList.innerHTML =
                    '<div class="file-empty">' +
                        '<span class="material-icons" style="color:var(--warning)">warning</span> ' +
                        (_('remote.file_timeout') || 'Remote device did not respond. File transfer may not be supported or is disabled on the remote machine.') +
                        '<br><button class="btn btn-sm btn-primary file-retry-btn" style="margin-top:8px">' +
                        '<span class="material-icons" style="font-size:16px;vertical-align:middle">refresh</span> ' +
                        (_('actions.retry') || 'Retry') + '</button>' +
                    '</div>';
                session.fileList.querySelector('.file-retry-btn')?.addEventListener('click', () => {
                    client.fileTransfer.browseDir(data.path);
                });
            }
        });

        client.on('file_transfer_start', (data) => {
            showTransferEntry(session, data);
        });

        client.on('file_transfer_progress', (data) => {
            updateTransferProgress(session, data);
        });

        client.on('file_transfer_complete', (data) => {
            completeTransferEntry(session, data);
        });

        client.on('file_transfer_error', (data) => {
            errorTransferEntry(session, data);
        });

        client.on('file_transfer_cancelled', (data) => {
            removeTransferEntry(session, data.id);
        });
    }

    /**
     * Render file list in file panel
     */
    function renderFileList(session, path, entries) {
        session.filePathText.textContent = path || '/';
        session.fileList.innerHTML = '';

        if (!entries || entries.length === 0) {
            session.fileList.innerHTML = '<div class="file-empty">' + (_('remote.file_empty') || 'No files') + '</div>';
            return;
        }

        entries.forEach((entry) => {
            const row = document.createElement('div');
            row.className = 'file-entry' + (entry.isDir ? ' file-entry-dir' : '');
            row.innerHTML =
                '<span class="material-icons file-entry-icon">' + RDFileTransfer.getFileIcon(entry) + '</span>' +
                '<span class="file-entry-name" title="' + escapeHtml(entry.name) + '">' + escapeHtml(entry.name) + '</span>' +
                '<span class="file-entry-size">' + (entry.isDir ? '' : RDFileTransfer.formatSize(entry.size)) + '</span>' +
                '<span class="file-entry-time">' + RDFileTransfer.formatTime(entry.modifiedTime) + '</span>' +
                '<div class="file-entry-actions">' +
                    (entry.isDir ? '' : '<button class="file-btn-icon file-btn-download" title="' + (_('remote.file_download') || 'Download') + '"><span class="material-icons">download</span></button>') +
                    '<button class="file-btn-icon file-btn-rename" title="' + (_('remote.file_rename') || 'Rename') + '"><span class="material-icons">edit</span></button>' +
                    '<button class="file-btn-icon file-btn-delete" title="' + (_('actions.delete') || 'Delete') + '"><span class="material-icons">delete</span></button>' +
                '</div>';

            // Double click / click on directory → navigate
            if (entry.isDir) {
                row.addEventListener('dblclick', () => {
                    const ft = session.client?.fileTransfer;
                    if (!ft) return;
                    const sep = path.includes('\\') ? '\\' : '/';
                    ft.browseDir(path + sep + entry.name);
                });
            }

            // Download button
            row.querySelector('.file-btn-download')?.addEventListener('click', (e) => {
                e.stopPropagation();
                session.client?.fileTransfer?.downloadFile(path, entry);
            });

            // Rename button
            row.querySelector('.file-btn-rename')?.addEventListener('click', (e) => {
                e.stopPropagation();
                const newName = prompt(_('remote.file_rename_prompt') || 'New name:', entry.name);
                if (newName && newName.trim() && newName !== entry.name) {
                    const ft = session.client?.fileTransfer;
                    if (!ft) return;
                    const sep = path.includes('\\') ? '\\' : '/';
                    ft.rename(path + sep + entry.name, newName.trim());
                    setTimeout(() => ft.browseDir(ft.currentPath), 500);
                }
            });

            // Delete button
            row.querySelector('.file-btn-delete')?.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!confirm((_('remote.file_delete_confirm') || 'Delete') + ' "' + entry.name + '"?')) return;
                const ft = session.client?.fileTransfer;
                if (!ft) return;
                const sep = path.includes('\\') ? '\\' : '/';
                const fullPath = path + sep + entry.name;
                if (entry.isDir) {
                    ft.removeDir(fullPath, true);
                } else {
                    ft.removeFile(fullPath);
                }
                setTimeout(() => ft.browseDir(ft.currentPath), 500);
            });

            session.fileList.appendChild(row);
        });
    }

    function escapeHtml(text) {
        const el = document.createElement('span');
        el.textContent = text;
        return el.innerHTML;
    }

    /**
     * Show new transfer entry in transfers panel
     */
    function showTransferEntry(session, data) {
        session.fileTransfersPanel.style.display = 'block';
        const entry = document.createElement('div');
        entry.className = 'file-transfer-entry';
        entry.id = 'ft-' + data.id;
        entry.innerHTML =
            '<span class="material-icons file-transfer-icon">' + (data.type === 'download' ? 'download' : 'upload') + '</span>' +
            '<div class="file-transfer-info">' +
                '<div class="file-transfer-name">' + escapeHtml(data.fileName) + '</div>' +
                '<div class="file-transfer-bar"><div class="file-transfer-bar-fill" style="width:0%"></div></div>' +
                '<div class="file-transfer-status">0%</div>' +
            '</div>' +
            '<button class="file-btn-icon file-transfer-cancel" title="Cancel"><span class="material-icons">close</span></button>';

        entry.querySelector('.file-transfer-cancel')?.addEventListener('click', () => {
            session.client?.fileTransfer?.cancelTransfer(data.id);
        });
        session.fileTransfersList.appendChild(entry);
    }

    function updateTransferProgress(session, data) {
        const entry = session.fileTransfersList.querySelector('#ft-' + data.id);
        if (!entry) return;
        const fill = entry.querySelector('.file-transfer-bar-fill');
        const status = entry.querySelector('.file-transfer-status');
        if (fill) fill.style.width = data.percent + '%';
        if (status) status.textContent = data.percent + '% — ' + RDFileTransfer.formatSize(data.transferred) + ' / ' + RDFileTransfer.formatSize(data.fileSize);
    }

    function completeTransferEntry(session, data) {
        const entry = session.fileTransfersList.querySelector('#ft-' + data.id);
        if (!entry) return;
        entry.classList.add('complete');
        const status = entry.querySelector('.file-transfer-status');
        if (status) status.textContent = (_('remote.file_complete') || 'Complete') + ' — ' + RDFileTransfer.formatSize(data.fileSize);
        const cancel = entry.querySelector('.file-transfer-cancel');
        if (cancel) cancel.style.display = 'none';
        // Auto-remove after 5s
        setTimeout(() => {
            entry.remove();
            if (!session.fileTransfersList.children.length) {
                session.fileTransfersPanel.style.display = 'none';
            }
        }, 5000);
    }

    function errorTransferEntry(session, data) {
        const entry = session.fileTransfersList.querySelector('#ft-' + data.id);
        if (!entry) return;
        entry.classList.add('error');
        const status = entry.querySelector('.file-transfer-status');
        if (status) status.textContent = (_('remote.file_error') || 'Error') + ': ' + data.error;
        const cancel = entry.querySelector('.file-transfer-cancel');
        if (cancel) cancel.style.display = 'none';
    }

    function removeTransferEntry(id) {
        const el = document.querySelector('#ft-' + id);
        if (el) el.remove();
    }

    // ---- Session state helpers ----

    function isActive(session) {
        return session.deviceId === activeSessionId;
    }

    /**
     * Keep keyboard/mouse capture, inbound clipboard, and audio scoped to the
     * active streaming tab so background sessions cannot receive input.
     */
    function syncSessionMediaCapture() {
        if (typeof window.syncSessionMediaCapture === 'function') {
            window.syncSessionMediaCapture(sessions, activeSessionId);
        }
    }

    function handleSessionState(session, state) {
        switch (state) {
        case 'connecting':
            session.connectionOverlay.style.display = 'flex';
            session.passwordOverlay.style.display = 'none';
            setSessionStatus(session, 'loading', _('remote.connecting'));
            if (isActive(session)) setToolbarAutoHide(false);
            break;
        case 'streaming':
            session.connectionOverlay.style.display = 'none';
            session.passwordOverlay.style.display = 'none';
            session.panel.classList.add('streaming');
            syncSessionMediaCapture();
            if (isActive(session)) setToolbarAutoHide(true);
            break;
        case 'disconnected':
        case 'error':
            session.panel.classList.remove('streaming');
            session.connectionOverlay.style.display = 'flex';
            setSessionStatus(session, state === 'error' ? 'error' : 'info',
                state === 'error' ? _('remote.error') : _('remote.disconnected'));
            showSessionActions(session);
            if (isActive(session)) setToolbarAutoHide(false);
            break;
        }
    }

    function setSessionStatus(session, type, text) {
        session.statusText.textContent = text;
        const statusEl = session.connectionOverlay.querySelector('.overlay-status');
        if (statusEl) statusEl.className = 'overlay-status ' + type;
    }

    function showSessionActions(session) {
        session.overlayActions.style.display = 'flex';
        const spinner = session.connectionOverlay.querySelector('.spinner');
        if (spinner) spinner.style.display = 'none';
    }

    function showCdapFallback(session) {
        if (session.cdapFallbackBtn) session.cdapFallbackBtn.style.display = 'inline-flex';
    }

    function syncToolbarToSession(session) {
        const stateLabels = {
            'idle': _('remote.status_idle'),
            'connecting': _('remote.connecting'),
            'waiting_password': _('remote.waiting_password'),
            'authenticating': _('remote.authenticating'),
            'streaming': _('remote.streaming'),
            'disconnected': _('remote.disconnected'),
            'error': _('remote.error')
        };
        toolbarStatus.textContent = stateLabels[session.state] || session.state;

        if (session.lastStats) {
            updateStats(session.lastStats, session.latency);
        } else {
            toolbarStats.textContent = '';
        }

        // Audio icon
        const audioBtn = document.getElementById('btn-audio');
        if (audioBtn) {
            audioBtn.querySelector('.material-icons').textContent =
                session.audioMuted ? 'volume_off' : 'volume_up';
        }

        // Recording icon
        const recBtn = document.getElementById('btn-record');
        if (recBtn) {
            recBtn.classList.toggle('recording',
                session.mediaRecorder && session.mediaRecorder.state === 'recording');
        }
    }

    function syncToolbarFromSession(session) {
        if (!session || !session.viewerPrefs) return;
        const p = session.viewerPrefs;
        document.querySelectorAll('.quality-item').forEach(function (btn) {
            btn.classList.toggle('active', btn.dataset.quality === p.quality);
        });
        document.querySelectorAll('.scale-item').forEach(function (btn) {
            btn.classList.toggle('active', btn.dataset.scale === p.scale);
        });
        document.querySelectorAll('.codec-item').forEach(function (btn) {
            btn.classList.toggle('active', btn.dataset.codec === p.codec);
        });
    }

    // ---- Stats display ----

    function updateStats(stats, latency) {
        if (!stats) return;
        const parts = [];
        if (stats.video) {
            const fps = stats.video.videoFps || 0;
            parts.push(fps + ' FPS');
            if (stats.video.frameCount !== undefined) parts.push(stats.video.frameCount + ' frames');
        }
        if (stats.video && stats.video.displayWidth && stats.video.displayHeight) {
            parts.push(stats.video.displayWidth + 'x' + stats.video.displayHeight);
        } else if (stats.renderer && stats.renderer.remoteWidth && stats.renderer.remoteHeight) {
            parts.push(stats.renderer.remoteWidth + 'x' + stats.renderer.remoteHeight);
        }
        if (latency > 0) parts.push(latency + 'ms');
        if (stats.video && stats.video.codec) parts.push(stats.video.codec.toUpperCase());
        toolbarStats.textContent = parts.join(' | ');
    }

    // ---- Autoplay blocked overlay ----

    function showAutoplayOverlay(session) {
        let overlay = session.panel.querySelector('.autoplay-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'viewer-overlay autoplay-overlay';
            overlay.innerHTML = `
                <div class="overlay-card autoplay-card">
                    <div class="overlay-icon"><span class="material-icons">play_circle</span></div>
                    <h2 class="overlay-title">${_('remote.click_to_start') || 'Click to Start'}</h2>
                    <p class="overlay-hint">${_('remote.autoplay_blocked') || 'Browser requires user interaction to start video and audio playback.'}</p>
                    <button class="btn btn-primary btn-full autoplay-start-btn">
                        <span class="material-icons">play_arrow</span>
                        ${_('remote.start_playback') || 'Start Playback'}
                    </button>
                </div>`;
            session.panel.appendChild(overlay);
        }
        overlay.style.display = 'flex';
        const dismiss = () => {
            overlay.style.display = 'none';
            if (session.client && session.client.video) session.client.video.retryPlay();
            if (session.client && session.client.audio && session.client.audio.audioCtx &&
                session.client.audio.audioCtx.state === 'suspended') {
                session.client.audio.audioCtx.resume();
            }
        };
        overlay.querySelector('.autoplay-start-btn')?.addEventListener('click', dismiss, { once: true });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); }, { once: true });
    }

    // ---- Chat ----

    function sendChat(session) {
        const text = session.chatInput?.value?.trim();
        if (!text || !session.client) return;
        session.client.sendChat(text);
        addChatMessage(session, text, 'sent');
        session.chatInput.value = '';
    }

    function addChatMessage(session, text, type) {
        const div = document.createElement('div');
        div.className = 'chat-msg ' + type;
        div.textContent = text;
        session.chatMessages?.appendChild(div);
        if (session.chatMessages) session.chatMessages.scrollTop = session.chatMessages.scrollHeight;
    }

    // ---- Shared Toolbar Handlers ----
    // All toolbar buttons delegate to the active session's client

    function withClient(fn) {
        const session = getActiveSession();
        if (session && session.client) fn(session.client, session);
    }

    // Disconnect
    document.getElementById('btn-disconnect')?.addEventListener('click', () => {
        withClient(c => c.disconnect());
    });

    // Fullscreen
    document.getElementById('btn-fullscreen')?.addEventListener('click', () => {
        withClient(c => c.toggleFullscreen(viewerContainer));
    });

    // Audio toggle
    document.getElementById('btn-audio')?.addEventListener('click', function () {
        const session = getActiveSession();
        if (!session) return;
        session.audioMuted = !session.audioMuted;
        if (session.client) session.client.setAudioMuted(session.audioMuted);
        this.querySelector('.material-icons').textContent =
            session.audioMuted ? 'volume_off' : 'volume_up';
    });

    // Ctrl+Alt+Del
    document.getElementById('btn-cad')?.addEventListener('click', () => {
        withClient(c => c.sendCtrlAltDel());
        closeAllDropdowns();
    });

    // Lock Screen
    document.getElementById('btn-lock')?.addEventListener('click', () => {
        withClient(c => c.sendLockScreen());
        closeAllDropdowns();
    });

    // Restart Remote
    document.getElementById('btn-restart-remote')?.addEventListener('click', () => {
        withClient((c) => {
            if (confirm(_('remote.confirm_restart'))) c.sendRestartRemoteDevice();
        });
        closeAllDropdowns();
    });

    // Refresh Screen
    document.getElementById('btn-refresh-screen')?.addEventListener('click', () => {
        withClient(c => c.sendRefreshScreen());
        closeAllDropdowns();
    });

    // Clipboard Paste
    document.getElementById('btn-clipboard-paste')?.addEventListener('click', async () => {
        const session = getActiveSession();
        if (!session || !session.client) return;
        try {
            const text = await navigator.clipboard.readText();
            if (text) {
                session.client.sendClipboard(text);
            } else {
                showToast(_('remote.clipboard_empty') || 'Clipboard is empty', 'warning');
            }
        } catch {
            // Clipboard API requires HTTPS or user permission
            showToast(_('remote.clipboard_denied') || 'Clipboard access denied. HTTPS required or permission not granted.', 'error');
        }
        closeAllDropdowns();
    });

    // Block Input toggle
    setupToggle('btn-block-input', (on) => withClient(c => c.setBlockInput(on)));

    // Quality items — map HTML data-quality to client presets (includes FPS adjustment)
    var qualityToPreset = { 'Best': 'best', 'Balanced': 'balanced', 'Low': 'speed' };
    document.querySelectorAll('.quality-item').forEach(btn => {
        btn.addEventListener('click', function () {
            var preset = qualityToPreset[this.dataset.quality] || 'balanced';
            var session = getActiveSession();
            withClient(c => c.setQualityPreset(preset));
            if (session) updateSessionViewerPref(session, { quality: this.dataset.quality });
            document.querySelectorAll('.quality-item').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            closeAllDropdowns();
        });
    });

    // Scale items
    document.querySelectorAll('.scale-item').forEach(btn => {
        btn.addEventListener('click', function () {
            var session = getActiveSession();
            withClient(c => c.setScaleMode(this.dataset.scale));
            if (session) updateSessionViewerPref(session, { scale: this.dataset.scale });
            document.querySelectorAll('.scale-item').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            closeAllDropdowns();
        });
    });

    // Codec items — request the peer to (re)encode with a specific codec (GPU-friendly).
    document.querySelectorAll('.codec-item').forEach(btn => {
        btn.addEventListener('click', function () {
            if (this.classList.contains('disabled')) return;
            var session = getActiveSession();
            withClient(c => c.setCodec(this.dataset.codec));
            if (session) updateSessionViewerPref(session, { codec: this.dataset.codec });
            document.querySelectorAll('.codec-item').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            closeAllDropdowns();
        });
    });

    // Disable codec options the browser's decoder cannot handle.
    (function probeCodecMenu() {
        if (!window.RDVideo || typeof RDVideo.getSupportedCodecs !== 'function') return;
        RDVideo.getSupportedCodecs().then(function (support) {
            document.querySelectorAll('.codec-item').forEach(function (btn) {
                var codec = (btn.dataset.codec || '').toLowerCase();
                if (codec === 'auto') return; // always allowed
                if (support && support[codec] === false) {
                    btn.classList.add('disabled');
                    btn.setAttribute('disabled', 'disabled');
                    btn.title = 'Not supported by this browser';
                }
            });
        }).catch(function () { /* ignore */ });
    })();

    // Toggle helpers
    setupToggle('btn-show-cursor', (on) => withClient(c => c.setShowRemoteCursor(on)));
    setupToggle('btn-lock-session', (on) => withClient(c => c.setLockAfterSession(on)));
    setupToggle('btn-privacy-mode', (on) => withClient(c => c.setPrivacyMode(on)));
    setupToggle('btn-disable-clipboard', (on) => withClient(c => c.setDisableClipboard(on)));

    // Dropdown toggles
    document.getElementById('btn-actions')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllDropdowns('actions-menu');
        document.getElementById('actions-menu')?.classList.toggle('open');
    });

    document.getElementById('btn-display')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllDropdowns('display-menu');
        document.getElementById('display-menu')?.classList.toggle('open');
    });

    document.getElementById('btn-monitors')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllDropdowns('monitors-menu');
        updateMonitorMenu();
        document.getElementById('monitors-menu')?.classList.toggle('open');
    });

    function refreshMonitorButton(session) {
        session = session || getActiveSession();
        if (!session || !session.client) return;
        const btn = document.getElementById('btn-monitors');
        if (!btn) return;
        let monitors = [];
        let vd = { supported: false };
        try { monitors = session.client.getMonitors() || []; } catch { monitors = []; }
        try {
            vd = (typeof session.client.getVirtualDisplaySupport === 'function')
                ? session.client.getVirtualDisplaySupport()
                : { supported: false };
        } catch { vd = { supported: false }; }
        const visible = (monitors.length > 1) || (vd && vd.supported);
        btn.style.display = visible ? '' : 'none';
        if (visible) updateMonitorMenu();
    }

    function updateMonitorMenu() {
        const session = getActiveSession();
        if (!session || !session.client) return;
        const monitors = session.client.getMonitors() || [];
        const menu = document.getElementById('monitors-menu');
        if (!menu) return;

        let vd = { supported: false };
        try {
            vd = (typeof session.client.getVirtualDisplaySupport === 'function')
                ? session.client.getVirtualDisplaySupport()
                : { supported: false };
        } catch { vd = { supported: false }; }

        // Nothing meaningful to show: a single physical display and no virtual
        // display support.
        if (monitors.length < 2 && !(vd && vd.supported)) return;

        const btn = document.getElementById('btn-monitors');
        if (btn) btn.style.display = '';

        const label = menu.querySelector('.dropdown-label');
        menu.innerHTML = '';
        if (label) menu.appendChild(label);

        // Physical monitors
        monitors.forEach(m => {
            const item = document.createElement('button');
            item.className = 'dropdown-item monitor-item' + (m.current ? ' active' : '');
            item.dataset.idx = m.idx;
            item.innerHTML = '<span class="material-icons">' +
                (m.primary ? 'desktop_windows' : 'monitor') +
                '</span> ' + escapeHtml(m.name) +
                (m.width ? ' (' + m.width + '\u00d7' + m.height + ')' : '');
            item.addEventListener('click', () => {
                session.client.switchMonitor(m.idx);
                menu.querySelectorAll('.monitor-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');
            });
            menu.appendChild(item);
        });

        // Virtual displays (RustDesk IDD / Amyuni IDD)
        if (vd && vd.supported) {
            const divider = document.createElement('div');
            divider.className = 'dropdown-divider';
            menu.appendChild(divider);

            const vdLabel = document.createElement('div');
            vdLabel.className = 'dropdown-label';
            vdLabel.textContent = t('remote.virtual_displays', 'Virtual displays');
            menu.appendChild(vdLabel);

            if (vd.impl === 'rustdesk_idd') {
                const active = Array.isArray(vd.rustdeskDisplays) ? vd.rustdeskDisplays : [];
                for (let i = 0; i < 4; i++) {
                    const idx = i + 1;
                    const on = active.indexOf(idx) !== -1;
                    const item = document.createElement('button');
                    item.className = 'dropdown-item virtual-display-item' + (on ? ' active' : '');
                    item.innerHTML = '<span class="material-icons">' +
                        (on ? 'check_box' : 'check_box_outline_blank') + '</span> ' +
                        escapeHtml(t('remote.virtual_display', 'Virtual display') + ' ' + idx);
                    item.addEventListener('click', () => {
                        session.client.toggleVirtualDisplay(idx, !on);
                    });
                    menu.appendChild(item);
                }
            } else if (vd.impl === 'amyuni_idd') {
                const count = (typeof vd.amyuniCount === 'number') ? vd.amyuniCount : 0;
                const row = document.createElement('div');
                row.className = 'dropdown-item virtual-display-counter';

                const minus = document.createElement('button');
                minus.className = 'vd-count-btn';
                minus.innerHTML = '<span class="material-icons">remove</span>';
                minus.disabled = count <= 0;
                minus.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    session.client.toggleVirtualDisplay(0, false);
                });

                const num = document.createElement('span');
                num.className = 'vd-count-value';
                num.textContent = String(count);

                const plus = document.createElement('button');
                plus.className = 'vd-count-btn';
                plus.innerHTML = '<span class="material-icons">add</span>';
                plus.disabled = count >= 4;
                plus.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    session.client.toggleVirtualDisplay(0, true);
                });

                row.appendChild(minus);
                row.appendChild(num);
                row.appendChild(plus);
                menu.appendChild(row);
            }

            // Plug out all
            const plugOut = document.createElement('button');
            plugOut.className = 'dropdown-item virtual-display-item';
            plugOut.innerHTML = '<span class="material-icons">power_off</span> ' +
                escapeHtml(t('remote.plug_out_all', 'Plug out all'));
            plugOut.addEventListener('click', () => {
                session.client.toggleVirtualDisplay(-1, false);
            });
            menu.appendChild(plugOut);
        }
    }

    // Chat toggle
    document.getElementById('btn-chat')?.addEventListener('click', function () {
        const session = getActiveSession();
        if (!session) return;
        const isOpen = session.chatPanel.style.display !== 'none';
        session.chatPanel.style.display = isOpen ? 'none' : 'flex';
        this.classList.toggle('active', !isOpen);
        if (!isOpen && session.chatInput) session.chatInput.focus();
    });

    // File transfer toggle
    document.getElementById('btn-file-transfer')?.addEventListener('click', function () {
        const session = getActiveSession();
        if (!session) return;
        const isOpen = session.filePanel.style.display !== 'none';
        session.filePanel.style.display = isOpen ? 'none' : 'flex';
        this.classList.toggle('active', !isOpen);
        if (!isOpen && session.client) {
            session.client.fileTransfer.browseDir('');
        }
    });

    // Recording
    document.getElementById('btn-record')?.addEventListener('click', function () {
        const session = getActiveSession();
        if (!session) return;

        if (session.mediaRecorder && session.mediaRecorder.state === 'recording') {
            session.mediaRecorder.stop();
            this.classList.remove('recording');
        } else {
            try {
                const stream = session.canvas.captureStream(30);
                session.recordedChunks = [];
                const mimeTypes = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
                let mimeType = '';
                for (const mt of mimeTypes) {
                    if (MediaRecorder.isTypeSupported(mt)) { mimeType = mt; break; }
                }
                session.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
                session.mediaRecorder.ondataavailable = (e) => {
                    if (e.data.size > 0) session.recordedChunks.push(e.data);
                };
                session.mediaRecorder.onstop = () => {
                    const blob = new Blob(session.recordedChunks, { type: mimeType || 'video/webm' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'betterdesk-' + session.deviceId + '-' + Date.now() + '.webm';
                    a.click();
                    URL.revokeObjectURL(url);
                    session.mediaRecorder = null;
                };
                session.mediaRecorder.start(1000);
                this.classList.add('recording');
            } catch (err) {
                console.warn('[Remote] Recording not supported:', err);
            }
        }
    });

    // View Only toggle
    document.getElementById('btn-viewonly')?.addEventListener('click', function () {
        const isViewOnly = !this.classList.contains('active');
        this.classList.toggle('active', isViewOnly);
        withClient(c => c.setViewOnly(isViewOnly));
    });

    // Pin Toolbar toggle — keeps the expanded action pill open
    document.getElementById('btn-pin')?.addEventListener('click', function () {
        toolbarPinned = !toolbarPinned;
        toolbar.classList.toggle('pinned', toolbarPinned);
        this.classList.toggle('active', toolbarPinned);
        if (toolbarPinned) expandToolbar();
    });

    // ---- Compact handle: expand / collapse the action pill ----
    document.getElementById('btn-toolbar-expand')?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleToolbar();
    });

    // ---- Compact handle: fullscreen ----
    document.getElementById('btn-handle-fullscreen')?.addEventListener('click', (e) => {
        e.stopPropagation();
        withClient(c => c.toggleFullscreen(viewerContainer));
    });

    // ---- Compact handle: drag the floating toolbar horizontally ----
    (function setupToolbarDrag() {
        const dragBtn = document.getElementById('btn-toolbar-drag');
        if (!dragBtn) return;
        let dragging = false;
        let startX = 0;
        let startLeft = 0;

        function clampLeft(px) {
            const w = toolbar.offsetWidth || 200;
            const min = 8 + w / 2;
            const max = window.innerWidth - 8 - w / 2;
            return Math.max(min, Math.min(max, px));
        }

        function onMove(ev) {
            if (!dragging) return;
            ev.preventDefault();
            const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
            const next = clampLeft(startLeft + (clientX - startX));
            toolbar.style.left = next + 'px';
            toolbar.style.transform = 'translateX(-50%)';
        }

        function onUp() {
            if (!dragging) return;
            dragging = false;
            toolbar.classList.remove('dragging');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onUp);
        }

        function onDown(ev) {
            ev.preventDefault();
            dragging = true;
            toolbar.classList.add('dragging');
            const rect = toolbar.getBoundingClientRect();
            startLeft = rect.left + rect.width / 2;
            startX = ev.touches ? ev.touches[0].clientX : ev.clientX;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onUp);
        }

        dragBtn.addEventListener('mousedown', onDown);
        dragBtn.addEventListener('touchstart', onDown, { passive: false });
    })();

    // ---- Back to devices (independent tab — close instead of navigating) ----
    document.getElementById('btn-back-devices')?.addEventListener('click', (e) => {
        e.preventDefault();
        returnToDevices();
    });

    function closeAllDropdowns(exceptId) {
        document.querySelectorAll('.toolbar-dropdown-menu.open').forEach(m => {
            if (m.id !== exceptId) m.classList.remove('open');
        });
    }

    function setupToggle(btnId, onChange) {
        document.getElementById(btnId)?.addEventListener('click', function () {
            const active = this.dataset.active !== 'true';
            this.dataset.active = active.toString();
            onChange(active);
        });
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    }

    // Close dropdowns on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.toolbar-dropdown')) {
            closeAllDropdowns();
        }
    });

    // Fullscreen handler
    document.addEventListener('fullscreenchange', () => {
        const fsIcon = document.fullscreenElement ? 'fullscreen_exit' : 'fullscreen';
        const icon = document.getElementById('btn-fullscreen')?.querySelector('.material-icons');
        if (icon) icon.textContent = fsIcon;
        const handleIcon = document.getElementById('btn-handle-fullscreen')?.querySelector('.material-icons');
        if (handleIcon) handleIcon.textContent = fsIcon;
        setTimeout(() => {
            const session = getActiveSession();
            if (session && session.client && session.client.renderer) session.client.renderer.resize();
        }, 100);
    });

    // Escape to show toolbar
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !document.fullscreenElement) showToolbar();
    });

    // Window resize
    window.addEventListener('resize', () => {
        const session = getActiveSession();
        if (session && session.client && session.client.renderer) session.client.renderer.resize();
    });

    // ---- Add Session Dialog ----

    const addOverlay = document.getElementById('add-session-overlay');
    const newSessionInput = document.getElementById('new-session-id');

    document.getElementById('btn-add-session')?.addEventListener('click', () => {
        addOverlay.style.display = 'flex';
        newSessionInput.value = '';
        newSessionInput.focus();
    });

    document.getElementById('btn-cancel-new')?.addEventListener('click', () => {
        addOverlay.style.display = 'none';
    });

    document.getElementById('btn-connect-new')?.addEventListener('click', () => {
        const id = newSessionInput.value.trim();
        if (!id || !/^[A-Za-z0-9_-]{3,64}$/.test(id)) {
            newSessionInput.classList.add('error');
            setTimeout(() => newSessionInput.classList.remove('error'), 1500);
            return;
        }
        addOverlay.style.display = 'none';
        createSession(id, '');
    });

    newSessionInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('btn-connect-new')?.click();
        if (e.key === 'Escape') addOverlay.style.display = 'none';
    });

    // ---- HTTP Warning Banner ----

    let httpWarningShown = false;
    function showHttpWarningBanner() {
        if (httpWarningShown) return;
        httpWarningShown = true;
        const banner = document.createElement('div');
        banner.className = 'http-warning-banner';
        banner.innerHTML = '<span class="material-icons">warning</span> ' +
            '<span>' + (_('remote.http_warning') || 'HTTP mode: limited to H.264 software decode (~15 FPS). Use HTTPS for full performance (WebCodecs, VP9, 60 FPS).') + '</span>' +
            '<button class="http-warning-dismiss" title="Dismiss">&times;</button>';
        document.body.appendChild(banner);
        banner.querySelector('.http-warning-dismiss').addEventListener('click', () => banner.remove());
    }

    // ---- Translation helper fallback ----
    if (typeof window._ === 'undefined') {
        window._ = function (key) {
            const parts = key.split('.');
            let val = window.BetterDesk?.translations;
            for (const p of parts) {
                if (!val) return key;
                val = val[p];
            }
            return val || key;
        };
    }

    // ---- Initialize ----

    function init() {
        const deviceId = window.__initialDeviceId;
        const deviceName = window.__initialDeviceName || '';
        if (deviceId) {
            createSession(deviceId, deviceName);
        }

        // Support opening additional sessions via URL hash: #add=DEVICE_ID
        if (window.location.hash) {
            const match = window.location.hash.match(/add=([A-Za-z0-9_-]+)/);
            if (match && match[1] && match[1] !== deviceId) {
                createSession(match[1], '');
            }
        }

        // ---- BroadcastChannel for cross-tab session adding ----
        // Devices page can send {type:'add-session', deviceId, deviceName}
        // to add a new tab here without opening a new browser tab.
        try {
            const bc = new BroadcastChannel('betterdesk-remote');
            bc.onmessage = (ev) => {
                const msg = ev.data;
                if (!msg || typeof msg !== 'object') return;
                if (msg.type === 'add-session' && msg.deviceId) {
                    // Validate deviceId format (alphanumeric, hyphens, underscores)
                    if (!/^[A-Za-z0-9_-]+$/.test(msg.deviceId)) return;
                    createSession(msg.deviceId, msg.deviceName || '');
                    // Acknowledge so the sender knows we handled it
                    bc.postMessage({ type: 'session-added', deviceId: msg.deviceId });
                    // Bring this window to front
                    window.focus();
                } else if (msg.type === 'ping') {
                    bc.postMessage({ type: 'pong' });
                }
            };
        } catch (_) {
            // BroadcastChannel not supported — cross-tab disabled
        }
    }

    // ── Tab / window lifecycle: auto-disconnect on tab close ─────────────
    //
    // Without this hook the remote peer keeps streaming video/audio until
    // the relay notices the WebSocket is gone (seconds, sometimes longer
    // when the OS pauses the page). An explicit `pagehide` / `beforeunload`
    // triggers a clean `disconnect()` on every active session so the peer
    // tears down immediately — saves bandwidth and CPU on the remote end.
    function installLifecycleHandlers() {
        const teardown = () => {
            for (const session of sessions.values()) {
                try {
                    if (session.client) session.client.disconnect();
                } catch { /* ignore */ }
                if (session.mediaRecorder && session.mediaRecorder.state === 'recording') {
                    try { session.mediaRecorder.stop(); } catch { /* ignore */ }
                }
            }
        };
        // pagehide fires on tab close, navigation, and bfcache eviction —
        // the most reliable modern hook.
        window.addEventListener('pagehide', teardown, { capture: true });
        // beforeunload is a secondary fallback for older browsers.
        window.addEventListener('beforeunload', teardown, { capture: true });
    }

    init();
    installLifecycleHandlers();
})();
