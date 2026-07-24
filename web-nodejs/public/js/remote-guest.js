/**
 * Guest Access Link — mini RdClient device list (allowlist only).
 * No quick-connect, no plus, no Console links.
 */
(function () {
    'use strict';

    function t(key, fallback) {
        try {
            if (window.i18n && typeof window.i18n.t === 'function') {
                return window.i18n.t(key) || fallback || key;
            }
        } catch (_) { /* ignore */ }
        return fallback || key;
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function connectUrl(deviceId) {
        const token = window.__guestToken || '';
        const q = new URLSearchParams();
        if (token) q.set('guest', token);
        return '/remote/' + encodeURIComponent(deviceId) + '?' + q.toString();
    }

    function render(meta) {
        const loading = document.getElementById('rd-guest-loading');
        const grid = document.getElementById('rd-guest-grid');
        const empty = document.getElementById('rd-guest-empty');
        const err = document.getElementById('rd-guest-error');
        const expiry = document.getElementById('rd-guest-expiry');
        const banner = document.getElementById('rd-guest-banner');
        const labelEl = document.getElementById('rd-guest-label');

        if (loading) loading.hidden = true;

        if (!meta || !Array.isArray(meta.devices)) {
            if (err) {
                err.hidden = false;
                err.textContent = t('guest_access.expired', 'This guest link is invalid or expired.');
            }
            return;
        }

        if (meta.label && banner && labelEl) {
            banner.style.display = '';
            labelEl.textContent = meta.label;
        }

        if (meta.expires_at && expiry) {
            try {
                const d = new Date(meta.expires_at);
                expiry.textContent = t('guest_access.expires', 'Expires') + ': ' + d.toLocaleString();
            } catch (_) {
                expiry.textContent = meta.expires_at;
            }
        }

        if (!meta.devices.length) {
            if (empty) empty.hidden = false;
            return;
        }

        if (!grid) return;
        grid.hidden = false;
        grid.innerHTML = meta.devices.map(function (d) {
            const name = d.display_name || d.hostname || d.id;
            const online = !!d.online;
            const statusClass = online ? 'online' : 'offline';
            return (
                '<article class="rd-desk-card' + (online ? '' : ' rd-desk-card-offline') + '" data-id="' + esc(d.id) + '">' +
                '<div class="rd-desk-card-body">' +
                '<div class="rd-desk-card-name" title="' + esc(name) + '">' + esc(name) + '</div>' +
                '<div class="rd-desk-card-id">' + esc(d.id) + '</div>' +
                '</div>' +
                '<div class="rd-desk-card-footer">' +
                '<span class="rd-desk-status-dot ' + statusClass + '"></span>' +
                '<button type="button" class="rd-desk-btn rd-guest-connect" data-id="' + esc(d.id) + '">' +
                '<span class="material-icons">play_arrow</span> ' + esc(t('remote_dashboard.connect', 'Connect')) +
                '</button>' +
                '</div></article>'
            );
        }).join('');

        grid.querySelectorAll('.rd-guest-connect').forEach(function (btn) {
            btn.addEventListener('click', function () {
                const id = btn.getAttribute('data-id');
                if (!id) return;
                window.location.href = connectUrl(id);
            });
        });
    }

    document.addEventListener('DOMContentLoaded', function () {
        render(window.__guestAccess || {});
    });
})();
