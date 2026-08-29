/* =========================================================================
   BetterDesk Support Agent Generator
   Create branded Support Agent installers; builds run on this console host.
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
        platforms: [],
        selectedPlatforms: new Set(),
        dirty: false,
        slugManual: false,
        previewTimer: null,
        buildsPollTimer: null,
        productType: 'support-agent',
    };

    const $ = (id) => document.getElementById(id);
    const els = {};

    function cacheEls() {
        ['gen-new-support', 'gen-bundle-list', 'gen-editor-title', 'gen-revoke-btn', 'gen-delete-btn', 'gen-save-btn',
         'gen-rebuild-btn', 'gen-builds-list', 'gen-builds-summary', 'gen-toolchain-banner', 'gen-platforms',
         'gen-empty-state', 'gen-editor-form',
         'gen-name', 'gen-slug', 'gen-company', 'gen-short-text', 'gen-product-label', 'gen-hide-product-type',
         'gen-email', 'gen-phone', 'gen-url',
         'gen-server-host', 'gen-use-https', 'gen-token-mask',
         'gen-logo', 'gen-logo-clear', 'gen-primary', 'gen-accent', 'gen-bg', 'gen-surface', 'gen-text', 'gen-text-muted', 'gen-status-ready', 'gen-header-text', 'gen-lang', 'gen-unattended',
         'gen-download-info', 'gen-download-url', 'gen-copy-link', 'gen-open-link',
         'gen-preview', 'gen-prev-logo', 'gen-prev-body-logo', 'gen-prev-name', 'gen-prev-text', 'gen-prev-pw-row', 'gen-prev-contact',
         'gen-validation-errors', 'gen-advanced-branding'
        ].forEach(id => { els[id] = $(id); });
    }

    const DEFAULT_BRANDING = {
        company_name: '',
        short_text: '',
        product_label: '',
        hide_product_type: false,
        contact_email: '',
        contact_phone: '',
        contact_url: '',
        logo_data_url: '',
        primary_color: '#2563eb',
        accent_color:  '#e0f2fe',
        background_color: '#ffffff',
        surface_color: '#f3f4f6',
        text_color: '#1f2937',
        text_muted_color: '#6b7280',
        status_ready_color: '#22c55e',
        header_text_color: '#1f2937',
        allow_unattended: false,
        default_lang: 'en',
        server_host: '',
        use_https: true,
    };

    let logoDataUrl = '';
    let connectionDefaults = { server_host: '', use_https: true };

    const SLUG_TRANSLIT = {
        'ą': 'a', 'ć': 'c', 'ę': 'e', 'ł': 'l', 'ń': 'n', 'ó': 'o', 'ś': 's', 'ź': 'z', 'ż': 'z',
        'ä': 'a', 'ö': 'o', 'ü': 'u', 'ß': 'ss', 'æ': 'ae', 'ø': 'o', 'å': 'a',
        'č': 'c', 'ď': 'd', 'ě': 'e', 'ň': 'n', 'ř': 'r', 'š': 's', 'ť': 't', 'ů': 'u', 'ý': 'y', 'ž': 'z',
    };

    function slugifyName(name) {
        let slug = String(name || '').trim().toLowerCase().split('').map(ch => SLUG_TRANSLIT[ch] ?? ch).join('');
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
            company_name: els['gen-company'].value.trim(),
            short_text:   els['gen-short-text'].value.trim(),
            product_label: els['gen-product-label'] ? els['gen-product-label'].value.trim() : '',
            hide_product_type: !!(els['gen-hide-product-type'] && els['gen-hide-product-type'].checked),
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
        if (els['gen-product-label']) els['gen-product-label'].value = b.product_label || '';
        if (els['gen-hide-product-type']) els['gen-hide-product-type'].checked = !!b.hide_product_type;
        els['gen-email'].value = b.contact_email || '';
        els['gen-phone'].value = b.contact_phone || '';
        els['gen-url'].value   = b.contact_url || '';
        els['gen-primary'].value = b.primary_color || '#2563eb';
        els['gen-accent'].value  = b.accent_color  || '#e0f2fe';
        els['gen-bg'].value = b.background_color || '#ffffff';
        els['gen-surface'].value = b.surface_color || '#f3f4f6';
        els['gen-text'].value = b.text_color || '#1f2937';
        els['gen-text-muted'].value = b.text_muted_color || '#6b7280';
        els['gen-status-ready'].value = b.status_ready_color || '#22c55e';
        els['gen-header-text'].value = b.header_text_color || '#1f2937';
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
            frame.style.setProperty('--brand-bg', b.background_color || '#ffffff');
            frame.style.setProperty('--brand-surface', b.surface_color || '#f3f4f6');
            frame.style.setProperty('--brand-text', b.text_color || '#1f2937');
            frame.style.setProperty('--brand-text-muted', b.text_muted_color || '#6b7280');
            frame.style.setProperty('--brand-status-ready', b.status_ready_color || '#22c55e');
            frame.style.setProperty('--brand-header-text', b.header_text_color || '#1f2937');
        }
        const logoHtml = b.logo_data_url
            ? `<img src="${escapeText(b.logo_data_url)}" alt="">`
            : '<span class="material-icons">support_agent</span>';
        const logoTop = els['gen-prev-logo'];
        if (logoTop) logoTop.innerHTML = logoHtml;
        const logoHero = els['gen-prev-body-logo'];
        if (logoHero) {
            logoHero.innerHTML = b.logo_data_url
                ? `<img src="${escapeText(b.logo_data_url)}" alt="">`
                : '<span class="material-icons">devices</span>';
        }
        els['gen-prev-name'].textContent = b.company_name || t('generator.preview_default_name', 'BetterDesk Support');
        els['gen-prev-text'].textContent = b.short_text || '';
        if (els['gen-prev-pw-row']) els['gen-prev-pw-row'].classList.remove('hidden');
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
            queued: t('generator.build_status_pending', 'Queued'),
            building: t('generator.build_status_building', 'Building'),
            failed: t('generator.build_status_failed', 'Failed'),
        };
        return map[status] || status;
    }

    function summarizeBuilds(builds) {
        const counts = { ready: 0, pending: 0, building: 0, failed: 0 };
        for (const b of builds || []) {
            const status = b.status === 'queued' ? 'pending' : b.status;
            if (counts[status] != null) counts[status]++;
        }
        return counts;
    }

    function buildsNeedPoll(builds) {
        return (builds || []).some(
            (b) => b.status === 'queued' || b.status === 'pending' || b.status === 'building'
        );
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

    function classifyBuildErrorClient(msg) {
        const s = String(msg || '');
        if (/branding signing|sealbranding|refusing to embed plaintext|signed branding profile could not/i.test(s)) {
            return t('generator.toolchain_branding_seal', 'Branding signing failed — check bundle signing key and rebuild');
        }
        if (/not in std|Go toolchain|stdlib verification|go:|cannot find package/i.test(s)) {
            return t('generator.toolchain_go', 'Go toolchain missing or unhealthy');
        }
        if (/wixl|msitools|\.wxs/i.test(s)) {
            return t('generator.toolchain_wixl', 'wixl (msitools) required for Windows .msi builds');
        }
        if (/appimagetool|AppImage|Failed to extract AppImage|could not create symlink/i.test(s)) {
            return t('generator.toolchain_appimage', 'appimagetool required for Linux AppImage builds');
        }
        if (/dpkg-deb|fakeroot|\.deb/i.test(s)) {
            return t('generator.toolchain_deb', 'dpkg-deb / fakeroot required for .deb packages');
        }
        if (/rpmbuild|\.rpm/i.test(s)) {
            return t('generator.toolchain_rpm', 'rpmbuild required for .rpm packages');
        }
        if (/mesa|opengl|libGL|WGL/i.test(s)) {
            return t('generator.toolchain_mesa', 'Mesa/OpenGL support needed for Windows GUI builds');
        }
        if (/mingw|x86_64-w64-mingw|cgo: C compiler|CC=.*mingw/i.test(s)) {
            return t('generator.toolchain_cgo', 'CGO / mingw cross-compiler required for Windows Fyne builds');
        }
        return t('generator.build_error_hint', 'Build error');
    }

    function selectAllPlatforms() {
        state.selectedPlatforms = new Set(
            (state.platforms || []).map((p) => platformKey(p.platform, p.arch, p.format))
        );
        renderPlatformChecklist();
    }

    function readSelectedPlatforms() {
        const keys = state.selectedPlatforms;
        const list = (state.platforms || []).filter((p) => keys.has(platformKey(p.platform, p.arch, p.format)));
        return list.map((p) => ({ platform: p.platform, arch: p.arch, format: p.format }));
    }

    function renderPlatformChecklist() {
        const root = els['gen-platforms'];
        if (!root) return;
        if (!state.platforms.length) {
            root.innerHTML = `<p class="text-muted">${escapeText(t('generator.builds_loading', 'Loading…'))}</p>`;
            return;
        }
        root.innerHTML = state.platforms.map((p) => {
            const key = platformKey(p.platform, p.arch, p.format);
            const checked = state.selectedPlatforms.has(key) ? 'checked' : '';
            const label = p.label || platformLabel(p.platform, p.arch, p.format);
            return `
                <label class="platform-check">
                    <input type="checkbox" data-platform-key="${escapeText(key)}" ${checked}>
                    <span>${escapeText(label)}</span>
                </label>
            `;
        }).join('');
        root.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
            cb.addEventListener('change', () => {
                const key = cb.dataset.platformKey;
                if (cb.checked) state.selectedPlatforms.add(key);
                else state.selectedPlatforms.delete(key);
                if (state.currentId === 'new' || state.currentId) markDirty();
            });
        });
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
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map(b => {
                        const hint = b.error_message
                            ? `<div class="build-error-hint">${escapeText(classifyBuildErrorClient(b.error_message))}</div>`
                            : '';
                        const err = b.error_message
                            ? `<div class="build-error" title="${escapeText(b.error_message)}">${escapeText(b.error_message)}</div>`
                            : '';
                        const retry = b.status === 'failed'
                            ? `<button type="button" class="btn btn-ghost btn-xs gen-retry-build"
                                data-platform="${escapeText(b.platform)}"
                                data-arch="${escapeText(b.arch)}"
                                data-format="${escapeText(b.format)}">
                                <span class="material-icons">replay</span>
                                ${escapeText(t('generator.retry_build', 'Retry'))}
                               </button>`
                            : '';
                        return `
                            <tr class="build-row build-row--${escapeText(b.status)}">
                                <td>${escapeText(platformLabel(b.platform, b.arch, b.format))}${hint}${err}</td>
                                <td><span class="build-badge build-badge--${escapeText(b.status)}">${escapeText(statusLabel(b.status))}</span></td>
                                <td class="build-actions">${retry}</td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        `;

        listEl.querySelectorAll('.gen-retry-build').forEach((btn) => {
            btn.addEventListener('click', () => retryPlatformBuild(
                btn.dataset.platform,
                btn.dataset.arch,
                btn.dataset.format
            ));
        });

        scheduleBuildsPoll();
    }

    async function retryPlatformBuild(platform, arch, format) {
        if (!state.currentId || state.currentId === 'new') return;
        try {
            const res = await api(
                'POST',
                `/api/generator/bundles/${encodeURIComponent(state.currentId)}/rebuild/`
                    + `${encodeURIComponent(platform)}/${encodeURIComponent(arch)}/${encodeURIComponent(format)}`
            );
            notify.success(t('generator.retry_queued', 'Platform build queued'));
            renderBuilds((res && res.data && res.data.builds) || []);
        } catch (e) {
            notify.error(e.message);
        }
    }

    async function loadToolchainStatus() {
        const banner = els['gen-toolchain-banner'];
        if (!banner) return;
        try {
            const res = await api('GET', '/api/generator/build-status');
            const d = (res && res.data) || {};
            const issues = [];
            if (!d.workerEnabled) {
                issues.push(t('generator.toolchain_worker_off', 'Agent build worker is disabled'));
            }
            if (!d.goHealthy) {
                issues.push(t('generator.toolchain_go_missing', 'Go is not available'));
            }
            if (!d.mingwGcc) {
                issues.push(t('generator.toolchain_mingw_missing', 'mingw-w64 (x86_64-w64-mingw32-gcc) not found — Windows builds will fail'));
            }
            if (!d.msiBuilder) {
                issues.push(t('generator.toolchain_msi_missing', 'MSI builder (wixl) not found'));
            }
            if (!d.appimagetool) {
                issues.push(t('generator.toolchain_appimage_missing', 'appimagetool not found — AppImage builds will fail'));
            }
            if (d.rebuildPending) {
                issues.push(
                    t('generator.rebuild_pending_banner', 'A generator rebuild is pending')
                        .replace('{{reason}}', d.rebuildPending.reason || 'update')
                );
            }
            if (issues.length) {
                banner.className = 'toolchain-banner toolchain-banner--warn';
                banner.textContent = issues.join(' · ');
                banner.classList.remove('hidden');
            } else {
                banner.className = 'toolchain-banner toolchain-banner--ok';
                banner.textContent = t('generator.toolchain_banner_ok', 'Build toolchain ready (Go {{go}}).')
                    .replace('{{go}}', d.goBin || 'go');
                banner.classList.remove('hidden');
            }
        } catch (_) {
            banner.classList.add('hidden');
        }
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
            const platforms = readSelectedPlatforms();
            const res = await api('POST', `/api/generator/bundles/${encodeURIComponent(state.currentId)}/rebuild`, {
                platforms: platforms.length ? platforms : undefined,
            });
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
            const pt = bundle.product_type || 'support-agent';
            const productBadge = (pt === 'support-agent' || pt === 'agent')
                ? `<span class="badge-product">${escapeText(t('generator.product_support_agent', 'Support'))}</span>`
                : pt === 'rdclient'
                    ? `<span class="badge-product badge-product--legacy">${escapeText(t('generator.product_rdclient', 'RdClient'))}</span>`
                    : `<span class="badge-product badge-product--legacy">${escapeText(t('generator.product_agent_client', 'Agent Client'))}</span>`;
            item.innerHTML = `
                <div class="bundle-item-title">
                    ${escapeText(bundle.name || bundle.bundle_id)}
                    ${productBadge}
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

    function setEditorForNew(productType) {
        state.currentId = 'new';
        state.currentBundle = null;
        state.currentBuilds = [];
        state.dirty = false;
        state.slugManual = false;
        state.productType = productType || 'support-agent';
        selectAllPlatforms();
        stopBuildsPoll();
        els['gen-editor-title'].innerHTML = `<span class="material-icons">add_circle</span> ${escapeText(t('generator.support_agent_new_bundle', 'New Support Agent'))}`;
        els['gen-name'].value = '';
        if (els['gen-slug']) els['gen-slug'].value = '';
        writeBranding(DEFAULT_BRANDING);
        if (els['gen-advanced-branding']) els['gen-advanced-branding'].open = false;
        els['gen-revoke-btn'].classList.add('hidden');
        els['gen-delete-btn'].classList.add('hidden');
        els['gen-download-info'].classList.remove('hidden');
        const buildsSection = $('gen-builds-section');
        if (buildsSection) buildsSection.classList.add('hidden');
        els['gen-download-url'].value = '';
        if (els['gen-open-link']) {
            els['gen-open-link'].href = '#';
            els['gen-open-link'].classList.add('disabled');
        }
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
        state.productType = bundle.product_type || 'support-agent';
        state.dirty = false;
        state.slugManual = true;
        selectAllPlatforms();
        stopBuildsPoll();
        els['gen-editor-title'].innerHTML = `<span class="material-icons">edit</span> ${escapeText(bundle.name || bundle.bundle_id)}`;
        els['gen-name'].value = bundle.name || '';
        if (els['gen-slug']) els['gen-slug'].value = bundle.slug || bundle.public_id || '';
        writeBranding(bundle.branding);
        if (els['gen-advanced-branding']) {
            const b = bundle.branding || {};
            const hasCustom = !!(b.company_name || b.logo_data_url || b.short_text || b.contact_email
                || b.product_label || b.hide_product_type);
            els['gen-advanced-branding'].open = hasCustom;
        }
        els['gen-revoke-btn'].classList.remove('hidden');
        els['gen-revoke-btn'].innerHTML = bundle.revoked
            ? `<span class="material-icons">undo</span> ${escapeText(t('generator.unrevoke', 'Unrevoke'))}`
            : `<span class="material-icons">block</span> ${escapeText(t('generator.revoke', 'Revoke'))}`;
        els['gen-delete-btn'].classList.remove('hidden');
        els['gen-save-btn'].disabled = true;
        updateDownloadLinkPreview();
        els['gen-download-info'].classList.remove('hidden');
        const buildsSection = $('gen-builds-section');
        if (buildsSection) buildsSection.classList.remove('hidden');
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
        const branding = readBranding();
        if (!branding.company_name && els['gen-name'].value.trim()) {
            branding.company_name = els['gen-name'].value.trim();
        }
        const platforms = readSelectedPlatforms();
        if (!platforms.length) {
            showErrors([t('generator.errors.platforms_required', 'Select at least one platform to build')]);
            return;
        }
        const payload = {
            name: els['gen-name'].value.trim(),
            slug: readSlugInput(),
            branding,
            product_type: 'support-agent',
            platforms,
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
                refreshBuilds().catch(() => {});
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
            state.platforms = platforms;
            state.platformLabels = {};
            platforms.forEach(p => {
                state.platformLabels[platformKey(p.platform, p.arch, p.format)] = p.label;
            });
            selectAllPlatforms();
        } catch (_) {
            state.platforms = [];
            state.platformLabels = {};
        }
    }

    function bindEvents() {
        if (els['gen-new-support']) {
            els['gen-new-support'].addEventListener('click', () => setEditorForNew('support-agent'));
        }
        els['gen-save-btn'].addEventListener('click', saveBundle);
        els['gen-rebuild-btn'].addEventListener('click', rebuildAllBuilds);
        els['gen-revoke-btn'].addEventListener('click', toggleRevoke);
        els['gen-delete-btn'].addEventListener('click', deleteBundle);
        els['gen-logo'].addEventListener('change', onLogoChange);
        els['gen-logo-clear'].addEventListener('click', clearLogo);
        els['gen-copy-link'].addEventListener('click', copyDownloadLink);

        if (els['gen-name']) {
            els['gen-name'].addEventListener('input', () => {
                syncSlugFromName();
                markDirty();
            });
        }
        if (els['gen-slug']) {
            els['gen-slug'].addEventListener('input', () => {
                state.slugManual = true;
                els['gen-slug'].value = els['gen-slug'].value.toLowerCase().replace(/[^a-z0-9-]/g, '');
                updateDownloadLinkPreview();
                markDirty();
            });
        }

        [         'gen-company', 'gen-short-text', 'gen-product-label', 'gen-hide-product-type',
         'gen-email', 'gen-phone', 'gen-url',
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
        loadToolchainStatus().catch(() => {});
        loadBundles();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
