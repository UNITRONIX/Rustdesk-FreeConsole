(function () {
    'use strict';

    var LANGS = [
        ['', 'System default'],
        ['en', 'English'],
        ['pl', 'Polski'],
        ['de', 'Deutsch'],
        ['fr', 'Français'],
        ['es', 'Español'],
        ['it', 'Italiano'],
        ['pt', 'Português'],
        ['nl', 'Nederlands'],
        ['cs', 'Čeština'],
        ['da', 'Dansk'],
        ['fi', 'Suomi'],
        ['nb', 'Norsk'],
        ['sv', 'Svenska'],
        ['ro', 'Română'],
        ['hu', 'Magyar'],
        ['uk', 'Українська'],
        ['ru', 'Русский'],
        ['tr', 'Türkçe'],
        ['ar', 'العربية'],
        ['hi', 'हिन्दी'],
        ['ja', '日本語'],
        ['ko', '한국어'],
        ['zh', '简体中文'],
        ['zh-TW', '繁體中文'],
        ['vi', 'Tiếng Việt'],
        ['th', 'ไทย'],
        ['id', 'Bahasa Indonesia']
    ];

    var urlInput = document.getElementById('server-url');
    var urlStatus = document.getElementById('url-status');
    var serverMeta = document.getElementById('server-meta');
    var tlsCheckbox = document.getElementById('tls-strict');
    var langSelect = document.getElementById('ui-lang');

    function status(el, msg, kind) {
        if (!el) return;
        el.textContent = msg || '';
        el.className = 'status' + (kind ? ' ' + kind : '');
    }

    async function invoke(cmd, args) {
        if (!window.__TAURI__ || !window.__TAURI__.core || !window.__TAURI__.core.invoke) {
            throw new Error('Desktop bridge unavailable');
        }
        return window.__TAURI__.core.invoke(cmd, args || {});
    }

    function fillLangSelect(selected) {
        if (!langSelect) return;
        langSelect.innerHTML = '';
        LANGS.forEach(function (pair) {
            var opt = document.createElement('option');
            opt.value = pair[0];
            opt.textContent = pair[1];
            if (pair[0] === (selected || '')) opt.selected = true;
            langSelect.appendChild(opt);
        });
    }

    async function loadConfig() {
        try {
            var cfg = await invoke('get_config');
            if (urlInput && cfg.server_url) urlInput.value = cfg.server_url;
            if (tlsCheckbox) tlsCheckbox.checked = !!cfg.tls_strict;
            fillLangSelect(cfg.ui_lang || '');
            if (cfg.server_url) {
                var probe = await invoke('probe_server_url', { url: cfg.server_url });
                if (probe && probe.ok && serverMeta) {
                    var parts = [];
                    if (probe.panel_name) parts.push(probe.panel_name);
                    if (probe.version) parts.push('v' + probe.version);
                    serverMeta.textContent = parts.join(' · ');
                }
            }
        } catch (e) {
            status(urlStatus, String(e), 'error');
        }
    }

    document.getElementById('save-url-btn').addEventListener('click', async function () {
        var url = (urlInput.value || '').trim();
        if (!url) {
            status(urlStatus, 'Enter a panel URL.', 'error');
            return;
        }
        status(urlStatus, 'Validating…', '');
        try {
            await invoke('set_server_url', { url: url });
            status(urlStatus, 'Saved. Reconnecting…', 'ok');
        } catch (e) {
            status(urlStatus, String(e), 'error');
        }
    });

    document.getElementById('save-tls-btn').addEventListener('click', async function () {
        try {
            await invoke('set_tls_strict', { strict: !!tlsCheckbox.checked });
            status(urlStatus, 'TLS setting saved. Restart may be required for existing connections.', 'ok');
        } catch (e) {
            status(urlStatus, String(e), 'error');
        }
    });

    if (langSelect) {
        langSelect.addEventListener('change', async function () {
            try {
                await invoke('set_ui_lang', { lang: langSelect.value || null });
            } catch (_) { /* ignore */ }
        });
    }

    document.getElementById('sign-out-btn').addEventListener('click', async function () {
        if (!confirm('Sign out from the panel on this device?')) return;
        try {
            await invoke('sign_out');
        } catch (e) {
            status(urlStatus, String(e), 'error');
        }
    });

    document.getElementById('reset-btn').addEventListener('click', async function () {
        if (!confirm('Reset RdClient? This removes the server URL and all saved data on this device.')) return;
        try {
            await invoke('reset_client');
        } catch (e) {
            status(urlStatus, String(e), 'error');
        }
    });

    loadConfig();
})();
