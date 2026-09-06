/* BetterDesk Console — Client Branding page */

(function () {
    'use strict';

    const t = (k, def) => {
        const tr = window.t ? window.t(k) : k;
        return (tr && tr !== k) ? tr : (def != null ? def : k);
    };
    const notify = window.Notifications || {
        success: console.log,
        error: console.error,
        warning: console.warn,
        info: console.info,
    };
    const csrf = () => (window.BetterDesk && window.BetterDesk.csrfToken) || '';

    const MAX_LOGO = 512 * 1024;
    const state = {
        logo: null,
        clearLogo: false,
        revision: '',
    };

    async function api(method, url, body) {
        const headers = { Accept: 'application/json' };
        const write = method === 'POST' || method === 'PUT' || method === 'PATCH';
        if (write) headers['Content-Type'] = 'application/json';
        if (method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = csrf();
        const opts = { method, headers, credentials: 'same-origin' };
        if (body !== undefined) opts.body = JSON.stringify(body);
        else if (write) opts.body = '{}';
        const res = await fetch(url, opts);
        const ct = res.headers.get('content-type') || '';
        const data = ct.includes('application/json') ? await res.json() : null;
        if (!res.ok || (data && data.success === false)) {
            throw new Error((data && data.error) || `HTTP ${res.status}`);
        }
        return data;
    }

    function $(id) {
        return document.getElementById(id);
    }

    function normalizeColor(raw) {
        const v = String(raw || '').trim();
        if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return v;
        return '#4f6ef7';
    }

    function syncAccentInputs(fromPicker) {
        const picker = $('cb-accent-picker');
        const text = $('cb-accent');
        if (!picker || !text) return;
        if (fromPicker) {
            text.value = picker.value;
        } else {
            const c = normalizeColor(text.value);
            text.value = c;
            picker.value = c.length === 4
                ? '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]
                : c;
        }
        updatePreview();
    }

    function contactLines() {
        const parts = [];
        const phone = ($('cb-phone')?.value || '').trim();
        const email = ($('cb-email')?.value || '').trim();
        const website = ($('cb-website')?.value || '').trim();
        const support = ($('cb-support')?.value || '').trim();
        if (phone) parts.push(phone);
        if (email) parts.push(email);
        if (website) parts.push(website);
        if (support) parts.push(support);
        return parts;
    }

    function updatePreview() {
        const company = ($('cb-company')?.value || '').trim() || 'BetterDesk';
        const accent = normalizeColor($('cb-accent')?.value);
        const companyEl = $('cb-preview-company');
        const contactEl = $('cb-preview-contact');
        const pane = $('cb-preview-bd');
        if (companyEl) companyEl.textContent = company;
        if (contactEl) contactEl.textContent = contactLines().join(' · ');
        if (pane) pane.style.setProperty('--cb-accent', accent);

        const logoImg = $('cb-preview-logo');
        const fallback = $('cb-preview-logo-fallback');
        const src = state.logo && state.logo.data_base64
            ? `data:${state.logo.mime};base64,${state.logo.data_base64}`
            : (state.logo && state.logo.url ? state.logo.url : '');
        if (logoImg && fallback) {
            if (src && !state.clearLogo) {
                logoImg.src = src;
                logoImg.hidden = false;
                fallback.hidden = true;
            } else {
                logoImg.removeAttribute('src');
                logoImg.hidden = true;
                fallback.hidden = false;
            }
        }

        const rd = {};
        if (company && company.toLowerCase() !== 'betterdesk') {
            rd['display-name'] = company;
        }
        const rdEl = $('cb-preview-rd');
        if (rdEl) {
            rdEl.textContent = JSON.stringify({ config_options: rd }, null, 2);
        }
        const rev = $('cb-revision');
        if (rev) {
            rev.textContent = state.revision
                ? `${t('client_branding.revision', 'Revision')}: ${state.revision}`
                : '';
        }
    }

    function fillForm(data) {
        data = data || {};
        $('cb-company').value = data.company_name || '';
        $('cb-phone').value = data.phone || '';
        $('cb-email').value = data.email || '';
        $('cb-website').value = data.website || '';
        $('cb-support').value = data.support_contact || '';
        $('cb-accent').value = data.accent_color || '#4f6ef7';
        state.revision = data.revision || '';
        state.clearLogo = false;
        state.logo = data.logo || null;
        syncAccentInputs(false);
        updatePreview();
    }

    function readFileAsLogo(file) {
        return new Promise((resolve, reject) => {
            if (!file) return resolve(null);
            if (file.size <= 0 || file.size > MAX_LOGO) {
                return reject(new Error(t('client_branding.logo_too_large', 'Logo must be at most 512 KiB')));
            }
            const mime = (file.type || '').toLowerCase();
            if (!['image/png', 'image/jpeg', 'image/jpg', 'image/webp'].includes(mime)) {
                return reject(new Error(t('client_branding.logo_invalid', 'Invalid logo format')));
            }
            const reader = new FileReader();
            reader.onload = () => {
                const result = String(reader.result || '');
                const comma = result.indexOf(',');
                const dataBase64 = comma >= 0 ? result.slice(comma + 1) : result;
                resolve({ mime: mime === 'image/jpg' ? 'image/jpeg' : mime, data_base64: dataBase64 });
            };
            reader.onerror = () => reject(new Error(t('client_branding.logo_invalid', 'Invalid logo format')));
            reader.readAsDataURL(file);
        });
    }

    async function load() {
        const result = await api('GET', '/api/client-branding');
        fillForm(result.data || {});
    }

    async function save() {
        const payload = {
            company_name: ($('cb-company')?.value || '').trim(),
            phone: ($('cb-phone')?.value || '').trim(),
            email: ($('cb-email')?.value || '').trim(),
            website: ($('cb-website')?.value || '').trim(),
            support_contact: ($('cb-support')?.value || '').trim(),
            accent_color: normalizeColor($('cb-accent')?.value),
        };
        if (state.clearLogo) payload.clear_logo = true;
        else if (state.logo && (state.logo.data_base64 || state.logo.url)) {
            payload.logo = state.logo;
        }
        const result = await api('POST', '/api/client-branding', payload);
        const branding = (result.data && result.data.branding) || result.data || {};
        if (result.revision) branding.revision = result.revision;
        if (result.data && result.data.revision) branding.revision = result.data.revision;
        fillForm(branding);
        notify.success(t('client_branding.saved', 'Client branding saved'));
    }

    function bind() {
        ['cb-company', 'cb-phone', 'cb-email', 'cb-website', 'cb-support'].forEach((id) => {
            $(id)?.addEventListener('input', updatePreview);
        });
        $('cb-accent')?.addEventListener('input', () => syncAccentInputs(false));
        $('cb-accent-picker')?.addEventListener('input', () => syncAccentInputs(true));
        $('cb-logo-file')?.addEventListener('change', async (ev) => {
            const file = ev.target.files && ev.target.files[0];
            try {
                const logo = await readFileAsLogo(file);
                if (logo) {
                    state.logo = logo;
                    state.clearLogo = false;
                    updatePreview();
                }
            } catch (err) {
                notify.error(err.message);
                ev.target.value = '';
            }
        });
        $('cb-clear-logo')?.addEventListener('click', () => {
            state.logo = null;
            state.clearLogo = true;
            const input = $('cb-logo-file');
            if (input) input.value = '';
            updatePreview();
        });
        $('cb-save')?.addEventListener('click', async () => {
            try {
                await save();
            } catch (err) {
                notify.error(err.message || t('client_branding.save_failed', 'Save failed'));
            }
        });
    }

    document.addEventListener('DOMContentLoaded', async () => {
        bind();
        try {
            await load();
        } catch (err) {
            notify.error(err.message || t('client_branding.load_failed', 'Failed to load branding'));
            updatePreview();
        }
    });
})();
