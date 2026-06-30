/**
 * BetterDesk — shared address book logic for /remote dashboard and session picker.
 */
(function (global) {
    'use strict';

    var CARD_PALETTE = [
        '#1e3a5f', '#1a4731', '#4a1942', '#3d2914', '#1f4d4d',
        '#2d3561', '#4a3728', '#1e4620', '#5c2d42', '#2c3e50'
    ];

    function t(key, fallback) {
        if (typeof global.t === 'function') {
            var v = global.t(key);
            if (v && v !== key) return v;
        }
        if (typeof global._ === 'function') {
            var w = global._(key);
            if (w && w !== key) return w;
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
            } catch (_) { /* ignore */ }
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

    /**
     * @param {object} options
     * @param {object} options.ids - DOM element ids
     * @param {function} [options.onConnect] - (deviceId, deviceName) => void
     * @param {function} [options.getConnectedIds] - () => Set|string[]
     * @param {boolean} [options.compact] - smaller cards for session picker overlay
     * @param {string} [options.classPrefix] - CSS class prefix (rd-desk or rd-ab)
     */
    function createAddressBook(options) {
        options = options || {};
        var ids = options.ids || {};
        var onConnect = options.onConnect || function () {};
        var getConnectedIds = options.getConnectedIds || function () { return new Set(); };
        var compact = !!options.compact;
        var cp = options.classPrefix || 'rd-ab';
        function c(suffix) { return cp + suffix; }

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
        var syncing = false;

        function el(id) {
            return id ? document.getElementById(id) : null;
        }

        function isConnected(deviceId) {
            var idsSet = getConnectedIds();
            if (idsSet instanceof Set) return idsSet.has(deviceId);
            if (Array.isArray(idsSet)) return idsSet.indexOf(deviceId) !== -1;
            return false;
        }

        function showState(state) {
            ['loading', 'error', 'empty', 'grid', 'list'].forEach(function (st) {
                var map = {
                    loading: ids.loading,
                    error: ids.error,
                    empty: ids.empty,
                    grid: ids.grid,
                    list: ids.tableWrap
                };
                var node = el(map[st]);
                if (!node) return;
                node.classList.toggle('hidden', state !== st);
            });
        }

        function setActiveNav(navType, activeId) {
            var sidebar = el(ids.sidebar);
            if (!sidebar) return;
            sidebar.querySelectorAll('.' + c('-nav-item') + '[data-nav="' + navType + '"]').forEach(function (node) {
                node.classList.toggle('active', activeId !== null && node.getAttribute('data-id') === String(activeId));
            });
        }

        function clearNavExcept(navType, activeId) {
            ['folder', 'group', 'tag'].forEach(function (type) {
                if (type === navType) setActiveNav(type, activeId);
                else setActiveNav(type, null);
            });
        }

        function updateSectionTitle() {
            var titleEl = el(ids.sectionTitle);
            if (!titleEl) return;
            if (selectedTag) {
                titleEl.textContent = selectedTag;
                return;
            }
            if (currentGroup) {
                var g = deviceGroups.find(function (x) { return x.guid === currentGroup; });
                titleEl.textContent = g ? g.name : t('remote_dashboard.nav_groups', 'Groups');
                return;
            }
            if (currentFolder === 'unassigned') {
                titleEl.textContent = t('remote_dashboard.unassigned', 'Unassigned');
                return;
            }
            if (currentFolder !== 'all') {
                var f = folders.find(function (x) { return folderIdsEqual(x.id, currentFolder); });
                titleEl.textContent = f ? f.name : t('remote_dashboard.nav_folders', 'Folders');
                return;
            }
            titleEl.textContent = t('remote_dashboard.nav_address_book', 'Address book');
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

        function tagDeviceCount(tag) {
            var lower = tag.toLowerCase();
            return devices.filter(function (d) {
                return normalizeTags(d.tags).some(function (x) { return x.toLowerCase() === lower; });
            }).length;
        }

        function updateCounts() {
            var allEl = el(ids.countAll);
            var unEl = el(ids.countUnassigned);
            if (allEl) allEl.textContent = String(devices.length);
            if (unEl) unEl.textContent = String(devices.filter(function (d) { return !d.folder_id; }).length);

            folders.forEach(function (folder) {
                var btn = document.querySelector('#' + ids.sidebar + ' .' + c('-nav-item') + '[data-nav="folder"][data-id="' + folder.id + '"] .' + c('-nav-count'));
                if (btn) {
                    btn.textContent = String(devices.filter(function (d) { return folderIdsEqual(d.folder_id, folder.id); }).length);
                }
            });

            deviceGroups.forEach(function (group) {
                var btn = document.querySelector('#' + ids.sidebar + ' .' + c('-nav-item') + '[data-nav="group"][data-id="' + group.guid + '"] .' + c('-nav-count'));
                if (btn) {
                    btn.textContent = String(devices.filter(function (d) { return deviceMatchesGroup(d, group); }).length);
                }
            });

            availableTags.forEach(function (tag) {
                document.querySelectorAll('#' + ids.sidebar + ' .' + c('-nav-item') + '[data-nav="tag"]').forEach(function (node) {
                    if (node.getAttribute('data-id') === tag) {
                        var countEl = node.querySelector('.' + c('-nav-count'));
                        if (countEl) countEl.textContent = String(tagDeviceCount(tag));
                    }
                });
            });

            var countEl = el(ids.deviceCount);
            if (countEl) {
                var tpl = t('remote_dashboard.devices_count', '{count} devices');
                countEl.textContent = tpl.replace('{count}', String(filtered.length));
            }
        }

        function renderFolders() {
            var container = el(ids.foldersCustom);
            if (!container) return;
            container.innerHTML = folders.map(function (folder) {
                var color = (global.Utils && global.Utils.sanitizeColor
                    ? global.Utils.sanitizeColor(folder.color)
                    : (folder.color || '#58a6ff'));
                var active = folderIdsEqual(currentFolder, folder.id) ? ' active' : '';
                return '<li><button type="button" class="' + c('-nav-item') + active + '" data-nav="folder" data-id="' + esc(folder.id) + '">' +
                    '<span class="material-icons" style="color:' + esc(color) + '">folder</span>' +
                    '<span class="' + c('-nav-label') + '">' + esc(folder.name) + '</span>' +
                    '<span class="' + c('-nav-count') + '">' + (folder.device_count || 0) + '</span>' +
                    '</button></li>';
            }).join('');
        }

        function renderGroups() {
            var container = el(ids.groups);
            var emptyEl = el(ids.groupsEmpty);
            if (!container) return;

            var items = deviceGroups.map(function (group) {
                var isDynamic = (group.source_type || 'manual') === 'tag';
                var active = currentGroup === group.guid ? ' active' : '';
                return '<li><button type="button" class="' + c('-nav-item') + active + '" data-nav="group" data-id="' + esc(group.guid) + '">' +
                    '<span class="material-icons">' + (isDynamic ? 'sell' : 'hub') + '</span>' +
                    '<span class="' + c('-nav-label') + '">' + esc(group.name) + '</span>' +
                    '<span class="' + c('-nav-count') + '">' + (group.member_count || 0) + '</span>' +
                    '</button></li>';
            }).join('');

            if (emptyEl) emptyEl.classList.toggle('hidden', deviceGroups.length > 0);
            container.querySelectorAll('li:not([data-static])').forEach(function (li) { li.remove(); });
            container.insertAdjacentHTML('beforeend', items);
        }

        function renderTags() {
            var container = el(ids.tags);
            var emptyEl = el(ids.tagsEmpty);
            if (!container) return;

            var items = availableTags.map(function (tag) {
                var active = selectedTag === tag ? ' active' : '';
                return '<li><button type="button" class="' + c('-nav-item') + ' ' + c('-tag-item') + active + '" data-nav="tag" data-id="' + esc(tag) + '">' +
                    '<span class="' + c('-tag-dot') + '"></span>' +
                    '<span class="' + c('-nav-label') + '">' + esc(tag) + '</span>' +
                    '<span class="' + c('-nav-count') + '">' + tagDeviceCount(tag) + '</span>' +
                    '</button></li>';
            }).join('');

            if (emptyEl) emptyEl.classList.toggle('hidden', availableTags.length > 0);
            container.querySelectorAll('li:not([data-static])').forEach(function (li) { li.remove(); });
            container.insertAdjacentHTML('beforeend', items);
        }

        function connectButtonHtml(d, name, canConnect) {
            var connected = isConnected(d.id);
            if (connected) {
                return '<span class="' + c('-connected-badge') + '" title="' + esc(t('remote.session_picker.already_connected', 'Already connected')) + '">' +
                    '<span class="material-icons">link</span></span>';
            }
            if (!canConnect) return '';
            return '<button type="button" class="' + c('-card-connect') + '" data-id="' + esc(d.id) + '" data-name="' + esc(name) + '" title="' +
                esc(t('remote_dashboard.connect', 'Connect')) + '">' +
                '<span class="material-icons">play_arrow</span></button>';
        }

        function renderGrid() {
            var grid = el(ids.grid);
            if (!grid) return;
            var cardClass = compact ? (c('-card') + ' ' + c('-card-compact')) : c('-card');

            grid.innerHTML = filtered.map(function (d) {
                var st = deviceStatusInfo(d);
                var name = displayName(d);
                var platform = d.platform || d.os || '';
                var canConnect = !d.banned && !isConnected(d.id);
                var isOffline = !d.online;
                var tags = normalizeTags(d.tags);
                var bg = cardColorForId(d.id);
                var connected = isConnected(d.id);

                return '<article class="' + cardClass +
                    (isOffline ? ' ' + c('-card-offline') : '') +
                    (canConnect && !connected ? '' : ' ' + c('-card-disabled')) +
                    (connected ? ' ' + c('-card-connected') : '') +
                    '" style="--rd-card-bg:' + bg + '" data-id="' + esc(d.id) + '">' +
                    '<div class="' + c('-card-top') + '">' +
                    '<span class="material-icons ' + c('-card-os') + '">' + platformIcon(platform) + '</span>' +
                    '</div>' +
                    '<div class="' + c('-card-body') + '">' +
                    '<div class="' + c('-card-name') + '" title="' + esc(name) + '">' + esc(name) + '</div>' +
                    (tags.length ? '<div class="' + c('-card-tags') + '">' + tags.slice(0, 2).map(function (tag) {
                        return '<span class="' + c('-card-tag') + '">' + esc(tag) + '</span>';
                    }).join('') + '</div>' : '') +
                    '</div>' +
                    '<div class="' + c('-card-footer') + '">' +
                    '<span class="' + c('-status-dot') + ' ' + st.className + '" title="' + esc(st.label) + '"></span>' +
                    '<span class="' + c('-card-id') + '">' + esc(d.id) + '</span>' +
                    connectButtonHtml(d, name, !d.banned) +
                    '</div>' +
                    '</article>';
            }).join('');
        }

        function renderList() {
            var tbody = el(ids.tbody);
            if (!tbody) return;

            tbody.innerHTML = filtered.map(function (d) {
                var st = deviceStatusInfo(d);
                var hostname = displayName(d);
                var platform = d.platform || d.os || '—';
                var last = d.online
                    ? t('status.online', 'Online')
                    : (global.Utils && global.Utils.formatRelativeTime
                        ? global.Utils.formatRelativeTime(d.last_online)
                        : (d.last_online || '—'));
                var canConnect = !d.banned && !isConnected(d.id);
                var isOffline = !d.online;
                var connected = isConnected(d.id);

                return '<tr data-id="' + esc(d.id) + '"' + (isOffline ? ' class="' + c('-row-offline') + '"' : '') + '>' +
                    '<td><span class="' + c('-status') + '">' +
                    '<span class="' + c('-status-dot') + ' ' + st.className + '"></span>' +
                    esc(st.label) + '</span></td>' +
                    '<td><span class="' + c('-device-id') + '">' + esc(d.id) + '</span></td>' +
                    '<td><div class="' + c('-host-cell') + '">' +
                    '<span class="material-icons">' + deviceTypeIcon(d.device_type) + '</span>' +
                    '<span class="' + c('-hostname') + '" title="' + esc(hostname) + '">' + esc(hostname) + '</span>' +
                    '</div></td>' +
                    '<td class="' + c('-platform') + '">' + esc(platform) + '</td>' +
                    '<td class="' + c('-last') + '">' + esc(last) + '</td>' +
                    '<td>' +
                    (connected
                        ? '<span class="' + c('-connected-label') + '">' + esc(t('remote.session_picker.already_connected', 'Already connected')) + '</span>'
                        : (canConnect
                            ? '<button type="button" class="' + c('-btn') + ' ' + c('-btn-sm') + ' ' + c('-connect') + '" data-id="' + esc(d.id) + '" data-name="' + esc(hostname) + '">' +
                              '<span class="material-icons">play_arrow</span>' + esc(t('remote_dashboard.connect', 'Connect')) +
                              '</button>'
                            : '<button type="button" class="' + c('-btn') + ' ' + c('-btn-sm') + ' ' + c('-btn-ghost') + '" disabled>' +
                              esc(t('remote_dashboard.connect', 'Connect')) + '</button>')) +
                    '</td></tr>';
            }).join('');
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

        async function loadAll(silent) {
            if (syncing) return;
            syncing = true;
            if (!silent) showState('loading');

            var refreshBtn = el(ids.refreshBtn);
            if (refreshBtn) refreshBtn.classList.add(c('-spinning'));

            try {
                if (!global.Utils || typeof global.Utils.api !== 'function') {
                    throw new Error('Utils.api unavailable');
                }
                var results = await Promise.all([
                    global.Utils.api('/api/devices'),
                    global.Utils.api('/api/folders').catch(function () { return { folders: [] }; }),
                    global.Utils.api('/api/device-groups').catch(function () { return { groups: [] }; }),
                    global.Utils.api('/api/tags').catch(function () { return { tags: [] }; })
                ]);

                devices = results[0].devices || [];
                folders = results[1].folders || [];
                deviceGroups = results[2].groups || [];
                availableTags = results[3].tags || [];

                renderFolders();
                renderGroups();
                renderTags();
                renderDevices();
                return true;
            } catch (err) {
                if (!silent) {
                    var errorText = el(ids.errorText);
                    if (errorText) {
                        errorText.textContent = err.message || t('remote_dashboard.error_load', 'Failed to load devices');
                    }
                    showState('error');
                }
                return false;
            } finally {
                syncing = false;
                if (refreshBtn) refreshBtn.classList.remove(c('-spinning'));
            }
        }

        function bindUi(root) {
            root = root || document;
            var search = el(ids.search);
            if (search) {
                search.addEventListener('input', function () {
                    searchQuery = search.value;
                    renderDevices();
                });
            }

            root.querySelectorAll('.' + c('-filter')).forEach(function (btn) {
                btn.addEventListener('click', function () {
                    root.querySelectorAll('.' + c('-filter')).forEach(function (b) { b.classList.remove('active'); });
                    btn.classList.add('active');
                    currentFilter = btn.getAttribute('data-filter') || 'all';
                    renderDevices();
                });
            });

            var sidebar = el(ids.sidebar);
            if (sidebar) {
                sidebar.addEventListener('click', function (e) {
                    var btn = e.target.closest('.' + c('-nav-item'));
                    if (!btn) return;
                    var nav = btn.getAttribute('data-nav');
                    var id = btn.getAttribute('data-id');
                    if (nav === 'folder') selectFolder(id);
                    else if (nav === 'group') selectGroup(id);
                    else if (nav === 'tag') selectTag(id);
                });
            }

            el(ids.retry)?.addEventListener('click', function () { loadAll(false); });
            el(ids.refreshBtn)?.addEventListener('click', function () { loadAll(false); });

            var contentRoot = el(ids.contentRoot) || root;
            contentRoot.addEventListener('click', function (e) {
                var btn = e.target.closest('.' + c('-card-connect') + ', .' + c('-connect'));
                if (!btn || btn.disabled) return;
                e.preventDefault();
                e.stopPropagation();
                onConnect(btn.getAttribute('data-id'), btn.getAttribute('data-name'));
            });

            var gridBtn = el(ids.viewGrid);
            var listBtn = el(ids.viewList);
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

        function quickConnect(inputId) {
            var input = el(inputId || ids.quickId);
            if (!input) return false;
            var id = (input.value || '').trim().replace(/\s/g, '');
            if (!id || !/^[A-Za-z0-9_-]{3,64}$/.test(id)) {
                input.focus();
                input.classList.add(c('-input-error'));
                setTimeout(function () { input.classList.remove(c('-input-error')); }, 1200);
                return false;
            }
            onConnect(id, id);
            return true;
        }

        return {
            loadAll: loadAll,
            renderDevices: renderDevices,
            bindUi: bindUi,
            quickConnect: quickConnect,
            getDevices: function () { return devices.slice(); },
            getFiltered: function () { return filtered.slice(); }
        };
    }

    global.RemoteAddressBook = {
        create: createAddressBook,
        platformIcon: platformIcon,
        displayName: displayName,
        cardColorForId: cardColorForId,
        deviceStatusInfo: deviceStatusInfo
    };
}(typeof window !== 'undefined' ? window : this));
