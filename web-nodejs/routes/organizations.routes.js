/**
 * BetterDesk Console — Organization Management Routes (v3.0.0)
 *
 * Proxies organization CRUD operations to the Go server REST API.
 * Provides page routes for the web panel and API routes for AJAX calls.
 *
 * Page routes:
 *   GET /organizations          — Organizations management page
 *   GET /organizations/:id      — Organization detail page
 *
 * API routes (proxy to Go server /api/org/*):
 *   GET    /api/panel/org              — List organizations
 *   POST   /api/panel/org              — Create organization
 *   GET    /api/panel/org/:id          — Get organization
 *   PUT    /api/panel/org/:id          — Update organization
 *   DELETE /api/panel/org/:id          — Delete organization
 *   GET    /api/panel/org/:id/users    — List org users
 *   POST   /api/panel/org/:id/users    — Create org user
 *   PUT    /api/panel/org/:id/users/:uid — Update org user
 *   DELETE /api/panel/org/:id/users/:uid — Delete org user
 *   POST   /api/panel/org/:id/invite   — Create invitation
 *   GET    /api/panel/org/:id/invitations — List invitations
 *   POST   /api/panel/org/:id/devices  — Assign device to org
 *   GET    /api/panel/org/:id/devices  — List org devices
 *   DELETE /api/panel/org/:id/devices/:did — Unassign device
 *   GET    /api/panel/org/:id/settings — List org settings
 *   PUT    /api/panel/org/:id/settings — Set org setting
 *   GET    /api/panel/org/:id/address-book — Get shared org address book
 *   PUT    /api/panel/org/:id/address-book — Update shared org address book
 */

'use strict';

const express = require('express');
const router = express.Router();
const { apiClient } = require('../services/betterdeskApi');
const { assertSafeApiId } = require('../lib/goApiPath');
const { requireAuth, requirePermission } = require('../middleware/auth');
const userSync = require('../services/userSync');
const db = require('../services/database');
const serverBackend = require('../services/serverBackend');
const deviceGroupService = require('../services/deviceGroupService');

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

function orgApiPath(orgId, suffix = '') {
    const id = assertSafeApiId(orgId, 'orgId');
    return `/org/${encodeURIComponent(id)}${suffix}`;
}

function orgUserApiPath(orgId, userId) {
    return `${orgApiPath(orgId)}/users/${encodeURIComponent(assertSafeApiId(userId, 'userId'))}`;
}

function orgDeviceApiPath(orgId, deviceId) {
    return `${orgApiPath(orgId)}/devices/${encodeURIComponent(assertSafeApiId(deviceId, 'deviceId'))}`;
}

function orgMemberApiPath(orgId, userId) {
    return `${orgApiPath(orgId)}/members/${encodeURIComponent(assertSafeApiId(userId, 'userId'))}`;
}

async function goApiProxySafe(req, res, method, pathBuilder, body) {
    try {
        const path = typeof pathBuilder === 'function' ? pathBuilder() : pathBuilder;
        return goApiProxy(req, res, method, path, body);
    } catch (err) {
        if (err.message && /^Invalid /.test(err.message)) {
            return res.status(400).json({ error: err.message });
        }
        throw err;
    }
}

async function resolveGoMemberId(userId) {
    const resolved = await userSync.resolveGoUserId(userId);
    return resolved || userId;
}

// ---------------------------------------------------------------------------
//  Page routes
// ---------------------------------------------------------------------------

router.get('/organizations', requireAuth, (req, res) => {
    res.render('organizations', {
        title: 'Organizations',
        user: req.session.user,
        currentPage: 'organizations',
    });
});

router.get('/organizations/:id', requireAuth, (req, res) => {
    res.render('organization-detail', {
        title: 'Organization Details',
        user: req.session.user,
        currentPage: 'organizations',
        orgId: req.params.id,
    });
});

// ---------------------------------------------------------------------------
//  API routes (proxy to Go server)
// ---------------------------------------------------------------------------

// Organizations CRUD
router.get('/api/panel/org', requireAuth, (req, res) => goApiProxy(req, res, 'get', '/org'));
router.post('/api/panel/org', requireAuth, requirePermission('org.create'), (req, res) => goApiProxy(req, res, 'post', '/org', req.body));
router.get('/api/panel/org/:id', requireAuth, (req, res) =>
    goApiProxySafe(req, res, 'get', () => orgApiPath(req.params.id)));
router.put('/api/panel/org/:id', requireAuth, requirePermission('org.edit'), (req, res) =>
    goApiProxySafe(req, res, 'put', () => orgApiPath(req.params.id), req.body));
router.delete('/api/panel/org/:id', requireAuth, requirePermission('org.delete'), (req, res) =>
    goApiProxySafe(req, res, 'delete', () => orgApiPath(req.params.id)));

// Org Users
router.get('/api/panel/org/:id/users', requireAuth, (req, res) =>
    goApiProxySafe(req, res, 'get', () => orgApiPath(req.params.id, '/users')));
