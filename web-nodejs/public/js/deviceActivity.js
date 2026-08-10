/** Actual operator-to-device remote-session report. */
(function() {
    'use strict';

    let report = null;
    let loading = false;

    document.addEventListener('DOMContentLoaded', initDeviceActivity);

    function initDeviceActivity() {
        const toggle = document.getElementById('device-activity-toggle');
        const panel = document.getElementById('device-activity-panel');
        if (!toggle || !panel) return;
        const today = new Date();
        const first = new Date(today.getFullYear(), today.getMonth(), 1);
        document.getElementById('device-activity-from').value = dateInputValue(first);
        document.getElementById('device-activity-to').value = dateInputValue(today);

        toggle.addEventListener('click', () => {
            panel.hidden = !panel.hidden;
            toggle.classList.toggle('active', !panel.hidden);
            if (!panel.hidden && !report) loadReport();
        });
        document.getElementById('device-activity-close')?.addEventListener('click', () => {
            panel.hidden = true;
            toggle.classList.remove('active');
        });
        document.getElementById('device-activity-run')?.addEventListener('click', loadReport);
        document.getElementById('device-activity-export')?.addEventListener('click', exportCSV);
        document.getElementById('device-activity-select-all')?.addEventListener('change', event => {
            document.querySelectorAll('.device-activity-select').forEach(input => { input.checked = event.target.checked; });
            updateExportState();
        });
        document.getElementById('device-activity-tbody')?.addEventListener('change', event => {
            if (event.target.classList.contains('device-activity-select')) updateExportState();
        });
        document.getElementById('device-activity-tbody')?.addEventListener('click', event => {
            const button = event.target.closest('[data-activity-details]');
            if (!button) return;
            const details = document.getElementById(button.dataset.activityDetails);
            if (!details) return;
            details.hidden = !details.hidden;
            button.classList.toggle('expanded', !details.hidden);
            button.querySelector('.material-icons').textContent = details.hidden ? 'expand_more' : 'expand_less';
        });
        window.setInterval(updateCurrentSessionDurations, 1000);
    }

    function dateInputValue(date) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    function requestPayload(operators) {
        const typedOperator = document.getElementById('device-activity-operator')?.value.trim() || '';
        const payload = {
            from_date: document.getElementById('device-activity-from')?.value || '',
            to_date: document.getElementById('device-activity-to')?.value || '',
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
            live_only: document.getElementById('device-activity-connected-only')?.checked === true
        };
        if (Array.isArray(operators)) payload.operators = operators;
        else if (typedOperator) payload.operators = [typedOperator];
        return payload;
    }

    async function loadReport() {
        if (loading) return;
        loading = true;
        const tbody = document.getElementById('device-activity-tbody');
        const run = document.getElementById('device-activity-run');
        const exportButton = document.getElementById('device-activity-export');
        if (run) run.disabled = true;
        if (exportButton) exportButton.disabled = true;
        if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="device-activity-empty"><span class="spinner"></span> ${Utils.escapeHtml(_('common.loading'))}</td></tr>`;
        try {
            report = await Utils.api('/api/devices/activity/report', { method: 'POST', body: requestPayload() });
            renderReport();
        } catch (error) {
            report = null;
            if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="device-activity-empty error">${Utils.escapeHtml(error.message || _('devices.activity_error'))}</td></tr>`;
            Notifications.error(error.message || _('devices.activity_error'));
        } finally {
            loading = false;
            if (run) run.disabled = false;
            updateExportState();
        }
    }

    function formatDuration(seconds, exact) {
        const total = Math.max(0, Math.floor(Number(seconds) || 0));
        const days = Math.floor(total / 86400);
        const hours = Math.floor((total % 86400) / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const secs = total % 60;
        if (exact) return `${String(Math.floor(total / 3600)).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        if (days > 0) return `${days} d ${String(hours).padStart(2, '0')} h ${String(minutes).padStart(2, '0')} min`;
        return `${String(hours).padStart(2, '0')} h ${String(minutes).padStart(2, '0')} min`;
    }

    function formatDateTime(value) {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return '—';
        const options = {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        };
        if (report?.timezone) options.timeZone = report.timezone;
        try {
            return new Intl.DateTimeFormat(undefined, options).format(date);
        } catch (_) {
            delete options.timeZone;
            return new Intl.DateTimeFormat(undefined, options).format(date);
        }
    }

    function sessionEvidence(device, session) {
        const controllerID = Utils.escapeHtml(session.controller_id || session.operator || '—');
        const targetID = Utils.escapeHtml(device.peer_id || session.peer_id || '—');
        const from = Utils.escapeHtml(formatDateTime(session.started_at));
        const to = session.ongoing ? Utils.escapeHtml(_('devices.live')) : Utils.escapeHtml(formatDateTime(session.ended_at));
        const actualSeconds = Math.max(0, Number(session.actual_connected_seconds) || Number(session.connected_seconds) || 0);
        const liveData = session.ongoing && session.started_at
            ? ` data-live-evidence-started-at="${Utils.escapeHtml(session.started_at)}"`
            : '';
        return `<div class="activity-session-evidence"${liveData}>
            <span class="activity-session-route"><code>${controllerID}</code> → <code>${targetID}</code></span>
            <span><b>${Utils.escapeHtml(_('devices.activity_from'))}:</b> ${from}</span>
            <span><b>${Utils.escapeHtml(_('devices.activity_to'))}:</b> ${to}</span>
            <small>${formatDuration(actualSeconds, true)}</small>
        </div>`;
    }

    function currentSessionDuration(operator) {
        if (!operator.live || !operator.current_session_started_at) return '—';
        const seconds = Math.max(0, Number(operator.current_session_seconds) || 0);
        const startedAt = Utils.escapeHtml(operator.current_session_started_at);
        return `<span class="device-activity-current-session" data-current-session-started-at="${startedAt}" data-current-session-seconds="${seconds}">
            <strong>${formatDuration(seconds)}</strong><small>${formatDuration(seconds, true)}</small>
        </span>`;
    }

    function updateCurrentSessionDurations() {
        document.querySelectorAll('[data-current-session-started-at]').forEach(element => {
            const startedAt = Date.parse(element.dataset.currentSessionStartedAt || '');
            if (!Number.isFinite(startedAt)) return;
            const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
            const friendly = element.querySelector('strong');
            const exact = element.querySelector('small');
            if (friendly) friendly.textContent = formatDuration(seconds);
            if (exact) exact.textContent = formatDuration(seconds, true);
        });
        document.querySelectorAll('[data-live-evidence-started-at]').forEach(element => {
            const startedAt = Date.parse(element.dataset.liveEvidenceStartedAt || '');
            if (!Number.isFinite(startedAt)) return;
            const duration = element.querySelector('small');
            if (duration) duration.textContent = formatDuration(Math.floor((Date.now() - startedAt) / 1000), true);
        });
    }

    function renderReport() {
        renderSummary();
        const tbody = document.getElementById('device-activity-tbody');
        const operators = Array.isArray(report?.operators) ? report.operators : [];
        updateOperatorOptions(operators);
        if (!tbody) return;
        if (operators.length === 0) {
            tbody.innerHTML = `<tr><td colspan="9" class="device-activity-empty">${Utils.escapeHtml(_('devices.activity_no_data'))}</td></tr>`;
            return;
        }
        tbody.innerHTML = operators.map((operator, index) => {
            const username = Utils.escapeHtml(operator.username || 'unknown');
            const detailID = `device-activity-detail-${index}`;
            const deviceRows = (operator.devices || []).map(device => {
                const remoteID = Utils.escapeHtml(device.peer_id || '—');
                const name = Utils.escapeHtml(device.display_name || device.peer_id || '—');
                const days = (device.days || []).map(day =>
                    `<span class="activity-day-chip"><b>${Utils.escapeHtml(day.date)}</b> ${formatDuration(day.connected_seconds, true)} · ${Number(day.session_count) || 0}</span>`
                ).join('');
                const evidence = (device.intervals || []).map(session => sessionEvidence(device, session)).join('');
                return `<tr>
                    <td><strong>${name}</strong><small class="activity-remote-id">Remote PC ID: <code>${remoteID}</code></small></td>
                    <td><strong>${formatDuration(device.connected_seconds)}</strong><small>${formatDuration(device.connected_seconds, true)}</small></td>
                    <td><div class="activity-day-list">${days || '—'}</div></td>
                    <td>${Number(device.session_count) || 0}</td>
                    <td><div class="activity-session-evidence-list">${evidence || '—'}</div></td>
                    <td><span class="status-badge ${device.live ? 'live' : 'offline'}"><span class="status-dot"></span>${Utils.escapeHtml(device.live ? _('devices.live') : '—')}</span></td>
                </tr>`;
            }).join('');
            return `<tr class="device-activity-device-row">
                <td><input type="checkbox" class="device-activity-select" data-operator="${username}" checked></td>
                <td><strong>${username}</strong></td>
                <td><strong>${formatDuration(operator.connected_seconds)}</strong><small>${formatDuration(operator.connected_seconds, true)}</small></td>
                <td>${currentSessionDuration(operator)}</td>
                <td>${Number(operator.device_count) || 0}</td>
                <td>${Number(operator.active_days) || 0}</td>
                <td>${Number(operator.session_count) || 0}</td>
                <td><span class="status-badge ${operator.live ? 'live' : 'offline'}"><span class="status-dot"></span>${Utils.escapeHtml(operator.live ? _('devices.live') : '—')}</span></td>
                <td><button type="button" class="btn-icon" data-activity-details="${detailID}" title="${Utils.escapeHtml(_('devices.activity_daily_breakdown'))}"><span class="material-icons">expand_more</span></button></td>
            </tr>
            <tr class="device-activity-detail-row" id="${detailID}" hidden><td colspan="9">
                <div class="device-activity-day-title">${Utils.escapeHtml(_('devices.activity_operator'))}: ${username}</div>
                <table><thead><tr><th>${Utils.escapeHtml(_('devices.activity_pc'))}</th><th>${Utils.escapeHtml(_('devices.activity_total'))}</th><th>${Utils.escapeHtml(_('devices.activity_days'))}</th><th>${Utils.escapeHtml(_('devices.activity_sessions'))}</th><th>${Utils.escapeHtml(_('devices.activity_session_evidence'))}</th><th>${Utils.escapeHtml(_('devices.live'))}</th></tr></thead><tbody>${deviceRows}</tbody></table>
            </td></tr>`;
        }).join('');
        const selectAll = document.getElementById('device-activity-select-all');
        if (selectAll) selectAll.checked = true;
        updateCurrentSessionDurations();
        updateExportState();
    }

    function updateOperatorOptions(operators) {
        const list = document.getElementById('device-activity-operators');
        if (!list) return;
        list.innerHTML = operators.map(operator => `<option value="${Utils.escapeHtml(operator.username || '')}"></option>`).join('');
    }

    function renderSummary() {
        const summary = document.getElementById('device-activity-summary');
        if (!summary) return;
        const totals = report?.totals || {};
        summary.innerHTML = `
            <div><span>${Utils.escapeHtml(_('devices.activity_total'))}</span><strong>${formatDuration(totals.connected_seconds)}</strong><small>${formatDuration(totals.connected_seconds, true)}</small></div>
            <div><span>${Utils.escapeHtml(_('devices.activity_operator'))}</span><strong>${Number(totals.operators) || 0}</strong></div>
            <div><span>${Utils.escapeHtml(_('devices.activity_devices'))}</span><strong>${Number(totals.devices) || 0}</strong></div>
            <div><span>${Utils.escapeHtml(_('devices.live'))}</span><strong>${Number(totals.live_sessions) || 0}</strong></div>
            <div><span>${Utils.escapeHtml(_('devices.activity_sessions'))}</span><strong>${Number(totals.sessions) || 0}</strong></div>
            <div><span>${Utils.escapeHtml(_('devices.activity_period'))}</span><strong>${Utils.escapeHtml(report?.from_date || '')} – ${Utils.escapeHtml(report?.to_date || '')}</strong><small>${Utils.escapeHtml(report?.timezone || 'UTC')}</small></div>`;
    }

    function selectedOperators() {
        return Array.from(document.querySelectorAll('.device-activity-select:checked')).map(input => input.dataset.operator);
    }

    function updateExportState() {
        const button = document.getElementById('device-activity-export');
        if (button) button.disabled = loading || !report || selectedOperators().length === 0;
    }

    function exportCSV() {
        const operators = selectedOperators();
        if (operators.length === 0) return;
        const button = document.getElementById('device-activity-export');
        if (button) button.disabled = true;
        try {
            const payload = requestPayload(operators);
            const params = new URLSearchParams({
                from_date: payload.from_date,
                to_date: payload.to_date,
                timezone: payload.timezone,
                live_only: String(payload.live_only === true)
            });
            operators.forEach(operator => params.append('operator', operator));
            const link = document.createElement('a');
            link.href = `/api/devices/activity/export?${params.toString()}`;
            link.download = `remote-live-sessions_${payload.from_date}_${payload.to_date}.csv`;
            link.target = '_blank';
            link.rel = 'noopener';
            link.style.display = 'none';
            document.body.appendChild(link); link.click(); link.remove();
            Notifications.success(_('devices.activity_export_success'));
        } catch (error) {
            Notifications.error(error.message || _('devices.activity_export_error'));
        } finally {
            updateExportState();
        }
    }
})();
