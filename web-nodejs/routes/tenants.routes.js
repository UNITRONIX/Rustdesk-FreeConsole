/**
 * BetterDesk Console — Multi-Tenancy API Routes
 *
 * Provides organization / tenant management for multi-client deployments.
 * Each tenant has its own set of devices, users, policies, and data
 * boundaries enforced at the API layer.
 *
 * Endpoints:
 *
 * Admin-facing (super-admin only):
 *   GET    /api/tenants               — List all tenants
 *   GET    /api/tenants/:id           — Get tenant details
 *   POST   /api/tenants               — Create tenant
 *   PATCH  /api/tenants/:id           — Update tenant
 *   DELETE /api/tenants/:id           — Delete tenant
 *   GET    /api/tenants/:id/devices   — List devices assigned to tenant
 *   POST   /api/tenants/:id/devices   — Assign device(s) to tenant
 *   DELETE /api/tenants/:id/devices/:deviceId — Remove device from tenant
 *   GET    /api/tenants/:id/users     — List users assigned to tenant
 *   POST   /api/tenants/:id/users     — Assign user to tenant
 *   DELETE /api/tenants/:id/users/:userId — Remove user from tenant
 *   GET    /api/tenants/:id/stats     — Tenant statistics
 *
 * @author  UNITRONIX
 * @version 1.0.0
 */

'use strict';

const express = require('express');
const router = express.Router();
const { getAdapter } = require('../services/dbAdapter');
const { isSuperAdminRole } = require('../middleware/auth');

// ---------------------------------------------------------------------------
//  Auth middleware
// ---------------------------------------------------------------------------

function requireSession(req, res, next) {
    if (req.session && req.session.user) return next();
    return res.status(401).json({ error: 'Authentication required' });
}

function requireAdmin(req, res, next) {
    const role = req.session && req.session.user && req.session.user.role;
    if (isSuperAdminRole(role) || role === 'global_admin') return next();
    return res.status(403).json({ error: 'Admin access required' });
}

// =========================================================================
//  Tenant CRUD
// =========================================================================

/**
 * GET /api/tenants
 */
router.get('/', requireAdmin, async (req, res) => {
    try {
        const db = getAdapter();
        const tenants = await db.getTenants();
        res.json(tenants);
    } catch (err) {
        console.error('[Tenants] GET / error:', err.message);
        res.status(500).json({ error: 'Failed to fetch tenants' });
    }
});

/**
 * GET /api/tenants/:id
 */
router.get('/:id', requireAdmin, async (req, res) => {
    try {
        const db = getAdapter();
        const tenant = await db.getTenantById(Number(req.params.id));
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
        res.json(tenant);
    } catch (err) {
        console.error('[Tenants] GET /:id error:', err.message);
        res.status(500).json({ error: 'Failed to fetch tenant' });
    }
});

/**
 * POST /api/tenants
 * Body: { name, slug?, contact_name?, contact_email?, max_devices?, notes? }
 */
router.post('/', requireAdmin, async (req, res) => {
    try {
        const { name, slug, contact_name, contact_email, max_devices, notes } = req.body;
        if (!name || typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ error: 'Tenant name is required' });
        }
        const db = getAdapter();
        const tenant = await db.createTenant({
            name: name.trim(),
            slug: slug || name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
            contact_name: contact_name || '',
            contact_email: contact_email || '',
            max_devices: max_devices || 0,
            notes: notes || '',
        });
        res.status(201).json(tenant);
    } catch (err) {
        console.error('[Tenants] POST / error:', err.message);
        if (err.message && err.message.includes('UNIQUE')) {
            return res.status(409).json({ error: 'Tenant slug already exists' });
        }
        res.status(500).json({ error: 'Failed to create tenant' });
    }
});

/**
 * PATCH /api/tenants/:id
 */
router.patch('/:id', requireAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const db = getAdapter();
        const existing = await db.getTenantById(id);
        if (!existing) return res.status(404).json({ error: 'Tenant not found' });
        const updated = await db.updateTenant(id, req.body);
        res.json(updated);
    } catch (err) {
        console.error('[Tenants] PATCH /:id error:', err.message);
        res.status(500).json({ error: 'Failed to update tenant' });
    }
});

/**
 * DELETE /api/tenants/:id
 */
router.delete('/:id', requireAdmin, async (req, res) => {
    try {
        const db = getAdapter();
        const ok = await db.deleteTenant(Number(req.params.id));
        if (!ok) return res.status(404).json({ error: 'Tenant not found' });
        res.json({ ok: true });
    } catch (err) {
        console.error('[Tenants] DELETE /:id error:', err.message);
        res.status(500).json({ error: 'Failed to delete tenant' });
    }
});

