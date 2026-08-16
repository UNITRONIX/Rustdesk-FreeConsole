/**
 * BetterDesk Console — Organization Detail Page JavaScript
 *
 * Handles org detail view with tabs: Users, Devices, Invitations, Settings,
 * Address Book, and Device Groups.
 * Uses Modal.show() for form inputs, i18n for all strings.
 */
'use strict';

(function () {
    const orgId = document.querySelector('.org-detail-page')?.dataset.orgId;
    if (!orgId) return;

    const API = `/api/panel/org/${orgId}`;

    // i18n helper — falls back to key
    function t(key) {
        return (typeof _ === 'function') ? _(`organizations.${key}`) || key : key;
    }

    // -----------------------------------------------------------------------
    //  Helpers
    // -----------------------------------------------------------------------
    async function api(method, path, body) {
        const csrfToken = window.BetterDesk?.csrfToken || '';
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json' },
        };
        if (csrfToken) opts.headers['x-csrf-token'] = csrfToken;
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(API + path, opts);
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: res.statusText }));
            throw new Error(err.error || 'Request failed');
        }
        if (res.status === 204) return null;
        return res.json();
    }

    function toast(msg, type = 'info') {
        if (typeof Notifications !== 'undefined' && Notifications[type]) Notifications[type](msg);
        else if (window.showToast) window.showToast(msg, type);
        else console.log(`[${type}]`, msg);
    }

    function escHtml(s) {
        const d = document.createElement('div');
        d.textContent = s || '';
        return d.innerHTML;
    }

    function formatDate(d) {
        if (!d) return '—';
        return new Date(d).toLocaleDateString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    }

    // Roles ordered lowest → highest, matching the org membership modal.
    // (Member/Operator/Admin/Owner). Backend value `user` is preserved for
    // compatibility but the label is standardized to "Member" via i18n
    // to avoid vocabulary collision with the server-wide "Viewer" role.
    function roleOptions(selected) {
        const roles = ['user', 'operator', 'admin', 'owner'];
        return roles.map(r =>
            `<option value="${r}" ${r === selected ? 'selected' : ''}>${t('role_' + r)}</option>`
        ).join('');
    }

    // -----------------------------------------------------------------------
    //  Tabs
    // -----------------------------------------------------------------------
    document.querySelectorAll('.org-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.org-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.org-tab-content').forEach(c => c.style.display = 'none');
            tab.classList.add('active');
            document.getElementById(`tab-${tab.dataset.tab}`).style.display = 'block';
            if (tab.dataset.tab === 'address-book') loadAddressBook();
            if (tab.dataset.tab === 'device-groups') loadDeviceGroups();
        });
    });

    // -----------------------------------------------------------------------
    //  Load org header
    // -----------------------------------------------------------------------
    let currentOrg = {};

    async function loadOrgHeader() {
        try {
            const org = await api('GET', '');
            currentOrg = org;
            document.getElementById('org-detail-name').textContent = org.name;
            document.getElementById('org-detail-slug').textContent = org.slug;
        } catch (err) {
            toast(t('loading_failed'), 'error');
        }
    }

    // -----------------------------------------------------------------------
    //  Edit org (header button)
    // -----------------------------------------------------------------------
    document.getElementById('org-edit-btn')?.addEventListener('click', () => {
        Modal.show({
            title: t('edit'),
            content: `
                <div class="form-group">
                    <label class="form-label">${escHtml(t('name'))}</label>
                    <input type="text" id="modal-org-name" class="form-input" value="${escHtml(currentOrg.name || '')}">
                </div>
                <div class="form-group">
                    <label class="form-label">${escHtml(t('slug'))}</label>
                    <input type="text" id="modal-org-slug" class="form-input" value="${escHtml(currentOrg.slug || '')}">
                </div>
                <div class="form-group">
                    <label class="form-label">${escHtml(t('logo_url'))}</label>
                    <input type="text" id="modal-org-logo" class="form-input" value="${escHtml(currentOrg.logo_url || '')}">
                </div>
            `,
            buttons: [
                { label: _('actions.cancel') || 'Cancel', class: 'btn-secondary', onClick: () => Modal.close() },
                {
                    label: _('actions.save') || 'Save', class: 'btn-primary', onClick: async () => {
                        const name = document.getElementById('modal-org-name')?.value?.trim();
                        const slug = document.getElementById('modal-org-slug')?.value?.trim();
                        const logo_url = document.getElementById('modal-org-logo')?.value?.trim();
                        if (!name || !slug) return;
                        try {
                            await api('PUT', '', { name, slug, logo_url });
                            Modal.close();
                            toast(t('edit'), 'success');
                            loadOrgHeader();
                        } catch (err) { toast(err.message, 'error'); }
                    }
                }
            ]
        });
    });

    // -----------------------------------------------------------------------
    //  Users tab
    // -----------------------------------------------------------------------
    async function loadUsers() {
        try {
            const data = await api('GET', '/users');
            const users = data.users || [];
            document.getElementById('users-count').textContent = users.length;
            const container = document.getElementById('users-table');

            if (users.length === 0) {
                container.innerHTML = `<p class="text-muted">${escHtml(t('no_users'))}</p>`;
                return;
            }

            container.innerHTML = `
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>${escHtml(t('username'))}</th>
                            <th>${escHtml(t('display_name'))}</th>
                            <th>${escHtml(t('email'))}</th>
                            <th>${escHtml(t('role'))}</th>
                            <th>${escHtml(t('last_login'))}</th>
                            <th>${escHtml(t('actions'))}</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${users.map(u => `
                            <tr>
                                <td><strong>${escHtml(u.username)}</strong></td>
                                <td>${escHtml(u.display_name)}</td>
                                <td>${escHtml(u.email)}</td>
                                <td><span class="role-badge role-${String(u.role || '').replace(/[^a-z0-9_-]/gi, '')}">${escHtml(t('role_' + u.role) || u.role)}</span></td>
                                <td>${formatDate(u.last_login)}</td>
                                <td>
                                    <button class="btn btn-icon btn-sm user-role-btn" data-user-id="${escHtml(u.id)}" data-role="${escHtml(u.role)}" title="${escHtml(t('edit_role'))}">
                                        <span class="material-icons">edit</span>
                                    </button>
                                    <button class="btn btn-icon btn-sm user-remove-btn" data-user-id="${escHtml(u.id)}" title="${escHtml(_('common.delete') || 'Remove')}">
                                        <span class="material-icons">person_remove</span>
                                    </button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>`;

            container.querySelectorAll('.user-remove-btn').forEach(btn => {
                btn.addEventListener('click', () => deleteUser(btn.dataset.userId));
            });
            container.querySelectorAll('.user-role-btn').forEach(btn => {
                btn.addEventListener('click', () => editUserRole(btn.dataset.userId, btn.dataset.role));
            });
        } catch (err) {
            toast(t('loading_failed'), 'error');
        }
    }

    // Add User modal — supports both creating new org user or linking existing server user
    document.getElementById('add-user-btn')?.addEventListener('click', async () => {
        // Fetch available users first
        let availableUsers = [];
        try {
            const resp = await api('GET', '/available-users');
            availableUsers = resp.users || [];
        } catch (err) {
            console.error('Failed to load available users:', err);
        }

        const hasAvailableUsers = availableUsers.length > 0;
        const userOptions = availableUsers.map(u =>
            `<option value="${escHtml(u.id)}">${escHtml(u.username)} (${escHtml(u.role)})</option>`
        ).join('');

        Modal.show({
            title: t('add_user'),
            content: `
                <div class="modal-tabs">
                    <button type="button" class="modal-tab active" data-tab="create">${escHtml(t('create_new_user'))}</button>
                    <button type="button" class="modal-tab" data-tab="existing">${escHtml(t('add_existing_user'))}${!hasAvailableUsers ? ' (' + escHtml(t('none_available')) + ')' : ''}</button>
                </div>
                <div id="modal-tab-create" class="modal-tab-content" style="display:block">
                    <div class="form-group">
                        <label class="form-label">${escHtml(t('username'))}</label>
                        <input type="text" id="modal-user-name" class="form-input" required autocomplete="off" autocapitalize="off" spellcheck="false">
                    </div>
                    <div class="form-group">
                        <label class="form-label">${escHtml(t('password'))}</label>
                        <input type="password" id="modal-user-pass" class="form-input" required autocomplete="new-password">
                    </div>
                    <div class="form-group">
                        <label class="form-label">${escHtml(t('role'))}</label>
                        <select id="modal-user-role" class="form-input">${roleOptions('user')}</select>
                    </div>
                </div>
                <div id="modal-tab-existing" class="modal-tab-content" style="display:none">
                    ${hasAvailableUsers ? `
                        <div class="form-group">
                            <label class="form-label">${escHtml(t('select_user'))}</label>
                            <select id="modal-existing-user" class="form-input">
                                <option value="">— ${escHtml(t('select_user'))} —</option>
                                ${userOptions}
                            </select>
                        </div>
                        <div class="form-group">
                            <label class="form-label">${escHtml(t('org_role'))}</label>
                            <select id="modal-existing-role" class="form-input">${roleOptions('user')}</select>
                        </div>
                        <p class="text-muted text-sm">${escHtml(t('link_user_hint'))}</p>
                    ` : `
                        <p class="text-muted">${escHtml(t('no_available_users'))}</p>
                    `}
                </div>
            `,
            buttons: [
                { label: _('actions.cancel') || 'Cancel', class: 'btn-secondary', onClick: () => Modal.close() },
                {
                    label: t('add_user'), class: 'btn-primary', icon: 'person_add', onClick: async () => {
                        const activeTab = document.querySelector('.modal-tab.active')?.dataset.tab || 'create';
                        
                        if (activeTab === 'create') {
                            // Create new org user
                            const username = document.getElementById('modal-user-name')?.value?.trim();
                            const password = document.getElementById('modal-user-pass')?.value;
                            const role = document.getElementById('modal-user-role')?.value || 'user';
                            if (!username || !password) return;
                            try {
                                await api('POST', '/users', { username, password, role });
                                Modal.close();
                                toast(t('user_added'), 'success');
                                loadUsers();
                            } catch (err) { toast(err.message, 'error'); }
                        } else {
                            // Link existing server user
                            const userId = document.getElementById('modal-existing-user')?.value;
                            const role = document.getElementById('modal-existing-role')?.value || 'user';
                            if (!userId) {
                                toast(t('select_user'), 'warning');
                                return;
                            }
                            try {
                                await api('POST', '/members', { user_id: parseInt(userId, 10), role });
                                Modal.close();
                                toast(t('user_linked'), 'success');
                                loadUsers();
                            } catch (err) { toast(err.message, 'error'); }
                        }
                    }
                }
            ],
            onOpen: () => {
                // Tab switching
                document.querySelectorAll('.modal-tab').forEach(tab => {
                    tab.addEventListener('click', () => {
                        document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
                        document.querySelectorAll('.modal-tab-content').forEach(c => c.style.display = 'none');
                        tab.classList.add('active');
                        document.getElementById(`modal-tab-${tab.dataset.tab}`).style.display = 'block';
                    });
                });
                setTimeout(() => document.getElementById('modal-user-name')?.focus(), 50);
            }
        });
    });

    // Edit user role modal
    async function editUserRole(uid, currentRole) {
        Modal.show({
            title: t('edit_role'),
            content: `
                <div class="form-group">
                    <label class="form-label">${escHtml(t('role'))}</label>
                    <select id="modal-edit-role" class="form-input">${roleOptions(currentRole)}</select>
                </div>
            `,
            buttons: [
                { label: _('actions.cancel') || 'Cancel', class: 'btn-secondary', onClick: () => Modal.close() },
                {
                    label: _('actions.save') || 'Save', class: 'btn-primary', onClick: async () => {
                        const role = document.getElementById('modal-edit-role')?.value;
                        if (!role) return;
                        try {
                            await api('PUT', `/users/${uid}`, { role });
                            Modal.close();
                            toast(t('user_updated'), 'success');
                            loadUsers();
                        } catch (err) { toast(err.message, 'error'); }
                    }
                }
            ]
        });
    }

    // -----------------------------------------------------------------------
    //  Devices tab
    // -----------------------------------------------------------------------
    async function loadDevices() {
        try {
            const data = await api('GET', '/devices');
            const devices = data.devices || [];
            document.getElementById('devices-count').textContent = devices.length;
            const container = document.getElementById('devices-table');

            if (devices.length === 0) {
                container.innerHTML = `<p class="text-muted">${escHtml(t('no_devices'))}</p>`;
                return;
            }

            container.innerHTML = `
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>${escHtml(t('device_id'))}</th>
                            <th>${escHtml(t('department'))}</th>
                            <th>${escHtml(t('building'))}</th>
                            <th>${escHtml(t('location'))}</th>
                            <th>${escHtml(t('assigned_user'))}</th>
                            <th>${escHtml(t('actions'))}</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${devices.map(d => `
                            <tr>
                                <td><a href="/devices/${escHtml(d.device_id)}">${escHtml(d.device_id)}</a></td>
                                <td>${escHtml(d.department)}</td>
                                <td>${escHtml(d.building)}</td>
                                <td>${escHtml(d.location)}</td>
                                <td>${escHtml(d.assigned_user_id)}</td>
                                <td>
                                    <button class="btn btn-icon btn-sm btn-danger device-unassign-btn" data-device-id="${escHtml(d.device_id)}" title="${escHtml(_('common.delete') || 'Unassign')}">
                                        <span class="material-icons">link_off</span>
                                    </button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>`;

            container.querySelectorAll('.device-unassign-btn').forEach(btn => {
                btn.addEventListener('click', () => unassignDevice(btn.dataset.deviceId));
            });
        } catch (err) {
            toast(t('loading_failed'), 'error');
        }
    }

    // Assign Device modal
    document.getElementById('assign-device-btn')?.addEventListener('click', () => {
        Modal.show({
            title: t('assign_device'),
            content: `
                <div class="form-group">
                    <label class="form-label">${escHtml(t('device_id'))}</label>
                    <input type="text" id="modal-device-id" class="form-input" required>
                </div>
                <div class="form-group">
                    <label class="form-label">${escHtml(t('department'))}</label>
                    <input type="text" id="modal-device-dept" class="form-input">
                </div>
                <div class="form-group">
                    <label class="form-label">${escHtml(t('building'))}</label>
                    <input type="text" id="modal-device-building" class="form-input">
                </div>
            `,
            buttons: [
                { label: _('actions.cancel') || 'Cancel', class: 'btn-secondary', onClick: () => Modal.close() },
                {
                    label: t('assign_device'), class: 'btn-primary', icon: 'add_circle', onClick: async () => {
                        const device_id = document.getElementById('modal-device-id')?.value?.trim();
                        const department = document.getElementById('modal-device-dept')?.value?.trim() || '';
                        const building = document.getElementById('modal-device-building')?.value?.trim() || '';
                        if (!device_id) return;
                        try {
                            await api('POST', '/devices', { device_id, department, building });
                            Modal.close();
                            toast(t('device_assigned'), 'success');
                            loadDevices();
                        } catch (err) { toast(err.message, 'error'); }
                    }
                }
            ],
            onOpen: () => setTimeout(() => document.getElementById('modal-device-id')?.focus(), 50)
        });
    });

    // -----------------------------------------------------------------------
    //  Invitations tab
    // -----------------------------------------------------------------------
    async function loadInvitations() {
        try {
            const data = await api('GET', '/invitations');
            const invs = data.invitations || [];
            document.getElementById('invitations-count').textContent = invs.length;
            const container = document.getElementById('invitations-table');

            if (invs.length === 0) {
                container.innerHTML = `<p class="text-muted">${escHtml(t('no_invitations'))}</p>`;
                return;
            }

            container.innerHTML = `
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>${escHtml(t('token'))}</th>
                            <th>${escHtml(t('email'))}</th>
                            <th>${escHtml(t('role'))}</th>
                            <th>${escHtml(t('expires'))}</th>
                            <th>${escHtml(t('used'))}</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${invs.map(inv => `
                            <tr>
                                <td><code>${escHtml((inv.token || '').substring(0, 16) + '...')}</code></td>
                                <td>${escHtml(inv.email)}</td>
                                <td><span class="role-badge role-${inv.role}">${escHtml(t('role_' + inv.role) || inv.role)}</span></td>
                                <td>${formatDate(inv.expires_at)}</td>
                                <td>${inv.used_at ? formatDate(inv.used_at) : '—'}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>`;
        } catch (err) {
            toast(t('loading_failed'), 'error');
        }
    }

    // Create Invitation modal
    document.getElementById('create-invite-btn')?.addEventListener('click', () => {
        Modal.show({
            title: t('create_invitation'),
            content: `
                <div class="form-group">
                    <label class="form-label">${escHtml(t('email'))}</label>
                    <input type="email" id="modal-invite-email" class="form-input" placeholder="optional">
                </div>
                <div class="form-group">
                    <label class="form-label">${escHtml(t('role'))}</label>
                    <select id="modal-invite-role" class="form-input">${roleOptions('user')}</select>
                </div>
                <div class="form-group">
                    <label class="form-label">${escHtml(t('expires_hours'))}</label>
                    <input type="number" id="modal-invite-hours" class="form-input" value="72" min="1" max="720">
                </div>
            `,
            buttons: [
                { label: _('actions.cancel') || 'Cancel', class: 'btn-secondary', onClick: () => Modal.close() },
                {
                    label: t('create_invitation'), class: 'btn-primary', icon: 'link', onClick: async () => {
                        const email = document.getElementById('modal-invite-email')?.value?.trim() || '';
                        const role = document.getElementById('modal-invite-role')?.value || 'user';
                        const hours = parseInt(document.getElementById('modal-invite-hours')?.value) || 72;
                        try {
                            const inv = await api('POST', '/invite', { email, role, expires_in_hours: hours });
                            Modal.close();
                            toast(t('invitation_created'), 'success');
                            loadInvitations();
                        } catch (err) { toast(err.message, 'error'); }
                    }
                }
            ],
            onOpen: () => setTimeout(() => document.getElementById('modal-invite-email')?.focus(), 50)
        });
    });

    // -----------------------------------------------------------------------
    //  Settings tab
    // -----------------------------------------------------------------------
    async function loadSettings() {
        try {
            const data = await api('GET', '/settings');
            const settings = data.settings || [];
            const container = document.getElementById('settings-container');

            container.innerHTML = `
                <div class="org-settings-form">
                    <div class="form-group">
                        <label>${escHtml(t('connection_policy'))}</label>
                        <select id="setting-connection-policy" class="form-input">
                            <option value="unattended">${escHtml(t('policy_unattended'))}</option>
                            <option value="attended">${escHtml(t('policy_attended'))}</option>
                            <option value="ask_always">${escHtml(t('policy_ask'))}</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>${escHtml(t('allow_file_transfer'))}</label>
                        <select id="setting-allow-file-transfer" class="form-input">
                            <option value="true">${_('common.yes') || 'Yes'}</option>
                            <option value="false">${_('common.no') || 'No'}</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>${escHtml(t('allow_clipboard'))}</label>
                        <select id="setting-allow-clipboard" class="form-input">
                            <option value="true">${_('common.yes') || 'Yes'}</option>
                            <option value="false">${_('common.no') || 'No'}</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>${escHtml(t('max_session_duration'))}</label>
                        <input type="number" id="setting-max-session" class="form-input" value="120" min="0" />
                    </div>
                    <button class="btn btn-primary" id="save-settings-btn">
                        <span class="material-icons">save</span> ${escHtml(t('save'))}
                    </button>
                </div>
                <div class="org-settings-raw">
                    <h3>${escHtml(t('raw_settings'))}</h3>
                    <table class="data-table">
                        <thead><tr><th>${escHtml(t('key'))}</th><th>${escHtml(t('value'))}</th></tr></thead>
                        <tbody>
                            ${settings.map(s => `
                                <tr><td><code>${escHtml(s.key)}</code></td><td>${escHtml(s.value)}</td></tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>`;

            // Apply current settings to form
            settings.forEach(s => {
                const el = document.getElementById(`setting-${s.key.replace(/_/g, '-')}`);
                if (el) el.value = s.value;
            });

            document.getElementById('save-settings-btn')?.addEventListener('click', async () => {
                const saveBtn = document.getElementById('save-settings-btn');
                const originalContent = saveBtn.innerHTML;
                
                // Visual feedback: disable button, show spinner
                saveBtn.disabled = true;
                saveBtn.innerHTML = '<span class="material-icons rotating">sync</span> ' + (t('saving') || 'Saving...');
                
                const settingsToSave = [
                    { key: 'connection_policy', value: document.getElementById('setting-connection-policy')?.value || 'unattended' },
                    { key: 'allow_file_transfer', value: document.getElementById('setting-allow-file-transfer')?.value || 'true' },
                    { key: 'allow_clipboard', value: document.getElementById('setting-allow-clipboard')?.value || 'true' },
                    { key: 'max_session_duration_min', value: document.getElementById('setting-max-session')?.value || '120' },
                ];
                
                console.log('[Org Settings] Saving:', settingsToSave);
                
                try {
                    for (const s of settingsToSave) {
                        console.log('[Org Settings] PUT', s.key, '=', s.value);
                        const result = await api('PUT', '/settings', s);
                        console.log('[Org Settings] Result:', result);
                    }
                    toast(t('settings_saved') || 'Settings saved', 'success');
                    // Reload to confirm persistence
                    await loadSettings();
                } catch (err) {
                    console.error('[Org Settings] Save error:', err);
                    toast(err.message || 'Failed to save settings', 'error');
                } finally {
                    // Restore button
                    saveBtn.disabled = false;
                    saveBtn.innerHTML = originalContent;
                }
            });
        } catch (err) {
            toast(t('loading_failed'), 'error');
        }
    }

    // -----------------------------------------------------------------------
    //  Shared organization address book
    // -----------------------------------------------------------------------
    let addressBookEnabled = true;
    let addressBookPeers = [];
    let addressBookTags = [];
    let addressBookShowJson = false;

    function parseAddressBook(raw) {
        if (!raw || raw === '{}') return { peers: [], tags: [] };
        if (typeof raw === 'object') return raw;
        return JSON.parse(raw);
    }

    function formatAddressBook(ab) {
        const normalized = ab && typeof ab === 'object' ? ab : { peers: [], tags: [] };
        if (!Array.isArray(normalized.peers)) normalized.peers = [];
        if (!Array.isArray(normalized.tags)) normalized.tags = [];
        return JSON.stringify(normalized, null, 2);
    }

    function normalizeAddressBookPeer(peer) {
        const entry = {
            id: String(peer && peer.id || '').trim(),
            alias: String(peer && peer.alias || '').trim(),
            tags: Array.isArray(peer && peer.tags) ? peer.tags.map(String) : [],
            password: String(peer && peer.password || ''),
        };
        return entry;
    }

    function buildAddressBookPayload() {
        if (addressBookShowJson) {
            return currentAddressBookJSON();
        }
        const tagsRaw = document.getElementById('org-address-book-tags-input')?.value || '';
        const tags = tagsRaw.split(',').map(tag => tag.trim()).filter(Boolean);
        const peers = addressBookPeers.map(peer => {
            const entry = { id: String(peer.id || '').trim() };
            if (peer.alias) entry.alias = String(peer.alias).trim();
            if (Array.isArray(peer.tags) && peer.tags.length) entry.tags = peer.tags;
            const password = String(peer.password || '');
            if (password) entry.password = password;
            return entry;
        }).filter(peer => peer.id);
        return { peers, tags };
    }

    function renderAddressBookPeersTable() {
        const tbody = document.getElementById('org-address-book-peers-body');
        if (!tbody) return;
        if (!addressBookPeers.length) {
            tbody.innerHTML = `<tr><td colspan="5" class="org-ab-empty">${escHtml(t('address_book_no_peers'))}</td></tr>`;
            return;
        }
        tbody.innerHTML = addressBookPeers.map((peer, index) => `
            <tr data-index="${index}">
                <td><input type="text" class="form-input org-ab-peer-id" value="${escHtml(peer.id || '')}" maxlength="64" placeholder="123456789"></td>
                <td><input type="text" class="form-input org-ab-peer-alias" value="${escHtml(peer.alias || '')}" maxlength="120" placeholder="${escHtml(t('address_book_alias'))}"></td>
                <td><input type="password" class="form-input org-ab-peer-password" value="${escHtml(peer.password || '')}" maxlength="128" placeholder="${escHtml(t('address_book_password_placeholder'))}" autocomplete="new-password"></td>
                <td><input type="text" class="form-input org-ab-peer-tags" value="${escHtml((peer.tags || []).join(', '))}" maxlength="200" placeholder="${escHtml(t('address_book_peer_tags_placeholder'))}"></td>
                <td class="org-ab-actions">
                    <button type="button" class="action-btn danger org-ab-remove-peer" data-index="${index}" title="${escHtml(t('actions.delete'))}">
                        <span class="material-icons">delete</span>
                    </button>
                </td>
            </tr>
        `).join('');

        tbody.querySelectorAll('.org-ab-remove-peer').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.index, 10);
                if (!Number.isNaN(idx)) {
                    addressBookPeers.splice(idx, 1);
                    renderAddressBookPeersTable();
                }
            });
        });
    }

    function syncAddressBookPeersFromTable() {
        const rows = document.querySelectorAll('#org-address-book-peers-body tr[data-index]');
        addressBookPeers = Array.from(rows).map(row => {
            const tagsRaw = row.querySelector('.org-ab-peer-tags')?.value || '';
            return {
                id: row.querySelector('.org-ab-peer-id')?.value.trim() || '',
                alias: row.querySelector('.org-ab-peer-alias')?.value.trim() || '',
                password: row.querySelector('.org-ab-peer-password')?.value || '',
                tags: tagsRaw.split(',').map(tag => tag.trim()).filter(Boolean),
            };
        }).filter(peer => peer.id);
    }

    function currentAddressBookJSON() {
        const textarea = document.getElementById('org-address-book-json');
        const raw = textarea?.value?.trim() || '{}';
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(t('address_book_invalid_json'));
        }
        if (parsed.peers && !Array.isArray(parsed.peers)) {
            throw new Error(t('address_book_peers_array_required'));
        }
        if (parsed.tags && !Array.isArray(parsed.tags)) {
            throw new Error(t('address_book_tags_array_required'));
        }
        return parsed;
    }

    async function saveAddressBook() {
        let data;
        try {
            syncAddressBookPeersFromTable();
            data = buildAddressBookPayload();
        } catch (err) {
            toast(err.message || t('address_book_invalid_json'), 'error');
            return;
        }

        try {
            const enabled = !!document.getElementById('org-address-book-enabled')?.checked;
            await api('PUT', '/address-book', { data, enabled });
            addressBookEnabled = enabled;
            toast(t('address_book_saved'), 'success');
        } catch (err) {
            toast(err.message || t('address_book_save_failed'), 'error');
        }
    }

    async function importOrgDevicesIntoAddressBook() {
        try {
            syncAddressBookPeersFromTable();
            const data = buildAddressBookPayload();
            const deviceResp = await api('GET', '/devices');
            const devices = deviceResp.devices || [];
            const peers = Array.isArray(data.peers) ? data.peers : [];
            const seen = new Set(peers.map(peer => String(peer.id || '').trim()).filter(Boolean));
            let imported = 0;

            devices.forEach(device => {
                const id = String(device.device_id || '').trim();
                if (!id || seen.has(id)) return;
                const alias = device.assigned_user_id || device.department || device.location || device.building || id;
                peers.push({ id, alias });
                seen.add(id);
                imported += 1;
            });

            data.peers = peers;
            data.tags = Array.isArray(data.tags) ? data.tags : [];
            addressBookPeers = peers;
            addressBookTags = data.tags;
            renderAddressBookPeersTable();
            const tagsInput = document.getElementById('org-address-book-tags-input');
            if (tagsInput) tagsInput.value = data.tags.join(', ');
            toast(imported ? t('address_book_imported') : t('address_book_import_none'), imported ? 'success' : 'info');
        } catch (err) {
            toast(err.message || t('loading_failed'), 'error');
        }
    }

    async function loadAddressBook() {
        try {
            const container = document.getElementById('address-book-container');
            if (!container) return;
            const data = await api('GET', '/address-book');
            const parsed = parseAddressBook(data.data);
            addressBookEnabled = data.enabled !== false;
            addressBookPeers = Array.isArray(parsed.peers) ? parsed.peers.map(normalizeAddressBookPeer) : [];
            addressBookTags = Array.isArray(parsed.tags) ? parsed.tags.map(String) : [];
            addressBookShowJson = false;
            container.innerHTML = `
                <p class="form-hint">${escHtml(t('address_book_intro'))}</p>
                <label class="org-address-book-toggle">
                    <input type="checkbox" id="org-address-book-enabled" ${addressBookEnabled ? 'checked' : ''}>
                    <span>${escHtml(t('address_book_enabled'))}</span>
                </label>
                <div class="org-address-book-structured" id="org-address-book-structured">
                    <div class="org-section-header org-ab-section-header">
                        <h3>${escHtml(t('address_book_contacts'))}</h3>
                        <button type="button" class="btn btn-secondary btn-sm" id="org-address-book-add-peer-btn">
                            <span class="material-icons">person_add</span>
                            ${escHtml(t('address_book_add_peer'))}
                        </button>
                    </div>
                    <div class="org-table-container org-ab-table-wrap">
                        <table class="org-table org-address-book-table">
                            <thead>
                                <tr>
                                    <th>${escHtml(t('address_book_peer_id'))}</th>
                                    <th>${escHtml(t('address_book_alias'))}</th>
                                    <th>${escHtml(t('address_book_password'))}</th>
                                    <th>${escHtml(t('address_book_peer_tags'))}</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody id="org-address-book-peers-body"></tbody>
                        </table>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="org-address-book-tags-input">${escHtml(t('address_book_tags_label'))}</label>
                        <input type="text" id="org-address-book-tags-input" class="form-input" value="${escHtml(addressBookTags.join(', '))}" placeholder="${escHtml(t('address_book_tags_placeholder'))}">
                        <p class="form-hint">${escHtml(t('address_book_tags_hint'))}</p>
                    </div>
                </div>
                <div class="org-address-book-advanced">
                    <button type="button" class="btn btn-secondary btn-sm" id="org-address-book-toggle-json">
                        <span class="material-icons">code</span>
                        ${escHtml(t('address_book_show_json'))}
                    </button>
                    <div class="form-group org-address-book-json-wrap hidden" id="org-address-book-json-wrap">
                        <label class="form-label" for="org-address-book-json">${escHtml(t('address_book_json'))}</label>
                        <textarea id="org-address-book-json" class="form-input org-address-book-json" spellcheck="false">${escHtml(formatAddressBook(parsed))}</textarea>
                        <p class="form-hint">${escHtml(t('address_book_json_hint'))}</p>
                    </div>
                </div>
            `;

            renderAddressBookPeersTable();

            document.getElementById('org-address-book-add-peer-btn')?.addEventListener('click', () => {
                syncAddressBookPeersFromTable();
                addressBookPeers.push({ id: '', alias: '', tags: [], password: '' });
                renderAddressBookPeersTable();
            });

            document.getElementById('org-address-book-toggle-json')?.addEventListener('click', () => {
                addressBookShowJson = !addressBookShowJson;
                const wrap = document.getElementById('org-address-book-json-wrap');
                const btn = document.getElementById('org-address-book-toggle-json');
                const structured = document.getElementById('org-address-book-structured');
                if (addressBookShowJson) {
                    syncAddressBookPeersFromTable();
                    const payload = buildAddressBookPayload();
                    document.getElementById('org-address-book-json').value = formatAddressBook(payload);
                    wrap?.classList.remove('hidden');
                    structured?.classList.add('hidden');
                    if (btn) btn.innerHTML = `<span class="material-icons">view_list</span> ${escHtml(t('address_book_hide_json'))}`;
                } else {
                    try {
                        const parsedJson = currentAddressBookJSON();
                        addressBookPeers = Array.isArray(parsedJson.peers)
                            ? parsedJson.peers.map(normalizeAddressBookPeer)
                            : [];
                        addressBookTags = Array.isArray(parsedJson.tags) ? parsedJson.tags.map(String) : [];
                        document.getElementById('org-address-book-tags-input').value = addressBookTags.join(', ');
                        renderAddressBookPeersTable();
                    } catch (err) {
                        toast(err.message || t('address_book_invalid_json'), 'error');
                        addressBookShowJson = true;
                        return;
                    }
                    wrap?.classList.add('hidden');
                    structured?.classList.remove('hidden');
                    if (btn) btn.innerHTML = `<span class="material-icons">code</span> ${escHtml(t('address_book_show_json'))}`;
                }
            });

            const saveBtn = document.getElementById('save-address-book-btn');
            const importBtn = document.getElementById('import-org-devices-btn');
            if (saveBtn) saveBtn.onclick = saveAddressBook;
            if (importBtn) importBtn.onclick = importOrgDevicesIntoAddressBook;
        } catch (err) {
            toast(t('loading_failed'), 'error');
        }
    }

    // -----------------------------------------------------------------------
    //  Device groups linked to this organization (team_id)
    // -----------------------------------------------------------------------
    function groupTypeLabel(group) {
        if ((group.source_type || 'manual') === 'tag' && group.tag_filter) {
            return `${t('group_type_tag')}: ${group.tag_filter}`;
        }
        return t('group_type_manual');
    }

    function renderOrgGroupsList(groups, emptyKey) {
        if (!groups.length) {
            return `<p class="form-hint org-groups-empty">${escHtml(t(emptyKey))}</p>`;
        }
        return `
            <table class="data-table org-groups-table">
                <thead>
                    <tr>
                        <th>${escHtml(t('group_name'))}</th>
                        <th>${escHtml(t('group_type'))}</th>
                        <th>${escHtml(t('group_members'))}</th>
                        <th>${escHtml(t('group_allowed_user_groups'))}</th>
                    </tr>
                </thead>
                <tbody>
                    ${groups.map(group => `
                        <tr>
                            <td>
                                <strong>${escHtml(group.name || group.guid)}</strong>
                                ${group.note ? `<div class="text-muted org-group-note">${escHtml(group.note)}</div>` : ''}
                            </td>
                            <td>${escHtml(groupTypeLabel(group))}</td>
                            <td>${escHtml(String(group.member_count ?? 0))}</td>
                            <td>${escHtml(
                                (group.allowed_user_groups || [])
                                    .map(g => g.name || g.guid)
                                    .filter(Boolean)
                                    .join(', ') || '—'
                            )}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>`;
    }

    async function loadDeviceGroups() {
        try {
            const data = await api('GET', '/device-groups');
            const container = document.getElementById('device-groups-container');
            if (!container) return;

            const deviceGroups = data.device_groups || [];
            const userGroups = data.user_groups || [];

            container.innerHTML = `
                <p class="form-hint">${escHtml(t('device_groups_intro'))}</p>
                <p class="form-hint org-team-id-hint">
                    <code>${escHtml(t('org_team_id'))}: ${escHtml(orgId)}</code>
                </p>
                <div class="org-section-actions">
                    <button class="btn btn-primary btn-sm" id="create-org-device-group-btn">
                        <span class="material-icons">add</span> ${escHtml(t('create_org_device_group'))}
                    </button>
                </div>
                ${renderOrgGroupsList(deviceGroups, 'no_org_device_groups')}
                <h3 class="org-groups-subtitle">${escHtml(t('org_user_groups_title'))}</h3>
                <p class="form-hint">${escHtml(t('org_user_groups_intro'))}</p>
                ${userGroups.length ? `
                    <table class="data-table org-groups-table">
                        <thead>
                            <tr>
                                <th>${escHtml(t('group_name'))}</th>
                                <th>${escHtml(_('users.members') || 'Members')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${userGroups.map(group => `
                                <tr>
                                    <td>
                                        <strong>${escHtml(group.name || group.guid)}</strong>
                                        ${group.note ? `<div class="text-muted org-group-note">${escHtml(group.note)}</div>` : ''}
                                    </td>
                                    <td>${escHtml(String(group.member_count ?? 0))}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                ` : `<p class="form-hint org-groups-empty">${escHtml(t('no_org_user_groups'))}</p>`}
            `;

            document.getElementById('create-org-device-group-btn')?.addEventListener('click', () => {
                const defaultName = currentOrg.name
                    ? `${currentOrg.name} — ${t('group_devices_suffix')}`
                    : t('create_org_device_group');
                Modal.show({
                    title: t('create_org_device_group'),
                    content: `
                        <div class="form-group">
                            <label class="form-label">${escHtml(t('group_name'))}</label>
                            <input type="text" id="modal-org-dg-name" class="form-input" value="${escHtml(defaultName)}" maxlength="80">
                        </div>
                        <p class="form-hint">${escHtml(t('link_team_id_hint'))}</p>
                    `,
                    buttons: [
                        { label: _('actions.cancel') || 'Cancel', class: 'btn-secondary', onClick: () => Modal.close() },
                        {
                            label: _('actions.create') || 'Create',
                            class: 'btn-primary',
                            onClick: async () => {
                                const name = document.getElementById('modal-org-dg-name')?.value?.trim();
                                if (!name) {
                                    toast(t('group_name_required'), 'error');
                                    return;
                                }
                                try {
                                    const csrfToken = window.BetterDesk?.csrfToken || '';
                                    const res = await fetch('/api/device-groups', {
                                        method: 'POST',
                                        headers: {
                                            'Content-Type': 'application/json',
                                            ...(csrfToken ? { 'x-csrf-token': csrfToken } : {})
                                        },
                                        body: JSON.stringify({
                                            name,
                                            team_id: orgId,
                                            source_type: 'manual'
                                        })
                                    });
                                    if (!res.ok) {
                                        const err = await res.json().catch(() => ({}));
                                        throw new Error(err.error || 'Request failed');
                                    }
                                    Modal.close();
                                    toast(t('org_device_group_created'), 'success');
                                    loadDeviceGroups();
                                } catch (err) {
                                    toast(err.message || t('loading_failed'), 'error');
                                }
                            }
                        }
                    ]
                });
            });
        } catch (err) {
            toast(t('loading_failed'), 'error');
        }
    }

    // -----------------------------------------------------------------------
    //  Delete org
    // -----------------------------------------------------------------------
    document.getElementById('org-delete-btn')?.addEventListener('click', async () => {
        const confirmed = await Modal.confirm({
            title: _('common.delete') || 'Delete',
            message: t('confirm_delete_org'),
            danger: true,
            confirmIcon: 'delete'
        });
        if (!confirmed) return;
        try {
            await api('DELETE', '');
            toast(t('org_deleted'), 'success');
            window.location.href = '/organizations';
        } catch (err) {
            toast(err.message, 'error');
        }
    });

    async function deleteUser(uid) {
        const confirmed = await Modal.confirm({
            title: _('common.delete') || 'Remove',
            message: t('confirm_remove_user'),
            danger: true,
            confirmIcon: 'person_remove'
        });
        if (!confirmed) return;
        try {
            await api('DELETE', `/users/${uid}`);
            toast(t('user_removed'), 'success');
            loadUsers();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    async function unassignDevice(did) {
        const confirmed = await Modal.confirm({
            title: _('common.delete') || 'Unassign',
            message: t('confirm_unassign_device'),
            danger: true,
            confirmIcon: 'link_off'
        });
        if (!confirmed) return;
        try {
            await api('DELETE', `/devices/${did}`);
            toast(t('device_unassigned'), 'success');
            loadDevices();
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    // -----------------------------------------------------------------------
    //  Init
    // -----------------------------------------------------------------------
    loadOrgHeader();
    loadUsers();
    loadDevices();
    loadInvitations();
    loadSettings();
    loadAddressBook();
    loadDeviceGroups();

})();
