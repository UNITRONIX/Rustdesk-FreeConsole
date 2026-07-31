/**
 * BetterDesk Console - Keys Page
 */

(function() {
    'use strict';

    const _ = window._ || (k => k);
    const PUBLIC_KEY_MASK = '••••••••••••••••••••••••';

    let rawPublicKey = '';
    let publicKeyVisible = false;

    document.addEventListener('DOMContentLoaded', init);

    function init() {
        loadPublicKey();
        loadQRCode();
        loadServerInfo();

        document.getElementById('copy-key-btn')?.addEventListener('click', copyPublicKey);
        document.getElementById('reveal-key-btn')?.addEventListener('click', togglePublicKeyVisibility);
        document.getElementById('download-key-btn')?.addEventListener('click', downloadKey);
        document.getElementById('show-qr-btn')?.addEventListener('click', showQRModal);

        window.addEventListener('app:refresh', () => {
            loadPublicKey();
            loadQRCode();
            loadServerInfo();
        });
    }

    /**
     * Load public key (masked by default)
     */
    async function loadPublicKey() {
        const keyText = document.getElementById('public-key-text');
        if (!keyText) return;

        try {
            const data = await Utils.api('/api/keys/public');
            rawPublicKey = (data.key || '').trim();
            renderPublicKeyField(false, rawPublicKey ? null : _('keys.no_key'));
        } catch (error) {
            rawPublicKey = '';
            renderPublicKeyField(false, _('errors.load_key_failed'));
        }
    }

    function renderPublicKeyField(visible, errorText) {
        const keyText = document.getElementById('public-key-text');
        const revealBtn = document.getElementById('reveal-key-btn');
        if (!keyText) return;

        publicKeyVisible = Boolean(visible && rawPublicKey);

        if (errorText) {
            keyText.textContent = errorText;
            keyText.classList.remove('is-masked');
            keyText.removeAttribute('data-raw');
            if (revealBtn) revealBtn.disabled = true;
            syncPublicKeyRevealButton();
            return;
        }

        if (!rawPublicKey) {
            keyText.textContent = _('keys.no_key');
            keyText.classList.remove('is-masked');
            keyText.removeAttribute('data-raw');
            if (revealBtn) revealBtn.disabled = true;
            syncPublicKeyRevealButton();
            return;
        }

        keyText.dataset.raw = rawPublicKey;
        if (publicKeyVisible) {
            keyText.textContent = rawPublicKey;
            keyText.classList.remove('is-masked');
        } else {
            keyText.textContent = PUBLIC_KEY_MASK;
            keyText.classList.add('is-masked');
        }
        if (revealBtn) revealBtn.disabled = false;
        syncPublicKeyRevealButton();
    }

    function syncPublicKeyRevealButton() {
        const revealBtn = document.getElementById('reveal-key-btn');
        if (!revealBtn) return;
        const icon = revealBtn.querySelector('.material-icons');
        const label = publicKeyVisible ? _('actions.hide_value') : _('actions.show_value');
        revealBtn.title = label;
        revealBtn.setAttribute('aria-label', `${label} ${_('keys.public_key')}`);
        revealBtn.setAttribute('aria-pressed', publicKeyVisible ? 'true' : 'false');
        if (icon) icon.textContent = publicKeyVisible ? 'visibility_off' : 'visibility';
    }

    function togglePublicKeyVisibility() {
        if (!rawPublicKey) return;
        renderPublicKeyField(!publicKeyVisible);
    }

    /**
     * Load QR code
     */
    async function loadQRCode() {
        const qrWrapper = document.getElementById('qr-wrapper');
        if (!qrWrapper) return;

        try {
            const data = await Utils.api('/api/keys/public/qr');
            if (data && data.qr) {
                qrWrapper.innerHTML = `<img src="${data.qr}" alt="QR Code" style="width:200px;height:200px;">`;
            } else {
                throw new Error('No QR data');
            }
        } catch (error) {
            console.error('QR load error:', error);
            qrWrapper.innerHTML = `<div style="width:200px;height:200px;display:flex;align-items:center;justify-content:center;background:var(--bg-tertiary);color:var(--text-secondary);border-radius:8px;">${_('errors.load_qr_failed')}</div>`;
        }
    }

    /**
     * Load server info
     */
    async function loadServerInfo() {
        try {
            const data = await Utils.api('/api/keys/server-info');

            const serverIpEl = document.getElementById('server-ip');
            const relayIpEl = document.getElementById('relay-ip');
            const apiKeyEl = document.getElementById('api-key');

            if (serverIpEl) serverIpEl.textContent = data.server_id || window.location.hostname || '-';
            if (relayIpEl) relayIpEl.textContent = data.relay_server || window.location.hostname || '-';
            if (apiKeyEl) apiKeyEl.textContent = data.api_key_masked || '-';

        } catch (error) {
            console.error('Failed to load server info:', error);
            const hostname = window.location.hostname;
            const serverIpEl = document.getElementById('server-ip');
            const relayIpEl = document.getElementById('relay-ip');
            if (serverIpEl) serverIpEl.textContent = hostname || '-';
            if (relayIpEl) relayIpEl.textContent = hostname || '-';
        }
    }

    /**
     * Copy public key to clipboard (raw value even when masked)
     */
    async function copyPublicKey() {
        const copyBtn = document.getElementById('copy-key-btn');
        const key = rawPublicKey.trim();
        if (!key) {
            Notifications.warning(_('keys.no_key_to_copy'));
            return;
        }

        await Utils.copyToClipboard(key);
        copyBtn?.classList.add('copied');
        setTimeout(() => copyBtn?.classList.remove('copied'), 2000);
        Notifications.success(_('common.copied'));
    }

    /**
     * Download key file
     */
    async function downloadKey() {
        try {
            const response = await fetch('/api/keys/download');
            const blob = await response.blob();

            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'id_ed25519.pub';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);

            Notifications.success(_('keys.download_success'));
        } catch (error) {
            Notifications.error(_('errors.download_failed'));
        }
    }

    /**
     * Show QR code in modal
     */
    function showQRModal() {
        const qrWrapper = document.getElementById('qr-wrapper');
        const qrImg = qrWrapper?.querySelector('img');

        if (!qrImg) {
            Notifications.warning(_('keys.no_qr'));
            return;
        }

        Modal.show({
            title: _('keys.qr_code'),
            content: `
                <div style="text-align:center;">
                    <div style="background:white;padding:20px;display:inline-block;border-radius:8px;">
                        <img src="${qrImg.src}" alt="QR Code" width="300" height="300">
                    </div>
                    <p style="margin-top:16px;color:var(--text-secondary);">${_('keys.qr_hint')}</p>
                </div>
            `,
            buttons: [
                { label: _('actions.close'), class: 'btn-secondary', onClick: () => Modal.close() }
            ],
            size: 'medium'
        });
    }

})();
