'use strict';

/**
 * Billing work report modal — shown after remote session ends when a
 * billable session requires a technician report.
 */
(function (global) {
    function t(key, fallback) {
        if (typeof global.t === 'function') {
            const val = global.t(key);
            if (val && val !== key) return val;
        }
        return fallback !== undefined ? fallback : key;
    }

    function escapeHtml(s) {
        return String(s || '').replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function ensureModal() {
        let el = document.getElementById('billing-report-modal');
        if (el) return el;

        el = document.createElement('div');
        el.id = 'billing-report-modal';
        el.className = 'billing-report-modal hidden';
        el.innerHTML = `
<div class="billing-report-backdrop"></div>
<div class="billing-report-dialog" role="dialog" aria-modal="true">
  <h2 class="billing-report-title"></h2>
  <p class="billing-report-subtitle"></p>
  <div class="billing-report-meta"></div>
  <label class="billing-report-label">${escapeHtml(t('commercialization.report.category', 'Category'))}
    <input type="text" class="billing-report-category" maxlength="128">
  </label>
  <label class="billing-report-label">${escapeHtml(t('commercialization.report.ticket_ref', 'Ticket reference'))}
    <input type="text" class="billing-report-ticket" maxlength="128">
  </label>
  <label class="billing-report-label">${escapeHtml(t('commercialization.report.summary', 'Work performed'))} *
    <textarea class="billing-report-summary" rows="6" maxlength="8000" required></textarea>
  </label>
  <div class="billing-report-actions">
    <button type="button" class="btn btn-secondary billing-report-skip">${escapeHtml(t('commercialization.report.skip', 'Skip for now'))}</button>
    <button type="button" class="btn btn-primary billing-report-submit">${escapeHtml(t('commercialization.report.submit', 'Submit report'))}</button>
  </div>
  <p class="billing-report-error hidden"></p>
</div>`;
        document.body.appendChild(el);

        if (!document.getElementById('billing-report-styles')) {
            const style = document.createElement('style');
            style.id = 'billing-report-styles';
            style.textContent = `
.billing-report-modal{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center}
.billing-report-modal.hidden{display:none}
.billing-report-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.55)}
.billing-report-dialog{position:relative;z-index:1;width:min(520px,92vw);background:var(--surface-1,#fff);border-radius:10px;padding:1.25rem;box-shadow:0 12px 40px rgba(0,0,0,.25)}
.billing-report-title{margin:0 0 .25rem;font-size:1.15rem}
.billing-report-subtitle{margin:0 0 .75rem;color:var(--text-muted,#666);font-size:.9rem}
.billing-report-meta{font-size:.85rem;margin-bottom:.75rem;color:var(--text-muted,#666)}
.billing-report-label{display:block;margin-bottom:.65rem;font-size:.875rem}
.billing-report-label input,.billing-report-label textarea{width:100%;margin-top:.25rem;padding:.5rem;border:1px solid var(--border,#ccc);border-radius:6px;background:var(--surface-2,#fafafa);color:inherit}
.billing-report-actions{display:flex;gap:.5rem;justify-content:flex-end;margin-top:.75rem}
.billing-report-error{color:#b91c1c;font-size:.85rem;margin-top:.5rem}`;
            document.head.appendChild(style);
        }
        return el;
    }

    async function fetchPendingSession(deviceId) {
        const url = `/api/panel/billing/sessions/pending?device_id=${encodeURIComponent(deviceId)}`;
        const resp = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!resp.ok) return null;
        const data = await resp.json();
        return data.session || null;
    }

    async function submitReport(sessionId, payload) {
        const resp = await fetch(`/api/panel/billing/sessions/${encodeURIComponent(sessionId)}/report`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || resp.statusText);
    }

    function showModal(session, deviceName) {
        return new Promise((resolve) => {
            const modal = ensureModal();
            modal.querySelector('.billing-report-title').textContent = t('commercialization.report.title', 'Work report');
            modal.querySelector('.billing-report-subtitle').textContent = t('commercialization.report.subtitle', 'Describe the work performed during this remote session.');
            const mins = session.billed_minutes || 0;
            const amount = (session.amount_included || 0) + (session.amount_overage || 0);
            modal.querySelector('.billing-report-meta').textContent =
                `${deviceName || session.device_id} · ${mins} min · ${amount.toFixed(2)} ${session.currency || ''}`;

            const summaryEl = modal.querySelector('.billing-report-summary');
            const catEl = modal.querySelector('.billing-report-category');
            const ticketEl = modal.querySelector('.billing-report-ticket');
            const errEl = modal.querySelector('.billing-report-error');
            summaryEl.value = '';
            catEl.value = '';
            ticketEl.value = '';
            errEl.classList.add('hidden');

            const close = (result) => {
                modal.classList.add('hidden');
                resolve(result);
            };

            modal.querySelector('.billing-report-skip').onclick = () => close(false);
            modal.querySelector('.billing-report-backdrop').onclick = () => close(false);
            modal.querySelector('.billing-report-submit').onclick = async () => {
                const summary = summaryEl.value.trim();
                if (!summary) {
                    errEl.textContent = t('commercialization.report.summary_required', 'Summary is required');
                    errEl.classList.remove('hidden');
                    return;
                }
                try {
                    await submitReport(session.id, {
                        summary,
                        category: catEl.value.trim(),
                        ticket_ref: ticketEl.value.trim()
                    });
                    close(true);
                } catch (e) {
                    errEl.textContent = e.message || 'Error';
                    errEl.classList.remove('hidden');
                }
            };

            modal.classList.remove('hidden');
            summaryEl.focus();
        });
    }

    async function promptAfterSession(deviceId, deviceName) {
        if (!deviceId) return false;
        await sleep(1200);
        let session = null;
        for (let i = 0; i < 5; i++) {
            session = await fetchPendingSession(deviceId);
            if (session) break;
            await sleep(800);
        }
        if (!session) return false;
        return showModal(session, deviceName);
    }

    global.BillingReport = { promptAfterSession };
})(window);
