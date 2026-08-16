/* ===================================================================
   BetterDesk — Cross-Platform Compatibility  (frontend)
   =================================================================== */
(function () {
    'use strict';

    // ── Static data ─────────────────────────────────────────────────
    // Supported client builds: Windows, Linux, Android (+ web/ChromeOS notes). No Apple.
    const PLATFORMS = ['windows', 'linux_x86', 'linux_arm', 'android', 'web', 'chromeos'];

    // full = ✔ fully supported, partial = ◐ limited, none = ✖ not available, planned = ◎ planned
    const MATRIX = [
        { feature: 'cross_platform.feat_desktop_client',    vals: ['full','full','full','planned','partial','partial'] },
        { feature: 'cross_platform.feat_background_agent',  vals: ['full','full','full','partial','none','partial'] },
        { feature: 'cross_platform.feat_remote_target',     vals: ['full','full','partial','partial','partial','partial'] },
        { feature: 'cross_platform.feat_screen_capture',    vals: ['full','full','full','partial','partial','partial'] },
        { feature: 'cross_platform.feat_input_injection',   vals: ['full','full','full','partial','partial','none'] },
        { feature: 'cross_platform.feat_file_transfer',     vals: ['full','full','full','partial','partial','partial'] },
        { feature: 'cross_platform.feat_clipboard_sync',    vals: ['full','full','full','partial','partial','partial'] },
        { feature: 'cross_platform.feat_audio_streaming',   vals: ['full','full','partial','none','partial','none'] },
        { feature: 'cross_platform.feat_chat',              vals: ['full','full','full','full','full','full'] },
        { feature: 'cross_platform.feat_session_recording', vals: ['full','full','full','none','partial','none'] },
        { feature: 'cross_platform.feat_multi_monitor',     vals: ['full','full','full','partial','partial','none'] },
        { feature: 'cross_platform.feat_unattended_access', vals: ['full','full','full','partial','none','none'] },
        { feature: 'cross_platform.feat_h264',              vals: ['full','full','full','full','partial','full'] },
        { feature: 'cross_platform.feat_vp9',               vals: ['full','full','full','partial','partial','partial'] },
        { feature: 'cross_platform.feat_av1',               vals: ['partial','partial','none','none','partial','none'] },
        { feature: 'cross_platform.feat_cdap_agent',        vals: ['full','full','full','none','none','none'] },
    ];

    const LIMITATIONS = [
        { platform: 'windows', icon: 'desktop_windows', status: 'production', items: [
            'cross_platform.limit_win_uac',
            'cross_platform.limit_win_service',
            'cross_platform.limit_win_firewall',
            'cross_platform.limit_win_virtual_account'
        ]},
        { platform: 'linux', icon: 'computer', status: 'production', items: [
            'cross_platform.limit_linux_wayland',
            'cross_platform.limit_linux_pipewire',
            'cross_platform.limit_linux_arm',
            'cross_platform.limit_linux_unprivileged'
        ]},
        { platform: 'android', icon: 'phone_android', status: 'planned', items: [
            'cross_platform.limit_android_projection',
            'cross_platform.limit_android_accessibility',
            'cross_platform.limit_android_battery'
        ]},
        { platform: 'web', icon: 'language', status: 'production', items: [
            'cross_platform.limit_web_https',
            'cross_platform.limit_web_codec',
            'cross_platform.limit_web_performance'
        ]},
        { platform: 'chromeos', icon: 'laptop_chromebook', status: 'experimental', items: [
            'cross_platform.limit_chrome_crostini',
            'cross_platform.limit_chrome_pwa',
            'cross_platform.limit_chrome_input'
        ]},
    ];

    const BAR_COLORS = ['#58a6ff','#3fb950','#d29922','#a371f7','#79c0ff','#56d364'];

    // ── Helpers ──────────────────────────────────────────────────────
    function _(key) { return (typeof window._ === 'function') ? window._(key) : key.split('.').pop(); }

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    function statusIcon(val) {
        const map = { full: '✔', partial: '◐', none: '✖', planned: '◎' };
        return `<span class="cp-status ${val}" title="${_(('cross_platform.legend_' + val))}">${map[val] || '?'}</span>`;
    }

    function barHtml(label, value, max, color) {
        const pct = max > 0 ? Math.round((value / max) * 100) : 0;
        const safeLabel = escapeHtml(label);
        const safeColor = (typeof Utils !== 'undefined' && Utils.sanitizeColor)
            ? Utils.sanitizeColor(color) : color;
        return `<div class="cp-bar-row">
            <span class="cp-bar-label">${safeLabel}</span>
            <span class="cp-bar-track"><span class="cp-bar-fill" style="width:${pct}%;background:${safeColor}"></span></span>
            <span class="cp-bar-value">${value} (${pct}%)</span>
        </div>`;
    }

    // ── Tab switching ────────────────────────────────────────────────
    function switchTab(tab) {
        document.querySelectorAll('.crossplatform-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
        document.querySelectorAll('.crossplatform-panel').forEach(p => p.style.display = 'none');
        const panel = document.getElementById('panel-' + tab);
        if (panel) panel.style.display = 'block';

        const url = new URL(window.location);
        url.searchParams.set('tab', tab);
        history.replaceState(null, '', url);

        if (tab === 'distribution') loadDistribution();
        if (tab === 'protocols') loadProtocols();
    }

    // ── Matrix ───────────────────────────────────────────────────────
    function renderMatrix() {
        const tbody = document.getElementById('matrix-body');
        if (!tbody) return;
        tbody.innerHTML = MATRIX.map(row => {
            const featLabel = _(row.feature);
            const cells = row.vals.map(v => `<td>${statusIcon(v)}</td>`).join('');
            return `<tr><td>${featLabel}</td>${cells}</tr>`;
        }).join('');
    }

    // ── Distribution ─────────────────────────────────────────────────
    async function loadDistribution() {
        try {
            const resp = await fetch('/api/panel/cross-platform/distribution');
            if (!resp.ok) throw new Error(resp.statusText);
            const data = await resp.json();
            renderDistribution(data);
        } catch (e) {
            console.error('Distribution fetch error:', e);
        }
    }

    function renderDistribution(data) {
        // Platform bars
        const platEl = document.getElementById('platform-chart');
        if (platEl) {
            const entries = Object.entries(data.platforms || {}).sort((a, b) => b[1] - a[1]);
            platEl.innerHTML = entries.length
                ? entries.map((e, i) => barHtml(e[0], e[1], data.total, BAR_COLORS[i % BAR_COLORS.length])).join('')
                : `<p class="crossplatform-empty">${_('cross_platform.no_devices')}</p>`;
        }

        // Architecture bars
        const archEl = document.getElementById('arch-chart');
        if (archEl) {
            const entries = Object.entries(data.archs || {}).sort((a, b) => b[1] - a[1]);
            archEl.innerHTML = entries.length
                ? entries.map((e, i) => barHtml(e[0], e[1], data.total, BAR_COLORS[(i + 2) % BAR_COLORS.length])).join('')
                : `<p class="crossplatform-empty">${_('cross_platform.no_devices')}</p>`;
        }

        // Version bars
        const verEl = document.getElementById('version-chart');
        if (verEl) {
            const entries = Object.entries(data.versions || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
            verEl.innerHTML = entries.length
                ? entries.map((e, i) => barHtml(e[0], e[1], data.total, BAR_COLORS[(i + 4) % BAR_COLORS.length])).join('')
                : `<p class="crossplatform-empty">${_('cross_platform.no_devices')}</p>`;
        }

        // Summary
        const summaryEl = document.getElementById('summary-grid');
        if (summaryEl) {
            const platCount = Object.keys(data.platforms || {}).length;
            const archCount = Object.keys(data.archs || {}).length;
            const verCount = Object.keys(data.versions || {}).length;
            summaryEl.innerHTML = `
                <div class="cp-summary-item"><div class="cp-summary-value">${data.total || 0}</div><div class="cp-summary-label">${_('cross_platform.total_devices')}</div></div>
                <div class="cp-summary-item"><div class="cp-summary-value">${platCount}</div><div class="cp-summary-label">${_('cross_platform.unique_platforms')}</div></div>
                <div class="cp-summary-item"><div class="cp-summary-value">${archCount}</div><div class="cp-summary-label">${_('cross_platform.unique_archs')}</div></div>
                <div class="cp-summary-item"><div class="cp-summary-value">${verCount}</div><div class="cp-summary-label">${_('cross_platform.unique_versions')}</div></div>
            `;
        }
    }

    // ── Protocols ────────────────────────────────────────────────────
    async function loadProtocols() {
        try {
            const resp = await fetch('/api/panel/cross-platform/protocols');
            if (!resp.ok) throw new Error(resp.statusText);
            const data = await resp.json();
            renderProtocols(data);
        } catch (e) {
            console.error('Protocols fetch error:', e);
        }
        renderProtoDiagram();
    }

    function renderProtocols(data) {
        // Codec bars
        const codecEl = document.getElementById('codec-bars');
        const codecEmpty = document.getElementById('codec-empty');
        if (codecEl) {
            const entries = Object.entries(data.codecs || {}).sort((a, b) => b[1] - a[1]);
            if (entries.length) {
                codecEl.innerHTML = entries.map((e, i) => barHtml(e[0].toUpperCase(), e[1], data.totalOnline, BAR_COLORS[i % BAR_COLORS.length])).join('');
                if (codecEmpty) codecEmpty.style.display = 'none';
            } else {
                codecEl.innerHTML = '';
                if (codecEmpty) codecEmpty.style.display = 'block';
            }
        }

        // Feature bars
        const featEl = document.getElementById('feature-bars');
        const featEmpty = document.getElementById('feature-empty');
        if (featEl) {
            const entries = Object.entries(data.features || {}).sort((a, b) => b[1] - a[1]);
            if (entries.length) {
                featEl.innerHTML = entries.map((e, i) => barHtml(e[0], e[1], data.totalOnline, BAR_COLORS[(i + 3) % BAR_COLORS.length])).join('');
                if (featEmpty) featEmpty.style.display = 'none';
            } else {
                featEl.innerHTML = '';
                if (featEmpty) featEmpty.style.display = 'block';
            }
        }
    }

    function renderProtoDiagram() {
        const svg = document.getElementById('proto-svg');
        if (!svg) return;
        const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#e6edf3';
        const dimColor = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim() || '#8b949e';
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-blue').trim() || '#58a6ff';
        const borderC = getComputedStyle(document.documentElement).getPropertyValue('--border-primary').trim() || '#30363d';

        svg.innerHTML = `
            <!-- Client -->
            <rect x="20" y="70" width="140" height="60" rx="8" fill="none" stroke="${borderC}" stroke-width="1.5"/>
            <text x="90" y="96" fill="${textColor}" text-anchor="middle" font-size="13" font-weight="600">${_('cross_platform.diagram_client')}</text>
            <text x="90" y="114" fill="${dimColor}" text-anchor="middle" font-size="11">Capabilities</text>

            <!-- Arrow 1 -->
            <line x1="160" y1="100" x2="250" y2="100" stroke="${accent}" stroke-width="1.5" marker-end="url(#cpArrow)"/>
            <text x="205" y="90" fill="${dimColor}" text-anchor="middle" font-size="10">ClientCapabilities</text>

            <!-- Server -->
            <rect x="250" y="70" width="160" height="60" rx="8" fill="none" stroke="${accent}" stroke-width="1.5"/>
            <text x="330" y="96" fill="${textColor}" text-anchor="middle" font-size="13" font-weight="600">${_('cross_platform.diagram_server')}</text>
            <text x="330" y="114" fill="${dimColor}" text-anchor="middle" font-size="11">Negotiation</text>

            <!-- Arrow 2 -->
            <line x1="410" y1="100" x2="500" y2="100" stroke="${accent}" stroke-width="1.5" marker-end="url(#cpArrow)"/>
            <text x="455" y="90" fill="${dimColor}" text-anchor="middle" font-size="10">SessionConfig</text>

            <!-- Peer -->
            <rect x="500" y="70" width="140" height="60" rx="8" fill="none" stroke="${borderC}" stroke-width="1.5"/>
            <text x="570" y="96" fill="${textColor}" text-anchor="middle" font-size="13" font-weight="600">${_('cross_platform.diagram_peer')}</text>
            <text x="570" y="114" fill="${dimColor}" text-anchor="middle" font-size="11">Adapted stream</text>

            <!-- Marker -->
            <defs><marker id="cpArrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                <path d="M0,0 L8,3 L0,6" fill="${accent}"/>
            </marker></defs>
        `;
    }

    // ── Limitations ──────────────────────────────────────────────────
    function renderLimitations() {
        const grid = document.getElementById('limitations-grid');
        if (!grid) return;
        grid.innerHTML = LIMITATIONS.map(lim => {
            const items = lim.items.map(k => `<li>${_(k)}</li>`).join('');
            return `<div class="cp-limit-card">
                <div class="cp-limit-header">
                    <div class="cp-limit-icon ${lim.platform}">
                        <span class="material-icons">${lim.icon}</span>
                    </div>
                    <span class="cp-limit-name">${_(('cross_platform.platform_' + lim.platform))}</span>
                    <span class="cp-limit-status ${lim.status}">${_(('cross_platform.status_' + lim.status))}</span>
                </div>
                <ul class="cp-limit-list">${items}</ul>
            </div>`;
        }).join('');
    }

    // ── Init ─────────────────────────────────────────────────────────
    function init() {
        renderMatrix();
        renderLimitations();

        // Load data for active tab
        const active = document.querySelector('.crossplatform-tab.active');
        if (active) {
            const tab = active.dataset.tab;
            if (tab === 'distribution') loadDistribution();
            if (tab === 'protocols') loadProtocols();
        }
    }

    document.addEventListener('DOMContentLoaded', init);

    window.CrossPlatform = { switchTab };
})();
