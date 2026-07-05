/**
 * BetterDesk Console - Users Routes
 * User management for admins (CRUD operations)
 */

const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const db = require('../services/database');
const { apiClient } = require('../services/betterdeskApi');
const { assertSafeApiId } = require('../lib/goApiPath');
const userSync = require('../services/userSync');
const userScopeService = require('../services/userScopeService');
const deviceGroupService = require('../services/deviceGroupService');
const serverBackend = require('../services/serverBackend');
const { requireAuth, requirePermission, roleHasPermission, isSuperAdminRole } = require('../middleware/auth');
const { passwordChangeLimiter } = require('../middleware/rateLimiter');

// ---------------------------------------------------------------------------
//  Helper: proxy to Go server
// ---------------------------------------------------------------------------

async function goApiProxy(req, res, method, path, body) {
    try {
        const opts = { method, url: path };
        if (body) opts.data = body;
        const resp = await apiClient(opts);
        res.status(resp.status).json(resp.data);
    } catch (err) {
        const status = err.response?.status || 500;
        const data = err.response?.data || { error: 'Go server unreachable' };
        res.status(status).json(data);
    }
}

async function resolveGoUserIdOrRespond(req, res) {
    const userId = parseInt(req.params.id, 10);
    if (isNaN(userId) || userId <= 0) {
        res.status(400).json({ success: false, error: 'Invalid user ID' });
        return null;
    }

    const localUser = await db.getUserById(userId);
    if (!localUser) {
        res.status(404).json({ success: false, error: req.t('users.not_found') });
        return null;
    }

    const goUserId = await userSync.resolveGoUserId(userId);
    if (!goUserId) {
        res.status(502).json({ success: false, error: 'User is not synchronized with the Go server' });
        return null;
    }
    return goUserId;
}

function normalizeGroupGuids(value) {
    const raw = Array.isArray(value) ? value : String(value || '').split(',');
    return Array.from(new Set(raw.map(v => String(v || '').trim()).filter(Boolean))).slice(0, 100);
}

function isValidGroupGuid(guid) {
    return typeof guid === 'string' && guid.length > 0 && guid.length <= 80 && /^[A-Za-z0-9_.:-]+$/.test(guid);
}

function validateGroupGuidsFromBody(body) {
    if (!Object.prototype.hasOwnProperty.call(body || {}, 'groupGuids')) return null;
    const groupGuids = normalizeGroupGuids(body.groupGuids);
    if (groupGuids.some(guid => !isValidGroupGuid(guid))) {
        const error = new Error('Invalid user group identifier');
        error.status = 400;
        throw error;
    }
    return groupGuids;
}

function serializeUserGroup(group) {
    return {
        guid: group.guid,
        name: group.name,
        note: group.note || '',
        team_id: group.team_id || '',
        member_count: group.member_count || 0
    };
}

function normalizeUserGroupPayload(body) {
    const name = String((body && body.name) || '').trim();
    const note = String((body && body.note) || '').trim();
    const teamId = String((body && body.team_id) || '').trim();

    if (!name) {
        const error = new Error('Group name is required');
        error.status = 400;
        throw error;
    }
    if (name.length > 80) {
        const error = new Error('Group name is too long');
        error.status = 400;
        throw error;
    }
    if (note.length > 500) {
        const error = new Error('Group note is too long');
        error.status = 400;
        throw error;
    }
    if (teamId && !isValidGroupGuid(teamId)) {
        const error = new Error('Invalid team identifier');
        error.status = 400;
        throw error;
    }

    return { name, note, team_id: teamId };
}

async function serializeUserForList(u) {
    const folderIds = await userScopeService.getUserFolderIds(db, u.username);
    const peerGrants = await userScopeService.getUserPeerGrantIds(db, u.id);
    let strategyGuid = '';
    if (typeof db.getUserStrategyGuid === 'function') {
        try {
            strategyGuid = await db.getUserStrategyGuid(u.id);
        } catch (_) {}
    }
    return {
        id: u.id,
        username: u.username,
        role: u.role,
        email: u.email || '',
        auth_provider: u.auth_provider || 'local',
        created_at: u.created_at,
        last_login: u.last_login,
        user_groups: await getUserGroupGuids(u.id),
        folder_ids: folderIds,
        peer_grants: peerGrants,
        strategy_guid: strategyGuid
    };
}

