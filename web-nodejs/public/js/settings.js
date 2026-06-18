/**
 * BetterDesk Console - Settings Page
 */

(function() {
    'use strict';
    
    document.addEventListener('DOMContentLoaded', init);
    
    function init() {
        initTabs();
        initPasswordForm();
        initTotpSection();
        initBrandingSection();

        // Only init server-config sections when the tab is visible (requires server.config permission)
        if (document.getElementById('tab-auth') && document.getElementById('tab-auth').style.display !== 'none') {
            initEnrollmentSection();
            initLdapSection();
            initOidcSection();
        }
        if (document.getElementById('tab-backup') && document.getElementById('tab-backup').style.display !== 'none') {
            initBackupSection();
        }
        if (document.getElementById('tab-updates') && document.getElementById('tab-updates').style.display !== 'none') {
            initUpdateSection();
        }
        if (document.getElementById('tab-advanced') && document.getElementById('tab-advanced').style.display !== 'none') {
            initAdvancedSection();
        }
        if (document.getElementById('tab-email') && document.getElementById('tab-email').style.display !== 'none') {
            initEmailSection();
        }

        initTutorialSection();
        loadAuditLog();
        loadServerInfo();
        initConnectionModeSection();
        
        // Refresh handler
        window.addEventListener('app:refresh', loadAuditLog);
    }
    
    // ==================== Tab Navigation ====================
    
    function initTabs() {
        const tabs = document.querySelectorAll('.settings-tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                // Deactivate all
                tabs.forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
                
                // Activate selected
                tab.classList.add('active');
                const target = document.getElementById('tab-' + tab.dataset.tab);
                if (target) target.classList.add('active');
            });
        });
        
        // Check URL hash for direct tab navigation
        const hash = window.location.hash.replace('#', '');
        if (['branding', 'server', 'backup', 'updates', 'auth', 'advanced', 'email'].includes(hash)) {
            const tab = document.querySelector(`[data-tab="${hash}"]`);
            if (tab) tab.click();
        }
    }
    
    /**
     * Initialize password change form
     */
    function initPasswordForm() {
        const form = document.getElementById('password-form');
        const newPassword = document.getElementById('new-password');
        
        if (!form) return;
        
        // Real-time password validation
        newPassword?.addEventListener('input', () => {
            validatePassword(newPassword.value);
        });
        
        // Form submission
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const currentPassword = document.getElementById('current-password').value;
            const newPass = document.getElementById('new-password').value;
            const confirmPass = document.getElementById('confirm-password').value;
            
            // Validation
            if (!currentPassword || !newPass || !confirmPass) {
                Notifications.error(_('settings.fill_all_fields'));
                return;
            }
            
            if (newPass !== confirmPass) {
                Notifications.error(_('settings.passwords_not_match'));
                return;
            }
            
            if (!validatePassword(newPass)) {
                Notifications.error(_('settings.password_requirements_not_met'));
                return;
            }
            
            try {
                await Utils.api('/api/auth/password', {
                    method: 'POST',
                    body: {
                        currentPassword: currentPassword,
                        newPassword: newPass,
                        confirmPassword: confirmPass
                    }
                });
                
                Notifications.success(_('settings.password_changed'));
                form.reset();
                
                // Reset validation indicators
                document.querySelectorAll('.password-requirements li').forEach(li => {
                    li.classList.remove('valid');
                });
                
            } catch (error) {
                Notifications.error(error.message || _('errors.password_change_failed'));
            }
        });
    }
    
    /**
     * Validate password and update UI indicators
     */
    function validatePassword(password) {
        const requirements = {
            'req-length': password.length >= 8,
            'req-uppercase': /[A-Z]/.test(password),
            'req-lowercase': /[a-z]/.test(password),
            'req-number': /[0-9]/.test(password)
        };
        
        let allMet = true;
        
        for (const [id, met] of Object.entries(requirements)) {
            const el = document.getElementById(id);
            if (el) {
                el.classList.toggle('valid', met);
            }
            if (!met) allMet = false;
        }
        
        return allMet;
    }
    
    /**
     * Load audit log
     */
    async function loadAuditLog() {
        const tbody = document.getElementById('audit-log-body');
        if (!tbody) return;
        
        try {
            const logs = await Utils.api('/api/settings/audit');
            
            if (!logs || logs.length === 0) {
                tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">${_('settings.no_audit_logs')}</td></tr>`;
                return;
            }
            
            tbody.innerHTML = logs.map(log => {
                var actionKey = 'audit.action_' + (log.action || '').replace(/[^a-z0-9_]/gi, '_');
                var actionLabel = typeof _ === 'function' ? _(actionKey) : log.action;
                if (actionLabel === actionKey) actionLabel = log.action;
                var actionClass = String(log.action || '').replace(/[^a-z0-9_-]/gi, '');
                return `
                <tr>
                    <td>${Utils.formatDate(log.created_at)}</td>
                    <td>${Utils.escapeHtml(log.username || '-')}</td>
                    <td><span class="audit-action ${actionClass}">${Utils.escapeHtml(actionLabel)}</span></td>
                    <td>${Utils.escapeHtml(log.details || '-')}</td>
                </tr>
            `;
            }).join('');
            
        } catch (error) {
            tbody.innerHTML = `<tr><td colspan="4" class="text-center text-danger">${_('errors.load_audit_failed')}</td></tr>`;
        }
    }
    
    /**
     * Load server info
     */
    async function loadServerInfo() {
        try {
            const data = await Utils.api('/api/settings/info');
            
            document.getElementById('db-path').textContent = data.paths?.database || '-';
            document.getElementById('uptime').textContent = formatUptime(data.server?.uptime);

            const goVerEl = document.getElementById('go-server-version');
            if (goVerEl) {
                const goVer = data.goServer?.version;
                goVerEl.textContent = goVer ? `v${goVer}` : '-';
                if (goVer && goVer === 'dev' && data.app?.version && data.app.version !== 'dev') {
                    goVerEl.title = typeof _ === 'function' ? _('settings.go_server_version_dev_hint') : '';
                } else {
                    goVerEl.title = '';
                }
            }
            
        } catch (error) {
            console.error('Failed to load server info:', error);
        }
    }
    
    /**
     * Format uptime in human-readable format
     */
    function formatUptime(seconds) {
        if (!seconds || seconds < 0) return '-';
        
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        
        const parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
        
        return parts.join(' ');
    }

    // ==================== Connection Mode (P2P / Relay) ====================

    function initConnectionModeSection() {
        const section = document.getElementById('connection-mode-section');
        if (!section) return;

        const saveBtn = document.getElementById('connection-mode-save');
        const saveRestartBtn = document.getElementById('connection-mode-save-restart');
        saveBtn?.addEventListener('click', () => saveConnectionMode(false));
        saveRestartBtn?.addEventListener('click', () => saveConnectionMode(true));

        loadConnectionMode();
    }

    async function loadConnectionMode() {
        const sourceEl = document.getElementById('connection-mode-source');
        const runtimeEl = document.getElementById('connection-mode-runtime');
        try {
            const resp = await Utils.api('/api/settings/connection-mode');
            const data = resp.data || resp;
            const mode = data.mode || 'p2p_first';
            const p2pRadio = document.getElementById('conn-mode-p2p');
            const relayRadio = document.getElementById('conn-mode-relay');
            if (p2pRadio) p2pRadio.checked = mode === 'p2p_first';
            if (relayRadio) relayRadio.checked = mode === 'relay_only';

            const fallbackInput = document.getElementById('conn-p2p-fallback-ms');
            if (fallbackInput && data.p2p_fallback_ms != null) {
                fallbackInput.value = data.p2p_fallback_ms;
            }
            const sameNat = document.getElementById('conn-same-nat-relay');
            if (sameNat) sameNat.checked = data.same_nat_relay !== false;

            if (sourceEl) {
                const src = data.source || data.deployment || 'defaults';
                const writable = data.writable !== false && src !== 'defaults';
                sourceEl.textContent = writable
                    ? (_('settings.connection_mode_source_saved') || 'Saved in') + ': ' + src
                    : (_('settings.connection_mode_source_defaults') || 'Using server defaults (not writable from panel)');
            }

            if (runtimeEl && data.runtime) {
                const r = data.runtime;
                runtimeEl.hidden = false;
                runtimeEl.textContent = (_('settings.connection_mode_runtime') || 'Active server') + ': '
                    + (r.always_use_relay ? 'relay only' : 'P2P first')
                    + ', fallback=' + (r.p2p_fallback_ms ?? '-')
                    + 'ms, same_nat_relay=' + (r.same_nat_relay ? 'Y' : 'N');
            } else if (runtimeEl) {
                runtimeEl.hidden = true;
            }

            const saveBtns = [document.getElementById('connection-mode-save'), document.getElementById('connection-mode-save-restart')];
            const disabled = data.writable === false || data.source === 'defaults';
            saveBtns.forEach((b) => { if (b) b.disabled = disabled; });
        } catch (err) {
            console.error('Failed to load connection mode:', err);
            if (sourceEl) sourceEl.textContent = _('errors.server_error');
        }
    }

    function getConnectionModePayload() {
        const mode = document.querySelector('input[name="connection-mode"]:checked')?.value || 'p2p_first';
        const fallbackMs = parseInt(document.getElementById('conn-p2p-fallback-ms')?.value, 10);
        const sameNatRelay = document.getElementById('conn-same-nat-relay')?.checked !== false;
        return {
            mode,
            p2p_fallback_ms: Number.isFinite(fallbackMs) ? fallbackMs : 2000,
            same_nat_relay: sameNatRelay
        };
    }

    async function saveConnectionMode(restart) {
        const saveBtn = document.getElementById('connection-mode-save');
        const saveRestartBtn = document.getElementById('connection-mode-save-restart');
        [saveBtn, saveRestartBtn].forEach((b) => { if (b) b.disabled = true; });

        try {
            const payload = getConnectionModePayload();
            payload.restart = restart;
            const resp = await Utils.api('/api/settings/connection-mode', {
                method: 'PUT',
                body: JSON.stringify(payload)
            });

            if (typeof Notifications !== 'undefined') {
                Notifications.success(resp.message || _('settings.connection_mode_saved'));
            }

            if (restart && resp.data?.restart) {
                const failed = (resp.data.restart.restarts || []).filter((r) => !r.success);
                if (failed.length) {
                    Notifications.warning(_('settings.connection_mode_restart_failed'));
                }
            }

            await loadConnectionMode();
        } catch (err) {
            console.error('Save connection mode failed:', err);
            if (typeof Notifications !== 'undefined') {
                Notifications.error(err.message || _('errors.server_error'));
            }
        } finally {
            [saveBtn, saveRestartBtn].forEach((b) => { if (b) b.disabled = false; });
        }
    }
    
    // ==================== TOTP (2FA) Section ====================
    
    /**
     * Initialize TOTP section
     */
    async function initTotpSection() {
        const container = document.getElementById('totp-status-container');
        if (!container) return;
        
        try {
            const data = await Utils.api('/api/auth/totp/status');
            
            if (data.enabled) {
                renderTotpEnabled(container);
            } else {
                renderTotpDisabled(container);
            }
        } catch (error) {
            container.innerHTML = `<p class="text-danger">${_('errors.server_error')}</p>`;
        }
    }
    
    /**
     * Render TOTP enabled state
     */
    function renderTotpEnabled(container) {
        container.innerHTML = `
            <div class="totp-status totp-enabled">
                <div class="totp-status-badge">
                    <span class="material-icons">verified_user</span>
                    <span>${_('settings.totp_enabled')}</span>
                </div>
                <p class="totp-status-desc">${_('settings.totp_enabled_desc')}</p>
                <button class="btn btn-danger" id="totp-disable-btn">
                    <span class="material-icons">lock_open</span>
                    ${_('settings.totp_disable')}
                </button>
            </div>
        `;
        
        document.getElementById('totp-disable-btn')?.addEventListener('click', handleDisableTotp);
    }
    
    /**
     * Render TOTP disabled state
     */
    function renderTotpDisabled(container) {
        container.innerHTML = `
            <div class="totp-status totp-disabled">
                <div class="totp-status-badge disabled">
                    <span class="material-icons">shield</span>
                    <span>${_('settings.totp_disabled')}</span>
                </div>
                <p class="totp-status-desc">${_('settings.totp_disabled_desc')}</p>
                <button class="btn btn-primary" id="totp-setup-btn">
                    <span class="material-icons">qr_code_2</span>
                    ${_('settings.totp_setup')}
                </button>
            </div>
        `;
        
        document.getElementById('totp-setup-btn')?.addEventListener('click', handleSetupTotp);
    }
    
    /**
     * Handle TOTP setup flow
     */
    async function handleSetupTotp() {
        const container = document.getElementById('totp-status-container');
        
        try {
            const data = await Utils.api('/api/auth/totp/setup', { method: 'POST' });
            
            container.innerHTML = `
                <div class="totp-setup">
                    <div class="totp-setup-steps">
                        <div class="totp-step">
                            <span class="step-number">1</span>
                            <span>${_('settings.totp_step1')}</span>
                        </div>
                        <div class="totp-step">
                            <span class="step-number">2</span>
                            <span>${_('settings.totp_step2')}</span>
                        </div>
                        <div class="totp-step">
                            <span class="step-number">3</span>
                            <span>${_('settings.totp_step3')}</span>
                        </div>
                    </div>
                    
                    <div class="totp-qr-container">
                        <img src="${data.qrCode}" alt="QR Code" class="totp-qr-image">
                    </div>
                    
                    <div class="totp-manual-key">
                        <p class="totp-manual-label">${_('settings.totp_manual_key')}:</p>
                        <code class="totp-secret-code">${data.secret}</code>
                        <button class="btn btn-sm btn-ghost" id="totp-copy-secret-btn">
                            <span class="material-icons" style="font-size: 16px;">content_copy</span>
                        </button>
                    </div>
                    
                    <div class="totp-verify-form">
                        <label class="form-label">${_('settings.totp_enter_code')}:</label>
                        <div class="totp-verify-input-group">
                            <input type="text" id="totp-setup-code" class="form-input totp-input" 
                                   placeholder="000000" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autofocus>
                            <button class="btn btn-primary" id="totp-verify-btn">
                                <span class="material-icons">check</span>
                                ${_('settings.totp_verify_enable')}
                            </button>
                        </div>
                    </div>
                    
                    <button class="btn btn-ghost totp-cancel-btn" id="totp-cancel-btn">
                        ${_('actions.cancel')}
                    </button>
                </div>
            `;
            
            // Handle verify
            document.getElementById('totp-verify-btn')?.addEventListener('click', async () => {
                const code = document.getElementById('totp-setup-code').value.trim();
                if (!code || code.length !== 6) {
                    Notifications.error(_('auth.totp_enter_code'));
                    return;
                }
                
                try {
                    const result = await Utils.api('/api/auth/totp/enable', {
                        method: 'POST',
                        body: { code }
                    });
                    
                    // Show recovery codes
                    showRecoveryCodes(container, result.recoveryCodes);
                    
                } catch (err) {
                    Notifications.error(err.message || _('auth.totp_invalid_code'));
                }
            });
            
            // Auto-submit on 6 digits
            document.getElementById('totp-setup-code')?.addEventListener('input', (e) => {
                e.target.value = e.target.value.replace(/[^0-9]/g, '');
            });
            
            // Cancel
            document.getElementById('totp-cancel-btn')?.addEventListener('click', () => {
                initTotpSection();
            });

            document.getElementById('totp-copy-secret-btn')?.addEventListener('click', () => {
                navigator.clipboard.writeText(data.secret).catch(() => {});
            });
            
        } catch (error) {
            Notifications.error(error.message || _('errors.server_error'));
        }
    }
    
    /**
     * Show recovery codes after enabling TOTP
     */
    function showRecoveryCodes(container, codes) {
        container.innerHTML = `
            <div class="totp-recovery">
                <div class="totp-success-header">
                    <span class="material-icons totp-success-icon">verified_user</span>
                    <h3>${_('settings.totp_enabled_success')}</h3>
                </div>
                
                <div class="totp-recovery-warning">
                    <span class="material-icons">warning</span>
                    <p>${_('settings.totp_recovery_warning')}</p>
                </div>
                
                <div class="totp-recovery-codes">
                    ${codes.map(code => `<code class="recovery-code">${code}</code>`).join('')}
                </div>
                
                <div class="totp-recovery-actions">
                    <button class="btn btn-secondary" id="copy-recovery-btn">
                        <span class="material-icons">content_copy</span>
                        ${_('actions.copy')}
                    </button>
                </div>
                
                <button class="btn btn-primary totp-done-btn" id="totp-done-btn">
                    <span class="material-icons">check</span>
                    ${_('settings.totp_done')}
                </button>
            </div>
        `;
        
        document.getElementById('copy-recovery-btn')?.addEventListener('click', () => {
            navigator.clipboard.writeText(codes.join('\n'));
            Notifications.success(_('common.copied'));
        });
        
        document.getElementById('totp-done-btn')?.addEventListener('click', () => {
            initTotpSection();
        });
        
        Notifications.success(_('settings.totp_enabled_success'));
    }
    
    /**
     * Handle TOTP disable
     */
    async function handleDisableTotp() {
        const container = document.getElementById('totp-status-container');
        
        container.innerHTML = `
            <div class="totp-disable-confirm">
                <div class="totp-disable-warning">
                    <span class="material-icons">warning</span>
                    <p>${_('settings.totp_disable_warning')}</p>
                </div>
                <div class="form-group">
                    <label class="form-label">${_('settings.current_password')}:</label>
                    <input type="password" id="totp-disable-password" class="form-input" 
                           placeholder="${_('auth.password_placeholder')}" required>
                </div>
                <div class="totp-disable-actions">
                    <button class="btn btn-danger" id="confirm-disable-btn">
                        <span class="material-icons">lock_open</span>
                        ${_('settings.totp_disable')}
                    </button>
                    <button class="btn btn-ghost" id="cancel-disable-btn">
                        ${_('actions.cancel')}
                    </button>
                </div>
            </div>
        `;
        
        document.getElementById('confirm-disable-btn')?.addEventListener('click', async () => {
            const password = document.getElementById('totp-disable-password').value;
            if (!password) {
                Notifications.error(_('auth.fill_all_fields'));
                return;
            }
            
            try {
                await Utils.api('/api/auth/totp/disable', {
                    method: 'POST',
                    body: { password }
                });
                
                Notifications.success(_('settings.totp_disabled_success'));
                initTotpSection();
                
            } catch (err) {
                Notifications.error(err.message || _('errors.server_error'));
            }
        });
        
        document.getElementById('cancel-disable-btn')?.addEventListener('click', () => {
            initTotpSection();
        });
    }
    
    // ==================== Branding / Theming Section ====================
    
    let brandingData = null;
    let _brandingSnapshot = null;
    let _brandingDirty = false;
    let _previewDebounce = null;
    let _autosaveDebounce = null;
    let _canBrandingEdit = true;
    let _fontSource = 'google';
    let _brandingProfiles = [];
    const _backgroundUploads = new Map();
    
    /**
     * Initialize branding configuration section
     */
    async function initBrandingSection() {
        const tab = document.getElementById('tab-branding');
        if (!tab) return;

        _canBrandingEdit = tab.dataset.canBrandingEdit !== '0';

        try {
            const response = await Utils.api('/api/settings/branding');
            brandingData = response.data || response;
            
            populateBrandingForm(brandingData);
            _brandingSnapshot = JSON.stringify(collectBrandingData());
            initBrandingModules();
            initLogoTypeSelector();
            initColorPickers();
            initFontPickers();
            initFontSourceTabs();
            initBackgroundSelectors();
            initBrandingProfiles();
            initBuiltinThemes();
            initBrandingActions();
            initBrandingLivePreview();
            setBrandingStatus('saved');
            
        } catch (error) {
            console.error('Failed to load branding:', error);
        }
    }

    function initBrandingModules() {
        const nav = document.getElementById('branding-module-nav');
        if (!nav) return;
        nav.querySelectorAll('.branding-module-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const module = btn.dataset.brandingModule;
                nav.querySelectorAll('.branding-module-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                document.querySelectorAll('.branding-module-panel').forEach(panel => {
                    panel.classList.toggle('active', panel.dataset.brandingModule === module);
                });
            });
        });
    }

    function setBrandingStatus(state, message) {
        const statusEl = document.getElementById('branding-save-status');
        const textEl = document.getElementById('branding-status-text');
        if (!statusEl || !textEl) return;
        statusEl.classList.remove('is-dirty', 'is-saving', 'is-saved', 'is-error');
        const map = {
            saved: [_('branding.status_saved'), 'is-saved', 'check_circle'],
            dirty: [_('branding.status_dirty'), 'is-dirty', 'edit'],
            saving: [_('branding.status_saving'), 'is-saving', 'sync'],
            error: [_('branding.status_error'), 'is-error', 'error']
        };
        const cfg = map[state] || map.saved;
        textEl.textContent = message || cfg[0];
        statusEl.classList.add(cfg[1]);
        const icon = statusEl.querySelector('.branding-status-icon');
        if (icon) icon.textContent = cfg[2];
        if (state === 'saving' && icon) icon.classList.add('spinning');
        else if (icon) icon.classList.remove('spinning');
    }

    function onBrandingFieldChange() {
        const current = JSON.stringify(collectBrandingData());
        _brandingDirty = current !== _brandingSnapshot;
        if (_brandingDirty) setBrandingStatus('dirty');
        scheduleBrandingPreview();
        if (_canBrandingEdit) scheduleBrandingAutosave();
    }

    function scheduleBrandingPreview() {
        clearTimeout(_previewDebounce);
        _previewDebounce = setTimeout(() => {
            if (typeof BrandingPreview !== 'undefined') {
                const applyPage = document.getElementById('branding-preview-page-toggle')?.checked;
                BrandingPreview.apply(collectBrandingData(), { applyToPage: !!applyPage });
            }
            updateLogoPreview();
        }, 100);
    }

    function scheduleBrandingAutosave() {
        if (!_canBrandingEdit) return;
        clearTimeout(_autosaveDebounce);
        _autosaveDebounce = setTimeout(() => saveBrandingNow({ silent: true }), 1500);
    }

    async function saveBrandingNow(options = {}) {
        if (!_canBrandingEdit) return;
        setBrandingStatus('saving');
        try {
            await waitForBackgroundUploads();
            const data = collectBrandingData();
            const resp = await Utils.api('/api/settings/branding', {
                method: 'POST',
                body: data
            });
            brandingData = resp.data || data;
            _brandingSnapshot = JSON.stringify(collectBrandingData());
            _brandingDirty = false;
            setBrandingStatus('saved', options.silent ? _('branding.autosaved') : _('branding.saved'));
            if (typeof BrandingPreview !== 'undefined') {
                const rev = resp.revision || Date.now();
                BrandingPreview.refreshBrandingStylesheet(rev);
            }
            applyBrandingToChrome(data);
            if (!options.silent) {
                Notifications.success(_('branding.saved'));
            }
        } catch (error) {
            setBrandingStatus('error', error.message || _('errors.server_error'));
            if (!options.silent) Notifications.error(error.message || _('errors.server_error'));
        }
    }

    async function waitForBackgroundUploads() {
        const pending = Array.from(_backgroundUploads.values());
        if (!pending.length) return;
        await Promise.all(pending);
    }

    function revertBrandingChanges() {
        if (!_brandingSnapshot) return;
        try {
            const data = JSON.parse(_brandingSnapshot);
            populateBrandingForm(data);
            _brandingDirty = false;
            setBrandingStatus('saved');
            scheduleBrandingPreview();
            if (typeof BrandingPreview !== 'undefined') BrandingPreview.clearPagePreview();
        } catch (e) {
            console.error('Revert failed:', e);
        }
    }

    function applyBrandingToChrome(data) {
        const name = data.appName || 'BetterDesk';
        document.querySelectorAll('.sidebar-logo-text, .brand-text-logo').forEach(el => {
            if (data.logoType === 'text' && data.logoText) {
                el.textContent = data.logoText;
            }
        });
        document.title = document.title.replace(/^[^-]+/, name);
        const favicon = document.querySelector('link[rel="icon"]');
        if (favicon) favicon.href = `/branding/favicon.svg?v=${Date.now()}`;
    }

    function initBrandingLivePreview() {
        document.getElementById('branding-preview-page-toggle')?.addEventListener('change', scheduleBrandingPreview);
        const tab = document.getElementById('tab-branding');
        if (!tab) return;
        tab.addEventListener('input', (e) => {
            if (e.target.closest('#tab-branding')) onBrandingFieldChange();
        });
        tab.addEventListener('change', (e) => {
            if (e.target.closest('#tab-branding')) onBrandingFieldChange();
        });
        scheduleBrandingPreview();
    }

    async function initBrandingProfiles() {
        const select = document.getElementById('branding-profile-select');
        if (!select) return;
        await refreshBrandingProfiles(select);

        document.getElementById('branding-profile-apply-btn')?.addEventListener('click', async () => {
            const id = parseInt(select.value, 10);
            if (!id) return;
            try {
                const resp = await Utils.api(`/api/settings/branding/profiles/${id}/apply`, { method: 'POST' });
                brandingData = resp.data || brandingData;
                populateBrandingForm(brandingData);
                _brandingSnapshot = JSON.stringify(collectBrandingData());
                _brandingDirty = false;
                setBrandingStatus('saved');
                scheduleBrandingPreview();
                if (typeof BrandingPreview !== 'undefined') {
                    BrandingPreview.refreshBrandingStylesheet(resp.revision || Date.now());
                }
                Notifications.success(_('branding.profile_applied'));
            } catch (e) {
                Notifications.error(e.message || _('errors.server_error'));
            }
        });

        document.getElementById('branding-profile-new-btn')?.addEventListener('click', async () => {
            const name = prompt(_('branding.profile_name_prompt'));
            if (!name || !name.trim()) return;
            try {
                await Utils.api('/api/settings/branding/profiles', {
                    method: 'POST',
                    body: { name: name.trim(), description: '', branding: collectBrandingData() }
                });
                await refreshBrandingProfiles(select);
                Notifications.success(_('branding.profile_created'));
            } catch (e) {
                Notifications.error(e.message || _('errors.server_error'));
            }
        });

        document.getElementById('branding-profile-save-btn')?.addEventListener('click', async () => {
            const id = parseInt(select.value, 10);
            if (!id) {
                Notifications.error(_('branding.profile_select_first'));
                return;
            }
            try {
                await Utils.api(`/api/settings/branding/profiles/${id}`, {
                    method: 'PUT',
                    body: { branding: collectBrandingData() }
                });
                Notifications.success(_('branding.profile_updated'));
            } catch (e) {
                Notifications.error(e.message || _('errors.server_error'));
            }
        });

        document.getElementById('branding-profile-duplicate-btn')?.addEventListener('click', async () => {
            const id = parseInt(select.value, 10);
            if (!id) return;
            try {
                await Utils.api(`/api/settings/branding/profiles/${id}/duplicate`, { method: 'POST', body: {} });
                await refreshBrandingProfiles(select);
                Notifications.success(_('branding.profile_duplicated'));
            } catch (e) {
                Notifications.error(e.message || _('errors.server_error'));
            }
        });

        document.getElementById('branding-profile-delete-btn')?.addEventListener('click', async () => {
            const id = parseInt(select.value, 10);
            if (!id) return;
            if (!confirm(_('branding.profile_delete_confirm'))) return;
            try {
                await Utils.api(`/api/settings/branding/profiles/${id}`, { method: 'DELETE' });
                await refreshBrandingProfiles(select);
                Notifications.success(_('branding.profile_deleted'));
            } catch (e) {
                Notifications.error(e.message || _('errors.server_error'));
            }
        });
    }

    async function refreshBrandingProfiles(select) {
        try {
            const resp = await Utils.api('/api/settings/branding/profiles');
            _brandingProfiles = resp.data || resp || [];
            select.innerHTML = `<option value="">${_('branding.profile_none')}</option>`;
            _brandingProfiles.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = p.is_active ? `${p.name} (${_('branding.profile_active')})` : p.name;
                if (p.is_active) opt.selected = true;
                select.appendChild(opt);
            });
        } catch (e) {
            console.warn('Failed to load profiles:', e);
        }
    }

    async function initBuiltinThemes() {
        const gallery = document.getElementById('branding-theme-gallery');
        if (!gallery) return;
        try {
            const resp = await Utils.api('/api/settings/themes');
            const themes = resp.data || resp || [];
            gallery.innerHTML = '';
            themes.forEach(theme => {
                const card = document.createElement('button');
                card.type = 'button';
                card.className = 'branding-theme-card';
                card.title = theme.description || theme.name;
                const colors = theme.colors || {};
                const swatches = ['bgPrimary', 'bgSecondary', 'accentBlue', 'accentGreen']
                    .map(k => colors[k] || '#30363d')
                    .map(c => `<span class="branding-theme-swatch" style="background:${Utils.escapeHtml(c)}"></span>`)
                    .join('');
                card.innerHTML = `<div class="branding-theme-swatches">${swatches}</div><span class="branding-theme-name">${Utils.escapeHtml(theme.name || theme.id)}</span>`;
                card.addEventListener('click', async () => {
                    if (!_canBrandingEdit) return;
                    if (!confirm(_('branding.theme_apply_confirm'))) return;
                    try {
                        await Utils.api(`/api/settings/themes/${encodeURIComponent(theme.id)}/apply`, { method: 'POST' });
                        const fresh = await Utils.api('/api/settings/branding');
                        brandingData = fresh.data || fresh;
                        populateBrandingForm(brandingData);
                        _brandingSnapshot = JSON.stringify(collectBrandingData());
                        _brandingDirty = false;
                        setBrandingStatus('saved');
                        scheduleBrandingPreview();
                        if (typeof BrandingPreview !== 'undefined') BrandingPreview.refreshBrandingStylesheet(Date.now());
                        Notifications.success(_('branding.theme_applied'));
                    } catch (e) {
                        Notifications.error(e.message || _('errors.server_error'));
                    }
                });
                gallery.appendChild(card);
            });
        } catch (e) {
            console.warn('Builtin themes failed:', e);
        }
    }

    function initFontSourceTabs() {
        document.querySelectorAll('.font-source-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                _fontSource = tab.dataset.fontSource || 'google';
                document.querySelectorAll('.font-source-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                document.querySelectorAll('.font-source-panel').forEach(p => p.classList.remove('active'));
                const panel = document.getElementById(`font-source-${_fontSource}`);
                if (panel) panel.classList.add('active');
                if (_fontSource === 'local') renderLocalFontList();
            });
        });

        document.getElementById('font-upload-file')?.addEventListener('change', handleFontUpload);

        renderLocalFontList();
    }

    async function renderLocalFontList() {
        const list = document.getElementById('font-local-list');
        if (!list) return;
        try {
            const fonts = await Utils.api('/api/settings/fonts/local');
            list.innerHTML = '';
            if (!fonts || !fonts.length) {
                list.innerHTML = `<div class="font-dropdown-empty">${_('branding.font_local_empty')}</div>`;
                return;
            }
            fonts.forEach(font => {
                const row = document.createElement('div');
                row.className = 'font-local-item';
                row.innerHTML = `
                    <span style="font-family:'${Utils.escapeHtml(font.family)}',sans-serif">${Utils.escapeHtml(font.family)}</span>
                    <button type="button" class="btn btn-ghost btn-sm font-local-delete" data-family="${Utils.escapeHtml(font.family)}" title="${_('branding.font_delete')}">
                        <span class="material-icons">delete</span>
                    </button>`;
                row.querySelector('.font-local-delete')?.addEventListener('click', async () => {
                    try {
                        await Utils.api(`/api/settings/fonts/${encodeURIComponent(font.family)}`, { method: 'DELETE' });
                        renderLocalFontList();
                        loadLocalFontCount();
                    } catch (e) {
                        Notifications.error(e.message || _('errors.server_error'));
                    }
                });
                list.appendChild(row);
            });
        } catch (e) {
            list.innerHTML = `<div class="font-dropdown-empty">${_('errors.server_error')}</div>`;
        }
    }

    async function handleFontUpload(e) {
        const file = e.target.files[0];
        if (!file || !_canBrandingEdit) return;
        const family = document.getElementById('font-upload-name')?.value.trim() || file.name.replace(/\.[^.]+$/, '');
        const formData = new FormData();
        formData.append('font', file);
        formData.append('family', family);
        try {
            const resp = await fetch('/api/settings/fonts/upload', {
                method: 'POST',
                headers: { 'x-csrf-token': window.BetterDesk?.csrfToken || '' },
                body: formData
            });
            const result = await resp.json();
            if (!resp.ok || !result.success) throw new Error(result.error || 'Upload failed');
            Notifications.success(_('branding.font_upload_success'));
            renderLocalFontList();
            loadLocalFontCount();
            e.target.value = '';
        } catch (err) {
            Notifications.error(err.message || _('errors.server_error'));
            e.target.value = '';
        }
    }
    
    /**
     * Populate branding form with current config
     */
    function populateBrandingForm(data) {
        // Identity fields
        const nameInput = document.getElementById('brand-name');
        const descInput = document.getElementById('brand-description');
        if (nameInput) nameInput.value = data.appName || '';
        if (descInput) descInput.value = data.appDescription || '';
        
        // Logo type
        const logoTypeRadio = document.querySelector(`input[name="logo-type"][value="${data.logoType || 'icon'}"]`);
        if (logoTypeRadio) {
            logoTypeRadio.checked = true;
            showLogoPanel(data.logoType || 'icon');
        }
        
        // Logo fields
        const iconInput = document.getElementById('logo-icon-name');
        const svgInput = document.getElementById('logo-svg-input');
        const imageInput = document.getElementById('logo-image-url');
        const textInput = document.getElementById('logo-text-input');
        const textAccentInput = document.getElementById('logo-text-accent');
        if (iconInput) iconInput.value = data.logoIcon || 'dns';
        if (svgInput) svgInput.value = data.logoSvg || '';
        if (imageInput) imageInput.value = data.logoUrl || '';
        if (textInput) textInput.value = data.logoText || '';
        if (textAccentInput) textAccentInput.value = data.logoTextAccent || '';
        
        // Font fields
        if (data.fontHeading) {
            setFontPickerValue('heading', data.fontHeading);
        }
        if (data.fontBody) {
            setFontPickerValue('body', data.fontBody);
        }
        
        // Colors
        if (data.colors) {
            for (const [key, value] of Object.entries(data.colors)) {
                if (!value) continue;
                const picker = document.querySelector(`.color-picker[data-color="${key}"]`);
                const hex = document.querySelector(`.color-hex[data-color="${key}"]`);
                if (picker) picker.value = value;
                if (hex) hex.value = value;
            }
        }
        
        // Background & appearance (console)
        const setVal = (id, val) => { const el = document.getElementById(id); if (el != null && el) el.value = val; };
        const setChecked = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
        const checkRadio = (name, val) => {
            const r = document.querySelector(`input[name="${name}"][value="${val}"]`);
            if (r) r.checked = true;
        };
        checkRadio('bg-type', data.bgType || 'none');
        setVal('bg-color', data.bgColor || '');
        setVal('bg-gradient', data.bgGradient || '');
        setVal('bg-image-url', data.bgImageUrl || '');
        setVal('bg-blur', data.bgBlur || '0');
        setVal('bg-overlay', data.bgOverlay || '0');
        setVal('bg-size', data.bgSize || 'cover');
        if (data.bgColor && document.getElementById('bg-color-picker') && /^#[0-9a-fA-F]{6}$/.test(data.bgColor)) {
            document.getElementById('bg-color-picker').value = data.bgColor;
        }
        const bgBlurVal = document.getElementById('bg-blur-value');
        if (bgBlurVal) bgBlurVal.textContent = data.bgBlur || '0';
        const bgOverlayVal = document.getElementById('bg-overlay-value');
        if (bgOverlayVal) bgOverlayVal.textContent = data.bgOverlay || '0';
        showBackgroundPanel('bg', data.bgType || 'none');

        // Glass surfaces
        setChecked('glass-enabled', data.glassEnabled !== 'false');
        setVal('glass-color', data.glassColor || '#161b22');
        setVal('glass-blur', data.glassBlur || '16');
        setVal('glass-opacity', data.glassOpacity || '55');
        if (data.glassColor && document.getElementById('glass-color-picker') && /^#[0-9a-fA-F]{6}$/.test(data.glassColor)) {
            document.getElementById('glass-color-picker').value = data.glassColor;
        }
        const glassBlurVal = document.getElementById('glass-blur-value');
        if (glassBlurVal) glassBlurVal.textContent = data.glassBlur || '16';
        const glassOpacityVal = document.getElementById('glass-opacity-value');
        if (glassOpacityVal) glassOpacityVal.textContent = data.glassOpacity || '55';
        
        // Login page
        setVal('login-title', data.loginTitle || '');
        setVal('login-subtitle', data.loginSubtitle || '');
        checkRadio('login-bg-type', data.loginBgType || 'inherit');
        setVal('login-bg-color', data.loginBgColor || '');
        setVal('login-bg-gradient', data.loginBgGradient || '');
        setVal('login-bg-image-url', data.loginBgImageUrl || '');
        setVal('login-bg-overlay', data.loginBgOverlay || '0');
        if (data.loginBgColor && document.getElementById('login-bg-color-picker') && /^#[0-9a-fA-F]{6}$/.test(data.loginBgColor)) {
            document.getElementById('login-bg-color-picker').value = data.loginBgColor;
        }
        const loginOverlayVal = document.getElementById('login-bg-overlay-value');
        if (loginOverlayVal) loginOverlayVal.textContent = data.loginBgOverlay || '0';
        showBackgroundPanel('login-bg', data.loginBgType || 'inherit');
        
        // Agent download page
        checkRadio('agent-bg-type', data.agentBgType || 'none');
        setVal('agent-bg-color', data.agentBgColor || '');
        setVal('agent-bg-gradient', data.agentBgGradient || '');
        setVal('agent-bg-image-url', data.agentBgImageUrl || '');
        setChecked('agent-show-powered', data.agentShowPoweredBy !== 'false');
        if (data.agentBgColor && document.getElementById('agent-bg-color-picker') && /^#[0-9a-fA-F]{6}$/.test(data.agentBgColor)) {
            document.getElementById('agent-bg-color-picker').value = data.agentBgColor;
        }
        showBackgroundPanel('agent-bg', data.agentBgType || 'none');
        
        // Footer & custom CSS
        setVal('footer-text', data.footerText || '');
        setChecked('show-powered', data.showPoweredBy !== 'false');
        setVal('custom-css', data.customCss || '');
        
        // Update preview
        updateLogoPreview();
    }
    
    /**
     * Show the active panel for a background group (bg / login-bg / agent-bg)
     * and hide the rest. "none"/"inherit" hide all detail panels.
     */
    function showBackgroundPanel(prefix, type) {
        ['none', 'inherit', 'color', 'gradient', 'image'].forEach(t => {
            const panel = document.getElementById(`${prefix}-${t}-panel`);
            if (panel) panel.classList.add('hidden');
        });
        const active = document.getElementById(`${prefix}-${type}-panel`);
        if (active) active.classList.remove('hidden');
    }
    
    /**
     * Wire background selectors: radio toggles, range value labels,
     * color picker sync and image uploads for console/login/agent groups.
     */
    function initBackgroundSelectors() {
        // Radio toggles for the three background groups
        [['bg-type', 'bg'], ['login-bg-type', 'login-bg'], ['agent-bg-type', 'agent-bg']].forEach(([name, prefix]) => {
            document.querySelectorAll(`input[name="${name}"]`).forEach(radio => {
                radio.addEventListener('change', () => showBackgroundPanel(prefix, radio.value));
            });
        });
        
        // Color picker <-> hex text sync for the standalone background pickers
        [['bg-color-picker', 'bg-color'], ['login-bg-color-picker', 'login-bg-color'], ['agent-bg-color-picker', 'agent-bg-color'], ['glass-color-picker', 'glass-color']].forEach(([pickerId, textId]) => {
            const picker = document.getElementById(pickerId);
            const text = document.getElementById(textId);
            if (picker && text) {
                picker.addEventListener('input', () => { text.value = picker.value; });
                text.addEventListener('input', () => {
                    if (/^#[0-9a-fA-F]{6}$/.test(text.value)) picker.value = text.value;
                });
            }
        });
        
        // Range value labels
        [['bg-blur', 'bg-blur-value'], ['bg-overlay', 'bg-overlay-value'], ['login-bg-overlay', 'login-bg-overlay-value'], ['glass-blur', 'glass-blur-value'], ['glass-opacity', 'glass-opacity-value']].forEach(([rangeId, labelId]) => {
            const range = document.getElementById(rangeId);
            const label = document.getElementById(labelId);
            if (range && label) {
                range.addEventListener('input', () => { label.textContent = range.value; });
            }
        });
        
        // Background image uploads (shared route, data-target picks the URL field)
        document.querySelectorAll('.branding-bg-file').forEach(input => {
            input.addEventListener('change', handleBackgroundFileUpload);
        });
    }
    
    /**
     * Handle background image upload — uploads to the shared background route
     * and fills the URL field referenced by the input's data-target attribute.
     */
    async function handleBackgroundFileUpload(e) {
        const file = e.target.files[0];
        if (!file) return;
        
        const maxSize = 8 * 1024 * 1024; // 8 MB
        if (file.size > maxSize) {
            Utils.showNotification(_('branding.bg_image_too_large'), 'error');
            e.target.value = '';
            return;
        }
        const validTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
        if (!validTypes.includes(file.type)) {
            Utils.showNotification(_('branding.bg_image_invalid_type'), 'error');
            e.target.value = '';
            return;
        }
        
        const targetId = e.target.dataset.target;
        const nameEl = getBackgroundFileNameElement(e.target);
        setBackgroundUploadStatus(nameEl, file.name, _('branding.status_saving'));
        
        const formData = new FormData();
        formData.append('background', file);

        const uploadKey = targetId || e.target.id;
        const uploadPromise = (async () => {
            const result = await uploadBackgroundImage(formData, (percent) => {
                setBackgroundUploadStatus(nameEl, file.name, `${percent}%`);
            });
            const urlInput = document.getElementById(targetId);
            if (urlInput) urlInput.value = result.url;
            setBackgroundUploadStatus(nameEl, file.name, result.url || 'OK');
            selectBackgroundImageType(targetId);
            onBrandingFieldChange();
            Notifications.success(_('branding.bg_upload_success'));
            return result.url;
        })();

        _backgroundUploads.set(uploadKey, uploadPromise);

        try {
            await uploadPromise;
        } catch (err) {
            setBackgroundUploadStatus(nameEl, file.name, err.message || _('errors.server_error'));
            Utils.showNotification(err.message || _('errors.server_error'), 'error');
        } finally {
            if (_backgroundUploads.get(uploadKey) === uploadPromise) {
                _backgroundUploads.delete(uploadKey);
            }
        }
    }

    function getBackgroundFileNameElement(input) {
        const map = {
            'bg-image-file': 'bg-file-name',
            'login-bg-image-file': 'login-bg-file-name',
            'agent-bg-image-file': 'agent-bg-file-name'
        };
        return document.getElementById(map[input.id])
            || document.getElementById(input.id.replace('-file', '-file-name'));
    }

    function setBackgroundUploadStatus(el, fileName, status) {
        if (!el) return;
        el.textContent = status ? `${fileName} (${status})` : fileName;
        el.title = el.textContent;
    }

    function uploadBackgroundImage(formData, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/settings/branding/upload-background');
            xhr.withCredentials = true;
            const token = window.BetterDesk?.csrfToken || '';
            if (token) xhr.setRequestHeader('x-csrf-token', token);
            xhr.responseType = 'json';

            xhr.upload.onprogress = (event) => {
                if (!event.lengthComputable || typeof onProgress !== 'function') return;
                const percent = Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100)));
                onProgress(percent);
            };

            xhr.onload = () => {
                const result = xhr.response || parseUploadJsonResponse(xhr.responseText);
                if (xhr.status < 200 || xhr.status >= 300 || !result?.success) {
                    reject(new Error(result?.error || `Upload failed (${xhr.status})`));
                    return;
                }
                if (typeof onProgress === 'function') onProgress(100);
                resolve(result);
            };

            xhr.onerror = () => reject(new Error('Upload failed'));
            xhr.onabort = () => reject(new Error('Upload cancelled'));
            xhr.send(formData);
        });
    }

    function parseUploadJsonResponse(text) {
        if (!text) return null;
        try {
            return JSON.parse(text);
        } catch (_) {
            return null;
        }
    }

    function selectBackgroundImageType(targetId) {
        const map = {
            'bg-image-url': ['bg-type', 'bg'],
            'login-bg-image-url': ['login-bg-type', 'login-bg'],
            'agent-bg-image-url': ['agent-bg-type', 'agent-bg']
        };
        const cfg = map[targetId];
        if (!cfg) return;
        const [radioName, prefix] = cfg;
        const imageRadio = document.querySelector(`input[name="${radioName}"][value="image"]`);
        if (imageRadio && !imageRadio.checked) {
            imageRadio.checked = true;
            showBackgroundPanel(prefix, 'image');
        }
    }
    
    /**
     * Initialize logo type selector
     */
    function initLogoTypeSelector() {
        const radios = document.querySelectorAll('input[name="logo-type"]');
        radios.forEach(radio => {
            radio.addEventListener('change', () => {
                showLogoPanel(radio.value);
                updateLogoPreview();
            });
        });
        
        // Live preview on input changes
        document.getElementById('logo-icon-name')?.addEventListener('input', updateLogoPreview);
        document.getElementById('logo-svg-input')?.addEventListener('input', updateLogoPreview);
        document.getElementById('logo-image-url')?.addEventListener('input', updateLogoPreview);
        document.getElementById('logo-text-input')?.addEventListener('input', updateLogoPreview);
        document.getElementById('logo-text-accent')?.addEventListener('input', updateLogoPreview);
        document.getElementById('brand-name')?.addEventListener('input', updateLogoPreview);
        
        // File upload handler
        document.getElementById('logo-image-file')?.addEventListener('change', handleLogoFileUpload);
    }
    
    /**
     * Show the correct logo config panel
     */
    function showLogoPanel(type) {
        document.querySelectorAll('.logo-config-panel').forEach(p => p.classList.add('hidden'));
        const panel = document.getElementById(`logo-${type}-panel`);
        if (panel) panel.classList.remove('hidden');
    }
    
    function isSafePreviewUrl(url) {
        const trimmed = String(url || '').trim();
        if (!trimmed) return false;
        if (trimmed.startsWith('//') || trimmed.includes('..')) return false;
        if (trimmed.startsWith('/')) return true;
        try {
            const parsed = new URL(trimmed, window.location.origin);
            return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch (_) {
            return false;
        }
    }

    /**
     * Sanitize SVG content to prevent XSS attacks.
     * Removes potentially dangerous elements and attributes.
     * @param {string} svg - Raw SVG string
     * @returns {string} - Sanitized SVG string
     */
    function sanitizeSvg(svg) {
        // Parse the SVG
        const parser = new DOMParser();
        const doc = parser.parseFromString(svg, 'image/svg+xml');
        
        // Check for parsing errors
        const parserError = doc.querySelector('parsererror');
        if (parserError) return '<!-- Invalid SVG -->';
        
        const svgEl = doc.querySelector('svg');
        if (!svgEl) return '<!-- No SVG element found -->';
        
        // Remove dangerous elements
        const dangerousTags = ['script', 'foreignobject', 'iframe', 'embed', 'object', 'applet'];
        dangerousTags.forEach(tag => {
            doc.querySelectorAll(tag).forEach(el => el.remove());
        });
        
        // Remove dangerous attributes from all elements
        const dangerousAttrs = [
            'onclick', 'ondblclick', 'onmousedown', 'onmouseup', 'onmouseover', 'onmousemove',
            'onmouseout', 'onmouseenter', 'onmouseleave', 'onkeydown', 'onkeypress', 'onkeyup',
            'onload', 'onerror', 'onabort', 'onfocus', 'onblur', 'onchange', 'onsubmit', 'onreset',
            'onselect', 'onunload', 'xlink:href'
        ];
        
        doc.querySelectorAll('*').forEach(el => {
            dangerousAttrs.forEach(attr => el.removeAttribute(attr));
            for (const attr of Array.from(el.attributes || [])) {
                if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
            }
            if (el.hasAttribute('href')) {
                const href = el.getAttribute('href').trim().toLowerCase();
                if (/^(javascript|data|vbscript|file):/.test(href)) {
                    el.removeAttribute('href');
                }
            }
            if (el.hasAttribute('xlink:href')) {
                const href = el.getAttribute('xlink:href').trim().toLowerCase();
                if (/^(javascript|data|vbscript|file):/.test(href)) {
                    el.removeAttribute('xlink:href');
                }
            }
        });
        
        return svgEl.outerHTML;
    }
    
    /**
     * Update logo preview
     */
    function updateLogoPreview() {
        const preview = document.getElementById('logo-preview');
        if (!preview) return;
        
        const type = document.querySelector('input[name="logo-type"]:checked')?.value || 'icon';
        const name = document.getElementById('brand-name')?.value || 'BetterDesk';
        
        if (type === 'text') {
            const logoText = document.getElementById('logo-text-input')?.value || name;
            const accentText = document.getElementById('logo-text-accent')?.value || '';
            const fontHeading = document.getElementById('font-heading-value')?.value || '';
            const fontStyle = fontHeading ? `font-family: '${Utils.escapeHtml(fontHeading)}', sans-serif;` : '';
            let html = `<span class="brand-text-logo brand-text-logo-lg" style="${fontStyle}">${Utils.escapeHtml(logoText)}`;
            if (accentText) {
                html += `<span class="brand-text-accent">${Utils.escapeHtml(accentText)}</span>`;
            }
            html += '</span>';
            preview.innerHTML = html;
        } else if (type === 'svg') {
            const svg = document.getElementById('logo-svg-input')?.value || '';
            if (svg.trim()) {
                preview.innerHTML = `<span class="logo-preview-svg">${sanitizeSvg(svg)}</span>`;
            } else {
                preview.innerHTML = `<span class="material-icons">code</span><span class="logo-preview-text">${Utils.escapeHtml(name)}</span>`;
            }
        } else if (type === 'image') {
            const url = document.getElementById('logo-image-url')?.value || '';
            if (url.trim() && isSafePreviewUrl(url)) {
                preview.innerHTML = `<img src="${Utils.escapeHtml(url)}" alt="${Utils.escapeHtml(name)}" style="max-height: 36px;">`;
            } else {
                preview.innerHTML = `<span class="material-icons">photo</span><span class="logo-preview-text">${Utils.escapeHtml(name)}</span>`;
            }
        } else {
            const icon = document.getElementById('logo-icon-name')?.value || 'dns';
            preview.innerHTML = `<span class="material-icons">${Utils.escapeHtml(icon)}</span><span class="logo-preview-text">${Utils.escapeHtml(name)}</span>`;
        }
    }
    
    /**
     * Handle logo image file upload — uploads to server disk and fills URL field
     */
    async function handleLogoFileUpload(e) {
        const file = e.target.files[0];
        if (!file) return;
        
        const maxSize = 2 * 1024 * 1024; // 2 MB
        if (file.size > maxSize) {
            Utils.showNotification(_('branding.logo_image_too_large'), 'error');
            e.target.value = '';
            return;
        }
        
        const validTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];
        if (!validTypes.includes(file.type)) {
            Utils.showNotification(_('branding.logo_image_invalid_type'), 'error');
            e.target.value = '';
            return;
        }
        
        // Show filename
        const nameEl = document.getElementById('logo-file-name');
        if (nameEl) nameEl.textContent = file.name;

        // Upload to server
        const formData = new FormData();
        formData.append('logo', file);

        try {
            const resp = await fetch('/api/settings/branding/upload-logo', {
                method: 'POST',
                headers: { 'x-csrf-token': window.BetterDesk?.csrfToken || '' },
                body: formData
            });
            const result = await resp.json();
            if (!resp.ok || !result.success) {
                throw new Error(result.error || 'Upload failed');
            }
            const urlInput = document.getElementById('logo-image-url');
            if (urlInput) urlInput.value = result.url;
            Notifications.success(_('branding.logo_upload_success'));
            updateLogoPreview();
        } catch (err) {
            Utils.showNotification(err.message || _('errors.server_error'), 'error');
        }
    }
    
    /**
     * Initialize color picker sync (picker <-> hex input)
     */
    function initColorPickers() {
        document.querySelectorAll('.color-picker').forEach(picker => {
            picker.addEventListener('input', () => {
                const key = picker.dataset.color;
                const hex = document.querySelector(`.color-hex[data-color="${key}"]`);
                if (hex) hex.value = picker.value;
                onBrandingFieldChange();
            });
        });
        
        document.querySelectorAll('.color-hex').forEach(hex => {
            hex.addEventListener('input', () => {
                const key = hex.dataset.color;
                const picker = document.querySelector(`.color-picker[data-color="${key}"]`);
                if (picker && /^#[0-9a-fA-F]{6}$/.test(hex.value)) {
                    picker.value = hex.value;
                }
                onBrandingFieldChange();
            });
        });
    }
    
    /**
     * Collect branding form data
     */
    function collectBrandingData() {
        const data = {
            appName: document.getElementById('brand-name')?.value || 'BetterDesk',
            appDescription: document.getElementById('brand-description')?.value || '',
            logoType: document.querySelector('input[name="logo-type"]:checked')?.value || 'icon',
            logoIcon: document.getElementById('logo-icon-name')?.value || 'dns',
            logoSvg: document.getElementById('logo-svg-input')?.value || '',
            logoUrl: document.getElementById('logo-image-url')?.value || '',
            logoText: document.getElementById('logo-text-input')?.value || '',
            logoTextAccent: document.getElementById('logo-text-accent')?.value || '',
            fontHeading: document.getElementById('font-heading-value')?.value || '',
            fontBody: document.getElementById('font-body-value')?.value || '',
            colors: {}
        };
        
        // Collect colors
        document.querySelectorAll('.color-hex').forEach(hex => {
            const key = hex.dataset.color;
            const value = hex.value.trim();
            if (value && /^#[0-9a-fA-F]{6}$/.test(value)) {
                data.colors[key] = value;
            }
        });
        
        // Background & appearance (console)
        data.bgType = document.querySelector('input[name="bg-type"]:checked')?.value || 'none';
        data.bgColor = document.getElementById('bg-color')?.value.trim() || '';
        data.bgGradient = document.getElementById('bg-gradient')?.value.trim() || '';
        data.bgImageUrl = document.getElementById('bg-image-url')?.value.trim() || '';
        data.bgBlur = document.getElementById('bg-blur')?.value || '';
        data.bgOverlay = document.getElementById('bg-overlay')?.value || '';
        data.bgSize = document.getElementById('bg-size')?.value || 'cover';

        // Glass surfaces
        data.glassEnabled = document.getElementById('glass-enabled')?.checked ? 'true' : 'false';
        data.glassColor = document.getElementById('glass-color')?.value.trim() || '';
        data.glassBlur = document.getElementById('glass-blur')?.value || '';
        data.glassOpacity = document.getElementById('glass-opacity')?.value || '';
        
        // Login page
        data.loginBgType = document.querySelector('input[name="login-bg-type"]:checked')?.value || 'inherit';
        data.loginBgColor = document.getElementById('login-bg-color')?.value.trim() || '';
        data.loginBgGradient = document.getElementById('login-bg-gradient')?.value.trim() || '';
        data.loginBgImageUrl = document.getElementById('login-bg-image-url')?.value.trim() || '';
        data.loginBgOverlay = document.getElementById('login-bg-overlay')?.value || '';
        data.loginTitle = document.getElementById('login-title')?.value.trim() || '';
        data.loginSubtitle = document.getElementById('login-subtitle')?.value.trim() || '';
        
        // Agent download page
        data.agentBgType = document.querySelector('input[name="agent-bg-type"]:checked')?.value || 'none';
        data.agentBgColor = document.getElementById('agent-bg-color')?.value.trim() || '';
        data.agentBgGradient = document.getElementById('agent-bg-gradient')?.value.trim() || '';
        data.agentBgImageUrl = document.getElementById('agent-bg-image-url')?.value.trim() || '';
        data.agentShowPoweredBy = document.getElementById('agent-show-powered')?.checked ? 'true' : 'false';
        
        // Footer & custom CSS
        data.footerText = document.getElementById('footer-text')?.value.trim() || '';
        data.showPoweredBy = document.getElementById('show-powered')?.checked ? 'true' : 'false';
        data.customCss = document.getElementById('custom-css')?.value || '';
        
        return data;
    }
    
    /**
     * Font picker state
     */
    let _fontSearchTimeout = null;
    let _fontCategory = '';
    let _fontPreviewLinks = {};

    /**
     * Set font picker value
     */
    function setFontPickerValue(slot, family) {
        const valueInput = document.getElementById(`font-${slot}-value`);
        const currentLabel = document.getElementById(`font-${slot}-current`);
        const preview = document.getElementById(`font-${slot}-preview`);
        const clearBtn = document.querySelector(`#font-${slot}-slot .font-clear-btn`);
        
        if (valueInput) valueInput.value = family || '';
        if (currentLabel) currentLabel.textContent = family || _('branding.font_system_default');
        if (clearBtn) clearBtn.style.display = family ? 'inline-flex' : 'none';
        
        if (preview) {
            if (family) {
                loadFontPreview(family);
                preview.style.fontFamily = `'${family}', sans-serif`;
            } else {
                preview.style.fontFamily = '';
            }
        }
    }

    /**
     * Load font preview via Google Fonts CSS
     */
    function loadFontPreview(family) {
        const key = family.replace(/\s+/g, '+');
        if (_fontPreviewLinks[key]) return;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@400;700&display=swap`;
        document.head.appendChild(link);
        _fontPreviewLinks[key] = link;
    }

    /**
     * Initialize font pickers
     */
    function initFontPickers() {
        ['heading', 'body'].forEach(slot => {
            const searchInput = document.getElementById(`font-${slot}-search`);
            const dropdown = document.getElementById(`font-${slot}-dropdown`);
            const clearBtn = document.querySelector(`#font-${slot}-slot .font-clear-btn`);
            
            if (!searchInput || !dropdown) return;

            // Search input
            searchInput.addEventListener('input', () => {
                clearTimeout(_fontSearchTimeout);
                _fontSearchTimeout = setTimeout(() => {
                    searchFonts(slot, searchInput.value.trim());
                }, 300);
            });

            searchInput.addEventListener('focus', () => {
                if (!dropdown.children.length) {
                    searchFonts(slot, '');
                }
                dropdown.style.display = 'block';
            });

            // Close dropdown on outside click
            document.addEventListener('click', (e) => {
                if (!e.target.closest(`#font-${slot}-slot`)) {
                    dropdown.style.display = 'none';
                }
            });

            // Clear button
            if (clearBtn) {
                clearBtn.addEventListener('click', () => {
                    setFontPickerValue(slot, '');
                    updateLogoPreview();
                });
            }
        });

        // Category filter buttons
        document.querySelectorAll('.font-cat-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.font-cat-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                _fontCategory = btn.dataset.category || '';
                // Re-search both slots with new category
                ['heading', 'body'].forEach(slot => {
                    const searchInput = document.getElementById(`font-${slot}-search`);
                    const dropdown = document.getElementById(`font-${slot}-dropdown`);
                    if (searchInput && dropdown && dropdown.style.display === 'block') {
                        searchFonts(slot, searchInput.value.trim());
                    }
                });
            });
        });

        // Load local fonts count
        loadLocalFontCount();
    }

    /**
     * Search fonts and populate dropdown
     */
    async function searchFonts(slot, query) {
        const dropdown = document.getElementById(`font-${slot}-dropdown`);
        if (!dropdown) return;

        try {
            const params = new URLSearchParams();
            if (query) params.set('q', query);
            if (_fontCategory) params.set('category', _fontCategory);
            if (_fontSource === 'google') params.set('source', 'google');
            
            const fonts = await Utils.api(`/api/settings/fonts?${params}`);
            
            dropdown.innerHTML = '';
            
            if (!fonts || !fonts.length) {
                dropdown.innerHTML = '<div class="font-dropdown-empty">No fonts found</div>';
                dropdown.style.display = 'block';
                return;
            }

            fonts.forEach(font => {
                const item = document.createElement('div');
                item.className = 'font-dropdown-item';
                
                loadFontPreview(font.family);
                
                item.innerHTML = `
                    <span class="font-item-name" style="font-family: '${Utils.escapeHtml(font.family)}', sans-serif">${Utils.escapeHtml(font.family)}</span>
                    <span class="font-item-meta">
                        <span class="font-item-category">${Utils.escapeHtml(font.category)}</span>
                        ${font.downloaded ? '<span class="font-item-local" title="Downloaded">●</span>' : ''}
                    </span>
                `;
                
                item.addEventListener('click', async () => {
                    // Auto-download if not yet cached
                    if (!font.downloaded) {
                        item.classList.add('font-downloading');
                        try {
                            await Utils.api('/api/settings/fonts/download', {
                                method: 'POST',
                                body: { family: font.family }
                            });
                            loadLocalFontCount();
                        } catch (e) {
                            // Still use via CDN even if download fails
                            console.warn('Font download failed, using CDN:', e);
                        }
                        item.classList.remove('font-downloading');
                    }
                    
                    setFontPickerValue(slot, font.family);
                    dropdown.style.display = 'none';
                    updateLogoPreview();
                });
                
                dropdown.appendChild(item);
            });
            
            dropdown.style.display = 'block';
        } catch (error) {
            console.error('Font search failed:', error);
            dropdown.innerHTML = '<div class="font-dropdown-empty">Search failed</div>';
            dropdown.style.display = 'block';
        }
    }

    /**
     * Load local font count
     */
    async function loadLocalFontCount() {
        try {
            const fonts = await Utils.api('/api/settings/fonts/local');
            const counter = document.getElementById('font-local-count');
            if (counter && Array.isArray(fonts)) {
                counter.textContent = fonts.length;
            }
        } catch (e) {
            // ignore
        }
    }

    /**
     * Initialize branding action buttons
     */
    function initBrandingActions() {
        document.getElementById('branding-save-btn')?.addEventListener('click', () => saveBrandingNow());
        document.getElementById('branding-revert-btn')?.addEventListener('click', revertBrandingChanges);
        
        document.getElementById('branding-export-btn')?.addEventListener('click', async () => {
            try {
                const response = await Utils.api('/api/settings/branding/export');
                const blob = new Blob([JSON.stringify(response, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'betterdesk-theme.json';
                a.click();
                URL.revokeObjectURL(url);
                Notifications.success(_('branding.exported'));
            } catch (error) {
                Notifications.error(error.message || _('errors.server_error'));
            }
        });
        
        // Import
        document.getElementById('branding-import-input')?.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            try {
                const text = await file.text();
                const preset = JSON.parse(text);
                
                await Utils.api('/api/settings/branding/import', {
                    method: 'POST',
                    body: preset
                });
                
                const fresh = await Utils.api('/api/settings/branding');
                brandingData = fresh.data || fresh;
                populateBrandingForm(brandingData);
                _brandingSnapshot = JSON.stringify(collectBrandingData());
                _brandingDirty = false;
                setBrandingStatus('saved');
                scheduleBrandingPreview();
                if (typeof BrandingPreview !== 'undefined') BrandingPreview.refreshBrandingStylesheet(Date.now());
                Notifications.success(_('branding.imported'));
                
            } catch (error) {
                Notifications.error(error.message || _('branding.import_error'));
            }
            
            // Reset file input
            e.target.value = '';
        });
        
        // Reset
        document.getElementById('branding-reset-btn')?.addEventListener('click', async () => {
            if (!confirm(_('branding.reset_confirm'))) return;
            
            try {
                await Utils.api('/api/settings/branding/reset', { method: 'POST' });
                const fresh = await Utils.api('/api/settings/branding');
                brandingData = fresh.data || fresh;
                populateBrandingForm(brandingData);
                _brandingSnapshot = JSON.stringify(collectBrandingData());
                _brandingDirty = false;
                setBrandingStatus('saved');
                scheduleBrandingPreview();
                if (typeof BrandingPreview !== 'undefined') BrandingPreview.refreshBrandingStylesheet(Date.now());
                Notifications.success(_('branding.reset_success'));
            } catch (error) {
                Notifications.error(error.message || _('errors.server_error'));
            }
        });
    }
    
    // ==================== Backup & Restore ======================================
    
    function initBackupSection() {
        loadBackupStats();
        
        // Download backup
        document.getElementById('backup-download-btn')?.addEventListener('click', async () => {
            const btn = document.getElementById('backup-download-btn');
            if (!btn) return;
            btn.disabled = true;
            btn.innerHTML = '<span class="material-icons spinning">sync</span> ' + _('backup.creating');
            
            try {
                const fetchHeaders = {};
                if (window.BetterDesk && window.BetterDesk.csrfToken) {
                    fetchHeaders['X-CSRF-Token'] = window.BetterDesk.csrfToken;
                }
                const response = await fetch('/api/settings/backup', {
                    credentials: 'same-origin',
                    headers: fetchHeaders
                });
                if (!response.ok) throw new Error('Backup failed');
                
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                // Prefer the server-provided filename (full backup .tar.gz).
                let filename = '';
                const disp = response.headers.get('Content-Disposition') || '';
                const match = disp.match(/filename="?([^";]+)"?/i);
                if (match) filename = match[1];
                if (!filename) {
                    const date = new Date().toISOString().slice(0, 10);
                    filename = `betterdesk-backup-${date}.tar.gz`;
                }
                a.download = filename;
                a.click();
                URL.revokeObjectURL(url);
                
                Notifications.success(_('backup.download_success'));
            } catch (error) {
                Notifications.error(error.message || _('errors.server_error'));
            } finally {
                btn.disabled = false;
                btn.innerHTML = '<span class="material-icons">download</span> ' + _('backup.download');
            }
        });
        
        // Restore from file
        document.getElementById('restore-file-input')?.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            const name = file.name.toLowerCase();
            const isArchive = name.endsWith('.gz') || name.endsWith('.tar.gz');
            const isJson = name.endsWith('.json');
            if (!isArchive && !isJson) {
                Notifications.error(_('backup.invalid_format'));
                e.target.value = '';
                return;
            }
            
            if (!confirm(_('backup.restore_confirm'))) {
                e.target.value = '';
                return;
            }
            
            const resultEl = document.getElementById('restore-result');
            const label = document.getElementById('restore-upload-label');
            
            try {
                // Build FormData with restore options. The server auto-detects the
                // archive format (gzip magic bytes) vs a legacy JSON snapshot.
                const formData = new FormData();
                formData.append('backup', file);
                // Full disaster-recovery archive options
                formData.append('restoreDatabase', document.getElementById('restore-database')?.checked ?? true);
                formData.append('restoreUploads', document.getElementById('restore-uploads')?.checked ?? true);
                formData.append('restoreSecrets', document.getElementById('restore-secrets')?.checked ?? false);
                formData.append('restoreEnv', document.getElementById('restore-env')?.checked ?? false);
                formData.append('restoreGoDb', document.getElementById('restore-godb')?.checked ?? false);
                
                if (label) label.classList.add('loading');
                
                const headers = {};
                if (window.BetterDesk && window.BetterDesk.csrfToken) {
                    headers['X-CSRF-Token'] = window.BetterDesk.csrfToken;
                }
                
                const response = await fetch('/api/settings/restore', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: headers,
                    body: formData
                });
                
                const result = await response.json();
                
                if (result.success) {
                    Notifications.success(_('backup.restore_success'));
                    showRestoreResult(result.data, resultEl);
                    if (result.data && result.data.requiresRestart) {
                        Notifications.warning(_('backup.restart_required'));
                    }
                } else {
                    Notifications.error(result.error || _('errors.server_error'));
                }
            } catch (error) {
                Notifications.error(error.message || _('errors.server_error'));
            } finally {
                e.target.value = '';
                if (label) label.classList.remove('loading');
            }
        });
    }
    
    async function loadBackupStats() {
        try {
            const data = await Utils.api('/api/settings/backup/stats');
            if (!data) return;
            
            const setVal = (id, val) => {
                const el = document.getElementById(id);
                if (el) el.textContent = val;
            };
            const yn = (b) => b ? _('common.yes') : _('common.no');
            
            setVal('backup-stat-users', data.users || 0);
            setVal('backup-stat-settings', data.settings || 0);
            setVal('backup-stat-folders', data.folders || 0);
            setVal('backup-stat-groups', (data.userGroups || 0) + (data.deviceGroups || 0));
            setVal('backup-stat-strategies', data.strategies || 0);
            setVal('backup-stat-backend', data.backend === 'betterdesk' ? 'BetterDesk Go' : 'RustDesk');
            const comp = data.components || {};
            setVal('backup-stat-database', (data.dbType === 'postgres' ? 'PostgreSQL' : 'SQLite'));
            setVal('backup-stat-keys', yn(comp.goPrivKey || comp.goApiKey));
            setVal('backup-stat-env', yn(comp.env));
            setVal('backup-stat-uploads', comp.uploads || 0);
        } catch { /* silent */ }
    }
    
    function showRestoreResult(data, el) {
        if (!el) return;
        el.style.display = 'block';
        
        let html = '<div class="restore-result-inner">';
        if (data.restored.length) {
            html += `<p class="restore-ok"><span class="material-icons">check_circle</span> ${_('backup.restored')}: <strong>${Utils.escapeHtml(data.restored.join(', '))}</strong></p>`;
        }
        if (data.skipped.length) {
            html += `<p class="restore-skip"><span class="material-icons">skip_next</span> ${_('backup.skipped')}: ${Utils.escapeHtml(data.skipped.join(', '))}</p>`;
        }
        if (data.warnings && data.warnings.length) {
            html += `<p class="restore-warn"><span class="material-icons">warning</span> ${data.warnings.map(w => Utils.escapeHtml(w)).join('<br>')}</p>`;
        }
        if (data.backupDate) {
            html += `<p class="restore-meta">${_('backup.backup_date')}: ${Utils.escapeHtml(data.backupDate)}</p>`;
        }
        html += '</div>';
        el.innerHTML = html;
    }
    
    // ==================== Tutorials ====================

    function initTutorialSection() {
        const toggle = document.getElementById('tutorials-enabled');
        const resetBtn = document.getElementById('tutorials-reset-btn');
        if (!toggle) return;

        // Read current state from Tutorial system (localStorage)
        const tutorialDisabled = typeof Tutorial !== 'undefined' ? Tutorial.isDisabled() : 
            localStorage.getItem('betterdesk_tutorial_disabled') === 'true';
        toggle.checked = !tutorialDisabled;

        toggle.addEventListener('change', function() {
            const disabled = !toggle.checked;
            if (typeof Tutorial !== 'undefined') {
                Tutorial.setDisabled(disabled);
            } else {
                localStorage.setItem('betterdesk_tutorial_disabled', disabled ? 'true' : 'false');
            }
            // Notify tutorial.js to show/hide help button
            window.dispatchEvent(new CustomEvent('tutorial:stateChanged', { detail: { disabled: disabled } }));

            if (typeof Toast !== 'undefined') {
                Toast.success(
                    disabled ? _('settings.tutorials_disabled_toast') : _('settings.tutorials_enabled_toast'),
                    '', 3000
                );
            }
        });

        // Listen for changes from help menu toggle
        window.addEventListener('tutorial:stateChanged', function(e) {
            if (e.detail && typeof e.detail.disabled === 'boolean') {
                toggle.checked = !e.detail.disabled;
            }
        });

        if (resetBtn) {
            resetBtn.addEventListener('click', function() {
                if (typeof Tutorial !== 'undefined') {
                    Tutorial.resetTutorial();
                } else {
                    localStorage.removeItem('betterdesk_tutorial_seen');
                }
                if (typeof Toast !== 'undefined') {
                    Toast.success(_('settings.tutorials_reset_toast'), '', 3000);
                }
            });
        }
    }

    // ==================== Self-Update ====================
    
    let _updateState = { remoteSHA: null, changedData: null };
    let _updateChannelSaved = null;
    let _updateChannelBusy = false;

    function renderUpdateHeroStatus(state, opts = {}) {
        const icon = document.getElementById('update-hero-icon');
        const badge = document.getElementById('update-hero-badge');
        const headline = document.getElementById('update-status-headline');
        const desc = document.getElementById('update-status-desc');
        if (!icon || !headline) return;

        icon.dataset.state = state;
        const showBadge = state === 'warning' || state === 'error';
        if (badge) badge.hidden = !showBadge;

        const messages = {
            idle:      { h: _('updates.title'), d: _('updates.desc') },
            checking:  { h: _('updates.checking'), d: _('updates.desc') },
            uptodate:  { h: _('updates.up_to_date'), d: opts.detail || _('updates.desc') },
            available: { h: _('updates.update_available'), d: opts.detail || _('updates.desc') },
            baseline:  { h: _('updates.baseline_set'), d: _('updates.desc') },
            error:     { h: _('updates.install_failed'), d: opts.detail || _('updates.desc') }
        };
        const msg = messages[state] || messages.idle;
        headline.textContent = msg.h;
        if (desc) desc.textContent = msg.d;
    }
    
    function initUpdateSection() {
        const checkBtn = document.getElementById('update-check-btn');
        const installBtn = document.getElementById('update-install-btn');
        
        if (!checkBtn) return;
        
        checkBtn.addEventListener('click', checkForUpdates);
        installBtn?.addEventListener('click', installUpdate);

        const rebuildBtn = document.getElementById('update-rebuild-server-btn');
        rebuildBtn?.addEventListener('click', rebuildServerBinary);
        loadServerBinaryStatus();

        loadUpdateChannel();
        const channelSelect = document.getElementById('update-channel-select');
        channelSelect?.addEventListener('change', onUpdateChannelSelectChange);

        loadUpdateBackups();
        loadBackupRetention();
        loadLastUpdateResult();
        renderUpdateHeroStatus('idle');
    }

    function renderUpdateChannelBadge(data) {
        const badge = document.getElementById('update-channel-active-badge');
        if (!badge || !data?.channel) return;
        const isDev = data.channel === 'development';
        badge.className = `badge badge-sm ${isDev ? 'badge-warning' : 'badge-success'}`;
        badge.textContent = isDev ? _('updates.channel_development') : _('updates.channel_stable');
    }

    async function loadUpdateChannel() {
        const select = document.getElementById('update-channel-select');
        const branchEl = document.getElementById('update-channel-branch');
        if (!select) return;
        try {
            const payload = await Utils.api('/api/settings/updates/channel');
            const data = payload?.data ?? payload;
            _updateChannelSaved = data?.channel || 'stable';
            if (data?.channel) select.value = data.channel;
            renderUpdateChannelBadge(data);
            if (branchEl) {
                branchEl.textContent = data?.branch
                    ? `${data.branch} · ${data.owner || 'UNITRONIX'}/${data.repo || 'BetterDesk'}`
                    : '—';
            }
        } catch (_e) {
            if (branchEl) branchEl.textContent = '—';
        }
    }

    function channelToBranch(channel) {
        return channel === 'development' ? 'dev' : 'main';
    }

    async function onUpdateChannelSelectChange() {
        if (_updateChannelBusy) return;
        const select = document.getElementById('update-channel-select');
        if (!select) return;

        const channel = select.value;
        if (channel === _updateChannelSaved) return;

        const previous = _updateChannelSaved || 'stable';
        const confirmed = await Modal.confirm({
            title: _('updates.channel_save'),
            message: _('updates.channel_confirm_switch', {
                from: channelToBranch(previous),
                to: channelToBranch(channel)
            }),
            confirmLabel: _('updates.channel_save'),
            confirmIcon: 'alt_route'
        });

        if (!confirmed) {
            select.value = _updateChannelSaved || 'stable';
            return;
        }

        await persistUpdateChannel(channel, select);
    }

    async function persistUpdateChannel(channel, selectEl) {
        _updateChannelBusy = true;
        if (selectEl) selectEl.disabled = true;
        try {
            const payload = await Utils.api('/api/settings/updates/channel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel })
            });
            const data = payload?.data ?? payload;
            _updateChannelSaved = channel;
            await loadUpdateChannel();
            Notifications.success(_('updates.channel_saved'));
            if (data?.previousBranch && data.previousBranch !== data.branch) {
                _updateState.remoteSHA = null;
                _updateState.changedData = null;
                const detailsSection = document.getElementById('update-details-section');
                if (detailsSection) detailsSection.style.display = 'none';
                const remoteEl = document.getElementById('update-remote-version');
                if (remoteEl) remoteEl.textContent = '—';
                const statusRow = document.getElementById('update-status-row');
                if (statusRow) statusRow.style.display = 'none';
            }
        } catch (error) {
            if (selectEl) selectEl.value = _updateChannelSaved || 'stable';
            Notifications.error(error.message || _('updates.channel_save_failed'));
        } finally {
            _updateChannelBusy = false;
            if (selectEl) selectEl.disabled = false;
        }
    }

    async function loadLastUpdateResult() {
        const host = document.getElementById('update-alerts');
        if (!host) return;
        let banner = document.getElementById('update-last-result-banner');
        try {
            const payload = await Utils.api('/api/settings/updates/last-result');
            const record = payload?.data ?? payload;
            if (!record || (!record.failed?.length && !record.servicesFailed?.length && !record.consoleRestartBlocked)) {
                if (banner) banner.remove();
                return;
            }
            if (!banner) {
                banner = document.createElement('div');
                banner.id = 'update-last-result-banner';
                banner.className = 'update-stale-warning';
                banner.style.marginTop = '12px';
                host.appendChild(banner);
            }
            const lines = [];
            lines.push(`<strong>${Utils.escapeHtml(_('updates.complete_with_errors'))}</strong>`);
            lines.push(`<div style="font-size:12px;margin-top:6px;">SHA: ${Utils.escapeHtml(String(record.sha || '').slice(0, 7))} · ${Utils.escapeHtml(record.savedAt || '')}</div>`);
            for (const f of (record.failed || [])) {
                lines.push(`<div style="font-size:12px;color:var(--danger,#e34935);">${Utils.escapeHtml(f.file)}: ${Utils.escapeHtml(f.error || '')}</div>`);
            }
            for (const s of (record.servicesFailed || [])) {
                lines.push(`<div style="font-size:12px;color:var(--danger,#e34935);">${Utils.escapeHtml(s.service)}: ${Utils.escapeHtml(s.error || '')}</div>`);
            }
            if (record.consoleRestartBlocked) {
                lines.push(`<div style="font-size:12px;color:var(--danger,#e34935);">${Utils.escapeHtml(record.consoleRestartBlocked)}</div>`);
            }
            banner.innerHTML = lines.join('');
        } catch (_) {
            /* optional panel */
        }
    }

    async function loadServerBinaryStatus() {
        const warning = document.getElementById('update-stale-warning');
        if (!warning) return;
        try {
            const status = await Utils.api('/api/settings/updates/server-binary/status');
            if (status && status.dockerMode) {
                warning.style.display = 'none';
                return;
            }
            if (status && status.stale) {
                const detailEl = document.getElementById('update-stale-detail');
                if (detailEl) {
                    detailEl.textContent = status.detail
                        ? `${_('updates.server_stale_desc')} (${status.detail})`
                        : _('updates.server_stale_desc');
                }
                warning.style.display = '';
                const badge = document.getElementById('update-hero-badge');
                if (badge) badge.hidden = false;
                const icon = document.getElementById('update-hero-icon');
                if (icon && icon.dataset.state === 'idle') icon.dataset.state = 'warning';
            } else {
                warning.style.display = 'none';
            }
        } catch (_e) {
            warning.style.display = 'none';
        }
    }

    async function rebuildServerBinary() {
        const btn = document.getElementById('update-rebuild-server-btn');
        if (!btn) return;
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = `<span class="material-icons spinning">sync</span> ${_('updates.rebuilding_server')}`;
        try {
            const result = await Utils.api('/api/settings/updates/server-binary/rebuild', { method: 'POST' });
            if (result && result.success) {
                Notifications.success(_('updates.rebuild_server_success'));
                await loadServerBinaryStatus();
            } else {
                Notifications.error((result && result.error) || _('updates.rebuild_server_failed'));
            }
        } catch (error) {
            Notifications.error(error.message || _('updates.rebuild_server_failed'));
        } finally {
            btn.disabled = false;
            btn.innerHTML = original;
        }
    }
    
    function renderDockerUpdatePanel(data) {
        const panel = document.getElementById('update-docker-info');
        const commandsEl = document.getElementById('update-docker-commands');
        const imagesEl = document.getElementById('update-docker-images');
        const installNote = document.getElementById('update-docker-install-note');
        const installBtn = document.getElementById('update-install-btn');
        const staleWarning = document.getElementById('update-stale-warning');
        const dockerMode = data.deploymentMode === 'docker-image' || data.dockerImageMode;

        if (!panel) return dockerMode;

        if (dockerMode) {
            panel.style.display = '';
            if (staleWarning) staleWarning.style.display = 'none';
            if (installBtn) installBtn.style.display = 'none';
            if (installNote) installNote.style.display = '';

            const dockerUpdate = data.dockerUpdate || {};
            const commands = dockerUpdate.commands || ['docker compose pull', 'docker compose up -d'];
            if (commandsEl) {
                commandsEl.textContent = commands.join('\n');
            }
            if (imagesEl && Array.isArray(dockerUpdate.images) && dockerUpdate.images.length) {
                imagesEl.textContent = `${_('updates.docker_images')}: ${dockerUpdate.images.join(', ')}`;
            }
        } else {
            panel.style.display = 'none';
            if (installBtn) installBtn.style.display = '';
            if (installNote) installNote.style.display = 'none';
        }

        return dockerMode;
    }

    async function checkForUpdates() {
        const btn = document.getElementById('update-check-btn');
        const statusRow = document.getElementById('update-status-row');
        const statusBadge = document.getElementById('update-status-badge');
        const remoteEl = document.getElementById('update-remote-version');
        const detailsSection = document.getElementById('update-details-section');
        const installBtn = document.getElementById('update-install-btn');
        
        if (!btn) return;
        btn.disabled = true;
        renderUpdateHeroStatus('checking');
        btn.innerHTML = `<span class="material-icons spinning">sync</span> ${_('updates.checking')}`;
        
        try {
            const data = await Utils.api('/api/settings/updates/check');
            const dockerMode = renderDockerUpdatePanel(data);
            
            // Show commit SHA + message
            if (remoteEl) {
                const sha = data.remoteSHA ? data.remoteSHA.slice(0, 7) : '—';
                remoteEl.textContent = sha;
                if (data.latestMessage) remoteEl.title = data.latestMessage;
            }
            if (statusRow) statusRow.style.display = '';
            
            if (data.baselineEstablished) {
                if (statusBadge) statusBadge.innerHTML = `<span class="badge badge-info">${_('updates.baseline_set')}</span>`;
                renderUpdateHeroStatus('baseline');
                if (detailsSection) detailsSection.style.display = 'none';
                if (installBtn) installBtn.disabled = true;
            } else if (data.updateAvailable) {
                const behind = data.commitsBehind > 0 ? ` (${data.commitsBehind} ${_('updates.commits_behind')})` : '';
                const badgeLabel = dockerMode ? _('updates.docker_update_available') : _('updates.update_available');
                if (statusBadge) statusBadge.innerHTML = `<span class="badge badge-warning">${badgeLabel}${behind}</span>`;
                const detail = data.latestMessage
                    ? `${data.latestMessage}${behind}`
                    : `${badgeLabel}${behind}`.trim();
                renderUpdateHeroStatus('available', { detail });
                
                _updateState.remoteSHA = data.remoteSHA;
                
                // Fetch changed files
                try {
                    const changes = await Utils.api(`/api/settings/updates/changes?sha=${data.remoteSHA}`);
                    _updateState.changedData = changes;
                    renderUpdateDetails(data, changes, dockerMode);
                    if (installBtn) installBtn.disabled = dockerMode;
                } catch (_e) {
                    const cl = document.getElementById('update-changelog');
                    if (cl) cl.innerHTML = `<p class="text-muted">${_('updates.changes_unavailable')}</p>`;
                    if (installBtn) installBtn.disabled = dockerMode;
                }
                
                if (detailsSection) detailsSection.style.display = '';
            } else {
                if (statusBadge) {
                    const label = data.dockerShaUnknown ? _('updates.docker_sha_unknown') : _('updates.up_to_date');
                    statusBadge.innerHTML = `<span class="badge badge-success">${label}</span>`;
                }
                const detail = data.latestMessage || (data.remoteSHA ? `SHA ${data.remoteSHA.slice(0, 7)}` : '');
                renderUpdateHeroStatus('uptodate', { detail: detail || _('updates.desc') });
                if (detailsSection) detailsSection.style.display = 'none';
                if (installBtn) installBtn.disabled = true;
            }
        } catch (error) {
            renderUpdateHeroStatus('error', { detail: error.message || _('errors.server_error') });
            Notifications.error(error.message || _('errors.server_error'));
        } finally {
            btn.disabled = false;
            btn.innerHTML = `<span class="material-icons">refresh</span> ${_('updates.check_now')}`;
        }
    }
    
    function renderUpdateDetails(checkData, changesData, dockerMode = false) {
        const changelogEl = document.getElementById('update-changelog');
        const summaryEl = document.getElementById('update-files-summary');
        
        // ---- Recent commits ----
        if (changelogEl) {
            const commits = changesData.commits || [];
            if (commits.length > 0) {
                let html = '<div class="update-commits">';
                for (const c of commits.slice(0, 20)) {
                    const d = c.date ? new Date(c.date).toLocaleDateString() : '';
                    html += `<div class="update-commit-item">
                        <code class="update-commit-sha">${Utils.escapeHtml(c.sha || '')}</code>
                        <span class="update-commit-msg">${Utils.escapeHtml(c.message || '')}</span>
                        <span class="update-commit-meta">${Utils.escapeHtml(c.author || '')} · ${d}</span>
                    </div>`;
                }
                html += '</div>';
                changelogEl.innerHTML = html;
            } else {
                changelogEl.innerHTML = `<p class="text-muted">${_('updates.no_changelog')}</p>`;
            }
        }
        
        // ---- Component breakdown ----
        if (summaryEl) {
            const grouped = changesData.grouped || {};
            const meta = {
                console: { icon: 'web',       label: _('updates.component_console'),  auto: true },
                server:  { icon: 'dns',       label: _('updates.component_server'),   auto: true },
                agent:   { icon: 'smart_toy', label: _('updates.component_agent'),    auto: false },
                scripts: { icon: 'terminal',  label: _('updates.component_scripts'),  auto: true },
                other:   { icon: 'folder',    label: _('updates.component_other'),    auto: false }
            };
            
            let html = '<div class="update-components">';
            for (const [comp, files] of Object.entries(grouped)) {
                if (!files || files.length === 0) continue;
                const m = meta[comp] || meta.other;
                const badge = m.auto
                    ? `<span class="badge badge-success badge-sm">${_('updates.auto')}</span>`
                    : `<span class="badge badge-warning badge-sm">${_('updates.manual')}</span>`;
                html += `<div class="update-component-row">
                    <span class="material-icons">${m.icon}</span>
                    <span class="update-component-label">${m.label}</span>
                    <span class="update-component-count">${files.length} ${_('updates.files')}</span>
                    ${badge}
                </div>`;
            }
            html += '</div>';
            html += `<p class="text-muted" style="margin-top:8px;font-size:12px;">${_('updates.total_files')}: <strong>${changesData.totalFiles || 0}</strong></p>`;
            
            if (grouped.server?.length > 0) {
                html += `<div class="update-server-section" style="margin-top:12px;padding:12px;border:1px solid var(--border-color, #333);border-radius:8px;">
                    <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:8px;">
                        <span class="material-icons" style="font-size:20px;color:var(--primary);">auto_mode</span>
                        <div style="flex:1;min-width:0;">
                            <div style="font-weight:600;color:var(--text-primary);">${_('updates.include_server')}</div>
                            <div class="text-muted" style="font-size:12px;margin-top:2px;">${_('updates.auto_strategy_hint')}</div>
                        </div>
                        <span id="update-server-status" class="badge badge-warning badge-sm">${_('updates.checking_go')}</span>
                    </div>
                    <div id="update-server-info" class="text-muted" style="font-size:11px;"></div>
                </div>`;
            }
            
            summaryEl.innerHTML = html;
            
            // Check Go availability when server section is shown
            if (grouped.server?.length > 0 && !dockerMode) {
                checkServerBuildInfo();
            }
        }
    }
    
    async function checkServerBuildInfo() {
        const statusEl = document.getElementById('update-server-status');
        const infoEl = document.getElementById('update-server-info');
        if (!statusEl) return;

        try {
            const info = await Utils.api('/api/settings/updates/server-info');
            const hasGo = !!info.goAvailable && info.goMeetsMinimum !== false;
            const goNeedsUpgrade = !!info.goAvailable && info.goMeetsMinimum === false;
            const prebuilt = info.prebuilt || {};
            const hasDownload = !!prebuilt.available;
            const canInstallGo = !!info.canInstallGo;
            const vendoredReady = !!info.vendoredGoInstalled;

            // Status badge
            if (hasGo && hasDownload) {
                statusEl.className = 'badge badge-success badge-sm';
                statusEl.textContent = _('updates.both_available');
            } else if (hasDownload) {
                statusEl.className = 'badge badge-info badge-sm';
                statusEl.textContent = _('updates.download_available');
            } else if (hasGo) {
                statusEl.className = 'badge badge-success badge-sm';
                statusEl.textContent = info.goVersion ? info.goVersion.replace('go version ', '') : 'Go';
            } else if (goNeedsUpgrade || canInstallGo) {
                statusEl.className = 'badge badge-info badge-sm';
                statusEl.textContent = vendoredReady ? _('updates.toolchain_ready') : _('updates.auto_available');
            } else {
                statusEl.className = 'badge badge-warning badge-sm';
                statusEl.textContent = _('updates.no_method');
            }

            // Info line
            if (infoEl) {
                const parts = [];
                if (info.binaryPath) parts.push(`Binary: ${info.binaryPath}`);
                if (info.sourcePresent) parts.push('Source: present');
                if (hasDownload && prebuilt.releaseName) parts.push(`Release: ${prebuilt.releaseName}`);
                if (info.goSource && info.goSource !== 'path') parts.push(`Go: ${info.goSource}`);
                if (goNeedsUpgrade) parts.push(_('updates.toolchain_will_install'));
                if (!hasGo && !hasDownload && canInstallGo) parts.push(_('updates.toolchain_will_install'));
                infoEl.textContent = parts.join(' · ');
            }
        } catch (_e) {
            statusEl.className = 'badge badge-warning badge-sm';
            statusEl.textContent = _('updates.go_check_failed');
        }
    }

    function getUpdateScopeLabels() {
        const grouped = _updateState.changedData?.grouped || {};
        const labels = {
            console: _('updates.component_console'),
            server: _('updates.component_server'),
            scripts: _('updates.component_scripts'),
            agent: _('updates.component_agent'),
            other: _('updates.component_other')
        };
        return Object.entries(grouped)
            .filter(([, files]) => files?.length > 0)
            .map(([component, files]) => `${labels[component] || labels.other}: ${files.length} ${_('updates.files')}`);
    }
    
    // ---------- Update progress modal ----------

    const UPDATE_PHASES = [
        { id: 'confirm',  icon: 'task_alt',          key: 'updates.phase_confirm' },
        { id: 'backup',   icon: 'inventory',         key: 'updates.phase_backup' },
        { id: 'console',  icon: 'cloud_download',    key: 'updates.phase_console' },
        { id: 'server',   icon: 'memory',            key: 'updates.phase_server' },
        { id: 'restart',  icon: 'restart_alt',       key: 'updates.phase_restart' },
        { id: 'done',     icon: 'check_circle',      key: 'updates.phase_done' }
    ];

    function buildUpdateModalContent() {
        const items = UPDATE_PHASES.map(p => `
            <div class="update-phase" data-phase="${p.id}">
                <span class="update-phase-icon material-icons">${p.icon}</span>
                <span class="update-phase-label">${_(p.key)}</span>
                <span class="update-phase-state" data-phase-state="${p.id}">
                    <span class="material-icons">radio_button_unchecked</span>
                </span>
            </div>
        `).join('');
        return `
            <div class="update-progress-modal">
                <div class="update-progress-bar"><div class="update-progress-bar-fill" id="update-modal-bar" style="width:0%"></div></div>
                <div class="update-phases">${items}</div>
                <div class="update-progress-detail" id="update-modal-detail">${_('updates.preparing')}</div>
                <pre class="update-progress-log" id="update-modal-log" aria-live="polite"></pre>
            </div>
        `;
    }

    function setUpdatePhase(phaseId, state, detail) {
        // state: 'pending' | 'active' | 'done' | 'warning' | 'error' | 'skipped'
        const stateEl = document.querySelector(`[data-phase-state="${phaseId}"]`);
        if (stateEl) {
            const icons = {
                pending: 'radio_button_unchecked',
                active:  'sync',
                done:    'check_circle',
                warning: 'warning',
                error:   'error',
                skipped: 'remove_circle_outline'
            };
            const cls = {
                pending: '',
                active:  'spinning',
                done:    '',
                warning: '',
                error:   '',
                skipped: ''
            };
            stateEl.innerHTML = `<span class="material-icons ${cls[state] || ''}">${icons[state] || 'help'}</span>`;
            stateEl.dataset.state = state;
        }
        if (detail) {
            const det = document.getElementById('update-modal-detail');
            if (det) det.textContent = detail;
        }
        // Advance progress bar based on phase index
        const idx = UPDATE_PHASES.findIndex(p => p.id === phaseId);
        if (idx >= 0) {
            const pct = state === 'done' ? Math.round(((idx + 1) / UPDATE_PHASES.length) * 100)
                : state === 'active' ? Math.round((idx / UPDATE_PHASES.length) * 100)
                : null;
            const bar = document.getElementById('update-modal-bar');
            if (bar && pct !== null) bar.style.width = pct + '%';
        }
    }

    function logUpdate(line) {
        const log = document.getElementById('update-modal-log');
        if (!log) return;
        const ts = new Date().toLocaleTimeString();
        log.textContent += `[${ts}] ${line}\n`;
        log.scrollTop = log.scrollHeight;
    }

    function reloadConsole() {
        const url = new URL(window.location.href);
        url.searchParams.set('_bd_reload', Date.now().toString());
        window.location.replace(url.toString());
    }

    async function installUpdate() {
        const installBtn = document.getElementById('update-install-btn');

        if (!_updateState.remoteSHA) {
            Notifications.error(_('updates.no_version'));
            return;
        }

        const hasServerUpdate = (_updateState.changedData?.grouped?.server || []).length > 0;
        const createBackup = document.getElementById('update-backup-toggle')?.checked ?? true;

        // Preflight checks (issue #158)
        let preflightWarnings = [];
        try {
            const pfUrl = hasServerUpdate
                ? '/api/settings/updates/preflight?serverUpdate=1'
                : '/api/settings/updates/preflight';
            const pf = await Utils.api(pfUrl);
            if (pf && pf.ready === false && Array.isArray(pf.issues) && pf.issues.length) {
                Notifications.error(pf.issues.join('; '));
                return;
            }
            if (pf && Array.isArray(pf.warnings)) preflightWarnings = pf.warnings;
        } catch (_e) { /* non-blocking if preflight endpoint unavailable */ }

        // Pre-flight confirmation modal
        const scopeItems = getUpdateScopeLabels();
        const strategyNote = hasServerUpdate ? _('updates.auto_strategy_hint') : '';
        const warnHtml = preflightWarnings.length
            ? `<p class="text-muted" style="font-size:12px;margin-top:8px;">${preflightWarnings.map(w => Utils.escapeHtml(w)).join('<br>')}</p>`
            : '';
        const confirmHtml = `
            <p>${Utils.escapeHtml(_('updates.install_confirm'))}</p>
            <ul style="margin:8px 0 0 0;padding-left:20px;font-size:13px;color:var(--text-secondary);">
                <li>${Utils.escapeHtml(createBackup ? _('updates.confirm_with_backup') : _('updates.confirm_no_backup'))}</li>
                ${scopeItems.map(item => `<li>${Utils.escapeHtml(item)}</li>`).join('')}
                ${hasServerUpdate ? `<li>${Utils.escapeHtml(strategyNote || '')}</li>` : ''}
            </ul>
            ${warnHtml}
        `;
        const proceed = await new Promise((resolve) => {
            window.Modal.show({
                title: _('updates.confirm_title'),
                content: confirmHtml,
                buttons: [
                    { label: _('actions.cancel'),  class: 'btn-secondary', onClick: () => { window.Modal.close(); resolve(false); } },
                    { label: _('updates.install'), class: 'btn-primary', icon: 'system_update', onClick: () => { window.Modal.close(); resolve(true); } }
                ],
                closable: true,
                onClose: () => resolve(false)
            });
        });
        if (!proceed) return;

        if (installBtn) installBtn.disabled = true;

        // Open progress modal (non-closable while running)
        window.Modal.show({
            title: _('updates.modal_title'),
            content: buildUpdateModalContent(),
            buttons: [],
            closable: false,
            size: 'large'
        });

        UPDATE_PHASES.forEach(p => setUpdatePhase(p.id, 'pending'));
        setUpdatePhase('confirm', 'done');
        if (createBackup) setUpdatePhase('backup', 'active', _('updates.creating_backup'));
        else setUpdatePhase('backup', 'skipped', _('updates.backup_skipped'));
        logUpdate(`Starting update to ${_updateState.remoteSHA.slice(0, 7)}…`);

        try {
            // Console download phase indicator (we cannot stream backend
            // progress today, so we just mark it active until response arrives)
            setTimeout(() => {
                setUpdatePhase('backup', 'done');
                setUpdatePhase('console', 'active', _('updates.downloading'));
            }, 800);

            if (hasServerUpdate) {
                setTimeout(() => {
                    setUpdatePhase('console', 'done');
                    setUpdatePhase('server', 'active', _('updates.server_processing'));
                }, 4000);
            }

            const result = await Utils.api('/api/settings/updates/install', {
                method: 'POST',
                body: { remoteSHA: _updateState.remoteSHA, createBackup }
            });

            // Mark earlier phases done if not already
            ['backup', 'console'].forEach(p => {
                const st = document.querySelector(`[data-phase-state="${p}"]`)?.dataset?.state;
                if (st !== 'done' && st !== 'skipped') setUpdatePhase(p, 'done');
            });

            // Server result
            if (hasServerUpdate) {
                if (result.toolchainInstall) {
                    if (result.toolchainInstall.success) {
                        logUpdate(`Go toolchain ready: ${result.toolchainInstall.version || ''}`.trim());
                    } else {
                        logUpdate(`Go toolchain install failed: ${result.toolchainInstall.error || 'unknown'}`);
                    }
                }
                const deployFailed = !!(result.serverDeploy && result.serverDeploy.success === false);
                if (result.serverBuild) {
                    if (result.serverBuild.success && !deployFailed) {
                        const ms = result.serverBuild.duration || 0;
                        const secs = ms ? Math.round(ms / 1000) : 0;
                        const sizeMB = result.serverBuild.size ? ` (${(result.serverBuild.size / (1024 * 1024)).toFixed(1)} MB)` : '';
                        const detail = result.serverBuild.method === 'download'
                            ? `${_('updates.server_downloaded')}${sizeMB}`
                            : `${_('updates.server_built')}${secs ? ` · ${secs}s` : ''}`;
                        setUpdatePhase('server', 'done', detail);
                        logUpdate(detail);
                    } else if (result.serverBuild.success && deployFailed) {
                        // Build OK but deploy to service path failed — surface as error
                        const detail = _('updates.server_deploy_failed');
                        setUpdatePhase('server', 'error', detail);
                        logUpdate(`${detail}: ${result.serverDeploy.error || ''}`);
                    } else {
                        const detail = result.serverBuild.method === 'download'
                            ? _('updates.server_download_failed')
                            : _('updates.server_build_failed');
                        setUpdatePhase('server', 'error', detail);
                        logUpdate(`${detail}: ${result.serverBuild.error || ''}`);
                    }
                } else {
                    setUpdatePhase('server', 'skipped', _('updates.server_skipped'));
                }
                if (result.autoRebuild) {
                    if (result.autoRebuild.success) {
                        logUpdate(_('updates.server_built') + ' (auto-rebuild)');
                        setUpdatePhase('server', 'done', _('updates.server_built'));
                    } else if (result.autoRebuild.error) {
                        logUpdate(`Auto-rebuild: ${result.autoRebuild.error}`);
                    }
                }
                if (deployFailed && result.serverBuild?.success) {
                    logUpdate(`Deploy failed: ${result.serverDeploy.error || ''}`);
                }
            } else {
                setUpdatePhase('server', 'skipped', _('updates.server_skipped'));
            }

            const applied = result.applied?.length || 0;
            const failed  = result.failed?.length || 0;
            const removed = result.removed?.length || 0;
            logUpdate(`${_('updates.applied')}: ${applied} · ${_('updates.failed')}: ${failed} · ${_('updates.removed')}: ${removed}`);
            for (const item of (result.failed || [])) {
                logUpdate(`${item.file}: ${item.error || ''}`);
            }
            for (const item of (result.servicesFailed || [])) {
                logUpdate(`${item.service}: ${item.error || ''}`);
            }

            if (result.needsConsoleRestart && !result.consoleRestartBlocked) {
                setUpdatePhase('restart', 'active', _('updates.restarting'));
                logUpdate(_('updates.console_will_restart'));
                setTimeout(() => pollConsoleRestart(), 2500);
            } else if (result.consoleRestartBlocked) {
                setUpdatePhase('restart', 'error', result.consoleRestartBlocked);
                logUpdate(result.consoleRestartBlocked);
                setUpdatePhase('done', 'done', _('updates.complete_with_errors'));
                showUpdateCompletionModal(result);
                if (installBtn) installBtn.disabled = false;
                loadServerBinaryStatus();
            } else {
                setUpdatePhase('restart', 'skipped', _('updates.no_restart_needed'));
                setUpdatePhase('done', 'done', _('updates.complete'));
                showUpdateCompletionModal(result);
                if (installBtn) installBtn.disabled = false;
                loadServerBinaryStatus();
            }
        } catch (error) {
            const activePhase = UPDATE_PHASES.find(p => {
                const st = document.querySelector(`[data-phase-state="${p.id}"]`)?.dataset?.state;
                return st === 'active';
            });
            if (activePhase) setUpdatePhase(activePhase.id, 'error', error.message || _('updates.install_failed'));
            logUpdate(`ERROR: ${error.message || error}`);

            // Replace empty footer with a Close button so the user can dismiss
            window.Modal.close();
            await window.Modal.alert({
                title: _('updates.install_failed'),
                message: error.message || _('errors.server_error')
            });
            Notifications.error(error.message || _('updates.install_failed'));
            if (installBtn) installBtn.disabled = false;
        }
    }

    function showUpdateCompletionModal(result) {
        const lines = [];
        const deployFailed = !!(result.serverDeploy && result.serverDeploy.success === false);
        const hasFailures = (result.failed?.length || 0) > 0
            || (result.servicesFailed?.length || 0) > 0
            || !!result.consoleRestartBlocked
            || deployFailed;
        const summaryKey = hasFailures ? 'updates.complete_with_errors' : 'updates.complete_summary';
        lines.push(`<p>${Utils.escapeHtml(_(summaryKey))}</p>`);
        const stats = [
            { label: _('updates.applied'), value: result.applied?.length || 0 },
            { label: _('updates.failed'),  value: result.failed?.length  || 0 },
            { label: _('updates.removed'), value: result.removed?.length || 0 }
        ];
        lines.push(`<ul style="margin:8px 0;padding-left:20px;font-size:13px;">${stats.map(s => `<li>${Utils.escapeHtml(s.label)}: <strong>${s.value}</strong></li>`).join('')}</ul>`);
        if (result.failed?.length) {
            lines.push(`<ul style="margin:8px 0;padding-left:20px;font-size:12px;color:var(--danger,#e34935);">${result.failed.map(f =>
                `<li><strong>${Utils.escapeHtml(f.file || 'unknown')}</strong>${f.error ? `: ${Utils.escapeHtml(f.error)}` : ''}</li>`
            ).join('')}</ul>`);
        }
        if (result.servicesFailed?.length) {
            lines.push(`<ul style="margin:8px 0;padding-left:20px;font-size:12px;color:var(--danger,#e34935);">${result.servicesFailed.map(s =>
                `<li><strong>${Utils.escapeHtml(s.service || 'service')}</strong>${s.error ? `: ${Utils.escapeHtml(s.error)}` : ''}</li>`
            ).join('')}</ul>`);
        }
        if (result.consoleRestartBlocked) {
            lines.push(`<p style="font-size:12px;color:var(--danger,#e34935);">${Utils.escapeHtml(result.consoleRestartBlocked)}</p>`);
        }
        if (deployFailed) {
            const errMsg = result.serverDeploy.error || '';
            lines.push(`<p style="font-size:13px;color:var(--danger,#e34935);"><strong>${Utils.escapeHtml(_('updates.server_deploy_failed'))}</strong></p>`);
            if (errMsg) lines.push(`<pre style="font-size:12px;background:var(--bg-secondary,#1a1a1a);padding:8px;border-radius:4px;overflow:auto;max-height:120px;white-space:pre-wrap;">${Utils.escapeHtml(errMsg)}</pre>`);
        } else if (result.serverBuild?.success) {
            const note = result.serverBuild.method === 'download' ? _('updates.server_downloaded') : _('updates.server_built');
            lines.push(`<p style="font-size:13px;color:var(--text-secondary);">${Utils.escapeHtml(note)}</p>`);
        }
        // Some updates require manual reload (e.g., static asset changes)
        const needsReload = (result.applied || []).some(p => /\.(js|css|html|ejs)$/i.test(p));
        if (needsReload) {
            lines.push(`<p style="font-size:13px;margin-top:8px;">${Utils.escapeHtml(_('updates.refresh_recommended'))}</p>`);
        }

        window.Modal.close();
        window.Modal.show({
            title: _(hasFailures ? 'updates.modal_done_with_errors_title' : 'updates.modal_done_title'),
            content: lines.join(''),
            buttons: [
                { label: _('updates.modal_close'),     class: 'btn-secondary', onClick: () => { window.Modal.close(); } },
                { label: _('updates.modal_reload_now'), class: 'btn-primary', icon: 'refresh', onClick: reloadConsole }
            ],
            closable: !hasFailures
        });
        loadLastUpdateResult();
    }

    function pollConsoleRestart() {
        let attempts = 0;
        const maxAttempts = 90;
        const previousCacheVersion = window.BetterDesk?.cacheVersion || '';
        const interval = setInterval(async () => {
            attempts++;
            setUpdatePhase('restart', 'active', `${_('updates.restarting')} (${attempts}/${maxAttempts})`);
            try {
                const resp = await fetch('/api/settings/restart-status?_=' + Date.now(), {
                    credentials: 'same-origin',
                    cache: 'no-store',
                    headers: { 'Cache-Control': 'no-cache' }
                });
                if (resp.ok) {
                    const body = await resp.json().catch(() => null);
                    const status = body?.data || body || {};
                    if (previousCacheVersion && status.cacheVersion && status.cacheVersion === previousCacheVersion) {
                        return;
                    }

                    clearInterval(interval);
                    setUpdatePhase('restart', 'done', _('updates.restart_complete'));
                    setUpdatePhase('done', 'done', _('updates.complete'));
                    logUpdate(_('updates.restart_complete'));

                    // Final modal: tell operator to refresh
                    window.Modal.close();
                    window.Modal.show({
                        title: _('updates.modal_done_title'),
                        content: `<p>${Utils.escapeHtml(_('updates.restart_complete_msg'))}</p>`,
                        buttons: [
                            { label: _('updates.modal_close'),     class: 'btn-secondary', onClick: () => { window.Modal.close(); } },
                            { label: _('updates.modal_reload_now'), class: 'btn-primary', icon: 'refresh', onClick: reloadConsole }
                        ],
                        closable: true
                    });

                    // Auto-reload after a short grace period so operators do
                    // not have to click — gives them time to read the modal.
                    setTimeout(reloadConsole, 8000);
                    return;
                }
            } catch (_e) {
                // Server still down, keep polling
            }
            if (attempts >= maxAttempts) {
                clearInterval(interval);
                setUpdatePhase('restart', 'warning', _('updates.restart_timeout'));
                setUpdatePhase('done', 'done', _('updates.complete'));
                logUpdate(_('updates.restart_timeout'));

                const installBtn = document.getElementById('update-install-btn');
                if (installBtn) installBtn.disabled = false;

                window.Modal.close();
                window.Modal.show({
                    title: _('updates.modal_done_title'),
                    content: `<p>${Utils.escapeHtml(_('updates.restart_timeout'))}</p><p>${Utils.escapeHtml(_('updates.refresh_recommended'))}</p>`,
                    buttons: [
                        { label: _('updates.modal_close'),     class: 'btn-secondary', onClick: () => { window.Modal.close(); } },
                        { label: _('updates.modal_reload_now'), class: 'btn-primary', icon: 'refresh', onClick: reloadConsole }
                    ],
                    closable: true
                });
            }
        }, 2000);
    }
    
    function formatBytes(n) {
        if (!Number.isFinite(n) || n <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0;
        let v = n;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
    }

    async function loadBackupRetention() {
        const input = document.getElementById('backup-retention-input');
        if (!input) return;
        try {
            const data = await Utils.api('/api/settings/backup/retention');
            const count = (data && typeof data.count === 'number') ? data.count : 0;
            input.value = String(count);
        } catch {
            input.value = '0';
        }
    }

    async function saveBackupRetention() {
        const input = document.getElementById('backup-retention-input');
        if (!input) return;
        const count = parseInt(input.value, 10);
        if (!Number.isFinite(count) || count < 0 || count > 1000) {
            Notifications.error(_('updates.retention_invalid'));
            return;
        }
        try {
            await Utils.api('/api/settings/backup/retention', {
                method: 'PUT',
                body: { count }
            });
            Notifications.success(_('updates.retention_saved'));
        } catch (err) {
            Notifications.error(err.message || _('errors.server_error'));
        }
    }

    async function pruneBackupsNow() {
        const input = document.getElementById('backup-retention-input');
        const count = parseInt(input?.value, 10);
        if (!Number.isFinite(count) || count <= 0) {
            Notifications.error(_('updates.retention_required_for_prune'));
            return;
        }
        if (!confirm(_('updates.prune_confirm').replace('{n}', String(count)))) return;
        try {
            const data = await Utils.api('/api/settings/updates/backups/prune', {
                method: 'POST',
                body: { keep: count }
            });
            const deleted = (data && Array.isArray(data.deleted)) ? data.deleted.length : 0;
            Notifications.success(_('updates.prune_done').replace('{n}', String(deleted)));
            await loadUpdateBackups();
        } catch (err) {
            Notifications.error(err.message || _('errors.server_error'));
        }
    }

    async function deleteBackup(name, btn) {
        if (!confirm(_('updates.delete_confirm').replace('{name}', name))) return;
        if (btn) btn.disabled = true;
        try {
            await Utils.api(`/api/settings/updates/backups/${encodeURIComponent(name)}`, {
                method: 'DELETE'
            });
            Notifications.success(_('updates.delete_success'));
            await loadUpdateBackups();
        } catch (err) {
            Notifications.error(err.message || _('errors.server_error'));
            if (btn) btn.disabled = false;
        }
    }

    async function loadUpdateBackups() {
        const listEl = document.getElementById('update-backups-list');
        if (!listEl) return;
        const summaryEl = document.getElementById('backup-summary');
        
        try {
            const data = await Utils.api('/api/settings/updates/backups');
            const backups = Array.isArray(data) ? data : (data.backups || []);
            
            if (!backups.length) {
                listEl.innerHTML = `<p class="text-muted">${_('updates.no_backups')}</p>`;
                if (summaryEl) summaryEl.textContent = '';
                return;
            }

            const totalBytes = backups.reduce((acc, b) => acc + (b.sizeBytes || 0), 0);
            if (summaryEl) {
                summaryEl.textContent = `${_('updates.total_size')}: ${formatBytes(totalBytes)} · ${backups.length} ${_('updates.backups_count')}`;
            }
            
            let html = '<div class="update-backups">';
            for (const b of backups) {
                const date = b.timestamp ? new Date(b.timestamp).toLocaleString() : '';
                const sha = b.sha ? ` · ${Utils.escapeHtml(b.sha)}` : '';
                const size = formatBytes(b.sizeBytes || 0);
                html += `<div class="update-backup-item">
                    <div class="update-backup-info">
                        <strong>${Utils.escapeHtml(b.name)}</strong>
                        <span class="text-muted">${date}${sha} · ${b.fileCount || b.filesBackedUp || 0} ${_('updates.files')} · ${size}</span>
                    </div>
                    <div class="update-backup-actions">
                        <button class="btn btn-sm btn-outline" data-backup-restore="${Utils.escapeHtml(b.name)}">
                            <span class="material-icons">restore</span> ${_('updates.restore')}
                        </button>
                        <button class="btn btn-sm btn-danger" data-backup-delete="${Utils.escapeHtml(b.name)}">
                            <span class="material-icons">delete</span> ${_('updates.delete')}
                        </button>
                    </div>
                </div>`;
            }
            html += '</div>';
            listEl.innerHTML = html;
            
            // Attach restore handlers
            listEl.querySelectorAll('[data-backup-restore]').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const name = btn.dataset.backupRestore;
                    if (!confirm(_('updates.restore_confirm'))) return;
                    
                    btn.disabled = true;
                    try {
                        await Utils.api('/api/settings/updates/restore', {
                            method: 'POST',
                            body: { backupName: name }
                        });
                        Notifications.success(_('updates.restore_success'));
                        setTimeout(() => window.location.reload(), 2000);
                    } catch (error) {
                        Notifications.error(error.message || _('errors.server_error'));
                        btn.disabled = false;
                    }
                });
            });

            // Attach delete handlers
            listEl.querySelectorAll('[data-backup-delete]').forEach(btn => {
                btn.addEventListener('click', () => deleteBackup(btn.dataset.backupDelete, btn));
            });
        } catch {
            listEl.innerHTML = `<p class="text-muted">${_('updates.no_backups')}</p>`;
            if (summaryEl) summaryEl.textContent = '';
        }
    }

    // Wire retention controls (idempotent — handles tab re-mount)
    document.addEventListener('click', (ev) => {
        const target = ev.target.closest('#backup-retention-save, #backup-prune-now');
        if (!target) return;
        if (target.id === 'backup-retention-save') saveBackupRetention();
        else if (target.id === 'backup-prune-now') pruneBackupsNow();
    });

    // Expose retention loader so tab activation can call it
    window.loadBackupRetention = loadBackupRetention;

    // ==================== LDAP / Authentication Section ====================

    /**
     * Initialize LDAP settings section
     */
    async function initEnrollmentSection() {
        const section = document.getElementById('enrollment-settings-section');
        if (!section) return;

        const modeRadios = document.querySelectorAll('input[name="settings_enrollment_mode"]');
        const requireCb = document.getElementById('enrollment-require-approval');
        const richCb = document.getElementById('enrollment-rich-approve');
        const tagPickerCb = document.getElementById('enrollment-tag-picker');
        const pendingHint = document.getElementById('enrollment-pending-hint');

        let saveTimer = null;

        async function loadEnrollmentSettings() {
            try {
                const res = await Utils.api('/api/settings/enrollment');
                const data = res.data || res;
                const mode = data.mode || 'open';
                modeRadios.forEach(r => { r.checked = r.value === mode; });
                if (requireCb) requireCb.checked = mode === 'managed';
                if (richCb) richCb.checked = data.rich_approve !== false;
                if (tagPickerCb) tagPickerCb.checked = data.tag_picker !== false;
                if (pendingHint && data.pending_count > 0) {
                    const msg = (window.BetterDesk?.translations?.settings?.enrollment_pending_count
                        || '{count} pending enrollment request(s)')
                        .replace('{count}', String(data.pending_count));
                    pendingHint.textContent = msg;
                } else if (pendingHint) {
                    pendingHint.textContent = '';
                }
            } catch (err) {
                console.error('Load enrollment settings:', err);
            }
        }

        function scheduleSave(patch) {
            clearTimeout(saveTimer);
            saveTimer = setTimeout(async () => {
                try {
                    await Utils.api('/api/settings/enrollment', {
                        method: 'PUT',
                        body: patch,
                    });
                    Notifications?.success?.(window.BetterDesk?.translations?.common?.saved || 'Saved');
                    await loadEnrollmentSettings();
                } catch (err) {
                    Notifications?.error?.(err.message || 'Save failed');
                }
            }, 400);
        }

        modeRadios.forEach(radio => {
            radio.addEventListener('change', () => {
                if (!radio.checked) return;
                if (requireCb) requireCb.checked = radio.value === 'managed';
                scheduleSave({ mode: radio.value });
            });
        });

        if (requireCb) {
            requireCb.addEventListener('change', () => {
                scheduleSave({ require_approval: requireCb.checked });
            });
        }
        if (richCb) {
            richCb.addEventListener('change', () => {
                scheduleSave({ rich_approve: richCb.checked });
            });
        }
        if (tagPickerCb) {
            tagPickerCb.addEventListener('change', () => {
                scheduleSave({ tag_picker: tagPickerCb.checked });
            });
        }

        await loadEnrollmentSettings();
    }

    async function initLdapSection() {
        const form = document.getElementById('ldap-form');
        if (!form) return;

        // Toggle config fields visibility based on enabled checkbox
        const enabledCb = document.getElementById('ldap-enabled');
        const configFields = document.getElementById('ldap-config-fields');
        if (enabledCb && configFields) {
            enabledCb.addEventListener('change', () => {
                configFields.style.display = enabledCb.checked ? '' : 'none';
            });
        }

        // Toggle direct bind vs bind+search fields
        const directBindCb = document.getElementById('ldap-direct-bind');
        const bindSearchFields = document.getElementById('ldap-bind-search-fields');
        const directBindFields = document.getElementById('ldap-direct-bind-fields');
        if (directBindCb) {
            directBindCb.addEventListener('change', () => {
                if (bindSearchFields) bindSearchFields.style.display = directBindCb.checked ? 'none' : '';
                if (directBindFields) directBindFields.style.display = directBindCb.checked ? '' : 'none';
            });
        }

        // Auto-update port when TLS checkbox changes
        const useTlsCb = document.getElementById('ldap-use-tls');
        const portInput = document.getElementById('ldap-port');
        if (useTlsCb && portInput) {
            useTlsCb.addEventListener('change', () => {
                const current = parseInt(portInput.value, 10);
                if (useTlsCb.checked && (current === 389 || !current)) {
                    portInput.value = 636;
                } else if (!useTlsCb.checked && current === 636) {
                    portInput.value = 389;
                }
            });
        }

        // Load existing config
        await loadLdapConfig();

        // Test connection button
        document.getElementById('ldap-test-btn')?.addEventListener('click', testLdapConnection);

        // Form submission
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            await saveLdapConfig();
        });
    }

    /**
     * Load LDAP configuration from Go server (via Node.js proxy)
     */
    async function loadLdapConfig() {
        try {
            const data = await Utils.api('/api/settings/ldap');
            populateLdapForm(data);
        } catch (error) {
            console.error('Failed to load LDAP config:', error);
        }
    }

    /**
     * Populate LDAP form fields with config data
     */
    function populateLdapForm(data) {
        if (!data) return;

        const setVal = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.value = val ?? '';
        };
        const setChecked = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.checked = !!val;
        };

        setChecked('ldap-enabled', data.enabled);
        setVal('ldap-host', data.host);
        setVal('ldap-port', data.port || 389);
        setChecked('ldap-use-tls', data.use_tls);
        setChecked('ldap-start-tls', data.start_tls);
        setChecked('ldap-skip-tls-verify', data.skip_tls_verify);
        setVal('ldap-bind-dn', data.bind_dn);
        setVal('ldap-bind-password', data.bind_password);
        setVal('ldap-base-dn', data.base_dn);
        setVal('ldap-user-filter', data.user_filter);
        setVal('ldap-user-attr-id', data.user_attr_id);
        setVal('ldap-user-attr-email', data.user_attr_email);
        setVal('ldap-user-attr-name', data.user_attr_name);
        setVal('ldap-group-base-dn', data.group_base_dn);
        setVal('ldap-group-filter', data.group_filter);
        setVal('ldap-group-attr-name', data.group_attr_name);
        setVal('ldap-default-role', data.default_role || 'viewer');
        setVal('ldap-group-role-map', data.group_role_map);
        setChecked('ldap-direct-bind', data.direct_bind);
        setVal('ldap-direct-bind-dn', data.direct_bind_dn);
        setVal('ldap-conn-timeout', data.conn_timeout_sec || 10);

        // Update visibility
        const configFields = document.getElementById('ldap-config-fields');
        if (configFields) configFields.style.display = data.enabled ? '' : 'none';

        const bindSearchFields = document.getElementById('ldap-bind-search-fields');
        const directBindFields = document.getElementById('ldap-direct-bind-fields');
        if (bindSearchFields) bindSearchFields.style.display = data.direct_bind ? 'none' : '';
        if (directBindFields) directBindFields.style.display = data.direct_bind ? '' : 'none';
    }

    /**
     * Collect LDAP form data
     */
    function collectLdapData() {
        const getVal = (id) => {
            const el = document.getElementById(id);
            return el ? el.value.trim() : '';
        };
        const getChecked = (id) => {
            const el = document.getElementById(id);
            return el ? el.checked : false;
        };

        return {
            enabled: getChecked('ldap-enabled'),
            host: getVal('ldap-host'),
            port: parseInt(getVal('ldap-port'), 10) || 389,
            use_tls: getChecked('ldap-use-tls'),
            start_tls: getChecked('ldap-start-tls'),
            skip_tls_verify: getChecked('ldap-skip-tls-verify'),
            bind_dn: getVal('ldap-bind-dn'),
            bind_password: getVal('ldap-bind-password'),
            base_dn: getVal('ldap-base-dn'),
            user_filter: getVal('ldap-user-filter'),
            user_attr_id: getVal('ldap-user-attr-id'),
            user_attr_email: getVal('ldap-user-attr-email'),
            user_attr_name: getVal('ldap-user-attr-name'),
            group_base_dn: getVal('ldap-group-base-dn'),
            group_filter: getVal('ldap-group-filter'),
            group_attr_name: getVal('ldap-group-attr-name'),
            default_role: getVal('ldap-default-role'),
            group_role_map: getVal('ldap-group-role-map'),
            direct_bind: getChecked('ldap-direct-bind'),
            direct_bind_dn: getVal('ldap-direct-bind-dn'),
            conn_timeout_sec: parseInt(getVal('ldap-conn-timeout'), 10) || 10
        };
    }

    /**
     * Save LDAP configuration
     */
    async function saveLdapConfig() {
        try {
            const data = collectLdapData();
            await Utils.api('/api/settings/ldap', {
                method: 'PUT',
                body: data
            });
            Notifications.success(_('settings.ldap_saved'));
        } catch (error) {
            Notifications.error(error.message || _('errors.server_error'));
        }
    }

    /**
     * Test LDAP connection with current form values
     */
    async function testLdapConnection() {
        const btn = document.getElementById('ldap-test-btn');
        const resultEl = document.getElementById('ldap-test-result');
        if (!btn) return;

        btn.disabled = true;
        btn.innerHTML = '<span class="material-icons spin">sync</span> ' + _('settings.ldap_testing');

        if (resultEl) {
            resultEl.innerHTML = '';
            resultEl.style.display = 'none';
        }

        try {
            const data = collectLdapData();
            const result = await Utils.api('/api/settings/ldap/test', {
                method: 'POST',
                body: data
            });

            if (resultEl) {
                resultEl.style.display = 'block';
                if (result.success) {
                    resultEl.innerHTML = '<div class="alert alert-success"><span class="material-icons">check_circle</span> ' + _('settings.ldap_test_success') + '</div>';
                } else {
                    resultEl.innerHTML = '<div class="alert alert-danger"><span class="material-icons">error</span> ' + Utils.escapeHtml(result.error || _('settings.ldap_test_failed')) + '</div>';
                }
            }
        } catch (error) {
            if (resultEl) {
                resultEl.style.display = 'block';
                resultEl.innerHTML = '<div class="alert alert-danger"><span class="material-icons">error</span> ' + Utils.escapeHtml(error.message || _('settings.ldap_test_failed')) + '</div>';
            }
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<span class="material-icons">cable</span> ' + _('settings.ldap_test_connection');
        }
    }

    // ==================== OIDC / OAuth2 Section ====================

    async function initOidcSection() {
        const form = document.getElementById('oidc-form');
        if (!form) return;

        // Toggle config fields visibility based on enabled checkbox
        const enabledCb = document.getElementById('oidc-enabled');
        const configFields = document.getElementById('oidc-config-fields');
        if (enabledCb && configFields) {
            enabledCb.addEventListener('change', () => {
                configFields.style.display = enabledCb.checked ? '' : 'none';
            });
        }

        // Toggle manual endpoints based on auto-discovery checkbox
        const autoDiscoveryCb = document.getElementById('oidc-auto-discovery');
        const manualEndpoints = document.getElementById('oidc-manual-endpoints');
        if (autoDiscoveryCb && manualEndpoints) {
            autoDiscoveryCb.addEventListener('change', () => {
                manualEndpoints.style.display = autoDiscoveryCb.checked ? 'none' : '';
            });
        }

        // Load existing config
        await loadOidcConfig();

        // Test discovery button
        document.getElementById('oidc-test-btn')?.addEventListener('click', testOidcDiscovery);

        // Form submission
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            await saveOidcConfig();
        });
    }

    async function loadOidcConfig() {
        try {
            const data = await Utils.api('/api/settings/oidc');
            populateOidcForm(data);
        } catch (error) {
            console.error('Failed to load OIDC config:', error);
        }
    }

    function populateOidcForm(data) {
        if (!data) return;

        const setVal = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.value = val ?? '';
        };
        const setChecked = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.checked = !!val;
        };

        setChecked('oidc-enabled', data.enabled);
        setVal('oidc-display-name', data.display_name);
        setVal('oidc-issuer-url', data.issuer_url);
        setVal('oidc-client-id', data.client_id);
        setVal('oidc-client-secret', data.client_secret);
        setVal('oidc-redirect-url', data.redirect_url);
        setVal('oidc-scopes', data.scopes || 'openid profile email');
        setChecked('oidc-use-pkce', data.use_pkce);
        setChecked('oidc-auto-discovery', data.auto_discovery !== false);
        setChecked('oidc-allow-signup', data.allow_signup !== false);
        setVal('oidc-authorization-url', data.authorization_url);
        setVal('oidc-token-url', data.token_url);
        setVal('oidc-userinfo-url', data.userinfo_url);
        setVal('oidc-claim-username', data.claim_username || 'preferred_username');
        setVal('oidc-claim-email', data.claim_email || 'email');
        setVal('oidc-claim-name', data.claim_name || 'name');
        setVal('oidc-claim-groups', data.claim_groups || 'groups');
        setVal('oidc-default-role', data.default_role || 'viewer');
        setVal('oidc-group-role-map', data.group_role_map);

        // Update visibility
        const configFields = document.getElementById('oidc-config-fields');
        if (configFields) configFields.style.display = data.enabled ? '' : 'none';
        const manualEndpoints = document.getElementById('oidc-manual-endpoints');
        if (manualEndpoints) manualEndpoints.style.display = (data.auto_discovery !== false) ? 'none' : '';
    }

    function collectOidcData() {
        const getVal = (id) => {
            const el = document.getElementById(id);
            return el ? el.value.trim() : '';
        };
        const getChecked = (id) => {
            const el = document.getElementById(id);
            return el ? el.checked : false;
        };

        return {
            enabled: getChecked('oidc-enabled'),
            display_name: getVal('oidc-display-name'),
            issuer_url: getVal('oidc-issuer-url'),
            client_id: getVal('oidc-client-id'),
            client_secret: getVal('oidc-client-secret'),
            redirect_url: getVal('oidc-redirect-url'),
            scopes: getVal('oidc-scopes'),
            use_pkce: getChecked('oidc-use-pkce'),
            auto_discovery: getChecked('oidc-auto-discovery'),
            allow_signup: getChecked('oidc-allow-signup'),
            authorization_url: getVal('oidc-authorization-url'),
            token_url: getVal('oidc-token-url'),
            userinfo_url: getVal('oidc-userinfo-url'),
            claim_username: getVal('oidc-claim-username'),
            claim_email: getVal('oidc-claim-email'),
            claim_name: getVal('oidc-claim-name'),
            claim_groups: getVal('oidc-claim-groups'),
            default_role: getVal('oidc-default-role'),
            group_role_map: getVal('oidc-group-role-map')
        };
    }

    async function saveOidcConfig() {
        try {
            const data = collectOidcData();
            await Utils.api('/api/settings/oidc', {
                method: 'PUT',
                body: data
            });
            Notifications.success(_('settings.oidc_saved'));
        } catch (error) {
            Notifications.error(error.message || _('errors.server_error'));
        }
    }

    async function testOidcDiscovery() {
        const btn = document.getElementById('oidc-test-btn');
        const resultEl = document.getElementById('oidc-test-result');
        if (!btn) return;

        btn.disabled = true;
        btn.innerHTML = '<span class="material-icons spin">sync</span> ' + _('settings.oidc_testing');

        if (resultEl) {
            resultEl.innerHTML = '';
            resultEl.style.display = 'none';
        }

        try {
            const issuerUrl = document.getElementById('oidc-issuer-url')?.value?.trim();
            if (!issuerUrl) {
                throw new Error(_('settings.oidc_issuer_required'));
            }

            const result = await Utils.api('/api/settings/oidc/test', {
                method: 'POST',
                body: { issuer_url: issuerUrl }
            });

            if (resultEl) {
                resultEl.style.display = 'block';
                if (result.success) {
                    let details = '';
                    if (result.authorization_endpoint) details += '<br><small>Authorization: ' + Utils.escapeHtml(result.authorization_endpoint) + '</small>';
                    if (result.token_endpoint) details += '<br><small>Token: ' + Utils.escapeHtml(result.token_endpoint) + '</small>';
                    if (result.userinfo_endpoint) details += '<br><small>Userinfo: ' + Utils.escapeHtml(result.userinfo_endpoint) + '</small>';
                    resultEl.innerHTML = '<div class="alert alert-success"><span class="material-icons">check_circle</span> ' + _('settings.oidc_test_success') + details + '</div>';
                } else {
                    resultEl.innerHTML = '<div class="alert alert-danger"><span class="material-icons">error</span> ' + Utils.escapeHtml(result.error || _('settings.oidc_test_failed')) + '</div>';
                }
            }
        } catch (error) {
            if (resultEl) {
                resultEl.style.display = 'block';
                resultEl.innerHTML = '<div class="alert alert-danger"><span class="material-icons">error</span> ' + Utils.escapeHtml(error.message || _('settings.oidc_test_failed')) + '</div>';
            }
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<span class="material-icons">travel_explore</span> ' + _('settings.oidc_test_discovery');
        }
    }

    // ==================== Advanced config files =================================

    const advancedState = { files: [], activeId: null, dirty: false, original: '' };

    /** Utils.api unwraps { success, data } — accept both shapes. */
    function unwrapAdvancedPayload(resp) {
        if (resp == null) return resp;
        if (Array.isArray(resp)) return resp;
        if (typeof resp === 'object' && resp.content !== undefined && resp.path !== undefined) {
            return resp;
        }
        if (typeof resp === 'object' && resp.data !== undefined) return resp.data;
        return resp;
    }

    function initAdvancedSection() {
        const listEl = document.getElementById('advanced-config-file-list');
        const textarea = document.getElementById('advanced-config-textarea');
        const saveBtn = document.getElementById('advanced-config-save');
        const reloadBtn = document.getElementById('advanced-config-reload');
        const restartBtn = document.getElementById('advanced-config-restart');
        if (!listEl) return;

        loadAdvancedFileList();

        saveBtn?.addEventListener('click', saveAdvancedFile);
        restartBtn?.addEventListener('click', restartAdvancedServices);
        reloadBtn?.addEventListener('click', () => {
            if (advancedState.activeId) loadAdvancedFile(advancedState.activeId, true);
        });

        textarea?.addEventListener('input', () => {
            advancedState.dirty = textarea.value !== advancedState.original;
            if (saveBtn) saveBtn.disabled = !advancedState.dirty;
        });

        window.addEventListener('beforeunload', (e) => {
            if (advancedState.dirty) {
                e.preventDefault();
                e.returnValue = '';
            }
        });
    }

    async function loadAdvancedFileList() {
        const listEl = document.getElementById('advanced-config-file-list');
        if (!listEl) return;
        try {
            const resp = await Utils.api('/api/settings/advanced/files');
            advancedState.files = unwrapAdvancedPayload(resp) || [];
            if (!Array.isArray(advancedState.files)) advancedState.files = [];
            if (!advancedState.files.length) {
                listEl.innerHTML = '<li class="text-muted">' + _('settings.advanced_no_files') + '</li>';
                return;
            }
            listEl.innerHTML = advancedState.files.map((f) => {
                const label = _('settings.advanced_file_' + f.id) !== 'settings.advanced_file_' + f.id
                    ? _('settings.advanced_file_' + f.id)
                    : f.id;
                const status = f.exists
                    ? (f.writable ? '' : ' <span class="badge badge-muted">' + _('settings.advanced_readonly') + '</span>')
                    : ' <span class="badge badge-muted">' + _('settings.advanced_missing') + '</span>';
                const disabled = !f.exists && !f.canCreate;
                return '<li><button type="button" class="advanced-config-file-btn' +
                    (advancedState.activeId === f.id ? ' active' : '') +
                    '" data-id="' + Utils.escapeHtml(f.id) + '"' +
                    (disabled ? ' disabled' : '') + '>' +
                    Utils.escapeHtml(label) + status + '</button></li>';
            }).join('');

            listEl.querySelectorAll('.advanced-config-file-btn').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const id = btn.getAttribute('data-id');
                    if (!id) return;
                    if (advancedState.dirty && !confirm(_('settings.advanced_unsaved_confirm'))) return;
                    loadAdvancedFile(id);
                });
            });

        } catch (err) {
            listEl.innerHTML = '<li class="text-danger">' + Utils.escapeHtml(err.message || _('errors.server_error')) + '</li>';
        }
    }

    function advancedRestartHint(restart) {
        if (restart === 'none') return _('settings.advanced_restart_none');
        const map = {
            console: _('settings.advanced_restart_console'),
            goserver: _('settings.advanced_restart_goserver'),
            systemd: _('settings.advanced_restart_systemd')
        };
        return map[restart] || _('settings.advanced_restart_generic');
    }

    function updateAdvancedRestartButton(catalogOrData) {
        const restartBtn = document.getElementById('advanced-config-restart');
        if (!restartBtn) return;
        const canRestart = catalogOrData && catalogOrData.requiresRestart !== 'none';
        const show = canRestart && (catalogOrData.exists || catalogOrData.canCreate);
        restartBtn.hidden = !show;
    }

    async function loadAdvancedFile(id, force) {
        if (!force && advancedState.dirty && !confirm(_('settings.advanced_unsaved_confirm'))) return;

        const placeholder = document.getElementById('advanced-config-placeholder');
        const toolbar = document.getElementById('advanced-config-toolbar');
        const textarea = document.getElementById('advanced-config-textarea');
        const hint = document.getElementById('advanced-config-restart-hint');
        const saveBtn = document.getElementById('advanced-config-save');
        const meta = document.getElementById('advanced-config-meta');
        const pathEl = document.getElementById('advanced-config-path');

        const catalog = advancedState.files.find((f) => f.id === id);
        if (catalog && !catalog.exists && catalog.canCreate) {
            advancedState.activeId = id;
            advancedState.original = '';
            advancedState.dirty = false;
            if (placeholder) placeholder.hidden = true;
            if (toolbar) toolbar.hidden = false;
            if (textarea) {
                textarea.hidden = false;
                textarea.value = '# ' + _('settings.advanced_new_file_hint') + '\n';
                textarea.disabled = !catalog.writable;
            }
            if (pathEl) pathEl.textContent = catalog.path;
            if (meta) meta.textContent = _('settings.advanced_new_file');
            if (hint) {
                hint.hidden = false;
                hint.textContent = advancedRestartHint(catalog.requiresRestart);
            }
            if (saveBtn) saveBtn.disabled = !catalog.writable;
            updateAdvancedRestartButton(catalog);
            document.querySelectorAll('.advanced-config-file-btn').forEach((b) => {
                b.classList.toggle('active', b.getAttribute('data-id') === id);
            });
            return;
        }

        try {
            const resp = await Utils.api('/api/settings/advanced/files/' + encodeURIComponent(id));
            const data = unwrapAdvancedPayload(resp);
            const cat = advancedState.files.find((f) => f.id === id);
            advancedState.activeId = id;
            advancedState.original = data.content || '';
            advancedState.dirty = false;

            if (placeholder) placeholder.hidden = true;
            if (toolbar) toolbar.hidden = false;
            if (textarea) {
                textarea.hidden = false;
                textarea.value = advancedState.original;
                textarea.disabled = cat ? !cat.writable : false;
            }
            if (pathEl) pathEl.textContent = data.path;
            if (meta) {
                const kb = ((data.size || 0) / 1024).toFixed(1);
                meta.textContent = kb + ' KB · ' + (data.mtime || '');
            }
            if (hint) {
                hint.hidden = false;
                hint.textContent = advancedRestartHint(data.requiresRestart);
            }
            if (saveBtn) saveBtn.disabled = !cat || !cat.writable;
            updateAdvancedRestartButton(cat || { exists: true });

            document.querySelectorAll('.advanced-config-file-btn').forEach((b) => {
                b.classList.toggle('active', b.getAttribute('data-id') === id);
            });
        } catch (err) {
            Notifications.error(err.message || _('errors.server_error'));
        }
    }

    async function saveAdvancedFile() {
        const id = advancedState.activeId;
        const textarea = document.getElementById('advanced-config-textarea');
        if (!id || !textarea) return;

        const catalog = advancedState.files.find((f) => f.id === id);
        if (catalog && !catalog.writable) {
            Notifications.error(_('settings.advanced_error_not_writable'));
            return;
        }

        if (!confirm(_('settings.advanced_save_confirm'))) return;

        const saveBtn = document.getElementById('advanced-config-save');
        if (saveBtn) saveBtn.disabled = true;

        try {
            const resp = await Utils.api('/api/settings/advanced/files/' + encodeURIComponent(id), {
                method: 'PUT',
                body: { content: textarea.value }
            });
            advancedState.original = textarea.value;
            advancedState.dirty = false;
            let msg = _('settings.advanced_saved');
            if (resp && resp.backupPath) {
                msg += ' (' + _('settings.advanced_backup_created') + ')';
            }
            Notifications.success(msg);
            await loadAdvancedFileList();
            loadAdvancedFile(id, true);

            if (confirm(_('settings.advanced_restart_after_save'))) {
                await restartAdvancedServices(true);
            }
        } catch (err) {
            Notifications.error(err.message || _('errors.server_error'));
            if (saveBtn) saveBtn.disabled = advancedState.dirty;
        }
    }

    async function restartAdvancedServices(skipConfirm) {
        const id = advancedState.activeId;
        if (!id) return;

        if (advancedState.dirty && !confirm(_('settings.advanced_unsaved_confirm'))) return;

        const catalog = advancedState.files.find((f) => f.id === id);
        const isConsole = catalog && (catalog.requiresRestart === 'console' || id === 'systemd-console'
            || id === 'console-env' || id === 'console-env-local');
        const confirmKey = isConsole
            ? 'settings.advanced_restart_console_confirm'
            : 'settings.advanced_restart_confirm';
        if (!skipConfirm && !confirm(_(confirmKey))) return;

        const restartBtn = document.getElementById('advanced-config-restart');
        if (restartBtn) restartBtn.disabled = true;

        try {
            const result = await Utils.api('/api/settings/advanced/restart', {
                method: 'POST',
                body: { fileId: id }
            });
            Notifications.success(_('settings.advanced_restart_started'));

            if (result && result.needsConsolePoll) {
                pollAdvancedConsoleRestart();
            }
        } catch (err) {
            const detail = err.data && (err.data.details || err.data.error);
            Notifications.error(detail || err.message || _('settings.advanced_restart_failed'));
        } finally {
            if (restartBtn) restartBtn.disabled = false;
        }
    }

    function pollAdvancedConsoleRestart() {
        let attempts = 0;
        const maxAttempts = 90;
        const previousCacheVersion = window.BetterDesk?.cacheVersion || '';
        Notifications.info(_('settings.advanced_restart_polling'));

        const interval = setInterval(async () => {
            attempts++;
            try {
                const resp = await fetch('/api/settings/restart-status?_=' + Date.now(), {
                    credentials: 'same-origin',
                    cache: 'no-store'
                });
                if (resp.ok) {
                    const body = await resp.json().catch(() => null);
                    const status = body?.data || body || {};
                    if (previousCacheVersion && status.cacheVersion && status.cacheVersion === previousCacheVersion) {
                        return;
                    }
                    clearInterval(interval);
                    Notifications.success(_('settings.advanced_restart_done'));
                    setTimeout(() => window.location.reload(), 2000);
                    return;
                }
            } catch (_) { /* console still restarting */ }
            if (attempts >= maxAttempts) {
                clearInterval(interval);
                Notifications.warning(_('settings.advanced_restart_timeout'));
            }
        }, 2000);
    }

    // ==================== Email / SMTP ====================

    function initEmailSection() {
        const saveBtn = document.getElementById('email-smtp-save-btn');
        const testBtn = document.getElementById('email-smtp-test-btn');
        if (!saveBtn || !testBtn) return;

        loadEmailSmtpConfig();

        saveBtn.addEventListener('click', async () => {
            const body = {
                host: document.getElementById('email-smtp-host')?.value.trim() || '',
                port: parseInt(document.getElementById('email-smtp-port')?.value, 10) || 587,
                secure: !!document.getElementById('email-smtp-secure')?.checked,
                user: document.getElementById('email-smtp-user')?.value.trim() || '',
                pass: document.getElementById('email-smtp-pass')?.value || '',
                from: document.getElementById('email-smtp-from')?.value.trim() || '',
                alert_email: document.getElementById('email-smtp-alert')?.value.trim() || '',
            };
            try {
                const res = await fetch('/api/settings/email/smtp', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': window.BetterDesk?.csrfToken || '' },
                    body: JSON.stringify(body),
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Save failed');
                Notifications.success(_('settings.email.smtp_saved'));
                document.getElementById('email-smtp-pass').value = '';
                await loadEmailSmtpConfig();
            } catch (err) {
                Notifications.error(err.message || _('errors.server_error'));
            }
        });

        testBtn.addEventListener('click', async () => {
            try {
                const res = await fetch('/api/settings/email/smtp/test', {
                    method: 'POST',
                    headers: { 'X-CSRF-Token': window.BetterDesk?.csrfToken || '' },
                });
                const data = await res.json();
                if (data.success) {
                    Notifications.success(_('settings.email.smtp_test_success'));
                } else {
                    Notifications.error(data.error || _('settings.email.smtp_test_failed'));
                }
            } catch (_) {
                Notifications.error(_('settings.email.smtp_test_failed'));
            }
        });
    }

    async function loadEmailSmtpConfig() {
        try {
            const res = await fetch('/api/settings/email/smtp');
            const config = await res.json();
            if (!config.configured) return;
            document.getElementById('email-smtp-host').value = config.host || '';
            document.getElementById('email-smtp-port').value = config.port || 587;
            document.getElementById('email-smtp-secure').checked = !!config.secure;
            document.getElementById('email-smtp-user').value = config.user || '';
            document.getElementById('email-smtp-from').value = config.from || '';
            document.getElementById('email-smtp-alert').value = config.alert_email || '';
        } catch (_) { /* not configured yet */ }
    }
    
})();
