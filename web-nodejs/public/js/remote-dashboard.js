/**
 * BetterDesk — RdClient operator dashboard (/remote)
 * Address book with folders, groups, tags — synced from server.
 */

(function () {
    'use strict';

    var REFRESH_MS = 30000;
    var refreshTimer = null;
    var addressBook = null;

    function t(key, fallback) {
        if (typeof _ === 'function') {
            var v = _(key);
            if (v && v !== key) return v;
        }
        return fallback || key;
    }

    function esc(s) {
        if (s == null) return '';
        var d = document.createElement('div');
        d.textContent = String(s);
        return d.innerHTML;
    }

    function renderBrandLogo() {
        var el = document.getElementById('rd-desk-logo');
        if (!el) return;
        var b = (window.BetterDesk && window.BetterDesk.branding) || {};
        if (b.logoType === 'text' && b.logoText) {
            el.innerHTML = '<span class="brand-text-logo">' + esc(b.logoText) +
                (b.logoTextAccent ? '<span class="brand-text-accent">' + esc(b.logoTextAccent) + '</span>' : '') +
                '</span>';
            return;
        }
        if (b.logoType === 'svg' && b.logoSvg) {
            el.innerHTML = b.logoSvg;
            return;
        }
        if (b.logoType === 'image' && b.logoUrl) {
            el.innerHTML = '<img src="' + esc(b.logoUrl) + '" alt="">';
            return;
        }
        el.innerHTML = '<span class="material-icons">' + esc(b.logoIcon || 'connected_tv') + '</span>';
    }

    function renderUser() {
        var el = document.getElementById('rd-desk-user');
        var user = window.BetterDesk && window.BetterDesk.user;
        if (el && user) el.textContent = user.username || user.name || '';
    }

    function isRdClientDesktop() {
        if (window.__BETTERDESK_RDCLIENT_DESKTOP__) return true;
        return !!(window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function');
    }

    function syncDesktopViewport() {
        var h = window.innerHeight;
        if (h < 1) return;
        document.documentElement.style.setProperty('--rd-desk-vh', h + 'px');
    }

    function ensureSidebarScroll() {
        var sidebar = document.getElementById('rd-desk-sidebar');
        if (!sidebar || document.getElementById('rd-desk-sidebar-scroll')) return;
        var scroll = document.createElement('div');
        scroll.className = 'rd-desk-sidebar-scroll';
        scroll.id = 'rd-desk-sidebar-scroll';
        while (sidebar.firstChild) {
            scroll.appendChild(sidebar.firstChild);
        }
        sidebar.appendChild(scroll);
    }

    function markDesktopLayout() {
        syncDesktopViewport();
        ensureSidebarScroll();
        if (!isRdClientDesktop()) return;
        document.documentElement.classList.add('rd-desk-desktop');
        document.body.classList.add('rd-desk-desktop');
        var app = document.getElementById('rd-desk-app');
        if (app) app.classList.add('rd-desk-desktop');
        if (!window.__rdDeskViewportBound) {
            window.__rdDeskViewportBound = true;
            window.addEventListener('resize', syncDesktopViewport);
        }
    }

    function setDevicesPanelCollapsed(collapsed) {
        var panel = document.getElementById('rd-desk-devices-panel');
        var toggle = document.getElementById('rd-desk-devices-toggle');
        if (!panel || !toggle) return;
        panel.classList.toggle('is-collapsed', collapsed);
        toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        toggle.title = collapsed
            ? t('remote_dashboard.expand_devices', 'Expand device list')
            : t('remote_dashboard.collapse_devices', 'Collapse device list');
    }

    function setNavSectionCollapsed(section, collapsed) {
        if (!section) return;
        section.classList.toggle('is-collapsed', collapsed);
        var btn = section.querySelector('.rd-desk-nav-heading-btn');
        if (btn) btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }

    function bindCollapseUi() {
        var devicesToggle = document.getElementById('rd-desk-devices-toggle');
        if (devicesToggle) {
            devicesToggle.addEventListener('click', function () {
                var panel = document.getElementById('rd-desk-devices-panel');
                var collapsed = panel && !panel.classList.contains('is-collapsed');
                setDevicesPanelCollapsed(collapsed);
                try {
                    sessionStorage.setItem('rd-desk-devices-collapsed', collapsed ? '1' : '0');
                } catch (_) { /* ignore */ }
            });
        }

        document.querySelectorAll('.rd-desk-nav-section[data-collapsible]').forEach(function (section) {
            var btn = section.querySelector('.rd-desk-nav-heading-btn');
            if (!btn) return;
            btn.addEventListener('click', function () {
                var collapsed = !section.classList.contains('is-collapsed');
                setNavSectionCollapsed(section, collapsed);
                try {
                    var key = 'rd-desk-nav-' + (section.getAttribute('data-collapsible') || 'section') + '-collapsed';
                    sessionStorage.setItem(key, collapsed ? '1' : '0');
                } catch (_) { /* ignore */ }
            });
        });

        try {
            if (sessionStorage.getItem('rd-desk-devices-collapsed') === '1') {
                setDevicesPanelCollapsed(true);
            }
            document.querySelectorAll('.rd-desk-nav-section[data-collapsible]').forEach(function (section) {
                var id = section.getAttribute('data-collapsible') || 'section';
                if (sessionStorage.getItem('rd-desk-nav-' + id + '-collapsed') === '1') {
                    setNavSectionCollapsed(section, true);
                }
            });
        } catch (_) { /* ignore */ }
    }

    function showConnectError(message) {
        var text = message || t('remote_dashboard.connect_failed', 'Could not open remote session');
        if (typeof window.showToast === 'function') {
            window.showToast(text, 'error');
            return;
        }
        window.alert(text);
    }

    function openRemoteSession(deviceId, deviceName) {
        if (window.DeviceCapabilities && window.DeviceCapabilities.isPhone()) {
            if (window.RdClientMobile && window.RdClientMobile.showPhoneUnsupportedToast) {
                window.RdClientMobile.showPhoneUnsupportedToast();
            }
            return;
        }
        if (!deviceId) return;

        if (isRdClientDesktop()) {
            window.__TAURI__.core.invoke('open_session', {
                deviceId: deviceId,
                deviceName: deviceName || ''
            }).catch(function (err) {
                console.error('RdClient desktop session failed:', err);
                showConnectError(String(err && err.message ? err.message : err));
            });
            return;
        }

        if (typeof BroadcastChannel === 'undefined') {
            window.open('/remote/' + encodeURIComponent(deviceId), '_blank');
            return;
        }

        var bc = new BroadcastChannel('betterdesk-remote');
        var handled = false;

        bc.onmessage = function (ev) {
            if (ev.data && ev.data.type === 'pong') {
                handled = true;
                bc.postMessage({ type: 'add-session', deviceId: deviceId, deviceName: deviceName || '' });
                bc.close();
            } else if (ev.data && ev.data.type === 'session-added') {
                handled = true;
                bc.close();
            }
        };

        bc.postMessage({ type: 'ping' });
        setTimeout(function () {
            if (!handled) {
                bc.close();
                window.open('/remote/' + encodeURIComponent(deviceId), '_blank');
            }
        }, 300);
    }

    function updateSyncStatus(ok) {
        var timeEl = document.getElementById('rd-desk-sync-time');
        var statusEl = document.getElementById('rd-desk-status-text');
        var dotEl = document.getElementById('rd-desk-status-dot');
        if (timeEl) {
            timeEl.textContent = t('remote_dashboard.last_sync', 'Updated') + ' ' +
                new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        }
        if (statusEl) {
            statusEl.textContent = ok
                ? t('remote_dashboard.status_ready', 'Ready')
                : t('remote_dashboard.sync_error', 'Sync error');
        }
        if (dotEl) {
            dotEl.classList.toggle('online', ok);
            dotEl.classList.toggle('offline', !ok);
        }
    }

    function initAddressBook() {
        if (!window.RemoteAddressBook) return null;

        return window.RemoteAddressBook.create({
            classPrefix: 'rd-desk',
            ids: {
                sidebar: 'rd-desk-sidebar',
                contentRoot: 'rd-desk-app',
                foldersCustom: 'rd-desk-folders-custom',
                groups: 'rd-desk-groups',
                groupsEmpty: 'rd-desk-groups-empty',
                tags: 'rd-desk-tags',
                tagsEmpty: 'rd-desk-tags-empty',
                grid: 'rd-desk-grid',
                tableWrap: 'rd-desk-table-wrap',
                tbody: 'rd-desk-tbody',
                loading: 'rd-desk-loading',
                error: 'rd-desk-error',
                errorText: 'rd-desk-error-text',
                empty: 'rd-desk-empty',
                search: 'rd-desk-search',
                sectionTitle: 'rd-desk-section-title',
                deviceCount: 'rd-desk-count',
                countAll: 'rd-count-all',
                countUnassigned: 'rd-count-unassigned',
                viewGrid: 'rd-view-grid',
                viewList: 'rd-view-list',
                refreshBtn: 'rd-desk-refresh',
                retry: 'rd-desk-retry',
                quickId: 'rd-desk-quick-id'
            },
            onConnect: openRemoteSession
        });
    }

    async function loadAll(silent) {
        if (!addressBook) return;
        var ok = await addressBook.loadAll(silent);
        updateSyncStatus(ok);
        syncDesktopViewport();
    }

    function populateLanguageSelect() {
        var sel = document.getElementById('rd-desk-lang');
        if (!sel || sel.options.length > 0) return;
        var langs = (window.BetterDesk && window.BetterDesk.availableLanguages) || [];
        langs.forEach(function (lang) {
            var opt = document.createElement('option');
            opt.value = lang.code;
            opt.textContent = lang.native || lang.name || lang.code;
            if (lang.code === (window.BetterDesk && window.BetterDesk.lang)) opt.selected = true;
            sel.appendChild(opt);
        });
    }

    function bindDesktopSettings() {
        if (!isRdClientDesktop()) return;
        var btn = document.getElementById('rd-desk-settings');
        if (!btn) return;
        btn.style.display = '';
        btn.addEventListener('click', function () {
            var invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
            if (invoke) invoke('open_settings').catch(function () { /* ignore */ });
        });
    }

    function bindQuickConnect() {
        document.getElementById('rd-desk-quick-btn')?.addEventListener('click', function () {
            addressBook?.quickConnect('rd-desk-quick-id');
        });
        document.getElementById('rd-desk-quick-id')?.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); addressBook?.quickConnect('rd-desk-quick-id'); }
        });
    }

    function startAutoRefresh() {
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = setInterval(function () { loadAll(true); }, REFRESH_MS);
    }

    var dashboardInitialized = false;

    function startDashboardInit() {
        if (dashboardInitialized) return;
        dashboardInitialized = true;
        markDesktopLayout();
        populateLanguageSelect();
        bindDesktopSettings();
        renderBrandLogo();
        renderUser();
        addressBook = initAddressBook();
        if (addressBook) {
            addressBook.bindUi(document.getElementById('rd-desk-app'));
        }
        bindQuickConnect();
        bindCollapseUi();
        loadAll(false);
        startAutoRefresh();
    }

    document.addEventListener('DOMContentLoaded', function () {
        if (window.RdClientMobile && window.RdClientMobile.watchPhoneGate) {
            window.RdClientMobile.watchPhoneGate(startDashboardInit);
        } else {
            startDashboardInit();
        }
    });

    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) loadAll(true);
    });
})();
