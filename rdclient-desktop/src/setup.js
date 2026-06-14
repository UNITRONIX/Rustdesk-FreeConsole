(function () {
    'use strict';

    var form = document.getElementById('setup-form');
    var input = document.getElementById('server-url');
    var errorEl = document.getElementById('error');
    var submitBtn = document.getElementById('submit-btn');

    function showError(msg) {
        if (errorEl) errorEl.textContent = msg || '';
    }

    async function getInvoke() {
        if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
            return window.__TAURI__.core.invoke.bind(window.__TAURI__.core);
        }
        return null;
    }

    form.addEventListener('submit', async function (e) {
        e.preventDefault();
        showError('');
        var url = (input.value || '').trim();
        if (!url) {
            showError('Please enter a panel URL.');
            return;
        }

        var invoke = await getInvoke();
        if (!invoke) {
            showError('Desktop bridge unavailable.');
            return;
        }

        submitBtn.disabled = true;
        try {
            await invoke('set_server_url', { url: url });
        } catch (err) {
            showError(String(err) || 'Failed to save server URL.');
            submitBtn.disabled = false;
        }
    });

    getInvoke().then(function (invoke) {
        if (!invoke) return;
        invoke('get_server_url').then(function (existing) {
            if (existing && input) input.value = existing;
        }).catch(function () { /* ignore */ });
    });
})();