// =========================================================================
//  Tenant ↔ Device assignments
// =========================================================================

/**
 * GET /api/tenants/:id/devices
 */
router.get('/:id/devices', requireAdmin, async (req, res) => {
    try {
        const db = getAdapter();
        const devices = await db.getTenantDevices(Number(req.params.id));
        res.json(devices);
    } catch (err) {
        console.error('[Tenants] GET /:id/devices error:', err.message);
        res.status(500).json({ error: 'Failed to fetch tenant devices' });
    }
});

/**
 * POST /api/tenants/:id/devices
 * Body: { device_id } or { device_ids: [...] }
 */
router.post('/:id/devices', requireAdmin, async (req, res) => {
    try {
        const tenantId = Number(req.params.id);
        const db = getAdapter();
        const tenant = await db.getTenantById(tenantId);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

        const ids = req.body.device_ids || (req.body.device_id ? [req.body.device_id] : []);
        if (ids.length === 0) return res.status(400).json({ error: 'device_id or device_ids required' });

        let assigned = 0;
        for (const did of ids) {
            const ok = await db.assignDeviceToTenant(tenantId, did);
            if (ok) assigned++;
        }
        res.json({ ok: true, assigned });
    } catch (err) {
        console.error('[Tenants] POST /:id/devices error:', err.message);
        res.status(500).json({ error: 'Failed to assign devices' });
    }
});

/**
 * DELETE /api/tenants/:id/devices/:deviceId
 */
router.delete('/:id/devices/:deviceId', requireAdmin, async (req, res) => {
    try {
        const db = getAdapter();
        const ok = await db.removeDeviceFromTenant(Number(req.params.id), req.params.deviceId);
        if (!ok) return res.status(404).json({ error: 'Assignment not found' });
        res.json({ ok: true });
    } catch (err) {
        console.error('[Tenants] DELETE /:id/devices/:deviceId error:', err.message);
        res.status(500).json({ error: 'Failed to remove device' });
    }
});

// =========================================================================
//  Tenant ↔ User assignments
// =========================================================================

/**
 * GET /api/tenants/:id/users
 */
router.get('/:id/users', requireAdmin, async (req, res) => {
    try {
        const db = getAdapter();
        const users = await db.getTenantUsers(Number(req.params.id));
        res.json(users);
    } catch (err) {
        console.error('[Tenants] GET /:id/users error:', err.message);
        res.status(500).json({ error: 'Failed to fetch tenant users' });
    }
});

/**
 * POST /api/tenants/:id/users
 * Body: { user_id }
 */
router.post('/:id/users', requireAdmin, async (req, res) => {
    try {
        const tenantId = Number(req.params.id);
        const { user_id } = req.body;
        if (!user_id) return res.status(400).json({ error: 'user_id required' });

        const db = getAdapter();
        const ok = await db.assignUserToTenant(tenantId, Number(user_id));
        res.json({ ok: !!ok });
    } catch (err) {
        console.error('[Tenants] POST /:id/users error:', err.message);
        res.status(500).json({ error: 'Failed to assign user' });
    }
});

/**
 * DELETE /api/tenants/:id/users/:userId
 */
router.delete('/:id/users/:userId', requireAdmin, async (req, res) => {
    try {
        const db = getAdapter();
        const ok = await db.removeUserFromTenant(Number(req.params.id), Number(req.params.userId));
        if (!ok) return res.status(404).json({ error: 'Assignment not found' });
        res.json({ ok: true });
    } catch (err) {
        console.error('[Tenants] DELETE /:id/users/:userId error:', err.message);
        res.status(500).json({ error: 'Failed to remove user' });
    }
});

// =========================================================================
//  Tenant stats
// =========================================================================

/**
 * GET /api/tenants/:id/stats
 */
router.get('/:id/stats', requireAdmin, async (req, res) => {
    try {
        const tenantId = Number(req.params.id);
        const db = getAdapter();
        const tenant = await db.getTenantById(tenantId);
        if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

        const devices = await db.getTenantDevices(tenantId);
        const users = await db.getTenantUsers(tenantId);
        const onlineCount = devices.filter(d => d.online || d.status_online === 1 || d.status_online === true).length;

        res.json({
            tenant_id: tenantId,
            tenant_name: tenant.name,
            total_devices: devices.length,
            online_devices: onlineCount,
            total_users: users.length,
            max_devices: tenant.max_devices || 0,
        });
    } catch (err) {
        console.error('[Tenants] GET /:id/stats error:', err.message);
        res.status(500).json({ error: 'Failed to fetch tenant stats' });
    }
});

module.exports = router;