async function applyUserScopeFromBody(userId, username, body) {
    if (Object.prototype.hasOwnProperty.call(body || {}, 'folderIds')) {
        await userScopeService.syncUserFolderAccess(db, username, body.folderIds);
    }
    if (Object.prototype.hasOwnProperty.call(body || {}, 'peerIds')) {
        await userScopeService.syncUserPeerGrants(db, userId, body.peerIds);
    }
    if (Object.prototype.hasOwnProperty.call(body || {}, 'strategyGuid') && typeof db.setUserStrategyAssignment === 'function') {
        const strategyGuid = await db.setUserStrategyAssignment(userId, body.strategyGuid || '');
        if (await serverBackend.isBetterDesk()) {
            try {
                const userKey = typeof db.resolveUserAssignmentKey === 'function'
                    ? await db.resolveUserAssignmentKey(username)
                    : username;
                await apiClient({
                    method: 'POST',
                    url: '/strategies/assign',
                    data: {
                        strategy: strategyGuid || undefined,
                        users: userKey ? [userKey] : []
                    }
                });
            } catch (err) {
                console.warn('[users] Strategy assign Go sync failed:', err.message);
            }
        }
    }
}

async function getUserGroupGuids(userId) {
    if (typeof db.getUserGroupsForUser !== 'function') return [];
    const groups = await db.getUserGroupsForUser(userId);
    return (groups || []).map(group => group.guid).filter(Boolean);
}

async function updateUserGroupMembershipsFromBody(userId, body) {
    const groupGuids = validateGroupGuidsFromBody(body);
    if (!groupGuids) return null;
    await db.setUserGroupMemberships(userId, groupGuids);
    return groupGuids;
}

function runBestEffortUserSync(operation) {
    try {
        Promise.resolve(operation()).catch(() => {});
    } catch (_) {
        // Best-effort sync must never break local user management.
    }
}

function normalizeUserEmail(value) {
    if (value === undefined || value === null) return undefined;
    const trimmed = String(value).trim();
    if (!trimmed) return '';
    if (trimmed.length > 200) {
        const err = new Error('email_too_long');
        err.status = 400;
        throw err;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        const err = new Error('invalid_email');
        err.status = 400;
        throw err;
    }
    return trimmed;
}

function requireAnyPermission(...permissions) {
    return function(req, res, next) {
        const role = req.session && req.session.user && req.session.user.role;
        if (permissions.some(permission => roleHasPermission(role, permission))) return next();
        return res.status(403).json({ success: false, error: `Permission denied: ${permissions.join(' or ')}` });
    };
}

/**
 * GET /users - Users management page (admin only)
 */
router.get('/users', requireAuth, requirePermission('user.view'), (req, res) => {
    res.render('users', {
        title: req.t('nav.users'),
        activePage: 'users'
    });
});

/**
 * GET /api/users - Get all users (admin only)
 */
