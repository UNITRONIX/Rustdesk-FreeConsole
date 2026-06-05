/**
 * BetterDesk Console — Permissions Management (RBAC Phase 52)
 * Renders a permission matrix for each role with toggle switches.
 * Custom overrides are persisted in the Go server's role_permissions table.
 */
(function () {
    'use strict';

    const _ = (window.BetterDesk && window.BetterDesk.translations)
        ? (key) => {
            const keys = key.split('.');
            let val = window.BetterDesk.translations;
            for (const k of keys) {
                if (val && typeof val === 'object') val = val[k];
                else return key;
            }
            return (typeof val === 'string') ? val : key;
        }
        : (key) => key;

    const csrfToken = (window.BetterDesk && window.BetterDesk.csrfToken) || '';

    // ── Permission categories ──────────────────────────────────────────

    const CATEGORIES = [
        {
            id: 'device',
            icon: 'devices',
            permissions: [
                'device.view', 'device.connect', 'device.edit',
                'device.delete', 'device.ban', 'device.change_id'
            ]
        },
        {
            id: 'user',
            icon: 'group',
            permissions: ['user.view', 'user.create', 'user.edit', 'user.delete']
        },
        {
            id: 'server',
            icon: 'dns',
            permissions: ['server.config', 'server.keys', 'server.attestation']
        },
        {
            id: 'org',
            icon: 'corporate_fare',
            permissions: [
                'org.create', 'org.edit', 'org.delete',
                'org.manage_users', 'org.manage_devices'
            ]
        },
        {
            id: 'audit',
            icon: 'policy',
            permissions: ['audit.view', 'metrics.view', 'blocklist.edit']
        },
        {
            id: 'cdap',
            icon: 'hub',
            permissions: ['cdap.view', 'cdap.command', 'cdap.terminal', 'cdap.files']
        },
        {
            id: 'enrollment',
            icon: 'how_to_reg',
            permissions: ['enrollment.manage', 'enrollment.approve']
        },
        {
            id: 'chat',
            icon: 'chat',
            permissions: ['chat.access']
        },
        {
            id: 'branding',
            icon: 'palette',
            permissions: ['branding.edit']
        }
    ];

    // ── State ──────────────────────────────────────────────────────────

    let allRoles = [];            // [{name, level, is_super_admin, permissions}]
    let allPermissions = [];      // ['device.view', ...]
    let overrides = [];           // [{role, permission, granted}]
    let selectedRole = '';
    let roleDefaults = {};        // role -> [default perms]
    let effectivePerms = {};      // permission -> granted bool (for current role)

    // ── Helpers ────────────────────────────────────────────────────────

    async function apiFetch(url, opts = {}) {
        const headers = { ...(opts.headers || {}), 'x-csrf-token': csrfToken };
        if (opts.body && typeof opts.body === 'string') {
            headers['Content-Type'] = 'application/json';
        }
        const resp = await fetch(url, { ...opts, headers, credentials: 'same-origin' });
        return resp.json();
    }

    function unwrap(data) {
        return (data && data.success && data.data) ? data.data : data;
    }

    const ROLE_ICONS = {
        super_admin: 'shield_person',
        admin: 'admin_panel_settings',
        server_admin: 'dns',
        global_admin: 'public',
        operator: 'engineering',
        viewer: 'visibility',
        pro: 'star'
    };

    function roleLabel(name) {
        const key = 'users.role_' + name;
        const t = _(key);
        return t !== key ? t : name;
    }

    function permLabel(perm) {
        const key = 'permissions.perm_' + perm.replace(/\./g, '_');
        const t = _(key);
        return t !== key ? t : perm;
    }

    function catLabel(catId) {
        const key = 'permissions.cat_' + catId;
        const t = _(key);
        return t !== key ? t : catId.charAt(0).toUpperCase() + catId.slice(1);
    }

    // ── Data Loading ───────────────────────────────────────────────────

    async function loadRoles() {
        const resp = unwrap(await apiFetch('/api/panel/roles'));
        allRoles = resp.roles || [];
        allPermissions = resp.all_permissions || [];

        // Build default map per role
        roleDefaults = {};
        for (const role of allRoles) {
            roleDefaults[role.name] = role.permissions || [];
        }

        populateRoleSelect();
    }

    async function loadOverrides() {
        const resp = unwrap(await apiFetch('/api/panel/role-permissions'));
        overrides = resp.overrides || [];
    }

    async function loadEffectivePerms(role) {
        const resp = unwrap(await apiFetch('/api/panel/roles/' + encodeURIComponent(role) + '/permissions'));
        const perms = resp.permissions || [];
        effectivePerms = {};
        for (const p of perms) effectivePerms[p] = true;
    }

    // ── Rendering ──────────────────────────────────────────────────────

    function populateRoleSelect() {
        const sel = document.getElementById('role-select');
        if (!sel) return;

        // Keep the placeholder
        sel.innerHTML = '<option value="" disabled selected>' + _('permissions.select_role_placeholder') + '</option>';
        for (const role of allRoles) {
            const opt = document.createElement('option');
            opt.value = role.name;
            opt.textContent = roleLabel(role.name);
            sel.appendChild(opt);
        }

        if (selectedRole) sel.value = selectedRole;
    }

    function renderRoleInfo(role) {
        const banner = document.getElementById('role-info-banner');
        const nameEl = document.getElementById('role-info-name');
        const levelEl = document.getElementById('role-info-level');
        const iconEl = document.getElementById('role-info-icon');
        const permCount = document.getElementById('role-perm-count');
        const overrideCount = document.getElementById('role-override-count');
        if (!banner) return;

        nameEl.textContent = roleLabel(role.name);
        levelEl.textContent = _('permissions.level') + ' ' + role.level +
            (role.is_super_admin ? ' — ' + _('permissions.super_admin_tag') : '') +
            (role.is_server_level ? ' — ' + _('permissions.server_level_tag') : '');
        iconEl.textContent = ROLE_ICONS[role.name] || 'shield';

        const grantedCount = Object.keys(effectivePerms).length;
        permCount.textContent = grantedCount + '/' + allPermissions.length;

        const roleOverrides = overrides.filter(o => o.role === role.name);
        overrideCount.textContent = roleOverrides.length;

        banner.classList.remove('hidden');
    }

    function renderMatrix(role) {
        const container = document.getElementById('permissions-matrix');
        const emptyEl = document.getElementById('permissions-empty');
        const lockedEl = document.getElementById('permissions-locked');
        if (!container) return;

        // Super admin — locked notice
        if (role.is_super_admin) {
            container.classList.add('hidden');
            emptyEl.classList.add('hidden');
            lockedEl.classList.remove('hidden');
            document.getElementById('btn-reset-overrides').disabled = true;
            return;
        }

        lockedEl.classList.add('hidden');
        emptyEl.classList.add('hidden');
        container.classList.remove('hidden');

        const roleOverrides = overrides.filter(o => o.role === role.name);
        const overrideMap = {};
        for (const o of roleOverrides) overrideMap[o.permission] = o.granted;

        const defaults = roleDefaults[role.name] || [];
        const defaultSet = {};
        for (const p of defaults) defaultSet[p] = true;

        let html = '';
        for (const cat of CATEGORIES) {
            html += `<div class="perm-category">
                <div class="perm-category-header">
                    <span class="material-icons">${cat.icon}</span>
                    <h3>${catLabel(cat.id)}</h3>
                </div>
                <div class="perm-category-body">`;

            for (const perm of cat.permissions) {
                const granted = !!effectivePerms[perm];
                const isDefault = !!defaultSet[perm];
                const isOverride = perm in overrideMap;
                const overrideClass = isOverride ? ' perm-override' : '';
                const grantedClass = granted ? ' perm-granted' : ' perm-denied';

                html += `<div class="perm-row${overrideClass}${grantedClass}">
                    <div class="perm-info">
                        <span class="perm-name">${permLabel(perm)}</span>
                        <span class="perm-key">${perm}</span>
                        ${isOverride ? '<span class="perm-badge override">' + _('permissions.custom') + '</span>' : ''}
                        ${!isOverride && isDefault ? '<span class="perm-badge default">' + _('permissions.default') + '</span>' : ''}
                    </div>
                    <div class="perm-actions">
                        ${isOverride ? '<button class="btn-icon-sm btn-revert" data-perm="' + perm + '" title="' + _('permissions.revert') + '"><span class="material-icons">undo</span></button>' : ''}
                        <label class="toggle-label">
                            <input type="checkbox" class="toggle-switch" data-perm="${perm}" ${granted ? 'checked' : ''}>
                        </label>
                    </div>
                </div>`;
            }
            html += '</div></div>';
        }

        container.innerHTML = html;
        document.getElementById('btn-reset-overrides').disabled = roleOverrides.length === 0;
    }

    // ── Event Handlers ─────────────────────────────────────────────────

    async function onRoleChange(e) {
        selectedRole = e.target.value;
        if (!selectedRole) return;

        const role = allRoles.find(r => r.name === selectedRole);
        if (!role) return;

        await Promise.all([loadEffectivePerms(selectedRole), loadOverrides()]);
        renderRoleInfo(role);
        renderMatrix(role);
    }

    async function onToggle(e) {
        const toggle = e.target;
        if (!toggle.classList.contains('toggle-switch')) return;
        if (!selectedRole) return;

        const perm = toggle.dataset.perm;
        const granted = toggle.checked;

        toggle.disabled = true;
        try {
            const resp = await apiFetch('/api/panel/role-permissions', {
                method: 'POST',
                body: JSON.stringify({ role: selectedRole, permission: perm, granted })
            });
            const data = unwrap(resp);
            if (data.error) {
                toggle.checked = !granted; // revert
                showToast(data.error, 'error');
                return;
            }
            showToast(_('permissions.saved'), 'success');
            // Refresh data
            await Promise.all([loadEffectivePerms(selectedRole), loadOverrides()]);
            const role = allRoles.find(r => r.name === selectedRole);
            if (role) {
                renderRoleInfo(role);
                renderMatrix(role);
            }
        } catch (err) {
            toggle.checked = !granted;
            showToast(_('common.error'), 'error');
        } finally {
            toggle.disabled = false;
        }
    }

    async function onRevert(e) {
        const btn = e.target.closest('.btn-revert');
        if (!btn) return;
        if (!selectedRole) return;

        const perm = btn.dataset.perm;
        btn.disabled = true;
        try {
            const resp = await apiFetch('/api/panel/role-permissions/' + encodeURIComponent(selectedRole) + '/' + encodeURIComponent(perm), {
                method: 'DELETE'
            });
            const data = unwrap(resp);
            if (data.error) {
                showToast(data.error, 'error');
                return;
            }
            showToast(_('permissions.reverted'), 'success');
            await Promise.all([loadEffectivePerms(selectedRole), loadOverrides()]);
            const role = allRoles.find(r => r.name === selectedRole);
            if (role) {
                renderRoleInfo(role);
                renderMatrix(role);
            }
        } catch (err) {
            showToast(_('common.error'), 'error');
        } finally {
            btn.disabled = false;
        }
    }

    async function onResetAllOverrides() {
        if (!selectedRole) return;
        const roleOverrides = overrides.filter(o => o.role === selectedRole);
        if (roleOverrides.length === 0) return;

        if (!confirm(_('permissions.confirm_reset'))) return;

        try {
            for (const o of roleOverrides) {
                await apiFetch('/api/panel/role-permissions/' + encodeURIComponent(selectedRole) + '/' + encodeURIComponent(o.permission), {
                    method: 'DELETE'
                });
            }
            showToast(_('permissions.all_reverted'), 'success');
            await Promise.all([loadEffectivePerms(selectedRole), loadOverrides()]);
            const role = allRoles.find(r => r.name === selectedRole);
            if (role) {
                renderRoleInfo(role);
                renderMatrix(role);
            }
        } catch (err) {
            showToast(_('common.error'), 'error');
        }
    }

    function showToast(message, type) {
        if (window.Toast && typeof window.Toast[type] === 'function') {
            window.Toast[type]('', message);
        }
    }

    // ── Init ───────────────────────────────────────────────────────────

    async function init() {
        try {
            await Promise.all([loadRoles(), loadOverrides()]);
        } catch (err) {
            console.error('Failed to load permissions data:', err);
        }

        // Event listeners
        const roleSelect = document.getElementById('role-select');
        if (roleSelect) roleSelect.addEventListener('change', onRoleChange);

        const matrix = document.getElementById('permissions-matrix');
        if (matrix) {
            matrix.addEventListener('change', onToggle);
            matrix.addEventListener('click', onRevert);
        }

        const resetBtn = document.getElementById('btn-reset-overrides');
        if (resetBtn) resetBtn.addEventListener('click', onResetAllOverrides);
    }

    document.addEventListener('DOMContentLoaded', init);
})();
