/**
 * BetterDesk Console — Help Requests Page
 *
 * Polls the BD-API for incoming help requests and renders them as cards.
 * Operators can accept, resolve, connect, or delete requests.
 */

'use strict';

(function () {
    // ---- State ----

    let requests = [];
    let activeFilter = '';
    let pollTimer = null;
    const POLL_INTERVAL = 5000;

    // ---- DOM refs ----

    const listEl = document.getElementById('hr-list');
    const emptyEl = document.getElementById('hr-empty');
    const statTotal = document.getElementById('stat-total');
    const statPending = document.getElementById('stat-pending');
    const statAccepted = document.getElementById('stat-accepted');
    const statResolved = document.getElementById('stat-resolved');

    const csrfToken = window.BetterDesk?.csrfToken || '';

    // ---- Helpers ----

    async function apiFetch(url, options = {}) {
        const headers = { 'Content-Type': 'application/json' };
        if (csrfToken) headers['x-csrf-token'] = csrfToken;
        const resp = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
        return resp.json();
    }

    function timeAgo(ts) {
        const diff = Date.now() - ts;
        const secs = Math.floor(diff / 1000);
        if (secs < 60) return secs + 's ago';
        const mins = Math.floor(secs / 60);
        if (mins < 60) return mins + 'm ago';
        const hours = Math.floor(mins / 60);
        if (hours < 24) return hours + 'h ago';
        return Math.floor(hours / 24) + 'd ago';
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ---- Fetch ----

    async function fetchRequests() {
        try {
            const data = await apiFetch('/api/help/requests');
            if (data.success && Array.isArray(data.requests)) {
                const prevCount = requests.filter(r => r.status === 'pending').length;
                requests = data.requests;
                const newCount = requests.filter(r => r.status === 'pending').length;

                if (newCount > prevCount) {
                    playNotificationSound();
                }

                render();
            }
        } catch (err) {
            console.error('[HelpRequests] Fetch error:', err);
        }
    }

    // ---- Notification ----

    function playNotificationSound() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = 880;
            osc.type = 'sine';
            gain.gain.setValueAtTime(0.3, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.5);
        } catch (_) {}
    }

    // ---- Actions ----

    async function acceptRequest(id) {
        try {
            const data = await apiFetch(`/api/help/requests/${encodeURIComponent(id)}/accept`, {
                method: 'POST',
            });
            if (data.success) await fetchRequests();
        } catch (err) {
            console.error('[HelpRequests] Accept error:', err);
        }
    }

    async function resolveRequest(id) {
        try {
            const data = await apiFetch(`/api/help/requests/${encodeURIComponent(id)}/resolve`, {
                method: 'POST',
            });
            if (data.success) await fetchRequests();
        } catch (err) {
            console.error('[HelpRequests] Resolve error:', err);
        }
    }

    async function deleteRequest(id) {
        if (!confirm('Delete this help request?')) return;
        try {
            const data = await apiFetch(`/api/help/requests/${encodeURIComponent(id)}/resolve`, {
                method: 'POST',
            });
            if (data.success) await fetchRequests();
        } catch (err) {
            console.error('[HelpRequests] Delete error:', err);
        }
    }

    function connectToDevice(deviceId) {
        // Open RustDesk URI to connect
        window.open(`rustdesk://${encodeURIComponent(deviceId)}`, '_blank');
    }

    // ---- Render ----

    function render() {
        // Update stats
        const pending = requests.filter(r => r.status === 'pending').length;
        const accepted = requests.filter(r => r.status === 'accepted').length;
        const resolved = requests.filter(r => r.status === 'resolved').length;

        statTotal.textContent = requests.length;
        statPending.textContent = pending;
        statAccepted.textContent = accepted;
        statResolved.textContent = resolved;

        // Filter
        const filtered = activeFilter
            ? requests.filter(r => r.status === activeFilter)
            : requests;

        if (filtered.length === 0) {
            emptyEl.style.display = '';
            // Remove cards but keep empty state
            listEl.querySelectorAll('.hr-card').forEach(c => c.remove());
            return;
        }

        emptyEl.style.display = 'none';

        // Remove old cards
        listEl.querySelectorAll('.hr-card').forEach(c => c.remove());

        for (const req of filtered) {
            const card = document.createElement('div');
            card.className = `hr-card status-${req.status}`;
            card.dataset.id = req.id;

            let actionsHtml = '';
            if (req.status === 'pending') {
                actionsHtml = `
                    <button class="btn btn-accept" data-action="accept" title="Accept">
                        <span class="material-icons" style="font-size:16px">check</span>
                    </button>
                    <button class="btn btn-connect" data-action="connect" title="Connect">
                        <span class="material-icons" style="font-size:16px">desktop_windows</span>
                    </button>
                `;
            } else if (req.status === 'accepted') {
                actionsHtml = `
                    <button class="btn btn-resolve" data-action="resolve" title="Resolve">
                        <span class="material-icons" style="font-size:16px">done_all</span>
                    </button>
                    <button class="btn btn-connect" data-action="connect" title="Connect">
                        <span class="material-icons" style="font-size:16px">desktop_windows</span>
                    </button>
                `;
            }

            card.innerHTML = `
                <div class="hr-card-body">
                    <div class="hr-card-header">
                        ${req.status === 'pending' ? '<span class="hr-notification-dot"></span>' : ''}
                        <span class="hr-device-id">${escapeHtml(req.device_id)}</span>
                        <span class="hr-hostname">${escapeHtml(req.hostname || '')}</span>
                        <span class="hr-status-badge ${req.status}">${escapeHtml(req.status)}</span>
                    </div>
                    <div class="hr-message">${escapeHtml(req.message || '')}</div>
                    <div class="hr-meta">
                        <span>${timeAgo(req.created_at)}</span>
                        ${req.accepted_by ? `<span>Accepted by ${escapeHtml(req.accepted_by)}</span>` : ''}
                        ${req.resolved_by ? `<span>Resolved by ${escapeHtml(req.resolved_by)}</span>` : ''}
                    </div>
                </div>
                <div class="hr-card-actions">
                    ${actionsHtml}
                    <button class="btn" data-action="delete" title="Delete">
                        <span class="material-icons" style="font-size:16px">delete</span>
                    </button>
                </div>
            `;

            listEl.appendChild(card);
        }
    }

    // ---- Event delegation ----

    listEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;

        const card = btn.closest('.hr-card');
        if (!card) return;

        const id = card.dataset.id;
        const action = btn.dataset.action;

        switch (action) {
            case 'accept': acceptRequest(id); break;
            case 'resolve': resolveRequest(id); break;
            case 'delete': deleteRequest(id); break;
            case 'connect': {
                const req = requests.find(r => r.id === id);
                if (req) connectToDevice(req.device_id);
                break;
            }
        }
    });

    // ---- Filter buttons ----

    document.querySelectorAll('.help-requests-page .filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.help-requests-page .filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeFilter = btn.dataset.status || '';
            render();
        });
    });

    // ---- Init ----

    fetchRequests();
    pollTimer = setInterval(fetchRequests, POLL_INTERVAL);

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        if (pollTimer) clearInterval(pollTimer);
    });
})();
