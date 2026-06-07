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
        const resp = await fetch(path, {
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            credentials: 'same-origin',
            ...opts
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || resp.statusText);
        return data;
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

    async function loadOrgs() {
        const data = await api('/api/panel/org');
        return data.organizations || data.orgs || [];
    }

    async function populateOrgSelect(selectEl, placeholderKey) {
        const orgs = await loadOrgs();
        selectEl.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = t(placeholderKey, 'Select organization…');
        selectEl.appendChild(placeholder);
        orgs.forEach((org) => {
            const opt = document.createElement('option');
            opt.value = org.id;
            opt.textContent = org.name || org.id;
            selectEl.appendChild(opt);
        });
        return orgs;
    }

    async function loadTimesync() {
        try {
            const st = await api('/api/panel/billing/timesync/status');
            const banner = document.getElementById('timesync-banner');
            const statusEl = document.getElementById('clock-status');
            const offsetEl = document.getElementById('clock-offset');
            const detail = document.getElementById('settings-clock-detail');
            const synced = !!st.synced;
            if (statusEl) statusEl.textContent = synced ? 'OK' : 'WARN';
            const offset = `${st.offset_ms || 0} ms`;
            if (offsetEl) offsetEl.textContent = offset;
            if (detail) detail.textContent = `${synced ? 'Synced' : 'Not synced'} · offset ${offset}`;
            if (banner) {
                banner.classList.toggle('hidden', synced);
                banner.textContent = synced ? '' : t('commercialization.clock.unsynced', 'Clock not synchronized');
            }
        } catch (e) {
            console.warn('[commercialization] timesync', e);
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
            tr.innerHTML = `<td>${escapeHtml(p.name)}</td><td>${p.included_minutes}</td><td>${p.overage_rate}</td><td>${escapeHtml(p.currency)}</td>`;
            tbody.appendChild(tr);
        });
        setEmptyState('packages-table', 'packages-empty', pkgs.length === 0,
            t('commercialization.empty.packages', 'No packages yet. Create one with the button above.'));
        return pkgs;
    }

    async function loadContracts() {
        const tbody = document.querySelector('#contracts-table tbody');
        if (!tbody) return;
        const data = await api('/api/panel/billing/contracts');
        tbody.innerHTML = '';
        (data.contracts || []).forEach((c) => {
            const tr = document.createElement('tr');
            const orgLabel = escapeHtml(c.org_name || c.org_id);
            const pkgLabel = escapeHtml(c.package_name || c.package_id);
            const isSuspended = c.status === 'suspended';
            const toggleLabel = isSuspended
                ? t('commercialization.contracts.activate', 'Activate')
                : t('commercialization.contracts.suspend', 'Suspend');
            tr.innerHTML = `
                <td>${orgLabel}</td>
                <td>${pkgLabel}</td>
                <td>${formatMinutes(c.remaining_minutes)}</td>
                <td>${escapeHtml(c.status)}</td>
                <td><button type="button" class="btn-link ${isSuspended ? '' : 'danger'}" data-contract-id="${escapeHtml(c.id)}" data-status="${isSuspended ? 'active' : 'suspended'}">${toggleLabel}</button></td>`;
            tbody.appendChild(tr);
        });
        tbody.querySelectorAll('[data-contract-id]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const id = btn.getAttribute('data-contract-id');
                const status = btn.getAttribute('data-status');
                await api(`/api/panel/billing/contracts/${encodeURIComponent(id)}`, {
                    method: 'PUT',
                    body: JSON.stringify({ status })
                });
                await loadContracts();
            });
        });
        setEmptyState('contracts-table', 'contracts-empty', (data.contracts || []).length === 0,
            t('commercialization.empty.contracts', 'No organization contracts yet. Assign a package to an organization.'));
    }

    async function loadSessions() {
        const tbody = document.querySelector('#sessions-table tbody');
        if (!tbody) return;
        const data = await api('/api/panel/billing/sessions');
        tbody.innerHTML = '';
        let active = 0;
        (data.sessions || []).forEach((s) => {
            if (s.status === 'active') active++;
            const amount = (s.amount_included || 0) + (s.amount_overage || 0);
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${escapeHtml(s.device_id)}</td><td>${escapeHtml(s.operator_id)}</td><td>${formatMinutes(s.billed_minutes)}</td><td>${escapeHtml(s.billing_phase)}</td><td>${amount.toFixed(2)} ${escapeHtml(s.currency)}</td>`;
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
        const data = await api('/api/panel/billing/reports');
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

    async function openPackageModal() {
        const orgSelect = document.getElementById('package-org-select');
        const errEl = document.getElementById('package-modal-error');
        showModalError(errEl, '');
        const orgs = await populateOrgSelect(orgSelect, 'commercialization.packages.select_org_placeholder');
        if (!orgs.length) {
            alert(t('commercialization.contracts.no_orgs', 'No organizations found'));
            return;
        }
        document.getElementById('package-name').value = '';
        document.getElementById('package-minutes').value = '600';
        document.getElementById('package-overage').value = '100';
        document.getElementById('package-currency').value = 'PLN';
        openModal('package-modal');
    }

    async function submitPackageModal() {
        const errEl = document.getElementById('package-modal-error');
        const orgId = document.getElementById('package-org-select')?.value;
        const name = document.getElementById('package-name')?.value.trim();
        const includedMinutes = parseInt(document.getElementById('package-minutes')?.value, 10);
        const overageRate = parseFloat(document.getElementById('package-overage')?.value);
        const currency = document.getElementById('package-currency')?.value.trim().toUpperCase();

        if (!orgId) {
            showModalError(errEl, t('commercialization.packages.select_org_placeholder', 'Select organization…'));
            return;
        }
        if (!name) {
            showModalError(errEl, t('commercialization.packages.prompt_name', 'Package name'));
            return;
        }

        try {
            const pkg = await api('/api/panel/billing/packages', {
                method: 'POST',
                body: JSON.stringify({
                    name,
                    included_minutes: includedMinutes,
                    overage_rate: overageRate,
                    currency: currency || 'PLN'
                })
            });
            await api('/api/panel/billing/contracts', {
                method: 'POST',
                body: JSON.stringify({
                    org_id: orgId,
                    package_id: pkg.id,
                    currency: pkg.currency || currency || 'PLN'
                })
            });
            closeModal('package-modal');
            await loadPackages();
            await loadContracts();
        } catch (e) {
            showModalError(errEl, e.message);
        }
    }

    async function openAssignModal() {
        const orgSelect = document.getElementById('assign-org-select');
        const pkgSelect = document.getElementById('assign-package-select');
        const errEl = document.getElementById('assign-modal-error');
        showModalError(errEl, '');

        const [orgs, pkgs] = await Promise.all([
            populateOrgSelect(orgSelect, 'commercialization.packages.select_org_placeholder'),
            api('/api/panel/billing/packages')
        ]);
        if (!orgs.length) {
            alert(t('commercialization.contracts.no_orgs', 'No organizations found'));
            return;
        }
        const packages = pkgs.packages || [];
        if (!packages.length) {
            alert(t('commercialization.contracts.no_packages', 'Create a package first'));
            return;
        }
        pkgSelect.innerHTML = '';
        packages.forEach((p) => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `${p.name} (${p.included_minutes} min)`;
            pkgSelect.appendChild(opt);
        });
        openModal('assign-modal');
    }

    async function submitAssignModal() {
        const errEl = document.getElementById('assign-modal-error');
        const orgId = document.getElementById('assign-org-select')?.value;
        const packageId = document.getElementById('assign-package-select')?.value;
        if (!orgId || !packageId) {
            showModalError(errEl, t('commercialization.contracts.select_org', 'Select organization'));
            return;
        }
        try {
            const pkgs = await api('/api/panel/billing/packages');
            const pkg = (pkgs.packages || []).find((p) => p.id === packageId);
            await api('/api/panel/billing/contracts', {
                method: 'POST',
                body: JSON.stringify({
                    org_id: orgId,
                    package_id: packageId,
                    currency: pkg?.currency || 'PLN'
                })
            });
            closeModal('assign-modal');
            await loadContracts();
        } catch (e) {
            showModalError(errEl, e.message);
        }
    }

    document.getElementById('btn-timesync-check')?.addEventListener('click', async () => {
        await api('/api/panel/billing/timesync/check', { method: 'POST' });
        await loadTimesync();
    });

    document.getElementById('btn-new-package')?.addEventListener('click', () => {
        openPackageModal().catch((e) => alert(e.message));
    });

    document.getElementById('package-modal-submit')?.addEventListener('click', () => {
        submitPackageModal();
    });

    document.getElementById('btn-new-contract')?.addEventListener('click', () => {
        openAssignModal().catch((e) => alert(e.message));
    });

    document.getElementById('assign-modal-submit')?.addEventListener('click', () => {
        submitAssignModal();
    });

    document.getElementById('btn-export-sessions')?.addEventListener('click', () => {
        triggerDownload('/api/panel/billing/sessions/export?format=csv');
    });

    document.getElementById('btn-export-reports-csv')?.addEventListener('click', () => {
        triggerDownload('/api/panel/billing/reports/export?format=csv');
    });

    document.getElementById('btn-export-reports-pdf')?.addEventListener('click', () => {
        triggerDownload('/api/panel/billing/reports/export?format=pdf');
    });

    const tab = page.dataset.activeTab || 'overview';
    if (tab === 'overview' || tab === 'settings') {
        loadTimesync();
    }
    if (tab === 'overview' || tab === 'sessions') {
        loadSessions().catch(console.warn);
    }
    if (tab === 'packages') {
        loadPackages().catch(console.warn);
        loadContracts().catch(console.warn);
    }
    if (tab === 'reports') {
        loadReports().catch(console.warn);
    }
})();
