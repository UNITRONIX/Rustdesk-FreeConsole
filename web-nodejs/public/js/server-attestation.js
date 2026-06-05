/* server-attestation.js — Server Attestation benchmark UI */
'use strict';
(function () {
    const _ = window._ || (k => k);

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
        if (!tier) return _('server_attestation.tier_none', 'UNRATED');
        return _('server_attestation.tier_' + tier, tier.toUpperCase());
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
            connEl.textContent = maxConnections + ' ' + _('server_attestation.connections_short', 'conn.');
        } else if (connEl) {
            connEl.remove();
        }
    }

    function renderChart(steps) {
        const canvas = document.getElementById('sa-ramp-chart');
        if (!canvas || !steps || !steps.length) return;

        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = (rect.height || 200) * dpr;
        ctx.scale(dpr, dpr);
        const w = rect.width;
        const h = rect.height || 200;

        ctx.clearRect(0, 0, w, h);

        const maxConn = Math.max(...steps.map(s => s.connections || 0), 1);
        const pad = { l: 40, r: 16, t: 16, b: 28 };
        const plotW = w - pad.l - pad.r;
        const plotH = h - pad.t - pad.b;

        function x(i) {
            return pad.l + (i / Math.max(steps.length - 1, 1)) * plotW;
        }
        function yPct(v) {
            return pad.t + plotH - (Math.min(v, 100) / 100) * plotH;
        }
        function yConn(v) {
            return pad.t + plotH - (v / maxConn) * plotH;
        }

        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        for (let p = 0; p <= 4; p++) {
            const yy = pad.t + (plotH * p) / 4;
            ctx.beginPath();
            ctx.moveTo(pad.l, yy);
            ctx.lineTo(pad.l + plotW, yy);
            ctx.stroke();
        }

        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(255, 123, 114, 0.5)';
        const y80 = yPct(80);
        ctx.beginPath();
        ctx.moveTo(pad.l, y80);
        ctx.lineTo(pad.l + plotW, y80);
        ctx.stroke();
        ctx.setLineDash([]);

        function drawLine(key, color, yFn) {
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            steps.forEach((s, i) => {
                const px = x(i);
                const py = yFn(s[key] || 0);
                if (i === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            });
            ctx.stroke();
        }

        drawLine('cpu', '#ff7b72', yPct);
        drawLine('mem', '#79c0ff', yPct);
        drawLine('connections', '#56d364', yConn);
    }

    function applyResult(result) {
        if (!result) return;
        lastResult = result;

        updateBadge(result.tier, result.maxConnections);
        setText('sa-max-conn', result.maxConnections != null ? String(result.maxConnections) : '—');

        const detail = [];
        if (result.signalConnections != null) {
            detail.push(_('server_attestation.signal_peers', 'Signal peers') + ': ' + result.signalConnections);
        }
        if (result.relaySessions != null) {
            detail.push(_('server_attestation.relay_sessions', 'Relay sessions') + ': ' + result.relaySessions);
        }
        setText('sa-conn-detail', detail.join(' · '));

        if (result.finalMetrics) {
            setText('sa-th-cpu', result.finalMetrics.cpu + '%');
            setText('sa-th-mem', result.finalMetrics.mem + '%');
            setText('sa-th-disk', result.finalMetrics.disk + '%');
        }

        if (result.testedAt) {
            setText('sa-hero-meta', _('server_attestation.last_test', 'Last test') + ': ' + new Date(result.testedAt).toLocaleString());
        }

        if (result.rampSteps) renderChart(result.rampSteps);

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
        if (progress.rampSteps) renderChart(progress.rampSteps);
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
                    notify('success', _('server_attestation.complete', 'Benchmark complete'));
                }
            }
        } catch (err) {
            console.error('[ServerAttestation] poll error', err);
        }
    }

    async function runBenchmark() {
        const confirmed = window.confirm(_('server_attestation.confirm_run', 'This will load-test the server. Continue?'));
        if (!confirmed) return;

        setRunning(true);
        updateProgress({ phase: 'starting', message: _('server_attestation.starting', 'Starting…'), connections: 0 });

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

        window.addEventListener('resize', () => {
            if (lastResult && lastResult.rampSteps) renderChart(lastResult.rampSteps);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
