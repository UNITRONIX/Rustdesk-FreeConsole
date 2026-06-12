/* attestation.js — Device Attestation Dashboard */
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    loadAttestation();
  }

  async function loadAttestation() {
    try {
      const resp = await fetch('/api/panel/attestation', { credentials: 'same-origin' });
      if (!resp.ok) throw new Error(resp.statusText);
      const raw = await resp.json();
      const records = raw.data || raw.records || raw || [];
      renderTable(Array.isArray(records) ? records : []);
      updateStats(Array.isArray(records) ? records : []);
    } catch (e) {
      console.warn('Failed to load attestation:', e);
      document.getElementById('attestation-body').innerHTML =
        '<tr><td colspan="6" class="text-muted text-center">Failed to load attestation data.</td></tr>';
    }
  }

  function updateStats(records) {
    let verified = 0, pending = 0, failed = 0;
    records.forEach(r => {
      const s = (r.status || '').toLowerCase();
      if (s === 'verified' || s === 'trusted') verified++;
      else if (s === 'failed' || s === 'mismatch' || s === 'revoked') failed++;
      else pending++;
    });
    setText('att-verified', verified);
    setText('att-pending', pending);
    setText('att-failed', failed);
  }

  function renderTable(records) {
    const tbody = document.getElementById('attestation-body');
    if (!records.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-muted text-center">' +
        (typeof _ === 'function' ? _('attestation.no_records') : 'No attestation records found.') + '</td></tr>';
      return;
    }
    tbody.innerHTML = records.map(r => {
      const status = (r.status || 'pending').toLowerCase();
      const statusClass = status === 'verified' || status === 'trusted' ? 'status-online' :
        status === 'failed' || status === 'mismatch' ? 'status-offline' : 'status-pending';
      const fp = r.fingerprint || r.device_fingerprint || '—';
      const short = fp.length > 16 ? fp.slice(0, 8) + '…' + fp.slice(-8) : fp;
      return `
        <tr data-device="${escapeHtml(r.device_id || '')}">
          <td><code>${escapeHtml(r.device_id || '—')}</code></td>
          <td>${escapeHtml(r.hostname || '—')}</td>
          <td><code title="${escapeHtml(fp)}">${escapeHtml(short)}</code></td>
          <td><span class="device-status-dot ${statusClass}"></span> ${escapeHtml(status)}</td>
          <td>${r.last_check ? new Date(r.last_check).toLocaleString() : '—'}</td>
          <td>
            <button class="btn btn-xs btn-ghost" onclick="Attestation.verify('${escapeAttr(r.device_id)}')" title="Verify">
              <span class="material-icons" style="font-size:16px;">verified</span>
            </button>
            <button class="btn btn-xs btn-ghost" onclick="Attestation.revoke('${escapeAttr(r.device_id)}')" title="Revoke">
              <span class="material-icons" style="font-size:16px;">block</span>
            </button>
          </td>
        </tr>`;
    }).join('');
  }

  async function verify(deviceId) {
    if (!confirm('Mark this device as verified?')) return;
    try {
      const csrfToken = window.BetterDesk?.csrfToken || '';
      const resp = await fetch(`/api/panel/attestation/${encodeURIComponent(deviceId)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(csrfToken ? { 'x-csrf-token': csrfToken } : {})
        },
        credentials: 'same-origin',
        body: JSON.stringify({ status: 'verified' })
      });
      if (!resp.ok) throw new Error(resp.statusText);
      if (typeof Notifications !== 'undefined') Notifications.success(_('attestation.verify_success') || 'Device marked as verified');
      loadAttestation();
    } catch (e) {
      if (typeof Notifications !== 'undefined') Notifications.error(_('attestation.verify_failed') || 'Failed to verify device');
    }
  }

  async function revoke(deviceId) {
    if (!confirm('Revoke attestation for this device?')) return;
    try {
      const csrfToken = window.BetterDesk?.csrfToken || '';
      const resp = await fetch(`/api/panel/attestation/${encodeURIComponent(deviceId)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(csrfToken ? { 'x-csrf-token': csrfToken } : {})
        },
        credentials: 'same-origin',
        body: JSON.stringify({ status: 'revoked' })
      });
      if (!resp.ok) throw new Error(resp.statusText);
      if (typeof Notifications !== 'undefined') Notifications.warning(_('attestation.revoke_success') || 'Device attestation revoked');
      loadAttestation();
    } catch (e) {
      if (typeof Notifications !== 'undefined') Notifications.error(_('attestation.revoke_failed') || 'Failed to revoke attestation');
    }
  }

  function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function escapeAttr(s) {
    return String(s || '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/"/g, '&quot;');
  }

  window.Attestation = { verify, revoke };
})();
