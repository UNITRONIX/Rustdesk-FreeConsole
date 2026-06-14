(function () {
    'use strict';

    var form = document.getElementById('setup-form');
    var input = document.getElementById('server-url');
    var errorEl = document.getElementById('error');
    var submitBtn = document.getElementById('submit-btn');
    var listEl = document.getElementById('discovered-list');
    var emptyEl = document.getElementById('discovered-empty');
    var refreshBtn = document.getElementById('refresh-btn');

    function showError(msg) {
        if (errorEl) errorEl.textContent = msg || '';
    }

    async function getInvoke() {
        if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
            return window.__TAURI__.core.invoke.bind(window.__TAURI__.core);
        }
        return null;
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
        }).catch(function () { /* ignore */ });
        scanNetwork();
    });
})();
