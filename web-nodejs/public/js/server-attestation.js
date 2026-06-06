/* server-attestation.js — Server Attestation benchmark UI */
'use strict';
(function () {
    const _ = window._ || (k => k);

    function tr(key, fallback) {
        const v = _(key);
        return (v && v !== key) ? v : fallback;
    }

    let pollTimer = null;
    let lastResult = null;

    function csrfHeaders(extra) {
        const h = Object.assign({}, extra || {});
        const token = (window.BetterDesk && window.BetterDesk.csrfToken) || '';
        if (token) h['x-csrf-token'] = token;
        return h;
    }

    function notify(level, message) {
        if (!message) return;
        if (window.Notifications && typeof window.Notifications[level] === 'function') {
            window.Notifications[level](message);
            return;
        }
        if (window.Toast && typeof window.Toast[level] === 'function') {
            window.Toast[level]('', message);
            return;
        }
    }

    function setText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    function tierLabel(tier) {
        if (!tier) return tr('server_attestation.tier_none', 'UNRATED');
        return tr('server_attestation.tier_' + tier, tier.toUpperCase());
    }

    function updateBadge(tier, maxConnections) {
        const hero = document.querySelector('.sa-hero .bd-attest-badge');
        if (!hero) return;
        hero.className = 'bd-attest-badge bd-attest-badge--large ' + (tier ? ('bd-attest-tier-' + tier) : 'bd-attest-tier-none');
        const tierEl = hero.querySelector('.bd-attest-tier');
        if (tierEl) tierEl.textContent = tierLabel(tier);
        let connEl = hero.querySelector('.bd-attest-conn');
        if (maxConnections) {
            if (!connEl) {
                connEl = document.createElement('div');
                connEl.className = 'bd-attest-conn';
                hero.appendChild(connEl);
            }
            connEl.textContent = maxConnections + ' ' + tr('server_attestation.connections_short', 'conn.');
        } else if (connEl) {
            connEl.remove();
        }
    }

    function applyResult(result) {
        if (!result) return;
        lastResult = result;

        updateBadge(result.tier, result.maxConnections);
        setText('sa-max-conn', result.maxConnections != null ? String(result.maxConnections) : '—');

        const detail = [];
        if (result.signalConnections != null) {
            detail.push(tr('server_attestation.signal_peers', 'Signal peers') + ': ' + result.signalConnections);
        }
        if (result.relaySessions != null) {
            detail.push(tr('server_attestation.relay_sessions', 'Relay sessions') + ': ' + result.relaySessions);
        }
        setText('sa-conn-detail', detail.join(' · '));

        if (result.finalMetrics) {
            setText('sa-th-cpu', result.finalMetrics.cpu + '%');
            setText('sa-th-mem', result.finalMetrics.mem + '%');
            setText('sa-th-disk', result.finalMetrics.disk + '%');
        }

        if (result.testedAt) {
            let meta = tr('server_attestation.last_test', 'Last test') + ': ' + new Date(result.testedAt).toLocaleString();
            if (result.mode === 'estimated') {
                meta += ' · ' + tr('server_attestation.mode_estimated', 'Estimated (WebSocket unreachable)');
            }
            setText('sa-hero-meta', meta);
        }

        const dlBtn = document.getElementById('sa-download-btn');
        if (dlBtn) dlBtn.disabled = false;
    }

    function setRunning(running) {
        const runBtn = document.getElementById('sa-run-btn');
        const abortBtn = document.getElementById('sa-abort-btn');
        const progress = document.getElementById('sa-progress');
        if (runBtn) runBtn.disabled = running;
        if (abortBtn) abortBtn.classList.toggle('hidden', !running);
        if (progress) progress.classList.toggle('hidden', !running);
    }

    function updateProgress(progress) {
        if (!progress) return;
        const fill = document.getElementById('sa-progress-fill');
        const text = document.getElementById('sa-progress-text');
        let pct = 10;
        if (progress.phase === 'baseline') pct = 15;
        else if (progress.phase === 'ramp-up') {
            pct = 20 + Math.min(60, (progress.connections || 0) / 5);
        } else if (progress.phase === 'stabilize') pct = 85;
        else if (progress.phase === 'done') pct = 100;
        if (fill) fill.style.width = pct + '%';
        if (text) text.textContent = progress.message || progress.phase || '';
    }

    async function pollStatus() {
        try {
            const res = await fetch('/api/server-attestation/status', { credentials: 'same-origin' });
            const data = await res.json();
            if (!data.success) return;

            setRunning(data.running);
            if (data.progress) updateProgress(data.progress);

            if (!data.running) {
                clearInterval(pollTimer);
                pollTimer = null;
                const result = data.lastResult || (data.progress && data.progress.result);
                if (result) {
                    applyResult(result);
                    if (result.valid) {
                        notify('success', tr('server_attestation.complete', 'Benchmark complete'));
                    } else {
                        notify('warning', tr('server_attestation.incomplete', 'Benchmark finished without a valid tier'));
                    }
                }
            }
        } catch (err) {
            console.error('[ServerAttestation] poll error', err);
        }
    }

    async function runBenchmark() {
        const confirmed = window.confirm(tr('server_attestation.confirm_run', 'This will load-test the server. Continue?'));
        if (!confirmed) return;

        setRunning(true);
        updateProgress({ phase: 'starting', message: tr('server_attestation.starting', 'Starting…'), connections: 0 });

        try {
            const res = await fetch('/api/server-attestation/run', {
                method: 'POST',
                credentials: 'same-origin',
                headers: csrfHeaders({ 'Content-Type': 'application/json' })
            });
            const data = await res.json();
            if (!data.success) {
                notify('error', data.error || 'Failed to start');
                setRunning(false);
                return;
            }
            pollTimer = setInterval(pollStatus, 2000);
            pollStatus();
        } catch (err) {
            notify('error', err.message);
            setRunning(false);
        }
    }

    async function abortBenchmark() {
        try {
            await fetch('/api/server-attestation/abort', {
                method: 'POST',
                credentials: 'same-origin',
                headers: csrfHeaders({ 'Content-Type': 'application/json' })
            });
        } catch (_) { /* ignore */ }
    }

    function downloadReport() {
        if (!lastResult) return;
        const blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'betterdesk-server-attestation-' + (lastResult.testedAt || Date.now()) + '.json';
        a.click();
        URL.revokeObjectURL(url);
    }

    async function init() {
        document.getElementById('sa-run-btn')?.addEventListener('click', runBenchmark);
        document.getElementById('sa-abort-btn')?.addEventListener('click', abortBenchmark);
        document.getElementById('sa-download-btn')?.addEventListener('click', downloadReport);

        try {
            const res = await fetch('/api/server-attestation/status', { credentials: 'same-origin' });
            const data = await res.json();
            if (data.lastResult) applyResult(data.lastResult);
            if (data.running) {
                setRunning(true);
                pollTimer = setInterval(pollStatus, 2000);
            }
        } catch (_) { /* ignore */ }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
