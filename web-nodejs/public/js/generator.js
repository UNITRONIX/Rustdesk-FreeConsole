/* =========================================================================
   BetterDesk Support Generator
   Module install gate + simple custom.txt template bundles.
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
        const headers = { Accept: 'application/json' };
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
        platforms: [],
        selectedPlatforms: new Set(),
        dirty: false,
        slugManual: false,
        buildsPollTimer: null,
        moduleReady: false,
        moduleStatus: null,
        productType: 'betterdesk-support',
    };

    const $ = (id) => document.getElementById(id);
    const els = {};

    function cacheEls() {
        [
            'gen-module-gate', 'gen-module-status', 'gen-accept-terms', 'gen-install-module',
            'gen-finish-install', 'gen-main',
            'gen-new-support', 'gen-bundle-list', 'gen-editor-title', 'gen-revoke-btn', 'gen-delete-btn',
            'gen-save-btn', 'gen-rebuild-btn', 'gen-builds-list', 'gen-builds-summary', 'gen-platforms',
            'gen-empty-state', 'gen-editor-form',
            'gen-name', 'gen-slug', 'gen-app-name',
            'gen-server-host', 'gen-relay-host', 'gen-use-https', 'gen-api-port', 'gen-public-key',
            'gen-download-info', 'gen-download-url', 'gen-copy-link', 'gen-open-link',
            'gen-validation-errors',
        ].forEach((id) => { els[id] = $(id); });
    }

    let connectionDefaults = {
        server_host: '',
        relay_host: '',
        use_https: true,
        api_port: '21114',
        public_key: '',
        app_name: 'BetterDesk Support Agent',
    };

    const SLUG_TRANSLIT = {
        ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z',
        ä: 'a', ö: 'o', ü: 'u', ß: 'ss', æ: 'ae', ø: 'o', å: 'a',
        č: 'c', ď: 'd', ě: 'e', ň: 'n', ř: 'r', š: 's', ť: 't', ů: 'u', ý: 'y', ž: 'z',
    };

    function slugifyName(name) {
        let slug = String(name || '').trim().toLowerCase().split('').map((ch) => SLUG_TRANSLIT[ch] ?? ch).join('');
        slug = slug.replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        if (slug.length > 32) slug = slug.slice(0, 32).replace(/-$/, '');
        return slug;
    }

    function readSlugInput() {
        return (els['gen-slug'] && els['gen-slug'].value || '').trim().toLowerCase();
    }

    function updateDownloadLinkPreview() {
        const slug = readSlugInput();
        if (!els['gen-download-url']) return;
        if (state.currentId === 'new') {
            const url = slug ? `${window.location.origin}/d/${slug}` : '';
            els['gen-download-url'].value = url;
            if (els['gen-open-link']) {
                els['gen-open-link'].href = url || '#';
                els['gen-open-link'].classList.toggle('disabled', !url);
            }
            return;
        }
        if (state.currentBundle) {
            const publicId = slug || state.currentBundle.public_id || state.currentBundle.slug || state.currentBundle.bundle_id;
            const url = `${window.location.origin}/d/${publicId}`;
            els['gen-download-url'].value = url;
            if (els['gen-open-link']) {
                els['gen-open-link'].href = url;
                els['gen-open-link'].classList.remove('disabled');
            }
        }
    }

    function syncSlugFromName() {
        if (state.slugManual || !els['gen-slug']) return;
        els['gen-slug'].value = slugifyName(els['gen-name'].value);
        updateDownloadLinkPreview();
    }

    function readBranding() {
        return {
            app_name: els['gen-app-name'].value.trim(),
            company_name: els['gen-app-name'].value.trim(),
            server_host: els['gen-server-host'].value.trim(),
            relay_host: els['gen-relay-host'].value.trim(),
            use_https: !!(els['gen-use-https'] && els['gen-use-https'].checked),
            api_port: els['gen-api-port'].value.trim(),
            public_key: els['gen-public-key'].value.trim(),
            disable_settings: true,
        };
    }

    function writeBranding(b) {
        b = Object.assign({}, connectionDefaults, b || {});
        els['gen-app-name'].value = b.app_name || b.company_name || connectionDefaults.app_name || '';
        els['gen-server-host'].value = b.server_host
            || (b.server?.address ? String(b.server.address).replace(/^https?:\/\//, '').split(':')[0] : '')
            || '';
        els['gen-relay-host'].value = b.relay_host || '';
        els['gen-use-https'].checked = b.use_https ?? connectionDefaults.use_https ?? true;
        els['gen-api-port'].value = b.api_port || connectionDefaults.api_port || '';
        els['gen-public-key'].value = b.public_key || b.server_key || b.server?.public_key || connectionDefaults.public_key || '';
    }

    function platformKey(p) {
        return `${p.platform}/${p.arch}/${p.format}`;
    }

    function renderPlatforms() {
        if (!els['gen-platforms']) return;
        els['gen-platforms'].innerHTML = state.platforms.map((p) => {
            const key = platformKey(p);
            const checked = state.selectedPlatforms.has(key) ? 'checked' : '';
            return `<label class="platform-check">
                <input type="checkbox" data-platform="${p.platform}" data-arch="${p.arch}" data-format="${p.format}" ${checked}>
                <span>${p.label || key}</span>
            </label>`;
        }).join('');
        els['gen-platforms'].querySelectorAll('input[type=checkbox]').forEach((input) => {
            input.addEventListener('change', () => {
                const key = `${input.dataset.platform}/${input.dataset.arch}/${input.dataset.format}`;
                if (input.checked) state.selectedPlatforms.add(key);
                else state.selectedPlatforms.delete(key);
                markDirty();
            });
        });
    }

    function selectedPlatformPayload() {
        return state.platforms.filter((p) => state.selectedPlatforms.has(platformKey(p)));
    }

    function selectAllPlatforms() {
        state.selectedPlatforms = new Set(state.platforms.map(platformKey));
        renderPlatforms();
    }

    function markDirty() {
        state.dirty = true;
        if (els['gen-save-btn']) els['gen-save-btn'].disabled = false;
    }

    function clearDirty() {
        state.dirty = false;
        if (els['gen-save-btn']) els['gen-save-btn'].disabled = true;
    }

    function showValidation(errors) {
        if (!els['gen-validation-errors']) return;
        if (!errors || !errors.length) {
            els['gen-validation-errors'].classList.add('hidden');
            els['gen-validation-errors'].innerHTML = '';
            return;
        }
        els['gen-validation-errors'].classList.remove('hidden');
        els['gen-validation-errors'].innerHTML = `<ul>${errors.map((e) => `<li>${escapeText(e)}</li>`).join('')}</ul>`;
    }

    function escapeText(s) {
        const d = document.createElement('div');
        d.textContent = String(s == null ? '' : s);
        return d.innerHTML;
    }

    function renderBundleList() {
        if (!els['gen-bundle-list']) return;
        if (!state.bundles.length) {
            els['gen-bundle-list'].innerHTML = `<p class="text-muted">${t('generator.no_bundles', 'No bundles yet')}</p>`;
            return;
        }
        els['gen-bundle-list'].innerHTML = state.bundles.map((b) => {
            const active = state.currentId === b.bundle_id ? 'active' : '';
            const revoked = b.revoked ? 'revoked' : '';
            return `<button type="button" class="bundle-item ${active} ${revoked}" data-id="${escapeText(b.bundle_id)}">
                <span class="bundle-item-name">${escapeText(b.name)}</span>
                <span class="bundle-item-meta">${escapeText(b.slug || b.public_id || '')}</span>
            </button>`;
        }).join('');
        els['gen-bundle-list'].querySelectorAll('.bundle-item').forEach((btn) => {
            btn.addEventListener('click', () => openBundle(btn.dataset.id));
        });
    }

    function buildStatusLabel(status) {
        const s = String(status || 'pending').toLowerCase();
        if (s === 'ready') return t('generator.build_ready', 'Ready');
        if (s === 'building') return t('generator.build_building', 'Building');
        if (s === 'queued' || s === 'pending') return t('generator.build_queued', 'Queued');
        if (s === 'failed') return t('generator.build_failed', 'Failed');
        return s;
    }

    function renderBuilds() {
        if (!els['gen-builds-list']) return;
        const builds = state.currentBuilds || [];
        if (!builds.length) {
            els['gen-builds-list'].innerHTML = `<p class="text-muted">${t('generator.builds_empty', 'No builds yet — save to queue platforms.')}</p>`;
            if (els['gen-builds-summary']) els['gen-builds-summary'].textContent = '';
            return;
        }
        const ready = builds.filter((b) => b.status === 'ready').length;
        if (els['gen-builds-summary']) {
            els['gen-builds-summary'].textContent = `${ready}/${builds.length} ready`;
        }
        els['gen-builds-list'].innerHTML = builds.map((b) => {
            const key = `${b.platform}/${b.arch}/${b.format}`;
            const label = (state.platforms.find((p) => platformKey(p) === key) || {}).label || key;
            const err = b.error_message ? `<div class="build-error">${escapeText(b.error_message)}</div>` : '';
            const retry = b.status === 'failed'
                ? `<button type="button" class="btn btn-sm btn-secondary gen-retry-build"
                    data-platform="${escapeText(b.platform)}" data-arch="${escapeText(b.arch)}" data-format="${escapeText(b.format)}">Retry</button>`
                : '';
            return `<div class="build-row status-${escapeText(b.status)}">
                <div class="build-row-main">
                    <span class="build-label">${escapeText(label)}</span>
                    <span class="build-status badge">${escapeText(buildStatusLabel(b.status))}</span>
                    ${retry}
                </div>
                ${err}
            </div>`;
        }).join('');
        els['gen-builds-list'].querySelectorAll('.gen-retry-build').forEach((btn) => {
            btn.addEventListener('click', async () => {
                if (!state.currentId || state.currentId === 'new') return;
                try {
                    const { platform, arch, format } = btn.dataset;
                    await api('POST', `/api/generator/bundles/${state.currentId}/rebuild/${platform}/${arch}/${format}`);
                    notify.success(t('generator.rebuild_queued', 'Rebuild queued'));
                    await refreshBuilds();
                } catch (err) {
                    notify.error(err.message);
                }
            });
        });
    }

    function setEditorVisible(show) {
        els['gen-empty-state'].classList.toggle('hidden', show);
        els['gen-editor-form'].classList.toggle('hidden', !show);
    }

    function setEditorForNew() {
        stopBuildsPoll();
        state.currentId = 'new';
        state.currentBundle = null;
        state.currentBuilds = [];
        state.slugManual = false;
        state.productType = 'betterdesk-support';
        setEditorVisible(true);
        els['gen-editor-title'].textContent = t('generator.new_bundle', 'New BetterDesk Support');
        els['gen-name'].value = '';
        els['gen-slug'].value = '';
        writeBranding(connectionDefaults);
        selectAllPlatforms();
        els['gen-download-info'].classList.add('hidden');
        els['gen-revoke-btn'].classList.add('hidden');
        els['gen-delete-btn'].classList.add('hidden');
        els['gen-rebuild-btn'].classList.add('hidden');
        showValidation([]);
        renderBuilds();
        markDirty();
        renderBundleList();
        updateDownloadLinkPreview();
    }

    async function openBundle(id) {
        try {
            const data = await api('GET', `/api/generator/bundles/${id}`);
            const bundle = data.data.bundle;
            state.currentId = bundle.bundle_id;
            state.currentBundle = bundle;
            state.currentBuilds = bundle.builds || [];
            state.slugManual = true;
            state.productType = 'betterdesk-support';
            setEditorVisible(true);
            els['gen-editor-title'].textContent = bundle.name;
            els['gen-name'].value = bundle.name || '';
            els['gen-slug'].value = bundle.slug || '';
            writeBranding(bundle.branding || {});
            selectAllPlatforms();
            els['gen-download-info'].classList.remove('hidden');
            els['gen-revoke-btn'].classList.remove('hidden');
            els['gen-delete-btn'].classList.remove('hidden');
            els['gen-rebuild-btn'].classList.remove('hidden');
            els['gen-revoke-btn'].textContent = bundle.revoked
                ? t('generator.unrevoke', 'Restore')
                : t('generator.revoke', 'Revoke');
            showValidation([]);
            clearDirty();
            renderBuilds();
            renderBundleList();
            updateDownloadLinkPreview();
            startBuildsPoll();
        } catch (err) {
            notify.error(err.message);
        }
    }

    async function saveBundle() {
        const name = els['gen-name'].value.trim();
        if (!name) {
            notify.error(t('generator.errors.name_required', 'Name is required'));
            return;
        }
        const payload = {
            name,
            slug: readSlugInput(),
            product_type: 'betterdesk-support',
            branding: readBranding(),
            platforms: selectedPlatformPayload(),
        };
        try {
            let data;
            if (state.currentId === 'new') {
                data = await api('POST', '/api/generator/bundles', payload);
            } else {
                data = await api('PUT', `/api/generator/bundles/${state.currentId}`, payload);
            }
            notify.success(t('generator.saved', 'Saved'));
            showValidation([]);
            await loadBundles();
            await openBundle(data.data.bundle.bundle_id);
        } catch (err) {
            const details = err.data && (err.data.details || err.data.errors);
            if (details) showValidation(details);
            notify.error(err.message);
        }
    }

    async function loadBundles() {
        const data = await api('GET', '/api/generator/bundles?includeRevoked=1');
        state.bundles = (data.data && data.data.bundles) || [];
        renderBundleList();
    }

    async function loadPlatforms() {
        const data = await api('GET', '/api/generator/platforms');
        state.platforms = (data.data && data.data.platforms) || [];
        selectAllPlatforms();
    }

    async function loadDefaults() {
        const data = await api('GET', '/api/generator/defaults');
        connectionDefaults = Object.assign(connectionDefaults, data.data || {});
    }

    async function refreshBuilds() {
        if (!state.currentId || state.currentId === 'new') return;
        try {
            const data = await api('GET', `/api/generator/bundles/${state.currentId}`);
            state.currentBuilds = (data.data.bundle && data.data.bundle.builds) || [];
            renderBuilds();
        } catch (_) { /* ignore poll errors */ }
    }

    function startBuildsPoll() {
        stopBuildsPoll();
        state.buildsPollTimer = setInterval(refreshBuilds, 4000);
    }

    function stopBuildsPoll() {
        if (state.buildsPollTimer) {
            clearInterval(state.buildsPollTimer);
            state.buildsPollTimer = null;
        }
    }

    function renderModuleStatus(status) {
        state.moduleStatus = status;
        state.moduleReady = !!(status && status.ready);
        const el = els['gen-module-status'];
        if (!el) return;
        const parts = [
            `Status: ${status.status || 'unknown'}`,
            status.termsAccepted ? 'Terms accepted' : 'Terms not accepted',
            status.templatesPresent ? 'Templates present' : 'Templates missing',
            status.installedVersion ? `Version ${status.installedVersion}` : null,
            status.signingSeedPresent ? 'Signing seed present' : 'Signing seed missing (plain JSON Phase A)',
            status.error ? `Error: ${status.error}` : null,
        ].filter(Boolean);
        el.textContent = parts.join(' · ');
        el.classList.toggle('is-error', status.status === 'error');

        if (els['gen-accept-terms']) {
            els['gen-accept-terms'].disabled = !!status.termsAccepted;
        }
        if (els['gen-install-module']) {
            els['gen-install-module'].disabled = !status.termsAccepted || status.status === 'downloading';
            els['gen-install-module'].textContent = status.status === 'downloading'
                ? 'Downloading…'
                : 'Install from GitHub';
        }
        if (els['gen-finish-install']) {
            els['gen-finish-install'].classList.toggle('hidden', !status.ready);
        }
    }

    function showModuleGate(show) {
        if (els['gen-module-gate']) els['gen-module-gate'].classList.toggle('hidden', !show);
        if (els['gen-main']) els['gen-main'].classList.toggle('hidden', show);
    }

    async function refreshModuleStatus() {
        const data = await api('GET', '/api/generator/module/status');
        const status = data.data || {};
        renderModuleStatus(status);
        showModuleGate(!status.ready);
        return status;
    }

    function bindEvents() {
        if (els['gen-new-support']) {
            els['gen-new-support'].addEventListener('click', () => setEditorForNew());
        }
        if (els['gen-save-btn']) {
            els['gen-save-btn'].addEventListener('click', () => saveBundle());
        }
        if (els['gen-name']) {
            els['gen-name'].addEventListener('input', () => { syncSlugFromName(); markDirty(); });
        }
        if (els['gen-slug']) {
            els['gen-slug'].addEventListener('input', () => {
                state.slugManual = true;
                updateDownloadLinkPreview();
                markDirty();
            });
        }
        ['gen-app-name', 'gen-server-host', 'gen-relay-host', 'gen-api-port'].forEach((id) => {
            if (els[id]) els[id].addEventListener('input', markDirty);
        });
        if (els['gen-use-https']) els['gen-use-https'].addEventListener('change', markDirty);

        if (els['gen-copy-link']) {
            els['gen-copy-link'].addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(els['gen-download-url'].value);
                    notify.success(t('common.copied', 'Copied'));
                } catch (_) {
                    notify.error(t('common.copy_failed', 'Copy failed'));
                }
            });
        }

        if (els['gen-revoke-btn']) {
            els['gen-revoke-btn'].addEventListener('click', async () => {
                if (!state.currentId || state.currentId === 'new') return;
                const revoked = !(state.currentBundle && state.currentBundle.revoked);
                try {
                    await api('POST', `/api/generator/bundles/${state.currentId}/revoke`, { revoked });
                    notify.success(revoked ? t('generator.revoked', 'Revoked') : t('generator.restored', 'Restored'));
                    await loadBundles();
                    await openBundle(state.currentId);
                } catch (err) {
                    notify.error(err.message);
                }
            });
        }

        if (els['gen-delete-btn']) {
            els['gen-delete-btn'].addEventListener('click', async () => {
                if (!state.currentId || state.currentId === 'new') return;
                if (!window.confirm(t('generator.confirm_delete', 'Delete this bundle?'))) return;
                try {
                    await api('DELETE', `/api/generator/bundles/${state.currentId}`);
                    notify.success(t('common.deleted', 'Deleted'));
                    state.currentId = null;
                    setEditorVisible(false);
                    stopBuildsPoll();
                    await loadBundles();
                } catch (err) {
                    notify.error(err.message);
                }
            });
        }

        if (els['gen-rebuild-btn']) {
            els['gen-rebuild-btn'].addEventListener('click', async () => {
                if (!state.currentId || state.currentId === 'new') return;
                try {
                    await api('POST', `/api/generator/bundles/${state.currentId}/rebuild`, {
                        platforms: selectedPlatformPayload(),
                    });
                    notify.success(t('generator.rebuild_queued', 'Rebuild queued'));
                    await refreshBuilds();
                    startBuildsPoll();
                } catch (err) {
                    notify.error(err.message);
                }
            });
        }

        if (els['gen-accept-terms']) {
            els['gen-accept-terms'].addEventListener('click', async () => {
                try {
                    await api('POST', '/api/generator/module/accept-terms');
                    notify.success('Terms accepted');
                    await refreshModuleStatus();
                } catch (err) {
                    notify.error(err.message);
                }
            });
        }

        if (els['gen-install-module']) {
            els['gen-install-module'].addEventListener('click', async () => {
                try {
                    els['gen-install-module'].disabled = true;
                    notify.info('Downloading templates from GitHub…');
                    await api('POST', '/api/generator/module/install', {});
                    notify.success('Module installed');
                    await refreshModuleStatus();
                } catch (err) {
                    notify.error(err.message);
                    await refreshModuleStatus();
                }
            });
        }

        if (els['gen-finish-install']) {
            els['gen-finish-install'].addEventListener('click', async () => {
                const status = await refreshModuleStatus();
                if (status.ready) {
                    showModuleGate(false);
                    await initGeneratorMain();
                }
            });
        }
    }

    async function initGeneratorMain() {
        await loadDefaults();
        await loadPlatforms();
        await loadBundles();
    }

    async function init() {
        cacheEls();
        bindEvents();
        try {
            const status = await refreshModuleStatus();
            if (status.ready) {
                showModuleGate(false);
                await initGeneratorMain();
            }
        } catch (err) {
            notify.error(err.message);
            showModuleGate(true);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
