/**
 * BetterDesk Console - Automation Page Script
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

    // ---- Tab switching ----

    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabPanels = document.querySelectorAll('.tab-panel');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabPanels.forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            const panel = document.getElementById('tab-' + btn.dataset.tab);
            if (panel) panel.classList.add('active');

            if (btn.dataset.tab === 'rules') loadRules();
            else if (btn.dataset.tab === 'alerts') loadAlerts();
            else if (btn.dataset.tab === 'commands') loadCommands();
        });
    });

    // ---- API ----

    async function apiFetch(url, options = {}) {
        const headers = { 'Content-Type': 'application/json' };
        if (csrfToken) headers['x-csrf-token'] = csrfToken;
        const resp = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
        return resp.json();
    }

    // ==== RULES ====

    const rulesBody = document.getElementById('rules-body');
    const createRuleBtn = document.getElementById('create-rule-btn');
    const ruleModal = document.getElementById('rule-modal');
    const ruleForm = document.getElementById('rule-form');
    const ruleSaveBtn = document.getElementById('rule-save-btn');

    async function loadRules() {
        rulesBody.innerHTML = `<tr class="loading-row"><td colspan="7">${_('common.loading')}</td></tr>`;
        try {
            const resp = await apiFetch('/api/automation/rules');
            renderRules(Array.isArray(resp) ? resp : Array.isArray(resp.rules) ? resp.rules : []);
        } catch (err) {
            rulesBody.innerHTML = `<tr class="empty-row"><td colspan="7">
                <div class="empty-state"><span class="material-icons">error_outline</span><p>${escapeHtml(err.message)}</p></div></td></tr>`;
        }
    }

    function renderRules(rules) {
        if (!rules.length) {
            rulesBody.innerHTML = `<tr class="empty-row"><td colspan="7">
                <div class="empty-state"><span class="material-icons">rule</span><p>${_('automation.no_rules')}</p></div></td></tr>`;
            return;
        }
        rulesBody.innerHTML = rules.map(r => `
            <tr data-id="${escapeHtml(r.id)}">
                <td>${escapeHtml(r.name)}</td>
                <td>${escapeHtml(_('automation.type_' + r.condition_type) || r.condition_type)}</td>
                <td>${escapeHtml(_('automation.op_' + r.condition_op) || r.condition_op)}</td>
                <td>${escapeHtml(r.condition_value)}</td>
                <td><span class="severity-badge ${safeSeverity(r.severity)}">${escapeHtml(_('automation.severity_' + r.severity) || r.severity)}</span></td>
                <td><span class="toggle-indicator ${r.enabled ? 'on' : 'off'}"></span></td>
                <td class="action-btn-group">
                    <button class="btn btn-sm btn-secondary edit-rule-btn" data-id="${escapeHtml(r.id)}"><span class="material-icons" style="font-size:16px">edit</span></button>
                    <button class="btn btn-sm btn-danger del-rule-btn" data-id="${escapeHtml(r.id)}"><span class="material-icons" style="font-size:16px">delete</span></button>
                </td>
            </tr>
        `).join('');

        rulesBody.querySelectorAll('.edit-rule-btn').forEach(btn => btn.addEventListener('click', () => editRule(btn.dataset.id)));
        rulesBody.querySelectorAll('.del-rule-btn').forEach(btn => btn.addEventListener('click', () => deleteRule(btn.dataset.id)));
    }

    function openRuleModal(rule) {
        document.getElementById('rule-modal-title').textContent = rule ? _('automation.edit_rule') : _('automation.create_rule');
        document.getElementById('rule-id').value = rule ? rule.id : '';
        document.getElementById('rule-name').value = rule ? rule.name : '';
        document.getElementById('rule-desc').value = rule ? rule.description || '' : '';
        document.getElementById('rule-condition').value = rule ? rule.condition_type : 'cpu_usage';
        document.getElementById('rule-operator').value = rule ? rule.condition_op : 'gt';
        document.getElementById('rule-value').value = rule ? rule.condition_value : '';
        document.getElementById('rule-severity').value = rule ? rule.severity : 'warning';
        document.getElementById('rule-device').value = rule ? rule.scope_device_id || '' : '';
        document.getElementById('rule-enabled').checked = rule ? !!rule.enabled : true;
        ruleModal.style.display = 'flex';
    }

    async function editRule(id) {
        try {
            const rule = await apiFetch(`/api/automation/rules/${id}`);
            openRuleModal(rule);
        } catch (err) { showToast(err.message, 'error'); }
    }

    async function saveRule() {
        const id = document.getElementById('rule-id').value;
        const body = {
            name: document.getElementById('rule-name').value.trim(),
            description: document.getElementById('rule-desc').value.trim(),
            condition_type: document.getElementById('rule-condition').value,
            condition_op: document.getElementById('rule-operator').value,
            condition_value: parseFloat(document.getElementById('rule-value').value) || 0,
            severity: document.getElementById('rule-severity').value,
            scope_device_id: document.getElementById('rule-device').value.trim() || null,
            enabled: document.getElementById('rule-enabled').checked,
        };

        if (!body.name) { showToast(_('common.field_required').replace('{field}', _('automation.rule_name')), 'error'); return; }

        try {
            const url = id ? `/api/automation/rules/${id}` : '/api/automation/rules';
            const method = id ? 'PATCH' : 'POST';
            await apiFetch(url, { method, body: JSON.stringify(body) });
            ruleModal.style.display = 'none';
            showToast(_('common.saved'), 'success');
            loadRules();
        } catch (err) { showToast(err.message, 'error'); }
    }

    async function deleteRule(id) {
        if (!confirm(_('automation.delete_rule') + '?')) return;
        try {
            await apiFetch(`/api/automation/rules/${id}`, { method: 'DELETE' });
            showToast(_('common.success'), 'success');
            loadRules();
        } catch (err) { showToast(err.message, 'error'); }
    }

    createRuleBtn.addEventListener('click', () => openRuleModal(null));
    ruleSaveBtn.addEventListener('click', saveRule);

    // ==== ALERTS ====

    const alertsBody = document.getElementById('alerts-body');
    const severityFilter = document.getElementById('alert-severity-filter');

    async function loadAlerts() {
        alertsBody.innerHTML = `<tr class="loading-row"><td colspan="7">${_('common.loading')}</td></tr>`;
        const params = new URLSearchParams();
        const sev = severityFilter.value;
        if (sev) params.set('severity', sev);

        try {
            const resp = await apiFetch(`/api/automation/alerts?${params}`);
            renderAlerts(Array.isArray(resp) ? resp : Array.isArray(resp.alerts) ? resp.alerts : []);
        } catch (err) {
            alertsBody.innerHTML = `<tr class="empty-row"><td colspan="7">
                <div class="empty-state"><span class="material-icons">error_outline</span><p>${escapeHtml(err.message)}</p></div></td></tr>`;
        }
    }

    function renderAlerts(alerts) {
        if (!alerts.length) {
            alertsBody.innerHTML = `<tr class="empty-row"><td colspan="7">
                <div class="empty-state"><span class="material-icons">notifications_none</span><p>${_('automation.no_alerts')}</p></div></td></tr>`;
            return;
        }
        alertsBody.innerHTML = alerts.map(a => `
            <tr>
                <td><span class="severity-badge ${safeSeverity(a.severity)}">${escapeHtml(_('automation.severity_' + a.severity) || a.severity)}</span></td>
                <td>${escapeHtml(a.rule_name || '—')}</td>
                <td>${escapeHtml(a.device_id || '—')}</td>
                <td>${a.measured_value != null ? escapeHtml(a.measured_value) : '—'}</td>
                <td class="time-cell">${formatTimeAgo(a.triggered_at)}</td>
                <td>${a.acknowledged_at ? '<span class="material-icons" style="color:var(--accent-green);font-size:18px">check_circle</span>' : '—'}</td>
                <td>${!a.acknowledged_at ? `<button class="btn btn-sm btn-secondary ack-btn" data-id="${escapeHtml(a.id)}"><span class="material-icons" style="font-size:16px">check</span></button>` : ''}</td>
            </tr>
        `).join('');

        alertsBody.querySelectorAll('.ack-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                try {
                    await apiFetch(`/api/automation/alerts/${btn.dataset.id}/ack`, { method: 'POST' });
                    loadAlerts();
                } catch (err) { showToast(err.message, 'error'); }
            });
        });
    }

    severityFilter.addEventListener('change', loadAlerts);

    // ==== COMMANDS ====

    const commandsBody = document.getElementById('commands-body');
    const sendCmdBtn = document.getElementById('send-command-btn');
    const cmdModal = document.getElementById('cmd-modal');
    const cmdSendBtn = document.getElementById('cmd-send-btn');
    const resultModal = document.getElementById('result-modal');
    const resultBody = document.getElementById('result-body');

    async function loadCommands() {
        commandsBody.innerHTML = `<tr class="loading-row"><td colspan="7">${_('common.loading')}</td></tr>`;
        try {
            const resp = await apiFetch('/api/automation/commands');
            renderCommands(Array.isArray(resp) ? resp : Array.isArray(resp.commands) ? resp.commands : []);
        } catch (err) {
            commandsBody.innerHTML = `<tr class="empty-row"><td colspan="7">
                <div class="empty-state"><span class="material-icons">error_outline</span><p>${escapeHtml(err.message)}</p></div></td></tr>`;
        }
    }

    function renderCommands(cmds) {
        if (!cmds.length) {
            commandsBody.innerHTML = `<tr class="empty-row"><td colspan="7">
                <div class="empty-state"><span class="material-icons">terminal</span><p>${_('automation.no_commands')}</p></div></td></tr>`;
            return;
        }
        commandsBody.innerHTML = cmds.map(c => `
            <tr>
                <td>#${escapeHtml(c.id)}</td>
                <td>${escapeHtml(c.device_id)}</td>
                <td>${escapeHtml(c.command_type)}</td>
                <td title="${escapeHtml(c.payload)}">${escapeHtml(truncate(c.payload, 40))}</td>
                <td><span class="cmd-status ${safeStatus(c.status)}">${escapeHtml(_('automation.status_' + c.status) || c.status)}</span></td>
                <td class="time-cell">${formatTimeAgo(c.created_at)}</td>
                <td>${c.result ? `<button class="btn btn-sm btn-secondary result-btn" data-id="${escapeHtml(c.id)}"><span class="material-icons" style="font-size:16px">article</span></button>` : '—'}</td>
            </tr>
        `).join('');

        commandsBody.querySelectorAll('.result-btn').forEach(btn => {
            btn.addEventListener('click', () => viewResult(btn.dataset.id));
        });
    }

    async function viewResult(id) {
        resultModal.style.display = 'flex';
        resultBody.innerHTML = `<p>${_('common.loading')}</p>`;
        try {
            const cmd = await apiFetch(`/api/automation/commands/${id}`);
            resultBody.innerHTML = `
                <div class="detail-grid" style="margin-bottom:16px">
                    <div class="detail-item"><span class="detail-label">${_('inventory.device_id')}</span><span class="detail-value">${escapeHtml(cmd.device_id)}</span></div>
                    <div class="detail-item"><span class="detail-label">${_('automation.command_type')}</span><span class="detail-value">${escapeHtml(cmd.command_type)}</span></div>
                    <div class="detail-item"><span class="detail-label">${_('automation.command_status')}</span><span class="cmd-status ${safeStatus(cmd.status)}">${escapeHtml(_('automation.status_' + cmd.status))}</span></div>
                </div>
                <h4>${_('automation.command_payload')}</h4>
                <div class="result-output">${escapeHtml(cmd.payload)}</div>
                <h4 style="margin-top:16px">${_('automation.command_result')}</h4>
                <div class="result-output">${escapeHtml(cmd.result || '—')}</div>`;
        } catch (err) {
            resultBody.innerHTML = `<p class="text-error">${escapeHtml(err.message)}</p>`;
        }
    }

    async function sendCommand() {
        const body = {
            device_id: document.getElementById('cmd-device').value.trim(),
            command_type: document.getElementById('cmd-type').value,
            payload: document.getElementById('cmd-payload').value.trim(),
        };

        if (!body.device_id || !body.payload) {
            showToast(_('automation.id_payload_required'), 'error');
            return;
        }

        try {
            await apiFetch('/api/automation/commands', { method: 'POST', body: JSON.stringify(body) });
            cmdModal.style.display = 'none';
            showToast(_('common.success'), 'success');
            loadCommands();
        } catch (err) { showToast(err.message, 'error'); }
    }

    sendCmdBtn.addEventListener('click', () => { cmdModal.style.display = 'flex'; });
    cmdSendBtn.addEventListener('click', sendCommand);

    // ---- Helpers ----

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    function safeToken(value, allowed, fallback) {
        return allowed.includes(value) ? value : fallback;
    }

    function safeSeverity(value) {
        return safeToken(value, ['info', 'low', 'warning', 'medium', 'high', 'critical'], 'warning');
    }

    function safeStatus(value) {
        return safeToken(value, ['pending', 'queued', 'running', 'success', 'completed', 'failed', 'error', 'cancelled'], 'pending');
    }

    function truncate(str, max) {
        if (!str) return '';
        return str.length > max ? str.slice(0, max) + '…' : str;
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

    // ---- Modal close ----

    document.querySelectorAll('.modal-close').forEach(btn => {
        btn.addEventListener('click', () => {
            const modalId = btn.dataset.modal;
            if (modalId) document.getElementById(modalId).style.display = 'none';
        });
    });

    // ---- Init ----
    loadRules();
})();
