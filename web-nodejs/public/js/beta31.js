/**
 * BetterDesk Console — Beta 3.1 Panel Controller
 * Manages the ISPmanager-inspired shell: sidebar navigation, content loading
 */

(function () {
    'use strict';

    const STORAGE_KEY = 'bd_beta31_active';
    const STORAGE_PANEL = 'bd_beta31_panel';
    let shell = null;
    let contentArea = null;
    let currentPanel = null;

    const PANEL_ROUTES = {
        dashboard: '/',
        cdap: '/cdap'
    };

    /* ──────────────────────────────────────────────
       Menu definition — mirrors sidebar.ejs entries
       ────────────────────────────────────────────── */
    function getMenuSections() {
        const t = (k, fb) => (typeof _ === 'function' ? _(k) : fb) || fb;
        return [
            {
                heading: t('nav.main', 'Main'),
                items: [
                    { id: 'dashboard', icon: 'dashboard', label: t('nav.dashboard', 'Dashboard') },
                    { id: 'devices', icon: 'devices', label: t('nav.devices', 'Devices') },
                    { id: 'registrations', icon: 'how_to_reg', label: t('nav.registrations', 'Registrations') },
                ]
            },
            {
                heading: t('nav.management', 'Management'),
                items: [
                    { id: 'inventory', icon: 'inventory_2', label: t('nav.inventory', 'Inventory') },
                    { id: 'tickets', icon: 'confirmation_number', label: t('nav.tickets', 'Tickets') },
                    { id: 'help-requests', icon: 'support_agent', label: t('nav.help_requests', 'Help Requests') },
                    { id: 'automation', icon: 'smart_toy', label: t('nav.automation', 'Automation') },
                    { id: 'network', icon: 'lan', label: t('nav.network', 'Network') },
                    { id: 'activity', icon: 'timeline', label: t('nav.activity', 'Activity') },
                    { id: 'cdap', icon: 'developer_board', label: t('nav.cdap', 'CDAP') },
                    { id: 'fleet', icon: 'hub', label: t('nav.fleet', 'Fleet') },
                    { id: 'scaling', icon: 'cell_tower', label: t('nav.scaling', 'Scaling') },
                    { id: 'cross-platform', icon: 'devices', label: t('nav.cross_platform', 'Cross-Platform') },
                    { id: 'chat', icon: 'chat', label: t('nav.chat', 'Chat') },
                ]
            },
            {
                heading: t('nav.tools', 'Tools'),
                items: [
                    { id: 'reports', icon: 'assessment', label: t('nav.reports', 'Reports') },
                    { id: 'keys', icon: 'vpn_key', label: t('nav.keys', 'Keys') },
                    { id: 'generator', icon: 'build', label: t('nav.generator', 'Generator') },
                    { id: 'remote', icon: 'connected_tv', label: t('nav.remote', 'Remote Desktop') },
                    { id: 'toolkit', icon: 'handyman', label: t('nav.toolkit', 'Toolkit') },
                    { id: 'cdap-studio', icon: 'account_tree', label: t('nav.sdk_studio', 'SDK Studio') },
                ]
            },
            {
                heading: t('nav.system', 'System'),
                items: [
                    { id: 'tokens', icon: 'token', label: t('nav.tokens', 'Tokens') },
                    { id: 'organizations', icon: 'corporate_fare', label: t('nav.organizations', 'Organizations') },
                    { id: 'policies', icon: 'policy', label: t('nav.policies', 'Policies') },
                    { id: 'attestation', icon: 'fingerprint', label: t('nav.attestation', 'Attestation') },
                    { id: 'dataguard', icon: 'shield', label: t('nav.dataguard', 'DataGuard') },
                    { id: 'users', icon: 'group', label: t('nav.users', 'Users') },
                    { id: 'security-audit', icon: 'security', label: t('nav.security_audit', 'Security Audit') },
                    { id: 'permissions', icon: 'admin_panel_settings', label: t('nav.permissions', 'Permissions') },
                    { id: 'languages', icon: 'translate', label: t('nav.languages', 'Languages') },
                    { id: 'resource-control', icon: 'tune', label: t('nav.resource_control', 'Resource Control') },
                ]
            },
            {
                heading: t('nav.settings', 'Settings'),
                items: [
                    { id: 'settings', icon: 'settings', label: t('nav.settings', 'Settings') },
                ]
            }
        ];
    }

    /* ──────────────────────────────────────────────
       Build the shell DOM
       ────────────────────────────────────────────── */
    function buildShell() {
        if (document.getElementById('beta31-shell')) return;

        const appName = (window.BetterDesk && window.BetterDesk.branding && window.BetterDesk.branding.appName) || 'BetterDesk';
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

        shell = document.createElement('div');
        shell.id = 'beta31-shell';
        shell.className = 'beta31-shell' + (isDark ? ' b31-dark' : '');

        // Build topbar
        const topbar = document.createElement('div');
        topbar.className = 'b31-topbar';
        topbar.innerHTML = `
            <div class="b31-topbar-logo">
                <span class="material-icons">dns</span>
                <span>${escHtml(appName)}</span>
                <span class="b31-topbar-badge">BETA 3.1</span>
            </div>
            <div class="b31-topbar-spacer"></div>
            <div class="b31-topbar-actions">
                <button class="b31-topbar-btn" id="b31-refresh-btn" title="Refresh">
                    <span class="material-icons">refresh</span>
                </button>
                <button class="b31-topbar-btn" id="b31-theme-btn" title="Toggle theme">
                    <span class="material-icons">${isDark ? 'light_mode' : 'dark_mode'}</span>
                </button>
                <button class="b31-topbar-btn" id="b31-exit-btn" title="Exit Beta 3.1">
                    <span class="material-icons">close</span>
                </button>
            </div>
        `;

        // Build body (sidebar + content)
        const body = document.createElement('div');
        body.className = 'b31-body';

        // Sidebar
        const sidebar = document.createElement('nav');
        sidebar.className = 'b31-sidebar';
        sidebar.id = 'b31-sidebar';

        const sections = getMenuSections();
        sections.forEach(sec => {
            const div = document.createElement('div');
            div.className = 'b31-sidebar-section';
            div.innerHTML = `<div class="b31-sidebar-heading">${escHtml(sec.heading)}</div>`;
            sec.items.forEach(item => {
                const btn = document.createElement('button');
                btn.className = 'b31-sidebar-item';
                btn.dataset.panel = item.id;
                btn.innerHTML = `<span class="material-icons">${item.icon}</span><span>${escHtml(item.label)}</span>`;
                btn.addEventListener('click', () => navigateTo(item.id));
                div.appendChild(btn);
            });
            sidebar.appendChild(div);
        });

        // Content
        contentArea = document.createElement('div');
        contentArea.className = 'b31-content';
        contentArea.id = 'b31-content';

        body.appendChild(sidebar);
        body.appendChild(contentArea);

        shell.appendChild(topbar);
        shell.appendChild(body);
        document.body.appendChild(shell);

        // Event listeners
        document.getElementById('b31-exit-btn').addEventListener('click', deactivate);
        document.getElementById('b31-refresh-btn').addEventListener('click', () => {
            if (currentPanel) navigateTo(currentPanel);
        });
        document.getElementById('b31-theme-btn').addEventListener('click', toggleTheme);
    }

    /* ──────────────────────────────────────────────
       Navigation — load panel content via fetch
       ────────────────────────────────────────────── */
    function navigateTo(panelId) {
        if (!contentArea) return;
        currentPanel = panelId;
        localStorage.setItem(STORAGE_PANEL, panelId);

        // Update sidebar active state
        shell.querySelectorAll('.b31-sidebar-item').forEach(el => {
            el.classList.toggle('active', el.dataset.panel === panelId);
        });

        // Show loading
        contentArea.classList.remove('has-frame');
        contentArea.innerHTML = '<div class="b31-loading"><span class="material-icons">sync</span> Loading…</div>';

        renderEmbeddedPanel(panelId);
    }

    function getPanelUrl(panelId) {
        const route = PANEL_ROUTES[panelId] || '/' + panelId;
        const url = new URL(route, window.location.origin);
        url.searchParams.set('embed', '1');
        url.searchParams.set('beta31', '1');
        return url.pathname + url.search;
    }

    function renderEmbeddedPanel(panelId) {
        const frame = document.createElement('iframe');
        frame.className = 'b31-panel-frame';
        frame.title = panelId;
        frame.src = getPanelUrl(panelId);
        frame.loading = 'eager';
        frame.addEventListener('load', () => {
            frame.classList.add('loaded');
        });
        contentArea.classList.add('has-frame');
        contentArea.innerHTML = '';
        contentArea.appendChild(frame);
    }

    /* ──────────────────────────────────────────────
       Activate / Deactivate
       ────────────────────────────────────────────── */
    function activate() {
        buildShell();
        shell.classList.add('active');
        document.body.style.overflow = 'hidden';
        localStorage.setItem(STORAGE_KEY, '1');

        // Navigate to saved or default panel
        const saved = localStorage.getItem(STORAGE_PANEL) || 'dashboard';
        navigateTo(saved);
    }

    function deactivate() {
        if (shell) shell.classList.remove('active');
        document.body.style.overflow = '';
        localStorage.setItem(STORAGE_KEY, '0');
    }

    function toggleTheme() {
        if (!shell) return;
        shell.classList.toggle('b31-dark');
        const icon = document.querySelector('#b31-theme-btn .material-icons');
        if (icon) icon.textContent = shell.classList.contains('b31-dark') ? 'light_mode' : 'dark_mode';
    }

    /* ──────────────────────────────────────────────
       Helpers
       ────────────────────────────────────────────── */
    function escHtml(s) {
        const d = document.createElement('div');
        d.textContent = s || '';
        return d.innerHTML;
    }

    /* ──────────────────────────────────────────────
       Public API
       ────────────────────────────────────────────── */
    window.Beta31 = {
        activate: activate,
        deactivate: deactivate,
        navigateTo: navigateTo,
        isActive: () => shell && shell.classList.contains('active'),
        init: function () {
            // Beta 3.1 console retired — clear persisted state, do not auto-restore
            localStorage.removeItem(STORAGE_KEY);
            localStorage.removeItem(STORAGE_PANEL);
        }
    };

    // Auto-init on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => window.Beta31.init());
    } else {
        window.Beta31.init();
    }
})();
