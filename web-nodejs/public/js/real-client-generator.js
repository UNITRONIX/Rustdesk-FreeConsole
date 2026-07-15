/* BetterDesk RustDesk Client Generator */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const notify = window.Notifications || { success: console.log, error: console.error, warning: console.warn, info: console.info };
    const csrf = () => (window.BetterDesk && window.BetterDesk.csrfToken) || '';
    const state = {
        configs: [], capabilities: null, currentId: null, assets: { icon: null, logo: null, privacy: null },
        dirty: false, builds: [], poll: null, defaults: null, organizations: [],
        buildPlan: null, selectedTargets: new Set(), selectedVariants: new Set(['client', 'quicksupport']),
        showAllBuilds: false,
    };

    async function api(method, url, body) {
        const headers = { Accept: 'application/json' };
        const options = { method, credentials: 'same-origin', headers };
        if (!['GET', 'HEAD'].includes(method)) headers['X-CSRF-Token'] = csrf();
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(body);
        }
        const response = await fetch(url, options);
        const type = response.headers.get('content-type') || '';
        const data = type.includes('application/json') ? await response.json() : null;
        if (!response.ok || (data && data.success === false)) {
            const error = new Error((data && data.error) || `HTTP ${response.status}`);
            error.data = data;
            error.status = response.status;
            throw error;
        }
        return data;
    }

    function escapeText(value) {
        const node = document.createElement('div');
        node.textContent = String(value == null ? '' : value);
        return node.innerHTML;
    }

    function escapeAttr(value) {
        return escapeText(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function settingsToText(settings) {
        return Object.entries(settings || {}).map(([key, value]) => `${key}=${value}`).join('\n');
    }

    function defaultConfig() {
        return {
            rustdeskVersion: '1.4.9', target: 'windows-x64-exe', idServer: '', relayServer: '', apiServer: '', publicKey: '', networkScope: 'override',
            appName: 'RustDesk', executableName: 'rustdesk', companyName: '', customUrl: '', downloadUrl: '',
            androidAppId: 'com.carriez.flutter_hbb', macosBundleId: 'com.carriez.flutterHbb',
            direction: 'both', theme: 'system', themeScope: 'default',
            approvalMode: 'password-click', permissionsScope: 'default', permissionPreset: 'custom', delayFix: true,
            disableInstallation: false, disableSettings: false,
            allowAutoDisconnect: false, denyLanDiscovery: false, directIpAccess: false,
            removeWallpaper: true, hideConnectionManager: false, cycleMonitor: false, offlineIndicator: false,
            removeVersionNotification: false,
            permissions: {
                keyboard: true, clipboard: true, fileTransfer: true, audio: true, tcpTunnel: true,
                remoteRestart: true, recording: true, blockInput: true, remoteConfig: false,
                printer: true, camera: true, terminal: true,
            },
            defaultSettings: {}, overrideSettings: {},
            assets: { icon: null, logo: null, privacy: null },
        };
    }

    function targetAvailable(id) {
        const target = state.capabilities && state.capabilities.targets.find((item) => item.id === id);
        return !!(target && target.enabled);
    }

    function renderOrganizations(selected) {
        const select = $('rc-organization');
        select.innerHTML = '<option value="">Global / unscoped</option>' + state.organizations.map((organization) =>
            `<option value="${escapeText(organization.id)}">${escapeText(organization.name)}${organization.active ? '' : ' — inactive'}</option>`
        ).join('');
        select.value = selected == null ? '' : String(selected);
    }

    function renderCapabilities(selectedTarget) {
        const data = state.capabilities || { providers: [], targets: [] };
        const enabled = data.providers.filter((provider) => provider.enabled);
        const box = $('rc-provider-state');
        if (!enabled.length) {
            const reason = data.providers.map((provider) => provider.reason).filter(Boolean).join(' ');
            box.className = 'rc-provider-state is-error';
            box.textContent = `Build provider is not ready. ${reason || 'Configure a verified provider on the server.'}`;
        } else {
            box.className = 'rc-provider-state';
            box.textContent = `${enabled.map((provider) => provider.label).join(', ')} ready · ${data.targets.filter((target) => target.enabled).length} verified target(s) · ${(data.versions || []).length} verified version(s)`;
        }

        const providerSelect = $('rc-provider');
        providerSelect.innerHTML = data.providers.map((provider) =>
            `<option value="${escapeText(provider.id)}" ${provider.enabled ? '' : 'disabled'}>${escapeText(provider.label)}${provider.enabled ? '' : ' — unavailable'}</option>`
        ).join('') || '<option disabled>No provider configured</option>';
        if (enabled.length) providerSelect.value = enabled[0].id;

        const targetSelect = $('rc-target');
        const current = selectedTarget || targetSelect.value || 'windows-x64-exe';
        targetSelect.innerHTML = data.targets.map((target) => {
            const unavailable = !target.enabled;
            const keepSelectable = target.id === current;
            return `<option value="${escapeText(target.id)}" ${unavailable && !keepSelectable ? 'disabled' : ''}>${escapeText(target.label)}${unavailable ? ' — not configured' : ''}</option>`;
        }).join('');
        if (data.targets.some((target) => target.id === current)) targetSelect.value = current;
        const versionOptions = $('rc-version-options');
        if (versionOptions) {
            versionOptions.innerHTML = (data.versions || []).map((version) =>
                `<option value="${escapeAttr(version)}"></option>`
            ).join('');
        }
        renderVariantSelector();
        renderBuildMatrix();
        updateBuildButton();
    }

    function planEntry(targetId, variantId) {
        return state.buildPlan && state.buildPlan.entries.find((entry) =>
            entry.target === targetId && entry.variant === variantId
        );
    }

    function renderVariantSelector() {
        const box = $('rc-variant-selector');
        if (!box) return;
        const variants = state.capabilities && state.capabilities.variants || [];
        box.innerHTML = variants.map((variant) => `
            <label class="rc-variant-card ${state.selectedVariants.has(variant.id) ? 'is-selected' : ''}">
                <input type="checkbox" data-rc-variant="${escapeAttr(variant.id)}" ${state.selectedVariants.has(variant.id) ? 'checked' : ''}>
                <span><strong>${escapeText(variant.label)}</strong><small>${escapeText(variant.description)}</small></span>
            </label>
        `).join('');
    }

    function targetEnabledForSelection(targetId) {
        if (!state.buildPlan || !state.selectedVariants.size) return false;
        return [...state.selectedVariants].every((variantId) => {
            const entry = planEntry(targetId, variantId);
            return entry && entry.enabled;
        });
    }

    function renderBuildMatrix() {
        const box = $('rc-build-matrix');
        if (!box) return;
        if (!state.currentId) {
            box.innerHTML = '<p class="text-muted">Save a configuration to load verified build targets.</p>';
            updateSelectionSummary();
            return;
        }
        if (state.dirty) {
            box.innerHTML = '<p class="text-muted">Save the configuration changes to refresh the verified build matrix.</p>';
            updateSelectionSummary();
            return;
        }
        if (!state.buildPlan) {
            box.innerHTML = '<p class="text-muted">Loading verified build targets…</p>';
            updateSelectionSummary();
            return;
        }
        const targets = state.capabilities && state.capabilities.targets || [];
        box.innerHTML = targets.map((target) => {
            const enabled = targetEnabledForSelection(target.id);
            if (!enabled) state.selectedTargets.delete(target.id);
            const selected = enabled && state.selectedTargets.has(target.id);
            const issues = [...state.selectedVariants].flatMap((variantId) => {
                const entry = planEntry(target.id, variantId);
                return entry && !entry.enabled ? entry.errors.map((error) => `${variantId}: ${error.message}`) : [];
            });
            const warnings = [...state.selectedVariants].flatMap((variantId) => {
                const entry = planEntry(target.id, variantId);
                return entry ? (entry.warnings || []).map((warning) => `${variantId}: ${warning.message || warning.code}`) : [];
            });
            const adjustments = [...state.selectedVariants].flatMap((variantId) => {
                const entry = planEntry(target.id, variantId);
                return entry ? (entry.adjustments || []).map((adjustment) => `${variantId}: ${adjustment.message || adjustment.code}`) : [];
            });
            const details = [...issues, ...warnings, ...adjustments];
            const note = !enabled
                ? (issues[0] || 'Not E2E verified for this version')
                : warnings.length
                ? `Warning: ${warnings[0]}`
                : adjustments.length
                ? `Planned: ${adjustments[0]}`
                : `${state.selectedVariants.size} output type(s)`;
            return `
                <label class="rc-target-card ${selected ? 'is-selected' : ''} ${enabled ? '' : 'is-disabled'} ${warnings.length ? 'has-warning' : ''} ${adjustments.length ? 'has-adjustment' : ''}" title="${escapeAttr(details.join(' ') || target.label)}">
                    <input type="checkbox" data-rc-build-target="${escapeAttr(target.id)}" ${selected ? 'checked' : ''} ${enabled ? '' : 'disabled'}>
                    <span class="material-icons">${target.platform === 'windows' ? 'window' : target.platform === 'android' ? 'android' : target.platform === 'macos' ? 'laptop_mac' : 'computer'}</span>
                    <span><strong>${escapeText(target.label)}</strong><small>${escapeText(note)}</small></span>
                </label>
            `;
        }).join('');
        updateSelectionSummary();
    }

    function updateSelectionSummary() {
        const count = state.selectedTargets.size * state.selectedVariants.size;
        const requiresPassword = [...state.selectedTargets].some((targetId) =>
            [...state.selectedVariants].some((variantId) => {
                const entry = planEntry(targetId, variantId);
                return entry && entry.requires_password;
            })
        );
        const summary = $('rc-build-selection-summary');
        if (summary) {
            summary.textContent = count
                ? `${count} output(s) selected · ${state.selectedTargets.size} target(s) × ${state.selectedVariants.size} client type(s)${requiresPassword ? ' · permanent password required' : ''}`
                : 'No outputs selected.';
            summary.classList.toggle('is-warning', requiresPassword);
        }
        updateBuildButton();
    }

    async function loadBuildPlan({ selectAll = false } = {}) {
        state.buildPlan = null;
        if (!state.currentId || state.dirty) {
            renderBuildMatrix();
            return;
        }
        renderBuildMatrix();
        try {
            const response = await api('GET', `/api/generator/real-client/build-plan?config_id=${encodeURIComponent(state.currentId)}&provider=${encodeURIComponent($('rc-provider').value)}`);
            state.buildPlan = response.data.plan;
            if (selectAll) {
                state.selectedTargets = new Set((state.capabilities.targets || [])
                    .filter((target) => targetEnabledForSelection(target.id))
                    .map((target) => target.id));
            } else {
                state.selectedTargets = new Set([...state.selectedTargets].filter(targetEnabledForSelection));
            }
            renderBuildMatrix();
        } catch (error) {
            state.buildPlan = { entries: [] };
            $('rc-build-matrix').innerHTML = `<p class="text-muted">${escapeText(error.message)}</p>`;
            updateSelectionSummary();
        }
    }

    function setDirty(dirty) {
        state.dirty = dirty;
        if (dirty) {
            state.buildPlan = null;
            state.selectedTargets.clear();
        }
        $('rc-save-state').textContent = dirty ? 'Unsaved changes' : '';
        if (dirty && $('rc-build-matrix')) renderBuildMatrix();
    }

    function readForm() {
        const config = {
            rustdeskVersion: $('rc-version').value.trim(), target: $('rc-target').value,
            idServer: $('rc-id-server').value.trim(), relayServer: $('rc-relay-server').value.trim(),
            apiServer: $('rc-api-server').value.trim(), publicKey: $('rc-public-key').value.trim(),
            networkScope: $('rc-network-scope').value,
            appName: $('rc-app-name').value.trim(), executableName: $('rc-executable-name').value.trim(),
            companyName: $('rc-company-name').value.trim(), customUrl: $('rc-custom-url').value.trim(),
            downloadUrl: $('rc-download-url').value.trim(), androidAppId: $('rc-android-id').value.trim(),
            macosBundleId: $('rc-macos-bundle-id').value.trim(),
            direction: $('rc-direction').value, theme: $('rc-theme').value, themeScope: $('rc-theme-scope').value,
            approvalMode: $('rc-approval').value, permissionsScope: $('rc-permissions-scope').value,
            permissionPreset: $('rc-preset').value,
            defaultSettings: $('rc-default-settings').value, overrideSettings: $('rc-override-settings').value,
            assets: { ...state.assets }, permissions: {},
        };
        document.querySelectorAll('#rc-behavior-checks [data-field]').forEach((input) => { config[input.dataset.field] = input.checked; });
        document.querySelectorAll('#rc-permission-checks [data-field]').forEach((input) => { config.permissions[input.dataset.field] = input.checked; });
        return {
            name: $('rc-name').value.trim(),
            description: $('rc-description').value.trim(),
            organization_id: $('rc-organization').value,
            config,
        };
    }

    function writeForm(item) {
        const data = item || { name: '', description: '', config: defaultConfig() };
        const value = { ...defaultConfig(), ...(data.config || {}) };
        value.permissions = { ...(data.config && data.config.permissions || {}) };
        state.assets = { icon: null, logo: null, privacy: null, ...(value.assets || {}) };
        renderCapabilities(value.target);
        $('rc-name').value = data.name || '';
        $('rc-description').value = data.description || '';
        renderOrganizations(data.organization_id);
        $('rc-version').value = value.rustdeskVersion;
        $('rc-target').value = value.target;
        $('rc-id-server').value = value.idServer;
        $('rc-relay-server').value = value.relayServer;
        $('rc-api-server').value = value.apiServer;
        $('rc-public-key').value = value.publicKey;
        $('rc-network-scope').value = value.networkScope;
        $('rc-app-name').value = value.appName;
        $('rc-executable-name').value = value.executableName;
        $('rc-company-name').value = value.companyName;
        $('rc-custom-url').value = value.customUrl;
        $('rc-download-url').value = value.downloadUrl;
        $('rc-android-id').value = value.androidAppId;
        $('rc-macos-bundle-id').value = value.macosBundleId;
        $('rc-direction').value = value.direction;
        $('rc-theme').value = value.theme;
        $('rc-theme-scope').value = value.themeScope;
        $('rc-approval').value = value.approvalMode;
        $('rc-permissions-scope').value = value.permissionsScope;
        $('rc-preset').value = value.permissionPreset;
        $('rc-default-settings').value = settingsToText(value.defaultSettings);
        $('rc-override-settings').value = settingsToText(value.overrideSettings);
        document.querySelectorAll('#rc-behavior-checks [data-field]').forEach((input) => { input.checked = !!value[input.dataset.field]; });
        document.querySelectorAll('#rc-permission-checks [data-field]').forEach((input) => {
            input.checked = value.permissions[input.dataset.field] == null
                ? input.dataset.field !== 'remoteConfig'
                : !!value.permissions[input.dataset.field];
        });
        for (const kind of ['icon', 'logo', 'privacy']) {
            $(`rc-asset-${kind}`).value = '';
            const status = document.querySelector(`[data-asset-kind="${kind}"] .rc-asset-state`);
            status.textContent = state.assets[kind] ? 'Saved PNG attached' : 'Not selected';
        }
        $('rc-permanent-password').value = '';
        $('rc-errors').classList.add('hidden');
        $('rc-duplicate').classList.toggle('hidden', !state.currentId);
        $('rc-delete').classList.toggle('hidden', !state.currentId);
        $('rc-mode-label').textContent = state.currentId ? 'Editing saved configuration' : 'New configuration';
        const last = data.last_build;
        $('rc-config-meta').textContent = state.currentId
            ? `Created ${formatDate(data.created_at)} · Updated ${formatDate(data.updated_at)}${last ? ` · Last build ${last.platform}/${last.arch}/${last.package} via ${last.provider}: ${last.status}` : ' · Never built'}`
            : '';
        setDirty(false);
        updateBuildButton();
    }

    function showErrors(error) {
        const box = $('rc-errors');
        const errors = error && error.data && error.data.errors;
        const messages = Array.isArray(errors) && errors.length ? errors.map((item) => item.message || item.code) : [error.message || 'Unexpected error'];
        box.innerHTML = `<strong>Cannot continue</strong><ul>${messages.map((message) => `<li>${escapeText(message)}</li>`).join('')}</ul>`;
        box.classList.remove('hidden');
        box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function showWarnings(warnings) {
        if (!Array.isArray(warnings) || !warnings.length) return;
        notify.warning(warnings.map((item) => item.message || item.code).join(' '));
    }

    function renderConfigList() {
        const list = $('rc-config-list');
        if (!state.configs.length) {
            list.innerHTML = '<p class="text-muted">No RustDesk client configurations yet.</p>';
            return;
        }
        list.innerHTML = state.configs.map((item) => {
            const last = item.last_build ? `${item.last_build.status || 'unknown'} · ${item.last_build.platform}/${item.last_build.arch} · ${item.last_build.provider}` : 'Never built';
            return `<button type="button" class="rc-config-item ${item.id === state.currentId ? 'is-active' : ''}" data-config-id="${escapeText(item.id)}"><strong>${escapeText(item.name)}</strong><span class="rc-config-meta">${escapeText(last)}</span><span class="rc-config-meta">Updated ${escapeText(formatDate(item.updated_at))}</span></button>`;
        }).join('');
    }

    function formatDate(value) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? String(value || '') : date.toLocaleString();
    }

    async function loadConfigs(selectId) {
        const response = await api('GET', '/api/generator/real-client/configs');
        state.configs = response.data.configs || [];
        renderConfigList();
        if (selectId) await selectConfig(selectId);
    }

    async function selectConfig(id) {
        if (state.dirty && !window.confirm('Discard unsaved RustDesk client changes?')) return;
        const response = await api('GET', `/api/generator/real-client/configs/${encodeURIComponent(id)}`);
        state.currentId = id;
        state.showAllBuilds = false;
        writeForm(response.data.config);
        renderConfigList();
        await Promise.all([loadBuilds(), loadBuildPlan({ selectAll: true })]);
    }

    function newConfig() {
        if (state.dirty && !window.confirm('Discard unsaved RustDesk client changes?')) return;
        stopPoll();
        state.currentId = null;
        state.builds = [];
        state.showAllBuilds = false;
        state.buildPlan = null;
        state.selectedTargets.clear();
        state.selectedVariants = new Set(['client', 'quicksupport']);
        const fresh = defaultConfig();
        if (state.defaults) {
            fresh.idServer = state.defaults.server_host || '';
            fresh.relayServer = state.defaults.relay_server || '';
            fresh.apiServer = state.defaults.api_url || '';
            fresh.publicKey = state.defaults.public_key || '';
        }
        writeForm({ name: '', description: '', config: fresh });
        renderBuilds();
        renderVariantSelector();
        renderBuildMatrix();
        renderConfigList();
    }

    async function saveConfig(event) {
        event.preventDefault();
        $('rc-errors').classList.add('hidden');
        const body = readForm();
        try {
            const response = state.currentId
                ? await api('PUT', `/api/generator/real-client/configs/${encodeURIComponent(state.currentId)}`, body)
                : await api('POST', '/api/generator/real-client/configs', body);
            state.currentId = response.data.config.id;
            writeForm(response.data.config);
            await loadConfigs();
            renderConfigList();
            await Promise.all([loadBuilds(), loadBuildPlan({ selectAll: true })]);
            showWarnings(response.data.warnings);
            notify.success('RustDesk client configuration saved');
        } catch (error) {
            showErrors(error);
        }
    }

    async function uploadAsset(kind, input) {
        if (!input.files || !input.files[0]) return;
        const status = document.querySelector(`[data-asset-kind="${kind}"] .rc-asset-state`);
        status.textContent = 'Uploading…';
        const form = new FormData();
        form.append('asset', input.files[0]);
        if (state.currentId) form.append('config_id', state.currentId);
        try {
            const response = await fetch(`/api/generator/real-client/assets/${kind}`, {
                method: 'POST', body: form, credentials: 'same-origin',
                headers: { Accept: 'application/json', 'X-CSRF-Token': csrf() },
            });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.error || `HTTP ${response.status}`);
            state.assets[kind] = data.data.asset.id;
            status.textContent = `${data.data.asset.width} × ${data.data.asset.height} PNG attached`;
            setDirty(true);
        } catch (error) {
            input.value = '';
            status.textContent = 'Upload failed';
            notify.error(error.message);
        }
    }

    function updateBuildButton() {
        const provider = $('rc-provider') && $('rc-provider').value;
        $('rc-build').disabled = !state.currentId || state.dirty || !provider
            || !state.buildPlan || !state.selectedTargets.size || !state.selectedVariants.size;
    }

    function activeBuild(build) {
        return ['queued', 'dispatching', 'building', 'cancelling'].includes(build.status);
    }

    function renderBuilds() {
        const list = $('rc-build-list');
        const historyTitle = $('rc-build-history-title');
        const historyToggle = $('rc-toggle-all-builds');
        const current = state.configs.find((item) => item.id === state.currentId);
        historyTitle.textContent = state.showAllBuilds
            ? 'All build history'
            : current ? `Build history · ${current.name}` : 'Build history';
        historyToggle.textContent = state.showAllBuilds ? 'Show current configuration' : 'Show all builds';
        if (!state.builds.length) {
            list.innerHTML = `<p class="text-muted">${state.showAllBuilds ? 'No build history yet.' : state.currentId ? 'No builds for this configuration.' : 'Save a configuration or show all retained builds.'}</p>`;
            stopPoll();
            return;
        }
        const groups = [];
        const byId = new Map();
        for (const build of state.builds) {
            const key = build.batch_id || build.id;
            if (!byId.has(key)) {
                const group = { id: key, batch: !!build.batch_id, builds: [] };
                byId.set(key, group);
                groups.push(group);
            }
            byId.get(key).builds.push(build);
        }
        const renderRow = (build) => {
            const actions = [];
            if (build.artifact) actions.push(`<a class="btn btn-primary btn-sm" href="${escapeText(build.artifact.download_url)}"><span class="material-icons">download</span> Download</a>`);
            if (activeBuild(build)) {
                actions.push(`<button type="button" class="btn btn-secondary btn-sm" data-build-sync="${escapeText(build.id)}">Sync</button>`);
                actions.push(`<button type="button" class="btn btn-danger btn-sm" data-build-cancel="${escapeText(build.id)}">Cancel</button>`);
            }
            if (build.provider_run_url) actions.push(`<a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="${escapeAttr(build.provider_run_url)}">GitHub</a>`);
            const diagnostic = build.error_message || build.log_summary || '';
            const artifactMeta = build.artifact
                ? `<br><small>${escapeText(build.artifact.name)} · ${escapeText((build.artifact.size / 1048576).toFixed(1))} MiB</small><br><small>SHA-256 <code title="${escapeAttr(build.artifact.sha256)}">${escapeText(build.artifact.sha256)}</code></small>`
                : '';
            const variant = ((state.capabilities && state.capabilities.variants) || []).find((item) => item.id === build.client_variant);
            const configMeta = state.showAllBuilds
                ? `<br><small>Configuration: ${escapeText(build.config_name || 'Unnamed')}${build.config_id ? '' : ' · deleted'}</small>`
                : '';
            return `<article class="rc-build-row"><div><strong>${escapeText(variant ? variant.label : build.client_variant)} · ${escapeText(build.platform)} / ${escapeText(build.arch)} / ${escapeText(build.package)}</strong>${configMeta}<br><code>${escapeText(build.id)}</code>${artifactMeta}</div><div><span class="rc-build-status ${escapeText(build.status)}">${escapeText(build.status)}</span><br><small>${escapeText(build.provider_status || build.provider)}</small></div><div><small>Queued ${escapeText(formatDate(build.queued_at))}</small>${build.finished_at ? `<br><small>Finished ${escapeText(formatDate(build.finished_at))}</small>` : ''}</div><div class="rc-toolbar-actions">${actions.join('')}</div>${diagnostic ? `<pre class="rc-build-log">${escapeText(diagnostic)}</pre>` : ''}</article>`;
        };
        list.innerHTML = groups.map((group) => {
            const counts = group.builds.reduce((summary, build) => {
                summary[build.status] = (summary[build.status] || 0) + 1;
                return summary;
            }, {});
            const summary = Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(' · ');
            const header = group.batch
                ? `<div class="rc-batch-header"><strong>Batch ${escapeText(group.id)}</strong><span>${group.builds.length} outputs · ${escapeText(summary)}</span></div>`
                : '';
            return `<section class="rc-build-group">${header}${group.builds.map(renderRow).join('')}</section>`;
        }).join('');
        if (state.builds.some(activeBuild)) startPoll(); else stopPoll();
    }

    async function loadBuilds() {
        if (!state.showAllBuilds && !state.currentId) {
            state.builds = [];
            renderBuilds();
            return;
        }
        const query = state.showAllBuilds
            ? 'limit=500'
            : `config_id=${encodeURIComponent(state.currentId)}&limit=100`;
        const response = await api('GET', `/api/generator/real-client/builds?${query}`);
        state.builds = response.data.builds || [];
        renderBuilds();
    }

    async function startBuild() {
        if (!state.currentId || state.dirty) return;
        $('rc-build').disabled = true;
        const permanentPassword = $('rc-permanent-password').value;
        $('rc-permanent-password').value = '';
        try {
            const response = await api('POST', '/api/generator/real-client/builds/batch', {
                config_id: state.currentId,
                provider: $('rc-provider').value,
                permanent_password: permanentPassword,
                targets: [...state.selectedTargets],
                variants: [...state.selectedVariants],
            });
            await loadBuilds();
            showWarnings(response.data.warnings);
            if (response.data.partial) notify.warning(`${response.data.builds.length} builds were recorded; one or more dispatches failed.`);
            else notify.success(`${response.data.builds.length} Rust client builds queued in one batch`);
            await loadConfigs();
        } catch (error) {
            showErrors(error);
            notify.error(error.message);
        } finally {
            updateBuildButton();
        }
    }

    async function syncBuild(id) {
        try {
            await api('POST', `/api/generator/real-client/builds/${encodeURIComponent(id)}/sync`, {});
            await loadBuilds();
        } catch (error) { notify.error(error.message); }
    }

    async function cancelBuild(id) {
        if (!window.confirm('Cancel this build?')) return;
        try {
            await api('POST', `/api/generator/real-client/builds/${encodeURIComponent(id)}/cancel`, {});
            await loadBuilds();
        } catch (error) { notify.error(error.message); }
    }

    function startPoll() {
        if (state.poll) return;
        state.poll = window.setInterval(() => loadBuilds().catch(() => {}), 10000);
    }

    function stopPoll() {
        if (state.poll) window.clearInterval(state.poll);
        state.poll = null;
    }

    async function duplicateConfig() {
        if (!state.currentId) return;
        try {
            const response = await api('POST', `/api/generator/real-client/configs/${encodeURIComponent(state.currentId)}/duplicate`, {});
            await loadConfigs(response.data.config.id);
            notify.success('Configuration duplicated');
        } catch (error) { notify.error(error.message); }
    }

    async function deleteConfig() {
        if (!state.currentId || !window.confirm('Delete this saved configuration? Build history will be retained.')) return;
        try {
            await api('DELETE', `/api/generator/real-client/configs/${encodeURIComponent(state.currentId)}`);
            state.currentId = null;
            await loadConfigs();
            newConfig();
            notify.success('Configuration deleted');
        } catch (error) { notify.error(error.message); }
    }

    async function openPanel() {
        $('rc-panel').classList.remove('hidden');
        document.body.classList.add('rc-dialog-open');
        try {
            const [capabilities, defaults, organizations] = await Promise.all([
                api('GET', '/api/generator/real-client/capabilities'),
                api('GET', '/api/generator/defaults').catch(() => ({ data: {} })),
                api('GET', '/api/generator/real-client/organizations').catch(() => ({ data: { organizations: [] } })),
            ]);
            state.capabilities = capabilities.data;
            state.defaults = defaults.data || {};
            state.organizations = organizations.data.organizations || [];
            renderCapabilities();
            await loadConfigs();
            if (state.currentId && state.configs.some((item) => item.id === state.currentId)) await selectConfig(state.currentId);
            else newConfig();
        } catch (error) {
            $('rc-provider-state').className = 'rc-provider-state is-error';
            $('rc-provider-state').textContent = error.message;
        }
    }

    function closePanel() {
        if (state.dirty && !window.confirm('Close and discard unsaved RustDesk client changes?')) return;
        stopPoll();
        $('rc-panel').classList.add('hidden');
        document.body.classList.remove('rc-dialog-open');
    }

    function bind() {
        if (!$('gen-new-real-client') || !$('rc-panel')) return;
        $('gen-new-real-client').addEventListener('click', openPanel);
        document.querySelectorAll('[data-rc-close]').forEach((button) => button.addEventListener('click', closePanel));
        $('rc-new').addEventListener('click', newConfig);
        $('rc-form').addEventListener('submit', saveConfig);
        $('rc-duplicate').addEventListener('click', duplicateConfig);
        $('rc-delete').addEventListener('click', deleteConfig);
        $('rc-build').addEventListener('click', startBuild);
        $('rc-target').addEventListener('change', () => { setDirty(true); updateBuildButton(); });
        $('rc-provider').addEventListener('change', () => loadBuildPlan({ selectAll: true }));
        $('rc-variant-selector').addEventListener('change', (event) => {
            const input = event.target.closest('[data-rc-variant]');
            if (!input) return;
            if (input.checked) state.selectedVariants.add(input.dataset.rcVariant);
            else state.selectedVariants.delete(input.dataset.rcVariant);
            renderVariantSelector();
            renderBuildMatrix();
        });
        $('rc-build-matrix').addEventListener('change', (event) => {
            const input = event.target.closest('[data-rc-build-target]');
            if (!input) return;
            if (input.checked) state.selectedTargets.add(input.dataset.rcBuildTarget);
            else state.selectedTargets.delete(input.dataset.rcBuildTarget);
            renderBuildMatrix();
        });
        $('rc-select-all-builds').addEventListener('click', () => {
            state.selectedTargets = new Set((state.capabilities.targets || [])
                .filter((target) => targetEnabledForSelection(target.id))
                .map((target) => target.id));
            renderBuildMatrix();
        });
        $('rc-select-default-build').addEventListener('click', () => {
            const target = $('rc-target').value;
            state.selectedTargets = targetEnabledForSelection(target) ? new Set([target]) : new Set();
            renderBuildMatrix();
        });
        $('rc-clear-builds').addEventListener('click', () => {
            state.selectedTargets.clear();
            renderBuildMatrix();
        });
        $('rc-config-list').addEventListener('click', (event) => {
            const button = event.target.closest('[data-config-id]');
            if (button) selectConfig(button.dataset.configId).catch((error) => notify.error(error.message));
        });
        $('rc-build-list').addEventListener('click', (event) => {
            const sync = event.target.closest('[data-build-sync]');
            const cancel = event.target.closest('[data-build-cancel]');
            if (sync) syncBuild(sync.dataset.buildSync);
            if (cancel) cancelBuild(cancel.dataset.buildCancel);
        });
        $('rc-toggle-all-builds').addEventListener('click', () => {
            state.showAllBuilds = !state.showAllBuilds;
            loadBuilds().catch((error) => notify.error(error.message));
        });
        for (const kind of ['icon', 'logo', 'privacy']) {
            $(`rc-asset-${kind}`).addEventListener('change', (event) => uploadAsset(kind, event.target));
        }
        document.querySelectorAll('[data-rc-asset-clear]').forEach((button) => {
            button.addEventListener('click', () => {
                const kind = button.dataset.rcAssetClear;
                state.assets[kind] = null;
                $(`rc-asset-${kind}`).value = '';
                document.querySelector(`[data-asset-kind="${kind}"] .rc-asset-state`).textContent = 'Not selected';
                setDirty(true);
                updateBuildButton();
            });
        });
        $('rc-form').addEventListener('input', (event) => {
            if (!event.target.closest('.rc-build-section') && event.target.type !== 'file') setDirty(true);
            updateBuildButton();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !$('rc-panel').classList.contains('hidden')) closePanel();
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
    else bind();
})();
