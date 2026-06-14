/**
 * BetterDesk — RdClient operator dashboard (/remote)
 * Address book with folders, groups, tags — synced from server.
 */

(function () {
    'use strict';

    var REFRESH_MS = 30000;
    var CARD_PALETTE = [
        '#1e3a5f', '#1a4731', '#4a1942', '#3d2914', '#1f4d4d',
        '#2d3561', '#4a3728', '#1e4620', '#5c2d42', '#2c3e50'
    ];

    var devices = [];
    var filtered = [];
    var folders = [];
    var deviceGroups = [];
    var availableTags = [];

    var currentFolder = 'all';
    var currentGroup = null;
    var selectedTag = null;
    var currentFilter = 'all';
    var searchQuery = '';
    var viewMode = 'grid';
    var lastSyncAt = null;
    var refreshTimer = null;
    var syncing = false;

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

    function normalizeTags(value) {
        if (!value) return [];
        if (Array.isArray(value)) return value.map(String).map(function (x) { return x.trim(); }).filter(Boolean);
        if (typeof value === 'string') {
            try {
                var parsed = JSON.parse(value);
                if (Array.isArray(parsed)) return parsed.map(String).map(function (x) { return x.trim(); }).filter(Boolean);
            } catch (_) {}
            return value.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
        }
        return [];
    }

    function folderIdsEqual(a, b) {
        if (a == null || a === '' || Number(a) === 0) {
            return b == null || b === '' || Number(b) === 0;
        }
        return Number(a) === Number(b);
    }

    function deviceMatchesGroup(device, group) {
        if (!device || !group) return false;
        if ((group.source_type || 'manual') === 'tag') {
            var tag = String(group.tag_filter || '').toLowerCase();
            return tag && normalizeTags(device.tags).some(function (x) { return x.toLowerCase() === tag; });
        }
        var groups = Array.isArray(device.groups) ? device.groups : [];
        return groups.some(function (g) { return g.guid === group.guid; });
    }

    function cardColorForId(id) {
        var s = String(id || '');
        var hash = 0;
        for (var i = 0; i < s.length; i++) hash = ((hash << 5) - hash) + s.charCodeAt(i);
        return CARD_PALETTE[Math.abs(hash) % CARD_PALETTE.length];
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

    function platformIcon(platform) {
        if (!platform) return 'devices';
        var p = platform.toLowerCase();
        if (p.indexOf('windows') !== -1) return 'desktop_windows';
        if (p.indexOf('mac') !== -1 || p.indexOf('darwin') !== -1) return 'desktop_mac';
        if (p.indexOf('linux') !== -1 || p.indexOf('fedora') !== -1 || p.indexOf('ubuntu') !== -1) return 'computer';
        if (p.indexOf('android') !== -1) return 'phone_android';
        if (p.indexOf('ios') !== -1) return 'phone_iphone';
        return 'devices';
    }

    function deviceStatusInfo(d) {
        if (d.banned) return { className: 'banned', label: t('status.banned', 'Banned') };
        if (d.online) return { className: 'online', label: t('status.online', 'Online') };
        if (d.no_signal) return { className: 'no_signal', label: t('status.no_signal', 'No signal') };
        return { className: 'offline', label: t('status.offline', 'Offline') };
    }

    function displayName(d) {
        return d.display_name || d.hostname || d.note || d.id || '—';
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

    function showState(state) {
        ['rd-desk-loading', 'rd-desk-error', 'rd-desk-empty', 'rd-desk-grid', 'rd-desk-table-wrap'].forEach(function (id) {
            var el = document.getElementById(id);
            if (!el) return;
            var show = (id === 'rd-desk-loading' && state === 'loading') ||
                (id === 'rd-desk-error' && state === 'error') ||
                (id === 'rd-desk-empty' && state === 'empty') ||
                (id === 'rd-desk-grid' && state === 'grid') ||
                (id === 'rd-desk-table-wrap' && state === 'list');
            el.classList.toggle('hidden', !show);
        });
    }

    function setActiveNav(navType, activeId) {
        document.querySelectorAll('.rd-desk-nav-item[data-nav="' + navType + '"]').forEach(function (el) {
            el.classList.toggle('active', activeId !== null && el.getAttribute('data-id') === String(activeId));
        });
    }

    function clearNavExcept(navType, activeId) {
        ['folder', 'group', 'tag'].forEach(function (type) {
            if (type === navType) {
                setActiveNav(type, activeId);
            } else {
                setActiveNav(type, null);
            }
        });
    }

    function updateSectionTitle() {
        var el = document.getElementById('rd-desk-section-title');
        if (!el) return;
        if (selectedTag) {
            el.textContent = selectedTag;
            return;
        }
        if (currentGroup) {
            var g = deviceGroups.find(function (x) { return x.guid === currentGroup; });
            el.textContent = g ? g.name : t('remote_dashboard.nav_groups', 'Groups');
            return;
        }
        if (currentFolder === 'unassigned') {
            el.textContent = t('remote_dashboard.unassigned', 'Unassigned');
            return;
        }
        if (currentFolder !== 'all') {
            var f = folders.find(function (x) { return folderIdsEqual(x.id, currentFolder); });
            el.textContent = f ? f.name : t('remote_dashboard.nav_folders', 'Folders');
            return;
        }
        el.textContent = t('remote_dashboard.nav_address_book', 'Address book');
    }

    function applyFilters() {
        var q = searchQuery.trim().toLowerCase();
        filtered = devices.filter(function (d) {
            if (currentFolder === 'unassigned' && d.folder_id) return false;
            if (currentFolder !== 'all' && currentFolder !== 'unassigned') {
                if (!folderIdsEqual(d.folder_id, currentFolder)) return false;
            }
            if (currentGroup) {
                var group = deviceGroups.find(function (g) { return g.guid === currentGroup; });
                if (!group || !deviceMatchesGroup(d, group)) return false;
            }
            if (selectedTag) {
                var tags = normalizeTags(d.tags).map(function (x) { return x.toLowerCase(); });
                if (tags.indexOf(selectedTag.toLowerCase()) === -1) return false;
            }
            if (currentFilter === 'online' && !d.online) return false;
            if (currentFilter === 'offline' && (d.online || d.banned)) return false;
            if (q) {
                var hay = [d.id, d.hostname, d.note, d.platform, d.os, d.display_name].filter(Boolean).join(' ').toLowerCase();
                if (hay.indexOf(q) === -1) return false;
            }
            return true;
        });
        filtered.sort(function (a, b) {
            if (a.online !== b.online) return a.online ? -1 : 1;
            var ta = a.last_online ? new Date(a.last_online).getTime() : 0;
            var tb = b.last_online ? new Date(b.last_online).getTime() : 0;
            return tb - ta;
        });
    }

    function updateCounts() {
        var allEl = document.getElementById('rd-count-all');
        var unEl = document.getElementById('rd-count-unassigned');
        if (allEl) allEl.textContent = String(devices.length);
        if (unEl) unEl.textContent = String(devices.filter(function (d) { return !d.folder_id; }).length);

        folders.forEach(function (folder) {
            var btn = document.querySelector('.rd-desk-nav-item[data-nav="folder"][data-id="' + folder.id + '"] .rd-desk-nav-count');
            if (btn) {
                btn.textContent = String(devices.filter(function (d) { return folderIdsEqual(d.folder_id, folder.id); }).length);
            }
        });

        deviceGroups.forEach(function (group) {
            var btn = document.querySelector('.rd-desk-nav-item[data-nav="group"][data-id="' + group.guid + '"] .rd-desk-nav-count');
            if (btn) {
                var count = devices.filter(function (d) { return deviceMatchesGroup(d, group); }).length;
                btn.textContent = String(count);
            }
        });

        availableTags.forEach(function (tag) {
            document.querySelectorAll('.rd-desk-nav-item[data-nav="tag"]').forEach(function (el) {
                if (el.getAttribute('data-id') === tag) {
                    var countEl = el.querySelector('.rd-desk-nav-count');
                    if (countEl) countEl.textContent = String(tagDeviceCount(tag));
                }
            });
        });

        var countEl = document.getElementById('rd-desk-count');
        if (countEl) {
            var tpl = t('remote_dashboard.devices_count', '{count} devices');
            countEl.textContent = tpl.replace('{count}', String(filtered.length));
        }
    }

    function renderFolders() {
        var container = document.getElementById('rd-desk-folders-custom');
        if (!container) return;
        container.innerHTML = folders.map(function (folder) {
            var color = (Utils.sanitizeColor || function (c) { return c || '#58a6ff'; })(folder.color);
            var active = folderIdsEqual(currentFolder, folder.id) ? ' active' : '';
            return '<li><button type="button" class="rd-desk-nav-item' + active + '" data-nav="folder" data-id="' + esc(folder.id) + '">' +
                '<span class="material-icons" style="color:' + esc(color) + '">folder</span>' +
                '<span class="rd-desk-nav-label">' + esc(folder.name) + '</span>' +
                '<span class="rd-desk-nav-count">' + (folder.device_count || 0) + '</span>' +
                '</button></li>';
        }).join('');
    }

    function renderGroups() {
        var container = document.getElementById('rd-desk-groups');
        var emptyEl = document.getElementById('rd-desk-groups-empty');
        if (!container) return;

        var items = deviceGroups.map(function (group) {
            var isDynamic = (group.source_type || 'manual') === 'tag';
            var active = currentGroup === group.guid ? ' active' : '';
            return '<li><button type="button" class="rd-desk-nav-item' + active + '" data-nav="group" data-id="' + esc(group.guid) + '">' +
                '<span class="material-icons">' + (isDynamic ? 'sell' : 'hub') + '</span>' +
                '<span class="rd-desk-nav-label">' + esc(group.name) + '</span>' +
                '<span class="rd-desk-nav-count">' + (group.member_count || 0) + '</span>' +
                '</button></li>';
        }).join('');

        if (emptyEl) emptyEl.classList.toggle('hidden', deviceGroups.length > 0);
        container.querySelectorAll('li:not(#rd-desk-groups-empty)').forEach(function (li) { li.remove(); });
        container.insertAdjacentHTML('beforeend', items);
    }

    function tagDeviceCount(tag) {
        var lower = tag.toLowerCase();
        return devices.filter(function (d) {
            return normalizeTags(d.tags).some(function (x) { return x.toLowerCase() === lower; });
        }).length;
    }

    function renderTags() {
        var container = document.getElementById('rd-desk-tags');
        var emptyEl = document.getElementById('rd-desk-tags-empty');
        if (!container) return;

        var items = availableTags.map(function (tag) {
            var active = selectedTag === tag ? ' active' : '';
            return '<li><button type="button" class="rd-desk-nav-item rd-desk-tag-item' + active + '" data-nav="tag" data-id="' + esc(tag) + '">' +
                '<span class="rd-desk-tag-dot"></span>' +
                '<span class="rd-desk-nav-label">' + esc(tag) + '</span>' +
                '<span class="rd-desk-nav-count">' + tagDeviceCount(tag) + '</span>' +
                '</button></li>';
        }).join('');

        if (emptyEl) emptyEl.classList.toggle('hidden', availableTags.length > 0);
        container.querySelectorAll('li:not(#rd-desk-tags-empty)').forEach(function (li) { li.remove(); });
        container.insertAdjacentHTML('beforeend', items);
    }

    function renderGrid() {
        var grid = document.getElementById('rd-desk-grid');
        if (!grid) return;

        grid.innerHTML = filtered.map(function (d) {
            var st = deviceStatusInfo(d);
            var name = displayName(d);
            var platform = d.platform || d.os || '';
            var canConnect = d.online && !d.banned;
            var tags = normalizeTags(d.tags);
            var bg = cardColorForId(d.id);

            return '<article class="rd-desk-card' + (canConnect ? '' : ' rd-desk-card-disabled') + '" style="--rd-card-bg:' + bg + '" data-id="' + esc(d.id) + '">' +
                '<div class="rd-desk-card-top">' +
                '<span class="material-icons rd-desk-card-os">' + platformIcon(platform) + '</span>' +
                '</div>' +
                '<div class="rd-desk-card-body">' +
                '<div class="rd-desk-card-name" title="' + esc(name) + '">' + esc(name) + '</div>' +
                (tags.length ? '<div class="rd-desk-card-tags">' + tags.slice(0, 2).map(function (tag) {
                    return '<span class="rd-desk-card-tag">' + esc(tag) + '</span>';
                }).join('') + '</div>' : '') +
                '</div>' +
                '<div class="rd-desk-card-footer">' +
                '<span class="rd-desk-status-dot ' + st.className + '" title="' + esc(st.label) + '"></span>' +
                '<span class="rd-desk-card-id">' + esc(d.id) + '</span>' +
                (canConnect
                    ? '<button type="button" class="rd-desk-card-connect" data-id="' + esc(d.id) + '" data-name="' + esc(name) + '" title="' + esc(t('remote_dashboard.connect', 'Connect')) + '">' +
                      '<span class="material-icons">play_arrow</span></button>'
                    : '') +
                '</div>' +
                '</article>';
        }).join('');

        grid.querySelectorAll('.rd-desk-card-connect').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                openRemoteSession(btn.getAttribute('data-id'), btn.getAttribute('data-name'));
            });
        });
        grid.querySelectorAll('.rd-desk-card:not(.rd-desk-card-disabled)').forEach(function (card) {
            card.addEventListener('dblclick', function () {
                openRemoteSession(card.getAttribute('data-id'), displayName({ id: card.getAttribute('data-id') }));
            });
        });
    }

    function renderList() {
        var tbody = document.getElementById('rd-desk-tbody');
        if (!tbody) return;

        tbody.innerHTML = filtered.map(function (d) {
            var st = deviceStatusInfo(d);
            var hostname = displayName(d);
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
                '</td></tr>';
        }).join('');

        tbody.querySelectorAll('.rd-desk-connect').forEach(function (btn) {
            btn.addEventListener('click', function () {
                openRemoteSession(btn.getAttribute('data-id'), btn.getAttribute('data-name'));
            });
        });
    }

    function renderDevices() {
        applyFilters();
        updateCounts();
        updateSectionTitle();

        if (filtered.length === 0) {
            showState('empty');
            return;
        }

        if (viewMode === 'list') {
            renderList();
            showState('list');
        } else {
            renderGrid();
            showState('grid');
        }
    }

    function isRdClientDesktop() {
        return !!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke);
    }

    function openRemoteSession(deviceId, deviceName) {
        if (!deviceId) return;

        if (isRdClientDesktop()) {
            window.__TAURI__.core.invoke('open_session', {
                deviceId: deviceId,
                deviceName: deviceName || ''
            }).catch(function (err) {
                console.error('RdClient desktop session failed:', err);
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

    function quickConnect() {
        var input = document.getElementById('rd-desk-quick-id');
        if (!input) return;
        var id = (input.value || '').trim().replace(/\s/g, '');
        if (!id || !/^[A-Za-z0-9_-]{3,64}$/.test(id)) {
            input.focus();
            input.classList.add('rd-desk-input-error');
            setTimeout(function () { input.classList.remove('rd-desk-input-error'); }, 1200);
            return;
        }
        openRemoteSession(id, id);
    }

    function updateSyncStatus(ok) {
        lastSyncAt = new Date();
        var timeEl = document.getElementById('rd-desk-sync-time');
        var statusEl = document.getElementById('rd-desk-status-text');
        var dotEl = document.getElementById('rd-desk-status-dot');
        if (timeEl) {
            timeEl.textContent = t('remote_dashboard.last_sync', 'Updated') + ' ' +
                lastSyncAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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

    async function loadAll(silent) {
        if (syncing) return;
        syncing = true;
        if (!silent) showState('loading');

        var refreshBtn = document.getElementById('rd-desk-refresh');
        if (refreshBtn) refreshBtn.classList.add('rd-desk-spinning');

        try {
            var results = await Promise.all([
                Utils.api('/api/devices'),
                Utils.api('/api/folders').catch(function () { return { folders: [] }; }),
                Utils.api('/api/device-groups').catch(function () { return { groups: [] }; }),
                Utils.api('/api/tags').catch(function () { return { tags: [] }; })
            ]);

            devices = results[0].devices || [];
            folders = results[1].folders || [];
            deviceGroups = results[2].groups || [];
            availableTags = results[3].tags || [];

            renderFolders();
            renderGroups();
            renderTags();
            renderDevices();
            updateSyncStatus(true);
        } catch (err) {
            if (!silent) {
                var errorText = document.getElementById('rd-desk-error-text');
                if (errorText) {
                    errorText.textContent = err.message || t('remote_dashboard.error_load', 'Failed to load devices');
                }
                showState('error');
            }
            updateSyncStatus(false);
        } finally {
            syncing = false;
            if (refreshBtn) refreshBtn.classList.remove('rd-desk-spinning');
        }
    }

    function selectFolder(folderId) {
        currentFolder = folderId;
        currentGroup = null;
        selectedTag = null;
        clearNavExcept('folder', folderId);
        renderDevices();
    }

    function selectGroup(groupId) {
        currentGroup = groupId;
        currentFolder = 'all';
        selectedTag = null;
        clearNavExcept('group', groupId);
        renderDevices();
    }

    function selectTag(tag) {
        if (selectedTag === tag) {
            selectedTag = null;
            clearNavExcept('folder', 'all');
            currentFolder = 'all';
        } else {
            selectedTag = tag;
            currentGroup = null;
            currentFolder = 'all';
            clearNavExcept('tag', tag);
        }
        renderDevices();
    }

    function bindUi() {
        var search = document.getElementById('rd-desk-search');
        if (search) {
            search.addEventListener('input', function () {
                searchQuery = search.value;
                renderDevices();
            });
        }

        document.querySelectorAll('.rd-desk-filter').forEach(function (btn) {
            btn.addEventListener('click', function () {
                document.querySelectorAll('.rd-desk-filter').forEach(function (b) { b.classList.remove('active'); });
                btn.classList.add('active');
                currentFilter = btn.getAttribute('data-filter') || 'all';
                renderDevices();
            });
        });

        document.getElementById('rd-desk-sidebar')?.addEventListener('click', function (e) {
            var btn = e.target.closest('.rd-desk-nav-item');
            if (!btn) return;
            var nav = btn.getAttribute('data-nav');
            var id = btn.getAttribute('data-id');
            if (nav === 'folder') selectFolder(id);
            else if (nav === 'group') selectGroup(id);
            else if (nav === 'tag') selectTag(id);
        });

        document.getElementById('rd-desk-retry')?.addEventListener('click', function () { loadAll(false); });
        document.getElementById('rd-desk-refresh')?.addEventListener('click', function () { loadAll(false); });

        document.getElementById('rd-desk-quick-btn')?.addEventListener('click', quickConnect);
        document.getElementById('rd-desk-quick-id')?.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); quickConnect(); }
        });

        var gridBtn = document.getElementById('rd-view-grid');
        var listBtn = document.getElementById('rd-view-list');
        if (gridBtn && listBtn) {
            gridBtn.addEventListener('click', function () {
                viewMode = 'grid';
                gridBtn.classList.add('active');
                listBtn.classList.remove('active');
                renderDevices();
            });
            listBtn.addEventListener('click', function () {
                viewMode = 'list';
                listBtn.classList.add('active');
                gridBtn.classList.remove('active');
                renderDevices();
            });
        }
    }

    function startAutoRefresh() {
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = setInterval(function () { loadAll(true); }, REFRESH_MS);
    }

    document.addEventListener('DOMContentLoaded', function () {
        renderBrandLogo();
        renderUser();
        bindUi();
        loadAll(false);
        startAutoRefresh();
    });

    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) loadAll(true);
    });
})();
