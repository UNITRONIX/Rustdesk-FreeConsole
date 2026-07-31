/**
 * BetterDesk Console - Registrations Page Script
 */

(function () {
    'use strict';

    const _ = window.BetterDesk?.translations
        ? (key) => {
            const keys = key.split('.');
            let val = window.BetterDesk.translations;
            for (const k of keys) { val = val?.[k]; }
            return val || key;
        }
        : (key) => key;

    const csrfToken = window.BetterDesk?.csrfToken || '';

    // State
    let currentStatus = '';
    let currentSearch = '';
    let rejectTargetId = null;
    let rejectTargetSource = null;
    let approveTargetId = null;
    let approveTargetSource = null;
    let foldersLoaded = false;
    let groupsLoaded = false;
    let manualDeviceGroups = [];

    let enrollmentUi = {
        mode: 'open',
        rich_approve: true,
        tag_picker: true,
    };
    const selectedApproveTags = new Set();
    let availableTags = [];

    const SOURCE_REGISTRATION = 'registration';
    const SOURCE_ENROLLMENT = 'enrollment';

    // ---- DOM refs ----
    const tbody = document.getElementById('registrations-body');
    const searchInput = document.getElementById('search-input');
    const pendingCountBadge = document.getElementById('pending-count');
    const filterButtons = document.querySelectorAll('.filter-btn');
    const rejectModal = document.getElementById('reject-modal');
    const rejectReasonInput = document.getElementById('reject-reason');
    const rejectBanCheckbox = document.getElementById('reject-ban-checkbox');
    const rejectBanGroup = document.getElementById('reject-ban-group');
    const confirmRejectBtn = document.getElementById('confirm-reject-btn');
    const approveModal = document.getElementById('approve-modal');
    const approveDeviceIdEl = document.getElementById('approve-device-id');
    const approveDisplayNameInput = document.getElementById('approve-display-name');
    const approveSyncModeSelect = document.getElementById('approve-sync-mode');
    const approveTagsInput = document.getElementById('approve-tags');
    const approveFolderSelect = document.getElementById('approve-folder');
    const confirmApproveBtn = document.getElementById('confirm-approve-btn');
    const approveTagsTextGroup = document.getElementById('approve-tags-text-group');
    const approveTagsPickerGroup = document.getElementById('approve-tags-picker-group');
    const approveTagsPickerEl = document.getElementById('approve-tags-picker');
    const approveTagsSelectedEl = document.getElementById('approve-tags-selected');
    const approveTagNewInput = document.getElementById('approve-tag-new');
    const approveTagAddBtn = document.getElementById('approve-tag-add-btn');
    const approveGroupsPickerEl = document.getElementById('approve-groups-picker');
    const enrollmentModeBanner = document.getElementById('enrollment-mode-banner');
    const enrollmentModeBannerText = document.getElementById('enrollment-mode-banner-text');

    // ---- API helpers ----

    async function apiFetch(url, options = {}) {
        const headers = { 'Content-Type': 'application/json' };
        if (csrfToken) headers['x-csrf-token'] = csrfToken;
        const resp = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
        return resp.json();
    }

    // ---- Load registrations ----

    async function loadRegistrations() {
        const params = new URLSearchParams();
        if (currentStatus) params.set('status', currentStatus);
        if (currentSearch) params.set('search', currentSearch);

        tbody.innerHTML = `
            <tr class="loading-row">
                <td colspan="8">${_('common.loading')}</td>
            </tr>
        `;

        try {
            const [registrationResult, enrollmentResult] = await Promise.all([
                apiFetch(`/api/registrations?${params}`),
                shouldLoadEnrollmentPending() ? apiFetch('/api/enrollment/pending') : Promise.resolve({ success: true, data: [], count: 0 }),
            ]);
            if (!registrationResult.success) throw new Error(registrationResult.error);

            const registrations = normalizeRegistrations(registrationResult.data || []);
            const enrollments = enrollmentResult.success
                ? normalizeEnrollments(enrollmentResult.data || []).filter(matchesSearch)
                : [];

            renderTable([...enrollments, ...registrations]);
        } catch (err) {
            tbody.innerHTML = `
                <tr class="empty-row">
                    <td colspan="8">
                        <div class="empty-state">
                            <span class="material-icons">error_outline</span>
                            <p>${err.message || _('errors.server_error')}</p>
                        </div>
                    </td>
                </tr>
            `;
        }
    }

    async function loadPendingCount() {
        try {
            const [registrationResult, enrollmentResult] = await Promise.all([
                apiFetch('/api/registrations/count'),
                apiFetch('/api/enrollment/pending'),
            ]);
            const count = (registrationResult.count || 0) + (enrollmentResult.count || 0);
            pendingCountBadge.textContent = count;
            pendingCountBadge.style.display = count > 0 ? '' : 'none';

            // Update sidebar badge too
            const sidebarBadge = document.getElementById('reg-sidebar-badge');
            if (sidebarBadge) {
                sidebarBadge.textContent = count;
                sidebarBadge.style.display = count > 0 ? '' : 'none';
            }
        } catch (_) { /* silent */ }
    }

    // ---- Render ----

    function renderTable(registrations) {
        if (!registrations.length) {
            tbody.innerHTML = `
                <tr class="empty-row">
                    <td colspan="8">
                        <div class="empty-state">
                            <span class="material-icons">how_to_reg</span>
                            <p>${_('registrations.no_registrations')}</p>
                        </div>
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = registrations.map(reg => {
            const source = reg.source || SOURCE_REGISTRATION;
            const rowId = String(reg.row_id || reg.id || reg.device_id || '');
            const statusClass = String(reg.status || '');
            const statusLabel = _(`registrations.status_${reg.status}`) || reg.status;
            const platformIcon = getPlatformIcon(reg.platform);
            const timeAgo = formatTimeAgo(reg.created_at);

            let actions = '';
            if (reg.status === 'pending') {
                actions = `
                    <button class="action-btn approve" data-reg-action="approve" data-source="${escapeAttr(source)}" data-id="${escapeAttr(rowId)}" title="${escapeAttr(_('registrations.approve_btn'))}">
                        <span class="material-icons">check</span>
                        ${_('registrations.approve_btn')}
                    </button>
                    <button class="action-btn reject" data-reg-action="reject" data-source="${escapeAttr(source)}" data-id="${escapeAttr(rowId)}" title="${escapeAttr(_('registrations.reject_btn'))}">
                        <span class="material-icons">close</span>
                        ${_('registrations.reject_btn')}
                    </button>
                `;
            } else if (source === SOURCE_REGISTRATION) {
                actions = `
                    <button class="action-btn delete" data-reg-action="remove" data-source="${escapeAttr(source)}" data-id="${escapeAttr(rowId)}" title="${escapeAttr(_('common.delete'))}">
                        <span class="material-icons">delete</span>
                    </button>
                `;
            }

            return `
                <tr data-id="${escapeAttr(rowId)}" data-source="${escapeAttr(source)}">
                    <td class="device-id-cell">${escapeHtml(reg.device_id)}</td>
                    <td>${escapeHtml(reg.hostname || '—')}</td>
                    <td class="col-platform">
                        <div class="platform-cell">
                            <span class="material-icons">${platformIcon}</span>
                            ${escapeHtml(reg.platform || '—')}
                        </div>
                    </td>
                    <td>${escapeHtml(reg.ip_address || '—')}</td>
                    <td class="col-version">${escapeHtml(reg.version || '—')}</td>
                    <td class="col-status"><span class="status-badge ${escapeAttr(statusClass)}">${escapeHtml(statusLabel)}</span></td>
                    <td class="col-requested time-cell" title="${escapeAttr(reg.created_at || '')}">${timeAgo}</td>
                    <td class="col-actions">
                        <div class="action-btn-group">${actions}</div>
                    </td>
                </tr>
            `;
        }).join('');
    }

    // ---- Actions ----

    async function loadEnrollmentUiSettings() {
        try {
            const result = await apiFetch('/api/registrations/enrollment-ui');
            if (result.success && result.data) {
                enrollmentUi = { ...enrollmentUi, ...result.data };
            }
        } catch (_) { /* keep defaults */ }
        updateEnrollmentBanner();
    }

    function updateEnrollmentBanner() {
        if (!enrollmentModeBanner || !enrollmentModeBannerText) return;
        if (enrollmentUi.mode === 'managed') {
            enrollmentModeBanner.style.display = 'none';
            return;
        }
        enrollmentModeBanner.style.display = '';
        enrollmentModeBannerText.textContent = enrollmentUi.mode === 'locked'
            ? _('registrations.banner_locked_mode')
            : _('registrations.banner_open_mode');
    }

    async function loadTagsForPicker() {
        try {
            const result = await apiFetch('/api/tags');
            availableTags = (result.success && result.data?.tags) ? result.data.tags : (result.tags || []);
        } catch (_) {
            availableTags = [];
        }
        renderTagPicker();
    }

    function renderTagPicker() {
        if (!approveTagsPickerEl) return;
        if (!availableTags.length) {
            approveTagsPickerEl.innerHTML = `<span class="form-hint">${_('devices.no_tags')}</span>`;
            return;
        }
        approveTagsPickerEl.innerHTML = availableTags.map(tag => {
            const checked = selectedApproveTags.has(tag) ? 'checked' : '';
            return `<label class="tag-filter-option">
                <input type="checkbox" value="${escapeAttr(tag)}" ${checked}>
                <span>${escapeHtml(tag)}</span>
            </label>`;
        }).join('');
        approveTagsPickerEl.querySelectorAll('input[type="checkbox"]').forEach(input => {
            input.addEventListener('change', () => {
                if (input.checked) selectedApproveTags.add(input.value);
                else selectedApproveTags.delete(input.value);
                renderSelectedApproveTags();
                syncTagsTextInput();
            });
        });
        renderSelectedApproveTags();
    }

    function renderSelectedApproveTags() {
        if (!approveTagsSelectedEl) return;
        if (!selectedApproveTags.size) {
            approveTagsSelectedEl.innerHTML = '';
            return;
        }
        approveTagsSelectedEl.innerHTML = [...selectedApproveTags].map(tag =>
            `<span class="device-tag-pill">${escapeHtml(tag)}</span>`
        ).join('');
    }

    function syncTagsTextInput() {
        if (approveTagsInput) {
            approveTagsInput.value = [...selectedApproveTags].join(', ');
        }
    }

    function parseTagsFromText(text) {
        return String(text || '')
            .split(',')
            .map(t => t.trim())
            .filter(Boolean);
    }

    function collectApproveTags() {
        if (enrollmentUi.tag_picker) {
            const fromText = parseTagsFromText(approveTagsInput?.value || '');
            fromText.forEach(t => selectedApproveTags.add(t));
            return [...selectedApproveTags].join(', ');
        }
        return (approveTagsInput?.value || '').trim();
    }

    function collectSelectedGroupGuids() {
        if (!approveGroupsPickerEl) return [];
        return [...approveGroupsPickerEl.querySelectorAll('input[type="checkbox"]:checked')]
            .map(el => el.value)
            .filter(Boolean);
    }

    function applyTagPickerVisibility() {
        const usePicker = !!enrollmentUi.tag_picker;
        if (approveTagsTextGroup) approveTagsTextGroup.style.display = usePicker ? 'none' : '';
        if (approveTagsPickerGroup) approveTagsPickerGroup.style.display = usePicker ? '' : 'none';
    }

    async function loadDeviceGroups() {
        if (!approveGroupsPickerEl) return;
        try {
            const result = await apiFetch('/api/device-groups');
            const groups = result.success
                ? ((result.data && result.data.groups) || result.groups || [])
                : [];
            manualDeviceGroups = groups.filter(g => (g.source_type || 'manual') !== 'tag');
            groupsLoaded = true;
            if (!manualDeviceGroups.length) {
                approveGroupsPickerEl.innerHTML = `<span class="form-hint">${_('devices.no_groups')}</span>`;
                return;
            }
            approveGroupsPickerEl.innerHTML = manualDeviceGroups.map(group => `
                <label class="tag-filter-option">
                    <input type="checkbox" value="${escapeAttr(group.guid)}">
                    <span>${escapeHtml(group.name || group.guid)}</span>
                </label>
            `).join('');
        } catch (_) {
            approveGroupsPickerEl.innerHTML = `<span class="form-hint">${_('errors.server_error')}</span>`;
        }
    }

    async function loadFolders() {
        // Populate folder dropdown once; keep the default "no folder" option.
        try {
            const result = await apiFetch('/api/folders');
            const folders = result.success ? ((result.data && result.data.folders) || result.folders || []) : [];
            // Reset to the default option, then append folders.
            approveFolderSelect.querySelectorAll('option:not([value="0"])').forEach(o => o.remove());
            folders.forEach(folder => {
                const opt = document.createElement('option');
                opt.value = String(folder.id);
                opt.textContent = folder.name || folder.label || `#${folder.id}`;
                approveFolderSelect.appendChild(opt);
            });
            foldersLoaded = true;
        } catch (_) {
            // Folder list is optional; ignore errors.
        }
    }

    function openApproveModal(id, source) {
        approveTargetId = id;
        approveTargetSource = source || SOURCE_ENROLLMENT;
        approveDeviceIdEl.textContent = id;
        approveDisplayNameInput.value = '';
        approveSyncModeSelect.value = 'standard';
        approveTagsInput.value = '';
        selectedApproveTags.clear();
        approveFolderSelect.value = '0';
        if (approveGroupsPickerEl) {
            approveGroupsPickerEl.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
        }
        applyTagPickerVisibility();
        if (!foldersLoaded) loadFolders();
        if (!groupsLoaded) loadDeviceGroups();
        if (enrollmentUi.tag_picker) loadTagsForPicker();
        else renderSelectedApproveTags();
        approveModal.style.display = 'flex';
        setTimeout(() => approveDisplayNameInput.focus(), 50);
    }

    async function confirmApprove() {
        if (!approveTargetId) return;
        const payload = {
            display_name: approveDisplayNameInput.value.trim(),
            sync_mode: approveSyncModeSelect.value || 'standard',
            tags: collectApproveTags(),
            folder_id: parseInt(approveFolderSelect.value, 10) || 0,
            group_guids: collectSelectedGroupGuids(),
        };

        try {
            let result;
            if (approveTargetSource === SOURCE_ENROLLMENT) {
                result = await apiFetch(`/api/enrollment/approve/${encodeURIComponent(approveTargetId)}`, {
                    method: 'POST',
                    body: JSON.stringify(payload),
                });
            } else {
                result = await apiFetch(`/api/registrations/${encodeURIComponent(approveTargetId)}/approve`, {
                    method: 'PUT',
                    body: JSON.stringify(payload),
                });
            }
            if (!result.success) throw new Error(result.error);

            approveModal.style.display = 'none';
            const wasEnrollment = approveTargetSource === SOURCE_ENROLLMENT;
            approveTargetId = null;
            approveTargetSource = null;
            showToast(
                wasEnrollment ? _('registrations.enrollment_approved_success') : _('registrations.approved_success'),
                'success'
            );
            loadRegistrations();
            loadPendingCount();
        } catch (err) {
            showToast(err.message || _('errors.server_error'), 'error');
        }
    }

    async function approveRegistration(id, source) {
        const useRichModal = source === SOURCE_ENROLLMENT || enrollmentUi.rich_approve;
        if (useRichModal) {
            openApproveModal(id, source);
            return;
        }

        if (!confirm(_('registrations.approve_confirm'))) return;
        try {
            const result = await apiFetch(`/api/registrations/${encodeURIComponent(id)}/approve`, { method: 'PUT' });
            if (!result.success) throw new Error(result.error);

            showToast(_('registrations.approved_success'), 'success');
            loadRegistrations();
            loadPendingCount();
        } catch (err) {
            showToast(err.message || _('errors.server_error'), 'error');
        }
    }

    function openRejectModal(id, source) {
        rejectTargetId = id;
        rejectTargetSource = source || SOURCE_REGISTRATION;
        rejectReasonInput.value = '';
        if (rejectBanCheckbox) rejectBanCheckbox.checked = false;
        // The ban option only applies to enrollment (stock RustDesk) requests.
        if (rejectBanGroup) {
            rejectBanGroup.style.display = rejectTargetSource === SOURCE_ENROLLMENT ? '' : 'none';
        }
        rejectModal.style.display = 'flex';
    }

    async function confirmReject() {
        if (!rejectTargetId) return;

        try {
            const result = rejectTargetSource === SOURCE_ENROLLMENT
                ? await apiFetch(`/api/enrollment/reject/${encodeURIComponent(rejectTargetId)}`, {
                    method: 'POST',
                    body: JSON.stringify({ ban: !!(rejectBanCheckbox && rejectBanCheckbox.checked) }),
                })
                : await apiFetch(`/api/registrations/${encodeURIComponent(rejectTargetId)}/reject`, {
                    method: 'PUT',
                    body: JSON.stringify({ reason: rejectReasonInput.value }),
                });
            if (!result.success) throw new Error(result.error);

            const wasEnrollment = rejectTargetSource === SOURCE_ENROLLMENT;
            rejectModal.style.display = 'none';
            rejectTargetId = null;
            rejectTargetSource = null;
            showToast(wasEnrollment ? _('registrations.enrollment_rejected_success') : _('registrations.rejected_success'), 'success');
            loadRegistrations();
            loadPendingCount();
        } catch (err) {
            showToast(err.message || _('errors.server_error'), 'error');
        }
    }

    async function deleteRegistration(id) {
        if (!confirm(_('registrations.delete_confirm'))) return;

        try {
            const result = await apiFetch(`/api/registrations/${encodeURIComponent(id)}`, { method: 'DELETE' });
            if (!result.success) throw new Error(result.error);

            showToast(_('registrations.deleted_success'), 'success');
            loadRegistrations();
            loadPendingCount();
        } catch (err) {
            showToast(err.message || _('errors.server_error'), 'error');
        }
    }

    // ---- Helpers ----

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = String(str || '');
        return div.innerHTML;
    }

    function escapeAttr(str) {
        return escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function shouldLoadEnrollmentPending() {
        return !currentStatus || currentStatus === 'pending';
    }

    function normalizeRegistrations(items) {
        return items.map(item => ({
            ...item,
            row_id: String(item.id),
            source: SOURCE_REGISTRATION,
            ip_address: item.ip_address || item.ip || '',
        }));
    }

    function normalizeEnrollments(items) {
        return items.map(item => ({
            ...item,
            id: item.device_id,
            row_id: item.device_id,
            source: SOURCE_ENROLLMENT,
            status: 'pending',
            ip_address: item.ip || item.ip_address || '',
        }));
    }

    function matchesSearch(reg) {
        if (!currentSearch) return true;
        const needle = currentSearch.toLowerCase();
        return [reg.device_id, reg.hostname, reg.ip_address, reg.platform, reg.version]
            .some(value => String(value || '').toLowerCase().includes(needle));
    }

    function getPlatformIcon(platform) {
        if (!platform) return 'devices';
        const p = platform.toLowerCase();
        if (p.includes('windows')) return 'laptop_windows';
        if (p.includes('linux')) return 'computer';
        if (p.includes('mac') || p.includes('darwin')) return 'laptop_mac';
        if (p.includes('android')) return 'phone_android';
        if (p.includes('ios')) return 'phone_iphone';
        return 'devices';
    }

    function formatTimeAgo(dateStr) {
        if (!dateStr) return '—';
        const d = new Date(dateStr);
        const diff = Math.floor((Date.now() - d) / 1000);
        if (diff < 60) return _('time.seconds_ago').replace('{count}', diff);
        if (diff < 3600) return _('time.minutes_ago').replace('{count}', Math.floor(diff / 60));
        if (diff < 86400) return _('time.hours_ago').replace('{count}', Math.floor(diff / 3600));
        if (diff < 2592000) return _('time.days_ago').replace('{count}', Math.floor(diff / 86400));
        return d.toLocaleDateString();
    }

    function showToast(message, type) {
        // Use BetterDesk notification system if available
        if (window.BetterDesk?.notify) {
            window.BetterDesk.notify(message, type);
            return;
        }
        // Fallback: use toast container
        const container = document.getElementById('toast-container');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = `toast toast-${type || 'info'}`;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
    }

    // ---- Event listeners ----

    // Filter buttons
    filterButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            filterButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentStatus = btn.dataset.status;
            loadRegistrations();
        });
    });

    // Search
    let searchTimeout;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            currentSearch = searchInput.value.trim();
            loadRegistrations();
        }, 300);
    });

    // Reject modal
    confirmRejectBtn.addEventListener('click', confirmReject);

    // Approve modal
    if (confirmApproveBtn) confirmApproveBtn.addEventListener('click', confirmApprove);
    if (approveTagAddBtn && approveTagNewInput) {
        approveTagAddBtn.addEventListener('click', () => {
            const tag = approveTagNewInput.value.trim();
            if (!tag) return;
            selectedApproveTags.add(tag);
            if (!availableTags.includes(tag)) availableTags.push(tag);
            approveTagNewInput.value = '';
            renderTagPicker();
            syncTagsTextInput();
        });
        approveTagNewInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                approveTagAddBtn.click();
            }
        });
    }

    tbody.addEventListener('click', (e) => {
        const actionBtn = e.target.closest('[data-reg-action]');
        if (!actionBtn) return;
        const id = actionBtn.dataset.id;
        const source = actionBtn.dataset.source || SOURCE_REGISTRATION;
        switch (actionBtn.dataset.regAction) {
            case 'approve':
                approveRegistration(id, source);
                break;
            case 'reject':
                openRejectModal(id, source);
                break;
            case 'remove':
                deleteRegistration(id);
                break;
        }
    });

    // Close modal buttons
    document.querySelectorAll('.modal-close').forEach(btn => {
        btn.addEventListener('click', () => {
            const modalId = btn.dataset.modal;
            if (modalId) document.getElementById(modalId).style.display = 'none';
        });
    });

    // ---- Init ----

    loadEnrollmentUiSettings().then(() => {
        loadRegistrations();
        loadPendingCount();
    });

    // Refresh pending count every 15 seconds
    setInterval(loadPendingCount, 15000);

})();
