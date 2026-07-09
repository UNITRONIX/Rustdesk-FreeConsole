'use strict';

(function () {
    const page = document.querySelector('.commercialization-page');
    if (!page) return;

    function t(key, fallback) {
        if (typeof window.__ === 'function') {
            const val = window.__(key);
            if (val && val !== key) return val;
        }
        return fallback !== undefined ? fallback : key;
    }

    async function api(path, opts = {}) {
        const method = (opts.method || 'GET').toUpperCase();
        const payload = { ...opts };
        if (payload.body && typeof payload.body === 'string') {
            try {
                payload.body = JSON.parse(payload.body);
            } catch (_) { /* keep string */ }
        }
        return Utils.api(path, payload);
    }

    function notifySuccess(msg) {
        if (typeof Notifications !== 'undefined' && Notifications.success) {
            Notifications.success(msg);
        } else {
            alert(msg);
        }
    }

    function notifyError(msg) {
        if (typeof Notifications !== 'undefined' && Notifications.error) {
            Notifications.error(msg);
        } else {
            alert(msg);
        }
    }

    function formatMinutes(m) {
        if (!m) return '0 min';
        const h = Math.floor(m / 60);
        const min = m % 60;
        if (h > 0) return `${h}h ${min}m`;
        return `${min} min`;
    }

    function escapeHtml(s) {
        return String(s || '').replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function triggerDownload(url) {
        const a = document.createElement('a');
        a.href = url;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    function setEmptyState(tableId, emptyId, isEmpty, message) {
        const table = document.getElementById(tableId);
        let emptyEl = document.getElementById(emptyId);
        if (!table) return;
        if (isEmpty) {
            if (!emptyEl) {
                emptyEl = document.createElement('p');
                emptyEl.id = emptyId;
                emptyEl.className = 'empty-state';
                table.parentElement?.appendChild(emptyEl);
            }
            emptyEl.textContent = message;
            emptyEl.classList.remove('hidden');
            table.classList.add('hidden');
        } else {
            emptyEl?.classList.add('hidden');
            table.classList.remove('hidden');
        }
    }

    function openModal(id) {
        document.getElementById(id)?.classList.add('open');
    }

    function closeModal(id) {
        document.getElementById(id)?.classList.remove('open');
    }

    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
        btn.addEventListener('click', () => closeModal(btn.getAttribute('data-close-modal')));
    });

    document.querySelectorAll('.modal-overlay').forEach((overlay) => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeModal(overlay.id);
        });
    });

    function targetTypeLabel(type) {
        const map = {
            org: t('commercialization.targets.org', 'Organization'),
            device_group: t('commercialization.targets.device_group', 'Device group'),
            folder: t('commercialization.targets.folder', 'Folder'),
            device: t('commercialization.targets.device', 'Device')
        };
        return map[type] || type;
    }

    function formatValidity(c) {
        if (!c.valid_from && !c.valid_until) return '—';
        const from = c.valid_from ? String(c.valid_from).slice(0, 10) : '…';
        const until = c.valid_until ? String(c.valid_until).slice(0, 10) : '…';
        return `${from} → ${until}`;
    }

    let editingPackageId = null;
    let editingContractId = null;

    async function loadTimesync() {
        try {
            const st = await api('/api/panel/billing/timesync/status');
            const banner = document.getElementById('timesync-banner');
            const statusEl = document.getElementById('clock-status');
            const offsetEl = document.getElementById('clock-offset');
            const detail = document.getElementById('settings-clock-detail');
            const ntpServerEl = document.getElementById('clock-ntp-server');
            const osSyncEl = document.getElementById('clock-os-sync');
            const lastErrorEl = document.getElementById('clock-last-error');
            const synced = !!st.synced;
            if (statusEl) statusEl.textContent = synced ? 'OK' : 'WARN';
            const offset = `${st.offset_ms || 0} ms`;
            if (offsetEl) offsetEl.textContent = offset;
            if (ntpServerEl) ntpServerEl.textContent = st.ntp_server || '—';
            if (osSyncEl) {
                if (st.os_clock_synced === true) osSyncEl.textContent = t('commercialization.clock.os_yes', 'Yes');
                else if (st.os_clock_synced === false) osSyncEl.textContent = t('commercialization.clock.os_no', 'No');
                else osSyncEl.textContent = '—';
            }
            if (lastErrorEl) lastErrorEl.textContent = st.last_error || '—';
            if (detail) {
                detail.textContent = synced
                    ? t('commercialization.clock.synced_detail', 'Clock synchronized for billing')
                    : t('commercialization.clock.unsynced', 'Server clock is not synchronized — billable sessions may be blocked');
            }
            if (banner) {
                banner.classList.toggle('hidden', synced);
                banner.textContent = synced ? '' : t('commercialization.clock.unsynced', 'Server clock is not synchronized — billable sessions may be blocked');
            }
        } catch (e) {
            console.warn('[commercialization] timesync', e);
        }
    }

    async function loadOverviewStats() {
        try {
            const stats = await api('/api/panel/billing/stats');
            const expEl = document.getElementById('stat-expiring-contracts');
            if (expEl) expEl.textContent = String(stats.contracts_expiring_30d || 0);
            const activeEl = document.getElementById('stat-active-sessions');
            if (activeEl && stats.active_sessions != null) {
                activeEl.textContent = String(stats.active_sessions);
            }
        } catch (e) {
            console.warn('[commercialization] stats', e);
        }
    }

    async function loadClockSettings() {
        try {
            const data = await api('/api/panel/billing/clock/settings');
            const settings = data.settings || {};
            const serversEl = document.getElementById('clock-ntp-servers');
            const skewEl = document.getElementById('clock-max-skew');
            const requireEl = document.getElementById('clock-require-sync');
            const trustEl = document.getElementById('clock-trust-os');
            if (serversEl) serversEl.value = settings.ntp_servers || '';
            if (skewEl) skewEl.value = settings.max_skew_ms || 2000;
            if (requireEl) requireEl.checked = settings.require_synced_clock !== false;
            if (trustEl) trustEl.checked = settings.trust_os_ntp !== false;
        } catch (e) {
            console.warn('[commercialization] clock settings', e);
        }
    }

    async function loadPackages() {
        const tbody = document.querySelector('#packages-table tbody');
        if (!tbody) return [];
        const data = await api('/api/panel/billing/packages');
        tbody.innerHTML = '';
        const pkgs = data.packages || [];
        pkgs.forEach((p) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${escapeHtml(p.name)}</td>
                <td>${escapeHtml(p.description || '')}</td>
                <td>${p.included_minutes}</td>
                <td>${p.overage_rate}</td>
                <td>${escapeHtml(p.currency)}</td>
                <td class="actions-cell">
                    <button type="button" class="btn-link" data-edit-package="${escapeHtml(p.id)}">${t('commercialization.actions.edit', 'Edit')}</button>
                    <button type="button" class="btn-link danger" data-delete-package="${escapeHtml(p.id)}">${t('commercialization.actions.delete', 'Delete')}</button>
                </td>`;
            tbody.appendChild(tr);
        });
        tbody.querySelectorAll('[data-edit-package]').forEach((btn) => {
            btn.addEventListener('click', () => openPackageModal(btn.getAttribute('data-edit-package')));
        });
        tbody.querySelectorAll('[data-delete-package]').forEach((btn) => {
            btn.addEventListener('click', () => deletePackage(btn.getAttribute('data-delete-package')));
        });
        setEmptyState('packages-table', 'packages-empty', pkgs.length === 0,
            t('commercialization.empty.packages', 'No packages yet. Create one with the button above.'));
        return pkgs;
    }

    async function deletePackage(id) {
        if (!id) return;
        const ok = window.confirm(t('commercialization.packages.delete_confirm', 'Delete this package?'));
        if (!ok) return;
        try {
            await api(`/api/panel/billing/packages/${encodeURIComponent(id)}`, { method: 'DELETE' });
            notifySuccess(t('commercialization.packages.deleted', 'Package deleted'));
            await loadPackages();
        } catch (e) {
            notifyError(e.message);
        }
    }

    function getContractFilters() {
        return {
            target_type: document.getElementById('filter-contract-type')?.value || '',
            status: document.getElementById('filter-contract-status')?.value || '',
            search: (document.getElementById('filter-contract-search')?.value || '').trim().toLowerCase()
        };
    }

    async function loadContracts() {
        const tbody = document.querySelector('#contracts-table tbody');
        if (!tbody) return;
        const filters = getContractFilters();
        const params = new URLSearchParams();
        if (filters.target_type) params.set('target_type', filters.target_type);
        if (filters.status) params.set('status', filters.status);
        const qs = params.toString();
        const data = await api(`/api/panel/billing/contracts${qs ? `?${qs}` : ''}`);
        tbody.innerHTML = '';
        let contracts = data.contracts || [];
        if (filters.search) {
            contracts = contracts.filter((c) => {
                const hay = `${c.target_name || ''} ${c.target_key || ''} ${c.package_name || ''}`.toLowerCase();
                return hay.includes(filters.search);
            });
        }
        contracts.forEach((c) => {
            const tr = document.createElement('tr');
            const targetLabel = `${targetTypeLabel(c.target_type)}: ${escapeHtml(c.target_name || c.target_key)}`;
            const isSuspended = c.status === 'suspended';
            const toggleLabel = isSuspended
                ? t('commercialization.contracts.activate', 'Activate')
                : t('commercialization.contracts.suspend', 'Suspend');
            tr.innerHTML = `
                <td>${targetLabel}</td>
                <td>${escapeHtml(c.package_name || c.package_id)}</td>
                <td>${formatMinutes(c.remaining_minutes)}</td>
                <td>${escapeHtml(c.status)}</td>
                <td>${formatValidity(c)}</td>
                <td class="actions-cell">
                    <button type="button" class="btn-link" data-edit-contract="${escapeHtml(c.id)}">${t('commercialization.actions.edit', 'Edit')}</button>
                    <button type="button" class="btn-link ${isSuspended ? '' : 'danger'}" data-contract-id="${escapeHtml(c.id)}" data-status="${isSuspended ? 'active' : 'suspended'}">${toggleLabel}</button>
                    <button type="button" class="btn-link danger" data-delete-contract="${escapeHtml(c.id)}">${t('commercialization.actions.delete', 'Delete')}</button>
                </td>`;
            tbody.appendChild(tr);
        });
        tbody.querySelectorAll('[data-contract-id]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const id = btn.getAttribute('data-contract-id');
                const status = btn.getAttribute('data-status');
                try {
                    await api(`/api/panel/billing/contracts/${encodeURIComponent(id)}`, {
                        method: 'PUT',
                        body: { status }
                    });
                    await loadContracts();
                } catch (e) {
                    notifyError(e.message);
                }
            });
        });
        tbody.querySelectorAll('[data-edit-contract]').forEach((btn) => {
            btn.addEventListener('click', () => openContractEditModal(btn.getAttribute('data-edit-contract')));
        });
        tbody.querySelectorAll('[data-delete-contract]').forEach((btn) => {
            btn.addEventListener('click', () => deleteContract(btn.getAttribute('data-delete-contract')));
        });
        setEmptyState('contracts-table', 'contracts-empty', contracts.length === 0,
            t('commercialization.empty.contracts', 'No package assignments yet.'));
    }

    async function deleteContract(id) {
        if (!id) return;
        const ok = window.confirm(t('commercialization.contracts.delete_confirm', 'Remove this package assignment?'));
        if (!ok) return;
        try {
            await api(`/api/panel/billing/contracts/${encodeURIComponent(id)}`, { method: 'DELETE' });
            notifySuccess(t('commercialization.contracts.deleted', 'Assignment removed'));
            await loadContracts();
        } catch (e) {
            notifyError(e.message);
        }
    }

    function sessionQuery() {
        const params = new URLSearchParams();
        const orgId = document.getElementById('filter-session-org')?.value;
        const status = document.getElementById('filter-session-status')?.value;
        const deviceId = document.getElementById('filter-session-device')?.value?.trim();
        if (orgId) params.set('org_id', orgId);
        if (status) params.set('status', status);
        if (deviceId) params.set('device_id', deviceId);
        return params.toString();
    }

    async function loadSessions() {
        const tbody = document.querySelector('#sessions-table tbody');
        if (!tbody) return;
        const qs = sessionQuery();
        const data = await api(`/api/panel/billing/sessions${qs ? `?${qs}` : ''}`);
        tbody.innerHTML = '';
        let active = 0;
        (data.sessions || []).forEach((s) => {
            if (s.status === 'active') active++;
            const amount = (s.amount_included || 0) + (s.amount_overage || 0);
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${escapeHtml(s.device_name || s.device_id)}</td><td>${escapeHtml(s.org_id || '')}</td><td>${escapeHtml(s.operator_id)}</td><td>${formatMinutes(s.billed_minutes)}</td><td>${escapeHtml(s.billing_phase)}</td><td>${amount.toFixed(2)} ${escapeHtml(s.currency)}</td>`;
            tbody.appendChild(tr);
        });
        const stat = document.getElementById('stat-active-sessions');
        if (stat) stat.textContent = String(active);
        setEmptyState('sessions-table', 'sessions-empty', (data.sessions || []).length === 0,
            t('commercialization.empty.sessions', 'No billable sessions recorded yet.'));
    }

    async function loadReports() {
        const tbody = document.querySelector('#reports-table tbody');
        if (!tbody) return;
        const orgId = document.getElementById('filter-report-org')?.value;
        const params = orgId ? `?org_id=${encodeURIComponent(orgId)}` : '';
        const data = await api(`/api/panel/billing/reports${params}`);
        tbody.innerHTML = '';
        (data.reports || []).forEach((r) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${escapeHtml(r.session_id)}</td><td>${escapeHtml(r.summary)}</td><td>${escapeHtml(r.created_at || '')}</td>`;
            tbody.appendChild(tr);
        });
        setEmptyState('reports-table', 'reports-empty', (data.reports || []).length === 0,
            t('commercialization.empty.reports', 'No work reports submitted yet.'));
    }

    function showModalError(el, message) {
        if (!el) return;
        if (message) {
            el.textContent = message;
            el.classList.remove('hidden');
        } else {
            el.textContent = '';
            el.classList.add('hidden');
        }
    }

    async function openPackageModal(editId) {
        editingPackageId = editId || null;
        const errEl = document.getElementById('package-modal-error');
        showModalError(errEl, '');
        const titleEl = document.getElementById('package-modal-title');
        const submitEl = document.getElementById('package-modal-submit');
        if (editId) {
            if (titleEl) titleEl.textContent = t('commercialization.packages.edit_title', 'Edit package');
            if (submitEl) submitEl.textContent = t('commercialization.actions.save', 'Save');
            const data = await api('/api/panel/billing/packages');
            const pkg = (data.packages || []).find((p) => p.id === editId);
            if (!pkg) return;
            document.getElementById('package-name').value = pkg.name || '';
            document.getElementById('package-description').value = pkg.description || '';
            document.getElementById('package-minutes').value = pkg.included_minutes || 600;
            document.getElementById('package-overage').value = pkg.overage_rate || 0;
            document.getElementById('package-currency').value = pkg.currency || 'PLN';
        } else {
            if (titleEl) titleEl.textContent = t('commercialization.packages.create_title', 'New support package');
            if (submitEl) submitEl.textContent = t('commercialization.packages.create_submit', 'Create package');
            document.getElementById('package-name').value = '';
            document.getElementById('package-description').value = '';
            document.getElementById('package-minutes').value = '600';
            document.getElementById('package-overage').value = '100';
            document.getElementById('package-currency').value = 'PLN';
        }
        openModal('package-modal');
    }

    async function submitPackageModal() {
        const errEl = document.getElementById('package-modal-error');
        const name = document.getElementById('package-name')?.value.trim();
        const description = document.getElementById('package-description')?.value.trim();
        const includedMinutes = parseInt(document.getElementById('package-minutes')?.value, 10);
        const overageRate = parseFloat(document.getElementById('package-overage')?.value);
        const currency = document.getElementById('package-currency')?.value.trim().toUpperCase();

        if (!name) {
            showModalError(errEl, t('commercialization.packages.prompt_name', 'Package name'));
            return;
        }

        const body = {
            name,
            description,
            included_minutes: includedMinutes,
            overage_rate: overageRate,
            currency: currency || 'PLN'
        };

        try {
            if (editingPackageId) {
                await api(`/api/panel/billing/packages/${encodeURIComponent(editingPackageId)}`, {
                    method: 'PUT',
                    body
                });
                notifySuccess(t('commercialization.packages.updated', 'Package updated'));
            } else {
                await api('/api/panel/billing/packages', { method: 'POST', body });
                notifySuccess(t('commercialization.packages.created', 'Package created'));
            }
            closeModal('package-modal');
            await loadPackages();
        } catch (e) {
            showModalError(errEl, e.message);
        }
    }

    async function loadTargetOptions(targetType) {
        const select = document.getElementById('assign-target-select');
        if (!select) return;
        select.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = t('commercialization.assign.select_target', 'Select target…');
        select.appendChild(placeholder);

        if (targetType === 'org') {
            const data = await api('/api/panel/org');
            (data.organizations || data.orgs || []).forEach((org) => {
                const opt = document.createElement('option');
                opt.value = org.id;
                opt.textContent = org.name || org.id;
                select.appendChild(opt);
            });
        } else if (targetType === 'device_group') {
            const data = await api('/api/device-groups');
            (data.groups || data.device_groups || []).forEach((g) => {
                const opt = document.createElement('option');
                opt.value = g.guid || g.id;
                opt.textContent = g.name || g.guid;
                select.appendChild(opt);
            });
        } else if (targetType === 'folder') {
            const data = await api('/api/folders');
            (data.folders || []).forEach((f) => {
                const opt = document.createElement('option');
                opt.value = String(f.id);
                opt.textContent = f.name || f.id;
                select.appendChild(opt);
            });
        } else if (targetType === 'device') {
            const data = await api('/api/devices');
            (data.devices || []).forEach((d) => {
                const opt = document.createElement('option');
                opt.value = d.id || d.device_id;
                opt.textContent = d.name || d.hostname || d.id;
                select.appendChild(opt);
            });
        }
    }

    async function openAssignModal() {
        resetAssignModalFields();
        editingContractId = null;
        const errEl = document.getElementById('assign-modal-error');
        showModalError(errEl, '');
        document.getElementById('assign-modal-title').textContent = t('commercialization.assign.title', 'Assign package');
        document.getElementById('assign-modal-submit').textContent = t('commercialization.assign.submit', 'Assign');

        const pkgs = await api('/api/panel/billing/packages');
        const packages = pkgs.packages || [];
        if (!packages.length) {
            notifyError(t('commercialization.contracts.no_packages', 'Create a package first'));
            return;
        }
        const pkgSelect = document.getElementById('assign-package-select');
        pkgSelect.innerHTML = '';
        packages.forEach((p) => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `${p.name} (${p.included_minutes} min)`;
            pkgSelect.appendChild(opt);
        });

        const typeSelect = document.getElementById('assign-target-type');
        if (typeSelect && !typeSelect.dataset.bound) {
            typeSelect.dataset.bound = '1';
            typeSelect.addEventListener('change', () => loadTargetOptions(typeSelect.value));
        }
        await loadTargetOptions(typeSelect?.value || 'org');
        openModal('assign-modal');
    }

    async function openContractEditModal(contractId) {
        const data = await api('/api/panel/billing/contracts');
        const contract = (data.contracts || []).find((c) => c.id === contractId);
        if (!contract) return;
        editingContractId = contractId;
        document.getElementById('assign-modal-title').textContent = t('commercialization.contracts.edit_title', 'Edit assignment');
        document.getElementById('assign-modal-submit').textContent = t('commercialization.actions.save', 'Save');
        showModalError(document.getElementById('assign-modal-error'), '');

        const typeSelect = document.getElementById('assign-target-type');
        typeSelect.value = contract.target_type || 'org';
        typeSelect.disabled = true;
        await loadTargetOptions(typeSelect.value);
        const targetSelect = document.getElementById('assign-target-select');
        targetSelect.value = contract.target_key;
        targetSelect.disabled = true;
        document.getElementById('assign-package-select').disabled = true;

        document.getElementById('assign-remaining').value = contract.remaining_minutes ?? 0;
        document.getElementById('assign-hourly-rate').value = contract.hourly_rate ?? 0;
        document.getElementById('assign-overage-rate').value = contract.overage_rate ?? '';
        document.getElementById('assign-valid-from').value = contract.valid_from ? String(contract.valid_from).slice(0, 10) : '';
        document.getElementById('assign-valid-until').value = contract.valid_until ? String(contract.valid_until).slice(0, 10) : '';

        openModal('assign-modal');
    }

    function resetAssignModalFields() {
        const typeSelect = document.getElementById('assign-target-type');
        const targetSelect = document.getElementById('assign-target-select');
        const pkgSelect = document.getElementById('assign-package-select');
        if (typeSelect) typeSelect.disabled = false;
        if (targetSelect) targetSelect.disabled = false;
        if (pkgSelect) pkgSelect.disabled = false;
        document.getElementById('assign-remaining').value = '';
        document.getElementById('assign-hourly-rate').value = '';
        document.getElementById('assign-overage-rate').value = '';
        document.getElementById('assign-valid-from').value = '';
        document.getElementById('assign-valid-until').value = '';
    }

    async function submitAssignModal() {
        const errEl = document.getElementById('assign-modal-error');
        const targetType = document.getElementById('assign-target-type')?.value;
        const targetKey = document.getElementById('assign-target-select')?.value;
        const packageId = document.getElementById('assign-package-select')?.value;
        const remainingRaw = document.getElementById('assign-remaining')?.value;
        const hourlyRate = parseFloat(document.getElementById('assign-hourly-rate')?.value);
        const overageRaw = document.getElementById('assign-overage-rate')?.value;
        const validFrom = document.getElementById('assign-valid-from')?.value;
        const validUntil = document.getElementById('assign-valid-until')?.value;

        if (editingContractId) {
            const patch = {};
            if (remainingRaw !== '') patch.remaining_minutes = parseInt(remainingRaw, 10);
            if (!Number.isNaN(hourlyRate)) patch.hourly_rate = hourlyRate;
            if (overageRaw !== '') patch.overage_rate = parseFloat(overageRaw);
            patch.valid_from = validFrom ? `${validFrom}T00:00:00Z` : null;
            patch.valid_until = validUntil ? `${validUntil}T23:59:59Z` : null;
            try {
                await api(`/api/panel/billing/contracts/${encodeURIComponent(editingContractId)}`, {
                    method: 'PUT',
                    body: patch
                });
                closeModal('assign-modal');
                resetAssignModalFields();
                editingContractId = null;
                notifySuccess(t('commercialization.contracts.updated', 'Assignment updated'));
                await loadContracts();
            } catch (e) {
                showModalError(errEl, e.message);
            }
            return;
        }

        if (!targetType || !targetKey || !packageId) {
            showModalError(errEl, t('commercialization.assign.missing_fields', 'Select target and package'));
            return;
        }
        try {
            const pkgs = await api('/api/panel/billing/packages');
            const pkg = (pkgs.packages || []).find((p) => p.id === packageId);
            const body = {
                target_type: targetType,
                target_key: targetKey,
                package_id: packageId,
                currency: pkg?.currency || 'PLN'
            };
            if (remainingRaw !== '') body.remaining_minutes = parseInt(remainingRaw, 10);
            if (!Number.isNaN(hourlyRate)) body.hourly_rate = hourlyRate;
            if (overageRaw !== '') body.overage_rate = parseFloat(overageRaw);
            if (validFrom) body.valid_from = `${validFrom}T00:00:00Z`;
            if (validUntil) body.valid_until = `${validUntil}T23:59:59Z`;

            await api('/api/panel/billing/contracts', { method: 'POST', body });
            closeModal('assign-modal');
            resetAssignModalFields();
            notifySuccess(t('commercialization.assign.success', 'Package assigned'));
            await loadContracts();
        } catch (e) {
            showModalError(errEl, e.message);
        }
    }

    async function populateOrgFilterSelect(selectEl) {
        if (!selectEl) return;
        const data = await api('/api/panel/org');
        const current = selectEl.value;
        selectEl.innerHTML = `<option value="">${t('commercialization.filters.all_orgs', 'All organizations')}</option>`;
        (data.organizations || data.orgs || []).forEach((org) => {
            const opt = document.createElement('option');
            opt.value = org.id;
            opt.textContent = org.name || org.id;
            selectEl.appendChild(opt);
        });
        if (current) selectEl.value = current;
    }

    document.getElementById('btn-timesync-check')?.addEventListener('click', async () => {
        try {
            await api('/api/panel/billing/timesync/check', { method: 'POST' });
            notifySuccess(t('commercialization.clock.checked', 'Clock check completed'));
            await loadTimesync();
        } catch (e) {
            notifyError(e.message);
        }
    });

    document.getElementById('btn-save-clock-settings')?.addEventListener('click', async () => {
        const ok = window.confirm(t(
            'commercialization.clock.save_restart',
            'Save NTP settings and restart the BetterDesk Go server? Active sessions may disconnect briefly.'
        ));
        if (!ok) return;
        try {
            await api('/api/panel/billing/clock/settings', {
                method: 'PUT',
                body: {
                    ntp_servers: document.getElementById('clock-ntp-servers')?.value || '',
                    max_skew_ms: Number(document.getElementById('clock-max-skew')?.value || 2000),
                    require_synced_clock: document.getElementById('clock-require-sync')?.checked !== false,
                    trust_os_ntp: document.getElementById('clock-trust-os')?.checked !== false
                }
            });
            notifySuccess(t('commercialization.clock.saved', 'Clock settings saved. Go server restart initiated.'));
            await loadTimesync();
        } catch (e) {
            notifyError(e.message);
        }
    });

    document.getElementById('btn-new-package')?.addEventListener('click', () => {
        openPackageModal().catch((e) => notifyError(e.message));
    });

    document.getElementById('package-modal-submit')?.addEventListener('click', () => {
        submitPackageModal();
    });

    document.getElementById('btn-new-contract')?.addEventListener('click', () => {
        resetAssignModalFields();
        openAssignModal().catch((e) => notifyError(e.message));
    });

    document.getElementById('assign-modal-submit')?.addEventListener('click', () => {
        submitAssignModal();
    });

    document.getElementById('btn-export-sessions')?.addEventListener('click', () => {
        const qs = sessionQuery();
        triggerDownload(`/api/panel/billing/sessions/export?format=csv${qs ? `&${qs}` : ''}`);
    });

    document.getElementById('btn-export-reports-csv')?.addEventListener('click', () => {
        const orgId = document.getElementById('filter-report-org')?.value;
        triggerDownload(`/api/panel/billing/reports/export?format=csv${orgId ? `&org_id=${encodeURIComponent(orgId)}` : ''}`);
    });

    document.getElementById('btn-export-reports-pdf')?.addEventListener('click', () => {
        const orgId = document.getElementById('filter-report-org')?.value;
        triggerDownload(`/api/panel/billing/reports/export?format=pdf${orgId ? `&org_id=${encodeURIComponent(orgId)}` : ''}`);
    });

    ['filter-contract-type', 'filter-contract-status'].forEach((id) => {
        document.getElementById(id)?.addEventListener('change', () => loadContracts().catch(console.warn));
    });
    document.getElementById('filter-contract-search')?.addEventListener('input', () => {
        clearTimeout(window._commContractSearchTimer);
        window._commContractSearchTimer = setTimeout(() => loadContracts().catch(console.warn), 300);
    });
    document.getElementById('btn-refresh-sessions')?.addEventListener('click', () => loadSessions().catch(console.warn));
    document.getElementById('btn-refresh-reports')?.addEventListener('click', () => loadReports().catch(console.warn));
    document.getElementById('filter-session-org')?.addEventListener('change', () => loadSessions().catch(console.warn));
    document.getElementById('filter-session-status')?.addEventListener('change', () => loadSessions().catch(console.warn));
    document.getElementById('filter-report-org')?.addEventListener('change', () => loadReports().catch(console.warn));

    async function loadEmailNotificationSettings() {
        const statusEl = document.getElementById('email-smtp-status');
        try {
            const smtp = await api('/api/panel/commercialization/smtp-status');
            if (statusEl) {
                statusEl.textContent = smtp.configured
                    ? t('commercialization.notifications.smtp_configured', 'SMTP is configured')
                    : t('commercialization.notifications.smtp_missing', 'SMTP is not configured');
            }
        } catch (_) {
            if (statusEl) statusEl.textContent = t('commercialization.notifications.smtp_missing', 'SMTP is not configured');
        }

        try {
            const data = await api('/api/panel/commercialization/email-config');
            const cfg = data.config || {};
            document.getElementById('notif-help-requests-enabled').checked = cfg.help_requests_enabled !== false;
            document.getElementById('notif-assigned-operators').checked = cfg.notify_assigned_operators !== false;
            document.getElementById('notif-fallback-alert').checked = cfg.fallback_alert_email !== false;
            document.getElementById('notif-folder-subject').checked = cfg.include_folder_in_subject !== false;
        } catch (e) {
            console.warn('[commercialization] email config load failed', e);
        }
    }

    document.getElementById('btn-save-email-notifications')?.addEventListener('click', async () => {
        try {
            await api('/api/panel/commercialization/email-config', {
                method: 'PUT',
                body: {
                    help_requests_enabled: document.getElementById('notif-help-requests-enabled')?.checked !== false,
                    notify_assigned_operators: document.getElementById('notif-assigned-operators')?.checked !== false,
                    fallback_alert_email: document.getElementById('notif-fallback-alert')?.checked !== false,
                    include_folder_in_subject: document.getElementById('notif-folder-subject')?.checked !== false
                }
            });
            notifySuccess(t('commercialization.notifications.saved', 'Notification settings saved'));
        } catch (e) {
            notifyError(e.message);
        }
    });

    const tab = page.dataset.activeTab || 'overview';
    if (tab === 'overview' || tab === 'settings') {
        loadTimesync();
    }
    if (tab === 'overview') {
        loadOverviewStats().catch(console.warn);
        loadSessions().catch(console.warn);
    }
    if (tab === 'settings') {
        loadEmailNotificationSettings().catch(console.warn);
        loadClockSettings().catch(console.warn);
    }
    if (tab === 'sessions') {
        populateOrgFilterSelect(document.getElementById('filter-session-org')).catch(console.warn);
        loadSessions().catch(console.warn);
    }
    if (tab === 'packages') {
        loadPackages().catch(console.warn);
        loadContracts().catch(console.warn);
    }
    if (tab === 'reports') {
        populateOrgFilterSelect(document.getElementById('filter-report-org')).catch(console.warn);
        loadReports().catch(console.warn);
    }
})();
