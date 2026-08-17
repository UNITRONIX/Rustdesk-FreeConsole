/**
 * BetterDesk Console - Dashboard Page
 */

(function() {
    'use strict';
    
    const _ = window._ || (k => k);
    
    let rootEl = document;
    let initialized = false;
    let refreshInterval = null;
    let activityInterval = null;
    let refreshHandler = null;
    let statusButton = null;
    let statusButtonHandler = null;
    let tipDismissButton = null;
    let tipDismissHandler = null;
    let copyAllConfigButton = null;
    let copyAllConfigHandler = null;
    let copyDeployStringButton = null;
    let copyDeployStringHandler = null;
    let showIntuneScriptButton = null;
    let showIntuneScriptHandler = null;
    let showClientQrButton = null;
    let showClientQrHandler = null;
    let clientConfigHostInput = null;
    let applyClientHostButton = null;
    let applyClientHostHandler = null;
    let clientConfigCopyButtons = [];
    const clientConfigCopyHandlers = new Map();
    let clientConfigKeyRevealButton = null;
    let clientConfigKeyRevealHandler = null;
    let publicKeyVisible = false;
    let clientConfig = null;
    const pendingRequests = new Map();
    const PUBLIC_KEY_MASK = '••••••••••••••••••••••••';
    
    // Tips pool — rotated daily
    const TIPS = [
        'dashboard.tip_desktop_mode',
        'dashboard.tip_keyboard_shortcuts',
        'dashboard.tip_address_book',
        'dashboard.tip_2fa',
        'dashboard.tip_bulk_actions',
        'dashboard.tip_theme',
        'dashboard.tip_cdap'
    ];
    
    function init(root) {
        destroy();
        rootEl = root || document;

        if (!findById('welcome-section')) return;
        initialized = true;

        renderGreeting();
        renderTip();
        loadActivityFeed();
        loadOverview();
        loadClientConfig();
        
        // Auto-refresh every 30 seconds
        refreshInterval = setInterval(() => {
            loadOverview();
        }, 30000);
        
        // Activity feed refresh every 60 seconds
        activityInterval = setInterval(loadActivityFeed, 60000);
        
        // Manual refresh
        refreshHandler = () => {
            loadActivityFeed();
            loadOverview();
            loadClientConfig();
        };
        window.addEventListener('app:refresh', refreshHandler);
        
        // Refresh status button
        statusButton = findById('refresh-status-btn');
        statusButtonHandler = () => loadServerStatus();
        statusButton?.addEventListener('click', statusButtonHandler);
        
        // Tip dismiss
        tipDismissButton = findById('tip-dismiss');
        tipDismissHandler = () => {
            const tip = findById('welcome-tip');
            if (tip) {
                tip.style.display = 'none';
                try { localStorage.setItem('bd_tip_dismissed', new Date().toDateString()); } catch {}
            }
        };
        tipDismissButton?.addEventListener('click', tipDismissHandler);

        copyAllConfigButton = findById('copy-client-config-btn');
        copyAllConfigHandler = copyFullClientConfig;
        copyAllConfigButton?.addEventListener('click', copyAllConfigHandler);

        copyDeployStringButton = findById('copy-deploy-string-btn');
        copyDeployStringHandler = copyDeployConfigString;
        copyDeployStringButton?.addEventListener('click', copyDeployStringHandler);

        showIntuneScriptButton = findById('show-intune-script-btn');
        showIntuneScriptHandler = showIntuneScriptModal;
        showIntuneScriptButton?.addEventListener('click', showIntuneScriptHandler);

        showClientQrButton = findById('show-client-qr-btn');
        showClientQrHandler = showClientConfigQr;
        showClientQrButton?.addEventListener('click', showClientQrHandler);

        clientConfigHostInput = findById('client-config-host-input');
        applyClientHostButton = findById('apply-client-host-btn');
        applyClientHostHandler = () => loadClientConfig({ persistHost: true });
        applyClientHostButton?.addEventListener('click', applyClientHostHandler);
        clientConfigHostInput?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                loadClientConfig({ persistHost: true });
            }
        });

        clientConfigCopyButtons = Array.from(rootEl.querySelectorAll?.('.client-config-copy') || []);
        clientConfigCopyButtons.forEach(button => {
            const handler = () => copyClientConfigField(button.dataset.copyTarget, button);
            clientConfigCopyHandlers.set(button, handler);
            button.addEventListener('click', handler);
        });

        clientConfigKeyRevealButton = findById('client-config-key-reveal');
        clientConfigKeyRevealHandler = togglePublicKeyVisibility;
        clientConfigKeyRevealButton?.addEventListener('click', clientConfigKeyRevealHandler);
        
        // Cleanup on page leave
        window.addEventListener('beforeunload', destroy, { once: true });
    }

    function destroy() {
        if (refreshInterval) clearInterval(refreshInterval);
        if (activityInterval) clearInterval(activityInterval);
        if (refreshHandler) window.removeEventListener('app:refresh', refreshHandler);
        if (statusButton && statusButtonHandler) statusButton.removeEventListener('click', statusButtonHandler);
        if (tipDismissButton && tipDismissHandler) tipDismissButton.removeEventListener('click', tipDismissHandler);
        if (copyAllConfigButton && copyAllConfigHandler) copyAllConfigButton.removeEventListener('click', copyAllConfigHandler);
        if (copyDeployStringButton && copyDeployStringHandler) copyDeployStringButton.removeEventListener('click', copyDeployStringHandler);
        if (showIntuneScriptButton && showIntuneScriptHandler) showIntuneScriptButton.removeEventListener('click', showIntuneScriptHandler);
        if (showClientQrButton && showClientQrHandler) showClientQrButton.removeEventListener('click', showClientQrHandler);
        if (applyClientHostButton && applyClientHostHandler) applyClientHostButton.removeEventListener('click', applyClientHostHandler);
        clientConfigCopyButtons.forEach(button => {
            const handler = clientConfigCopyHandlers.get(button);
            if (handler) button.removeEventListener('click', handler);
        });
        clientConfigCopyHandlers.clear();
        if (clientConfigKeyRevealButton && clientConfigKeyRevealHandler) {
            clientConfigKeyRevealButton.removeEventListener('click', clientConfigKeyRevealHandler);
        }

        refreshInterval = null;
        activityInterval = null;
        refreshHandler = null;
        statusButton = null;
        statusButtonHandler = null;
        tipDismissButton = null;
        tipDismissHandler = null;
        copyAllConfigButton = null;
        copyAllConfigHandler = null;
        copyDeployStringButton = null;
        copyDeployStringHandler = null;
        showIntuneScriptButton = null;
        showIntuneScriptHandler = null;
        showClientQrButton = null;
        showClientQrHandler = null;
        clientConfigHostInput = null;
        applyClientHostButton = null;
        applyClientHostHandler = null;
        clientConfigCopyButtons = [];
        clientConfigKeyRevealButton = null;
        clientConfigKeyRevealHandler = null;
        publicKeyVisible = false;
        clientConfig = null;
        initialized = false;
    }

    async function loadOverview() {
        const [stats, status] = await Promise.all([
            loadStats(),
            loadServerStatus()
        ]);
        loadHealthOverview(stats, status);
    }
    
    /**
     * Render time-based personalized greeting
     */
    function renderGreeting() {
        const el = findById('welcome-greeting-text');
        if (!el) return;
        
        const hour = new Date().getHours();
        let greetingKey;
        if (hour < 6) greetingKey = 'dashboard.greeting_night';
        else if (hour < 12) greetingKey = 'dashboard.greeting_morning';
        else if (hour < 18) greetingKey = 'dashboard.greeting_afternoon';
        else greetingKey = 'dashboard.greeting_evening';
        
        // Get username from global config
        const username = window.BetterDesk?.user?.username || 'Admin';
        
        const greeting = _(greetingKey);
        el.textContent = greeting.replace('{name}', username);
    }
    
    /**
     * Show tip of the day
     */
    function renderTip() {
        const tipEl = findById('welcome-tip');
        const textEl = findById('tip-text');
        if (!tipEl || !textEl) return;
        
        // Hide if already dismissed today
        try {
            if (localStorage.getItem('bd_tip_dismissed') === new Date().toDateString()) {
                tipEl.style.display = 'none';
                return;
            }
        } catch {}
        
        // Pick tip based on day of year
        const now = new Date();
        const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
        const tip = TIPS[dayOfYear % TIPS.length];
        textEl.textContent = _(tip);
    }
    
    /**
     * Load device statistics
     */
    async function loadStats() {
        try {
            const data = await fetchApi('/api/stats');
            const stats = data.devices || data;
            
            // Update stats with values
            setStatValue('stat-total', stats.total ?? 0);
            setStatValue('stat-online', stats.online ?? 0);
            setStatValue('stat-banned', stats.banned ?? 0);
            setStatValue('stat-connections', stats.offline ?? 0);
            return stats;
            
        } catch (error) {
            console.error('Failed to load stats:', error);
            // Show zeros on error
            setStatValue('stat-total', 0);
            setStatValue('stat-online', 0);
            setStatValue('stat-banned', 0);
            setStatValue('stat-connections', 0);
            return null;
        }
    }
    
    /**
     * Set stat value directly (replacing skeleton)
     */
    function setStatValue(elementId, value) {
        const element = findById(elementId);
        if (!element) return;
        // Use textContent for security (no HTML parsing)
        element.textContent = value;
    }
    
    /**
     * Update a stat element with animation
     */
    function updateStat(elementId, value) {
        const element = findById(elementId);
        if (!element) return;
        
        const currentValue = parseInt(element.textContent) || 0;
        
        if (currentValue === value) return;
        
        // Simple counter animation
        const duration = 500;
        const steps = 20;
        const stepValue = (value - currentValue) / steps;
        let step = 0;
        
        const interval = setInterval(() => {
            step++;
            if (step >= steps) {
                element.textContent = value;
                clearInterval(interval);
            } else {
                element.textContent = Math.round(currentValue + stepValue * step);
            }
        }, duration / steps);
    }
    
    /**
     * Load server status
     */
    async function loadServerStatus() {
        try {
            const status = await fetchApi('/api/server/status');
            
            updateServerStatus('hbbs-status', status.hbbs);
            updateServerStatus('hbbr-status', status.hbbr);
            updateSystemStatus(status);
            
            // Populate all port values from server response
            const portMap = {
                'api-port': status.api_port,
                'hbbs-port': status.signal_port || status.hbbs_port,
                'hbbr-port': status.relay_port || status.hbbr_port,
                'nat-port': status.nat_port,
                'ws-signal-port': status.ws_signal_port,
                'ws-relay-port': status.ws_relay_port,
                'client-api-port': status.client_api_port,
                'console-port': status.console_port
            };
            
            for (const [id, value] of Object.entries(portMap)) {
                const el = findById(id);
                if (el && value) el.textContent = value;
            }
            return status;
            
        } catch (error) {
            console.error('Failed to load server status:', error);
            updateServerStatus('hbbs-status', { status: 'unknown' });
            updateServerStatus('hbbr-status', { status: 'unknown' });
            updateSystemStatus(null);
            return null;
        }
    }
    
    /**
     * Update server status indicator
     */
    function updateServerStatus(elementId, status) {
        const element = findById(elementId);
        if (!element) return;
        
        const statusDot = element.querySelector('.status-dot');
        const statusText = element.querySelector('.status-text');
        
        // Remove existing classes
        element.classList.remove('running', 'stopped', 'unknown');
        
        if (status?.status === 'running' || status?.online) {
            element.classList.add('running');
            statusText.textContent = _('status.running');
        } else if (status?.status === 'stopped' || status?.online === false) {
            element.classList.add('stopped');
            statusText.textContent = _('status.stopped');
        } else {
            element.classList.add('unknown');
            statusText.textContent = _('status.unknown');
        }
    }

    function updateSystemStatus(status) {
        const pill = findById('dashboard-system-pill');
        const text = findById('dashboard-system-status');
        if (!pill || !text) return;

        pill.classList.remove('running', 'stopped', 'unknown');

        const signalRunning = status?.hbbs?.status === 'running' || status?.hbbs?.online === true;
        const relayRunning = status?.hbbr?.status === 'running' || status?.hbbr?.online === true;

        if (signalRunning && relayRunning) {
            pill.classList.add('running');
            text.textContent = _('dashboard.system_ready');
        } else if (status) {
            pill.classList.add('stopped');
            text.textContent = _('dashboard.system_attention');
        } else {
            pill.classList.add('unknown');
            text.textContent = _('status.unknown');
        }
    }

    const CLIENT_HOST_STORAGE_KEY = 'bd_client_config_host';

    function getStoredClientHost() {
        try {
            return sessionStorage.getItem(CLIENT_HOST_STORAGE_KEY) || '';
        } catch {
            return '';
        }
    }

    function setStoredClientHost(host) {
        try {
            if (host) {
                sessionStorage.setItem(CLIENT_HOST_STORAGE_KEY, host);
            } else {
                sessionStorage.removeItem(CLIENT_HOST_STORAGE_KEY);
            }
        } catch {
            /* ignore */
        }
    }

    function resolveClientHostOverride() {
        const fromInput = clientConfigHostInput?.value?.trim();
        if (fromInput) {
            return fromInput;
        }
        return getStoredClientHost();
    }

    async function loadClientConfig(options = {}) {
        const hostOverride = resolveClientHostOverride();
        const query = hostOverride ? `?host=${encodeURIComponent(hostOverride)}` : '';

        try {
            const data = await fetchApi(`/api/dashboard/client-config${query}`);
            clientConfig = data || {};

            if (clientConfigHostInput && !hostOverride && clientConfig.client_server_host) {
                clientConfigHostInput.value = clientConfig.client_server_host;
            } else if (clientConfigHostInput && hostOverride) {
                clientConfigHostInput.value = hostOverride;
            }

            if (options.persistHost && hostOverride) {
                setStoredClientHost(hostOverride);
            }

            setText('client-config-server-id', clientConfig.server_id || '-');
            setText('client-config-relay-server', clientConfig.relay_server || '-');
            setText('client-config-api-url', clientConfig.api_url || '-');
            renderPublicKeyField(clientConfig.public_key || '', false);
            updateClientHostControls(clientConfig);
        } catch (err) {
            console.error('Client config load error:', err);
            clientConfig = null;
            setText('client-config-server-id', window.location.hostname || '-');
            setText('client-config-relay-server', window.location.hostname || '-');
            setText('client-config-api-url', '-');
            renderPublicKeyField('', false, _('errors.load_key_failed'));
        }
    }

    function getPublicKeyRaw() {
        return (clientConfig?.public_key || '').trim();
    }

    function renderPublicKeyField(rawKey, visible, errorText) {
        const el = findById('client-config-public-key');
        const revealBtn = clientConfigKeyRevealButton || findById('client-config-key-reveal');
        if (!el) return;

        const key = (rawKey || '').trim();
        publicKeyVisible = Boolean(visible && key);

        if (errorText) {
            el.textContent = errorText;
            el.classList.remove('is-masked');
            el.removeAttribute('data-raw');
            if (revealBtn) revealBtn.disabled = true;
            syncPublicKeyRevealButton();
            return;
        }

        if (!key) {
            el.textContent = _('keys.no_key');
            el.classList.remove('is-masked');
            el.removeAttribute('data-raw');
            if (revealBtn) revealBtn.disabled = true;
            syncPublicKeyRevealButton();
            return;
        }

        el.dataset.raw = key;
        if (publicKeyVisible) {
            el.textContent = key;
            el.classList.remove('is-masked');
        } else {
            el.textContent = PUBLIC_KEY_MASK;
            el.classList.add('is-masked');
        }
        if (revealBtn) revealBtn.disabled = false;
        syncPublicKeyRevealButton();
    }

    function syncPublicKeyRevealButton() {
        const revealBtn = clientConfigKeyRevealButton || findById('client-config-key-reveal');
        if (!revealBtn) return;
        const icon = revealBtn.querySelector('.material-icons');
        const label = publicKeyVisible ? _('actions.hide_value') : _('actions.show_value');
        revealBtn.title = label;
        revealBtn.setAttribute('aria-label', `${label} ${_('dashboard.config_key')}`);
        revealBtn.setAttribute('aria-pressed', publicKeyVisible ? 'true' : 'false');
        if (icon) icon.textContent = publicKeyVisible ? 'visibility_off' : 'visibility';
    }

    function togglePublicKeyVisibility() {
        const raw = getPublicKeyRaw();
        if (!raw) return;
        renderPublicKeyField(raw, !publicKeyVisible);
    }

    function updateClientHostControls(config) {
        const hintEl = findById('client-config-host-hint');
        const envOverride = Boolean(config?.env_override_active);

        if (clientConfigHostInput) {
            clientConfigHostInput.disabled = envOverride;
        }
        if (applyClientHostButton) {
            applyClientHostButton.disabled = envOverride;
        }
        if (hintEl) {
            hintEl.textContent = envOverride
                ? _('dashboard.client_server_host_env_hint')
                : _('dashboard.client_server_host_hint');
        }
    }

    async function copyClientConfigField(elementId, button) {
        const el = elementId ? findById(elementId) : null;
        let value = el?.textContent?.trim();

        if (elementId === 'client-config-public-key') {
            value = getPublicKeyRaw() || el?.dataset?.raw?.trim() || '';
            if (!value || value === _('keys.no_key') || value === _('errors.load_key_failed')) {
                Notifications.warning(_('dashboard.config_not_ready'));
                return;
            }
        } else if (!value || value === '-' || value === _('keys.no_key') || value === _('errors.load_key_failed')) {
            Notifications.warning(_('dashboard.config_not_ready'));
            return;
        }

        await Utils.copyToClipboard(value);
        markCopied(button);
        Notifications.success(_('common.copied'));
    }

    async function copyFullClientConfig() {
        if (!clientConfig) {
            Notifications.warning(_('dashboard.config_not_ready'));
            return;
        }

        const lines = [
            `${_('dashboard.config_server_id')}: ${clientConfig.server_id || '-'}`,
            `${_('dashboard.config_relay_server')}: ${clientConfig.relay_server || '-'}`,
            `${_('dashboard.config_api_server')}: ${clientConfig.api_url || '-'}`,
            `${_('dashboard.config_key')}: ${clientConfig.public_key || '-'}`
        ];

        await Utils.copyToClipboard(lines.join('\n'));
        markCopied(copyAllConfigButton);
        Notifications.success(_('common.copied'));
    }

    async function copyDeployConfigString() {
        const value = clientConfig?.deploy_config_string?.trim();
        if (!value) {
            Notifications.warning(_('dashboard.deploy_string_not_ready'));
            return;
        }

        await Utils.copyToClipboard(value);
        markCopied(copyDeployStringButton);
        Notifications.success(_('common.copied'));
    }

    function buildIntuneScriptSnippet() {
        const host = clientConfig?.server_id || clientConfig?.client_server_host || 'YOUR_SERVER_HOST';
        const apiUrl = clientConfig?.api_url || `http://${host}:21114`;
        const publicKey = clientConfig?.public_key || 'YOUR_PUBLIC_KEY';

        return `# Run elevated after RustDesk MSI (PSADT post-install / Intune Win32)
$RustDesk = Join-Path $env:ProgramFiles 'RustDesk\\rustdesk.exe'
$ServerHost = '${host.replace(/'/g, "''")}'
$PublicKey = '${publicKey.replace(/'/g, "''")}'
$ApiUrl = '${apiUrl.replace(/'/g, "''")}'

$json = @{
    host = $ServerHost
    relay = $ServerHost
    api = $ApiUrl
    key = $PublicKey
} | ConvertTo-Json -Compress
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)).TrimEnd('=')
$CfgString = -join ($b64[-1..-($b64.Length)] -join '')

Start-Process -FilePath $RustDesk -ArgumentList @('--config', $CfgString) -Wait -NoNewWindow
# Optional unattended password:
# Start-Process -FilePath $RustDesk -ArgumentList @('--password', 'YourPermanentPassword') -Wait -NoNewWindow`;
    }

    function showIntuneScriptModal() {
        if (!clientConfig?.deploy_config_string) {
            Notifications.warning(_('dashboard.deploy_string_not_ready'));
            return;
        }

        const script = buildIntuneScriptSnippet();
        Modal.show({
            title: _('dashboard.intune_script_title'),
            content: `
                <div class="client-config-script-modal">
                    <p>${escapeHtml(_('dashboard.intune_script_hint'))}</p>
                    <pre class="client-config-script-block"><code>${escapeHtml(script)}</code></pre>
                </div>
            `,
            buttons: [
                {
                    label: _('actions.copy'),
                    class: 'btn-primary',
                    onClick: async () => {
                        await Utils.copyToClipboard(script);
                        Notifications.success(_('common.copied'));
                    }
                },
                { label: _('actions.close'), class: 'btn-secondary', onClick: () => Modal.close() }
            ],
            size: 'large'
        });
    }

    function showClientConfigQr() {
        if (!clientConfig?.qr) {
            Notifications.warning(_('keys.no_qr'));
            return;
        }

        const warn = clientConfig.phone_unreachable_host
            ? `<p class="client-config-qr-warn">${escapeHtml(_('dashboard.client_config_qr_unreachable_host'))}</p>`
            : '';

        Modal.show({
            title: _('dashboard.client_config_qr_title'),
            content: `
                <div class="client-config-qr-modal">
                    <div class="client-config-qr-frame">
                        <img src="${escapeHtml(clientConfig.qr)}" alt="${escapeHtml(_('dashboard.client_config_qr_title'))}" width="300" height="300">
                    </div>
                    <p>${escapeHtml(_('dashboard.client_config_qr_hint'))}</p>
                    ${warn}
                </div>
            `,
            buttons: [
                { label: _('actions.close'), class: 'btn-secondary', onClick: () => Modal.close() }
            ],
            size: 'medium'
        });
    }

    function markCopied(button) {
        if (!button) return;
        button.classList.add('copied');
        setTimeout(() => button.classList.remove('copied'), 1600);
    }
    
    /**
     * Load activity feed from audit log
     */
    async function loadActivityFeed() {
        const container = findById('activity-feed');
        if (!container) return;
        
        try {
            const data = await fetchApi('/api/dashboard/activity');
            const events = data.events || data.data?.events || [];
            
            if (events.length === 0) {
                container.innerHTML = `<div class="activity-empty">${_('dashboard.no_recent_activity')}</div>`;
                return;
            }
            
            container.innerHTML = events.slice(0, 10).map(ev => {
                const iconMap = {
                    'conn_start': { icon: 'link', cls: 'connect' },
                    'conn_end': { icon: 'link_off', cls: 'disconnect' },
                    'login': { icon: 'login', cls: 'login' },
                    'login_failed': { icon: 'error', cls: 'ban' },
                    'ban': { icon: 'block', cls: 'ban' },
                    'unban': { icon: 'check_circle', cls: 'unban' },
                    'file_transfer': { icon: 'upload_file', cls: 'file' },
                    'alarm': { icon: 'warning', cls: 'alert' }
                };
                const info = iconMap[ev.action] || { icon: 'info', cls: 'connect' };
                const timeAgo = formatTimeAgo(ev.timestamp || ev.created_at);
                const detail = ev.device_id || ev.peer_id || ev.details || '';
                
                return `<div class="activity-item stagger-item">
                    <div class="activity-icon ${info.cls}">
                        <span class="material-icons">${info.icon}</span>
                    </div>
                    <div class="activity-content">
                        <div class="activity-text">${escapeHtml(ev.action_label || ev.action)}${detail ? ' — <strong>' + escapeHtml(String(detail)) + '</strong>' : ''}</div>
                        <div class="activity-time">${timeAgo}</div>
                    </div>
                </div>`;
            }).join('');
        } catch (err) {
            console.error('Activity feed error:', err);
            container.innerHTML = `<div class="activity-empty">${_('dashboard.no_recent_activity')}</div>`;
        }
    }
    
    /**
     * Load health overview data
     */
    async function loadHealthOverview(stats, status) {
        try {
            if (!stats) {
                const data = await fetchApi('/api/stats');
                stats = data.devices || data.data?.devices || data;
            }
            
            setText('health-online', stats.online ?? 0);
            setText('health-alerts', stats.banned ?? 0);
            setText('health-connections', stats.total ?? 0);
            
            // Server uptime from status
            try {
                status = status || await fetchApi('/api/server/status');
                const uptime = status.uptime || status.data?.uptime;
                setText('health-uptime', uptime ? formatUptime(uptime) : '-');
            } catch {
                setText('health-uptime', '-');
            }
        } catch (err) {
            console.error('Health overview error:', err);
        }
    }
    
    function setText(id, value) {
        const el = findById(id);
        if (el) el.textContent = value;
    }

    function findById(id) {
        if (rootEl && rootEl !== document && typeof rootEl.querySelector === 'function') {
            const scoped = rootEl.querySelector('#' + id);
            if (scoped) return scoped;
        }
        return document.getElementById(id);
    }

    function fetchApi(endpoint) {
        if (pendingRequests.has(endpoint)) return pendingRequests.get(endpoint);
        const request = Utils.api(endpoint).finally(() => pendingRequests.delete(endpoint));
        pendingRequests.set(endpoint, request);
        return request;
    }
    
    function formatUptime(seconds) {
        if (typeof seconds !== 'number') return String(seconds);
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        if (d > 0) return `${d}d ${h}h`;
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    }
    
    function formatTimeAgo(timestamp) {
        if (!timestamp) return '';
        const diff = Date.now() - new Date(timestamp).getTime();
        const secs = Math.floor(diff / 1000);
        if (secs < 60) return _('dashboard.just_now');
        const mins = Math.floor(secs / 60);
        if (mins < 60) return `${mins}m ${_('dashboard.ago')}`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h ${_('dashboard.ago')}`;
        const days = Math.floor(hours / 24);
        return `${days}d ${_('dashboard.ago')}`;
    }
    
    function escapeHtml(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    window.BetterDeskPanelMounts = window.BetterDeskPanelMounts || {};
    window.BetterDeskPanelMounts.dashboard = {
        mount: init,
        destroy: destroy,
        refresh: loadOverview
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => init(document));
    } else {
        init(document);
    }
    
})();
