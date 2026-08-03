/**
 * BetterDesk Console - Devices Page
 */

(function() {
    'use strict';
    
    // Fallback if Utils.sanitizeColor is missing (old utils.js on server)
    function _sanitizeColorFallback(c) {
        if (!c || typeof c !== 'string') return '#808080';
        if (/^#[0-9A-Fa-f]{3,6}$/.test(c)) return c;
        return '#808080';
    }

    function deviceStatusInfo(d) {
        if (d.soft_deleted) {
            return { className: 'deleted', label: _('devices.deleted_badge'), title: '' };
        }
        if (d.banned) {
            return { className: 'banned', label: _('status.banned'), title: '' };
        }
        if (d.online) {
            return { className: 'online', label: _('status.online'), title: '' };
        }
        if (d.no_signal) {
            return {
                className: 'no_signal',
                label: _('status.no_signal'),
                title: _('devices.no_signal_tooltip')
            };
        }
        return { className: 'offline', label: _('status.offline'), title: '' };
    }

    /** i18n with English fallback when the key is missing ('_' returns the key). */
    function dt(key, fallback) {
        if (typeof _ === 'function') {
            const val = _(key);
            if (val && val !== key) return val;
        }
        return fallback !== undefined ? fallback : key;
    }

    // Map device_type to Material Icons
    function getDeviceTypeIcon(type) {
        switch ((type || '').toLowerCase()) {
            case 'betterdesk': return 'desktop_windows';
            case 'desktop':  return 'desktop_windows';
            case 'scada':    return 'precision_manufacturing';
            case 'iot':      return 'sensors';
            case 'os_agent': return 'terminal';
            case 'mesh_agent': return 'hub';
            case 'mobile':   return 'phone_android';
            case 'rustdesk': return 'connected_tv';
            default:         return 'devices';
        }
    }
    
    document.addEventListener('DOMContentLoaded', init);
    
    // State
    let devices = [];
    let filteredDevices = [];
    let folders = [];
    let deviceGroups = [];
    let accessStrategies = [];
    let strategiesLoaded = false;
    let availableUserGroups = [];
    let userGroupsLoaded = false;
    let availableTags = [];
    let selectedTags = new Set();
    let selectedIds = new Set();
    let currentFilter = 'all';
    let currentFolder = 'all';
    let currentGroup = 'all';
    // Online first, then hostname A–Z (display name). Column clicks still apply as secondary sort.
    let currentSort = { field: 'hostname', order: 'asc' };
    let currentPage = 1;
    let perPage = 20;
    let searchQuery = '';
    let showDeleted = false;
    let draggedDeviceId = null;
    const STORAGE_PER_PAGE = 'bd_devices_per_page';
    const STORAGE_SHOW_DELETED = 'bd_devices_show_deleted';
    const PER_PAGE_OPTIONS = [10, 20, 50, 100];
    let contextMenuState = null;
    let hScrollSyncing = false;
    const pendingRequests = new Map();
    const LOAD_STAGGER_MS = 120;
    
    function fetchOnce(endpoint, fetcher) {
        if (pendingRequests.has(endpoint)) return pendingRequests.get(endpoint);
        const request = fetcher().finally(() => pendingRequests.delete(endpoint));
        pendingRequests.set(endpoint, request);
        return request;
    }

    function scheduleLoad(fn, index) {
        setTimeout(fn, index * LOAD_STAGGER_MS);
    }
    
    // Elements
    let tableBody, pagination, emptyState, bulkActions, selectedCountEl;
    let contextMenuEl, tableScrollEl, hScrollFloatEl, hScrollSpacerEl;
    
    function init() {
        // Cache elements
        tableBody = document.getElementById('devices-tbody');
        pagination = document.getElementById('pagination');
        emptyState = document.getElementById('devices-empty');
        bulkActions = document.getElementById('bulk-actions');
        selectedCountEl = document.getElementById('selected-count');
        
        // Load data (staggered to avoid rate-limit bursts on page entry)
        scheduleLoad(loadFolders, 0);
        scheduleLoad(loadUserGroups, 1);
        scheduleLoad(loadDeviceGroups, 2);
        scheduleLoad(loadStrategies, 3);
        scheduleLoad(loadTags, 4);
        scheduleLoad(loadDevices, 5);
        
        // Event listeners
        initSearch();
        initFilters();
        initShowDeletedToggle();
        initTagFilter();
        initSorting();
        initSync();
        initFolders();
        initDeviceGroups();
        initStrategies();
        initDragDrop();
        attachFolderDropEvents();  // For static folder chips
        attachGroupDropEvents();   // For static group chips
        initColumnVisibility();    // Column show/hide toggle
        initKebabGlobalClose();    // Close kebab/context menus on outside click
        initContextMenu();
        initPerPage();
        initTableHScroll();

        const savedPerPage = parseInt(localStorage.getItem(STORAGE_PER_PAGE) || '', 10);
        if (PER_PAGE_OPTIONS.includes(savedPerPage)) {
            perPage = savedPerPage;
            const perPageSelect = document.getElementById('per-page-select');
            if (perPageSelect) perPageSelect.value = String(perPage);
        }

        showDeleted = localStorage.getItem(STORAGE_SHOW_DELETED) === '1';
        const showDeletedInput = document.getElementById('show-deleted-input');
        if (showDeletedInput) showDeletedInput.checked = showDeleted;
        
        // Refresh handler
        window.addEventListener('app:refresh', () => {
            loadFolders();
            loadUserGroups();
            loadDeviceGroups();
            loadStrategies();
            loadTags();
            loadDevices();
        });

        // Listen for changes from DeviceDetail panel
        document.addEventListener('deviceDetail:changed', () => {
            loadFolders();
            loadUserGroups();
            loadDeviceGroups();
            loadTags();
            loadDevices();
        });

        // Real-time device status push via WebSocket
        initDeviceStatusWS();
    }

    /**
     * Connect to WebSocket for real-time device status updates.
     * Updates device status dots and badges without full page reload.
     */
    function initDeviceStatusWS() {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${location.host}/ws/device-status`;
        let ws = null;
        let retryDelay = 3000;

        function connect() {
            ws = new WebSocket(wsUrl);

            ws.onopen = () => {
                retryDelay = 3000;
            };

            ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'device_status') {
                        updateDeviceStatusInPlace(data.device_id, data.status);
                        document.dispatchEvent(new CustomEvent('devices:live-status', {
                            detail: { id: data.device_id, status: data.status }
                        }));
                    } else if (data.type === 'device_id_changed') {
                        document.dispatchEvent(new CustomEvent('devices:id-changed', {
                            detail: { old_id: data.old_id, new_id: data.new_id, source: data.source || '' }
                        }));
                        loadDevices();
                    }
                } catch (_) {}
            };

            ws.onclose = () => {
                setTimeout(connect, retryDelay);
                retryDelay = Math.min(retryDelay * 2, 60000);
            };

            ws.onerror = () => {
                ws.close();
            };
        }

        connect();
    }

    /**
     * Update a single device's status indicator without reloading the entire table.
     */
    function updateDeviceStatusInPlace(deviceId, status) {
        const row = tableBody?.querySelector(`tr[data-id="${deviceId}"]`);
        if (!row) return;

        const normalizedStatus = String(status || '').toLowerCase();
        const statusClassName = ['online', 'offline', 'no_signal', 'degraded', 'critical'].includes(normalizedStatus)
            ? normalizedStatus
            : 'offline';
        const statusText = _('status.' + statusClassName);
        const statusLabel = statusText === 'status.' + statusClassName ? statusClassName : statusText;

        const dot = row.querySelector('.device-status-dot');
        if (dot) {
            dot.className = 'device-status-dot';
            dot.classList.add(statusClassName);
            dot.title = statusLabel;
        }

        const badge = row.querySelector('[data-column="status"] .status-badge');
        if (badge) {
            badge.className = `status-badge ${statusClassName}`;
            badge.innerHTML = `<span class="status-dot"></span>${statusLabel}`;
        }

        // Also update the device in our local state
        const dev = devices.find(d => d.id === deviceId);
        if (dev) {
            dev.status = status;
            dev.live_status = statusClassName;
            dev.live_online = statusClassName === 'online';
            dev.online = statusClassName === 'online';
            dev.no_signal = statusClassName === 'no_signal';
        }
    }

    /**
     * Close all open kebab menus when clicking outside
     */
    function initKebabGlobalClose() {
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.kebab-wrapper')) {
                closeAllKebabMenus();
            }
            if (!e.target.closest('.devices-context-menu')) {
                closeContextMenu();
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeAllKebabMenus();
                closeContextMenu();
            }
        });

        document.addEventListener('scroll', () => {
            closeAllKebabMenus();
            closeContextMenu();
        }, true);
        window.addEventListener('resize', () => {
            closeAllKebabMenus();
            closeContextMenu();
            updateTableHScroll();
        });
    }

    function closeAllKebabMenus() {
        document.querySelectorAll('.kebab-menu.open').forEach(m => {
            m.classList.remove('open');
            m.style.top = '';
            m.style.left = '';
        });
        const overlay = document.getElementById('kebab-overlay');
        if (overlay) overlay.classList.remove('open');
    }

    function buildDeviceMenuItemsHtml(device) {
        const eid = Utils.escapeHtml(device.id);
        const banned = !!device.banned;
        if (device.soft_deleted) {
            return `
            <button type="button" class="kebab-menu-item info" data-action="details" data-id="${eid}">
                <span class="material-icons">info</span>
                <span>${_('actions.details')}</span>
            </button>
            <div class="kebab-divider"></div>
            <button type="button" class="kebab-menu-item" data-action="restore" data-id="${eid}">
                <span class="material-icons">restore</span>
                <span>${_('devices.restore_action')}</span>
            </button>
            <button type="button" class="kebab-menu-item danger" data-action="permanent-delete" data-id="${eid}">
                <span class="material-icons">delete_forever</span>
                <span>${_('devices.permanent_delete_title')}</span>
            </button>`;
        }
        const isMesh = String(device.device_type || '').toLowerCase() === 'mesh_agent';
        const meshOnline = isMesh && (device.mesh_connected || device.online);
        const meshOfflineWake = isMesh && !meshOnline ? `
            <button type="button" class="kebab-menu-item" data-action="mesh-power-wake" data-id="${eid}">
                <span class="material-icons">power_settings_new</span>
                <span>${_('mesh.power_wake') || 'Wake'}</span>
            </button>
            <div class="kebab-divider"></div>` : '';
        const meshActions = meshOnline ? `
            <button type="button" class="kebab-menu-item" data-action="mesh-terminal" data-id="${eid}">
                <span class="material-icons">terminal</span>
                <span>${_('mesh.terminal') || 'Terminal'}</span>
            </button>
            <button type="button" class="kebab-menu-item" data-action="mesh-files" data-id="${eid}">
                <span class="material-icons">folder</span>
                <span>${_('mesh.files') || 'File browser'}</span>
            </button>
            <button type="button" class="kebab-menu-item" data-action="mesh-run-command" data-id="${eid}">
                <span class="material-icons">play_arrow</span>
                <span>${_('mesh.run_command') || 'Run command'}</span>
            </button>
            <button type="button" class="kebab-menu-item" data-action="mesh-link-peer" data-id="${eid}">
                <span class="material-icons">link</span>
                <span>${_('mesh.link_peer') || 'Link peer'}</span>
            </button>
            <button type="button" class="kebab-menu-item" data-action="mesh-share" data-id="${eid}">
                <span class="material-icons">link</span>
                <span>${_('mesh.share_link') || 'Guest desktop link'}</span>
            </button>
            <button type="button" class="kebab-menu-item" data-action="mesh-port-tcp" data-id="${eid}">
                <span class="material-icons">settings_ethernet</span>
                <span>${_('mesh.port_tcp') || 'TCP port relay'}</span>
            </button>
            <button type="button" class="kebab-menu-item" data-action="mesh-port-udp" data-id="${eid}">
                <span class="material-icons">settings_ethernet</span>
                <span>${_('mesh.port_udp') || 'UDP port relay'}</span>
            </button>
            <button type="button" class="kebab-menu-item" data-action="mesh-power-wake" data-id="${eid}">
                <span class="material-icons">power_settings_new</span>
                <span>${_('mesh.power_wake') || 'Wake'}</span>
            </button>
            <button type="button" class="kebab-menu-item" data-action="mesh-power-sleep" data-id="${eid}">
                <span class="material-icons">bedtime</span>
                <span>${_('mesh.power_sleep') || 'Sleep'}</span>
            </button>
            <button type="button" class="kebab-menu-item" data-action="mesh-power-reset" data-id="${eid}">
                <span class="material-icons">restart_alt</span>
                <span>${_('mesh.power_reset') || 'Reset'}</span>
            </button>
            <button type="button" class="kebab-menu-item" data-action="mesh-power-off" data-id="${eid}">
                <span class="material-icons">power_off</span>
                <span>${_('mesh.power_off') || 'Power off'}</span>
            </button>
            <div class="kebab-divider"></div>` : '';
        return `
            <button type="button" class="kebab-menu-item connect-desktop" data-action="web-remote" data-id="${eid}">
                <span class="material-icons">screen_share</span>
                <span>${_('actions.web_remote') || 'Web Remote'}</span>
            </button>
            <button type="button" class="kebab-menu-item" data-action="guest-access" data-id="${eid}">
                <span class="material-icons">share</span>
                <span>${_('guest_access.menu') || 'Guest access link'}</span>
            </button>
            ${meshActions}
            ${meshOfflineWake}
            <button type="button" class="kebab-menu-item" data-action="cdap-viewer" data-id="${eid}">
                <span class="material-icons">photo_camera</span>
                <span>${_('actions.cdap_viewer') || 'CDAP Snapshot Viewer'}</span>
            </button>
            <button type="button" class="kebab-menu-item" data-action="connect-desktop" data-id="${eid}">
                <span class="material-icons">computer</span>
                <span>${_('actions.connect_desktop') || 'Desktop Client'}</span>
            </button>
            <div class="kebab-divider"></div>
            <button type="button" class="kebab-menu-item info" data-action="details" data-id="${eid}">
                <span class="material-icons">info</span>
                <span>${_('actions.details')}</span>
            </button>
            <button type="button" class="kebab-menu-item" data-action="edit" data-id="${eid}">
                <span class="material-icons">edit</span>
                <span>${_('actions.edit')}</span>
            </button>
            <button type="button" class="kebab-menu-item" data-action="groups" data-id="${eid}">
                <span class="material-icons">hub</span>
                <span>${_('devices.manage_groups') || 'Manage Groups'}</span>
            </button>
            <button type="button" class="kebab-menu-item" data-action="access-policy" data-id="${eid}">
                <span class="material-icons">lock</span>
                <span>${_('devices.access_policy') || 'Access Policy'}</span>
            </button>
            <button type="button" class="kebab-menu-item ${banned ? 'unban' : 'ban'}" data-action="toggle-ban" data-id="${eid}" data-banned="${banned}">
                <span class="material-icons">${banned ? 'check_circle' : 'block'}</span>
                <span>${banned ? _('actions.unban') : _('actions.ban')}</span>
            </button>
            <div class="kebab-divider"></div>
            <button type="button" class="kebab-menu-item danger" data-action="delete" data-id="${eid}">
                <span class="material-icons">delete</span>
                <span>${_('actions.delete')}</span>
            </button>`;
    }

    function initContextMenu() {
        contextMenuEl = document.getElementById('devices-context-menu');
        if (!contextMenuEl) return;

        contextMenuEl.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn || !contextMenuState) return;
            e.stopPropagation();
            const action = btn.dataset.action;
            const state = contextMenuState;
            closeContextMenu();

            if (state.type === 'device') {
                handleAction(action, btn.dataset.id || state.id, btn.dataset);
            } else if (state.type === 'folder') {
                if (action === 'edit') editFolder(state.id);
                else if (action === 'delete') deleteFolder(state.id);
            } else if (state.type === 'group') {
                const group = deviceGroups.find(item => item.guid === state.guid);
                if (!group) return;
                if (action === 'edit') showDeviceGroupModal(group);
                else if (action === 'delete') deleteDeviceGroup(group);
            }
        });

    }

    function buildChipContextMenuHtml(type) {
        return `
            <button type="button" class="kebab-menu-item" data-action="edit">
                <span class="material-icons">edit</span>
                <span>${_('actions.edit')}</span>
            </button>
            <div class="kebab-divider"></div>
            <button type="button" class="kebab-menu-item danger" data-action="delete">
                <span class="material-icons">delete</span>
                <span>${_('actions.delete')}</span>
            </button>`;
    }

    function positionContextMenu(clientX, clientY) {
        if (!contextMenuEl) return;
        const menuWidth = contextMenuEl.offsetWidth || 180;
        const menuHeight = contextMenuEl.offsetHeight || 120;
        let left = clientX;
        let top = clientY;
        if (left + menuWidth > window.innerWidth - 8) left = window.innerWidth - menuWidth - 8;
        if (top + menuHeight > window.innerHeight - 8) top = window.innerHeight - menuHeight - 8;
        if (left < 8) left = 8;
        if (top < 8) top = 8;
        contextMenuEl.style.left = left + 'px';
        contextMenuEl.style.top = top + 'px';
    }

    function openContextMenu(clientX, clientY, html, state) {
        if (!contextMenuEl) return;
        closeAllKebabMenus();
        contextMenuState = state;
        contextMenuEl.innerHTML = html;
        contextMenuEl.hidden = false;
        contextMenuEl.classList.add('open');
        positionContextMenu(clientX, clientY);
    }

    function closeContextMenu() {
        if (!contextMenuEl) return;
        contextMenuEl.classList.remove('open');
        contextMenuEl.hidden = true;
        contextMenuEl.innerHTML = '';
        contextMenuEl.style.left = '';
        contextMenuEl.style.top = '';
        contextMenuState = null;
    }

    function attachDeviceRowContextMenu() {
        if (!tableBody) return;
        tableBody.querySelectorAll('tr[data-id]').forEach(row => {
            row.addEventListener('contextmenu', (e) => {
                if (e.target.closest('.kebab-wrapper') || e.target.closest('.copy-btn')) return;
                e.preventDefault();
                const deviceId = row.dataset.id;
                const device = devices.find(d => d.id === deviceId) ||
                    filteredDevices.find(d => d.id === deviceId);
                if (!device) return;
                openContextMenu(e.clientX, e.clientY, buildDeviceMenuItemsHtml(device), {
                    type: 'device',
                    id: deviceId,
                    linked_peer_id: device.linked_peer_id || '',
                    deviceName: device.display_name || device.hostname || ''
                });
            });
        });
    }

    function attachChipContextMenu(el, state) {
        el.addEventListener('contextmenu', (e) => {
            if (e.target.closest('.chip-action') || e.target.closest('.chip-actions')) return;
            e.preventDefault();
            e.stopPropagation();
            openContextMenu(e.clientX, e.clientY, buildChipContextMenuHtml(state.type), state);
        });
    }

    function initPerPage() {
        const select = document.getElementById('per-page-select');
        if (!select) return;
        select.addEventListener('change', () => {
            const value = parseInt(select.value, 10);
            if (!PER_PAGE_OPTIONS.includes(value)) return;
            perPage = value;
            currentPage = 1;
            try { localStorage.setItem(STORAGE_PER_PAGE, String(perPage)); } catch (_) {}
            renderDevices();
            renderPagination();
        });
    }

    function initTableHScroll() {
        tableScrollEl = document.getElementById('devices-table-scroll');
        hScrollFloatEl = document.getElementById('devices-hscroll-float');
        hScrollSpacerEl = document.getElementById('devices-hscroll-spacer');
        if (!tableScrollEl || !hScrollFloatEl || !hScrollSpacerEl) return;

        tableScrollEl.addEventListener('scroll', () => {
            if (hScrollSyncing) return;
            hScrollSyncing = true;
            hScrollFloatEl.scrollLeft = tableScrollEl.scrollLeft;
            hScrollSyncing = false;
        });

        hScrollFloatEl.addEventListener('scroll', () => {
            if (hScrollSyncing) return;
            hScrollSyncing = true;
            tableScrollEl.scrollLeft = hScrollFloatEl.scrollLeft;
            hScrollSyncing = false;
        });

        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(() => updateTableHScroll());
            ro.observe(tableScrollEl);
            const table = document.getElementById('devices-table');
            if (table) ro.observe(table);
            const tableContainer = document.querySelector('.devices-table-container');
            if (tableContainer) ro.observe(tableContainer);
        }

        const mainContent = document.querySelector('.main-content');
        if (mainContent) {
            mainContent.addEventListener('scroll', updateTableHScroll, { passive: true });
        }
        window.addEventListener('scroll', updateTableHScroll, { passive: true });
    }

    function updateTableHScroll() {
        if (!tableScrollEl || !hScrollFloatEl || !hScrollSpacerEl) return;
        const table = document.getElementById('devices-table');
        const tableContainer = document.querySelector('.devices-table-container');
        const mainContent = document.querySelector('.main-content');
        if (!table || !tableContainer) return;

        const scrollWidth = table.scrollWidth;
        const clientWidth = tableScrollEl.clientWidth;
        const needsHScroll = scrollWidth > clientWidth + 1;
        hScrollSpacerEl.style.width = scrollWidth + 'px';

        if (!needsHScroll) {
            hScrollFloatEl.classList.remove('visible');
            hScrollFloatEl.scrollLeft = 0;
            tableScrollEl.scrollLeft = 0;
            return;
        }

        const containerRect = tableContainer.getBoundingClientRect();
        const viewportRect = mainContent
            ? mainContent.getBoundingClientRect()
            : { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };

        const tableInView = containerRect.bottom > viewportRect.top + 8 &&
            containerRect.top < viewportRect.bottom - 8;

        if (!tableInView) {
            hScrollFloatEl.classList.remove('visible');
            return;
        }

        const barHeight = hScrollFloatEl.offsetHeight || 22;
        hScrollFloatEl.style.left = containerRect.left + 'px';
        hScrollFloatEl.style.width = containerRect.width + 'px';
        hScrollFloatEl.style.top = (viewportRect.bottom - barHeight) + 'px';
        hScrollFloatEl.style.bottom = 'auto';
        hScrollFloatEl.classList.add('visible');
    }

    /**
     * Position a fixed kebab menu relative to its trigger button.
     * Flips upward if there is not enough space below.
     * Skips on mobile (≤600px) where CSS bottom-sheet handles positioning.
     */
    function positionKebabMenu(btn, menu) {
        if (window.innerWidth <= 600) return;

        // Force reflow so offsetHeight is accurate (menu just became display:block)
        menu.style.visibility = 'hidden';
        const prevDisplay = menu.style.display;
        menu.style.display = 'block';
        const menuHeight = menu.offsetHeight;
        const menuWidth = menu.offsetWidth || 180;
        menu.style.display = prevDisplay;
        menu.style.visibility = '';

        const rect = btn.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;

        let top, left;

        // Vertical: prefer below, flip above if not enough space
        if (spaceBelow >= menuHeight + 8) {
            top = rect.bottom + 4;
        } else {
            top = rect.top - menuHeight - 4;
        }
        // Clamp to viewport bounds
        if (top < 8) top = 8;
        if (top + menuHeight > window.innerHeight - 8) {
            top = window.innerHeight - menuHeight - 8;
        }

        // Dynamically constrain max-height to available viewport space
        const availableHeight = window.innerHeight - top - 8;
        if (menuHeight > availableHeight) {
            menu.style.maxHeight = availableHeight + 'px';
        } else {
            menu.style.maxHeight = '';
        }

        // Horizontal: align right edge to button right edge
        left = rect.right - menuWidth;
        if (left < 8) left = 8;
        if (left + menuWidth > window.innerWidth - 8) {
            left = window.innerWidth - menuWidth - 8;
        }

        menu.style.top = top + 'px';
        menu.style.left = left + 'px';
    }
    
    /**
     * Load devices from API
     */
    async function loadDevices() {
        try {
            const qs = showDeleted ? '?includeDeleted=true' : '';
            const endpoint = '/api/devices' + qs;
            const response = await fetchOnce(endpoint, () => Utils.api(endpoint));
            devices = response.devices || [];
            
            // Update count
            document.getElementById('devices-count').textContent = devices.length;
            
            // Update folder counts now that devices are loaded
            updateFolderCounts();
            updateGroupCounts();
            
            applyFilters();
            
        } catch (error) {
            console.error('Failed to load devices:', error);
            Notifications.error(_('errors.load_devices_failed'));
        }
    }

    function normalizeTags(value) {
        if (!value) return [];
        if (Array.isArray(value)) return value.map(String).map(t => t.trim()).filter(Boolean);
        if (typeof value === 'string') {
            try {
                const parsed = JSON.parse(value);
                if (Array.isArray(parsed)) return parsed.map(String).map(t => t.trim()).filter(Boolean);
            } catch (_) {}
            return value.split(',').map(t => t.trim()).filter(Boolean);
        }
        return [];
    }

    function normalizeGuids(value) {
        if (!value) return [];
        const raw = Array.isArray(value) ? value : String(value || '').split(',');
        const seen = new Set();
        const guids = [];
        raw.forEach(item => {
            const guid = typeof item === 'object' ? String(item.guid || '').trim() : String(item || '').trim();
            if (guid && !seen.has(guid)) {
                seen.add(guid);
                guids.push(guid);
            }
        });
        return guids;
    }

    async function loadUserGroups() {
        try {
            const response = await fetchOnce('/api/panel/user-groups', () => Utils.api('/api/panel/user-groups'));
            availableUserGroups = response.groups || [];
            userGroupsLoaded = true;
        } catch (error) {
            availableUserGroups = [];
            userGroupsLoaded = true;
            console.error('Failed to load user groups:', error);
        }
    }

    async function ensureUserGroupsLoaded() {
        if (!userGroupsLoaded) await loadUserGroups();
    }

    function renderUserGroupAccessOptions(selectedGuids) {
        const selected = new Set(normalizeGuids(selectedGuids));
        if (!availableUserGroups.length) {
            return `<div class="tag-filter-empty user-group-empty">
                <span>${_('devices.no_user_groups') || 'No user groups'}</span>
                <button type="button" class="btn btn-secondary btn-sm" id="dg-manage-user-groups-empty">
                    <span class="material-icons">group_add</span>
                    ${_('devices.manage_user_groups') || 'Manage user groups'}
                </button>
            </div>`;
        }
        return availableUserGroups.map(group => `
            <label class="group-membership-option compact">
                <input type="checkbox" class="dg-user-group" value="${Utils.escapeHtml(group.guid)}" ${selected.has(group.guid) ? 'checked' : ''}>
                <span class="material-icons">group</span>
                <span>${Utils.escapeHtml(group.name || group.guid)}</span>
            </label>`).join('');
    }

    function deviceMatchesGroup(device, group) {
        if (!device || !group) return false;
        if ((group.source_type || 'manual') === 'tag') {
            const tag = String(group.tag_filter || '').toLowerCase();
            return tag && normalizeTags(device.tags).some(t => t.toLowerCase() === tag);
        }
        const groups = Array.isArray(device.groups) ? device.groups : [];
        return groups.some(g => g.guid === group.guid);
    }

    /** Compare folder ids from API/Postgres (number or string) with chip dataset values. */
    function folderIdsEqual(a, b) {
        if (a == null || a === '' || Number(a) === 0) {
            return b == null || b === '' || Number(b) === 0;
        }
        return Number(a) === Number(b);
    }

    function findFolderById(folderId) {
        if (folderId == null || folderId === '') return null;
        const target = Number(folderId);
        if (!Number.isFinite(target)) return null;
        return folders.find(f => Number(f.id) === target) || null;
    }

    function renderTagsCell(device) {
        const tags = normalizeTags(device.tags);
        if (tags.length === 0) {
            return `<span class="device-tags-empty">-</span>`;
        }

        const visible = tags.slice(0, 2);
        const rest = tags.length - visible.length;
        return `
            <div class="device-tags" title="${Utils.escapeHtml(tags.join(', '))}">
                ${visible.map(tag => `<span class="device-tag-pill">${Utils.escapeHtml(tag)}</span>`).join('')}
                ${rest > 0 ? `<span class="device-tag-more">+${rest}</span>` : ''}
            </div>`;
    }
    
    /**
     * Apply current filters and render
     */
    function applyFilters() {
        filteredDevices = devices.filter(device => {
            if (!showDeleted && device.soft_deleted) return false;

            // Folder filter
            if (currentFolder === 'unassigned' && device.folder_id) return false;
            if (currentFolder !== 'all' && currentFolder !== 'unassigned') {
                if (!folderIdsEqual(device.folder_id, currentFolder)) return false;
            }

            // Device group filter (manual or dynamic)
            if (currentGroup !== 'all') {
                const group = deviceGroups.find(g => g.guid === currentGroup);
                if (!group || !deviceMatchesGroup(device, group)) return false;
            }

            // Tag filters: all selected tags must be present
            if (selectedTags.size > 0) {
                const tags = normalizeTags(device.tags).map(t => t.toLowerCase());
                for (const tag of selectedTags) {
                    if (!tags.includes(tag.toLowerCase())) return false;
                }
            }
            
            // Status filter
            if (currentFilter === 'online' && !device.online) return false;
            if (currentFilter === 'offline' && (device.online || device.banned)) return false;
            if (currentFilter === 'banned' && !device.banned) return false;
            if (currentFilter === 'mesh_agent' && String(device.device_type || '').toLowerCase() !== 'mesh_agent') return false;
            
            // Search filter
            if (searchQuery) {
                const q = searchQuery.toLowerCase();
                const match = 
                    device.id?.toLowerCase().includes(q) ||
                    device.display_name?.toLowerCase().includes(q) ||
                    device.hostname?.toLowerCase().includes(q) ||
                    device.username?.toLowerCase().includes(q) ||
                    device.platform?.toLowerCase().includes(q) ||
                    (device.device_type || 'rustdesk').toLowerCase().includes(q);
                if (!match) return false;
            }
            
            return true;
        });
        
        // Sort
        sortDevices();
        
        // Render
        renderDevices();
        renderPagination();
        updateEmptyState();
    }
    
    /** Name shown in the hostname column — used for alphabetical sort. */
    function deviceSortName(device) {
        return String(device.display_name || device.hostname || device.note || device.id || '').toLowerCase();
    }

    /**
     * Sort devices: online first, then current column (default hostname A–Z).
     */
    function sortDevices() {
        const { field, order } = currentSort;
        
        filteredDevices.sort((a, b) => {
            // Primary: Online before Offline / No signal / Banned
            const onlineA = a.online ? 0 : 1;
            const onlineB = b.online ? 0 : 1;
            if (onlineA !== onlineB) return onlineA - onlineB;

            let valA;
            let valB;

            if (field === 'hostname') {
                valA = deviceSortName(a);
                valB = deviceSortName(b);
            } else {
                valA = a[field];
                valB = b[field];

                if (valA === null || valA === undefined) valA = '';
                if (valB === null || valB === undefined) valB = '';

                if (typeof valA === 'string') {
                    valA = valA.toLowerCase();
                    valB = typeof valB === 'string' ? valB.toLowerCase() : String(valB || '').toLowerCase();
                }

                if (field === 'last_online') {
                    valA = new Date(valA || 0).getTime();
                    valB = new Date(valB || 0).getTime();
                }
            }
            
            if (valA < valB) return order === 'asc' ? -1 : 1;
            if (valA > valB) return order === 'asc' ? 1 : -1;

            // Stable tie-break by id so refresh does not reshuffle equals
            const idA = String(a.id || '');
            const idB = String(b.id || '');
            if (idA < idB) return -1;
            if (idA > idB) return 1;
            return 0;
        });
    }
    
    /**
     * Render devices table
     */
    function renderDevices() {
        if (!tableBody) return;
        
        const start = (currentPage - 1) * perPage;
        const end = start + perPage;
        const pageDevices = filteredDevices.slice(start, end);
        
        if (pageDevices.length === 0) {
            tableBody.innerHTML = '';
            return;
        }
        
        tableBody.innerHTML = pageDevices.map(device => {
            const eid = Utils.escapeHtml(device.id);
            const statusInfo = deviceStatusInfo(device);
            const sc = statusInfo.className;
            return `
            <tr data-id="${eid}" class="${device.banned ? 'banned-row' : ''}${device.soft_deleted ? ' deleted-row' : ''}" draggable="${device.soft_deleted ? 'false' : 'true'}">
                <td data-column="id">
                    <div class="device-id">
                        <span class="device-status-dot ${sc}"></span>
                        <span class="device-id-text">${eid}</span>
                        ${device.soft_deleted ? `<span class="device-deleted-badge">${Utils.escapeHtml(_('devices.deleted_badge'))}</span>` : ''}
                        <button class="copy-btn" title="${_('actions.copy')}" data-copy="${eid}">
                            <span class="material-icons">content_copy</span>
                        </button>
                    </div>
                </td>
                <td data-column="hostname">${Utils.escapeHtml(device.display_name || device.hostname || device.note || '-')}</td>
                <td data-column="device_type">
                    <div class="platform-icon">
                        <span class="material-icons">${getDeviceTypeIcon(device.device_type)}</span>
                        <span>${Utils.escapeHtml(device.device_type || '-')}</span>
                        ${device.linked_peer_id ? `<span class="mesh-linked-badge" title="${Utils.escapeHtml(_('mesh.linked_peer') || 'Linked device')}">↔ ${Utils.escapeHtml(device.linked_peer_id)}</span>` : ''}
                    </div>
                </td>
                <td data-column="platform">
                    <div class="platform-icon">
                        <span class="material-icons">${Utils.getPlatformIcon(device.platform || device.os)}</span>
                        <span>${Utils.escapeHtml(device.platform || device.os || '-')}</span>
                    </div>
                </td>
                <td data-column="last_online">
                    <span class="last-seen-text" title="${Utils.formatDate(device.last_online)}">${Utils.formatRelativeTime(device.last_online)}</span>
                </td>
                <td data-column="status">
                    <span class="status-badge ${sc}"${statusInfo.title ? ` title="${Utils.escapeHtml(statusInfo.title)}"` : ''}><span class="status-dot"></span>${statusInfo.label}</span>
                </td>
                <td data-column="tags">${renderTagsCell(device)}</td>
                <td data-column="actions">
                    <div class="kebab-wrapper">
                        <button class="kebab-btn" title="${_('devices.actions')}">
                            <span class="material-icons">more_vert</span>
                        </button>
                        <div class="kebab-menu">${buildDeviceMenuItemsHtml(device)}</div>
                    </div>
                </td>
            </tr>`;
        }).join('');
        
        // Re-apply column visibility to newly rendered rows
        applyColumnVisibility();
        
        // Attach event listeners
        attachRowEventListeners();
        attachDeviceRowContextMenu();
        requestAnimationFrame(updateTableHScroll);
    }
    
    /**
     * Attach event listeners to table rows
     */
    function attachRowEventListeners() {
        // Copy ID
        tableBody.querySelectorAll('.copy-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = btn.dataset.copy;
                await Utils.copyToClipboard(id);
                btn.classList.add('copied');
                setTimeout(() => btn.classList.remove('copied'), 2000);
                Notifications.success(_('common.copied'));
            });
        });

        // Kebab menu toggle
        tableBody.querySelectorAll('.kebab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const menu = btn.nextElementSibling;
                const wasOpen = menu.classList.contains('open');
                closeAllKebabMenus();
                if (!wasOpen) {
                    menu.classList.add('open');
                    positionKebabMenu(btn, menu);
                    const overlay = document.getElementById('kebab-overlay');
                    if (overlay) overlay.classList.add('open');
                }
            });
        });

        // Kebab menu item actions
        tableBody.querySelectorAll('.kebab-menu-item').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                closeAllKebabMenus();
                const row = btn.closest('tr[data-id]');
                const deviceId = btn.dataset.id || row && row.dataset.id;
                const device = devices.find(d => d.id === deviceId) ||
                    filteredDevices.find(d => d.id === deviceId);
                handleAction(btn.dataset.action, deviceId, device || btn.dataset);
            });
        });

        // Double-click row to open device detail panel
        tableBody.querySelectorAll('tr[data-id]').forEach(row => {
            row.addEventListener('dblclick', (e) => {
                // Ignore double-click on kebab menu and copy button
                if (e.target.closest('.kebab-wrapper') || e.target.closest('.copy-btn')) return;
                const deviceId = row.dataset.id;
                if (deviceId && typeof DeviceDetail !== 'undefined') {
                    DeviceDetail.open(deviceId);
                }
            });
        });
    }
    
    function _remoteViewerUrl(deviceId) {
        let url = `/remote/${encodeURIComponent(deviceId)}`;
        try {
            const device = (typeof devices !== 'undefined' && devices)
                ? devices.find((d) => String(d.id) === String(deviceId) || String(d.device_id) === String(deviceId))
                : null;
            const dtype = String((device && (device.device_type || device.type)) || '').toLowerCase();
            // Support Agent / CDAP peers must use CDAP for clipboard + file transfer.
            if (dtype === 'os_agent' || dtype === 'cdap' || (device && device.cdap_connected)) {
                url += '?transport=cdap';
            }
        } catch (_) { /* ignore */ }
        return url;
    }

    /**
     * Handle device actions
     */
    /**
     * Try to add a remote session tab in an existing RDClient window via BroadcastChannel.
     * Falls back to opening a new browser tab if no RDClient page is listening.
     */
    function _tryAddRemoteTab(deviceId, data) {
        if (window.DeviceCapabilities && window.DeviceCapabilities.isPhone()) {
            if (window.RdClientMobile && window.RdClientMobile.showPhoneUnsupportedToast) {
                window.RdClientMobile.showPhoneUnsupportedToast();
            } else if (typeof Modal !== 'undefined') {
                Modal.alert({
                    title: _('remote.phone_unsupported_title'),
                    message: _('remote.phone_unsupported_body')
                });
            }
            return;
        }

        if (typeof BroadcastChannel === 'undefined') {
            window.open(_remoteViewerUrl(deviceId), '_blank');
            return;
        }

        const bc = new BroadcastChannel('betterdesk-remote');
        let handled = false;

        // Listen for acknowledgment from remote page
        bc.onmessage = (ev) => {
            if (ev.data && ev.data.type === 'pong') {
                // Remote page exists — send the add-session command
                handled = true;
                bc.postMessage({
                    type: 'add-session',
                    deviceId: deviceId,
                    deviceName: (data && data.deviceName) || ''
                });
                bc.close();
            } else if (ev.data && ev.data.type === 'session-added') {
                handled = true;
                bc.close();
            }
        };

        // Ping to check if a remote page is open
        bc.postMessage({ type: 'ping' });

        // Timeout: if no response within 300ms, open new tab
        setTimeout(() => {
            if (!handled) {
                bc.close();
                window.open(_remoteViewerUrl(deviceId), '_blank');
            }
        }, 300);
    }

    async function handleAction(action, deviceId, data) {
        switch (action) {
            case 'web-remote':
                _tryAddRemoteTab(deviceId, data);
                break;

            case 'cdap-viewer':
                window.open(`/remote-cdap/${encodeURIComponent(deviceId)}`, '_blank');
                break;

            case 'connect-desktop':
                connectDesktopClient(deviceId);
                break;

            case 'mesh-terminal':
                if (typeof openMeshTerminal === 'function') {
                    openMeshTerminal(deviceId);
                } else {
                    Notifications.error(_('mesh.terminal_unavailable') || 'Terminal module not loaded');
                }
                break;

            case 'mesh-files':
                window.open('/remote/' + encodeURIComponent(deviceId) + '?transport=mesh&panel=files', '_blank');
                break;

            case 'mesh-run-command':
                showMeshRunCommandModal(deviceId);
                break;

            case 'mesh-link-peer':
                showMeshLinkPeerModal(deviceId, data);
                break;

            case 'mesh-share':
                showMeshShareModal(deviceId);
                break;
            case 'guest-access':
                showGuestAccessModal([deviceId]);
                break;

            case 'mesh-port-tcp':
                if (typeof openMeshPortForward === 'function') {
                    openMeshPortForward(deviceId, false);
                } else {
                    Notifications.error(_('mesh.port_unavailable') || 'Port relay module not loaded');
                }
                break;

            case 'mesh-port-udp':
                if (typeof openMeshPortForward === 'function') {
                    openMeshPortForward(deviceId, true);
                } else {
                    Notifications.error(_('mesh.port_unavailable') || 'Port relay module not loaded');
                }
                break;

            case 'mesh-power-wake':
                meshPowerAction(deviceId, 'wake');
                break;

            case 'mesh-power-sleep':
                meshPowerAction(deviceId, 'sleep');
                break;

            case 'mesh-power-reset':
                meshPowerAction(deviceId, 'reset');
                break;

            case 'mesh-power-off':
                meshPowerAction(deviceId, 'off');
                break;

            case 'remote-viewer':
                // Legacy action: route through the unified web remote client.
                _tryAddRemoteTab(deviceId, data);
                break;

            case 'details':
                if (typeof DeviceDetail !== 'undefined') {
                    DeviceDetail.open(deviceId);
                } else {
                    showDeviceDetails(deviceId);
                }
                break;
                
            case 'edit':
                showEditModal(deviceId);
                break;

            case 'groups':
                showDeviceMembershipModal(deviceId);
                break;
                
            case 'toggle-ban':
                // Kebab passes device object (boolean); context menu passes dataset (string)
                await toggleBan(deviceId, data.banned === true || data.banned === 'true');
                break;
                
            case 'change-id':
                await changeDeviceId(deviceId);
                break;
                
            case 'delete':
                await deleteDevice(deviceId);
                break;

            case 'restore':
                await restoreDevice(deviceId);
                break;

            case 'permanent-delete':
                await permanentDeleteDevice(deviceId);
                break;

            case 'access-policy':
                showAccessPolicyModal(deviceId);
                break;
        }
    }
    
    /**
     * Connect to device via RustDesk desktop client (rustdesk:// protocol)
     */
    function connectDesktopClient(deviceId) {
        window.open('rustdesk://' + encodeURIComponent(deviceId), '_blank');
    }

    async function showDeviceGroupModal(group = null) {
        await ensureUserGroupsLoaded();
        const editing = !!group;
        const sourceType = group?.source_type || 'manual';
        const selectedUserGroups = normalizeGuids(group?.allowed_groups || group?.allowed_user_groups);
        const allowedUsersValue = Array.isArray(group?.allowed_users) ? group.allowed_users.join(', ') : String(group?.allowed_users || '');
        const tagOptions = availableTags.map(tag => `<option value="${Utils.escapeHtml(tag)}"></option>`).join('');
        const content = `
            <div class="device-group-form">
                <div class="form-group">
                    <label>${_('devices.group_name') || 'Group name'}</label>
                    <input type="text" id="dg-name" class="form-input" maxlength="80" placeholder="${_('devices.group_name_placeholder') || 'e.g. Media PCs'}" value="${Utils.escapeHtml(group?.name || '')}">
                </div>
                <label class="toggle-row">
                    <input type="checkbox" id="dg-dynamic" ${sourceType === 'tag' ? 'checked' : ''}>
                    <span>${_('devices.dynamic_group') || 'Dynamic group from tag'}</span>
                </label>
                <div class="form-group" id="dg-tag-row" style="opacity:${sourceType === 'tag' ? '1' : '0.5'};pointer-events:${sourceType === 'tag' ? 'auto' : 'none'}">
                    <label>${_('devices.tag_filter') || 'Tag filter'}</label>
                    <input type="text" id="dg-tag" class="form-input" maxlength="50" list="dg-tag-options" placeholder="Linux" value="${Utils.escapeHtml(group?.tag_filter || '')}">
                    <datalist id="dg-tag-options">${tagOptions}</datalist>
                    <p class="form-hint">${_('devices.dynamic_group_hint') || 'Devices with this tag join automatically.'}</p>
                </div>
                <div class="form-group">
                    <label>${_('devices.group_allowed_users') || 'Allowed users'}</label>
                    <input type="text" id="dg-users" class="form-input" placeholder="operator1, operator2" value="${Utils.escapeHtml(allowedUsersValue)}">
                    <p class="form-hint">${_('devices.group_allowed_users_hint') || 'Assign allowed users and/or user groups. Leave empty to hide the group from non-admins.'}</p>
                </div>
                <div class="form-group">
                    <div class="form-label-row">
                        <label>${_('devices.group_allowed_user_groups') || 'Allowed user groups'}</label>
                        <button type="button" class="btn btn-secondary btn-sm" id="dg-manage-user-groups">
                            <span class="material-icons">groups</span>
                            ${_('devices.manage_user_groups') || 'Manage user groups'}
                        </button>
                    </div>
                    <div class="group-membership-list compact">${renderUserGroupAccessOptions(selectedUserGroups)}</div>
                    <p class="form-hint">${_('devices.group_allowed_user_groups_hint') || 'Users in selected user groups can access this device group.'}</p>
                </div>
            </div>`;

        Modal.show({
            title: editing ? (_('devices.edit_group') || 'Edit device group') : (_('devices.create_group') || 'Create device group'),
            content,
            size: 'medium',
            buttons: [
                { label: _('actions.cancel'), class: 'btn-secondary', onClick: () => Modal.close() },
                {
                    label: _('actions.save'), class: 'btn-primary', onClick: async () => {
                        const dynamic = document.getElementById('dg-dynamic').checked;
                        const payload = {
                            guid: group?.guid || '',
                            name: document.getElementById('dg-name').value.trim(),
                            source_type: dynamic ? 'tag' : 'manual',
                            tag_filter: document.getElementById('dg-tag').value.trim(),
                            allowed_users: document.getElementById('dg-users').value,
                            allowed_groups: Array.from(document.querySelectorAll('.dg-user-group:checked')).map(input => input.value)
                        };
                        if (group?.team_id) {
                            payload.team_id = group.team_id;
                        }
                        if (!payload.name) {
                            Notifications.error(_('common.name_required') || 'Name is required');
                            return;
                        }
                        if (payload.source_type === 'tag' && !payload.tag_filter) {
                            Notifications.error(_('devices.group_tag_required') || 'Tag filter is required');
                            return;
                        }
                        try {
                            await Utils.api('/api/device-groups', {
                                method: 'POST',
                                body: payload
                            });
                            Notifications.success(_('devices.group_saved') || 'Device group saved');
                            Modal.close();
                            loadDeviceGroups();
                        } catch (err) {
                            Notifications.error(err.message || _('errors.server_error'));
                        }
                    }
                }
            ]
        });

        const dynamicInput = document.getElementById('dg-dynamic');
        const tagRow = document.getElementById('dg-tag-row');
        dynamicInput?.addEventListener('change', () => {
            tagRow.style.opacity = dynamicInput.checked ? '1' : '0.5';
            tagRow.style.pointerEvents = dynamicInput.checked ? 'auto' : 'none';
        });
        document.getElementById('dg-manage-user-groups')?.addEventListener('click', () => {
            window.location.href = '/users#user-groups';
        });
        document.getElementById('dg-manage-user-groups-empty')?.addEventListener('click', () => {
            window.location.href = '/users#user-groups';
        });
    }

    async function showDeviceMembershipModal(deviceId) {
        try {
            const response = await Utils.api(`/api/devices/${encodeURIComponent(deviceId)}/groups`);
            const groups = response.groups || [];
            const memberships = response.memberships || [];
            const selected = new Set(memberships.map(group => group.guid));
            const manualGroups = groups.filter(group => (group.source_type || 'manual') !== 'tag');
            const dynamicGroups = groups.filter(group => (group.source_type || 'manual') === 'tag' && selected.has(group.guid));

            const manualHtml = manualGroups.length ? manualGroups.map(group => `
                <label class="group-membership-option">
                    <input type="checkbox" value="${Utils.escapeHtml(group.guid)}" ${selected.has(group.guid) ? 'checked' : ''}>
                    <span class="material-icons">hub</span>
                    <span>${Utils.escapeHtml(group.name)}</span>
                </label>`).join('') : `<div class="tag-filter-empty">${_('devices.no_groups') || 'No groups yet'}</div>`;

            const dynamicHtml = dynamicGroups.length ? `
                <div class="form-group">
                    <label>${_('devices.dynamic_memberships') || 'Dynamic memberships'}</label>
                    <div class="device-tags">
                        ${dynamicGroups.map(group => `<span class="device-tag-pill" title="${Utils.escapeHtml(group.tag_filter || '')}">${Utils.escapeHtml(group.name)}</span>`).join('')}
                    </div>
                </div>` : '';

            Modal.show({
                title: (_('devices.manage_groups') || 'Manage Groups') + ' — ' + deviceId,
                content: `
                    <div class="device-group-memberships">
                        <div class="form-group">
                            <label>${_('devices.manual_groups') || 'Manual groups'}</label>
                            <div class="group-membership-list">${manualHtml}</div>
                        </div>
                        ${dynamicHtml}
                    </div>`,
                size: 'medium',
                buttons: [
                    { label: _('actions.cancel'), class: 'btn-secondary', onClick: () => Modal.close() },
                    {
                        label: _('actions.save'), class: 'btn-primary', onClick: async () => {
                            const groupGuids = Array.from(document.querySelectorAll('.group-membership-list input:checked')).map(input => input.value);
                            try {
                                await Utils.api(`/api/devices/${encodeURIComponent(deviceId)}/groups`, {
                                    method: 'PUT',
                                    body: { groupGuids }
                                });
                                Notifications.success(_('devices.groups_saved') || 'Groups saved');
                                Modal.close();
                                loadDevices();
                                loadDeviceGroups();
                            } catch (err) {
                                Notifications.error(err.message || _('errors.server_error'));
                            }
                        }
                    }
                ]
            });
        } catch (error) {
            Notifications.error(error.message || _('errors.server_error'));
        }
    }
    
    function showMeshRunCommandModal(deviceId) {
        Modal.show({
            title: (_('mesh.run_command_title') || 'Run command') + ' — ' + deviceId,
            content: `
                <div class="form-group">
                    <label for="mesh-cmd-input">${_('mesh.command_placeholder') || 'Command'}</label>
                    <textarea id="mesh-cmd-input" class="form-input" rows="4" placeholder="whoami"></textarea>
                </div>
                <label class="toggle-row">
                    <input type="checkbox" id="mesh-cmd-shell" checked>
                    <span>${_('mesh.run_as_shell') || 'Run in shell'}</span>
                </label>`,
            size: 'medium',
            buttons: [
                { label: _('actions.cancel'), class: 'btn-secondary', onClick: () => Modal.close() },
                {
                    label: _('actions.run') || 'Run',
                    class: 'btn-primary',
                    onClick: async () => {
                        const command = document.getElementById('mesh-cmd-input').value;
                        if (!command.trim()) return;
                        const shell = document.getElementById('mesh-cmd-shell').checked;
                        try {
                            await Utils.api('/api/mesh/devices/' + encodeURIComponent(deviceId) + '/exec', {
                                method: 'POST',
                                body: { command: command.trim(), shell },
                            });
                            Notifications.success(_('mesh.command_sent') || 'Command sent');
                            Modal.close();
                        } catch (err) {
                            Notifications.error(err.message || (_('mesh.command_failed') || 'Failed'));
                        }
                    },
                },
            ],
        });
    }

    async function showMeshLinkPeerModal(deviceId, data) {
        const linkedId = data && data.linked_peer_id ? String(data.linked_peer_id) : '';
        Modal.show({
            title: (_('mesh.link_peer_title') || 'Link mesh agent') + ' — ' + deviceId,
            content: `
                <p class="form-hint">${_('mesh.link_peer_hint') || 'Enter RustDesk or CDAP peer ID on the same host. Leave empty to unlink.'}</p>
                <div class="form-group">
                    <label for="mesh-link-peer-id">${_('mesh.linked_peer') || 'Linked device'}</label>
                    <input type="text" id="mesh-link-peer-id" class="form-input" value="${Utils.escapeHtml(linkedId)}" placeholder="PEER_ID">
                </div>`,
            size: 'medium',
            buttons: [
                { label: _('actions.cancel'), class: 'btn-secondary', onClick: () => Modal.close() },
                {
                    label: _('actions.save'),
                    class: 'btn-primary',
                    onClick: async () => {
                        const peerId = document.getElementById('mesh-link-peer-id').value.trim();
                        try {
                            await Utils.api('/api/cdap/devices/' + encodeURIComponent(deviceId) + '/link', {
                                method: 'POST',
                                body: { linked_peer_id: peerId },
                            });
                            Notifications.success(_('mesh.link_saved') || 'Link updated');
                            Modal.close();
                            loadDevices();
                        } catch (err) {
                            Notifications.error(err.message || _('errors.server_error'));
                        }
                    },
                },
            ],
        });
    }

    async function meshPowerAction(deviceId, action) {
        const labels = { sleep: _('mesh.power_sleep') || 'Sleep', reset: _('mesh.power_reset') || 'Reset' };
        const label = labels[action] || action;
        if (!confirm((_('mesh.power_confirm') || 'Send power action') + ': ' + label + '?')) return;
        try {
            await Utils.api('/api/mesh/devices/' + encodeURIComponent(deviceId) + '/power', {
                method: 'POST',
                body: { action },
            });
            Notifications.success(_('mesh.power_sent') || 'Power command sent');
        } catch (err) {
            Notifications.error(err.message || _('errors.server_error'));
        }
    }

    async function showGuestAccessModal(peerIds) {
        const ids = (peerIds || []).filter(Boolean);
        if (!ids.length) return;
        Modal.show({
            title: _('guest_access.create_title') || 'Create guest access link',
            content: `
                <p class="form-hint">${_('guest_access.create_hint') || 'Time-limited RdClient link. Recipients can connect only to the selected devices — no Console login, no full device list.'}</p>
                <div class="form-group">
                    <label>${_('guest_access.devices') || 'Devices'}</label>
                    <div class="form-hint" style="margin:0;">${ids.map((id) => Utils.escapeHtml(id)).join(', ')}</div>
                </div>
                <div class="form-group">
                    <label for="guest-access-ttl">${_('guest_access.ttl') || 'Valid for (minutes)'}</label>
                    <input type="number" id="guest-access-ttl" class="form-input" min="15" max="1440" value="120">
                </div>
                <div class="form-group">
                    <label for="guest-access-label">${_('guest_access.label') || 'Label (optional)'}</label>
                    <input type="text" id="guest-access-label" class="form-input" maxlength="120" placeholder="">
                </div>
                <div class="form-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="guest-access-view-only" checked>
                        ${_('guest_access.view_only') || 'View only'}
                    </label>
                </div>
                <div class="form-group" id="guest-access-result" style="display:none;">
                    <label>${_('guest_access.url') || 'Share URL'}</label>
                    <input type="text" id="guest-access-url" class="form-input" readonly>
                </div>`,
            size: 'medium',
            buttons: [
                { label: _('actions.cancel'), class: 'btn-secondary', onClick: () => Modal.close() },
                {
                    label: _('guest_access.create') || 'Create link',
                    class: 'btn-primary',
                    onClick: async () => {
                        const ttl = parseInt(document.getElementById('guest-access-ttl').value, 10) || 120;
                        const label = (document.getElementById('guest-access-label') || {}).value || '';
                        const viewOnly = !!(document.getElementById('guest-access-view-only') || {}).checked;
                        try {
                            const resp = await Utils.api('/api/guest/access-links', {
                                method: 'POST',
                                body: {
                                    peer_ids: ids,
                                    ttl_minutes: ttl,
                                    view_only: viewOnly,
                                    label: label,
                                },
                            });
                            const data = resp.data || resp;
                            const path = data.path || '';
                            const full = window.location.origin + path;
                            const result = document.getElementById('guest-access-result');
                            const urlInput = document.getElementById('guest-access-url');
                            if (result && urlInput) {
                                urlInput.value = full;
                                result.style.display = 'block';
                                urlInput.select();
                            }
                            Notifications.success(_('guest_access.created') || 'Guest link created');
                        } catch (err) {
                            Notifications.error(err.message || _('errors.server_error'));
                        }
                    },
                },
            ],
        });
    }

    async function showMeshShareModal(deviceId) {
        Modal.show({
            title: (_('mesh.share_link_title') || 'Guest desktop link') + ' — ' + deviceId,
            content: `
                <p class="form-hint">${_('mesh.share_link_hint') || 'Time-limited link for view-only remote desktop (no panel login required).'}</p>
                <div class="form-group">
                    <label for="mesh-share-ttl">${_('mesh.share_ttl') || 'Valid for (minutes)'}</label>
                    <input type="number" id="mesh-share-ttl" class="form-input" min="15" max="1440" value="120">
                </div>
                <div class="form-group" id="mesh-share-result" style="display:none;">
                    <label>${_('mesh.share_url') || 'Share URL'}</label>
                    <input type="text" id="mesh-share-url" class="form-input" readonly>
                </div>`,
            size: 'medium',
            buttons: [
                { label: _('actions.cancel'), class: 'btn-secondary', onClick: () => Modal.close() },
                {
                    label: _('mesh.share_create') || 'Create link',
                    class: 'btn-primary',
                    onClick: async () => {
                        const ttl = parseInt(document.getElementById('mesh-share-ttl').value, 10) || 120;
                        try {
                            const resp = await Utils.api('/api/mesh/devices/' + encodeURIComponent(deviceId) + '/share', {
                                method: 'POST',
                                body: { ttl_minutes: ttl, view_only: true },
                            });
                            const data = resp.data || resp;
                            const path = data.path || '';
                            const full = window.location.origin + path;
                            const result = document.getElementById('mesh-share-result');
                            const urlInput = document.getElementById('mesh-share-url');
                            if (result && urlInput) {
                                urlInput.value = full;
                                result.style.display = 'block';
                            }
                            Notifications.success(_('mesh.share_created') || 'Link created');
                        } catch (err) {
                            Notifications.error(err.message || _('errors.server_error'));
                        }
                    },
                },
            ],
        });
    }

    /**
     * Show device details modal
     */
    async function showDeviceDetails(deviceId) {
        try {
            const device = await Utils.api(`/api/devices/${deviceId}`);
            
            const content = `
                <div class="device-details">
                    <div class="detail-row">
                        <span class="detail-label">${_('devices.id')}:</span>
                        <span class="detail-value"><strong>${Utils.escapeHtml(device.id)}</strong></span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">${_('devices.hostname')}:</span>
                        <span class="detail-value">${Utils.escapeHtml(device.display_name || device.hostname || device.note || '-')}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">${_('devices.platform')}:</span>
                        <span class="detail-value">${Utils.escapeHtml(device.platform || '-')}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">${_('status.label')}:</span>
                        <span class="detail-value">${deviceStatusInfo(device).label}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">${_('devices.last_online')}:</span>
                        <span class="detail-value">${Utils.formatDate(device.last_online)}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">${_('devices.created')}:</span>
                        <span class="detail-value">${Utils.formatDate(device.created_at)}</span>
                    </div>
                    ${device.ban_reason ? `
                    <div class="detail-row">
                        <span class="detail-label">${_('devices.ban_reason')}:</span>
                        <span class="detail-value">${Utils.escapeHtml(device.ban_reason)}</span>
                    </div>
                    ` : ''}
                </div>
            `;
            
            Modal.show({
                title: _('devices.details'),
                content: content,
                size: 'medium',
                buttons: [
                    { label: _('actions.ok'), class: 'btn-primary', onClick: () => Modal.close() }
                ]
            });
        } catch (error) {
            Notifications.error(error.message || _('errors.load_device_failed'));
        }
    }

    /**
     * Show Access Policy modal for unattended access management
     */
    async function showAccessPolicyModal(deviceId) {
        try {
            const resp = await Utils.api(`/api/devices/${deviceId}/access-policy`);
            const policy = resp.data || resp;

            const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
            const activeDays = (policy.schedule_days || '').split(',').map(d => d.trim().toLowerCase()).filter(Boolean);

            const dayCheckboxes = days.map(d => {
                const checked = activeDays.includes(d) ? 'checked' : '';
                const label = _('days.' + d) || d.charAt(0).toUpperCase() + d.slice(1);
                return `<label class="day-checkbox"><input type="checkbox" name="schedule_day" value="${d}" ${checked}> ${label}</label>`;
            }).join('');

            const content = `
                <div class="access-policy-form">
                    <div class="form-section">
                        <h4><span class="material-icons">vpn_key</span> ${_('devices.unattended_access') || 'Unattended Access'}</h4>
                        <label class="toggle-row">
                            <input type="checkbox" id="ap-unattended" ${policy.unattended_enabled ? 'checked' : ''}>
                            <span>${_('devices.enable_unattended') || 'Enable unattended access'}</span>
                        </label>
                        <label class="toggle-row">
                            <input type="checkbox" id="ap-passwordless-server" ${policy.passwordless_server_access !== false ? 'checked' : ''}>
                            <span>${_('devices.passwordless_server_access') || 'Passwordless server access'}</span>
                        </label>
                        <p class="form-hint">${dt('devices.passwordless_server_access_hint', 'When enabled, RdClient uses the Access Password from the server before any password remembered on this device. When disabled, the locally remembered password is tried first.')}</p>
                    </div>
                    <div class="form-section">
                        <h4><span class="material-icons">lock</span> ${_('devices.access_password') || 'Access Password'}</h4>
                        <p class="form-hint">${!policy.connect_secret_codec
                            ? '<span class="badge badge-warning">' + dt('devices.password_codec_unavailable', 'Server cannot seal passwords yet — update/restart betterdesk-server (look for “connect-secret codec ready” in logs)') + '</span>'
                            : (policy.password_set
                                ? (policy.connect_secret_ready
                                    ? '<span class="badge badge-success">✓ ' + dt('devices.password_auto_auth_ready', 'Password set — auto-connect ready') + '</span>'
                                    : '<span class="badge badge-warning">' + dt('devices.password_needs_reseal', 'Password set but not sealed — enter it again below and Save') + '</span>')
                                : '<span class="badge badge-warning">' + dt('devices.no_password', 'No password') + '</span>')}</p>
                        <p class="form-hint">${dt('devices.password_auto_auth_hint', 'For unattended auto-connect, type the device password and Save (required once after this update). After changing it here, wait up to ~30 seconds (or restart Support Agent) so the device applies the new password before connecting.')}</p>
                        <div class="form-row">
                            <input type="password" id="ap-password" class="form-input" placeholder="${_('devices.new_password') || 'New password (leave empty to keep current)'}" autocomplete="new-password">
                        </div>
                        <label class="toggle-row">
                            <input type="checkbox" id="ap-clear-password">
                            <span>${_('devices.clear_password') || 'Clear password'}</span>
                        </label>
                    </div>
                    <div class="form-section">
                        <h4><span class="material-icons">schedule</span> ${_('devices.access_schedule') || 'Access Schedule'}</h4>
                        <label class="toggle-row">
                            <input type="checkbox" id="ap-schedule" ${policy.schedule_enabled ? 'checked' : ''}>
                            <span>${_('devices.enable_schedule') || 'Enable time-based access'}</span>
                        </label>
                        <div id="ap-schedule-fields" style="${policy.schedule_enabled ? '' : 'opacity:0.5;pointer-events:none'}">
                            <div class="form-row">
                                <label>${_('devices.allowed_days') || 'Allowed days'}:</label>
                                <div class="day-checkboxes">${dayCheckboxes}</div>
                            </div>
                            <div class="form-row form-row-inline">
                                <div>
                                    <label>${_('devices.start_time') || 'Start time'}:</label>
                                    <input type="time" id="ap-start-time" class="form-input" value="${policy.schedule_start_time || '08:00'}">
                                </div>
                                <div>
                                    <label>${_('devices.end_time') || 'End time'}:</label>
                                    <input type="time" id="ap-end-time" class="form-input" value="${policy.schedule_end_time || '18:00'}">
                                </div>
                            </div>
                            <div class="form-row">
                                <label>${_('devices.timezone') || 'Timezone'}:</label>
                                <input type="text" id="ap-timezone" class="form-input" placeholder="Europe/Warsaw" value="${Utils.escapeHtml(policy.schedule_timezone || Intl.DateTimeFormat().resolvedOptions().timeZone)}">
                            </div>
                        </div>
                    </div>
                    <div class="form-section">
                        <h4><span class="material-icons">people</span> ${_('devices.allowed_operators') || 'Allowed Operators'}</h4>
                        <div class="form-row">
                            <input type="text" id="ap-operators" class="form-input" placeholder="${_('devices.all_operators') || 'All operators (leave empty)'}" value="${Utils.escapeHtml(policy.allowed_operators || '')}">
                            <p class="form-hint">${_('devices.operators_hint') || 'Comma-separated usernames. Leave empty to allow all operators.'}</p>
                        </div>
                    </div>
                    ${policy.updated_by ? `<p class="form-meta">${_('devices.last_updated_by') || 'Last updated by'}: ${Utils.escapeHtml(policy.updated_by)} ${policy.updated_at ? '(' + Utils.formatDate(policy.updated_at) + ')' : ''}</p>` : ''}
                </div>
            `;

            Modal.show({
                title: (_('devices.access_policy') || 'Access Policy') + ' — ' + deviceId,
                content: content,
                size: 'large',
                buttons: [
                    { label: _('actions.cancel'), class: 'btn-secondary', onClick: () => Modal.close() },
                    {
                        label: _('actions.save'), class: 'btn-primary', onClick: async () => {
                            const scheduleCheckbox = document.getElementById('ap-schedule');
                            const unattended = document.getElementById('ap-unattended').checked;
                            const password = document.getElementById('ap-password').value;
                            const clearPw = document.getElementById('ap-clear-password').checked;
                            if (unattended && !clearPw && !password && !policy.connect_secret_ready) {
                                Notifications.error(dt('devices.password_required_for_unattended',
                                    'Enter the access password to enable unattended auto-connect'));
                                document.getElementById('ap-password').focus();
                                return;
                            }
                            const selectedDays = Array.from(document.querySelectorAll('input[name="schedule_day"]:checked')).map(cb => cb.value);
                            const payload = {
                                unattended_enabled: unattended,
                                password: password,
                                clear_password: clearPw,
                                passwordless_server_access: document.getElementById('ap-passwordless-server')
                                    ? document.getElementById('ap-passwordless-server').checked
                                    : true,
                                schedule_enabled: scheduleCheckbox ? scheduleCheckbox.checked : false,
                                schedule_days: selectedDays.join(','),
                                schedule_start_time: document.getElementById('ap-start-time') ? document.getElementById('ap-start-time').value : '',
                                schedule_end_time: document.getElementById('ap-end-time') ? document.getElementById('ap-end-time').value : '',
                                schedule_timezone: document.getElementById('ap-timezone') ? document.getElementById('ap-timezone').value : '',
                                allowed_operators: document.getElementById('ap-operators') ? document.getElementById('ap-operators').value : ''
                            };

                            try {
                                const saved = await Utils.api(`/api/devices/${deviceId}/access-policy`, {
                                    method: 'PUT',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify(payload)
                                });
                                // Defense: some proxies return HTTP 200 with {success:false}.
                                if (saved && saved.success === false) {
                                    throw new Error(saved.error || 'Failed to save access policy');
                                }
                                Notifications.success(dt('devices.access_policy_saved_reseal',
                                    'Access policy saved. If using Support Agent, wait ~2 min or restart the agent so it picks up the password.'));
                                Modal.close();
                            } catch (err) {
                                Notifications.error(err.message || 'Failed to save access policy');
                            }
                        }
                    }
                ]
            });

            // Toggle schedule fields on checkbox change
            const scheduleChk = document.getElementById('ap-schedule');
            const scheduleFields = document.getElementById('ap-schedule-fields');
            if (scheduleChk && scheduleFields) {
                scheduleChk.addEventListener('change', () => {
                    scheduleFields.style.opacity = scheduleChk.checked ? '1' : '0.5';
                    scheduleFields.style.pointerEvents = scheduleChk.checked ? 'auto' : 'none';
                });
            }

        } catch (error) {
            Notifications.error(error.message || 'Failed to load access policy');
        }
    }

    /**
     * Toggle device ban status
     */
    async function toggleBan(deviceId, currentlyBanned) {
        const action = currentlyBanned ? 'unban' : 'ban';
        const confirmed = await Modal.confirm({
            title: _(`devices.${action}_title`),
            message: _(`devices.${action}_confirm`, { id: deviceId }),
            confirmLabel: _(currentlyBanned ? 'actions.unban' : 'actions.ban'),
            danger: !currentlyBanned
        });
        
        if (!confirmed) return;
        
        try {
            await Utils.api(`/api/devices/${deviceId}/${action}`, { method: 'POST' });
            Notifications.success(_(`devices.${action}_success`));
            loadDevices();
        } catch (error) {
            Notifications.error(error.message || _(`errors.${action}_failed`));
        }
    }
    
    /**
     * Change device ID
     */
    async function changeDeviceId(deviceId) {
        const device = devices.find(d => d.id === deviceId);
        if (device?.online) {
            const proceed = await Modal.confirm({
                title: _('devices.change_id_title'),
                message: _('devices.change_id_online_warn'),
                confirmLabel: _('devices.change_id'),
                danger: false
            });
            if (!proceed) return;
        }

        const newId = await Modal.prompt({
            title: _('devices.change_id_title'),
            label: _('devices.new_id'),
            placeholder: 'NEWID123',
            hint: _('devices.change_id_hint')
        });
        
        if (!newId) return;
        
        // Validate
        if (newId.length < 6 || newId.length > 16) {
            Notifications.error(_('devices.id_length_error'));
            return;
        }
        
        if (!/^[A-Z0-9_-]+$/i.test(newId)) {
            Notifications.error(_('devices.id_format_error'));
            return;
        }
        
        try {
            await Utils.api(`/api/devices/${deviceId}/change-id`, {
                method: 'POST',
                body: { newId }
            });
            Notifications.success(_('devices.change_id_success'));
            loadDevices();
        } catch (error) {
            Notifications.error(error.message || _('errors.change_id_failed'));
        }
    }
    
    /**
     * Delete device with delayed confirmation
     */
    async function deleteDevice(deviceId) {
        const device = devices.find(d => d.id === deviceId);
        if (device?.soft_deleted) {
            await permanentDeleteDevice(deviceId);
            return;
        }

        return new Promise((resolve) => {
            const modalHtml = `
                <div class="modal-overlay delete-confirm-modal" id="delete-modal-${deviceId}">
                    <div class="modal-container modal-danger">
                        <div class="modal-header">
                            <h3 class="modal-title">
                                <span class="material-icons" style="color: var(--accent-red);">warning</span>
                                ${_('devices.delete_title')}
                            </h3>
                        </div>
                        <div class="modal-body">
                            <p class="delete-warning">${_('devices.delete_warning')}</p>
                            <p class="delete-device-id"><strong>${Utils.escapeHtml(deviceId)}</strong></p>
                            <p class="delete-info">${_('devices.delete_permanent')}</p>
                            <div class="revoke-options" style="margin-top: 12px; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px;">
                                <label class="checkbox-label" style="display: flex; align-items: center; gap: 8px; cursor: pointer; margin-bottom: 6px;">
                                    <input type="checkbox" id="revoke-check-${deviceId}" />
                                    <span class="material-icons" style="font-size: 18px; color: var(--accent-red);">block</span>
                                    <span>${_('devices.revoke_option')}</span>
                                </label>
                                <p class="revoke-hint" style="font-size: 0.8rem; opacity: 0.7; margin: 0 0 0 30px;">
                                    ${_('devices.revoke_hint')}
                                </p>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button class="btn btn-secondary cancel-btn">${_('actions.cancel')}</button>
                            <button class="btn btn-danger confirm-delete-btn" disabled>
                                <span class="material-icons">delete_forever</span>
                                <span class="btn-text">${_('actions.delete')} (<span class="countdown">3</span>)</span>
                            </button>
                        </div>
                    </div>
                </div>
            `;
            
            document.body.insertAdjacentHTML('beforeend', modalHtml);
            
            const modal = document.getElementById(`delete-modal-${deviceId}`);
            const confirmBtn = modal.querySelector('.confirm-delete-btn');
            const cancelBtn = modal.querySelector('.cancel-btn');
            const countdownEl = confirmBtn.querySelector('.countdown');
            const revokeCheck = document.getElementById(`revoke-check-${deviceId}`);
            
            let countdown = 3;
            const timer = setInterval(() => {
                countdown--;
                if (countdownEl) {
                    countdownEl.textContent = countdown;
                }
                if (countdown <= 0) {
                    clearInterval(timer);
                    confirmBtn.disabled = false;
                    const btnText = confirmBtn.querySelector('.btn-text');
                    if (btnText) btnText.textContent = _('actions.delete');
                }
            }, 1000);
            
            const closeModal = () => {
                clearInterval(timer);
                modal.remove();
            };
            
            cancelBtn.addEventListener('click', () => {
                closeModal();
                resolve(false);
            });
            
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    closeModal();
                    resolve(false);
                }
            });
            
            confirmBtn.addEventListener('click', async () => {
                if (confirmBtn.disabled) return;
                const revoke = revokeCheck && revokeCheck.checked;
                closeModal();
                
                try {
                    const params = new URLSearchParams();
                    if (revoke) params.set('revoke', 'true');
                    const qs = params.toString();
                    const url = `/api/devices/${deviceId}${qs ? '?' + qs : ''}`;
                    await Utils.api(url, { method: 'DELETE' });
                    const msg = revoke ? _('devices.revoke_success') : _('devices.delete_success');
                    Notifications.success(msg);
                    loadDevices();
                    resolve(true);
                } catch (error) {
                    Notifications.error(error.message || _('errors.delete_failed'));
                    resolve(false);
                }
            });
        });
    }

    async function restoreDevice(deviceId) {
        const confirmed = await Modal.confirm({
            title: _('devices.restore_title'),
            message: _('devices.restore_confirm', { id: deviceId }),
            confirmLabel: _('devices.restore_action'),
            danger: false
        });
        if (!confirmed) return;

        try {
            await Utils.api(`/api/devices/${encodeURIComponent(deviceId)}/restore`, { method: 'POST' });
            Notifications.success(_('devices.restore_success'));
            loadDevices();
        } catch (error) {
            Notifications.error(error.message || _('devices.restore_failed'));
        }
    }

    async function permanentDeleteDevice(deviceId) {
        const confirmed = await Modal.confirm({
            title: _('devices.permanent_delete_title'),
            message: _('devices.permanent_delete_confirm', { id: deviceId }),
            confirmLabel: _('actions.delete'),
            danger: true
        });
        if (!confirmed) return;

        try {
            await Utils.api(`/api/devices/${encodeURIComponent(deviceId)}?hard=true`, { method: 'DELETE' });
            Notifications.success(_('devices.permanent_delete_success'));
            loadDevices();
        } catch (error) {
            Notifications.error(error.message || _('errors.delete_failed'));
        }
    }
    
    /**
     * Show edit modal
     */
    function showEditModal(deviceId) {
        const device = devices.find(d => d.id === deviceId);
        if (!device) return;
        
        Modal.show({
            title: _('devices.edit_title'),
            content: `
                <div class="device-info-grid">
                    <div class="device-info-item">
                        <label>${_('devices.id')}</label>
                        <span>${Utils.escapeHtml(device.id)}</span>
                    </div>
                    <div class="device-info-item">
                        <label>${_('devices.hostname')}</label>
                        <span>${Utils.escapeHtml(device.hostname || '-')}</span>
                    </div>
                    <div class="device-info-item full-width">
                        <label for="edit-display-name">${_('devices.display_name')}</label>
                        <input type="text" id="edit-display-name" class="form-input" 
                               value="${Utils.escapeHtml(device.display_name || '')}" 
                               placeholder="${_('devices.display_name_placeholder')}" maxlength="128" />
                    </div>
                    <div class="device-info-item full-width">
                        <label for="edit-note">${_('devices.note')}</label>
                        <textarea id="edit-note" class="form-input" rows="2" 
                                  placeholder="${_('devices.note_placeholder')}" maxlength="512">${Utils.escapeHtml(device.note || '')}</textarea>
                    </div>
                    <div class="device-info-item">
                        <label>${_('devices.username')}</label>
                        <span>${Utils.escapeHtml(device.username || '-')}</span>
                    </div>
                    <div class="device-info-item">
                        <label>${_('devices.platform')}</label>
                        <span>${Utils.escapeHtml(device.platform || '-')}</span>
                    </div>
                    <div class="device-info-item">
                        <label>${_('devices.version')}</label>
                        <span>${Utils.escapeHtml(device.version || '-')}</span>
                    </div>
                    <div class="device-info-item">
                        <label>${_('devices.first_seen')}</label>
                        <span>${Utils.formatDate(device.created_at)}</span>
                    </div>
                    <div class="device-info-item">
                        <label>${_('devices.last_seen')}</label>
                        <span>${Utils.formatDate(device.last_online)}</span>
                    </div>
                </div>
            `,
            buttons: [
                { label: _('actions.save'), class: 'btn-primary', onClick: async () => {
                    const displayName = document.getElementById('edit-display-name').value.trim();
                    const note = document.getElementById('edit-note').value.trim();
                    const saveBtn = document.querySelector('.modal-overlay.open [data-btn-index="0"]');
                    const closeBtn = document.querySelector('.modal-overlay.open [data-btn-index="1"]');
                    const restoreButtons = () => {
                        if (saveBtn) {
                            saveBtn.disabled = false;
                            saveBtn.textContent = _('actions.save');
                        }
                        if (closeBtn) closeBtn.disabled = false;
                    };

                    if (saveBtn) {
                        saveBtn.disabled = true;
                        saveBtn.textContent = _('common.loading');
                    }
                    if (closeBtn) closeBtn.disabled = true;

                    try {
                        await Utils.api(`/api/devices/${encodeURIComponent(device.id)}`, {
                            method: 'PATCH',
                            body: JSON.stringify({ display_name: displayName, note }),
                            headers: { 'Content-Type': 'application/json' }
                        });

                        device.display_name = displayName;
                        device.note = note;
                        applyFilters();
                        document.dispatchEvent(new CustomEvent('devices:updated', {
                            detail: {
                                id: device.id,
                                display_name: displayName,
                                note: note
                            }
                        }));

                        if (saveBtn) {
                            saveBtn.textContent = _('common.saved');
                        }

                        Notifications.success(_('common.saved'), _('devices.display_name'));
                        setTimeout(() => Modal.close(), 250);
                        loadDevices();
                    } catch (err) {
                        restoreButtons();
                        Notifications.error(err.message || _('errors.server_error'));
                    }
                }},
                { label: _('actions.close'), class: 'btn-secondary', onClick: () => Modal.close() }
            ],
            size: 'medium'
        });
    }

    window.BetterDeskDevices = window.BetterDeskDevices || {};
    window.BetterDeskDevices.showEditModal = showEditModal;
    
    /**
     * Render pagination
     */
    function renderPagination() {
        const totalPages = Math.ceil(filteredDevices.length / perPage);
        const paginationInfo = document.getElementById('pagination-info');
        const paginationControls = document.getElementById('pagination-controls');
        
        // Update info
        const start = Math.min((currentPage - 1) * perPage + 1, filteredDevices.length);
        const end = Math.min(currentPage * perPage, filteredDevices.length);
        paginationInfo.textContent = `${_('devices.showing')} ${start}-${end} ${_('devices.of')} ${filteredDevices.length}`;
        
        // Generate controls
        let html = '';
        
        html += `<button class="pagination-btn" ${currentPage === 1 ? 'disabled' : ''} data-page="${currentPage - 1}">
            <span class="material-icons">chevron_left</span>
        </button>`;
        
        // Page numbers
        for (let i = 1; i <= totalPages; i++) {
            if (i === 1 || i === totalPages || (i >= currentPage - 1 && i <= currentPage + 1)) {
                html += `<button class="pagination-btn ${i === currentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
            } else if (i === currentPage - 2 || i === currentPage + 2) {
                html += `<span style="padding: 0 4px;">...</span>`;
            }
        }
        
        html += `<button class="pagination-btn" ${currentPage === totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">
            <span class="material-icons">chevron_right</span>
        </button>`;
        
        paginationControls.innerHTML = html;
        
        // Event listeners
        paginationControls.querySelectorAll('.pagination-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const page = parseInt(btn.dataset.page);
                if (page && page !== currentPage && page >= 1 && page <= totalPages) {
                    currentPage = page;
                    renderDevices();
                    renderPagination();
                }
            });
        });
    }
    
    /**
     * Update empty state
     */
    function updateEmptyState() {
        const tableContainer = document.querySelector('.devices-table-container');
        
        if (filteredDevices.length === 0) {
            tableContainer.classList.add('hidden');
            emptyState.classList.remove('hidden');
        } else {
            tableContainer.classList.remove('hidden');
            emptyState.classList.add('hidden');
        }
    }
    
    /**
     * Initialize search
     */
    function initSearch() {
        const searchInput = document.getElementById('search-input');
        if (!searchInput) return;
        
        searchInput.addEventListener('input', Utils.debounce((e) => {
            searchQuery = e.target.value.trim();
            currentPage = 1;
            applyFilters();
        }, 300));
    }
    
    /**
     * Initialize filters
     */
    function initFilters() {
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentFilter = btn.dataset.filter;
                currentPage = 1;
                applyFilters();
            });
        });
    }

    function initShowDeletedToggle() {
        const input = document.getElementById('show-deleted-input');
        if (!input) return;
        input.addEventListener('change', () => {
            showDeleted = !!input.checked;
            localStorage.setItem(STORAGE_SHOW_DELETED, showDeleted ? '1' : '0');
            currentPage = 1;
            loadDevices();
        });
    }
    
    /**
     * Initialize sorting
     */
    function initSorting() {
        document.querySelectorAll('th.sortable').forEach(th => {
            th.addEventListener('click', () => {
                const field = th.dataset.sort;
                if (currentSort.field === field) {
                    currentSort.order = currentSort.order === 'asc' ? 'desc' : 'asc';
                } else {
                    currentSort.field = field;
                    currentSort.order = 'asc';
                }
                applyFilters();
            });
        });
    }
    
    /**
     * Initialize selection
     */
    function initSelection() {
        const selectAll = document.getElementById('select-all');
        if (!selectAll) return;
        
        selectAll.addEventListener('change', () => {
            const checkboxes = tableBody.querySelectorAll('.device-checkbox');
            checkboxes.forEach(cb => {
                cb.checked = selectAll.checked;
                const id = cb.dataset.id;
                if (selectAll.checked) {
                    selectedIds.add(id);
                } else {
                    selectedIds.delete(id);
                }
            });
            updateSelectionUI();
        });
    }
    
    /**
     * Update selection UI
     */
    function updateSelectionUI() {
        if (selectedIds.size > 0) {
            bulkActions.classList.remove('hidden');
            selectedCountEl.textContent = selectedIds.size;
        } else {
            bulkActions.classList.add('hidden');
        }
        
        // Update select all checkbox
        const selectAll = document.getElementById('select-all');
        const checkboxes = tableBody.querySelectorAll('.device-checkbox');
        selectAll.checked = checkboxes.length > 0 && selectedIds.size === checkboxes.length;
        selectAll.indeterminate = selectedIds.size > 0 && selectedIds.size < checkboxes.length;
    }
    
    /**
     * Initialize bulk actions
     */
    function initBulkActions() {
        document.getElementById('clear-selection')?.addEventListener('click', () => {
            selectedIds.clear();
            tableBody.querySelectorAll('.device-checkbox').forEach(cb => cb.checked = false);
            document.getElementById('select-all').checked = false;
            updateSelectionUI();
        });
        
        document.getElementById('bulk-delete')?.addEventListener('click', async () => {
            const count = selectedIds.size;
            const confirmed = await Modal.confirm({
                title: _('devices.bulk_delete_title'),
                message: _('devices.bulk_delete_confirm', { count }),
                confirmLabel: _('actions.delete'),
                confirmIcon: 'delete',
                danger: true
            });
            
            if (!confirmed) return;
            
            try {
                await Utils.api('/api/devices/bulk-delete', {
                    method: 'POST',
                    body: { ids: Array.from(selectedIds) }
                });
                Notifications.success(_('devices.bulk_delete_success', { count }));
                selectedIds.clear();
                loadDevices();
            } catch (error) {
                Notifications.error(error.message || _('errors.bulk_delete_failed'));
            }
        });
    }
    
    /**
     * Initialize sync button
     */
    function initSync() {
        document.getElementById('sync-btn')?.addEventListener('click', async () => {
            try {
                await Utils.api('/api/sync-status', { method: 'POST' });
                Notifications.success(_('devices.sync_success'));
                loadDevices();
            } catch (error) {
                Notifications.error(error.message || _('errors.sync_failed'));
            }
        });
    }

    // ==================== Tag and Device Group Filters ====================

    async function loadTags() {
        try {
            const response = await fetchOnce('/api/tags', () => Utils.api('/api/tags'));
            availableTags = response.tags || [];
            renderTagFilters();
        } catch (error) {
            console.error('Failed to load tags:', error);
        }
    }

    function renderTagFilters() {
        const menu = document.getElementById('tags-filter-menu');
        const btn = document.getElementById('tags-filter-btn');
        if (!menu) return;

        if (!availableTags.length) {
            menu.innerHTML = `<div class="tag-filter-empty">${_('devices.no_tags') || 'No tags'}</div>`;
        } else {
            menu.innerHTML = availableTags.map(tag => {
                const checked = selectedTags.has(tag) ? 'checked' : '';
                return `<label class="tag-filter-option">
                    <input type="checkbox" value="${Utils.escapeHtml(tag)}" ${checked}>
                    <span>${Utils.escapeHtml(tag)}</span>
                </label>`;
            }).join('');
        }

        menu.querySelectorAll('input[type="checkbox"]').forEach(input => {
            input.addEventListener('change', () => {
                if (input.checked) selectedTags.add(input.value);
                else selectedTags.delete(input.value);
                currentPage = 1;
                if (btn) btn.classList.toggle('tag-filter-active', selectedTags.size > 0);
                applyFilters();
            });
        });

        if (btn) btn.classList.toggle('tag-filter-active', selectedTags.size > 0);
    }

    function initTagFilter() {
        const btn = document.getElementById('tags-filter-btn');
        const menu = document.getElementById('tags-filter-menu');
        if (!btn || !menu) return;
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            menu.classList.toggle('show');
        });
        menu.addEventListener('click', (e) => e.stopPropagation());
        document.addEventListener('click', (e) => {
            if (!btn.contains(e.target) && !menu.contains(e.target)) menu.classList.remove('show');
        });
    }

    async function loadDeviceGroups() {
        try {
            const response = await fetchOnce('/api/device-groups', () => Utils.api('/api/device-groups'));
            deviceGroups = response.groups || [];
            window._betterdesk_device_groups = deviceGroups;
            renderDeviceGroups();
            updateGroupCounts();
        } catch (error) {
            console.error('Failed to load device groups:', error);
        }
    }

    function renderDeviceGroups() {
        const container = document.getElementById('custom-device-groups');
        if (!container) return;
        container.innerHTML = deviceGroups.map(group => {
            const isDynamic = (group.source_type || 'manual') === 'tag';
            return `<span class="group-chip ${currentGroup === group.guid ? 'active' : ''} ${isDynamic ? 'dynamic' : ''}" data-group="${Utils.escapeHtml(group.guid)}" role="button" tabindex="0" title="${Utils.escapeHtml(isDynamic ? (_('devices.dynamic_group_hint') || 'Dynamic tag group') + ': ' + group.tag_filter : group.name)}">
                <span class="material-icons chip-icon">${isDynamic ? 'sell' : 'hub'}</span>
                <span class="chip-label">${Utils.escapeHtml(group.name)}</span>
                <span class="chip-count">${group.member_count || 0}</span>
                <span class="chip-actions">
                    <button type="button" class="chip-action group-chip-action" data-action="edit" data-group="${Utils.escapeHtml(group.guid)}" title="${_('devices.edit_group') || 'Edit group'}">
                        <span class="material-icons">edit</span>
                    </button>
                    <button type="button" class="chip-action group-chip-action group-delete" data-action="delete" data-group="${Utils.escapeHtml(group.guid)}" title="${_('devices.delete_group') || 'Delete group'}">
                        <span class="material-icons">delete</span>
                    </button>
                </span>
            </span>`;
        }).join('');

        container.querySelectorAll('.group-chip').forEach(el => {
            el.addEventListener('click', (event) => {
                if (event.target.closest('.group-chip-action')) return;
                selectDeviceGroup(el.dataset.group);
            });
            el.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                selectDeviceGroup(el.dataset.group);
            });
            attachChipContextMenu(el, { type: 'group', guid: el.dataset.group });
        });

        container.querySelectorAll('.group-chip-action').forEach(btn => {
            btn.addEventListener('click', async (event) => {
                event.preventDefault();
                event.stopPropagation();
                const group = deviceGroups.find(item => item.guid === btn.dataset.group);
                if (!group) return;
                if (btn.dataset.action === 'edit') {
                    await showDeviceGroupModal(group);
                } else if (btn.dataset.action === 'delete') {
                    await deleteDeviceGroup(group);
                }
            });
        });

        attachGroupDropEvents();
    }

    async function deleteDeviceGroup(group) {
        const confirmed = await Modal.confirm({
            title: _('devices.delete_group') || 'Delete group',
            message: (_('devices.delete_group_confirm') || 'Delete device group {name}?').replace('{name}', group.name),
            confirmLabel: _('actions.delete'),
            danger: true
        });
        if (!confirmed) return;

        try {
            await Utils.api(`/api/device-groups/${encodeURIComponent(group.guid)}`, { method: 'DELETE' });
            Notifications.success(_('devices.group_deleted') || 'Device group deleted');
            if (currentGroup === group.guid) selectDeviceGroup('all');
            loadDeviceGroups();
            loadDevices();
        } catch (error) {
            Notifications.error(error.message || _('errors.server_error'));
        }
    }

    function updateGroupCounts() {
        const allCount = document.getElementById('group-count-all');
        if (allCount) allCount.textContent = devices.length;
        for (const group of deviceGroups) {
            const count = devices.filter(device => deviceMatchesGroup(device, group)).length;
            const chip = Array.from(document.querySelectorAll('.group-chip[data-group]')).find(el => el.dataset.group === group.guid);
            const countEl = chip ? chip.querySelector('.chip-count') : null;
            if (countEl) countEl.textContent = count;
        }
    }

    function selectDeviceGroup(groupGuid) {
        currentGroup = groupGuid || 'all';
        currentFolder = 'all';
        currentPage = 1;
        document.querySelectorAll('.group-chip').forEach(el => {
            el.classList.toggle('active', el.dataset.group === currentGroup);
        });
        document.querySelectorAll('.folder-chip').forEach(el => {
            el.classList.toggle('active', el.dataset.folder === 'all');
        });
        applyFilters();
    }

    function initDeviceGroups() {
        document.getElementById('add-device-group-btn')?.addEventListener('click', () => showDeviceGroupModal());
        document.querySelector('.group-chip[data-group="all"]')?.addEventListener('click', () => selectDeviceGroup('all'));
    }

    const RUSTDESK_STRATEGY_PERM_KEYS = [
        { key: 'enable-file-transfer', labelKey: 'devices.strategy_perm_file_transfer' },
        { key: 'disable-clipboard', labelKey: 'devices.strategy_perm_disable_clipboard' },
        { key: 'enable-clipboard', labelKey: 'devices.strategy_perm_enable_clipboard' },
        { key: 'enable-audio', labelKey: 'devices.strategy_perm_audio' },
        { key: 'enable-tunnel', labelKey: 'devices.strategy_perm_tunnel' },
        { key: 'enable-camera', labelKey: 'devices.strategy_perm_camera' },
        { key: 'enable-remote-restart', labelKey: 'devices.strategy_perm_restart' },
        { key: 'enable-block-input', labelKey: 'devices.strategy_perm_block_input' },
    ];

    async function loadStrategies() {
        try {
            const response = await fetchOnce('/api/panel/strategies', () => Utils.api('/api/panel/strategies'));
            accessStrategies = response.strategies || [];
            strategiesLoaded = true;
            renderStrategies();
        } catch (error) {
            console.error('Failed to load strategies:', error);
            strategiesLoaded = true;
            accessStrategies = [];
            renderStrategies();
        }
    }

    function renderStrategies() {
        const container = document.getElementById('devices-strategies-list');
        if (!container) return;
        if (!strategiesLoaded) {
            container.innerHTML = `<div class="empty-state-inline">${_('devices.loading_strategies')}</div>`;
            return;
        }
        if (!accessStrategies.length) {
            container.innerHTML = `<div class="empty-state-inline">${_('devices.no_strategies')}</div>`;
            return;
        }

        const userGroupName = (guid) => {
            const group = availableUserGroups.find(item => item.guid === guid);
            return group ? group.name : (guid || _('devices.strategy_any_user_group'));
        };
        const deviceGroupName = (guid) => {
            const group = deviceGroups.find(item => item.guid === guid);
            return group ? group.name : (guid || _('devices.strategy_any_device_group'));
        };

        container.innerHTML = accessStrategies.map(strategy => {
            const enabled = strategy.enabled !== false;
            const permCount = Object.keys(strategy.permissions || {}).length;
            return `<div class="strategy-manager-item ${enabled ? '' : 'strategy-disabled'}" data-guid="${Utils.escapeHtml(strategy.guid)}">
                <div class="strategy-manager-main">
                    <span class="material-icons">policy</span>
                    <div class="strategy-manager-text">
                        <strong>${Utils.escapeHtml(strategy.name)}</strong>
                        <span>${Utils.escapeHtml(userGroupName(strategy.user_group_guid))} → ${Utils.escapeHtml(deviceGroupName(strategy.device_group_guid))}</span>
                        <span class="strategy-perm-count">${_('devices.strategy_permissions_count', { count: permCount }) || permCount + ' settings'}</span>
                        <span class="strategy-assign-count" data-guid="${Utils.escapeHtml(strategy.guid)}">${_('devices.strategy_assign_none')}</span>
                    </div>
                </div>
                <span class="strategy-status-badge ${enabled ? 'enabled' : 'disabled'}">${enabled ? _('devices.strategy_enabled') : _('devices.strategy_disabled')}</span>
                <div class="strategy-manager-actions">
                    <button type="button" class="action-btn" data-action="assign-strategy" data-guid="${Utils.escapeHtml(strategy.guid)}" title="${_('devices.strategy_assign')}">
                        <span class="material-icons">link</span>
                    </button>
                    <button type="button" class="action-btn" data-action="edit-strategy" data-guid="${Utils.escapeHtml(strategy.guid)}" title="${_('devices.edit_strategy')}">
                        <span class="material-icons">edit</span>
                    </button>
                    <button type="button" class="action-btn danger" data-action="delete-strategy" data-guid="${Utils.escapeHtml(strategy.guid)}" title="${_('devices.delete_strategy')}">
                        <span class="material-icons">delete</span>
                    </button>
                </div>
            </div>`;
        }).join('');

        container.querySelectorAll('[data-action="edit-strategy"]').forEach(btn => {
            btn.addEventListener('click', () => {
                const strategy = accessStrategies.find(item => item.guid === btn.dataset.guid);
                if (strategy) showStrategyModal(strategy);
            });
        });
        container.querySelectorAll('[data-action="assign-strategy"]').forEach(btn => {
            btn.addEventListener('click', () => {
                const strategy = accessStrategies.find(item => item.guid === btn.dataset.guid);
                if (strategy) showStrategyAssignModal(strategy);
            });
        });
        container.querySelectorAll('[data-action="delete-strategy"]').forEach(btn => {
            btn.addEventListener('click', () => {
                const strategy = accessStrategies.find(item => item.guid === btn.dataset.guid);
                if (strategy) deleteStrategy(strategy);
            });
        });
        refreshStrategyAssignCounts();
    }

    async function refreshStrategyAssignCounts() {
        const badges = document.querySelectorAll('.strategy-assign-count[data-guid]');
        await Promise.all(Array.from(badges).map(async (el) => {
            try {
                const resp = await Utils.api(`/api/panel/strategies/${encodeURIComponent(el.dataset.guid)}`);
                const st = resp?.data?.strategy || resp?.strategy || {};
                const text = _('devices.strategy_assign_counts', {
                    peers: st.peer_count || 0,
                    users: st.user_count || 0,
                    groups: st.device_group_count || 0,
                });
                el.textContent = (st.peer_count || st.user_count || st.device_group_count)
                    ? text
                    : _('devices.strategy_assign_none');
            } catch (_) {
                el.textContent = _('devices.strategy_assign_none');
            }
        }));
    }

    function renderAssignCheckboxList(items, selectedKeys, inputClass, labelFn) {
        if (!items.length) {
            return `<div class="empty-state-inline">${_('common.no_results') || 'No items'}</div>`;
        }
        return items.map(item => {
            const key = item.key;
            const checked = selectedKeys.includes(key) ? 'checked' : '';
            return `<label class="strategy-assign-option">
                <input type="checkbox" class="${inputClass}" value="${Utils.escapeHtml(key)}" ${checked}>
                <span>${Utils.escapeHtml(labelFn(item))}</span>
            </label>`;
        }).join('');
    }

    async function showStrategyAssignModal(strategy) {
        if (!deviceGroups.length) await loadDeviceGroups();
        let panelUsers = [];
        try {
            const usersResp = await Utils.api('/api/users');
            panelUsers = usersResp.users || usersResp.data?.users || usersResp.data || [];
        } catch (_) { panelUsers = []; }

        let detail = { peer_ids: [], user_names: [], group_guids: [] };
        try {
            const resp = await Utils.api(`/api/panel/strategies/${encodeURIComponent(strategy.guid)}`);
            detail = resp?.data?.strategy || detail;
        } catch (_) {}

        const deviceItems = (devices || []).slice(0, 500).map(d => ({
            key: d.id,
            label: `${d.id}${d.hostname ? ' — ' + d.hostname : ''}`,
        }));
        const userItems = panelUsers.map(u => ({
            key: u.username || u.name || String(u.id),
            label: u.username || u.name || String(u.id),
        }));
        const groupItems = deviceGroups.map(g => ({ key: g.guid, label: g.name || g.guid }));

        Modal.show({
            title: (_('devices.strategy_assign_title') || 'Assign strategy').replace('{name}', strategy.name),
            content: `
                <form id="strategy-assign-form" class="device-group-form">
                    <p class="form-hint">${_('devices.strategy_assign_hint')}</p>
                    <div class="form-group">
                        <label>${_('devices.strategy_assign_devices')}</label>
                        <div class="strategy-assign-list">${renderAssignCheckboxList(deviceItems, detail.peer_ids || [], 'strategy-assign-peer', i => i.label)}</div>
                    </div>
                    <div class="form-group">
                        <label>${_('devices.strategy_assign_users')}</label>
                        <div class="strategy-assign-list">${renderAssignCheckboxList(userItems, detail.user_names || [], 'strategy-assign-user', i => i.label)}</div>
                    </div>
                    <div class="form-group">
                        <label>${_('devices.strategy_assign_groups')}</label>
                        <div class="strategy-assign-list">${renderAssignCheckboxList(groupItems, detail.group_guids || [], 'strategy-assign-group', i => i.label)}</div>
                    </div>
                </form>
            `,
            size: 'large',
            buttons: [
                { label: _('actions.cancel'), class: 'btn-secondary', onClick: () => Modal.close() },
                { label: _('actions.save'), class: 'btn-primary', onClick: () => saveStrategyAssignments(strategy) }
            ],
        });
    }

    async function saveStrategyAssignments(strategy) {
        const peers = Array.from(document.querySelectorAll('.strategy-assign-peer:checked')).map(el => el.value);
        const users = Array.from(document.querySelectorAll('.strategy-assign-user:checked')).map(el => el.value);
        const groups = Array.from(document.querySelectorAll('.strategy-assign-group:checked')).map(el => el.value);
        if (!peers.length && !users.length && !groups.length) {
            Notifications.error(_('devices.strategy_assign_hint'));
            return;
        }
        try {
            await Utils.api(`/api/panel/strategies/${encodeURIComponent(strategy.guid)}/assign`, {
                method: 'POST',
                body: { peers, users, groups },
            });
            Notifications.success(_('devices.strategy_assign_saved'));
            Modal.close();
            await refreshStrategyAssignCounts();
        } catch (error) {
            Notifications.error(error.message || _('errors.server_error'));
        }
    }

    function renderStrategyPermissionOptions(permissions = {}) {
        return RUSTDESK_STRATEGY_PERM_KEYS.map(item => {
            const current = permissions[item.key];
            const checked = current === 'Y' || current === true;
            const denied = current === 'N' || current === false;
            return `<label class="strategy-perm-option">
                <span>${Utils.escapeHtml(_(item.labelKey))}</span>
                <select class="form-input strategy-perm-select" data-perm-key="${Utils.escapeHtml(item.key)}">
                    <option value="" ${!checked && !denied ? 'selected' : ''}>${_('devices.strategy_perm_default')}</option>
                    <option value="Y" ${checked ? 'selected' : ''}>${_('devices.strategy_perm_allow')}</option>
                    <option value="N" ${denied ? 'selected' : ''}>${_('devices.strategy_perm_deny')}</option>
                </select>
            </label>`;
        }).join('');
    }

    function readStrategyPermissionsFromForm() {
        const permissions = {};
        document.querySelectorAll('.strategy-perm-select').forEach(select => {
            const key = select.dataset.permKey;
            const value = select.value;
            if (key && (value === 'Y' || value === 'N')) permissions[key] = value;
        });
        return permissions;
    }

    async function showStrategyModal(strategy = null) {
        await ensureUserGroupsLoaded();
        if (!deviceGroups.length) await loadDeviceGroups();
        const editing = !!strategy;
        const userGroupOptions = [
            `<option value="">${Utils.escapeHtml(_('devices.strategy_any_user_group'))}</option>`,
            ...availableUserGroups.map(group => `<option value="${Utils.escapeHtml(group.guid)}" ${strategy?.user_group_guid === group.guid ? 'selected' : ''}>${Utils.escapeHtml(group.name)}</option>`)
        ].join('');
        const deviceGroupOptions = [
            `<option value="">${Utils.escapeHtml(_('devices.strategy_any_device_group'))}</option>`,
            ...deviceGroups.map(group => `<option value="${Utils.escapeHtml(group.guid)}" ${strategy?.device_group_guid === group.guid ? 'selected' : ''}>${Utils.escapeHtml(group.name)}</option>`)
        ].join('');

        Modal.show({
            title: editing ? _('devices.edit_strategy') : _('devices.create_strategy'),
            content: `
                <form id="strategy-form" class="device-group-form">
                    <div class="form-group">
                        <label for="strategy-name">${_('devices.strategy_name')}</label>
                        <input type="text" id="strategy-name" class="form-input" maxlength="80" required value="${Utils.escapeHtml(strategy?.name || '')}">
                    </div>
                    <div class="form-group">
                        <label for="strategy-user-group">${_('devices.strategy_user_group')}</label>
                        <select id="strategy-user-group" class="form-input">${userGroupOptions}</select>
                    </div>
                    <div class="form-group">
                        <label for="strategy-device-group">${_('devices.strategy_device_group')}</label>
                        <select id="strategy-device-group" class="form-input">${deviceGroupOptions}</select>
                    </div>
                    <label class="toggle-row">
                        <input type="checkbox" id="strategy-enabled" ${strategy?.enabled !== false ? 'checked' : ''}>
                        <span>${_('devices.strategy_enabled_label')}</span>
                    </label>
                    <div class="form-group">
                        <label>${_('devices.strategy_permissions')}</label>
                        <div class="strategy-perm-grid">${renderStrategyPermissionOptions(strategy?.permissions || {})}</div>
                        <p class="form-hint">${_('devices.strategy_permissions_hint')}</p>
                    </div>
                </form>
            `,
            size: 'medium',
            buttons: [
                { label: _('actions.cancel'), class: 'btn-secondary', onClick: () => Modal.close() },
                { label: _('actions.save'), class: 'btn-primary', onClick: () => saveStrategy(strategy) }
            ],
            onOpen: () => document.getElementById('strategy-name')?.focus()
        });
    }

    async function saveStrategy(strategy = null) {
        const name = document.getElementById('strategy-name')?.value.trim() || '';
        if (!name) {
            Notifications.error(_('devices.strategy_name_required'));
            return;
        }
        const payload = {
            name,
            user_group_guid: document.getElementById('strategy-user-group')?.value || '',
            device_group_guid: document.getElementById('strategy-device-group')?.value || '',
            enabled: !!document.getElementById('strategy-enabled')?.checked,
            permissions: readStrategyPermissionsFromForm(),
        };
        try {
            const url = strategy
                ? `/api/panel/strategies/${encodeURIComponent(strategy.guid)}`
                : '/api/panel/strategies';
            await Utils.api(url, { method: strategy ? 'PATCH' : 'POST', body: payload });
            Notifications.success(strategy ? _('devices.strategy_updated') : _('devices.strategy_created'));
            Modal.close();
            strategiesLoaded = false;
            await loadStrategies();
        } catch (error) {
            Notifications.error(error.message || _('errors.server_error'));
        }
    }

    async function deleteStrategy(strategy) {
        const confirmed = await Modal.confirm({
            title: _('devices.delete_strategy'),
            message: (_('devices.delete_strategy_confirm') || 'Delete strategy {name}?').replace('{name}', strategy.name),
            confirmLabel: _('actions.delete'),
            danger: true
        });
        if (!confirmed) return;
        try {
            await Utils.api(`/api/panel/strategies/${encodeURIComponent(strategy.guid)}`, { method: 'DELETE' });
            Notifications.success(_('devices.strategy_deleted'));
            strategiesLoaded = false;
            await loadStrategies();
        } catch (error) {
            Notifications.error(error.message || _('errors.server_error'));
        }
    }

    function initStrategies() {
        document.getElementById('add-strategy-btn')?.addEventListener('click', () => showStrategyModal());
    }
    
    // ==================== Folder Functions ====================
    
    /**
     * Load folders from API
     */
    async function loadFolders() {
        try {
            const response = await fetchOnce('/api/folders', () => Utils.api('/api/folders'));
            folders = response.folders || [];
            // Expose folders globally for DeviceDetail panel
            window._betterdesk_folders = folders;
            renderFolders();
            updateBulkMoveSelect();
        } catch (error) {
            console.error('Failed to load folders:', error);
        }
    }
    
    /**
     * Render folders list
     */
    function renderFolders() {
        const container = document.getElementById('custom-folders');
        if (!container) return;
        
        if (folders.length === 0) {
            container.innerHTML = '';
            attachFolderDropEvents();
            return;
        }
        
        container.innerHTML = folders.map(folder => {
            const safeColor = (Utils.sanitizeColor || _sanitizeColorFallback)(folder.color);
            return `
            <span class="folder-chip ${currentFolder == folder.id ? 'active' : ''}"
                 data-folder="${folder.id}" 
                 role="button"
                 tabindex="0"
                 style="--folder-color: ${safeColor}">
                <span class="material-icons chip-icon" style="color: ${safeColor}">folder</span>
                <span class="chip-label">${Utils.escapeHtml(folder.name)}</span>
                <span class="chip-count">${folder.device_count || 0}</span>
                <span class="chip-actions">
                    <button type="button" class="chip-action folder-edit" data-id="${folder.id}" title="${_('actions.edit')}">
                        <span class="material-icons">edit</span>
                    </button>
                    <button type="button" class="chip-action folder-delete" data-id="${folder.id}" title="${_('actions.delete')}">
                        <span class="material-icons">delete</span>
                    </button>
                </span>
            </span>
        `}).join('');
        
        // Attach folder click listeners
        container.querySelectorAll('.folder-chip').forEach(el => {
            el.addEventListener('click', (e) => {
                if (!e.target.closest('.chip-actions')) {
                    selectFolder(el.dataset.folder);
                }
            });
            el.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                if (e.target.closest('.chip-actions')) return;
                e.preventDefault();
                selectFolder(el.dataset.folder);
            });
            attachChipContextMenu(el, { type: 'folder', id: el.dataset.folder });
        });
        
        container.querySelectorAll('.folder-edit').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                editFolder(btn.dataset.id);
            });
        });
        
        container.querySelectorAll('.folder-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                deleteFolder(btn.dataset.id);
            });
        });
        
        // Attach drag & drop events for all folder chips
        attachFolderDropEvents();
    }
    
    /**
     * Update folder counts
     */
    function updateFolderCounts() {
        // All devices count
        const allCount = document.getElementById('folder-count-all');
        if (allCount) allCount.textContent = devices.length;
        
        // Unassigned count (devices without folder_id — null, undefined, or missing)
        const unassignedCount = document.getElementById('folder-count-unassigned');
        if (unassignedCount) {
            const count = devices.filter(d => !d.folder_id).length;
            unassignedCount.textContent = count;
        }
        
        // Update custom folder counts from devices array
        for (const folder of folders) {
            const el = document.querySelector(`.folder-chip[data-folder="${folder.id}"] .chip-count`);
            if (el) {
                const count = devices.filter(d => folderIdsEqual(d.folder_id, folder.id)).length;
                el.textContent = count;
            }
        }
    }
    
    /**
     * Update bulk move select options
     */
    function updateBulkMoveSelect() {
        const select = document.getElementById('bulk-move-folder');
        if (!select) return;
        
        select.innerHTML = `
            <option value="">${_('folders.move_to')}...</option>
            <option value="0">${_('folders.unassigned')}</option>
            ${folders.map(f => `<option value="${f.id}">${Utils.escapeHtml(f.name)}</option>`).join('')}
        `;
        
        // Add change listener
        select.addEventListener('change', async function() {
            if (!this.value || selectedIds.size === 0) return;
            
            try {
                await Utils.api(`/api/folders/${this.value}/devices`, {
                    method: 'POST',
                    body: { deviceIds: Array.from(selectedIds) }
                });
                Notifications.success(_('folders.devices_moved'));
                this.value = '';
                selectedIds.clear();
                updateSelectionUI();
                loadDevices();
                loadFolders();
            } catch (error) {
                Notifications.error(error.message || _('errors.server_error'));
            }
        });
    }
    
    /**
     * Select folder
     */
    function selectFolder(folderId) {
        currentFolder = folderId;
        currentGroup = 'all';
        currentPage = 1;
        
        // Update active state
        document.querySelectorAll('.folder-chip').forEach(el => {
            el.classList.toggle('active', el.dataset.folder == folderId);
        });
        document.querySelectorAll('.group-chip').forEach(el => {
            el.classList.toggle('active', el.dataset.group === 'all');
        });
        
        applyFilters();
    }
    
    /**
     * Initialize folder event listeners
     */
    function initFolders() {
        // Add folder button
        document.getElementById('add-folder-btn')?.addEventListener('click', showAddFolderModal);
        
        // Special folder clicks
        document.querySelectorAll('.folder-chip[data-folder="all"], .folder-chip[data-folder="unassigned"]').forEach(el => {
            el.addEventListener('click', () => selectFolder(el.dataset.folder));
        });
    }
    
    /**
     * Initialize column visibility toggle
     */
    function initColumnVisibility() {
        const btn = document.getElementById('columns-btn');
        const menu = document.getElementById('columns-menu');
        if (!btn || !menu) return;

        // Restore saved preferences
        const saved = localStorage.getItem('devices-visible-columns');
        if (saved) {
            try {
                const hidden = JSON.parse(saved);
                menu.querySelectorAll('input[data-column]').forEach(cb => {
                    cb.checked = !hidden.includes(cb.dataset.column);
                });
            } catch (e) { /* ignore parse errors */ }
        }

        // Toggle dropdown on button click
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            menu.classList.toggle('show');
        });

        // Close on outside click — use contains() to handle child elements
        document.addEventListener('click', (e) => {
            if (!btn.contains(e.target) && !menu.contains(e.target)) {
                menu.classList.remove('show');
            }
        });

        // Checkbox change — stop propagation so click doesn't bubble to document
        menu.querySelectorAll('input[data-column]').forEach(cb => {
            cb.addEventListener('change', (e) => {
                e.stopPropagation();
                saveColumnPreferences();
                applyColumnVisibility();
            });
        });

        // Prevent menu clicks from closing dropdown
        menu.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        // Apply initial state
        applyColumnVisibility();
    }

    /**
     * Save column visibility preferences to localStorage
     */
    function saveColumnPreferences() {
        const menu = document.getElementById('columns-menu');
        if (!menu) return;
        const hidden = [];
        menu.querySelectorAll('input[data-column]').forEach(cb => {
            if (!cb.checked) hidden.push(cb.dataset.column);
        });
        localStorage.setItem('devices-visible-columns', JSON.stringify(hidden));
    }

    /**
     * Apply column visibility to table headers and cells
     */
    function applyColumnVisibility() {
        const menu = document.getElementById('columns-menu');
        if (!menu) return;

        const hiddenColumns = [];
        menu.querySelectorAll('input[data-column]').forEach(cb => {
            if (!cb.checked) hiddenColumns.push(cb.dataset.column);
        });

        // Apply to <th> elements
        document.querySelectorAll('.devices-table th[data-column]').forEach(th => {
            th.classList.toggle('column-hidden', hiddenColumns.includes(th.dataset.column));
        });

        // Apply to <td> elements
        document.querySelectorAll('.devices-table td[data-column]').forEach(td => {
            td.classList.toggle('column-hidden', hiddenColumns.includes(td.dataset.column));
        });
        requestAnimationFrame(updateTableHScroll);
    }
    
    function selectedFolderUserGroupGuids() {
        return Array.from(document.querySelectorAll('#folder-user-groups-list input:checked')).map(input => input.value);
    }

    function renderFolderUserGroupOptions(selectedGuids) {
        const container = document.getElementById('folder-user-groups-list');
        if (!container) return;
        container.innerHTML = renderUserGroupAccessOptions(selectedGuids || []);
    }

    /**
     * Show add folder modal
     */
    async function showAddFolderModal() {
        await ensureUserGroupsLoaded();
        const template = document.getElementById('folder-form-template');
        if (!template) return;
        
        const content = template.content.cloneNode(true);
        const formHtml = content.querySelector('form').outerHTML;
        
        Modal.show({
            title: _('folders.create'),
            content: formHtml,
            size: 'small',
            buttons: [
                { label: _('actions.cancel'), class: 'btn-secondary', onClick: () => Modal.close() },
                { label: _('actions.save'), class: 'btn-primary', onClick: () => submitFolderForm() }
            ],
            onOpen: () => {
                initColorPicker();
                renderFolderUserGroupOptions([]);
                document.getElementById('folder-name')?.focus();
            }
        });
    }
    
    /**
     * Edit folder
     */
    async function editFolder(folderId) {
        await ensureUserGroupsLoaded();
        const folder = findFolderById(folderId);
        if (!folder) return;
        
        const template = document.getElementById('folder-form-template');
        if (!template) return;
        
        const content = template.content.cloneNode(true);
        const formHtml = content.querySelector('form').outerHTML;
        
        Modal.show({
            title: _('folders.edit'),
            content: formHtml,
            size: 'small',
            buttons: [
                { label: _('actions.cancel'), class: 'btn-secondary', onClick: () => Modal.close() },
                { label: _('actions.save'), class: 'btn-primary', onClick: () => submitFolderForm(folderId) }
            ],
            onOpen: () => {
                initColorPicker();
                document.getElementById('folder-name').value = folder.name;
                document.getElementById('folder-color').value = folder.color;
                document.getElementById('folder-allowed-users').value = (folder.allowed_users || []).join(', ');
                renderFolderUserGroupOptions(folder.allowed_groups || []);
                
                // Set active color
                document.querySelectorAll('.color-option').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.color === folder.color);
                });
            }
        });
    }
    
    /**
     * Initialize color picker
     */
    function initColorPicker() {
        document.querySelectorAll('.color-option').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.color-option').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                document.getElementById('folder-color').value = btn.dataset.color;
            });
        });
    }
    
    /**
     * Submit folder form
     */
    async function submitFolderForm(folderId = null) {
        const name = document.getElementById('folder-name')?.value.trim();
        const color = document.getElementById('folder-color')?.value;
        const allowedUsers = document.getElementById('folder-allowed-users')?.value || '';
        const allowedGroups = selectedFolderUserGroupGuids();
        
        if (!name) {
            Notifications.error(_('folders.name_required'));
            return;
        }
        
        try {
            if (folderId) {
                await Utils.api(`/api/folders/${folderId}`, {
                    method: 'PATCH',
                    body: { name, color, allowed_users: allowedUsers, allowed_groups: allowedGroups }
                });
                Notifications.success(_('folders.updated'));
            } else {
                await Utils.api('/api/folders', {
                    method: 'POST',
                    body: { name, color, allowed_users: allowedUsers, allowed_groups: allowedGroups }
                });
                Notifications.success(_('folders.created'));
            }
            
            Modal.close();
            loadFolders();
        } catch (error) {
            Notifications.error(error.message || _('errors.server_error'));
        }
    }
    
    /**
     * Delete folder
     */
    async function deleteFolder(folderId) {
        const folder = findFolderById(folderId);
        if (!folder) return;
        
        const confirmed = await Modal.confirm({
            title: _('folders.delete'),
            message: _('folders.delete_confirm'),
            confirmLabel: _('actions.delete'),
            danger: true
        });
        
        if (!confirmed) return;
        
        try {
            await Utils.api(`/api/folders/${folderId}`, { method: 'DELETE' });
            Notifications.success(_('folders.delete_success'));
            
            // If current folder was deleted, switch to all
            if (currentFolder == folderId) {
                selectFolder('all');
            }
            
            loadFolders();
            loadDevices();
        } catch (error) {
            Notifications.error(error.message || _('errors.server_error'));
        }
    }
    
    // ==================== Drag & Drop ====================
    
    /**
     * Initialize drag & drop - row drag events only (called once)
     */
    function initDragDrop() {
        // Handle drag start on rows
        tableBody?.addEventListener('dragstart', (e) => {
            const row = e.target.closest('tr');
            if (!row) return;
            
            draggedDeviceId = row.dataset.id;
            row.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', draggedDeviceId);
        });
        
        tableBody?.addEventListener('dragend', (e) => {
            const row = e.target.closest('tr');
            if (row) row.classList.remove('dragging');
            draggedDeviceId = null;
            
            // Remove drop indicators
            document.querySelectorAll('.folder-chip.drag-over').forEach(el => {
                el.classList.remove('drag-over');
            });
        });
    }
    
    /**
     * Attach drag events to folder items (called after renderFolders)
     */
    function attachFolderDropEvents() {
        // Handle drop on ALL folders (static + dynamic)
        document.querySelectorAll('.folder-chip').forEach(folder => {
            // Skip if already has drag handlers (check with data attribute)
            if (folder.dataset.dragAttached) return;
            folder.dataset.dragAttached = 'true';
            
            folder.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                folder.classList.add('drag-over');
            });
            
            folder.addEventListener('dragleave', () => {
                folder.classList.remove('drag-over');
            });
            
            folder.addEventListener('drop', async (e) => {
                e.preventDefault();
                folder.classList.remove('drag-over');
                
                const deviceId = e.dataTransfer.getData('text/plain');
                if (!deviceId) return;
                
                const targetFolder = folder.dataset.folder;
                let folderId = null;
                
                if (targetFolder === 'all') {
                    return; // Can't drop on "all"
                } else if (targetFolder === 'unassigned') {
                    folderId = null;
                } else {
                    folderId = Number(targetFolder);
                    if (!Number.isFinite(folderId)) return;
                }
                
                try {
                    await Utils.api(`/api/devices/${deviceId}/folder`, {
                        method: 'PATCH',
                        body: { folderId }
                    });
                    
                    Notifications.success(_('folders.device_assigned'));
                    loadDevices();
                    loadFolders();
                } catch (error) {
                    console.error('Folder assignment failed:', error);
                    Notifications.error(error.message || _('errors.server_error'));
                }
            });
        });
    }

    async function setDeviceManualGroups(deviceId, groupGuids) {
        await Utils.api(`/api/devices/${encodeURIComponent(deviceId)}/groups`, {
            method: 'PUT',
            body: { groupGuids }
        });
    }

    async function getDeviceManualGroupGuids(deviceId) {
        const device = devices.find(item => item.id === deviceId);
        if (device && Array.isArray(device.groups)) {
            return device.groups
                .filter(group => (group.source_type || 'manual') !== 'tag')
                .map(group => group.guid)
                .filter(Boolean);
        }
        const response = await Utils.api(`/api/devices/${encodeURIComponent(deviceId)}/groups`);
        return (response.memberships || [])
            .filter(group => (group.source_type || 'manual') !== 'tag')
            .map(group => group.guid)
            .filter(Boolean);
    }

    /**
     * Attach drag events to group chips (called after renderDeviceGroups).
     */
    function attachGroupDropEvents() {
        document.querySelectorAll('.group-chip[data-group]').forEach(chip => {
            if (chip.dataset.groupDropAttached) return;
            chip.dataset.groupDropAttached = 'true';

            chip.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                chip.classList.add('drag-over');
            });

            chip.addEventListener('dragleave', () => {
                chip.classList.remove('drag-over');
            });

            chip.addEventListener('drop', async (e) => {
                e.preventDefault();
                chip.classList.remove('drag-over');

                const deviceId = e.dataTransfer.getData('text/plain');
                if (!deviceId) return;

                const targetGroup = chip.dataset.group;
                try {
                    if (targetGroup === 'all') {
                        if (currentGroup === 'all') return;
                        const manualGuids = await getDeviceManualGroupGuids(deviceId);
                        const nextGuids = manualGuids.filter(guid => guid !== currentGroup);
                        if (nextGuids.length === manualGuids.length) return;
                        await setDeviceManualGroups(deviceId, nextGuids);
                        Notifications.success(_('devices.group_membership_removed') || 'Removed from group');
                    } else {
                        const group = deviceGroups.find(item => item.guid === targetGroup);
                        if (!group || (group.source_type || 'manual') === 'tag') return;
                        const manualGuids = await getDeviceManualGroupGuids(deviceId);
                        if (manualGuids.includes(targetGroup)) return;
                        await setDeviceManualGroups(deviceId, [...manualGuids, targetGroup]);
                        Notifications.success(_('devices.group_membership_added') || 'Added to group');
                    }
                    loadDevices();
                    loadDeviceGroups();
                } catch (error) {
                    console.error('Group assignment failed:', error);
                    Notifications.error(error.message || _('errors.server_error'));
                }
            });
        });
    }
    
})();
