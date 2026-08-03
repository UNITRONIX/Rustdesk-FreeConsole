/**
 * Native OS file drag-and-drop bridge for RdClient desktop (Tauri tauri://drag-drop).
 * HTML5 DataTransfer drops in WebView2 do not expose reliable paths or bytes.
 */
(function () {
    'use strict';

    function isDesktopBridge() {
        return window.__BETTERDESK_RDCLIENT_DESKTOP__ === true
            && window.__TAURI__
            && window.__TAURI__.core
            && typeof window.__TAURI__.core.invoke === 'function';
    }

    function desktopInvoke(cmd, args) {
        return window.__TAURI__.core.invoke(cmd, args || {});
    }

    function normalizePaths(paths) {
        if (!paths || !paths.length) return [];
        var out = [];
        for (var i = 0; i < paths.length; i++) {
            var p = paths[i];
            if (typeof p === 'string' && p.trim()) out.push(p.trim());
        }
        return out;
    }

    function debugLog() {
        if (window.BetterDesk && window.BetterDesk.debugRelay) {
            console.log.apply(console, ['[RDDesktopDnd]'].concat(Array.prototype.slice.call(arguments)));
        }
    }

    function emitNativeDrop(paths, position) {
        debugLog('tauri://drag-drop payload paths=', paths);
        if (!paths.length) return;
        window.dispatchEvent(new CustomEvent('rd-desk-native-drop', {
            detail: { paths: paths, position: position || null }
        }));
    }

    function payloadPaths(payload) {
        if (!payload) return [];
        return normalizePaths(payload.paths || payload.Paths);
    }

    /**
     * Register tauri://drag-drop here (not only in the init script) so __TAURI__
     * is guaranteed to exist when viewer scripts load.
     */
    function installNativeDropListener() {
        if (!isDesktopBridge() || window.__rdDeskNativeDropTauriBound) return false;
        var ev = window.__TAURI__.event;
        if (!ev || typeof ev.listen !== 'function') return false;

        window.__rdDeskNativeDropTauriBound = true;
        ev.listen('tauri://drag-drop', function (e) {
            debugLog('tauri://drag-drop event received', e);
            emitNativeDrop(payloadPaths(e && e.payload), e && e.payload && e.payload.position);
        }).then(function () {
            debugLog('tauri://drag-drop listener registered');
        }).catch(function (err) {
            window.__rdDeskNativeDropTauriBound = false;
            console.warn('[RDDesktopDnd] drag-drop listen failed:', err);
        });
        return true;
    }

    function ensureNativeDropListener() {
        if (installNativeDropListener()) return;
        if (window.__rdDeskNativeDropRetryTimer) return;
        var attempts = 0;
        window.__rdDeskNativeDropRetryTimer = setInterval(function () {
            attempts += 1;
            if (installNativeDropListener() || attempts >= 40) {
                clearInterval(window.__rdDeskNativeDropRetryTimer);
                window.__rdDeskNativeDropRetryTimer = null;
            }
        }, 250);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ensureNativeDropListener, { once: true });
    } else {
        ensureNativeDropListener();
    }

    // eslint-disable-next-line no-unused-vars
    var RDDesktopDnd = {
        isSupported: isDesktopBridge,
        ensureNativeDropListener: ensureNativeDropListener,

        /**
         * Open dropped/picked paths as native upload file handles.
         * @param {string[]} paths
         * @returns {Promise<Object[]>}
         */
        openPaths: function (paths) {
            var list = normalizePaths(paths);
            if (!list.length || !isDesktopBridge()) return Promise.resolve([]);
            return desktopInvoke('desktop_open_paths', { paths: list }).then(function (infos) {
                if (typeof LocalFiles === 'undefined' || !LocalFiles.createNativeUploadFile) {
                    return infos || [];
                }
                return (infos || []).map(LocalFiles.createNativeUploadFile).filter(Boolean);
            });
        },

        /**
         * Wire native drop events into cliprdr + optional upload callback.
         * @param {Object} opts
         * @param {Function} [opts.onCliprdrSync] - (paths) => void
         * @param {Function} [opts.onUploadPaths] - (paths) => void
         */
        bind: function (opts) {
            if (!isDesktopBridge()) {
                debugLog('bind() skipped — isDesktopBridge() is false');
                return;
            }
            if (window.__rdDeskNativeDropListener) return;
            ensureNativeDropListener();
            window.__rdDeskNativeDropListener = true;
            window.addEventListener('rd-desk-native-drop', function (e) {
                var paths = normalizePaths(e && e.detail && e.detail.paths);
                debugLog('rd-desk-native-drop received, paths=', paths);
                if (!paths.length) return;
                if (opts && typeof opts.onCliprdrSync === 'function') {
                    opts.onCliprdrSync(paths);
                }
                if (opts && typeof opts.onUploadPaths === 'function') {
                    opts.onUploadPaths(paths);
                }
            });
        }
    };

    window.RDDesktopDnd = RDDesktopDnd;
})();
