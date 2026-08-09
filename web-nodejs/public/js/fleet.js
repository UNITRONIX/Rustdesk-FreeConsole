/* fleet.js — Fleet Management: Resources, Tasks, Compliance */
'use strict';
(function () {
    const _ = window._ || (k => k);
    let _orgs = [];
    let _resources = [];
    let _tasks = [];
    let _complianceData = [];

    // -----------------------------------------------------------------------
    // Init
    // -----------------------------------------------------------------------
    async function init() {
        await loadOrganizations();
        const activeTab = document.querySelector('.fleet-tab.active')?.dataset.tab || 'resources';
        if (activeTab === 'resources') loadResources();
        if (activeTab === 'tasks') loadTasks();
        if (activeTab === 'compliance') loadCompliance();
    }

    async function loadOrganizations() {
        try {
            const resp = await fetch('/api/panel/org', { credentials: 'same-origin' });
            const data = await resp.json();
            _orgs = Array.isArray(data) ? data : (data.data || data.organizations || []);
        } catch { _orgs = []; }
        populateOrgSelects();
    }

    function populateOrgSelects() {
        ['res-org-select', 'comp-org-select'].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            const val = el.value;
            const opts = el.querySelectorAll('option:not(:first-child)');
            opts.forEach(o => o.remove());
            _orgs.forEach(o => {
                const opt = document.createElement('option');
                opt.value = o.id || o.name;
                opt.textContent = o.name || o.id;
                el.appendChild(opt);
            });
            if (val) el.value = val;
        });
    }

    // -----------------------------------------------------------------------
    // Tab switching
    // -----------------------------------------------------------------------
    function switchTab(tab) {
        document.querySelectorAll('.fleet-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
        document.querySelectorAll('.fleet-panel').forEach(p => p.style.display = 'none');
        const panel = document.getElementById('panel-' + tab);
        if (panel) panel.style.display = 'block';
        // Update URL without reload
        const url = new URL(window.location);
        url.searchParams.set('tab', tab);
        history.replaceState(null, '', url);
        // Load data on tab switch
        if (tab === 'resources') loadResources();
        if (tab === 'tasks') loadTasks();
        if (tab === 'compliance') loadCompliance();
    }

    // -----------------------------------------------------------------------
    // Resources
    // -----------------------------------------------------------------------
    async function loadResources() {
        const orgId = document.getElementById('res-org-select')?.value;
        if (!orgId) { renderResources([]); return; }
        try {
            const resp = await fetch(`/api/panel/fleet/resources/${encodeURIComponent(orgId)}`);
            const data = await resp.json();
            _resources = Array.isArray(data) ? data : (data.data || data.resources || []);
        } catch { _resources = []; }
        const typeFilter = document.getElementById('res-type-filter')?.value;
        const filtered = typeFilter ? _resources.filter(r => r.type === typeFilter) : _resources;
        renderResources(filtered);
    }

    function renderResources(list) {
        const tbody = document.getElementById('res-tbody');
        const empty = document.getElementById('res-empty');
        if (!tbody) return;
        if (!list.length) { tbody.innerHTML = ''; empty.style.display = 'flex'; return; }
        empty.style.display = 'none';
        tbody.innerHTML = list.map(r => `
            <tr>
                <td>${esc(r.name)}</td>
                <td><span class="status-badge active">${esc(r.type)}</span></td>
                <td>${esc(r.address || r.value || '-')}</td>
                <td>${esc(r.scope || 'org')} ${r.scope_value ? '(' + esc(r.scope_value) + ')' : ''}</td>
                <td><span class="status-badge ${r.active !== false ? 'active' : 'inactive'}">${r.active !== false ? _('fleet.active') : _('fleet.inactive')}</span></td>
                <td>
                    <button class="btn-icon" title="Edit" onclick="Fleet.editResource('${esc(r.id)}')"><span class="material-icons">edit</span></button>
                    <button class="btn-icon" title="Delete" onclick="Fleet.deleteResource('${esc(r.id)}')"><span class="material-icons">delete</span></button>
                </td>
            </tr>
        `).join('');
    }

    function showResourceModal(resource) {
        document.getElementById('res-edit-id').value = resource?.id || '';
        document.getElementById('res-name').value = resource?.name || '';
        document.getElementById('res-type').value = resource?.type || 'printer';
        document.getElementById('res-address').value = resource?.address || resource?.value || '';
        document.getElementById('res-scope').value = resource?.scope || 'org';
        document.getElementById('res-scope-value').value = resource?.scope_value || '';
        document.getElementById('res-modal-title').textContent = resource ? _('fleet.edit_resource') : _('fleet.add_resource');
        document.getElementById('resource-modal').style.display = 'flex';
        onResTypeChange();
    }

    function closeResourceModal() { document.getElementById('resource-modal').style.display = 'none'; }

    function onResTypeChange() {
        const type = document.getElementById('res-type')?.value;
        const label = document.getElementById('res-address-label');
        const input = document.getElementById('res-address');
        if (!label || !input) return;
        const placeholders = {
            printer: '\\\\server\\printer',
            network_drive: '\\\\server\\share',
            dns: '8.8.8.8, 1.1.1.1',
            vpn: 'vpn.example.com',
            proxy: 'http://proxy:8080'
        };
        label.textContent = type === 'dns' ? 'DNS Servers' : type === 'vpn' ? 'VPN Endpoint' : _('fleet.address');
        input.placeholder = placeholders[type] || '';
    }

    async function saveResource() {
        const orgId = document.getElementById('res-org-select')?.value;
        if (!orgId) return;
        const editId = document.getElementById('res-edit-id')?.value;
        const body = {
            name: document.getElementById('res-name')?.value?.trim(),
            type: document.getElementById('res-type')?.value,
            address: document.getElementById('res-address')?.value?.trim(),
            scope: document.getElementById('res-scope')?.value,
            scope_value: document.getElementById('res-scope-value')?.value?.trim()
        };
        if (!body.name) return;
        try {
            const url = editId
                ? `/api/panel/fleet/resources/${encodeURIComponent(orgId)}/${encodeURIComponent(editId)}`
                : `/api/panel/fleet/resources/${encodeURIComponent(orgId)}`;
            await fetch(url, {
                method: editId ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            closeResourceModal();
            loadResources();
        } catch (e) { console.error('saveResource', e); }
    }

    function editResource(id) {
        const r = _resources.find(x => x.id === id);
        if (r) showResourceModal(r);
    }

    async function deleteResource(id) {
        if (!confirm(_('fleet.confirm_delete'))) return;
        const orgId = document.getElementById('res-org-select')?.value;
        if (!orgId) return;
        try {
            await fetch(`/api/panel/fleet/resources/${encodeURIComponent(orgId)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
            loadResources();
        } catch (e) { console.error('deleteResource', e); }
    }

    function onResOrgChange() { loadResources(); }

    // -----------------------------------------------------------------------
    // Tasks
    // -----------------------------------------------------------------------
    async function loadTasks() {
        const qs = new URLSearchParams();
        const status = document.getElementById('task-status-filter')?.value;
        if (status) qs.set('status', status);
        try {
            const resp = await fetch(`/api/panel/fleet/tasks?${qs.toString()}`);
            const data = await resp.json();
            _tasks = Array.isArray(data) ? data : (data.data || data.tasks || []);
        } catch { _tasks = []; }
        renderTasks(_tasks);
    }

    function renderTasks(list) {
        const tbody = document.getElementById('task-tbody');
        const empty = document.getElementById('task-empty');
        if (!tbody) return;
        if (!list.length) { tbody.innerHTML = ''; empty.style.display = 'flex'; return; }
        empty.style.display = 'none';
        tbody.innerHTML = list.map(t => `
            <tr>
                <td>${esc(t.name)}</td>
                <td>${esc(t.type || t.task_type || '-')}</td>
                <td>${esc(t.targets || t.device_id || '-')}</td>
                <td>${esc(formatSchedule(t))}</td>
                <td><span class="status-badge ${esc(t.status || 'pending')}">${esc(t.status || 'pending')}</span></td>
                <td>${t.last_run ? new Date(t.last_run).toLocaleString() : '-'}</td>
                <td>
                    <button class="btn-icon" title="Output" onclick="Fleet.showOutput('${esc(t.id)}')"><span class="material-icons">terminal</span></button>
                    ${t.status === 'failed' ? `<button class="btn-icon" title="Retry" onclick="Fleet.retryTask('${esc(t.id)}')"><span class="material-icons">replay</span></button>` : ''}
                    <button class="btn-icon" title="Delete" onclick="Fleet.deleteTask('${esc(t.id)}')"><span class="material-icons">delete</span></button>
                </td>
            </tr>
        `).join('');
    }

    function filterTasks() {
        const q = (document.getElementById('task-search')?.value || '').toLowerCase();
        if (!q) { renderTasks(_tasks); return; }
        renderTasks(_tasks.filter(t =>
            (t.name || '').toLowerCase().includes(q) ||
            (t.targets || '').toLowerCase().includes(q)
        ));
    }

    function formatSchedule(t) {
        if (t.schedule_type === 'cron') return `cron: ${t.schedule_value || t.cron || ''}`;
        if (t.schedule_type === 'once') return t.schedule_value || 'once';
        return _('fleet.schedule_immediate');
    }

    function showTaskModal(task) {
        document.getElementById('task-edit-id').value = task?.id || '';
        document.getElementById('task-name').value = task?.name || '';
        document.getElementById('task-type').value = task?.type || task?.task_type || 'script';
        document.getElementById('task-targets').value = task?.targets || task?.device_id || '';
        document.getElementById('task-schedule-type').value = task?.schedule_type || 'immediate';
        document.getElementById('task-schedule-value').value = task?.schedule_value || task?.cron || '';
        document.getElementById('task-script').value = task?.script || task?.payload || '';
        document.getElementById('task-retries').value = task?.retries ?? 0;
        document.getElementById('task-timeout').value = task?.timeout ?? 300;
        document.getElementById('task-modal-title').textContent = task ? _('fleet.edit_task') : _('fleet.create_task');
        onScheduleTypeChange();
        document.getElementById('task-modal').style.display = 'flex';
    }

    function closeTaskModal() { document.getElementById('task-modal').style.display = 'none'; }

    function onScheduleTypeChange() {
        const type = document.getElementById('task-schedule-type')?.value;
        const valInput = document.getElementById('task-schedule-value');
        if (!valInput) return;
        valInput.style.display = type === 'immediate' ? 'none' : 'block';
        if (type === 'once') { valInput.type = 'datetime-local'; valInput.placeholder = ''; }
        else { valInput.type = 'text'; valInput.placeholder = _('fleet.cron_placeholder'); }
    }

    async function saveTask() {
        const editId = document.getElementById('task-edit-id')?.value;
        const body = {
            name: document.getElementById('task-name')?.value?.trim(),
            type: document.getElementById('task-type')?.value,
            targets: document.getElementById('task-targets')?.value?.trim(),
            schedule_type: document.getElementById('task-schedule-type')?.value,
            schedule_value: document.getElementById('task-schedule-value')?.value?.trim(),
            script: document.getElementById('task-script')?.value,
            retries: parseInt(document.getElementById('task-retries')?.value) || 0,
            timeout: parseInt(document.getElementById('task-timeout')?.value) || 300
        };
        if (!body.name) return;
        try {
            const url = editId
                ? `/api/panel/fleet/tasks/${encodeURIComponent(editId)}`
                : '/api/panel/fleet/tasks';
            await fetch(url, {
                method: editId ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            closeTaskModal();
            loadTasks();
        } catch (e) { console.error('saveTask', e); }
    }

    async function deleteTask(id) {
        if (!confirm(_('fleet.confirm_delete'))) return;
        try {
            await fetch(`/api/panel/fleet/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
            loadTasks();
        } catch (e) { console.error('deleteTask', e); }
    }

    async function retryTask(id) {
        try {
            await fetch(`/api/panel/fleet/tasks/${encodeURIComponent(id)}/retry`, { method: 'POST' });
            loadTasks();
        } catch (e) { console.error('retryTask', e); }
    }

    async function showOutput(taskId) {
        const panel = document.getElementById('task-output-panel');
        const pre = document.getElementById('task-output-pre');
        if (!panel || !pre) return;
        panel.style.display = 'block';
        pre.textContent = _('fleet.loading') + '...';
        try {
            const resp = await fetch(`/api/panel/fleet/tasks/${encodeURIComponent(taskId)}/output`);
            const data = await resp.json();
            pre.textContent = data.output || data.log || _('fleet.no_output');
        } catch { pre.textContent = _('fleet.error_loading'); }
    }

    function closeOutput() {
        const panel = document.getElementById('task-output-panel');
        if (panel) panel.style.display = 'none';
    }

    // -----------------------------------------------------------------------
    // Compliance
    // -----------------------------------------------------------------------
    async function loadCompliance() {
        const qs = new URLSearchParams();
        const orgId = document.getElementById('comp-org-select')?.value;
        if (orgId) qs.set('orgId', orgId);
        try {
            const resp = await fetch(`/api/panel/fleet/compliance?${qs.toString()}`);
            const data = await resp.json();
            _complianceData = Array.isArray(data) ? data : (data.data || data.devices || []);
        } catch { _complianceData = []; }
        renderCompliance(_complianceData);
    }

    function renderCompliance(list) {
        // Stats
        let compliant = 0, warning = 0, critical = 0, totalScore = 0;
        list.forEach(d => {
            const s = d.score ?? 0;
            totalScore += s;
            if (s >= 80) compliant++;
            else if (s >= 50) warning++;
            else critical++;
        });
        document.getElementById('comp-compliant').textContent = compliant;
        document.getElementById('comp-warning').textContent = warning;
        document.getElementById('comp-critical').textContent = critical;
        document.getElementById('comp-score').textContent = list.length ? Math.round(totalScore / list.length) + '%' : '--%';

        // Table
        const tbody = document.getElementById('comp-tbody');
        const empty = document.getElementById('comp-empty');
        if (!tbody) return;
        if (!list.length) { tbody.innerHTML = ''; empty.style.display = 'flex'; return; }
        empty.style.display = 'none';
        tbody.innerHTML = list.map(d => {
            const score = d.score ?? 0;
            const cls = score >= 80 ? 'good' : score >= 50 ? 'warning' : 'bad';
            return `
            <tr>
                <td>${esc(d.device_id || d.id)}</td>
                <td>${esc(d.hostname || '-')}</td>
                <td>${esc(d.os || d.platform || '-')}</td>
                <td>
                    <strong>${score}%</strong>
                    <span class="score-bar"><span class="score-bar-fill ${cls}" style="width:${score}%"></span></span>
                </td>
                <td>${d.issues ?? 0}</td>
                <td>${d.last_scan ? new Date(d.last_scan).toLocaleString() : '-'}</td>
                <td>
                    <button class="btn-icon" title="Scan" onclick="Fleet.scanDevice('${esc(d.device_id || d.id)}')"><span class="material-icons">radar</span></button>
                    <button class="btn-icon" title="Remediate" onclick="Fleet.remediate('${esc(d.device_id || d.id)}')"><span class="material-icons">build</span></button>
                </td>
            </tr>`;
        }).join('');
    }

    async function scanDevice(deviceId) {
        try {
            await fetch(`/api/panel/fleet/compliance/${encodeURIComponent(deviceId)}/scan`, { method: 'POST' });
            loadCompliance();
        } catch (e) { console.error('scanDevice', e); }
    }

    async function scanAll() {
        // Scan all devices in the compliance list
        for (const d of _complianceData) {
            try { await fetch(`/api/panel/fleet/compliance/${encodeURIComponent(d.device_id || d.id)}/scan`, { method: 'POST' }); }
            catch { /* continue */ }
        }
        loadCompliance();
    }

    async function remediate(deviceId) {
        if (!confirm(_('fleet.confirm_remediate'))) return;
        try {
            await fetch(`/api/panel/fleet/compliance/${encodeURIComponent(deviceId)}/remediate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'auto' })
            });
            loadCompliance();
        } catch (e) { console.error('remediate', e); }
    }

    // -----------------------------------------------------------------------
    // Workflow helpers (non-builder)
    // -----------------------------------------------------------------------
    async function loadWorkflowList() {
        const sel = document.getElementById('workflow-select');
        if (!sel) return;
        try {
            const resp = await fetch('/api/panel/fleet/workflows');
            const data = await resp.json();
            const workflows = Array.isArray(data) ? data : (data.data || data.workflows || []);
            const opts = sel.querySelectorAll('option:not(:first-child)');
            opts.forEach(o => o.remove());
            workflows.forEach(w => {
                const opt = document.createElement('option');
                opt.value = w.id;
                opt.textContent = w.name || w.id;
                sel.appendChild(opt);
            });
        } catch { /* no workflows */ }
    }

    // Helpers
    function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    window.Fleet = {
        switchTab,
        // Resources
        loadResources, onResOrgChange, showResourceModal, closeResourceModal,
        onResTypeChange, saveResource, editResource, deleteResource,
        // Tasks
        loadTasks, filterTasks, showTaskModal, closeTaskModal,
        onScheduleTypeChange, saveTask, deleteTask, retryTask,
        showOutput, closeOutput,
        // Compliance
        loadCompliance, scanDevice, scanAll, remediate,
        // Workflow
        loadWorkflowList, loadWorkflow: loadWorkflowList,
        newWorkflow() { if (window.FleetBuilder) FleetBuilder.newWorkflow(); },
        saveWorkflow() { if (window.FleetBuilder) FleetBuilder.saveWorkflow(); },
        exportWorkflow() { if (window.FleetBuilder) FleetBuilder.exportWorkflow(); },
        executeWorkflow(dryRun) { if (window.FleetBuilder) FleetBuilder.execute(dryRun); }
    };

    document.addEventListener('DOMContentLoaded', init);
})();
