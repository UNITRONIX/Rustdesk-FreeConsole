/* =========================================================================
   Agent Generator (Phase 1: panel + preview + bundle CRUD)
   Build artifacts not yet produced; /api/d/.../download returns 503.
   ========================================================================= */

(function () {
    'use strict';

    const t = (k, def) => {
        const tr = window.t ? window.t(k) : k;
        return (tr && tr !== k) ? tr : (def != null ? def : k);
    };
    const notify = window.Notifications || { success: console.log, error: console.error, warning: console.warn, info: console.info };
    const csrf = () => (window.BetterDesk && window.BetterDesk.csrfToken) || '';

    async function api(method, url, body) {
        const headers = { 'Accept': 'application/json' };
        const writeMethods = method === 'POST' || method === 'PUT' || method === 'PATCH';
        if (writeMethods) headers['Content-Type'] = 'application/json';
        if (method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = csrf();
        const opts = { method, headers, credentials: 'same-origin' };
        if (body !== undefined) {
            opts.body = JSON.stringify(body);
        } else if (writeMethods) {
            opts.body = '{}';
        }
        const res = await fetch(url, opts);
        const ct = (res.headers.get('content-type') || '');
        const data = ct.includes('application/json') ? await res.json() : null;
        if (!res.ok || (data && data.success === false)) {
            const err = new Error((data && data.error) || `HTTP ${res.status}`);
            err.data = data;
            err.status = res.status;
            throw err;
        }
        return data;
    }

    const state = {
        bundles: [],
        currentId: null,
        currentBundle: null,
        currentBuilds: [],
        platformLabels: {},
        dirty: false,
        previewTimer: null,
        buildsPollTimer: null,
    };

    const $ = (id) => document.getElementById(id);
    const els = {};

    function cacheEls() {
        ['gen-new-bundle', 'gen-bundle-list', 'gen-editor-title', 'gen-revoke-btn', 'gen-delete-btn', 'gen-save-btn',
         'gen-rebuild-btn', 'gen-builds-list', 'gen-builds-summary',
         'gen-empty-state', 'gen-editor-form',
         'gen-name', 'gen-company', 'gen-short-text', 'gen-email', 'gen-phone', 'gen-url',
         'gen-server-host', 'gen-use-https', 'gen-token-mask',
         'gen-logo', 'gen-logo-clear', 'gen-primary', 'gen-accent', 'gen-bg', 'gen-surface', 'gen-text', 'gen-text-muted', 'gen-status-ready', 'gen-header-text', 'gen-lang', 'gen-unattended',
         'gen-download-info', 'gen-download-url', 'gen-copy-link', 'gen-open-link',
         'gen-preview', 'gen-prev-body-logo', 'gen-prev-name', 'gen-prev-text', 'gen-prev-pw-row', 'gen-prev-contact',
         'gen-validation-errors'
        ].forEach(id => { els[id] = $(id); });
    }

    const DEFAULT_BRANDING = {
        company_name: '',
        short_text: '',
        contact_email: '',
        contact_phone: '',
        contact_url: '',
        logo_data_url: '',
        primary_color: '#2563eb',
        accent_color:  '#1e293b',
        background_color: '#0f172a',
        surface_color: '#1e293b',
        text_color: '#e2e8f0',
        text_muted_color: '#94a3b8',
        status_ready_color: '#22c55e',
        header_text_color: '#ffffff',
        allow_unattended: false,
        default_lang: 'en',
        server_host: '',
        use_https: true,
    };

    let logoDataUrl = '';
    let connectionDefaults = { server_host: '', use_https: true };

    function readBranding() {
        return {
            company_name: els['gen-company'].value.trim(),
            short_text:   els['gen-short-text'].value.trim(),
            contact_email: els['gen-email'].value.trim(),
            contact_phone: els['gen-phone'].value.trim(),
            contact_url:   els['gen-url'].value.trim(),
            logo_data_url: logoDataUrl,
            primary_color: els['gen-primary'].value,
            accent_color:  els['gen-accent'].value,
            background_color: els['gen-bg'].value,
            surface_color: els['gen-surface'].value,
            text_color: els['gen-text'].value,
            text_muted_color: els['gen-text-muted'].value,
            status_ready_color: els['gen-status-ready'].value,
            header_text_color: els['gen-header-text'].value,
            allow_unattended: !!els['gen-unattended'].checked,
            default_lang: els['gen-lang'].value,
            server_host: els['gen-server-host'].value.trim(),
            use_https: !!els['gen-use-https'].checked,
        };
    }

    function writeBranding(b) {
        b = Object.assign({}, DEFAULT_BRANDING, connectionDefaults, b || {});
        els['gen-server-host'].value = b.server_host || b.server?.address?.replace(/^https?:\/\//, '').split(':')[0] || '';
        els['gen-use-https'].checked = b.use_https ?? (b.server?.address?.startsWith('https://') ?? true);
        if (els['gen-token-mask']) {
            els['gen-token-mask'].value = t('generator.enrollment_per_device', 'Per device — approve in Registrations');
        }
        els['gen-company'].value = b.company_name || '';
        els['gen-short-text'].value = b.short_text || '';
        els['gen-email'].value = b.contact_email || '';
        els['gen-phone'].value = b.contact_phone || '';
        els['gen-url'].value   = b.contact_url || '';
        els['gen-primary'].value = b.primary_color || '#2563eb';
        els['gen-accent'].value  = b.accent_color  || '#1e293b';
        els['gen-bg'].value = b.background_color || '#0f172a';
        els['gen-surface'].value = b.surface_color || '#1e293b';
        els['gen-text'].value = b.text_color || '#e2e8f0';
        els['gen-text-muted'].value = b.text_muted_color || '#94a3b8';
        els['gen-status-ready'].value = b.status_ready_color || '#22c55e';
        els['gen-header-text'].value = b.header_text_color || '#ffffff';
        els['gen-unattended'].checked = !!b.allow_unattended;
        els['gen-lang'].value = b.default_lang || 'en';
        logoDataUrl = b.logo_data_url || '';
        els['gen-logo'].value = '';
        els['gen-logo-clear'].classList.toggle('hidden', !logoDataUrl);
    }

    function escapeText(s) {
        const d = document.createElement('div');
        d.textContent = String(s == null ? '' : s);
        return d.innerHTML;
    }

    function renderPreview() {
        const b = readBranding();
        const frame = els['gen-preview'].querySelector('.agent-preview-frame');
        if (frame) {
            frame.style.setProperty('--brand-primary', b.primary_color);
            frame.style.setProperty('--brand-accent',  b.accent_color);
            frame.style.setProperty('--brand-bg', b.background_color || '#0f172a');
            frame.style.setProperty('--brand-surface', b.surface_color || '#1e293b');
            frame.style.setProperty('--brand-text', b.text_color || '#e2e8f0');
            frame.style.setProperty('--brand-text-muted', b.text_muted_color || '#94a3b8');
            frame.style.setProperty('--brand-status-ready', b.status_ready_color || '#22c55e');
            frame.style.setProperty('--brand-header-text', b.header_text_color || '#ffffff');
        }
        const logoEl = els['gen-prev-body-logo'];
        if (b.logo_data_url) {
            logoEl.innerHTML = `<img src="${escapeText(b.logo_data_url)}" alt="">`;
        } else {
            logoEl.innerHTML = '<span class="material-icons">support_agent</span>';
        }
        els['gen-prev-name'].textContent = b.company_name || t('generator.preview_default_name', 'BetterDesk Support');
        els['gen-prev-text'].textContent = b.short_text || '';
        els['gen-prev-pw-row'].classList.toggle('hidden', !b.allow_unattended);
        const parts = [];
        if (b.contact_email) parts.push(b.contact_email);
        if (b.contact_phone) parts.push(b.contact_phone);
        if (b.contact_url)   parts.push(b.contact_url);
        els['gen-prev-contact'].textContent = parts.join(' • ');
    }

    function schedulePreview() {
        if (state.previewTimer) clearTimeout(state.previewTimer);
        state.previewTimer = setTimeout(renderPreview, 60);
    }

    function markDirty() {
        state.dirty = true;
        els['gen-save-btn'].disabled = false;
        schedulePreview();
    }

    function fmtDate(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        return d.toLocaleDateString();
    }

    function platformKey(p, a, f) {
        return `${p}/${a}/${f}`;
    }

    function platformLabel(p, a, f) {
        return state.platformLabels[platformKey(p, a, f)]
            || `${p} ${a} ${f}`;
    }

    function statusLabel(status) {
        const map = {
            ready: t('generator.build_status_ready', 'Ready'),
            pending: t('generator.build_status_pending', 'Queued'),
            building: t('generator.build_status_building', 'Building'),
            failed: t('generator.build_status_failed', 'Failed'),
        };
        return map[status] || status;
    }

    function summarizeBuilds(builds) {
        const counts = { ready: 0, pending: 0, building: 0, failed: 0 };
        for (const b of builds || []) {
            if (counts[b.status] != null) counts[b.status]++;
        }
        return counts;
    }

    function buildsNeedPoll(builds) {
        return (builds || []).some(b => b.status === 'pending' || b.status === 'building');
    }

    function stopBuildsPoll() {
        if (state.buildsPollTimer) {
            clearInterval(state.buildsPollTimer);
            state.buildsPollTimer = null;
        }
    }

    function scheduleBuildsPoll() {
        stopBuildsPoll();
        if (!state.currentId || state.currentId === 'new') return;
        if (!buildsNeedPoll(state.currentBuilds)) return;
        state.buildsPollTimer = setInterval(() => {
            refreshBuilds().catch(() => {});
        }, 5000);
    }

    function renderBuilds(builds) {
        state.currentBuilds = builds || [];
        const listEl = els['gen-builds-list'];
        const summaryEl = els['gen-builds-summary'];
        if (!listEl) return;

        if (!builds || !builds.length) {
            listEl.innerHTML = `<p class="text-muted">${escapeText(t('generator.builds_empty', 'No builds queued yet'))}</p>`;
            summaryEl.classList.add('hidden');
            stopBuildsPoll();
            return;
        }

        const counts = summarizeBuilds(builds);
        summaryEl.textContent = t('generator.builds_summary', '{{ready}} ready · {{pending}} queued · {{building}} building · {{failed}} failed')
            .replace('{{ready}}', counts.ready)
            .replace('{{pending}}', counts.pending)
            .replace('{{building}}', counts.building)
            .replace('{{failed}}', counts.failed);
        summaryEl.classList.remove('hidden');

        const rows = [...builds].sort((a, b) => {
            const la = platformLabel(a.platform, a.arch, a.format);
            const lb = platformLabel(b.platform, b.arch, b.format);
            return la.localeCompare(lb);
        });

        listEl.innerHTML = `
            <table class="builds-table">
                <thead>
                    <tr>
                        <th>${escapeText(t('generator.builds_title', 'Client builds'))}</th>
                        <th>${escapeText(t('common.status', 'Status'))}</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map(b => {
                        const err = b.error_message ? `<div class="build-error" title="${escapeText(b.error_message)}">${escapeText(b.error_message)}</div>` : '';
                        return `
                            <tr class="build-row build-row--${escapeText(b.status)}">
                                <td>${escapeText(platformLabel(b.platform, b.arch, b.format))}${err}</td>
                                <td><span class="build-badge build-badge--${escapeText(b.status)}">${escapeText(statusLabel(b.status))}</span></td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        `;

        scheduleBuildsPoll();
    }

    async function refreshBuilds() {
        if (!state.currentId || state.currentId === 'new') return;
        const res = await api('GET', `/api/generator/bundles/${encodeURIComponent(state.currentId)}`);
        if (res && res.data && res.data.bundle) {
            state.currentBundle = res.data.bundle;
            renderBuilds(res.data.bundle.builds || []);
        }
    }

    async function rebuildAllBuilds() {
        if (!state.currentBundle || state.currentId === 'new') return;
        if (!confirm(t('generator.rebuild_confirm', 'Rebuild all platform installers for this bundle?'))) return;
        const btn = els['gen-rebuild-btn'];
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `<span class="material-icons spinning">sync</span> ${escapeText(t('generator.rebuilding_all', 'Queuing rebuilds…'))}`;
        }
        try {
            const res = await api('POST', `/api/generator/bundles/${encodeURIComponent(state.currentId)}/rebuild`);
            notify.success(t('generator.rebuild_queued', 'All platform builds queued'));
            renderBuilds((res && res.data && res.data.builds) || []);
        } catch (e) {
            notify.error(e.message);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = `<span class="material-icons">sync</span> ${escapeText(t('generator.rebuild_all', 'Rebuild all'))}`;
            }
        }
    }

    function renderBundleList() {
        const root = els['gen-bundle-list'];
        if (!state.bundles.length) {
            root.innerHTML = `<p class="text-muted">${escapeText(t('generator.no_bundles', 'No bundles yet'))}</p>`;
            return;
        }
        root.innerHTML = '';
        state.bundles.forEach(bundle => {
            const item = document.createElement('div');
            item.className = 'bundle-item';
            if (bundle.bundle_id === state.currentId) item.classList.add('active');
            item.dataset.bundleId = bundle.bundle_id;
            const revokedBadge = bundle.revoked
                ? `<span class="badge-revoked">${escapeText(t('generator.revoked', 'Revoked'))}</span>`
                : '';
            item.innerHTML = `
                <div class="bundle-item-title">
                    ${escapeText(bundle.name || bundle.bundle_id)}
                    ${revokedBadge}
                </div>
                <div class="bundle-item-meta">
                    <span>${escapeText(fmtDate(bundle.created_at))}</span>
                    <span>↓ ${bundle.download_count || 0}</span>
                </div>
            `;
            item.addEventListener('click', () => selectBundle(bundle.bundle_id));
            root.appendChild(item);
        });
    }

    async function loadBundles() {
        try {
            const res = await api('GET', '/api/generator/bundles');
            state.bundles = (res && res.data && res.data.bundles) || [];
            renderBundleList();
        } catch (e) {
            notify.error(e.message, t('generator.title', 'Generator'));
        }
    }

    function showEditor() {
        els['gen-empty-state'].classList.add('hidden');
        els['gen-editor-form'].classList.remove('hidden');
    }

    function hideEditor() {
        els['gen-empty-state'].classList.remove('hidden');
        els['gen-editor-form'].classList.add('hidden');
        els['gen-revoke-btn'].classList.add('hidden');
        els['gen-delete-btn'].classList.add('hidden');
        els['gen-download-info'].classList.add('hidden');
        els['gen-save-btn'].disabled = true;
    }

    function setEditorForNew() {
        state.currentId = 'new';
        state.currentBundle = null;
        state.currentBuilds = [];
        state.dirty = false;
        stopBuildsPoll();
        els['gen-editor-title'].innerHTML = `<span class="material-icons">add_circle</span> ${escapeText(t('generator.new_bundle', 'New bundle'))}`;
        els['gen-name'].value = '';
        writeBranding(DEFAULT_BRANDING);
        els['gen-revoke-btn'].classList.add('hidden');
        els['gen-delete-btn'].classList.add('hidden');
        els['gen-download-info'].classList.add('hidden');
        els['gen-save-btn'].disabled = false;
        clearErrors();
        showEditor();
        renderBundleList();
        renderPreview();
        els['gen-name'].focus();
    }

    function setEditorForBundle(bundle) {
        state.currentId = bundle.bundle_id;
        state.currentBundle = bundle;
        state.dirty = false;
        stopBuildsPoll();
        els['gen-editor-title'].innerHTML = `<span class="material-icons">edit</span> ${escapeText(bundle.name || bundle.bundle_id)}`;
        els['gen-name'].value = bundle.name || '';
        writeBranding(bundle.branding);
        els['gen-revoke-btn'].classList.remove('hidden');
        els['gen-revoke-btn'].innerHTML = bundle.revoked
            ? `<span class="material-icons">undo</span> ${escapeText(t('generator.unrevoke', 'Unrevoke'))}`
            : `<span class="material-icons">block</span> ${escapeText(t('generator.revoke', 'Revoke'))}`;
        els['gen-delete-btn'].classList.remove('hidden');
        els['gen-save-btn'].disabled = true;
        const url = `${window.location.origin}${bundle.download_url || '/d/' + bundle.bundle_id}`;
        els['gen-download-url'].value = url;
        els['gen-open-link'].href = url;
        els['gen-download-info'].classList.remove('hidden');
        renderBuilds(bundle.builds || []);
        clearErrors();
        showEditor();
        renderBundleList();
        renderPreview();
    }

    async function selectBundle(bundleId) {
        if (state.dirty && !confirm(t('generator.unsaved_confirm', 'Discard unsaved changes?'))) return;
        try {
            const res = await api('GET', `/api/generator/bundles/${encodeURIComponent(bundleId)}`);
            setEditorForBundle(res.data.bundle);
        } catch (e) {
            notify.error(e.message);
        }
    }

    function clearErrors() {
        els['gen-validation-errors'].classList.add('hidden');
        els['gen-validation-errors'].innerHTML = '';
    }

    function fmtError(key) {
        if (!key) return '';
        const translated = t(`generator.errors.${key}`, null);
        return translated || key;
    }

    function showErrors(errors) {
        if (!errors || !errors.length) { clearErrors(); return; }
        const items = errors.map(e => `<li>${escapeText(fmtError(e))}</li>`).join('');
        els['gen-validation-errors'].innerHTML = `
            <strong>${escapeText(t('generator.errors.validation_failed', 'Validation failed'))}</strong>
            <ul>${items}</ul>
        `;
        els['gen-validation-errors'].classList.remove('hidden');
    }

    async function saveBundle() {
        clearErrors();
        const payload = {
            name: els['gen-name'].value.trim(),
            branding: readBranding(),
        };
        if (!payload.name) {
            showErrors([t('generator.errors.name_required', 'Bundle name is required')]);
            return;
        }
        els['gen-save-btn'].disabled = true;
        try {
            let res;
            if (state.currentId === 'new') {
                res = await api('POST', '/api/generator/bundles', payload);
                notify.success(t('generator.created', 'Bundle created'));
            } else {
                res = await api('PUT', `/api/generator/bundles/${encodeURIComponent(state.currentId)}`, payload);
                notify.success(t('generator.saved', 'Bundle saved'));
            }
            await loadBundles();
            if (res && res.data && res.data.bundle) {
                setEditorForBundle(res.data.bundle);
            }
        } catch (e) {
            const errs = (e.data && e.data.errors) || [e.message];
            showErrors(errs);
            els['gen-save-btn'].disabled = false;
        }
    }

    async function toggleRevoke() {
        if (!state.currentBundle) return;
        const newState = !state.currentBundle.revoked;
        const confirmMsg = newState
            ? t('generator.confirm_revoke', 'Revoke this bundle? The download link will stop working.')
            : t('generator.confirm_unrevoke', 'Re-enable this bundle?');
        if (!confirm(confirmMsg)) return;
        try {
            const res = await api('POST', `/api/generator/bundles/${encodeURIComponent(state.currentId)}/revoke`, { revoked: newState });
            notify.success(newState ? t('generator.revoked_ok', 'Bundle revoked') : t('generator.unrevoked_ok', 'Bundle re-enabled'));
            await loadBundles();
            if (res && res.data && res.data.bundle) setEditorForBundle(res.data.bundle);
        } catch (e) {
            notify.error(e.message);
        }
    }

    async function deleteBundle() {
        if (!state.currentBundle) return;
        if (!confirm(t('generator.confirm_delete', 'Delete this bundle permanently? This cannot be undone.'))) return;
        try {
            await api('DELETE', `/api/generator/bundles/${encodeURIComponent(state.currentId)}`);
            notify.success(t('generator.deleted', 'Bundle deleted'));
            state.currentId = null;
            state.currentBundle = null;
            state.dirty = false;
            hideEditor();
            await loadBundles();
        } catch (e) {
            notify.error(e.message);
        }
    }

    function onLogoChange(ev) {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        if (!/^image\//.test(file.type)) {
            notify.error(t('generator.errors.logo_invalid', 'Logo must be an image file'));
            els['gen-logo'].value = '';
            return;
        }
        if (file.size > 256 * 1024) {
            notify.error(t('generator.errors.logo_too_large', 'Logo must be 256KB or smaller'));
            els['gen-logo'].value = '';
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            logoDataUrl = reader.result;
            els['gen-logo-clear'].classList.remove('hidden');
            markDirty();
        };
        reader.onerror = () => notify.error(t('generator.errors.logo_read_failed', 'Failed to read logo file'));
        reader.readAsDataURL(file);
    }

    function clearLogo() {
        logoDataUrl = '';
        els['gen-logo'].value = '';
        els['gen-logo-clear'].classList.add('hidden');
        markDirty();
    }

    function copyDownloadLink() {
        const url = els['gen-download-url'].value;
        if (!url) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(
                () => notify.success(t('generator.link_copied', 'Link copied')),
                () => fallbackCopy(url)
            );
        } else {
            fallbackCopy(url);
        }
    }

    function fallbackCopy(text) {
        els['gen-download-url'].select();
        try {
            document.execCommand('copy');
            notify.success(t('generator.link_copied', 'Link copied'));
        } catch (_) {
            notify.warning(t('generator.copy_failed', 'Could not copy automatically; please copy manually'));
        }
    }

    async function loadConnectionDefaults() {
        try {
            const res = await api('GET', '/api/generator/defaults');
            const d = (res && res.data) || {};
            connectionDefaults = {
                server_host: d.server_host || '',
                use_https: d.use_https !== false,
            };
        } catch (_) {
            connectionDefaults = { server_host: '', use_https: true };
        }
    }

    async function loadPlatformLabels() {
        try {
            const res = await api('GET', '/api/generator/platforms');
            const platforms = (res && res.data && res.data.platforms) || [];
            state.platformLabels = {};
            platforms.forEach(p => {
                state.platformLabels[platformKey(p.platform, p.arch, p.format)] = p.label;
            });
        } catch (_) {
            state.platformLabels = {};
        }
    }

    function bindEvents() {
        els['gen-new-bundle'].addEventListener('click', () => setEditorForNew());
        els['gen-save-btn'].addEventListener('click', saveBundle);
        els['gen-rebuild-btn'].addEventListener('click', rebuildAllBuilds);
        els['gen-revoke-btn'].addEventListener('click', toggleRevoke);
        els['gen-delete-btn'].addEventListener('click', deleteBundle);
        els['gen-logo'].addEventListener('change', onLogoChange);
        els['gen-logo-clear'].addEventListener('click', clearLogo);
        els['gen-copy-link'].addEventListener('click', copyDownloadLink);

        [         'gen-name', 'gen-company', 'gen-short-text', 'gen-email', 'gen-phone', 'gen-url',
         'gen-server-host', 'gen-use-https',
         'gen-primary', 'gen-accent', 'gen-bg', 'gen-surface', 'gen-text', 'gen-text-muted', 'gen-status-ready', 'gen-header-text', 'gen-lang', 'gen-unattended'
        ].forEach(id => {
            const el = els[id];
            if (!el) return;
            const evt = (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'color') ? 'change' : 'input';
            el.addEventListener(evt, markDirty);
        });
    }

    async function init() {
        cacheEls();
        if (!els['gen-bundle-list']) return;
        bindEvents();
        await loadConnectionDefaults();
        await loadPlatformLabels();
        loadBundles();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
