(function () {
    'use strict';

    var form = document.getElementById('setup-form');
    var input = document.getElementById('server-url');
    var errorEl = document.getElementById('error');
    var submitBtn = document.getElementById('submit-btn');
    var listEl = document.getElementById('discovered-list');
    var emptyEl = document.getElementById('discovered-empty');
    var refreshBtn = document.getElementById('refresh-btn');
    var lastAppearanceUrl = '';

    function showError(msg) {
        if (errorEl) errorEl.textContent = msg || '';
    }

    async function getInvoke() {
        if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
            return window.__TAURI__.core.invoke.bind(window.__TAURI__.core);
        }
        return null;
    }

    function normalizeBaseUrl(url) {
        var raw = String(url || '').trim();
        if (!raw) return '';
        if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
        try {
            var parsed = new URL(raw);
            return parsed.origin;
        } catch (_) {
            return '';
        }
    }

    function safeColor(value, fallback) {
        var v = String(value || '').trim();
        return /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
    }

    function applyBackgroundSizeMode(target, size) {
        var mode = String(size || 'cover').trim();
        if (['cover', 'contain', 'auto', 'center', 'repeat'].indexOf(mode) === -1) mode = 'cover';
        target.style.backgroundSize = (mode === 'cover' || mode === 'contain') ? mode : 'auto';
        target.style.backgroundRepeat = mode === 'repeat' ? 'repeat' : 'no-repeat';
        target.style.backgroundPosition = mode === 'repeat' ? 'top left' : 'center';
    }

    function applyAppearancePayload(payload, baseUrl) {
        var data = payload && (payload.data || payload.appearance || payload);
        if (!data || typeof data !== 'object') return;
        var palette = data.palette || {};
        var root = document.documentElement;
        root.style.setProperty('--bg', safeColor(palette.background, '#0d1117'));
        root.style.setProperty('--panel', safeColor(palette.surface, '#161b22'));
        root.style.setProperty('--border', safeColor(palette.border, '#30363d'));
        root.style.setProperty('--text', safeColor(palette.text, '#e6edf3'));
        root.style.setProperty('--muted', safeColor(palette.muted, '#8b949e'));
        root.style.setProperty('--accent', safeColor(palette.primary, '#58a6ff'));
        root.style.setProperty('--error', safeColor(palette.danger, '#f85149'));

        var identity = data.identity || {};
        if (identity.appName) {
            document.title = identity.appName + ' RdClient — Setup';
            var title = document.querySelector('h1');
            if (title) title.textContent = identity.appName + ' RdClient';
        }

        var bg = data.background || {};
        var card = document.querySelector('.card');
        if (bg.type === 'image' && bg.imageUrl && baseUrl) {
            var absolute = new URL(bg.imageUrl, baseUrl).toString();
            document.body.style.backgroundImage = 'linear-gradient(rgba(0,0,0,.55), rgba(0,0,0,.55)), url("' + absolute.replace(/"/g, '%22') + '")';
            document.body.style.backgroundColor = '';
            applyBackgroundSizeMode(document.body, bg.size);
            if (card) card.style.backdropFilter = 'blur(18px)';
        } else if (bg.type === 'gradient' && bg.gradient) {
            document.body.style.backgroundImage = bg.gradient;
            document.body.style.backgroundColor = '';
            document.body.style.backgroundSize = 'cover';
            document.body.style.backgroundRepeat = 'no-repeat';
            document.body.style.backgroundPosition = 'center';
        } else if (bg.type === 'color' && bg.color) {
            document.body.style.backgroundImage = 'none';
            document.body.style.backgroundColor = safeColor(bg.color, 'var(--bg)');
            document.body.style.backgroundSize = '';
            document.body.style.backgroundRepeat = '';
            document.body.style.backgroundPosition = '';
        }
    }

    async function loadAppearanceForUrl(url) {
        var baseUrl = normalizeBaseUrl(url);
        if (!baseUrl || baseUrl === lastAppearanceUrl) return;
        lastAppearanceUrl = baseUrl;
        try {
            var res = await fetch(baseUrl + '/api/bd/appearance', { credentials: 'omit', cache: 'no-store' });
            if (!res.ok) return;
            applyAppearancePayload(await res.json(), baseUrl);
        } catch (_) { /* first-run setup must work without appearance */ }
    }

    async function connectUrl(url) {
        var invoke = await getInvoke();
        if (!invoke) {
            showError('Desktop bridge unavailable.');
            return;
        }
        submitBtn.disabled = true;
        if (refreshBtn) refreshBtn.disabled = true;
        showError('');
        try {
            var probe = await invoke('probe_server_url', { url: url });
            if (!probe || !probe.ok) {
                showError((probe && probe.error) || 'Server did not respond as a BetterDesk panel.');
                submitBtn.disabled = false;
                if (refreshBtn) refreshBtn.disabled = false;
                return;
            }
            await loadAppearanceForUrl(probe.normalized_url || url);
            await invoke('set_server_url', { url: probe.normalized_url || url });
        } catch (err) {
            showError(String(err) || 'Failed to save server URL.');
            submitBtn.disabled = false;
            if (refreshBtn) refreshBtn.disabled = false;
        }
    }

    function renderDiscovered(servers) {
        if (!listEl) return;
        listEl.innerHTML = '';
        if (!servers || !servers.length) {
            var li = document.createElement('li');
            li.className = 'empty-hint';
            li.textContent = 'No servers found on the local network.';
            listEl.appendChild(li);
            return;
        }
        servers.forEach(function (s) {
            var li = document.createElement('li');
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.innerHTML = '<span class="discovered-name">' + escapeHtml(s.name || s.url) + '</span>'
                + '<span class="discovered-url">' + escapeHtml(s.url) + '</span>';
            btn.addEventListener('click', function () {
                if (input) input.value = s.url;
                loadAppearanceForUrl(s.url);
                connectUrl(s.url);
            });
            li.appendChild(btn);
            listEl.appendChild(li);
        });
    }

    function escapeHtml(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    async function scanNetwork() {
        var invoke = await getInvoke();
        if (!invoke) {
            if (emptyEl) emptyEl.textContent = 'Discovery unavailable.';
            return;
        }
        if (emptyEl) emptyEl.textContent = 'Scanning…';
        try {
            var servers = await invoke('discover_servers');
            renderDiscovered(servers || []);
        } catch (_) {
            renderDiscovered([]);
        }
    }

    form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var url = (input.value || '').trim();
        if (!url) {
            showError('Please enter a panel URL.');
            return;
        }
        connectUrl(url);
    });

    if (refreshBtn) {
        refreshBtn.addEventListener('click', function () { scanNetwork(); });
    }

    getInvoke().then(function (invoke) {
        if (!invoke) return;
        invoke('get_server_url').then(function (existing) {
            if (existing && input) input.value = existing;
            if (existing) loadAppearanceForUrl(existing);
        }).catch(function () { /* ignore */ });
        scanNetwork();
    });

    if (input) {
        input.addEventListener('blur', function () {
            loadAppearanceForUrl(input.value);
        });
    }
})();
