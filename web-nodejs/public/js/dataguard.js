/**
 * BetterDesk Console - DataGuard Page Script
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

    async function apiFetch(url, options = {}) {
        const headers = { 'Content-Type': 'application/json' };
        if (csrfToken) headers['x-csrf-token'] = csrfToken;
        const resp = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
        return resp.json();
    }

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
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
        if (window.BetterDesk?.notify) { window.BetterDesk.notify(message, type); return; }
        const container = document.getElementById('toast-container');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = `toast toast-${type || 'info'}`;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
    }

    // ---- Tab switching ----
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            const panel = document.getElementById('tab-' + btn.dataset.tab);
            if (panel) panel.classList.add('active');
            if (btn.dataset.tab === 'policies') loadPolicies();
            else if (btn.dataset.tab === 'events') loadEvents();
        });
    });

    // ---- Modal close ----
    document.querySelectorAll('.modal-close').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.modal;
            if (id) document.getElementById(id).style.display = 'none';
        });
    });

    // ==== Stats ====
    async function loadStats() {
        try {
            const stats = await apiFetch('/api/dataguard/stats');
            document.getElementById('stat-policies').textContent = stats.total_policies ?? 0;
            document.getElementById('stat-active').textContent = stats.active_policies ?? 0;
            document.getElementById('stat-violations').textContent = stats.violations ?? 0;
            document.getElementById('stat-blocked').textContent = stats.blocked ?? 0;
        } catch (_e) { /* ignore */ }
    }

    // ==== Policies ====

    const policiesBody = document.getElementById('policies-body');
    const createBtn = document.getElementById('create-policy-btn');
    const policyModal = document.getElementById('policy-modal');
    const saveBtn = document.getElementById('policy-save-btn');
    const cancelBtn = document.getElementById('policy-cancel-btn');
    const policySearch = document.getElementById('policy-search');
    let allPolicies = [];

    async function loadPolicies() {
        policiesBody.innerHTML = `<tr class="loading-row"><td colspan="7">${_('common.loading')}</td></tr>`;
        try {
            const data = await apiFetch('/api/dataguard/policies');
            allPolicies = Array.isArray(data) ? data : [];
            filterPolicies();
        } catch (err) {
            policiesBody.innerHTML = `<tr class="empty-row"><td colspan="7">
                <div class="empty-state"><span class="material-icons">error_outline</span><p>${escapeHtml(err.message)}</p></div></td></tr>`;
        }
    }

    function filterPolicies() {
        const q = policySearch.value.toLowerCase();
        const filtered = q ? allPolicies.filter(p => (p.name + p.description).toLowerCase().includes(q)) : allPolicies;
        renderPolicies(filtered);
    }

    function renderPolicies(policies) {
        if (!policies.length) {
            policiesBody.innerHTML = `<tr class="empty-row"><td colspan="7">
                <div class="empty-state"><span class="material-icons">policy</span><p>${_('dataguard.no_policies')}</p></div></td></tr>`;
            return;
        }
        policiesBody.innerHTML = policies.map(p => `
            <tr data-id="${p.id}">
                <td>${escapeHtml(p.name)}</td>
                <td><span class="dg-type-badge">${escapeHtml(p.policy_type || p.type)}</span></td>
                <td><span class="dg-action-badge ${String(p.action || '').replace(/[^a-z0-9_-]/gi, '')}">${escapeHtml(_('dataguard.action_' + p.action) || p.action)}</span></td>
                <td>${escapeHtml(p.scope || _('dataguard.scope_all'))}</td>
                <td><span class="policy-status ${p.enabled ? 'active' : 'disabled'}"><span class="dot"></span> ${p.enabled ? _('dataguard.active') : _('dataguard.disabled')}</span></td>
                <td class="violations-count ${(p.events_count || 0) > 50 ? 'high' : ''}">${p.events_count || 0}</td>
                <td class="action-btn-group">
                    <button class="btn btn-sm btn-secondary edit-btn" data-id="${p.id}"><span class="material-icons" style="font-size:16px">edit</span></button>
                    <button class="btn btn-sm btn-danger del-btn" data-id="${p.id}"><span class="material-icons" style="font-size:16px">delete</span></button>
                </td>
            </tr>
        `).join('');

        policiesBody.querySelectorAll('.edit-btn').forEach(btn => btn.addEventListener('click', () => editPolicy(btn.dataset.id)));
        policiesBody.querySelectorAll('.del-btn').forEach(btn => btn.addEventListener('click', () => deletePolicy(btn.dataset.id)));
    }

    function openPolicyModal(p) {
        document.getElementById('policy-modal-title').textContent = p ? _('dataguard.edit_policy') : _('dataguard.create_policy');
        document.getElementById('policy-id').value = p ? p.id : '';
        document.getElementById('policy-name').value = p ? p.name : '';
        document.getElementById('policy-desc').value = p ? p.description || '' : '';
        document.getElementById('policy-type').value = p ? p.policy_type || p.type : 'usb';
        document.getElementById('policy-action').value = p ? p.action : 'log';
        document.getElementById('policy-scope').value = p ? p.scope || '' : '';
        document.getElementById('policy-rules').value = p ? (typeof p.rules === 'string' ? p.rules : JSON.stringify(p.rules || [], null, 2)) : '';
        document.getElementById('policy-enabled').checked = p ? !!p.enabled : true;
        policyModal.style.display = 'flex';
    }

    async function editPolicy(id) {
        try {
            const p = await apiFetch(`/api/dataguard/policies/${id}`);
            openPolicyModal(p);
        } catch (err) { showToast(err.message, 'error'); }
    }

    async function savePolicy() {
        const id = document.getElementById('policy-id').value;
        let rules;
        try {
            const raw = document.getElementById('policy-rules').value.trim();
            rules = raw ? JSON.parse(raw) : [];
        } catch (_e) {
            showToast(_('common.invalid_json'), 'error');
            return;
        }

        const body = {
            name: document.getElementById('policy-name').value.trim(),
            description: document.getElementById('policy-desc').value.trim(),
            policy_type: document.getElementById('policy-type').value,
            action: document.getElementById('policy-action').value,
            scope: document.getElementById('policy-scope').value.trim() || null,
            rules,
            enabled: document.getElementById('policy-enabled').checked,
        };

        if (!body.name) { showToast(_('common.name_required'), 'error'); return; }

        try {
            const url = id ? `/api/dataguard/policies/${id}` : '/api/dataguard/policies';
            const method = id ? 'PATCH' : 'POST';
            await apiFetch(url, { method, body: JSON.stringify(body) });
            policyModal.style.display = 'none';
            showToast(_('common.saved'), 'success');
            loadPolicies();
            loadStats();
        } catch (err) { showToast(err.message, 'error'); }
    }

    async function deletePolicy(id) {
        if (!confirm(_('dataguard.delete_policy') + '?')) return;
        try {
            await apiFetch(`/api/dataguard/policies/${id}`, { method: 'DELETE' });
            showToast(_('common.success'), 'success');
            loadPolicies();
            loadStats();
        } catch (err) { showToast(err.message, 'error'); }
    }

    createBtn.addEventListener('click', () => openPolicyModal(null));
    saveBtn.addEventListener('click', savePolicy);
    cancelBtn?.addEventListener('click', () => { policyModal.style.display = 'none'; });
    policySearch.addEventListener('input', filterPolicies);

    // ==== Events ====

    const eventsBody = document.getElementById('events-body');
    const eventSearch = document.getElementById('event-search');
    let allEvents = [];
    let eventActionFilter = '';

    async function loadEvents() {
        eventsBody.innerHTML = `<tr class="loading-row"><td colspan="5">${_('common.loading')}</td></tr>`;
        const params = new URLSearchParams();
        if (eventActionFilter) params.set('event_type', eventActionFilter);

        try {
            const data = await apiFetch(`/api/dataguard/events?${params}`);
            allEvents = Array.isArray(data) ? data : [];
            filterEvents();
        } catch (err) {
            eventsBody.innerHTML = `<tr class="empty-row"><td colspan="5">
                <div class="empty-state"><span class="material-icons">error_outline</span><p>${escapeHtml(err.message)}</p></div></td></tr>`;
        }
    }

    function filterEvents() {
        const q = eventSearch.value.toLowerCase();
        const filtered = q ? allEvents.filter(e => ((e.device_id || '') + (e.policy_name || '') + (typeof e.details === 'string' ? e.details : JSON.stringify(e.details || ''))).toLowerCase().includes(q)) : allEvents;
        renderEvents(filtered);
    }

    function renderEvents(events) {
        if (!events.length) {
            eventsBody.innerHTML = `<tr class="empty-row"><td colspan="5">
                <div class="empty-state"><span class="material-icons">shield</span><p>${_('dataguard.no_events')}</p></div></td></tr>`;
            return;
        }
        eventsBody.innerHTML = events.map(e => `
            <tr>
                <td class="time-cell">${formatTimeAgo(e.created_at)}</td>
                <td>${escapeHtml(e.device_id || '—')}</td>
                <td>${escapeHtml(e.policy_name || '—')}</td>
                <td><span class="dg-action-badge ${e.action}">${_('dataguard.action_' + e.action) || e.action}</span></td>
                <td class="event-detail" title="${escapeHtml(typeof e.details === 'object' ? JSON.stringify(e.details) : (e.details || ''))}">${escapeHtml(typeof e.details === 'object' ? JSON.stringify(e.details) : (e.details || '—'))}</td>
            </tr>
        `).join('');
    }

    // Event action filter buttons
    document.querySelectorAll('#event-action-filter .filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#event-action-filter .filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            eventActionFilter = btn.dataset.action;
            loadEvents();
        });
    });

    eventSearch.addEventListener('input', filterEvents);

    // ---- Init ----
    loadPolicies();
    loadStats();
})();