router.post('/api/panel/org/:id/users', requireAuth, requirePermission('org.manage_users'), (req, res) =>
    goApiProxySafe(req, res, 'post', () => orgApiPath(req.params.id, '/users'), req.body));
router.put('/api/panel/org/:id/users/:uid', requireAuth, requirePermission('org.manage_users'), (req, res) =>
    goApiProxySafe(req, res, 'put', () => orgUserApiPath(req.params.id, req.params.uid), req.body));
router.delete('/api/panel/org/:id/users/:uid', requireAuth, requirePermission('org.manage_users'), (req, res) =>
    goApiProxySafe(req, res, 'delete', () => orgUserApiPath(req.params.id, req.params.uid)));

// User-Org Linking (Issue #106)
router.get('/api/panel/org/:id/available-users', requireAuth, requirePermission('org.manage_users'), (req, res) =>
    goApiProxySafe(req, res, 'get', () => orgApiPath(req.params.id, '/available-users')));
router.post('/api/panel/org/:id/members', requireAuth, requirePermission('org.manage_users'), (req, res) =>
    goApiProxySafe(req, res, 'post', () => orgApiPath(req.params.id, '/members'), req.body));
router.delete('/api/panel/org/:id/members/:userId', requireAuth, requirePermission('org.manage_users'), async (req, res) => {
    try {
        const goUserId = await resolveGoMemberId(req.params.userId);
        return goApiProxySafe(req, res, 'delete', () => orgMemberApiPath(req.params.id, goUserId));
    } catch (err) {
        if (err.message && /^Invalid /.test(err.message)) {
            return res.status(400).json({ error: err.message });
        }
        res.status(500).json({ error: 'Failed to resolve user' });
    }
});

// Invitations
router.post('/api/panel/org/:id/invite', requireAuth, requirePermission('org.manage_users'), (req, res) =>
    goApiProxySafe(req, res, 'post', () => orgApiPath(req.params.id, '/invite'), req.body));
router.get('/api/panel/org/:id/invitations', requireAuth, requirePermission('org.manage_users'), (req, res) =>
    goApiProxySafe(req, res, 'get', () => orgApiPath(req.params.id, '/invitations')));

// Devices
router.post('/api/panel/org/:id/devices', requireAuth, requirePermission('org.manage_devices'), (req, res) =>
    goApiProxySafe(req, res, 'post', () => orgApiPath(req.params.id, '/devices'), req.body));
router.get('/api/panel/org/:id/devices', requireAuth, (req, res) =>
    goApiProxySafe(req, res, 'get', () => orgApiPath(req.params.id, '/devices')));
router.delete('/api/panel/org/:id/devices/:did', requireAuth, requirePermission('org.manage_devices'), (req, res) =>
    goApiProxySafe(req, res, 'delete', () => orgDeviceApiPath(req.params.id, req.params.did)));

// Settings
router.get('/api/panel/org/:id/settings', requireAuth, (req, res) =>
    goApiProxySafe(req, res, 'get', () => orgApiPath(req.params.id, '/settings')));
router.put('/api/panel/org/:id/settings', requireAuth, requirePermission('org.edit'), (req, res) =>
    goApiProxySafe(req, res, 'put', () => orgApiPath(req.params.id, '/settings'), req.body));

// Shared organization address book (Issue #190)
router.get('/api/panel/org/:id/address-book', requireAuth, (req, res) =>
    goApiProxySafe(req, res, 'get', () => orgApiPath(req.params.id, '/address-book')));
router.put('/api/panel/org/:id/address-book', requireAuth, requirePermission('org.edit'), (req, res) =>
    goApiProxySafe(req, res, 'put', () => orgApiPath(req.params.id, '/address-book'), req.body));

/**
 * GET /api/panel/org/:id/device-groups
 * Device and user groups linked to this organization (team_id = org id).
 */
router.get('/api/panel/org/:id/device-groups', requireAuth, async (req, res) => {
    try {
        const orgId = assertSafeApiId(req.params.id, 'orgId');
        const devices = await serverBackend.getAllDevices({});
        const allGroups = (await db.getAllDeviceGroups())
            .filter(group => deviceGroupService.folderIdFromGroupGuid(group.guid) === null)
            .filter(group => String(group.team_id || '').trim() === orgId);

        const deviceGroups = await deviceGroupService.enrichGroups(db, allGroups, devices);
        const userGroups = (await db.getAllUserGroups())
            .filter(group => String(group.team_id || '').trim() === orgId)
            .map(group => ({
                guid: group.guid,
                name: group.name,
                note: group.note || '',
                member_count: group.member_count || 0
            }));

        res.json({
            org_id: orgId,
            device_groups: deviceGroups,
            user_groups: userGroups
        });
    } catch (err) {
        if (err.message && /^Invalid /.test(err.message)) {
            return res.status(400).json({ error: err.message });
        }
        console.error('[org] List org device groups error:', err);
        res.status(500).json({ error: 'Failed to load organization groups' });
    }
});

module.exports = router;
