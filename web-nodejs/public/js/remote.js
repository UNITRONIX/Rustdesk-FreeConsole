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
        const t = String(caps.transport || 'rd').toLowerCase();
        if (t === 'mesh') return 'mesh';
        if (t === 'cdap') return 'cdap';
        return 'rd';
    }

    function isGuestAccessMode() {
        const caps = window.__capabilities || {};
        return !!(caps.guest_access || caps.mesh_share);
    }

    function guestAllowedPeerIds() {
        const caps = window.__capabilities || {};
        if (Array.isArray(caps.guest_peer_ids) && caps.guest_peer_ids.length) {
            return caps.guest_peer_ids.map(String);
        }
        if (caps.mesh_share && window.__initialDeviceId) {
            return [String(window.__initialDeviceId)];
        }
        return [];
    }

    function isPeerAllowedForGuest(deviceId) {
        if (!isGuestAccessMode()) return true;
        const allowed = guestAllowedPeerIds();
        if (!allowed.length) return false;
        return allowed.includes(String(deviceId));
    }

    function applyGuestUiLockdown() {
        if (!isGuestAccessMode()) return;
        const hideIds = ['btn-add-session', 'session-picker-backdrop', 'session-picker-panel'];
        hideIds.forEach((id) => {
            const el = document.getElementById(id);
            if (el) {
                el.hidden = true;
                el.style.display = 'none';
            }
        });
        const back = document.getElementById('btn-back-devices');
        if (back) {
            back.title = t('guest_access.back_to_list', 'Back to guest devices');
            back.onclick = function (e) {
                e.preventDefault();
                e.stopPropagation();
                const token = new URLSearchParams(window.location.search).get('guest')
                    || new URLSearchParams(window.location.search).get('t')
                    || window.__guestToken
                    || '';
                window.location.href = token ? ('/remote/guest?t=' + encodeURIComponent(token)) : '/remote/guest';
            };
        }
        if (window.__capabilities && (window.__capabilities.guest_view_only || window.__capabilities.mesh_view_only)) {
            // View-only: leave transport adapters to enforce; hide file transfer / chat when present
            ['btn-file-transfer', 'btn-chat'].forEach((id) => {
                const el = document.getElementById(id);
                if (el) {
                    el.disabled = true;
                    el.classList.add('disabled');
                    el.style.display = 'none';
                }
            });
        }
    }
    function createTransportClient(canvas, opts) {
        const name = getTransportName();
        if (name === 'mesh' && typeof MeshSession === 'function') {
            return new MeshSession(canvas, opts);
        }
        if (name === 'cdap' && typeof CDAPSession === 'function') {
            return new CDAPSession(canvas, opts);
        }
        return new RDClient(canvas, opts);
    }

    // ---- Simple toast notification ----
    function showToast(message, type) {
        const toast = document.createElement('div');
        toast.className = 'rd-toast rd-toast-' + (type || 'info');
        toast.textContent = message;
        // Prefer the fullscreen / viewer shell host — body children are invisible in FS.
        const host = document.fullscreenElement
            || document.getElementById('rd-viewer-shell')
            || document.body;
        host.appendChild(toast);
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
            keyboardMode: 'Auto',
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
            serverRecord: session.meshServerRecord || false,
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
            if (typeof client.setKeyboardMode === 'function' && prefs.keyboardMode) {
                client.setKeyboardMode(prefs.keyboardMode);
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
            this.rememberPeerCheckbox = panel.querySelector('.session-remember-peer-checkbox');
            this.loginError = panel.querySelector('.session-login-error');
            this.statusText = panel.querySelector('.session-status-text');
            this.overlayActions = panel.querySelector('.session-overlay-actions');
            this.chatPanel = panel.querySelector('.session-chat-panel');
            this.chatMessages = panel.querySelector('.session-chat-messages');
            this.chatInput = panel.querySelector('.session-chat-input');
            this.tfaOverlay = panel.querySelector('.session-2fa-overlay');
            this.tfaInput = panel.querySelector('.session-2fa-input');
            this.tfaError = panel.querySelector('.session-2fa-error');
            this.cdapFallbackBtn = panel.querySelector('.session-btn-cdap-fallback');
            this.client = null;
            this.state = 'idle';
            this.meshServerRecord = false;
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
    const viewerShell = document.getElementById('rd-viewer-shell');
    const toolbar = document.getElementById('viewer-toolbar');
    const toolbarHandle = document.getElementById('toolbar-handle');
    const toolbarNotchSlot = document.getElementById('toolbar-notch-slot');
    const toolbarStatus = document.getElementById('toolbar-status');
    const toolbarDeviceId = document.getElementById('toolbar-device-id');
    const tabBar = document.getElementById('session-tabs');

    // ---- Notch toolbar (integrated in session tab bar) ----
    // Compact handle pulls the action drawer open; fullscreen stays on the handle only.
    let toolbarPinned = false;
    let drawerPullTimer = null;

    function syncToolbarHandleAria(expanded) {
        if (!toolbarHandle) return;
        toolbarHandle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }

    function setDrawerPulling(active) {
        toolbar?.classList.toggle('drawer-pulling', active);
        if (!active) {
            clearTimeout(drawerPullTimer);
            drawerPullTimer = null;
            return;
        }
        clearTimeout(drawerPullTimer);
        drawerPullTimer = setTimeout(() => toolbar?.classList.remove('drawer-pulling'), 440);
    }

    function syncExpandControlIcon(expanded) {
        const exp = document.getElementById('btn-toolbar-expand');
        if (!exp) return;
        exp.classList.toggle('active', expanded);
        const ic = exp.querySelector('.material-icons');
        if (ic) ic.textContent = expanded ? 'expand_less' : 'expand_more';
    }

    function expandToolbar() {
        if (toolbarNotchSlot?.classList.contains('toolbar-chrome-hidden')) return;
        toolbar.classList.remove('hover-preview');
        toolbar.classList.add('expanded');
        syncToolbarHandleAria(true);
        syncExpandControlIcon(true);
        setDrawerPulling(true);
    }

    function collapseToolbar() {
        if (toolbarPinned) return;
        if (document.querySelector('.toolbar-dropdown-menu.open')) return;
        setDrawerPulling(true);
        toolbar.classList.remove('expanded');
        toolbar.classList.remove('hover-preview');
        syncToolbarHandleAria(false);
        syncExpandControlIcon(false);
    }

    function toggleToolbar() {
        if (toolbar.classList.contains('expanded') || toolbar.classList.contains('pinned')) {
            toolbar.classList.remove('expanded', 'hover-preview');
            syncExpandControlIcon(false);
            syncToolbarHandleAria(false);
            setDrawerPulling(true);
            if (toolbarPinned) {
                toolbarPinned = false;
                toolbar.classList.remove('pinned');
                document.getElementById('btn-pin')?.classList.remove('active');
            }
        } else {
            expandToolbar();
        }
    }

    if (toolbarHandle && toolbar) {
        toolbarHandle.addEventListener('mouseenter', () => {
            if (!toolbar.classList.contains('expanded') && !toolbarPinned) {
                toolbar.classList.add('hover-preview');
            }
        });
        toolbarHandle.addEventListener('mouseleave', () => {
            if (!toolbar.classList.contains('expanded')) {
                toolbar.classList.remove('hover-preview');
            }
        });
        toolbarHandle.addEventListener('focusin', () => {
            if (!toolbar.classList.contains('expanded') && !toolbarPinned) {
                toolbar.classList.add('hover-preview');
            }
        });
        toolbarHandle.addEventListener('focusout', () => {
            if (!toolbar.classList.contains('expanded')) {
                toolbar.classList.remove('hover-preview');
            }
        });
        toolbarHandle.addEventListener('click', (e) => {
            if (toolbarNotchSlot?.classList.contains('toolbar-chrome-hidden')) return;
            if (e.target.closest('#btn-handle-fullscreen')) return;
            e.preventDefault();
            toggleToolbar();
        });
        toolbarHandle.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            if (e.target.closest('#btn-handle-fullscreen')) return;
            e.preventDefault();
            toggleToolbar();
        });
    }

    // Legacy compatibility shims — older code paths call these to surface the
    // status while overlays are visible. They now drive expand/collapse only,
    // never an auto-hide timer.
    function showToolbar() {
        if (toolbarNotchSlot?.classList.contains('toolbar-chrome-hidden')) return;
        expandToolbar();
    }

    let toolbarChromeExiting = false;

    function forceCollapseToolbar() {
        toolbarPinned = false;
        toolbar.classList.remove('expanded', 'pinned', 'hover-preview', 'drawer-pulling');
        document.getElementById('btn-pin')?.classList.remove('active');
        syncToolbarHandleAria(false);
        syncExpandControlIcon(false);
        clearTimeout(drawerPullTimer);
        drawerPullTimer = null;
    }

    function setToolbarChromeVisible(visible) {
        if (!toolbarNotchSlot) return;
        const wasHidden = toolbarNotchSlot.classList.contains('toolbar-chrome-hidden');

        if (!visible) {
            if (wasHidden || toolbarChromeExiting) return;
            const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            if (reducedMotion) {
                toolbarNotchSlot.classList.add('toolbar-chrome-hidden');
                forceCollapseToolbar();
                toolbarNotchSlot.classList.remove('toolbar-chrome-enter', 'toolbar-chrome-exit');
                return;
            }
            toolbarChromeExiting = true;
            playToolbarChromeExit(() => {
                toolbarNotchSlot.classList.add('toolbar-chrome-hidden');
                forceCollapseToolbar();
                toolbarNotchSlot.classList.remove('toolbar-chrome-enter', 'toolbar-chrome-exit');
                toolbarChromeExiting = false;
            });
            return;
        }

        toolbarChromeExiting = false;
        toolbarNotchSlot.classList.remove('toolbar-chrome-hidden', 'toolbar-chrome-exit');
        if (wasHidden) playToolbarChromeEnter();
    }

    function playToolbarChromeExit(done) {
        if (!toolbarNotchSlot) {
            done?.();
            return;
        }
        toolbarNotchSlot.classList.remove('toolbar-chrome-enter');
        void toolbarNotchSlot.offsetWidth;
        toolbarNotchSlot.classList.add('toolbar-chrome-exit');

        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            toolbarNotchSlot.classList.remove('toolbar-chrome-exit');
            toolbarNotchSlot.removeEventListener('animationend', onEnd);
            clearTimeout(fallback);
            done?.();
        };

        const onEnd = (ev) => {
            if (ev.target !== toolbarNotchSlot) return;
            finish();
        };

        toolbarNotchSlot.addEventListener('animationend', onEnd);
        const fallback = setTimeout(finish, 420);
    }

    function playToolbarChromeEnter() {
        if (!toolbarNotchSlot) return;
        toolbarNotchSlot.classList.remove('toolbar-chrome-enter');
        void toolbarNotchSlot.offsetWidth;
        toolbarNotchSlot.classList.add('toolbar-chrome-enter');
        const onEnd = (ev) => {
            if (ev.target !== toolbarNotchSlot && !ev.target.classList.contains('toolbar-handle')) return;
            toolbarNotchSlot.classList.remove('toolbar-chrome-enter');
            toolbarNotchSlot.removeEventListener('animationend', onEnd);
        };
        toolbarNotchSlot.addEventListener('animationend', onEnd);
        setTimeout(() => toolbarNotchSlot.classList.remove('toolbar-chrome-enter'), 500);
    }

    /** Show notch only during active streaming; hidden on login/connect overlays. */
    function syncToolbarChrome(session) {
        if (!session || !isActive(session) || session.state !== 'streaming') {
            setToolbarChromeVisible(false);
            return;
        }
        setToolbarChromeVisible(true);
        if (!toolbarPinned) collapseToolbar();
    }

    // Keep toolbar chrome in sync when session ends (disconnect / error / idle).
    function hideToolbarChromeForSession(session) {
        if (!session || !isActive(session)) return;
        setToolbarChromeVisible(false);
    }

    function setToolbarAutoHide(enable) {
        if (enable) {
            syncToolbarChrome(getActiveSession());
        } else {
            setToolbarChromeVisible(false);
        }
    }

    // ---- Independent "back to devices" navigation ----
    // The rdclient page is opened as a script-launched tab (window.open) from
    // the web panel. Navigating THIS tab to /devices spawned duplicate panel
    // tabs that accumulated over time. Instead, close this tab and re-focus the
    // opener; only fall back to navigation when there is no opener (e.g. the
    // page was opened directly via URL).
    function isRdClientDesktop() {
        if (window.__BETTERDESK_RDCLIENT_DESKTOP__) return true;
        return !!(window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function');
    }

    function returnToDevices() {
        if (isRdClientDesktop()) {
            const invoke = window.__TAURI__?.core?.invoke;
            if (invoke) {
                invoke('close_current_window').catch(() => {
                    window.__TAURI__?.window?.getCurrentWindow?.()?.close?.().catch(() => {});
                });
                return;
            }
            // Desktop shell injected flag but IPC not ready — never navigate to /devices.
            if (window.__BETTERDESK_RDCLIENT_DESKTOP__ && /\/remote\/[^/?#]+/.test(location.pathname)) {
                return;
            }
        }

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
    //
    // Never run this on right/middle-click: Desktop Cliprdr sync + FormatData
    // share a cache lock with remote Explorer context-menu probes. Awaiting
    // sync on button 2 is what made right-click take 20+ seconds when the
    // local clipboard held files.
    function _clipDebug() {
        if (window.BetterDesk && window.BetterDesk.debugRelay) {
            console.log.apply(console, ['[ClipboardSync]'].concat(Array.prototype.slice.call(arguments)));
        }
    }
    let _lastSyncedClipboard = '';
    let _clipSyncTimer = null;
    let _clipSyncQueued = false;
    async function syncLocalClipboardToRemote(ev) {
        if (typeof RDCliprdr !== 'undefined'
            && typeof RDCliprdr.shouldSyncOnUserGesture === 'function'
            && !RDCliprdr.shouldSyncOnUserGesture(ev)) {
            _clipDebug('skip: non-left mouse button (keep remote context menu responsive)');
            return;
        }
        const session = getActiveSession();
        if (!session || !session.client || session.state !== 'streaming') {
            _clipDebug('skip: no active streaming session', session && session.state);
            return;
        }
        if (session.client.viewOnly) {
            _clipDebug('skip: view-only session');
            return;
        }
        if (session.client._lastSyncedClipboardHint) {
            _lastSyncedClipboard = session.client._lastSyncedClipboardHint;
        }
        let hasFiles = false;
        if (window.__BETTERDESK_RDCLIENT_DESKTOP__ && typeof RDCliprdr !== 'undefined' && RDCliprdr.isSupported()) {
            _clipDebug('desktop bridge detected → syncCliprdrFiles()');
            try {
                const sync = await session.client.syncCliprdrFiles();
                hasFiles = !!(sync && sync.hasFiles);
                if (sync && sync.busy) {
                    _clipDebug('Cliprdr sync busy (clipboard locked) — skipping text push');
                    return;
                }
            } catch (err) {
                _clipDebug('syncCliprdrFiles failed:', err && err.message ? err.message : err);
            }
        } else if (window.__BETTERDESK_RDCLIENT_DESKTOP__) {
            _clipDebug('desktop flag set but RDCliprdr.isSupported() is false — check window.__TAURI__.core.invoke');
        }
        // Explorer file copies often also expose a path as CF_UNICODETEXT. Sending
        // that text Clipboard message after Cliprdr FormatList clears file formats
        // on the peer — skip text when local CF_HDROP is present.
        // Also never flushPendingLocalClipboard (writeText) before Cliprdr sync:
        // that wipes CF_HDROP and can leave remote Explorer stuck on a half-applied
        // FormatList from the previous click.
        if (hasFiles) {
            _clipDebug('skip text clipboard: local file clipboard (CF_HDROP) present');
            return;
        }
        // Remote→local writes often fail without a gesture; retry on focus/click
        // only when we are not holding a local file clipboard.
        if (typeof session.client.flushPendingLocalClipboard === 'function') {
            try {
                await session.client.flushPendingLocalClipboard();
            } catch (_) { /* ignore */ }
        }
        if (!navigator.clipboard || !navigator.clipboard.readText) {
            _clipDebug('skip: navigator.clipboard.readText unavailable in this webview');
            return;
        }
        try {
            const text = await navigator.clipboard.readText();
            _clipDebug('readText() ok, length=', text ? text.length : 0);
            if (text && text !== _lastSyncedClipboard) {
                _lastSyncedClipboard = text;
                session.client.sendClipboard(text);
                _clipDebug('sendClipboard() called');
            }
        } catch (err) {
            _clipDebug('readText() FAILED:', err && err.message ? err.message : err);
            // Permission denied or not focused — ignore, the manual paste
            // button remains available as a fallback.
        }
    }
    function scheduleLocalClipboardSync(ev) {
        if (typeof RDCliprdr !== 'undefined'
            && typeof RDCliprdr.shouldSyncOnUserGesture === 'function'
            && !RDCliprdr.shouldSyncOnUserGesture(ev)) {
            return;
        }
        // Debounce left-click storms so we do not stack Cliprdr IPC on every
        // mousedown while a prior assess/materialize is still running.
        _clipSyncQueued = true;
        if (_clipSyncTimer) return;
        _clipSyncTimer = setTimeout(function () {
            _clipSyncTimer = null;
            if (!_clipSyncQueued) return;
            _clipSyncQueued = false;
            void syncLocalClipboardToRemote({ button: 0 });
        }, 200);
    }
    window.addEventListener('focus', function () {
        void syncLocalClipboardToRemote(null);
    });
    if (viewerContainer) {
        viewerContainer.addEventListener('mousedown', scheduleLocalClipboardSync);

        // Browser HTML5 drag-and-drop onto the session surface → file transfer upload
        viewerContainer.addEventListener('dragover', (e) => {
            if (!e.dataTransfer || !e.dataTransfer.types) return;
            const hasFiles = Array.from(e.dataTransfer.types).includes('Files');
            if (!hasFiles) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });
        viewerContainer.addEventListener('drop', (e) => {
            const files = e.dataTransfer && e.dataTransfer.files;
            if (!files || !files.length) return;
            e.preventDefault();
            const session = getActiveSession();
            if (!session || !session.client || !session.client.fileTransfer) return;
            if (session.client.viewOnly) return;
            if (!window.__fileTransferModal) return;
            if (!window.__fileTransferModal.isOpen()) {
                window.__fileTransferModal.open(session);
            }
            if (typeof window.__fileTransferModal._uploadFiles === 'function') {
                window.__fileTransferModal._uploadFiles(files);
            }
        });
    }

    if (window.__BETTERDESK_RDCLIENT_DESKTOP__
        && typeof RDDesktopDnd !== 'undefined'
        && RDDesktopDnd.isSupported()) {
        RDDesktopDnd.ensureNativeDropListener();
        RDDesktopDnd.bind({
            // Session surface: Cliprdr paste into whatever is under the drop point.
            // Do NOT auto-open the file-transfer modal — that race wiped the paste UX.
            onCliprdrSync(paths, position) {
                if (window.__fileTransferModal && window.__fileTransferModal.isOpen()) {
                    return;
                }
                const session = getActiveSession();
                if (!session || !session.client || session.state !== 'streaming') return;
                if (session.client.viewOnly) return;
                session.client.syncCliprdrPaths(paths, position || null);
            },
            // File-transfer modal only: upload into the current remote folder.
            onUploadPaths(paths) {
                if (!window.__fileTransferModal || !window.__fileTransferModal.isOpen()) {
                    return;
                }
                const session = getActiveSession();
                if (!session) return;
                window.__fileTransferModal.uploadNativePaths(paths);
            }
        });
    }


    // ---- Tab Bar (slim + expandable cards) ----

    const sessionTabBarEl = document.getElementById('session-tab-bar');
    let expandedTabId = null;

    function collapseExpandedTabBarItems() {
        tabBar.querySelectorAll('.session-tab-card.is-expanded').forEach((t) => t.classList.remove('is-expanded'));
        document.getElementById('btn-back-devices')?.classList.remove('is-expanded');
        document.getElementById('btn-add-session')?.classList.remove('is-expanded');
        expandedTabId = null;
    }

    function tabStatusClass(state) {
        switch (state) {
        case 'streaming': return 'status-online';
        case 'connecting':
        case 'authenticating':
        case 'waiting_password': return 'status-connecting';
        case 'error': return 'status-error';
        default: return 'status-offline';
        }
    }

    function createTab(deviceId, deviceName, platform) {
        const tab = document.createElement('div');
        tab.className = 'session-tab session-tab-card status-offline';
        tab.dataset.sessionId = deviceId;

        const inner = document.createElement('div');
        inner.className = 'session-tab-card-inner';

        const osIcon = document.createElement('span');
        osIcon.className = 'session-tab-os material-icons';
        const iconName = (window.RemoteAddressBook && window.RemoteAddressBook.platformIcon)
            ? window.RemoteAddressBook.platformIcon(platform || '')
            : 'devices';
        osIcon.textContent = iconName;
        inner.appendChild(osIcon);

        const label = document.createElement('span');
        label.className = 'session-tab-label';
        label.textContent = deviceName || deviceId;
        label.title = deviceId;
        inner.appendChild(label);

        const dot = document.createElement('span');
        dot.className = 'session-tab-dot dot-offline';
        inner.appendChild(dot);

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'session-tab-close';
        closeBtn.innerHTML = '<span class="material-icons" style="font-size:14px">close</span>';
        closeBtn.title = t('actions.close', 'Close');
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeSession(deviceId);
        });
        inner.appendChild(closeBtn);

        tab.appendChild(inner);

        const glow = document.createElement('div');
        glow.className = 'session-tab-glow';
        glow.setAttribute('aria-hidden', 'true');
        tab.appendChild(glow);

        tab.addEventListener('click', (e) => {
            if (e.target.closest('.session-tab-close')) return;
            switchSession(deviceId);
            if (window.matchMedia('(hover: none)').matches) {
                collapseExpandedTabBarItems();
                tab.classList.add('is-expanded');
                expandedTabId = deviceId;
            }
        });

        tabBar.appendChild(tab);
    }

    function updateTabState(deviceId, state) {
        const tab = findTab(deviceId);
        if (!tab) return;
        tab.classList.remove('status-online', 'status-connecting', 'status-error', 'status-offline');
        tab.classList.add(tabStatusClass(state));
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
        tabBar.querySelectorAll('.session-tab').forEach((t) => t.classList.remove('active'));
        const tab = findTab(deviceId);
        if (tab) tab.classList.add('active');
    }

    function findTab(deviceId) {
        return tabBar.querySelector('[data-session-id="' + CSS.escape(deviceId) + '"]');
    }

    function bindSlimTabBar() {
        if (!sessionTabBarEl) return;

        ['btn-back-devices', 'btn-add-session'].forEach((id) => {
            const btn = document.getElementById(id);
            if (!btn) return;
            btn.addEventListener('click', () => {
                if (window.matchMedia('(hover: none)').matches) {
                    collapseExpandedTabBarItems();
                    btn.classList.add('is-expanded');
                }
            }, { capture: true });
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('#session-tab-bar')) {
                collapseExpandedTabBarItems();
            }
        });
    }

    // ---- Session Lifecycle ----

    function createSession(deviceId, deviceName, platform) {
        if (!isPeerAllowedForGuest(deviceId)) {
            console.warn('Guest access: refused session outside allowlist', deviceId);
            return;
        }
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
        createTab(deviceId, deviceName, platform);
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
        attachMobileTouch(session);
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

        if (window.__fileTransferModal?.isOpen()) {
            window.__fileTransferModal.close();
        }

        // Sync toolbar state
        syncToolbarToSession(session);
        syncToolbarFromSession(session);

        if (session.state === 'streaming') {
            session.canvas.focus();
            session.client.renderer.resize();
            syncToolbarChrome(session);
        } else {
            syncToolbarChrome(session);
        }

        syncSessionMediaCapture();

        if (session.state === 'streaming' && session.client) {
            session.client.setAudioMuted(session.audioMuted);
        }
        syncMobileTouchForActive();
    }

    function closeSession(deviceId, options) {
        options = options || {};
        const session = sessions.get(deviceId);
        if (!session) {
            const tab = findTab(deviceId);
            if (tab) tab.remove();
            return;
        }

        try { if (session.client) session.client.disconnect(); } catch { /* ignore */ }
        if (window.__fileTransferModal?.isOpen() &&
            window.__fileTransferModal._session?.deviceId === deviceId) {
            window.__fileTransferModal.close();
        }
        if (session.mediaRecorder && session.mediaRecorder.state === 'recording') {
            try { session.mediaRecorder.stop(); } catch { /* ignore */ }
        }

        if (session.panel) session.panel.remove();
        const tab = findTab(deviceId);
        if (tab) tab.remove();
        sessions.delete(deviceId);

        if (expandedTabId === deviceId) expandedTabId = null;

        if (activeSessionId === deviceId) {
            activeSessionId = null;
            if (sessions.size > 0) {
                switchSession(sessions.keys().next().value);
            } else if (!options.suppressReturn) {
                returnToDevices();
            }
        } else {
            syncSessionMediaCapture();
        }
    }

    function closeAllSessions() {
        Array.from(sessions.keys()).forEach((id) => closeSession(id, { suppressReturn: true }));
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
            if (isActive(session)) {
                if (state !== 'streaming') hideToolbarChromeForSession(session);
                syncToolbarToSession(session);
            }
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
            if (isActive(session)) setToolbarChromeVisible(false);
        });

        c.on('cdap_fallback_available', () => {
            showCdapFallback(session);
        });

        c.on('disconnected', (reason) => {
            setSessionStatus(session, 'info', reason || _('remote.disconnected'));
            showSessionActions(session);
            if (isActive(session)) setToolbarChromeVisible(false);
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
            session.loginError.style.display = 'none';
            session.passwordInput.value = '';
            session._authPreferServer = true;
            session._authFromServer = false;

            const tryAuth = (pw, remember, fromServer) => {
                if (!pw || !session.client) return false;
                session.passwordOverlay.style.display = 'none';
                session.passwordInput.value = pw;
                session._authFromServer = !!fromServer;
                if (session.rememberPeerCheckbox) {
                    // Passwordless mode: never persist/reuse local vault copies.
                    session.rememberPeerCheckbox.checked = !!(remember && !fromServer);
                }
                session.client.authenticate(pw);
                return true;
            };

            const showPasswordPrompt = (hint) => {
                session.passwordOverlay.style.display = 'flex';
                if (hint) {
                    session.loginError.textContent = hint;
                    session.loginError.style.display = 'block';
                }
                if (isActive(session)) session.passwordInput.focus();
                if (isActive(session)) setToolbarChromeVisible(false);
            };

            const clearLocalVault = () => {
                if (window.RdClientSecureStore && session.deviceId) {
                    window.RdClientSecureStore.clearPeerPassword(session.deviceId).catch(function () { /* ignore */ });
                }
            };

            // 1) Console unattended connect-secret (Access Policy)
            // 2) Local remembered peer password (auto-submit) — skipped when passwordless
            // 3) Manual prompt (with reason when secret fetch fails)
            // Priority is controlled by Access Policy "Passwordless server access".
            const fetchSecret = fetch('/api/devices/' + encodeURIComponent(session.deviceId) + '/connect-secret', {
                credentials: 'same-origin',
                headers: { Accept: 'application/json' },
            }).then(async (r) => {
                let body = null;
                try { body = await r.json(); } catch (_) { /* ignore */ }
                if (!r.ok) {
                    return {
                        ok: false,
                        error: (body && (body.error || (body.data && body.data.error))) || ('HTTP ' + r.status),
                        preferServer: body && (typeof body.passwordless_server_access === 'boolean'
                            ? body.passwordless_server_access
                            : (body.data && body.data.passwordless_server_access)),
                    };
                }
                return {
                    ok: true,
                    password: (body && (body.password || (body.data && body.data.password))) || '',
                    preferServer: body && (typeof body.passwordless_server_access === 'boolean'
                        ? body.passwordless_server_access
                        : (body.data && body.data.passwordless_server_access)),
                };
            }).catch((e) => ({ ok: false, error: e.message || 'connect-secret failed' }));

            const fetchVault = (window.RdClientSecureStore && session.deviceId)
                ? window.RdClientSecureStore.loadPeerPassword(session.deviceId).catch(() => null)
                : Promise.resolve(null);

            const fetchPolicy = fetch('/api/devices/' + encodeURIComponent(session.deviceId) + '/access-policy', {
                credentials: 'same-origin',
                headers: { Accept: 'application/json' },
            }).then(async (r) => {
                if (!r.ok) return null;
                try { return await r.json(); } catch (_) { return null; }
            }).catch(() => null);

            Promise.all([fetchSecret, fetchVault, fetchPolicy]).then(([secretResp, saved, policyResp]) => {
                const policy = (policyResp && (policyResp.data || policyResp)) || {};
                // Default true = prefer sealed server password.
                let preferServer = true;
                if (typeof secretResp.preferServer === 'boolean') {
                    preferServer = secretResp.preferServer;
                } else if (typeof policy.passwordless_server_access === 'boolean') {
                    preferServer = policy.passwordless_server_access;
                }
                session._authPreferServer = preferServer;

                if (session.rememberPeerCheckbox) {
                    const row = session.rememberPeerCheckbox.closest('.session-remember-peer');
                    if (row) row.style.display = preferServer ? 'none' : '';
                    if (preferServer) session.rememberPeerCheckbox.checked = false;
                }

                const secretPw = secretResp && secretResp.ok && secretResp.password;
                const tryServer = () => !!(secretPw && tryAuth(secretPw, false, true));
                const tryClient = () => !!(saved && tryAuth(saved, true, false));

                if (preferServer) {
                    // Drop stale local copies so they cannot override a console password change.
                    clearLocalVault();
                    if (tryServer()) return;
                    // Do not fall back to vault — prompt so the operator can type the live device password.
                } else {
                    if (tryClient()) return;
                    if (tryServer()) return;
                    if (saved) {
                        session.passwordInput.value = saved;
                        if (session.rememberPeerCheckbox) session.rememberPeerCheckbox.checked = true;
                    }
                }

                let hint = '';
                if (secretResp && !secretResp.ok && secretResp.error) {
                    hint = secretResp.error;
                    console.warn('[Remote] connect-secret:', secretResp.error);
                }
                showPasswordPrompt(hint);
            }).catch(() => showPasswordPrompt(''));
        });

        c.on('login_error', (error) => {
            if (session.state === 'waiting_2fa' || session.tfaOverlay.style.display === 'flex') {
                session.tfaError.textContent = error;
                session.tfaError.style.display = 'block';
                session.tfaInput.value = '';
                if (isActive(session)) session.tfaInput.focus();
                return;
            }
            // Stale vault / failed auto-auth — never keep a rejected password around in passwordless mode.
            if (session._authPreferServer || session._authFromServer) {
                if (window.RdClientSecureStore && session.deviceId) {
                    window.RdClientSecureStore.clearPeerPassword(session.deviceId).catch(function () { /* ignore */ });
                }
                if (session.rememberPeerCheckbox) session.rememberPeerCheckbox.checked = false;
            }
            session._authFromServer = false;
            // Auto-auth may have hidden the overlay — show it again on failure
            session.passwordOverlay.style.display = 'flex';
            session.loginError.textContent = error;
            session.loginError.style.display = 'block';
            session.passwordInput.value = '';
            if (isActive(session)) session.passwordInput.focus();
            if (isActive(session)) setToolbarChromeVisible(false);
        });

        c.on('2fa_error', (error) => {
            session.tfaError.textContent = error || (_('remote.2fa_invalid') || 'Invalid code');
            session.tfaError.style.display = 'block';
            session.tfaInput.value = '';
            session.tfaOverlay.style.display = 'flex';
            if (isActive(session)) session.tfaInput.focus();
            if (isActive(session)) setToolbarChromeVisible(false);
        });

        c.on('2fa_required', () => {
            session.passwordOverlay.style.display = 'none';
            session.connectionOverlay.style.display = 'none';
            session.tfaOverlay.style.display = 'flex';
            session.tfaError.style.display = 'none';
            session.tfaInput.value = '';
            if (isActive(session)) session.tfaInput.focus();
            if (isActive(session)) setToolbarChromeVisible(false);
        });

        c.on('login_success', () => {
            session.passwordOverlay.style.display = 'none';
            session.tfaOverlay.style.display = 'none';
            session.passwordInput.blur();
            if (window.RdClientSecureStore && session.deviceId) {
                var preferServer = !!session._authPreferServer || !!session._authFromServer;
                var pw = session.passwordInput.value;
                if (preferServer) {
                    // Passwordless: never keep a local copy that can go stale after console changes.
                    window.RdClientSecureStore.clearPeerPassword(session.deviceId).catch(function () { /* ignore */ });
                } else if (session.rememberPeerCheckbox && session.rememberPeerCheckbox.checked && pw) {
                    window.RdClientSecureStore.savePeerPassword(session.deviceId, pw).catch(function () { /* ignore */ });
                } else if (session.rememberPeerCheckbox && !session.rememberPeerCheckbox.checked) {
                    window.RdClientSecureStore.clearPeerPassword(session.deviceId).catch(function () { /* ignore */ });
                }
            }
            session._authFromServer = false;
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
                syncToolbarChrome(session);
                try { refreshMonitorButton(session); } catch { /* not ready */ }
            }
            if (session.client.video) {
                session.client.video.onAutoplayBlocked = () => {
                    if (isActive(session)) showAutoplayOverlay(session);
                };
            }
            if (window.__openFilePanelOnConnect && isActive(session)) {
                window.__openFilePanelOnConnect = false;
                window.__fileTransferModal?.open(session);
            }
        });

        c.on('stats', (stats) => {
            session.lastStats = stats;
        });

        c.on('latency', (rtt) => { session.latency = rtt; });

        c.on('chat', (text) => addChatMessage(session, text, 'received'));

        // Browser file paste (Explorer → Ctrl+V) — no CF_HDROP; use File Transfer upload.
        c.on('local-paste-files', (files) => {
            if (!isActive(session) || session.client.viewOnly) return;
            if (!files || !files.length) return;
            if (!window.__fileTransferModal) return;
            if (!window.__fileTransferModal.isOpen()) {
                window.__fileTransferModal.open(session);
            }
            if (typeof window.__fileTransferModal._uploadFiles === 'function') {
                window.__fileTransferModal._uploadFiles(files);
            }
        });

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
                try { updateWindowsSessionMenu(session); } catch { /* not ready */ }
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
        c.on('cliprdr_too_large', (info) => {
            const sig = (info && info.signature) || '';
            if (sig && session._cliprdrTooLargeToastSig === sig) return;
            if (sig) session._cliprdrTooLargeToastSig = sig;
            showToast(
                _('remote.cliprdr_use_file_transfer')
                || 'This folder is too large for clipboard paste. Use File transfer to avoid freezing the remote desktop.',
                'warning'
            );
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
            if (isActive(session)) setToolbarChromeVisible(false);
            break;
        case 'streaming':
            session.connectionOverlay.style.display = 'none';
            session.passwordOverlay.style.display = 'none';
            session.panel.classList.add('streaming');
            syncSessionMediaCapture();
            attachMobileTouch(session);
            syncMobileTouchForActive();
            if (isActive(session)) syncToolbarChrome(session);
            break;
        case 'disconnected':
        case 'error':
            session.panel.classList.remove('streaming');
            session.connectionOverlay.style.display = 'flex';
            setSessionStatus(session, state === 'error' ? 'error' : 'info',
                state === 'error' ? _('remote.error') : _('remote.disconnected'));
            showSessionActions(session);
            if (isActive(session)) setToolbarChromeVisible(false);
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
        const isStreaming = session.state === 'streaming';
        toolbar.classList.toggle('toolbar-streaming', isStreaming);
        if (toolbarStatus) toolbarStatus.style.display = 'none';
        document.querySelector('.toolbar-status-sep')?.style.setProperty('display', 'none');

        if (isStreaming) {
            syncToolbarChrome(session);
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
        document.querySelectorAll('.keyboard-mode-item').forEach(function (btn) {
            btn.classList.toggle('active', btn.dataset.keyboardMode === (p.keyboardMode || 'Auto'));
        });
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

    function toggleViewerShellFullscreen() {
        const target = viewerShell || viewerContainer;
        if (!target) return;
        if (!document.fullscreenElement) {
            target.requestFullscreen().catch(function () { /* ignore */ });
            if (navigator.keyboard && navigator.keyboard.lock) {
                navigator.keyboard.lock().catch(function () { /* permission / unsupported */ });
            }
        } else {
            if (navigator.keyboard && navigator.keyboard.unlock) {
                navigator.keyboard.unlock();
            }
            document.exitFullscreen().catch(function () { /* ignore */ });
        }
    }

    function applyTransportCapabilities() {
        const fileBtn = document.getElementById('btn-file-transfer');
        if (fileBtn && getTransportName() === 'cdap') {
            // CDAP uses CDAPFileTransfer over /api/cdap/devices/:id/files
            fileBtn.disabled = false;
            fileBtn.classList.remove('disabled');
            fileBtn.removeAttribute('title');
        }
        applyGuestUiLockdown();
    }

    // Disconnect
    document.getElementById('btn-disconnect')?.addEventListener('click', () => {
        withClient(c => c.disconnect());
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

    // Reset keyboard (release stuck modifiers on remote)
    document.getElementById('btn-reset-keyboard')?.addEventListener('click', () => {
        withClient(c => {
            if (typeof c.resetKeyboard === 'function') {
                c.resetKeyboard();
            } else if (c.input && typeof c.input.resetKeyboard === 'function') {
                c.input.resetKeyboard();
            }
        });
        showToast(_('remote.reset_keyboard_done') || 'Keyboard state reset on remote', 'success');
        closeAllDropdowns();
    });

    // Clipboard Paste
    document.getElementById('btn-clipboard-paste')?.addEventListener('click', async () => {
        const session = getActiveSession();
        if (!session || !session.client) return;
        if (session.client.viewOnly) {
            showToast(_('remote.view_only') || 'View only mode', 'warning');
            closeAllDropdowns();
            return;
        }
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
        });
    });

    // Keyboard mode (Legacy / Map / Auto)
    document.querySelectorAll('.keyboard-mode-item').forEach(btn => {
        btn.addEventListener('click', function () {
            var mode = this.dataset.keyboardMode || 'Auto';
            var session = getActiveSession();
            withClient(c => {
                if (typeof c.setKeyboardMode === 'function') c.setKeyboardMode(mode);
            });
            if (session) updateSessionViewerPref(session, { keyboardMode: mode });
            document.querySelectorAll('.keyboard-mode-item').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
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
        const useStrip = monitors.length >= 2 && monitors.length <= 4;
        const showDropdown = (monitors.length > 1 && !useStrip) || (vd && vd.supported);
        btn.style.display = showDropdown ? '' : 'none';
        updateMonitorStrip(session, monitors, useStrip);
        if (showDropdown) updateMonitorMenu();
    }

    function updateMonitorStrip(session, monitors, useStrip) {
        const strip = document.getElementById('toolbar-monitor-strip');
        if (!strip) return;
        strip.innerHTML = '';
        if (!useStrip || !session || !session.client || monitors.length < 2) {
            strip.hidden = true;
            return;
        }
        strip.hidden = false;
        monitors.forEach(function (m, i) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'toolbar-monitor-btn' + (m.current ? ' active' : '');
            item.title = m.name || ('Monitor ' + (i + 1));
            item.textContent = String(i + 1);
            item.addEventListener('click', function (e) {
                e.stopPropagation();
                session.client.switchMonitor(m.idx);
                strip.querySelectorAll('.toolbar-monitor-btn').forEach(function (b) {
                    b.classList.remove('active');
                });
                item.classList.add('active');
                updateMonitorMenu();
            });
            strip.appendChild(item);
        });
    }

    function updateWindowsSessionMenu(session) {
        session = session || getActiveSession();
        const menu = document.getElementById('actions-menu');
        if (!menu || !session || !session.client) return;
        menu.querySelectorAll('.windows-session-item, .windows-session-sep').forEach(function (el) {
            el.remove();
        });
        let ws = { sessions: [], currentSid: 0 };
        try {
            ws = (typeof session.client.getWindowsSessions === 'function')
                ? session.client.getWindowsSessions()
                : { sessions: [], currentSid: 0 };
        } catch { ws = { sessions: [], currentSid: 0 }; }
        if (!ws.sessions || ws.sessions.length < 2) return;

        const sep = document.createElement('div');
        sep.className = 'dropdown-separator windows-session-sep';
        menu.appendChild(sep);

        const label = document.createElement('div');
        label.className = 'dropdown-label windows-session-sep';
        label.textContent = t('remote.windows_sessions', 'Windows sessions');
        menu.appendChild(label);

        ws.sessions.forEach(function (s) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'dropdown-item windows-session-item' +
                (s.sid === ws.currentSid ? ' active' : '');
            item.innerHTML = '<span class="material-icons">desktop_windows</span> ' + escapeHtml(s.name);
            item.addEventListener('click', function () {
                session.client.selectWindowsSession(s.sid);
                menu.querySelectorAll('.windows-session-item').forEach(function (b) {
                    b.classList.remove('active');
                });
                item.classList.add('active');
                closeAllDropdowns();
            });
            menu.appendChild(item);
        });
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

        const label = menu.querySelector('.dropdown-label');
        menu.innerHTML = '';
        if (label) menu.appendChild(label);

        const listWrap = document.createElement('div');
        listWrap.className = 'monitors-menu-list';

        // Physical monitors
        monitors.forEach(m => {
            const item = document.createElement('button');
            item.className = 'dropdown-item monitor-item' + (m.current ? ' active' : '');
            item.dataset.idx = m.idx;
            const res = (m.width && m.height)
                ? '<span class="monitor-item-meta">' + m.width + '\u00d7' + m.height + '</span>'
                : '';
            item.innerHTML = '<span class="material-icons">' +
                (m.primary ? 'desktop_windows' : 'monitor') +
                '</span><span class="monitor-item-text">' +
                '<span class="monitor-item-name">' + escapeHtml(m.name) + '</span>' +
                res +
                '</span>';
            item.addEventListener('click', () => {
                session.client.switchMonitor(m.idx);
                menu.querySelectorAll('.monitor-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');
                refreshMonitorButton(session);
            });
            listWrap.appendChild(item);
        });

        menu.appendChild(listWrap);

        // Virtual displays (RustDesk IDD / Amyuni IDD)
        if (vd && vd.supported) {
            const vdWrap = document.createElement('div');
            vdWrap.className = 'monitors-menu-vd';

            const vdLabel = document.createElement('div');
            vdLabel.className = 'dropdown-label';
            vdLabel.textContent = t('remote.virtual_displays', 'Virtual displays');
            vdWrap.appendChild(vdLabel);

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
                    vdWrap.appendChild(item);
                }
            } else if (vd.impl === 'amyuni_idd') {
                const count = (typeof vd.amyuniCount === 'number') ? vd.amyuniCount : 0;
                const row = document.createElement('div');
                row.className = 'virtual-display-counter';

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
                vdWrap.appendChild(row);
            }

            // Plug out all
            const plugOut = document.createElement('button');
            plugOut.className = 'dropdown-item virtual-display-item';
            plugOut.innerHTML = '<span class="material-icons">power_off</span> ' +
                escapeHtml(t('remote.plug_out_all', 'Plug out all'));
            plugOut.addEventListener('click', () => {
                session.client.toggleVirtualDisplay(-1, false);
            });
            vdWrap.appendChild(plugOut);
            menu.appendChild(vdWrap);
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

    // File transfer modal toggle (RustDesk RDFileTransfer or CDAPFileTransfer)
    function ensureFileTransferModal() {
        if (window.__fileTransferModal && typeof window.__fileTransferModal.open === 'function') {
            return window.__fileTransferModal;
        }
        if (typeof window.FileTransferModal === 'function') {
            try {
                window.__fileTransferModal = new window.FileTransferModal();
                return window.__fileTransferModal;
            } catch (err) {
                console.error('[Remote] FileTransferModal re-init failed:', err);
                window.__fileTransferModal = null;
            }
        }
        return null;
    }

    function toggleFileTransferModal(ev) {
        if (ev) {
            ev.preventDefault();
            ev.stopPropagation();
        }
        const unavailable = t('remote.file_transfer_unavailable',
            'File transfer is not available for this session.');
        try {
            const session = getActiveSession();
            const modal = ensureFileTransferModal();
            if (!modal) {
                showToast(unavailable, 'warning');
                return;
            }
            if (modal.isOpen()) {
                modal.close();
                return;
            }
            if (!session || !session.client) {
                // Still open the shell so the operator sees a dialog, not a dead click.
                modal.open(null);
                showToast(unavailable, 'warning');
                return;
            }
            if (!session.client.fileTransfer && typeof session.client.ensureFileConnection === 'function') {
                // RD path: object exists from ctor; Mesh may create it in connect().
            }
            if (!session.client.fileTransfer) {
                modal.open(session);
                showToast(unavailable, 'warning');
                return;
            }
            if (typeof modal._ensureMountedInHost === 'function') {
                modal._ensureMountedInHost();
            }
            modal.open(session);
            // Expand drawer so the active state on the folder button is visible.
            if (!toolbar?.classList.contains('expanded') && !toolbarPinned) {
                expandToolbar();
            }
        } catch (err) {
            console.error('[Remote] File transfer toggle failed:', err);
            showToast(unavailable, 'error');
        }
    }

    document.getElementById('btn-file-transfer')?.addEventListener('click', toggleFileTransferModal);

    // Recording
    document.getElementById('btn-record')?.addEventListener('click', function () {
        const session = getActiveSession();
        if (!session) return;

        if (session.mediaRecorder && session.mediaRecorder.state === 'recording') {
            session.mediaRecorder.stop();
            this.classList.remove('recording');
        } else if (window.__capabilities && window.__capabilities.transport === 'mesh') {
            session.meshServerRecord = !session.meshServerRecord;
            this.classList.toggle('recording', session.meshServerRecord);
            Notifications.info(session.meshServerRecord
                ? (_('mesh.recording_server_on') || 'Server recording enabled — reconnecting…')
                : (_('mesh.recording_server_off') || 'Server recording disabled — reconnecting…'));
            try { session.client.disconnect(); } catch { /* ignore */ }
            wireNewClient(session);
            session.client.connect().catch((err) => setSessionStatus(session, 'error', err.message));
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
        syncMobileTouchForActive();
    });

    // Pin Toolbar toggle — keeps the expanded action pill open
    document.getElementById('btn-pin')?.addEventListener('click', function () {
        if (toolbarNotchSlot?.classList.contains('toolbar-chrome-hidden')) return;
        toolbarPinned = !toolbarPinned;
        toolbar.classList.toggle('pinned', toolbarPinned);
        this.classList.toggle('active', toolbarPinned);
        if (toolbarPinned) expandToolbar();
    });

    // ---- Compact handle: fullscreen (drawer toggle is on the handle itself) ----
    document.getElementById('btn-handle-fullscreen')?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleViewerShellFullscreen();
    });

    // ---- Back to devices — close all sessions first ----
    document.getElementById('btn-back-devices')?.addEventListener('click', (e) => {
        e.preventDefault();
        closeAllSessions();
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
        const handleIcon = document.getElementById('btn-handle-fullscreen')?.querySelector('.material-icons');
        if (handleIcon) handleIcon.textContent = fsIcon;
        // Notch is only for streaming sessions — re-sync after FS layout swap.
        syncToolbarChrome(getActiveSession());
        if (window.__fileTransferModal && typeof window.__fileTransferModal._ensureMountedInHost === 'function') {
            window.__fileTransferModal._ensureMountedInHost();
        }
        setTimeout(() => {
            const session = getActiveSession();
            if (session && session.client && session.client.renderer) session.client.renderer.resize();
        }, 100);
    });

    // Escape to show toolbar; F11 toggles viewer shell fullscreen
    document.addEventListener('keydown', (e) => {
        if (e.key === 'F11') {
            e.preventDefault();
            toggleViewerShellFullscreen();
            return;
        }
        if (e.key === 'Escape' && !document.fullscreenElement) showToolbar();
    });

    // Window resize
    window.addEventListener('resize', () => {
        const session = getActiveSession();
        if (session && session.client && session.client.renderer) session.client.renderer.resize();
    });

    // ---- Session picker (address book) ----

    let sessionPicker = null;
    let sessionPickerLoaded = false;
    const sessionPickerBackdrop = document.getElementById('session-picker-backdrop');

    function openSessionPicker() {
        if (!sessionPickerBackdrop) return;
        sessionPickerBackdrop.hidden = false;
        sessionPickerBackdrop.classList.add('open');
        if (!sessionPickerLoaded && sessionPicker) {
            sessionPicker.loadAll(false).then(() => { sessionPickerLoaded = true; });
        } else if (sessionPicker) {
            sessionPicker.renderDevices();
        }
        document.getElementById('session-picker-search')?.focus();
    }

    function closeSessionPicker() {
        if (!sessionPickerBackdrop) return;
        sessionPickerBackdrop.classList.remove('open');
        sessionPickerBackdrop.hidden = true;
    }

    function toggleSessionPicker() {
        if (sessionPickerBackdrop?.classList.contains('open')) closeSessionPicker();
        else openSessionPicker();
    }

    function initSessionPicker() {
        if (isGuestAccessMode()) {
            applyGuestUiLockdown();
            return;
        }
        if (!window.RemoteAddressBook || !document.getElementById('session-picker-panel')) return;

        sessionPicker = window.RemoteAddressBook.create({
            classPrefix: 'rd-picker',
            compact: true,
            ids: {
                sidebar: 'session-picker-sidebar',
                contentRoot: 'session-picker-content',
                foldersCustom: 'session-picker-folders-custom',
                groups: 'session-picker-groups',
                groupsEmpty: 'session-picker-groups-empty',
                tags: 'session-picker-tags',
                tagsEmpty: 'session-picker-tags-empty',
                grid: 'session-picker-grid',
                tableWrap: 'session-picker-table-wrap',
                tbody: 'session-picker-tbody',
                loading: 'session-picker-loading',
                error: 'session-picker-error',
                errorText: 'session-picker-error-text',
                empty: 'session-picker-empty',
                search: 'session-picker-search',
                sectionTitle: 'session-picker-section-title',
                deviceCount: 'session-picker-count',
                countAll: 'rd-picker-count-all',
                countUnassigned: 'rd-picker-count-unassigned',
                viewGrid: 'session-picker-view-grid',
                viewList: 'session-picker-view-list',
                refreshBtn: 'session-picker-refresh',
                retry: 'session-picker-retry',
                quickId: 'session-picker-quick-id'
            },
            getConnectedIds: function () {
                return new Set(sessions.keys());
            },
            onConnect: function (deviceId, deviceName) {
                closeSessionPicker();
                createSession(deviceId, deviceName || '');
                if (sessionPicker) sessionPicker.renderDevices();
            }
        });

        sessionPicker.bindUi(document.getElementById('session-picker-panel'));

        document.getElementById('btn-add-session')?.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleSessionPicker();
        });

        document.getElementById('session-picker-close')?.addEventListener('click', closeSessionPicker);

        document.getElementById('session-picker-quick-btn')?.addEventListener('click', () => {
            if (sessionPicker?.quickConnect('session-picker-quick-id')) {
                closeSessionPicker();
            }
        });

        document.getElementById('session-picker-quick-id')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                document.getElementById('session-picker-quick-btn')?.click();
            }
        });

        sessionPickerBackdrop?.addEventListener('click', (e) => {
            if (e.target === sessionPickerBackdrop) closeSessionPicker();
        });

        const sessionPickerPanel = document.getElementById('session-picker-panel');
        sessionPickerPanel?.addEventListener('click', (e) => e.stopPropagation());

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && sessionPickerBackdrop?.classList.contains('open')) {
                closeSessionPicker();
            }
        });
    }

    bindSlimTabBar();
    initSessionPicker();

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

    // ---- Mobile / tablet rdclient ----
    const touchHandlers = new Map();
    let mobileTouchMode = 'direct';

    function attachMobileTouch(session) {
        if (!window.RdClientMobile || !window.RdClientMobile.isMobileRdClient()) return;
        if (typeof RDTouch !== 'function' || !session.client) return;
        let touch = touchHandlers.get(session.deviceId);
        if (!touch) {
            touch = new RDTouch(session.canvas, session.client.renderer, function(msg) {
                if (session.client && session.client.input) {
                    session.client.input.sendMessage(msg);
                }
            });
            touchHandlers.set(session.deviceId, touch);
        }
        touch.setMode(mobileTouchMode);
        if (session.deviceId === activeSessionId && session.state === 'streaming' && !(session.client && session.client.viewOnly)) {
            touch.start();
        } else {
            touch.stop();
        }
    }

    function syncMobileTouchForActive() {
        if (!window.RdClientMobile || !window.RdClientMobile.isMobileRdClient()) return;
        touchHandlers.forEach(function(touch, id) {
            var session = sessions.get(id);
            if (id === activeSessionId && session && session.state === 'streaming' && !(session.client && session.client.viewOnly)) {
                touch.setMode(mobileTouchMode);
                touch.start();
            } else {
                touch.stop();
            }
        });
    }

    function resizeViewerForViewport() {
        sessions.forEach(function(session) {
            if (session.client && session.client.renderer) {
                session.client.renderer.resize();
            }
        });
    }

    function initMobileViewerBindings() {
        var kbBridge = document.getElementById('rd-keyboard-bridge');
        var specialPanel = document.getElementById('rd-special-keys-panel');

        document.getElementById('rd-mob-input-touch')?.addEventListener('click', function() {
            mobileTouchMode = 'direct';
            document.querySelectorAll('#rd-mobile-toolbar [data-mode]').forEach(function(b) {
                b.classList.toggle('active', b.dataset.mode === 'direct');
            });
            syncMobileTouchForActive();
        });

        document.getElementById('rd-mob-input-touchpad')?.addEventListener('click', function() {
            mobileTouchMode = 'touchpad';
            document.querySelectorAll('#rd-mobile-toolbar [data-mode]').forEach(function(b) {
                b.classList.toggle('active', b.dataset.mode === 'touchpad');
            });
            syncMobileTouchForActive();
        });

        document.getElementById('rd-mob-keyboard')?.addEventListener('click', function() {
            if (window.RdClientMobile) window.RdClientMobile.focusKeyboardBridge(kbBridge);
        });

        document.getElementById('rd-mob-special')?.addEventListener('click', function() {
            if (specialPanel) specialPanel.classList.toggle('open');
        });

        document.getElementById('rd-mob-cad')?.addEventListener('click', function() {
            withClient(function(c) { c.sendCtrlAltDel(); });
        });

        document.getElementById('rd-mob-fullscreen')?.addEventListener('click', function() {
            toggleViewerShellFullscreen();
        });

        specialPanel?.querySelectorAll('.rd-special-key-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var session = getActiveSession();
                if (!session || !session.client || !session.client.input) return;
                var input = session.client.input;
                var map = {
                    Meta: 'MetaLeft',
                    'Alt+Tab': 'Tab',
                    PrintScreen: 'PrintScreen',
                    Escape: 'Escape'
                };
                var code = map[btn.dataset.special];
                if (!code) return;
                var down = new KeyboardEvent('keydown', { code: code, bubbles: true, cancelable: true });
                if (btn.dataset.special === 'Alt+Tab') {
                    down = new KeyboardEvent('keydown', { code: 'Tab', altKey: true, bubbles: true, cancelable: true });
                }
                input._handleKeyDown(down);
                var up = new KeyboardEvent('keyup', { code: code, bubbles: true, cancelable: true });
                if (btn.dataset.special === 'Alt+Tab') {
                    up = new KeyboardEvent('keyup', { code: 'Tab', altKey: true, bubbles: true, cancelable: true });
                }
                input._handleKeyUp(up);
                specialPanel.classList.remove('open');
            });
        });

        if (kbBridge) {
            kbBridge.addEventListener('keydown', function(e) {
                var session = getActiveSession();
                if (!session || !session.client || !session.client.input) return;
                session.client.input._handleKeyDown(e);
            });
            kbBridge.addEventListener('keyup', function(e) {
                var session = getActiveSession();
                if (!session || !session.client || !session.client.input) return;
                session.client.input._handleKeyUp(e);
            });
        }

        if (window.RdClientMobile) {
            window.RdClientMobile.initVisualViewport(resizeViewerForViewport);
        }
    }

    var viewerInitialized = false;
    var mobileBindingsDone = false;

    function startViewerInit() {
        if (viewerInitialized) return;
        viewerInitialized = true;

        applyTransportCapabilities();
        if (!mobileBindingsDone) {
            initMobileViewerBindings();
            mobileBindingsDone = true;
        }

        const deviceId = window.__initialDeviceId;
        const deviceName = window.__initialDeviceName || '';
        const panelPref = new URLSearchParams(window.location.search).get('panel');
        if (panelPref === 'files') {
            window.__openFilePanelOnConnect = true;
        }
        if (deviceId) {
            createSession(deviceId, deviceName);
        }

        // Support opening additional sessions via URL hash: #add=DEVICE_ID
        if (window.location.hash && !isGuestAccessMode()) {
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
                    if (!isPeerAllowedForGuest(msg.deviceId)) return;
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

    function bootViewer() {
        installLifecycleHandlers();
        if (window.RdClientMobile && window.RdClientMobile.watchPhoneGate) {
            window.RdClientMobile.watchPhoneGate(startViewerInit);
        } else {
            startViewerInit();
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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootViewer);
    } else {
        bootViewer();
    }
})();
