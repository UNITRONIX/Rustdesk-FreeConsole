/**
 * BetterDesk — RdClient operator dashboard (/remote)
 */

(function () {
    'use strict';

    var devices = [];
    var filtered = [];
    var currentFilter = 'all';
    var searchQuery = '';

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

    function deviceTypeIcon(type) {
        switch ((type || '').toLowerCase()) {
            case 'betterdesk':
            case 'desktop': return 'desktop_windows';
            case 'scada': return 'precision_manufacturing';
            case 'iot': return 'sensors';
            case 'os_agent': return 'terminal';
            case 'mobile': return 'phone_android';
            case 'rustdesk': return 'connected_tv';
            default: return 'devices';
        }
    }

    function deviceStatusInfo(d) {
        if (d.banned) {
            return { className: 'banned', label: t('status.banned', 'Banned') };
        }
        if (d.online) {
            return { className: 'online', label: t('status.online', 'Online') };
        }
        if (d.no_signal) {
            return { className: 'no_signal', label: t('status.no_signal', 'No signal') };
        }
        return { className: 'offline', label: t('status.offline', 'Offline') };
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
        if (el && user) {
            el.textContent = user.username || user.name || '';
        }
    }

    function showState(state) {
        var loading = document.getElementById('rd-desk-loading');
        var error = document.getElementById('rd-desk-error');
        var empty = document.getElementById('rd-desk-empty');
        var table = document.getElementById('rd-desk-table-wrap');
        if (loading) loading.classList.toggle('hidden', state !== 'loading');
        if (error) error.classList.toggle('hidden', state !== 'error');
        if (empty) empty.classList.toggle('hidden', state !== 'empty');
        if (table) table.classList.toggle('hidden', state !== 'table');
    }

    function applyFilters() {
        var q = searchQuery.trim().toLowerCase();
        filtered = devices.filter(function (d) {
            if (currentFilter === 'online' && !d.online) return false;
            if (currentFilter === 'offline' && d.online) return false;
            if (!q) return true;
            var hay = [
                d.id,
                d.hostname,
                d.note,
                d.platform,
                d.os
            ].filter(Boolean).join(' ').toLowerCase();
            return hay.indexOf(q) !== -1;
        });
        filtered.sort(function (a, b) {
            if (a.online !== b.online) return a.online ? -1 : 1;
            var ta = a.last_online ? new Date(a.last_online).getTime() : 0;
            var tb = b.last_online ? new Date(b.last_online).getTime() : 0;
            return tb - ta;
        });
    }

    function updateCount() {
        var el = document.getElementById('rd-desk-count');
        if (!el) return;
        var tpl = t('remote_dashboard.devices_count', '{count} devices');
        el.textContent = tpl.replace('{count}', String(filtered.length));
    }

    function renderTable() {
        applyFilters();
        updateCount();
        var tbody = document.getElementById('rd-desk-tbody');
        if (!tbody) return;

        if (filtered.length === 0) {
            tbody.innerHTML = '';
            showState('empty');
            return;
        }

        showState('table');
        tbody.innerHTML = filtered.map(function (d) {
            var st = deviceStatusInfo(d);
            var hostname = d.hostname || d.note || '—';
            var platform = d.platform || d.os || '—';
            var last = d.online
                ? t('status.online', 'Online')
                : (window.Utils && Utils.formatRelativeTime
                    ? Utils.formatRelativeTime(d.last_online)
                    : (d.last_online || '—'));
            var canConnect = d.online && !d.banned;

            return '<tr data-id="' + esc(d.id) + '">' +
                '<td><span class="rd-desk-status">' +
                '<span class="rd-desk-status-dot ' + st.className + '"></span>' +
                esc(st.label) + '</span></td>' +
                '<td><span class="rd-desk-device-id">' + esc(d.id) + '</span></td>' +
                '<td><div class="rd-desk-host-cell">' +
                '<span class="material-icons">' + deviceTypeIcon(d.device_type) + '</span>' +
                '<span class="rd-desk-hostname" title="' + esc(hostname) + '">' + esc(hostname) + '</span>' +
                '</div></td>' +
                '<td class="rd-desk-platform">' + esc(platform) + '</td>' +
                '<td class="rd-desk-last">' + esc(last) + '</td>' +
                '<td>' +
                (canConnect
                    ? '<button type="button" class="rd-desk-btn rd-desk-btn-sm rd-desk-connect" data-id="' + esc(d.id) + '" data-name="' + esc(hostname) + '">' +
                      '<span class="material-icons">play_arrow</span>' + esc(t('remote_dashboard.connect', 'Connect')) +
                      '</button>'
                    : '<button type="button" class="rd-desk-btn rd-desk-btn-sm rd-desk-btn-ghost" disabled>' +
                      esc(t('remote_dashboard.connect', 'Connect')) + '</button>') +
                '</td>' +
                '</tr>';
        }).join('');

        tbody.querySelectorAll('.rd-desk-connect').forEach(function (btn) {
            btn.addEventListener('click', function () {
                openRemoteSession(btn.getAttribute('data-id'), btn.getAttribute('data-name'));
            });
        });
    }

    function openRemoteSession(deviceId, deviceName) {
        if (!deviceId) return;
        if (typeof BroadcastChannel === 'undefined') {
            window.open('/remote/' + encodeURIComponent(deviceId), '_blank');
            return;
        }

        var bc = new BroadcastChannel('betterdesk-remote');
        var handled = false;

        bc.onmessage = function (ev) {
            if (ev.data && ev.data.type === 'pong') {
                handled = true;
                bc.postMessage({
                    type: 'add-session',
                    deviceId: deviceId,
                    deviceName: deviceName || ''
                });
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

    async function loadDevices() {
        showState('loading');
        var errorText = document.getElementById('rd-desk-error-text');
        try {
            var response = await Utils.api('/api/devices');
            devices = (response && response.data && response.data.devices) || [];
            renderTable();
        } catch (err) {
            if (errorText) {
                errorText.textContent = err.message || t('remote_dashboard.error_load', 'Failed to load devices');
            }
            showState('error');
        }
    }

    function bindUi() {
        var search = document.getElementById('rd-desk-search');
        if (search) {
            search.addEventListener('input', function () {
                searchQuery = search.value;
                renderTable();
            });
        }

        document.querySelectorAll('.rd-desk-filter').forEach(function (btn) {
            btn.addEventListener('click', function () {
                document.querySelectorAll('.rd-desk-filter').forEach(function (b) {
                    b.classList.remove('active');
                });
                btn.classList.add('active');
                currentFilter = btn.getAttribute('data-filter') || 'all';
                renderTable();
            });
        });

        var retry = document.getElementById('rd-desk-retry');
        if (retry) {
            retry.addEventListener('click', loadDevices);
        }
    }

    document.addEventListener('DOMContentLoaded', function () {
        renderBrandLogo();
        renderUser();
        bindUi();
        loadDevices();
    });
})();
