/**
 * BetterDesk Console - Users Page
 * User management for admins
 */

(function() {
    'use strict';
    
    document.addEventListener('DOMContentLoaded', init);
    
    // State
    let users = [];
    let userGroups = [];
    let userGroupsLoaded = false;
    let editingUserId = null;
    // Cache: userId -> [{ id, org_id, name, org_name, role }]
    const userOrgsCache = new Map();
    
    // Elements
    let tableBody, emptyState, userGroupsManager;
    
    function init() {
        tableBody = document.getElementById('users-tbody');
        emptyState = document.getElementById('users-empty');
        userGroupsManager = document.getElementById('user-groups-manager-list');
        
        loadUserGroups();
        loadUsers();
        initEventListeners();
        focusUserGroupsFromHash();
        
        window.addEventListener('app:refresh', loadUsers);
    }

    function focusUserGroupsFromHash() {
        if (window.location.hash !== '#user-groups') return;
        window.requestAnimationFrame(() => {
            document.getElementById('user-groups')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            document.getElementById('add-user-group-btn')?.focus();
        });
    }
    
    function initEventListeners() {
        // Add user button
        document.getElementById('add-user-btn')?.addEventListener('click', showAddUserModal);
        document.getElementById('add-user-group-btn')?.addEventListener('click', () => showUserGroupModal());
    }
    
    /**
     * Load users from API
     */
    async function loadUsers() {
        try {
            const response = await Utils.api('/api/users');
            users = response.users || [];
            renderUsers();
            // Lazy-load organizations for each user (parallel, best-effort)
            loadUsersOrganizations();
        } catch (error) {
            console.error('Failed to load users:', error);
            if (error.status === 403) {
                Notifications.error(_('users.admin_only'));
            } else {
                Notifications.error(_('errors.load_users_failed'));
            }
        }
    }

    async function loadUserGroups() {
        try {
            const response = await Utils.api('/api/panel/user-groups');
            userGroups = response.groups || [];
            userGroupsLoaded = true;
            renderUserGroupsManager();
            if (users.length > 0) renderUsers();
        } catch (error) {
            userGroups = [];
            userGroupsLoaded = true;
            renderUserGroupsManager();
            console.error('Failed to load user groups:', error);
        }
    }

    async function ensureUserGroupsLoaded() {
        if (!userGroupsLoaded) await loadUserGroups();
    }

    function userGroupName(guid) {
        const group = userGroups.find(item => item.guid === guid);
        return group ? group.name : guid;
    }

    function renderUserGroupBadges(groupGuids) {
        if (!Array.isArray(groupGuids) || groupGuids.length === 0) return '';
        return `<div class="user-group-badges">${groupGuids.map(guid => `
            <span class="user-group-badge" title="${Utils.escapeHtml(userGroupName(guid))}">
                <span class="material-icons">group</span>
                ${Utils.escapeHtml(userGroupName(guid))}
            </span>`).join('')}</div>`;
    }

    function renderUserGroupCheckboxes(selectedGuids) {
        const selected = new Set(Array.isArray(selectedGuids) ? selectedGuids : []);
        const container = document.getElementById('user-groups-list');
        if (!container) return;
        if (!userGroups.length) {
            container.innerHTML = `<div class="empty-state-inline">${_('users.no_user_groups') || 'No user groups'}</div>`;
            return;
        }
        container.innerHTML = userGroups.map(group => `
            <label class="user-group-option">
                <input type="checkbox" value="${Utils.escapeHtml(group.guid)}" ${selected.has(group.guid) ? 'checked' : ''}>
                <span class="material-icons">group</span>
                <span>${Utils.escapeHtml(group.name || group.guid)}</span>
            </label>`).join('');
    }

    function selectedUserGroupGuids() {
        return Array.from(document.querySelectorAll('#user-groups-list input:checked')).map(input => input.value);
    }

    function renderUserGroupsManager() {
        if (!userGroupsManager) return;
        if (!userGroupsLoaded) {
            userGroupsManager.innerHTML = `<div class="empty-state-inline">${_('users.loading_user_groups') || 'Loading user groups...'}</div>`;
            return;
        }
        if (!userGroups.length) {
            userGroupsManager.innerHTML = `<div class="empty-state-inline">${_('users.no_user_groups') || 'No user groups available'}</div>`;
            return;
        }

        userGroupsManager.innerHTML = userGroups.map(group => `
            <div class="user-group-manager-item" data-guid="${Utils.escapeHtml(group.guid)}">
                <div class="user-group-manager-main">
                    <span class="material-icons">groups</span>
                    <div class="user-group-manager-text">
                        <strong>${Utils.escapeHtml(group.name || group.guid)}</strong>
                        ${group.note ? `<span>${Utils.escapeHtml(group.note)}</span>` : ''}
                    </div>
                </div>
                <span class="user-group-member-count">${_('users.group_members_count', { count: group.member_count || 0 }) || (group.member_count || 0)}</span>
                <div class="user-group-manager-actions">
                    <button class="action-btn" data-action="edit-user-group" data-guid="${Utils.escapeHtml(group.guid)}" title="${_('users.edit_user_group') || 'Edit user group'}">
                        <span class="material-icons">edit</span>
                    </button>
                    <button class="action-btn danger" data-action="delete-user-group" data-guid="${Utils.escapeHtml(group.guid)}" title="${_('users.delete_user_group') || 'Delete user group'}">
                        <span class="material-icons">delete</span>
                    </button>
                </div>
            </div>
        `).join('');

        userGroupsManager.querySelectorAll('[data-action="edit-user-group"]').forEach(btn => {
            btn.addEventListener('click', () => {
                const group = userGroups.find(item => item.guid === btn.dataset.guid);
                if (group) showUserGroupModal(group);
            });
        });
        userGroupsManager.querySelectorAll('[data-action="delete-user-group"]').forEach(btn => {
            btn.addEventListener('click', () => {
                const group = userGroups.find(item => item.guid === btn.dataset.guid);
                if (group) deleteUserGroup(group);
            });
        });
    }

    function showUserGroupModal(group = null) {
        const editing = !!group;
        Modal.show({
            title: editing ? (_('users.edit_user_group') || 'Edit user group') : (_('users.create_user_group') || 'Create user group'),
            content: `
                <form id="user-group-form" class="user-form">
                    <div class="form-group">
                        <label for="user-group-name">${_('users.group_name') || 'Group name'}</label>
                        <input type="text" id="user-group-name" class="form-input" maxlength="80" required value="${Utils.escapeHtml(group?.name || '')}" placeholder="${_('users.group_name_placeholder') || 'Operators'}">
                    </div>
                    <div class="form-group">
                        <label for="user-group-note">${_('users.group_note') || 'Note'}</label>
                        <textarea id="user-group-note" class="form-input" maxlength="500" rows="3" placeholder="${_('users.group_note_placeholder') || 'Optional note'}">${Utils.escapeHtml(group?.note || '')}</textarea>
                    </div>
                </form>
            `,
            size: 'medium',
            buttons: [
                { label: _('actions.cancel'), class: 'btn-secondary', onClick: () => Modal.close() },
                { label: _('actions.save'), class: 'btn-primary', onClick: () => saveUserGroup(group) }
            ],
            onOpen: () => document.getElementById('user-group-name')?.focus()
        });
    }

    async function saveUserGroup(group = null) {
        const name = document.getElementById('user-group-name')?.value.trim() || '';
        const note = document.getElementById('user-group-note')?.value.trim() || '';
        if (!name) {
            Notifications.error(_('users.group_name_required') || 'Group name is required');
            return;
        }

        try {
            const url = group ? `/api/panel/user-groups/${encodeURIComponent(group.guid)}` : '/api/panel/user-groups';
            await Utils.api(url, {
                method: group ? 'PATCH' : 'POST',
                body: { name, note }
            });
            Notifications.success(group ? (_('users.user_group_updated') || 'User group updated') : (_('users.user_group_created') || 'User group created'));
            Modal.close();
            userGroupsLoaded = false;
            await loadUserGroups();
            await loadUsers();
        } catch (error) {
            Notifications.error(error.message || _('errors.server_error'));
        }
    }

    async function deleteUserGroup(group) {
        const confirmed = await Modal.confirm({
            title: _('users.delete_user_group') || 'Delete user group',
            message: (_('users.delete_user_group_confirm') || 'Delete user group {name}?').replace('{name}', group.name || group.guid),
            confirmLabel: _('actions.delete'),
            danger: true
        });
        if (!confirmed) return;

        try {
            await Utils.api(`/api/panel/user-groups/${encodeURIComponent(group.guid)}`, { method: 'DELETE' });
            Notifications.success(_('users.user_group_deleted') || 'User group deleted');
            userGroupsLoaded = false;
            await loadUserGroups();
            await loadUsers();
        } catch (error) {
            Notifications.error(error.message || _('errors.server_error'));
        }
    }

    /**
     * Lazy-load each user's organization memberships and update the table cells.
     * Errors per user are silently ignored so the table still renders.
     */
    async function loadUsersOrganizations() {
        if (!Array.isArray(users) || users.length === 0) return;
        await Promise.all(users.map(async (user) => {
            try {
                const resp = await Utils.api(`/api/users/${user.id}/organizations`);
                const orgs = (resp.organizations || []).map(normalizeOrgPayload).filter(o => o.id);
                userOrgsCache.set(Number(user.id), orgs);
                renderUserOrgsCell(user.id, orgs);
            } catch (_err) {
                renderUserOrgsCell(user.id, []);
            }
        }));
    }

    function normalizeOrgPayload(org) {
        const id = String(org.org_id || org.id || org.organization_id || '');
        return {
            ...org,
            id,
            org_id: id,
            name: org.name || org.org_name || (id ? 'Org #' + id : ''),
            org_name: org.org_name || org.name || (id ? 'Org #' + id : ''),
            role: org.role || ''
        };
    }

    function renderUserOrgsCell(userId, orgs) {
        const cell = document.querySelector(`tr[data-id="${userId}"] .user-orgs-cell`);
        if (!cell) return;
        if (!orgs || orgs.length === 0) {
            cell.innerHTML = `<span class="no-orgs">${_('users.no_orgs_short')}</span>`;
            return;
        }
        cell.innerHTML = orgs.map(o => `
            <span class="org-badge" data-org-id="${Utils.escapeHtml(o.id)}" title="${Utils.escapeHtml(o.org_name)}${o.role ? ' • ' + _('organizations.role_' + o.role) : ''}">
                <span class="material-icons">business</span>
                ${Utils.escapeHtml(o.org_name)}
            </span>
        `).join('');
    }

    /**
     * Re-fetch a single user's org memberships and refresh the inline cell.
     * Safe to call after add/remove from the Organizations modal.
     */
    async function refreshUserOrgsCell(userId) {
        try {
            const resp = await Utils.api(`/api/users/${userId}/organizations`);
            const orgs = (resp.organizations || []).map(normalizeOrgPayload).filter(o => o.id);
            userOrgsCache.set(Number(userId), orgs);
            renderUserOrgsCell(userId, orgs);
        } catch (_err) {
            // Leave cell as-is on failure
        }
    }
    
    /**
     * Render users table
     */
    function renderUsers() {
        if (!tableBody) return;
        
        if (users.length === 0) {
            tableBody.innerHTML = '';
            emptyState?.classList.remove('hidden');
            return;
        }
        
        emptyState?.classList.add('hidden');
        
        tableBody.innerHTML = users.map(user => {
            const roleIcons = {
                super_admin: 'shield_person',
                admin: 'admin_panel_settings',
                server_admin: 'dns',
                global_admin: 'public',
                operator: 'engineering',
                viewer: 'visibility',
                pro: 'star'
            };
            const roleIcon = roleIcons[user.role] || 'person';
            const roleLabelKey = 'users.role_' + user.role;
            const provider = (user.auth_provider || 'local').toLowerCase();
            const providerLabel = _('users.provider_' + provider) || provider;
            const isLocal = provider === 'local';
            return `
            <tr data-id="${user.id}">
                <td>
                    <div class="user-info">
                        <div class="user-avatar">
                            <span class="material-icons">${roleIcon}</span>
                        </div>
                        <div class="user-name-stack">
                            <span class="user-username">${Utils.escapeHtml(user.username)}</span>
                            ${renderUserGroupBadges(user.user_groups)}
                        </div>
                    </div>
                </td>
                <td>
                    <span class="role-badge ${String(user.role || '').replace(/[^a-z0-9_-]/gi, '')}">
                        ${Utils.escapeHtml(_(roleLabelKey))}
                    </span>
                </td>
                <td>
                    <span class="provider-badge provider-${provider}" title="${Utils.escapeHtml(providerLabel)}">
                        ${Utils.escapeHtml(providerLabel)}
                    </span>
                </td>
                <td>
                    <div class="user-orgs-cell" data-user-id="${user.id}" data-username="${Utils.escapeHtml(user.username)}">
                        <span class="skeleton skeleton-text" style="width: 80px; height: 14px;"></span>
                    </div>
                </td>
                <td>${Utils.formatDate(user.created_at)}</td>
                <td>${user.last_login ? Utils.formatDate(user.last_login) : '<span class="text-muted">' + _('users.never') + '</span>'}</td>
                <td>
                    <div class="user-actions">
                        <button class="action-btn" title="${_('users.organizations')}" data-action="organizations" data-id="${user.id}" data-username="${Utils.escapeHtml(user.username)}">
                            <span class="material-icons">business</span>
                        </button>
                        ${isLocal ? `<button class="action-btn" title="${_('users.reset_password')}" data-action="reset-password" data-id="${user.id}">
                            <span class="material-icons">lock_reset</span>
                        </button>` : ''}
                        <button class="action-btn" title="${_('users.edit')}" data-action="edit" data-id="${user.id}">
                            <span class="material-icons">edit</span>
                        </button>
                        <button class="action-btn danger" title="${_('actions.delete')}" data-action="delete" data-id="${user.id}" data-username="${Utils.escapeHtml(user.username)}">
                            <span class="material-icons">delete</span>
                        </button>
                    </div>
                </td>
            </tr>
        `}).join('');        
        
        // Attach event listeners
        tableBody.querySelectorAll('.action-btn').forEach(btn => {
            btn.addEventListener('click', () => handleAction(btn.dataset.action, btn.dataset.id, btn.dataset));
        });
        // Clicking the inline orgs cell opens the same Organizations modal as the action button
        tableBody.querySelectorAll('.user-orgs-cell').forEach(cell => {
            cell.addEventListener('click', () => {
                const id = cell.dataset.userId;
                const username = cell.dataset.username;
                if (id && username) showOrganizationsModal(id, username);
            });
        });
    }
    
    /**
     * Handle actions
     */
    async function handleAction(action, userId, data) {
        switch (action) {
            case 'edit':
                showEditUserModal(userId);
                break;
            case 'reset-password':
                await resetPassword(userId);
                break;
            case 'delete':
                await deleteUser(userId, data.username);
                break;
            case 'organizations':
                await showOrganizationsModal(userId, data.username);
                break;
        }
    }
    
    /**
     * Show add user modal
     */
    async function showAddUserModal() {
        await ensureUserGroupsLoaded();
        editingUserId = null;
        
        const template = document.getElementById('user-form-template');
        const content = template.content.cloneNode(true);
        const formHtml = content.querySelector('form').outerHTML;
        
        Modal.show({
            title: _('users.add_user'),
            content: formHtml,
            size: 'medium',
            buttons: [
                { label: _('actions.cancel'), class: 'btn-secondary', onClick: () => Modal.close() },
                { label: _('users.create'), class: 'btn-primary', onClick: () => submitUserForm() }
            ],
            onOpen: () => {
                initFormListeners();
                renderUserGroupCheckboxes([]);
                document.getElementById('user-username')?.focus();
            }
        });
    }
    
    /**
     * Show edit user modal
     */
    async function showEditUserModal(userId) {
        await ensureUserGroupsLoaded();
        const user = users.find(u => Number(u.id) === Number(userId));
        if (!user) return;
        
        editingUserId = user.id;
        
        const template = document.getElementById('user-form-template');
        const content = template.content.cloneNode(true);
        const formHtml = content.querySelector('form').outerHTML;
        
        Modal.show({
            title: _('users.edit_user'),
            content: formHtml,
            size: 'medium',
            buttons: [
                { label: _('actions.cancel'), class: 'btn-secondary', onClick: () => Modal.close() },
                { label: _('actions.save'), class: 'btn-primary', onClick: () => submitUserForm() }
            ],
            onOpen: () => {
                initFormListeners();
                
                // Fill form with user data
                const usernameInput = document.getElementById('user-username');
                const roleSelect = document.getElementById('user-role');
                const passwordInput = document.getElementById('user-password');
                
                if (usernameInput) {
                    usernameInput.value = user.username;
                    usernameInput.readOnly = true;
                    usernameInput.classList.add('readonly');
                }
                if (roleSelect) roleSelect.value = user.role;
                if (passwordInput) passwordInput.placeholder = _('users.password_leave_empty');
                // LDAP/OIDC accounts are managed by the identity provider:
                // password cannot be set locally and the role is provider-mapped.
                const provider = (user.auth_provider || 'local').toLowerCase();
                if (provider !== 'local') {
                    if (passwordInput) {
                        passwordInput.value = '';
                        passwordInput.disabled = true;
                        passwordInput.placeholder = _('users.password_managed_by_provider');
                    }
                    const passwordGroup = passwordInput ? passwordInput.closest('.form-group') : null;
                    if (passwordGroup) {
                        const hint = document.createElement('span');
                        hint.className = 'form-hint';
                        hint.textContent = _('users.provider_managed_hint');
                        passwordGroup.appendChild(hint);
                    }
                }
                renderUserGroupCheckboxes(user.user_groups || []);
            }
        });
    }
    
    /**
     * Initialize form listeners
     */
    function initFormListeners() {
        // Password visibility toggle
        document.querySelector('.toggle-password')?.addEventListener('click', function() {
            const input = document.getElementById('user-password');
            const icon = this.querySelector('.material-icons');
            if (input.type === 'password') {
                input.type = 'text';
                icon.textContent = 'visibility_off';
            } else {
                input.type = 'password';
                icon.textContent = 'visibility';
            }
        });
        
        // Password strength indicator
        document.getElementById('user-password')?.addEventListener('input', function() {
            updatePasswordStrength(this.value);
        });
    }
    
    /**
     * Update password strength indicator
     */
    function updatePasswordStrength(password) {
        const container = document.getElementById('password-strength');
        if (!container) return;
        
        if (!password) {
            container.innerHTML = '';
            return;
        }
        
        let score = 0;
        const feedback = [];
        
        if (password.length >= 8) score++;
        else feedback.push(_('settings.req_length'));
        
        if (password.length >= 12) score++;
        
        if (/[a-z]/.test(password)) score++;
        else feedback.push(_('settings.req_lowercase'));
        
        if (/[A-Z]/.test(password)) score++;
        else feedback.push(_('settings.req_uppercase'));
        
        if (/[0-9]/.test(password)) score++;
        else feedback.push(_('settings.req_number'));
        
        if (/[^a-zA-Z0-9]/.test(password)) score++;
        
        const strength = score <= 2 ? 'weak' : score <= 4 ? 'medium' : 'strong';
        const labels = { weak: _('users.strength_weak'), medium: _('users.strength_medium'), strong: _('users.strength_strong') };
        
        container.innerHTML = `
            <div class="strength-bar">
                <div class="strength-fill ${strength}" style="width: ${(score / 6) * 100}%"></div>
            </div>
            <span class="strength-label ${strength}">${labels[strength]}</span>
        `;
    }
    
    /**
     * Submit user form
     */
    async function submitUserForm() {
        const form = document.getElementById('user-form');
        if (!form) return;
        
        const username = document.getElementById('user-username')?.value.trim();
        const password = document.getElementById('user-password')?.value;
        const role = document.getElementById('user-role')?.value;
        const groupGuids = selectedUserGroupGuids();
        
        // Validate
        if (!editingUserId) {
            // Creating new user
            if (!username || !password) {
                Notifications.error(_('users.fill_required'));
                return;
            }
            
            if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
                Notifications.error(_('users.invalid_username'));
                return;
            }
            
            if (password.length < 8) {
                Notifications.error(_('users.password_too_short'));
                return;
            }
        }
        
        try {
            if (editingUserId) {
                // Update existing user
                const data = { role };
                if (password) data.password = password;
                data.groupGuids = groupGuids;
                
                await Utils.api(`/api/users/${editingUserId}`, {
                    method: 'PATCH',
                    body: data
                });
                Notifications.success(_('users.user_updated'));
            } else {
                // Create new user
                await Utils.api('/api/users', {
                    method: 'POST',
                    body: { username, password, role, groupGuids }
                });
                Notifications.success(_('users.user_created'));
            }
            
            Modal.close();
            loadUsers();
        } catch (error) {
            Notifications.error(error.message || _('errors.server_error'));
        }
    }
    
    /**
     * Reset user password
     */
    async function resetPassword(userId) {
        const user = users.find(u => Number(u.id) === Number(userId));
        if (!user) return;
        
        const newPassword = await Modal.prompt({
            title: _('users.reset_password'),
            label: _('users.new_password'),
            hint: _('users.password_hint'),
            inputType: 'password'
        });
        
        if (!newPassword) return;
        
        if (newPassword.length < 8) {
            Notifications.error(_('users.password_too_short'));
            return;
        }
        
        try {
            await Utils.api(`/api/users/${userId}/reset-password`, {
                method: 'POST',
                body: { newPassword }
            });
            Notifications.success(_('users.password_reset_success'));
        } catch (error) {
            Notifications.error(error.message || _('errors.server_error'));
        }
    }
    
    /**
     * Delete user
     */
    async function deleteUser(userId, username) {
        const confirmed = await Modal.confirm({
            title: _('users.delete_title'),
            message: _('users.delete_confirm', { username }),
            confirmLabel: _('actions.delete'),
            danger: true
        });
        
        if (!confirmed) return;
        
        try {
            await Utils.api(`/api/users/${userId}`, { method: 'DELETE' });
            Notifications.success(_('users.delete_success'));
            loadUsers();
        } catch (error) {
            Notifications.error(error.message || _('errors.server_error'));
        }
    }
    
    /**
     * Show organizations modal for user
     */
    async function showOrganizationsModal(userId, username) {
        let userOrgs = [];
        let allOrgs = [];

        const normalizeOrg = (org) => {
            const id = String(org.org_id || org.id || org.organization_id || '');
            return {
                ...org,
                id,
                org_id: id,
                name: org.name || org.org_name || (id ? 'Org #' + id : ''),
                org_name: org.org_name || org.name || (id ? 'Org #' + id : ''),
                role: org.role || ''
            };
        };
        
        try {
            // Fetch user's organizations
            const orgsResponse = await Utils.api(`/api/users/${userId}/organizations`);
            userOrgs = (orgsResponse.organizations || []).map(normalizeOrg).filter(o => o.id);
            
            // Fetch all organizations for adding
            const allOrgsResponse = await Utils.api('/api/panel/org');
            allOrgs = (allOrgsResponse.organizations || []).map(normalizeOrg).filter(o => o.id);
        } catch (error) {
            console.error('Failed to load organizations:', error);
            Notifications.error(_('errors.load_orgs_failed'));
            return;
        }
        
        // Filter out orgs user is already in
        const userOrgIds = new Set(userOrgs.map(o => o.id));
        const availableOrgs = allOrgs.filter(o => !userOrgIds.has(String(o.id)));
        
        const orgsListHtml = userOrgs.length > 0 
            ? userOrgs.map(org => `
                <div class="org-assignment-item" data-org-id="${Utils.escapeHtml(org.id)}">
                    <div class="org-info">
                        <span class="material-icons">business</span>
                        <span class="org-name">${Utils.escapeHtml(org.org_name)}</span>
                        ${org.role ? `<span class="role-badge ${Utils.escapeHtml(org.role)}">${_('organizations.role_' + org.role)}</span>` : ''}
                    </div>
                    <button class="action-btn danger remove-org-btn" data-org-id="${Utils.escapeHtml(org.id)}" title="${_('actions.remove')}">
                        <span class="material-icons">remove_circle</span>
                    </button>
                </div>
            `).join('')
            : `<div class="empty-state-inline">${_('users.no_organizations')}</div>`;
        
        const addOrgHtml = availableOrgs.length > 0 
            ? `
                <div class="add-org-row">
                    <select id="add-org-select" class="form-input">
                        <option value="">${_('policies.select_org_placeholder')}</option>
                        ${availableOrgs.map(o => `<option value="${Utils.escapeHtml(String(o.id))}">${Utils.escapeHtml(o.name)}</option>`).join('')}
                    </select>
                    <select id="add-org-role" class="form-input" style="width: 140px;" title="${_('organizations.org_role')}" aria-label="${_('organizations.org_role')}">
                        <option value="user">${_('organizations.role_user')}</option>
                        <option value="operator">${_('organizations.role_operator')}</option>
                        <option value="admin">${_('organizations.role_admin')}</option>
                        <option value="owner">${_('organizations.role_owner')}</option>
                    </select>
                    <button id="add-org-btn" class="btn btn-primary btn-sm">
                        <span class="material-icons">add</span>
                        ${_('actions.add')}
                    </button>
                </div>
            `
            : `<div class="empty-state-inline">${_('users.all_orgs_assigned')}</div>`;
        
        Modal.show({
            title: _('users.user_organizations', { username }),
            content: `
                <div class="org-assignments">
                    <h4 class="org-assignments-section">${_('users.org_membership_section')}</h4>
                    <p class="org-assignments-hint">${_('users.org_membership_hint')}</p>
                    <div class="org-assignments-list" id="user-orgs-list">
                        ${orgsListHtml}
                    </div>
                    ${addOrgHtml}
                </div>
            `,
            size: 'medium',
            buttons: [
                { label: _('actions.close'), class: 'btn-secondary', onClick: () => Modal.close() }
            ],
            onOpen: () => {
                // Remove org handler
                document.querySelectorAll('.remove-org-btn').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        const orgId = btn.dataset.orgId;
                        try {
                            await Utils.api(`/api/panel/org/${orgId}/members/${userId}`, { method: 'DELETE' });
                            Notifications.success(_('users.org_removed'));
                            userOrgsCache.delete(Number(userId));
                            Modal.close();
                            refreshUserOrgsCell(userId);
                            showOrganizationsModal(userId, username); // Refresh
                        } catch (error) {
                            Notifications.error(error.message || _('errors.server_error'));
                        }
                    });
                });
                
                // Add org handler
                document.getElementById('add-org-btn')?.addEventListener('click', async () => {
                    const orgId = document.getElementById('add-org-select').value;
                    const role = document.getElementById('add-org-role').value;
                    
                    if (!orgId) {
                        Notifications.error(_('policies.select_org_placeholder'));
                        return;
                    }
                    
                    try {
                        await Utils.api(`/api/users/${userId}/organizations`, {
                            method: 'POST',
                            body: { org_id: orgId, role }
                        });
                        Notifications.success(_('organizations.user_linked'));
                        userOrgsCache.delete(Number(userId));
                        Modal.close();
                        refreshUserOrgsCell(userId);
                        showOrganizationsModal(userId, username); // Refresh
                    } catch (error) {
                        Notifications.error(error.message || _('errors.server_error'));
                    }
                });
            }
        });
    }
})();