router.get('/api/users', requireAuth, requirePermission('user.view'), async (req, res) => {
    try {
        await userSync.backfillFromGo();
        const users = await db.getAllUsers();
        
        // Remove sensitive data
        const safeUsers = await Promise.all(users.map(u => serializeUserForList(u)));
        
        res.json({
            success: true,
            data: {
                users: safeUsers,
                total: safeUsers.length
            }
        });
    } catch (err) {
        console.error('Get users error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * GET /api/panel/user-groups - Get user groups for panel assignment UIs.
 */
router.get('/api/panel/user-groups', requireAuth, requireAnyPermission('user.view', 'device.edit'), async (req, res) => {
    try {
        const groups = await db.getAllUserGroups();
        res.json({
            success: true,
            data: {
                groups: (groups || []).map(serializeUserGroup),
                total: groups.length
            }
        });
    } catch (err) {
        console.error('Get user groups error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/panel/user-groups - Create a user group for panel access scoping.
 */
router.post('/api/panel/user-groups', requireAuth, requirePermission('user.edit'), async (req, res) => {
    try {
        const payload = normalizeUserGroupPayload(req.body || {});
        const group = await db.createUserGroup(payload);
        await db.logAction(req.session.userId, 'user_group_created', `Created user group: ${group.name}`, req.ip);
        res.json({ success: true, data: { group: serializeUserGroup(group) } });
    } catch (err) {
        console.error('Create user group error:', err);
        res.status(err.status || 500).json({
            success: false,
            error: err.status === 400 ? err.message : req.t('errors.server_error')
        });
    }
});

/**
 * PATCH /api/panel/user-groups/:guid - Update a user group.
 */
router.patch('/api/panel/user-groups/:guid', requireAuth, requirePermission('user.edit'), async (req, res) => {
    try {
        const guid = String(req.params.guid || '').trim();
        if (!isValidGroupGuid(guid)) {
            return res.status(400).json({ success: false, error: 'Invalid user group identifier' });
        }

        const existing = await db.getUserGroupByGuid(guid);
        if (!existing) {
            return res.status(404).json({ success: false, error: req.t('users.user_group_not_found') });
        }

        const payload = normalizeUserGroupPayload(req.body || {});
        const group = await db.updateUserGroup(guid, payload);
        await db.logAction(req.session.userId, 'user_group_updated', `Updated user group: ${group.name}`, req.ip);
        res.json({ success: true, data: { group: serializeUserGroup(group) } });
    } catch (err) {
        console.error('Update user group error:', err);
        res.status(err.status || 500).json({
            success: false,
            error: err.status === 400 ? err.message : req.t('errors.server_error')
        });
    }
});

/**
 * DELETE /api/panel/user-groups/:guid - Delete a user group.
 */
router.delete('/api/panel/user-groups/:guid', requireAuth, requirePermission('user.edit'), async (req, res) => {
    try {
        const guid = String(req.params.guid || '').trim();
        if (!isValidGroupGuid(guid)) {
            return res.status(400).json({ success: false, error: 'Invalid user group identifier' });
        }

        const group = await db.getUserGroupByGuid(guid);
        if (!group) {
            return res.status(404).json({ success: false, error: req.t('users.user_group_not_found') });
        }

        await db.deleteUserGroup(guid);
        await db.logAction(req.session.userId, 'user_group_deleted', `Deleted user group: ${group.name}`, req.ip);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete user group error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/users - Create new user (admin only)
 */
router.post('/api/users', requireAuth, requirePermission('user.create'), passwordChangeLimiter, async (req, res) => {
    try {
        const { username, password, role, email } = req.body;
        
        // Validate input
        if (!username || !password) {
            return res.status(400).json({
                success: false,
                error: req.t('users.fill_required')
            });
        }
        
        // Validate username format
        if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
            return res.status(400).json({
                success: false,
                error: req.t('users.invalid_username')
            });
        }
        
        // Check username uniqueness
        const existingUser = await db.getUserByUsername(username);
        if (existingUser) {
            return res.status(400).json({
                success: false,
                error: req.t('users.username_exists')
            });
        }

        const groupGuids = validateGroupGuidsFromBody(req.body) || [];
        
        // Validate password strength
        const passwordCheck = authService.validatePasswordStrength(password);
        if (passwordCheck.strength === 'weak') {
            return res.status(400).json({
                success: false,
                error: req.t('users.weak_password'),
                feedback: passwordCheck.feedback
            });
        }
        
        // Validate role (7-role hierarchy — Phase 52)
        const validRoles = ['super_admin', 'admin', 'server_admin', 'global_admin', 'operator', 'viewer', 'pro'];
        const userRole = validRoles.includes(role) ? role : 'viewer';
        
        // Hash password
        const passwordHash = await authService.hashPassword(password);
        
        // Create user
        const result = await db.createUser(username, passwordHash, userRole);
        await db.setUserGroupMemberships(result.id, groupGuids);

        let savedEmail = '';
        if (email !== undefined) {
            savedEmail = normalizeUserEmail(email);
            await db.updateUserProfile(result.id, { email: savedEmail });
        }

        // Mirror to Go server so the user is linkable to organizations
        // (Issue #125). Best-effort — does not fail panel-side creation.
        runBestEffortUserSync(() => userSync.mirrorCreate(username, password, userRole));

        if (Object.prototype.hasOwnProperty.call(req.body || {}, 'folderIds') ||
            Object.prototype.hasOwnProperty.call(req.body || {}, 'peerIds') ||
            Object.prototype.hasOwnProperty.call(req.body || {}, 'strategyGuid')) {
            await applyUserScopeFromBody(result.id, username, req.body);
        }

        // Log action
        await db.logAction(req.session.userId, 'user_created', `Created user: ${username} (${userRole})`, req.ip);
        
        res.json({
            success: true,
            data: {
                id: result.id,
                username,
                role: userRole,
                email: savedEmail,
                user_groups: groupGuids,
                folder_ids: await userScopeService.getUserFolderIds(db, username),
                peer_grants: await userScopeService.getUserPeerGrantIds(db, result.id)
            }
        });
    } catch (err) {
        console.error('Create user error:', err);
        res.status(err.status || 500).json({
            success: false,
            error: err.status === 400 ? err.message : req.t('errors.server_error')
        });
    }
});

/**
 * PATCH /api/users/:id - Update user (admin only)
 */
router.patch('/api/users/:id', requireAuth, requirePermission('user.edit'), async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId) || userId <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        const { role, password, email } = req.body;
        
        const user = await db.getUserById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: req.t('users.not_found')
            });
        }

        const provider = String(user.auth_provider || 'local').trim().toLowerCase();
        const isExternalAccount = provider === 'ldap' || provider === 'oidc';

        if (isExternalAccount && password) {
            return res.status(400).json({
                success: false,
                error: req.t('users.provider_managed_hint')
            });
        }
        if (isExternalAccount && role) {
            return res.status(400).json({
                success: false,
                error: req.t('users.provider_managed_hint')
            });
        }
        
        // Prevent self-demotion from admin-level role
        if (userId === req.session.userId && role && isSuperAdminRole(req.session.user.role) && !isSuperAdminRole(role)) {
            return res.status(400).json({
                success: false,
                error: req.t('users.cannot_demote_self')
            });
        }
        
        // Update role if provided
        if (role) {
            const validRoles = ['super_admin', 'admin', 'server_admin', 'global_admin', 'operator', 'viewer', 'pro'];
            if (!validRoles.includes(role)) {
                return res.status(400).json({
                    success: false,
                    error: req.t('users.invalid_role')
                });
            }
            await db.updateUserRole(userId, role);
            // Mirror role change to Go (Issue #125)
            runBestEffortUserSync(() => userSync.mirrorUpdate(user.username, { role }));
        }
        
        // Update password if provided
        if (password) {
            const passwordCheck = authService.validatePasswordStrength(password);
            if (passwordCheck.strength === 'weak') {
                return res.status(400).json({
                    success: false,
                    error: req.t('users.weak_password'),
                    feedback: passwordCheck.feedback
                });
            }
            
            const passwordHash = await authService.hashPassword(password);
            await db.updateUserPassword(userId, passwordHash);
            // Mirror password change to Go (Issue #125)
            runBestEffortUserSync(() => userSync.mirrorUpdate(user.username, { password }));
        }

        await updateUserGroupMembershipsFromBody(userId, req.body);
        await applyUserScopeFromBody(userId, user.username, req.body);

        if (email !== undefined) {
            const normalizedEmail = normalizeUserEmail(email);
            await db.updateUserProfile(userId, { email: normalizedEmail });
        }
        
        // Log action
        await db.logAction(req.session.userId, 'user_updated', `Updated user: ${user.username}`, req.ip);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Update user error:', err);
        res.status(err.status || 500).json({
            success: false,
            error: err.status === 400 ? err.message : req.t('errors.server_error')
        });
    }
});

/**
 * GET /api/users/:id/effective-scope - Count devices visible to a user (admin).
 */
router.get('/api/users/:id/effective-scope', requireAuth, requirePermission('user.view'), async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId) || userId <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        const user = await db.getUserById(userId);
        if (!user) {
            return res.status(404).json({ success: false, error: req.t('users.not_found') });
        }
        let devices = [];
        try {
            devices = await serverBackend.getAllDevices({});
        } catch (_) {
            devices = [];
        }
        const result = await userScopeService.countEffectiveScope(db, user, devices);
        res.json({ success: true, data: result });
    } catch (err) {
        console.error('Effective scope error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * DELETE /api/users/:id - Delete user (admin only)
 */
router.delete('/api/users/:id', requireAuth, requirePermission('user.delete'), async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId) || userId <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        
        const user = await db.getUserById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: req.t('users.not_found')
            });
        }
        
        // Prevent self-deletion
        if (userId === req.session.userId) {
            return res.status(400).json({
                success: false,
                error: req.t('users.cannot_delete_self')
            });
        }
        
        // Ensure at least one admin remains
        const adminCount = await db.countAdmins();
        if (isSuperAdminRole(user.role) && adminCount <= 1) {
            return res.status(400).json({
                success: false,
                error: req.t('users.last_admin')
            });
        }
        
        await db.deleteUser(userId);

        // Mirror delete to Go server so org links are cleaned up (Issue #125)
        runBestEffortUserSync(() => userSync.mirrorDelete(user.username));

        // Log action
        await db.logAction(req.session.userId, 'user_deleted', `Deleted user: ${user.username}`, req.ip);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Delete user error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * POST /api/users/:id/reset-password - Admin reset user password
 */
router.post('/api/users/:id/reset-password', requireAuth, requirePermission('user.edit'), passwordChangeLimiter, async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId) || userId <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        const { newPassword } = req.body;
        
        const user = await db.getUserById(userId);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: req.t('users.not_found')
            });
        }
        
        if (!newPassword) {
            return res.status(400).json({
                success: false,
                error: req.t('users.password_required')
            });
        }
        
        const passwordCheck = authService.validatePasswordStrength(newPassword);
        if (passwordCheck.strength === 'weak') {
            return res.status(400).json({
                success: false,
                error: req.t('users.weak_password'),
                feedback: passwordCheck.feedback
            });
        }
        
        const passwordHash = await authService.hashPassword(newPassword);
        await db.updateUserPassword(userId, passwordHash);

        // Mirror password reset to Go (Issue #125)
        runBestEffortUserSync(() => userSync.mirrorUpdate(user.username, { password: newPassword }));

        // Log action
        await db.logAction(req.session.userId, 'password_reset', `Reset password for user: ${user.username}`, req.ip);
        
        res.json({ success: true });
    } catch (err) {
        console.error('Reset password error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

// ---------------------------------------------------------------------------
//  User-Org Linking (Issue #106)
// ---------------------------------------------------------------------------

/**
 * GET /api/users/:id/organizations - Get organizations a user belongs to
 */
router.get('/api/users/:id/organizations', requireAuth, requirePermission('user.view'), async (req, res) => {
    try {
        const goUserId = await resolveGoUserIdOrRespond(req, res);
        if (!goUserId) return;
        const safeGoUserId = assertSafeApiId(goUserId, 'userId');
        goApiProxy(req, res, 'get', `/users/${encodeURIComponent(safeGoUserId)}/organizations`);
    } catch (err) {
        console.error('Resolve user organizations error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/users/:id/organizations - Assign user to an organization
 */
router.post('/api/users/:id/organizations', requireAuth, requirePermission('org.manage_users'), async (req, res) => {
    try {
        const goUserId = await resolveGoUserIdOrRespond(req, res);
        if (!goUserId) return;
        const safeGoUserId = assertSafeApiId(goUserId, 'userId');
        goApiProxy(req, res, 'post', `/users/${encodeURIComponent(safeGoUserId)}/organizations`, req.body);
    } catch (err) {
        console.error('Assign user organization error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

module.exports = router;
