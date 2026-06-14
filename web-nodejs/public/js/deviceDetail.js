/**
 * BetterDesk Console - Device Detail Panel
 * Full workspace modal for device management.
 *
 * Usage:
 *   DeviceDetail.open(deviceId)   — opens the panel
 *   DeviceDetail.close()          — closes the panel
 *
 * Dispatches 'deviceDetail:changed' on document when device is modified.
 */

const DeviceDetail = (function () {
    'use strict';

    document.addEventListener('devices:updated', function (event) {
        const detail = event.detail || {};
        if (!device || !detail.id || device.id !== detail.id) return;

        if (typeof detail.display_name === 'string') {
            device.display_name = detail.display_name;
        }
        if (typeof detail.note === 'string') {
            device.note = detail.note;
        }

        _render();
    });

    // ──────────────────────────────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────────────────────────────
    let overlayEl = null;
    let device = null;
    let activeTab = 'overview';
    let refreshTimer = null;
    let availableTags = [];
    let availableTagsLoaded = false;

    // ──────────────────────────────────────────────────────────────────────
    // Public API
    // ──────────────────────────────────────────────────────────────────────

    /**
     * Open device detail panel for the given device ID.
     * @param {string} deviceId
     */
    async function open(deviceId) {
        if (!deviceId) return;
        activeTab = 'overview';
        _createOverlay();
        _showLoading();
        _show();
        document.body.classList.add('device-detail-open');

        try {
            device = await Utils.api('/api/devices/' + encodeURIComponent(deviceId));
            _render();
        } catch (err) {
            console.error('DeviceDetail: failed to load device', err);
            Notifications.error(err.message || _('errors.load_device_failed'));
            close();
        }

        // Auto-refresh every 15 s while panel is open
        _startRefresh(deviceId);
    }

    /**
     * Close the panel.
     */
    function close() {
        _stopRefresh();
        document.body.classList.remove('device-detail-open');
        if (overlayEl) {
            if (overlayEl._escHandler) {
                document.removeEventListener('keydown', overlayEl._escHandler);
            }
            overlayEl.classList.remove('open');
            setTimeout(() => {
                if (overlayEl) {
                    overlayEl.remove();
                    overlayEl = null;
                }
            }, 300);
        }
        device = null;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Overlay / skeleton
    // ──────────────────────────────────────────────────────────────────────

    function _createOverlay() {
        if (overlayEl) overlayEl.remove();

        overlayEl = document.createElement('div');
        overlayEl.className = 'device-panel-overlay';
        overlayEl.innerHTML = '<div class="device-panel" id="device-panel-inner"></div>';

        // Close on overlay click — skip if a modal dialog is open on top
        overlayEl.addEventListener('click', function (e) {
            if (e.target === overlayEl) {
                if (document.querySelector('.modal-overlay.open, .modal-container.open')) return;
                close();
            }
        });

        // Escape key — skip if a modal dialog is open on top
        overlayEl._escHandler = function (e) {
            if (e.key === 'Escape') {
                if (document.querySelector('.modal-overlay.open, .modal-container.open')) return;
                close();
            }
        };
        document.addEventListener('keydown', overlayEl._escHandler);

        document.body.appendChild(overlayEl);
    }

    function _show() {
        requestAnimationFrame(() => {
            if (overlayEl) overlayEl.classList.add('open');
        });
    }

    function _showLoading() {
        const inner = overlayEl.querySelector('#device-panel-inner');
        inner.innerHTML = `
            <div class="device-panel-loading">
                <div class="device-panel-spinner"></div>
                <div class="device-panel-loading-text">${_('common.loading')}</div>
            </div>`;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Render
    // ──────────────────────────────────────────────────────────────────────

    function _render() {
        if (!overlayEl || !device) return;
        const inner = overlayEl.querySelector('#device-panel-inner');

        inner.innerHTML = _headerHTML() + _tabsHTML() + _contentHTML() + _footerHTML();

        _attachEvents();
        _switchTab(activeTab);
    }

    // ── Header ──

    function _resolveDeviceStatus(d) {
        if (d.banned) {
            return { className: 'banned', label: _('status.banned'), title: '' };
        }
        if (d.online) {
            const tier = (d.status_tier || 'online').toLowerCase();
            if (tier === 'degraded' || tier === 'critical') {
                return { className: tier, label: _('status.' + tier), title: '' };
            }
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

    function _headerHTML() {
        const d = device;
        const platformLabel = d.platform || d.os || '-';
        const platformIcon = Utils.getPlatformIcon(d.platform || d.os);
        const statusInfo = _resolveDeviceStatus(d);
        const statusClass = statusInfo.className;
        const statusLabel = statusInfo.label;
        const statusTitle = statusInfo.title;

        return `
        <div class="device-panel-header">
            <div class="device-panel-header-top">
                <div class="device-panel-identity">
                    <div class="device-panel-id-row">
                        <span class="device-panel-device-id">${Utils.escapeHtml(d.id)}</span>
                        <button class="device-panel-copy-btn" data-copy="${Utils.escapeHtml(d.id)}" title="${_('actions.copy')}">
                            <span class="material-icons">content_copy</span>
                        </button>
                    </div>
                    <div class="device-panel-subtitle">
                        <span class="material-icons">${platformIcon}</span>
                        <span>${Utils.escapeHtml(d.display_name || d.hostname || d.note || '-')}</span>
                        ${d.username ? ` &middot; <span>${Utils.escapeHtml(d.username)}</span>` : ''}
                    </div>
                </div>
                <button class="device-panel-close" title="${_('actions.close')}">
                    <span class="material-icons">close</span>
                </button>
            </div>
            <div class="device-panel-status-bar">
                <span class="device-panel-status-badge ${statusClass}"${statusTitle ? ` title="${Utils.escapeHtml(statusTitle)}"` : ''}>
                    <span class="status-dot"></span>${statusLabel}
                </span>
                <span class="device-panel-platform-badge">
                    <span class="material-icons">${platformIcon}</span>
                    ${Utils.escapeHtml(platformLabel)}
                </span>
            </div>
        </div>`;
    }

    // ── Tabs ──

    function _tabsHTML() {
        const tabs = [
            { id: 'overview',  icon: 'info',            label: _('device_detail.tab_overview') },
            { id: 'hardware',  icon: 'memory',          label: _('device_detail.tab_hardware') },
            { id: 'metrics',   icon: 'monitoring',      label: _('device_detail.tab_metrics') },
            { id: 'services',  icon: 'settings_applications', label: _('device_detail.tab_services') },
            { id: 'processes', icon: 'memory',          label: _('device_detail.tab_processes') },
            { id: 'events',    icon: 'event_note',      label: _('device_detail.tab_events') },
            { id: 'activity',  icon: 'insights',        label: _('device_detail.tab_activity') },
            { id: 'files',     icon: 'folder_open',     label: _('device_detail.tab_files') },
            { id: 'tags',      icon: 'sell',             label: _('device_detail.tab_tags') },
            { id: 'actions',   icon: 'play_arrow',       label: _('device_detail.tab_actions') }
        ];
        return `<div class="device-panel-tabs">` +
            tabs.map(t =>
                `<button class="device-panel-tab${t.id === activeTab ? ' active' : ''}" data-tab="${t.id}">
                    <span class="material-icons">${t.icon}</span>${t.label}
                </button>`
            ).join('') +
            `</div>`;
    }

    // ── Content ──

    function _contentHTML() {
        return `<div class="device-panel-content">
            ${_overviewPane()}
            ${_hardwarePane()}
            ${_metricsPane()}
            ${_agentPane('services', 'settings_applications', 'tab_services')}
            ${_agentPane('processes', 'memory', 'tab_processes')}
            ${_agentPane('events', 'event_note', 'tab_events')}
            ${_agentPane('activity', 'insights', 'tab_activity')}
            ${_agentPane('files', 'folder_open', 'tab_files')}
            ${_tagsPane()}
            ${_actionsPane()}
        </div>`;
    }

    // ── Live-agent tabs (lazy loaded) ────────────────────────────────────
    //
    // These panes are populated on first tab activation by `_loadAgentTab()`.
    // Keeping them in separate functions would duplicate 200+ lines of
    // boilerplate. Instead, each pane is a placeholder that shows an empty
    // state and a "Load" button; real data is fetched when tab is shown.

    function _agentPane(paneId, icon, labelKey) {
        return `<div class="device-panel-tab-pane" data-pane="${paneId}">
            <div class="device-panel-agent-pane" data-agent-pane="${paneId}">
                <div class="device-panel-agent-empty">
                    <span class="material-icons">${icon}</span>
                    <div>${_('device_detail.' + labelKey)}</div>
                    <div class="device-panel-agent-hint">${_('device_detail.agent_lazy_hint')}</div>
                </div>
            </div>
        </div>`;
    }

    // ── Overview tab ──

    function _overviewPane() {
        const d = device;
        let html = `<div class="device-panel-tab-pane" data-pane="overview">`;

        // Ban alert
        if (d.banned) {
            html += `
            <div class="device-panel-ban-alert">
                <span class="material-icons">gpp_bad</span>
                <div class="device-panel-ban-alert-text">
                    <div class="device-panel-ban-alert-title">${_('device_detail.device_banned')}</div>
                    <div class="device-panel-ban-alert-reason">${d.ban_reason ? Utils.escapeHtml(d.ban_reason) : _('device_detail.no_reason')}</div>
                </div>
            </div>`;
        }

        // Quick metrics summary (if available)
        if (d.metrics) {
            html += `
            <div class="device-panel-section">
                <div class="device-panel-section-title"><span class="material-icons">monitoring</span> ${_('device_detail.section_live_metrics')}</div>
                <div class="device-panel-metrics-grid">
                    ${_metricCard('CPU', d.metrics.cpu_usage, 'speed')}
                    ${_metricCard(_('device_detail.metric_memory'), d.metrics.memory_usage, 'memory')}
                    ${_metricCard(_('device_detail.metric_disk'), d.metrics.disk_usage, 'storage')}
                </div>
                ${d.metrics.updated_at ? `<div class="device-panel-metrics-updated">${_('device_detail.metrics_updated')} ${Utils.formatRelativeTime(d.metrics.updated_at)}</div>` : ''}
            </div>`;
        }

        // Identity section
        html += `
        <div class="device-panel-section">
            <div class="device-panel-section-title"><span class="material-icons">badge</span> ${_('device_detail.section_identity')}</div>
            <div class="device-panel-info-grid">
                ${_infoRow(_('devices.id'), `<span class="mono">${Utils.escapeHtml(d.id)}</span>`, d.id)}
                ${_infoRow(_('devices.display_name'), Utils.escapeHtml(d.display_name || '-'))}
                ${_infoRow(_('devices.hostname'), Utils.escapeHtml(d.hostname || d.note || '-'))}
                ${_infoRow(_('devices.username'), Utils.escapeHtml(d.username || '-'))}
                ${d.uuid ? _infoRow('UUID', `<span class="mono">${Utils.escapeHtml(d.uuid)}</span>`) : ''}
                ${_infoRow(_('devices.platform'), Utils.escapeHtml(d.platform || d.os || (d.sysinfo && d.sysinfo.platform) || '-'))}
                ${d.sysinfo && d.sysinfo.version ? _infoRow(_('device_detail.version'), Utils.escapeHtml(d.sysinfo.version)) : ''}
            </div>
        </div>`;

        // Network section
        html += `
        <div class="device-panel-section">
            <div class="device-panel-section-title"><span class="material-icons">lan</span> ${_('device_detail.section_network')}</div>
            <div class="device-panel-info-grid">
                ${_infoRow(_('devices.ip_address'), d.ip ? `<span class="mono">${Utils.escapeHtml(d.ip)}</span>` : '-', d.ip)}
                ${_infoRow(_('device_detail.folder'), _folderName(d.folder_id))}
                ${d.groups && d.groups.length > 0 ? _infoRow(_('device_detail.device_groups'), d.groups.map(g => `<span class="device-panel-group-badge">${Utils.escapeHtml(g.name || g.guid)}</span>`).join(' ')) : ''}
            </div>
        </div>`;

        // Timestamps
        html += `
        <div class="device-panel-section">
            <div class="device-panel-section-title"><span class="material-icons">schedule</span> ${_('device_detail.section_timestamps')}</div>
            <div class="device-panel-info-grid">
                ${_infoRow(_('devices.first_seen'), Utils.formatDate(d.created_at))}
                ${_infoRow(_('devices.last_seen'), _lastSeenValue(d.last_online))}
                ${d.status_tier && d.status_tier.toLowerCase() !== 'online' && d.status_tier.toLowerCase() !== 'offline'
                    ? _infoRow(_('device_detail.status_tier'), _statusTierBadge(d.status_tier.toLowerCase()))
                    : ''}
            </div>
        </div>`;

        html += `</div>`;
        return html;
    }

    // ── Hardware tab (sysinfo data) ──

    function _hardwarePane() {
        const d = device;
        const s = d.sysinfo || {};
        let html = `<div class="device-panel-tab-pane" data-pane="hardware">`;

        if (!d.sysinfo) {
            html += `
            <div class="device-panel-empty-state">
                <span class="material-icons">memory</span>
                <p>${_('device_detail.no_sysinfo')}</p>
                <p class="device-panel-empty-hint">${_('device_detail.no_sysinfo_hint')}</p>
            </div>`;
            html += `</div>`;
            return html;
        }

        // System section
        html += `
        <div class="device-panel-section">
            <div class="device-panel-section-title"><span class="material-icons">computer</span> ${_('device_detail.section_system')}</div>
            <div class="device-panel-info-grid">
                ${s.hostname ? _infoRow(_('devices.hostname'), Utils.escapeHtml(s.hostname)) : ''}
                ${s.username ? _infoRow(_('devices.username'), Utils.escapeHtml(s.username)) : ''}
                ${s.os_full ? _infoRow(_('device_detail.os'), Utils.escapeHtml(s.os_full)) : ''}
                ${s.platform ? _infoRow(_('devices.platform'), Utils.escapeHtml(s.platform)) : ''}
                ${s.version ? _infoRow(_('device_detail.version'), Utils.escapeHtml(s.version)) : ''}
            </div>
        </div>`;

        // CPU section
        html += `
        <div class="device-panel-section">
            <div class="device-panel-section-title"><span class="material-icons">speed</span> ${_('device_detail.section_cpu')}</div>
            <div class="device-panel-info-grid">
                ${s.cpu_name ? _infoRow(_('device_detail.cpu_model'), Utils.escapeHtml(s.cpu_name)) : ''}
                ${s.cpu_cores ? _infoRow(_('device_detail.cpu_cores'), s.cpu_cores + ' cores') : ''}
                ${s.cpu_freq_ghz ? _infoRow(_('device_detail.cpu_freq'), _formatFreq(s.cpu_freq_ghz)) : ''}
            </div>
        </div>`;

        // Memory section
        if (s.memory_gb) {
            html += `
            <div class="device-panel-section">
                <div class="device-panel-section-title"><span class="material-icons">memory</span> ${_('device_detail.section_memory')}</div>
                <div class="device-panel-info-grid">
                    ${_infoRow(_('device_detail.total_memory'), _formatMemory(s.memory_gb))}
                </div>
            </div>`;
        }

        // Displays section
        const displays = _safeParseJSON(s.displays_json || s.displays, []);
        if (displays.length > 0) {
            html += `
            <div class="device-panel-section">
                <div class="device-panel-section-title"><span class="material-icons">monitor</span> ${_('device_detail.section_displays')}</div>
                <div class="device-panel-displays-list">
                    ${displays.map((disp, i) => {
                        const w = disp.width || disp.w || 0;
                        const h = disp.height || disp.h || 0;
                        const name = disp.name || ('#' + (i + 1));
                        return `<div class="device-panel-display-item">
                            <span class="material-icons">monitor</span>
                            <span>${Utils.escapeHtml(name)}</span>
                            ${w && h ? `<span class="device-panel-display-res">${w}×${h}</span>` : ''}
                        </div>`;
                    }).join('')}
                </div>
            </div>`;
        }

        // Encoding capabilities
        const encoding = _safeParseJSON(s.encoding_json || s.encoding, []);
        if (encoding.length > 0) {
            html += `
            <div class="device-panel-section">
                <div class="device-panel-section-title"><span class="material-icons">videocam</span> ${_('device_detail.section_encoding')}</div>
                <div class="device-panel-encoding-tags">
                    ${encoding.map(e => {
                        const label = typeof e === 'string' ? e : (e.name || e.codec || JSON.stringify(e));
                        return `<span class="device-panel-encoding-tag">${Utils.escapeHtml(label)}</span>`;
                    }).join('')}
                </div>
            </div>`;
        }

        html += `</div>`;
        return html;
    }

    // ── Metrics tab (CPU, memory, disk usage) ──

    function _metricsPane() {
        const d = device;
        let html = `<div class="device-panel-tab-pane" data-pane="metrics">`;

        if (!d.metrics && (!d.metrics_history || d.metrics_history.length === 0)) {
            html += `
            <div class="device-panel-empty-state">
                <span class="material-icons">monitoring</span>
                <p>${_('device_detail.no_metrics')}</p>
                <p class="device-panel-empty-hint">${_('device_detail.no_metrics_hint')}</p>
            </div>`;
            html += `</div>`;
            return html;
        }

        // Current metrics
        if (d.metrics) {
            html += `
            <div class="device-panel-section">
                <div class="device-panel-section-title"><span class="material-icons">speed</span> ${_('device_detail.section_current_usage')}</div>
                <div class="device-panel-metrics-grid">
                    ${_metricCard('CPU', d.metrics.cpu_usage, 'speed')}
                    ${_metricCard(_('device_detail.metric_memory'), d.metrics.memory_usage, 'memory')}
                    ${_metricCard(_('device_detail.metric_disk'), d.metrics.disk_usage, 'storage')}
                </div>
                ${d.metrics.updated_at ? `<div class="device-panel-metrics-updated">${_('device_detail.metrics_updated')} ${Utils.formatRelativeTime(d.metrics.updated_at)}</div>` : ''}
            </div>`;
        }

        // Metrics history (simple bar chart)
        if (d.metrics_history && d.metrics_history.length > 1) {
            html += `
            <div class="device-panel-section">
                <div class="device-panel-section-title"><span class="material-icons">timeline</span> ${_('device_detail.section_usage_history')}</div>
                <div class="device-panel-chart-container">
                    <div class="device-panel-chart-label">CPU</div>
                    <div class="device-panel-mini-chart" id="dp-chart-cpu">
                        ${_miniBarChart(d.metrics_history.map(m => m.cpu), 'cpu')}
                    </div>
                    <div class="device-panel-chart-label">${_('device_detail.metric_memory')}</div>
                    <div class="device-panel-mini-chart" id="dp-chart-memory">
                        ${_miniBarChart(d.metrics_history.map(m => m.memory), 'memory')}
                    </div>
                    <div class="device-panel-chart-label">${_('device_detail.metric_disk')}</div>
                    <div class="device-panel-mini-chart" id="dp-chart-disk">
                        ${_miniBarChart(d.metrics_history.map(m => m.disk), 'disk')}
                    </div>
                </div>
                <div class="device-panel-chart-legend">
                    <span>${_('device_detail.chart_oldest')}</span>
                    <span>${_('device_detail.chart_newest')}</span>
                </div>
            </div>`;
        }

        html += `</div>`;
        return html;
    }

    // ── Tags & Notes tab ──

    function _tagsPane() {
        const d = device;
        const tags = d.tags || [];
        const hasTags = tags.length > 0;

        let html = `<div class="device-panel-tab-pane" data-pane="tags">`;

        // Tags section
        html += `
        <div class="device-panel-section">
            <div class="device-panel-section-title"><span class="material-icons">sell</span> ${_('device_detail.tags')}</div>
            <div class="device-panel-tags-container" id="dp-tags-list">
                ${hasTags
                    ? tags.map(t => `
                        <span class="device-panel-tag">
                            ${Utils.escapeHtml(t)}
                            <button class="device-panel-tag-remove" data-tag="${Utils.escapeHtml(t)}" title="${_('actions.delete')}">
                                <span class="material-icons">close</span>
                            </button>
                        </span>`).join('')
                    : `<div class="device-panel-tags-empty">${_('device_detail.no_tags')}</div>`
                }
            </div>
            <div class="device-panel-tag-input-row">
                <input type="text" class="device-panel-tag-input" id="dp-tag-input"
                       placeholder="${_('device_detail.tag_placeholder')}" maxlength="50" list="dp-tag-suggestions">
                <datalist id="dp-tag-suggestions">
                    ${_tagSuggestionOptions(tags)}
                </datalist>
                <button class="device-panel-tag-add-btn" id="dp-tag-add-btn">
                    <span class="material-icons">add</span>${_('device_detail.add_tag')}
                </button>
            </div>
        </div>`;

        // Notes section
        html += `
        <div class="device-panel-section">
            <div class="device-panel-section-title"><span class="material-icons">notes</span> ${_('device_detail.notes')}</div>
            <textarea class="device-panel-notes-textarea" id="dp-notes-textarea"
                      placeholder="${_('device_detail.notes_placeholder')}">${Utils.escapeHtml(d.note || '')}</textarea>
            <div class="device-panel-notes-actions">
                <button class="btn btn-primary btn-sm" id="dp-notes-save">
                    <span class="material-icons">save</span>${_('actions.save')}
                </button>
            </div>
        </div>`;

        html += `</div>`;
        return html;
    }

    // ── Actions tab ──

    function _actionsPane() {
        const d = device;
        const isBanned = d.banned;

        let html = `<div class="device-panel-tab-pane" data-pane="actions">`;

        // Connection actions
        html += `
        <div class="device-panel-section">
            <div class="device-panel-section-title"><span class="material-icons">link</span> ${_('device_detail.section_connect')}</div>
            <div class="device-panel-actions-grid">
                <div class="device-panel-action-card" data-action="connect-desktop">
                    <div class="device-panel-action-icon purple">
                        <span class="material-icons">computer</span>
                    </div>
                    <div class="device-panel-action-text">
                        <div class="device-panel-action-title">${_('device_detail.action_connect_desktop')}</div>
                        <div class="device-panel-action-desc">${_('device_detail.action_connect_desktop_desc')}</div>
                    </div>
                </div>
                <div class="device-panel-action-card" data-action="connect-web">
                    <div class="device-panel-action-icon blue">
                        <span class="material-icons">screen_share</span>
                    </div>
                    <div class="device-panel-action-text">
                        <div class="device-panel-action-title">${_('device_detail.action_connect_web')}</div>
                        <div class="device-panel-action-desc">${_('device_detail.action_connect_web_desc')}</div>
                    </div>
                </div>
            </div>
        </div>`;

        // Management actions
        html += `
        <div class="device-panel-section">
            <div class="device-panel-section-title"><span class="material-icons">settings</span> ${_('device_detail.section_manage')}</div>
            <div class="device-panel-actions-grid">
                <div class="device-panel-action-card" data-action="edit">
                    <div class="device-panel-action-icon blue">
                        <span class="material-icons">edit</span>
                    </div>
                    <div class="device-panel-action-text">
                        <div class="device-panel-action-title">${_('actions.edit')}</div>
                        <div class="device-panel-action-desc">${_('devices.display_name')} / ${_('devices.note')}</div>
                    </div>
                </div>
                <div class="device-panel-action-card" data-action="change-id">
                    <div class="device-panel-action-icon blue">
                        <span class="material-icons">swap_horiz</span>
                    </div>
                    <div class="device-panel-action-text">
                        <div class="device-panel-action-title">${_('devices.change_id')}</div>
                        <div class="device-panel-action-desc">${_('device_detail.action_change_id_desc')}</div>
                    </div>
                </div>
                <div class="device-panel-action-card" data-action="toggle-ban">
                    <div class="device-panel-action-icon ${isBanned ? 'green' : 'orange'}">
                        <span class="material-icons">${isBanned ? 'check_circle' : 'block'}</span>
                    </div>
                    <div class="device-panel-action-text">
                        <div class="device-panel-action-title">${isBanned ? _('actions.unban') : _('actions.ban')}</div>
                        <div class="device-panel-action-desc">${isBanned ? _('device_detail.action_unban_desc') : _('device_detail.action_ban_desc')}</div>
                    </div>
                </div>
            </div>
        </div>`;

        // Danger zone
        html += `
        <div class="device-panel-danger-zone">
            <div class="device-panel-section-title"><span class="material-icons">warning</span> ${_('device_detail.danger_zone')}</div>
            <div class="device-panel-actions-grid">
                <div class="device-panel-action-card" data-action="delete">
                    <div class="device-panel-action-icon red">
                        <span class="material-icons">delete_forever</span>
                    </div>
                    <div class="device-panel-action-text">
                        <div class="device-panel-action-title">${_('actions.delete')}</div>
                        <div class="device-panel-action-desc">${_('device_detail.action_delete_desc')}</div>
                    </div>
                </div>
            </div>
        </div>`;

        html += `</div>`;
        return html;
    }

    // ── Footer ──

    function _footerHTML() {
        return `
        <div class="device-panel-footer">
            <button class="btn btn-secondary" id="dp-edit-btn">
                <span class="material-icons">edit</span>${_('actions.edit')}
            </button>
            <button class="btn btn-primary" id="dp-connect-btn">
                <span class="material-icons">link</span>${_('actions.connect')}
            </button>
            <button class="btn btn-secondary" id="dp-close-btn">
                ${_('actions.close')}
            </button>
        </div>`;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Helpers
    // ──────────────────────────────────────────────────────────────────────

    function _infoRow(label, valueHTML, copyValue) {
        const copyBtn = copyValue
            ? `<button class="device-panel-copy-btn" data-copy="${Utils.escapeHtml(copyValue)}" title="${_('actions.copy')}">
                <span class="material-icons">content_copy</span>
               </button>`
            : '';
        return `
        <div class="device-panel-info-row">
            <span class="device-panel-info-label">${label}</span>
            <span class="device-panel-info-value">${valueHTML}${copyBtn}</span>
        </div>`;
    }

    /**
     * Render a metric card with circular progress indicator
     */
    function _metricCard(label, value, icon) {
        const pct = Math.min(100, Math.max(0, Math.round(value || 0)));
        const colorClass = pct > 90 ? 'critical' : pct > 70 ? 'warning' : 'normal';
        return `
        <div class="device-panel-metric-card ${colorClass}">
            <div class="device-panel-metric-header">
                <span class="material-icons">${icon}</span>
                <span class="device-panel-metric-label">${label}</span>
            </div>
            <div class="device-panel-metric-bar-container">
                <div class="device-panel-metric-bar" style="width: ${pct}%"></div>
            </div>
            <div class="device-panel-metric-value">${pct}%</div>
        </div>`;
    }

    /**
     * Render a mini bar chart from an array of values (0-100)
     */
    function _miniBarChart(values, type) {
        if (!values || values.length === 0) return '';
        // Reverse so oldest is on the left
        const reversed = [...values].reverse();
        return `<div class="device-panel-mini-bars">` +
            reversed.map(v => {
                const pct = Math.min(100, Math.max(0, Math.round(v || 0)));
                const colorClass = pct > 90 ? 'critical' : pct > 70 ? 'warning' : 'normal';
                return `<div class="device-panel-mini-bar ${colorClass}" style="height: ${Math.max(2, pct)}%" title="${pct}%"></div>`;
            }).join('') +
            `</div>`;
    }

    /**
     * Format CPU frequency
     */
    function _formatFreq(ghz) {
        if (!ghz || ghz <= 0) return '-';
        if (ghz >= 1) return ghz.toFixed(2) + ' GHz';
        return (ghz * 1000).toFixed(0) + ' MHz';
    }

    /**
     * Format memory size
     */
    function _formatMemory(gb) {
        if (!gb || gb <= 0) return '-';
        if (gb >= 1024) return (gb / 1024).toFixed(1) + ' TB';
        if (gb >= 1) return gb.toFixed(1) + ' GB';
        return (gb * 1024).toFixed(0) + ' MB';
    }

    /**
     * Safely parse JSON string or return fallback
     */
    function _safeParseJSON(val, fallback) {
        if (Array.isArray(val)) return val;
        if (typeof val === 'object' && val !== null) return val;
        if (typeof val !== 'string' || !val) return fallback;
        try { return JSON.parse(val); } catch (e) { return fallback; }
    }

    function _lastSeenValue(lastOnline) {
        if (!lastOnline) return '-';
        const abs = Utils.formatDate(lastOnline);
        const rel = Utils.formatRelativeTime(lastOnline);
        return `${abs} <span style="color:var(--text-tertiary);font-size:var(--font-size-xs)">(${rel})</span>`;
    }

    function _folderName(folderId) {
        if (!folderId) return _('folders.unassigned');
        // Try to get folder name from the global folders list (devices.js maintains it)
        if (window._betterdesk_folders) {
            const target = Number(folderId);
            const f = window._betterdesk_folders.find(item => Number(item.id) === target);
            if (f) return Utils.escapeHtml(f.name);
        }
        return '#' + folderId;
    }

    function _statusTierBadge(tier) {
        const cls = (tier || 'offline').toLowerCase();
        const label = _('status.' + cls) || cls;
        return `<span class="device-panel-status-badge ${cls}"><span class="status-dot"></span>${label}</span>`;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────────────

    function _attachEvents() {
        if (!overlayEl) return;
        const panel = overlayEl.querySelector('#device-panel-inner');

        // Close button
        panel.querySelector('.device-panel-close')?.addEventListener('click', close);

        // Footer buttons
        panel.querySelector('#dp-close-btn')?.addEventListener('click', close);
        panel.querySelector('#dp-edit-btn')?.addEventListener('click', function () {
            if (window.BetterDeskDevices && typeof window.BetterDeskDevices.showEditModal === 'function' && device) {
                window.BetterDeskDevices.showEditModal(device.id);
            } else {
                Notifications.error(_('errors.server_error'));
            }
        });
        panel.querySelector('#dp-connect-btn')?.addEventListener('click', function () {
            // Unified web remote client: always /remote/:id
            if (device) window.open('/remote/' + encodeURIComponent(device.id), '_blank');
        });

        // Tabs
        panel.querySelectorAll('.device-panel-tab').forEach(function (tab) {
            tab.addEventListener('click', function () {
                _switchTab(tab.dataset.tab);
            });
        });

        // Copy buttons
        panel.querySelectorAll('.device-panel-copy-btn').forEach(function (btn) {
            btn.addEventListener('click', async function (e) {
                e.stopPropagation();
                const text = btn.dataset.copy;
                if (!text) return;
                await Utils.copyToClipboard(text);
                Notifications.success(_('common.copied'));
            });
        });

        // Tag events
        _attachTagEvents(panel);

        // Notes save
        panel.querySelector('#dp-notes-save')?.addEventListener('click', _saveNotes);

        // Action cards
        panel.querySelectorAll('.device-panel-action-card').forEach(function (card) {
            card.addEventListener('click', function () {
                if (card.classList.contains('disabled')) return;
                _handleAction(card.dataset.action);
            });
        });
    }

    function _switchTab(tabId) {
        activeTab = tabId;
        if (!overlayEl) return;
        const panel = overlayEl.querySelector('#device-panel-inner');

        panel.querySelectorAll('.device-panel-tab').forEach(function (t) {
            t.classList.toggle('active', t.dataset.tab === tabId);
        });
        panel.querySelectorAll('.device-panel-tab-pane').forEach(function (p) {
            p.classList.toggle('active', p.dataset.pane === tabId);
        });

        // Lazy-load agent-backed tabs on first activation.
        const AGENT_TABS = ['services', 'processes', 'events', 'activity', 'files'];
        if (AGENT_TABS.indexOf(tabId) !== -1) {
            _loadAgentTab(tabId);
        }
    }

    // ── Agent-backed tabs ───────────────────────────────────────────────

    // Track which tabs have been loaded so we don't refetch on every click.
    const _agentTabLoaded = {};

    async function _loadAgentTab(tabId) {
        if (_agentTabLoaded[tabId]) return;
        _agentTabLoaded[tabId] = true;

        if (!device || !device.id) return;
        const pane = overlayEl?.querySelector(`[data-agent-pane="${tabId}"]`);
        if (!pane) return;

        pane.innerHTML = `<div class="device-panel-agent-loading">
            <span class="material-icons spinning">autorenew</span>
            <div>${_('common.loading')}</div>
        </div>`;

        const endpointMap = {
            services:  { method: 'GET',  url: `/api/devices/${encodeURIComponent(device.id)}/services`  },
            processes: { method: 'GET',  url: `/api/devices/${encodeURIComponent(device.id)}/processes` },
            events:    { method: 'GET',  url: `/api/devices/${encodeURIComponent(device.id)}/events?limit=200` },
            activity:  { method: 'GET',  url: `/api/devices/${encodeURIComponent(device.id)}/activity`  },
            files:     { method: 'POST', url: `/api/devices/${encodeURIComponent(device.id)}/files/browse`, body: { path: '/', show_hidden: false } }
        };

        const ep = endpointMap[tabId];
        if (!ep) return;

        try {
            let resp;
            if (ep.method === 'POST') {
                resp = await Utils.api(ep.url, { method: 'POST', body: JSON.stringify(ep.body) });
            } else {
                resp = await Utils.api(ep.url);
            }
            const data = (resp && resp.data) || resp || null;
            _renderAgentTab(tabId, data, pane);
        } catch (err) {
            _agentTabLoaded[tabId] = false; // allow retry
            pane.innerHTML = _agentErrorHTML(err, tabId);
        }
    }

    function _agentErrorHTML(err, tabId) {
        const msg = err && err.message ? String(err.message) : 'unknown';
        // Differentiate offline vs generic error for clearer UX.
        const isOffline = msg.indexOf('503') !== -1 || msg.indexOf('offline') !== -1;
        const isTimeout = msg.indexOf('504') !== -1 || msg.indexOf('timeout') !== -1;
        const icon = isOffline ? 'cloud_off' : isTimeout ? 'hourglass_empty' : 'error_outline';
        const title = isOffline
            ? _('device_detail.agent_offline') || 'Agent is offline'
            : isTimeout
            ? _('device_detail.agent_timeout') || 'Agent did not respond in time'
            : _('device_detail.agent_error') || 'Failed to load data from agent';
        return `<div class="device-panel-agent-error">
            <span class="material-icons">${icon}</span>
            <div class="device-panel-agent-error-title">${title}</div>
            <div class="device-panel-agent-error-hint">${Utils.escapeHtml(msg)}</div>
            <button class="btn btn-secondary btn-sm" data-retry-tab="${tabId}">
                <span class="material-icons">refresh</span>${_('actions.retry') || 'Retry'}
            </button>
        </div>`;
    }

    function _renderAgentTab(tabId, data, pane) {
        if (tabId === 'services') {
            pane.innerHTML = _renderServicesList(data);
        } else if (tabId === 'processes') {
            pane.innerHTML = _renderProcessList(data);
        } else if (tabId === 'events') {
            pane.innerHTML = _renderEventList(data);
        } else if (tabId === 'activity') {
            pane.innerHTML = _renderActivity(data);
        } else if (tabId === 'files') {
            pane.innerHTML = _renderFileBrowser(data, '/');
            _attachFileBrowserEvents(pane);
        }

        // Generic retry button handler
        pane.querySelector('[data-retry-tab]')?.addEventListener('click', function () {
            const tid = this.dataset.retryTab;
            _agentTabLoaded[tid] = false;
            _loadAgentTab(tid);
        });
    }

    function _renderServicesList(data) {
        const services = Array.isArray(data?.services) ? data.services : Array.isArray(data) ? data : [];
        if (!services.length) {
            return `<div class="device-panel-agent-empty"><span class="material-icons">inbox</span><div>${_('common.no_data')}</div></div>`;
        }
        const rows = services.slice(0, 500).map(s => `
            <tr>
                <td>${Utils.escapeHtml(s.name || '')}</td>
                <td>${Utils.escapeHtml(s.display_name || s.name || '')}</td>
                <td><span class="badge ${s.status === 'running' ? 'badge-success' : 'badge-neutral'}">${Utils.escapeHtml(s.status || '-')}</span></td>
                <td>${Utils.escapeHtml(s.start_type || '-')}</td>
            </tr>`).join('');
        return `<table class="device-panel-agent-table">
            <thead><tr>
                <th>${_('device_detail.service_name') || 'Name'}</th>
                <th>${_('device_detail.service_display') || 'Display'}</th>
                <th>${_('device_detail.service_status') || 'Status'}</th>
                <th>${_('device_detail.service_start') || 'Start'}</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
    }

    function _renderProcessList(data) {
        const procs = Array.isArray(data?.processes) ? data.processes : Array.isArray(data) ? data : [];
        if (!procs.length) {
            return `<div class="device-panel-agent-empty"><span class="material-icons">inbox</span><div>${_('common.no_data')}</div></div>`;
        }
        // Sort by CPU descending, show top 200
        procs.sort((a, b) => (b.cpu || 0) - (a.cpu || 0));
        const rows = procs.slice(0, 200).map(p => `
            <tr>
                <td>${Utils.escapeHtml(String(p.pid ?? '-'))}</td>
                <td>${Utils.escapeHtml(p.name || '-')}</td>
                <td>${Utils.escapeHtml(p.user || '-')}</td>
                <td>${Number(p.cpu || 0).toFixed(1)}%</td>
                <td>${Number(p.memory_mb || 0).toFixed(0)} MB</td>
            </tr>`).join('');
        return `<table class="device-panel-agent-table">
            <thead><tr>
                <th>PID</th>
                <th>${_('device_detail.process_name') || 'Name'}</th>
                <th>${_('device_detail.process_user') || 'User'}</th>
                <th>CPU</th>
                <th>${_('device_detail.process_memory') || 'Memory'}</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
    }

    function _renderEventList(data) {
        const events = Array.isArray(data?.events) ? data.events : Array.isArray(data) ? data : [];
        if (!events.length) {
            return `<div class="device-panel-agent-empty"><span class="material-icons">inbox</span><div>${_('common.no_data')}</div></div>`;
        }
        const rows = events.slice(0, 500).map(e => {
            const level = String(e.level || 'info').toLowerCase();
            const levelClass = level === 'error' || level === 'critical' ? 'error'
                : level === 'warning' || level === 'warn' ? 'warn' : 'info';
            return `<div class="device-panel-event-row ${levelClass}">
                <div class="device-panel-event-time">${Utils.escapeHtml(e.time || '')}</div>
                <div class="device-panel-event-source">${Utils.escapeHtml(e.source || e.facility || '-')}</div>
                <div class="device-panel-event-msg">${Utils.escapeHtml(e.message || '')}</div>
            </div>`;
        }).join('');
        return `<div class="device-panel-event-list">${rows}</div>`;
    }

    function _renderActivity(data) {
        const items = Array.isArray(data?.apps) ? data.apps : Array.isArray(data) ? data : [];
        if (!items.length) {
            return `<div class="device-panel-agent-empty"><span class="material-icons">inbox</span><div>${_('common.no_data')}</div></div>`;
        }
        // Sort by total seconds
        items.sort((a, b) => (b.seconds || 0) - (a.seconds || 0));
        const maxSec = Math.max(1, items[0].seconds || 1);
        const rows = items.slice(0, 50).map(a => {
            const pct = Math.min(100, ((a.seconds || 0) / maxSec) * 100);
            const minutes = Math.floor((a.seconds || 0) / 60);
            return `<div class="device-panel-activity-row">
                <div class="device-panel-activity-name">${Utils.escapeHtml(a.name || a.app || '-')}</div>
                <div class="device-panel-activity-bar">
                    <div class="device-panel-activity-bar-fill" style="width:${pct.toFixed(1)}%"></div>
                </div>
                <div class="device-panel-activity-time">${minutes} min</div>
            </div>`;
        }).join('');
        return `<div class="device-panel-activity-list">${rows}</div>`;
    }

    function _renderFileBrowser(data, currentPath) {
        const entries = Array.isArray(data?.entries) ? data.entries : Array.isArray(data) ? data : [];
        const path = data?.path || currentPath || '/';
        const parent = data?.parent || null;
        const rows = entries.slice(0, 1000).map(e => {
            const icon = e.is_dir ? 'folder' : 'description';
            const size = e.is_dir ? '' : _formatBytes(e.size || 0);
            return `<div class="device-panel-file-row" data-is-dir="${e.is_dir ? '1' : '0'}" data-path="${Utils.escapeHtml(e.path || '')}">
                <span class="material-icons">${icon}</span>
                <div class="device-panel-file-name">${Utils.escapeHtml(e.name || '')}</div>
                <div class="device-panel-file-size">${size}</div>
            </div>`;
        }).join('');
        return `<div class="device-panel-file-browser">
            <div class="device-panel-file-path">
                ${parent ? `<button class="btn btn-secondary btn-sm" data-fb-up="${Utils.escapeHtml(parent)}">
                    <span class="material-icons">arrow_upward</span>
                </button>` : ''}
                <span>${Utils.escapeHtml(path)}</span>
            </div>
            <div class="device-panel-file-list">${rows}</div>
        </div>`;
    }

    function _attachFileBrowserEvents(pane) {
        pane.querySelectorAll('[data-fb-up]').forEach(btn => {
            btn.addEventListener('click', () => _browseFiles(btn.dataset.fbUp));
        });
        pane.querySelectorAll('.device-panel-file-row').forEach(row => {
            row.addEventListener('dblclick', () => {
                if (row.dataset.isDir === '1') _browseFiles(row.dataset.path);
            });
        });
    }

    async function _browseFiles(path) {
        if (!device || !device.id) return;
        const pane = overlayEl?.querySelector('[data-agent-pane="files"]');
        if (!pane) return;
        pane.innerHTML = `<div class="device-panel-agent-loading"><span class="material-icons spinning">autorenew</span><div>${_('common.loading')}</div></div>`;
        try {
            const resp = await Utils.api(`/api/devices/${encodeURIComponent(device.id)}/files/browse`, {
                method: 'POST',
                body: JSON.stringify({ path, show_hidden: false })
            });
            pane.innerHTML = _renderFileBrowser(resp?.data || resp, path);
            _attachFileBrowserEvents(pane);
        } catch (err) {
            pane.innerHTML = _agentErrorHTML(err, 'files');
            pane.querySelector('[data-retry-tab]')?.addEventListener('click', function () {
                _agentTabLoaded['files'] = false;
                _loadAgentTab('files');
            });
        }
    }

    function _formatBytes(n) {
        if (!n) return '0 B';
        const k = 1024;
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(k)));
        return (n / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
    }

    // ── Tags ──

    function _attachTagEvents(panel) {
        const addBtn = panel.querySelector('#dp-tag-add-btn');
        const input = panel.querySelector('#dp-tag-input');

        _loadTagSuggestions(panel);

        if (addBtn && input) {
            addBtn.addEventListener('click', function () { _addTag(input.value.trim()); });
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); _addTag(input.value.trim()); }
            });
        }

        panel.querySelectorAll('.device-panel-tag-remove').forEach(function (btn) {
            btn.addEventListener('click', function () { _removeTag(btn.dataset.tag); });
        });
    }

    async function _addTag(tag) {
        if (!tag || !device) return;
        const tags = [...(device.tags || [])];
        if (tags.includes(tag)) {
            Notifications.warning(_('device_detail.tag_exists'));
            return;
        }
        tags.push(tag);
        await _saveTags(tags);
    }

    async function _removeTag(tag) {
        if (!device) return;
        const tags = (device.tags || []).filter(function (t) { return t !== tag; });
        await _saveTags(tags);
    }

    async function _saveTags(tags) {
        try {
            await Utils.api('/api/devices/' + encodeURIComponent(device.id) + '/tags', {
                method: 'PUT',
                body: { tags: tags }
            });
            device.tags = tags;
            availableTags = Array.from(new Set(availableTags.concat(tags))).sort(function (a, b) {
                return a.localeCompare(b);
            });
            _render();
            _switchTab('tags');
            _notifyChanged();
            Notifications.success(_('common.saved'));
        } catch (err) {
            Notifications.error(err.message || _('errors.server_error'));
        }
    }

    function _tagSuggestionOptions(currentTags) {
        const current = new Set(currentTags || []);
        return (availableTags || [])
            .filter(function (tag) { return tag && !current.has(tag); })
            .map(function (tag) { return `<option value="${Utils.escapeHtml(tag)}"></option>`; })
            .join('');
    }

    function _updateTagSuggestions(panel) {
        const list = panel.querySelector('#dp-tag-suggestions');
        if (!list || !device) return;
        list.innerHTML = _tagSuggestionOptions(device.tags || []);
    }

    async function _loadTagSuggestions(panel) {
        if (availableTagsLoaded) {
            _updateTagSuggestions(panel);
            return;
        }

        try {
            const response = await Utils.api('/api/tags');
            availableTags = response.tags || [];
        } catch (_) {
            availableTags = [];
        }

        availableTagsLoaded = true;
        _updateTagSuggestions(panel);
    }

    // ── Notes ──

    async function _saveNotes() {
        if (!device) return;
        const textarea = overlayEl.querySelector('#dp-notes-textarea');
        if (!textarea) return;
        const note = textarea.value.trim();

        try {
            await Utils.api('/api/devices/' + encodeURIComponent(device.id), {
                method: 'PATCH',
                body: { note: note }
            });
            device.note = note;
            _notifyChanged();
            Notifications.success(_('common.saved'));
        } catch (err) {
            Notifications.error(err.message || _('errors.server_error'));
        }
    }

    // ── Actions ──

    async function _handleAction(action) {
        if (!device) return;

        switch (action) {
            case 'edit':
                if (window.BetterDeskDevices && typeof window.BetterDeskDevices.showEditModal === 'function') {
                    window.BetterDeskDevices.showEditModal(device.id);
                } else {
                    Notifications.error(_('errors.server_error'));
                }
                break;

            case 'connect-desktop':
                window.open('rustdesk://' + encodeURIComponent(device.id), '_blank');
                break;

            case 'connect-web':
                // Unified web remote client: always /remote/:id
                window.open('/remote/' + encodeURIComponent(device.id), '_blank');
                break;

            case 'change-id':
                await _changeId();
                break;

            case 'toggle-ban':
                await _toggleBan();
                break;

            case 'delete':
                await _deleteDevice();
                break;
        }
    }

    async function _changeId() {
        // Capture device ID before async operation — panel close sets device=null
        const deviceId = device && device.id;
        if (!deviceId) return;

        const newId = await Modal.prompt({
            title: _('devices.change_id_title'),
            label: _('devices.new_id'),
            placeholder: 'NEWID123',
            hint: _('devices.change_id_hint')
        });
        if (!newId) return;
        if (newId.length < 6 || newId.length > 16) {
            Notifications.error(_('devices.id_length_error'));
            return;
        }
        if (!/^[A-Z0-9_-]+$/i.test(newId)) {
            Notifications.error(_('devices.id_format_error'));
            return;
        }
        try {
            await Utils.api('/api/devices/' + encodeURIComponent(deviceId) + '/change-id', {
                method: 'POST',
                body: { newId: newId.toUpperCase() }
            });
            Notifications.success(_('devices.change_id_success'));
            close();
            _notifyChanged();
        } catch (err) {
            Notifications.error(err.message || _('errors.change_id_failed'));
        }
    }

    async function _toggleBan() {
        // Capture before async — panel close sets device=null
        const deviceId = device && device.id;
        const isBanned = device && device.banned;
        if (!deviceId) return;

        const action = isBanned ? 'unban' : 'ban';
        const confirmed = await Modal.confirm({
            title: _('devices.' + action + '_title'),
            message: _('devices.' + action + '_confirm', { id: deviceId }),
            confirmLabel: _(isBanned ? 'actions.unban' : 'actions.ban'),
            danger: !isBanned
        });
        if (!confirmed) return;
        try {
            await Utils.api('/api/devices/' + encodeURIComponent(deviceId) + '/' + action, { method: 'POST' });
            Notifications.success(_('devices.' + action + '_success'));
            // Refresh panel if still open
            if (overlayEl) {
                device = await Utils.api('/api/devices/' + encodeURIComponent(deviceId));
                _render();
                _switchTab('actions');
            }
            _notifyChanged();
        } catch (err) {
            Notifications.error(err.message || _('errors.' + action + '_failed'));
        }
    }

    async function _deleteDevice() {
        // Capture before async — panel close sets device=null
        const deviceId = device && device.id;
        if (!deviceId) return;

        const confirmed = await Modal.confirm({
            title: _('devices.delete_title'),
            message: _('devices.delete_confirm', { id: deviceId }),
            confirmLabel: _('actions.delete'),
            confirmIcon: 'delete',
            danger: true
        });
        if (!confirmed) return;
        try {
            await Utils.api('/api/devices/' + encodeURIComponent(deviceId), { method: 'DELETE' });
            Notifications.success(_('devices.delete_success'));
            close();
            _notifyChanged();
        } catch (err) {
            Notifications.error(err.message || _('errors.delete_failed'));
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    // Auto-refresh
    // ──────────────────────────────────────────────────────────────────────

    function _startRefresh(deviceId) {
        _stopRefresh();
        refreshTimer = setInterval(async function () {
            try {
                const updated = await Utils.api('/api/devices/' + encodeURIComponent(deviceId));
                if (updated && overlayEl) {
                    device = updated;
                    // Only re-render header status (minimal update, avoid losing form state)
                    const statusBar = overlayEl.querySelector('.device-panel-status-bar');
                    if (statusBar) {
                        const statusInfo = _resolveDeviceStatus(device);
                        const badge = statusBar.querySelector('.device-panel-status-badge');
                        if (badge) {
                            badge.className = 'device-panel-status-badge ' + statusInfo.className;
                            if (statusInfo.title) {
                                badge.title = statusInfo.title;
                            } else {
                                badge.removeAttribute('title');
                            }
                            badge.innerHTML = '<span class="status-dot"></span>' + statusInfo.label;
                        }
                    }
                }
            } catch (e) {
                // Silent — device may have been deleted
            }
        }, 15000);
    }

    function _stopRefresh() {
        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    // Notify parent (devices table) of changes
    // ──────────────────────────────────────────────────────────────────────

    function _notifyChanged() {
        document.dispatchEvent(new CustomEvent('deviceDetail:changed'));
    }

    // ──────────────────────────────────────────────────────────────────────
    // Cleanup on navigation
    // ──────────────────────────────────────────────────────────────────────
    window.addEventListener('beforeunload', function () {
        _stopRefresh();
    });

    return { open: open, close: close };
})();

window.DeviceDetail = DeviceDetail;
