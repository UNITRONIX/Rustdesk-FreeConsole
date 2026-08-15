/**
 * BetterDesk Console — DataGuard / DLP API Routes
 *
 * Manages Data Loss Prevention policies for USB device control and
 * file-operation monitoring.  Desktop agents fetch policies and
 * report violations through the device-facing endpoints.
 *
 * Endpoints:
 *
 * Admin-facing (web console session):
 *   GET    /api/dataguard/policies      — List all DLP policies
 *   GET    /api/dataguard/policies/:id  — Get a single policy
 *   POST   /api/dataguard/policies      — Create a policy
 *   PATCH  /api/dataguard/policies/:id  — Update a policy
 *   DELETE /api/dataguard/policies/:id  — Delete a policy
 *   GET    /api/dataguard/events        — List DLP events (filterable)
 *   GET    /api/dataguard/stats         — Aggregated event statistics
 *
 * Device-facing (authenticated via X-Device-Id / token):
 *   GET    /api/bd/dlp-policies         — Fetch active policies for agent
 *   POST   /api/bd/dlp-events           — Report a DLP event (violation / info)
 *
 * @author  UNITRONIX
 * @version 1.0.0
 */

'use strict';

const express = require('express');
const router = express.Router();
const { getAdapter } = require('../services/dbAdapter');

const { requireAuth, requirePermission } = require('../middleware/auth');
const { requireDeviceToken } = require('../middleware/deviceAuth');

// ---------------------------------------------------------------------------
//  Auth middleware helpers
// ---------------------------------------------------------------------------

// =========================================================================
//  Admin-facing — Policy CRUD
// =========================================================================

/**
 * GET /api/dataguard/policies
 * Returns all DLP policies.
 */
router.get('/policies', requireAuth, requirePermission('device.view'), async (req, res) => {
    try {
        const db = getAdapter();
        const policies = await db.getDlpPolicies();
        // Parse rules from JSON string to object when needed
        const parsed = policies.map(p => ({
            ...p,
            rules: typeof p.rules === 'string' ? JSON.parse(p.rules) : (p.rules || []),
        }));
        res.json(parsed);
    } catch (err) {
        console.error('[DataGuard] GET /policies error:', err.message);
        res.status(500).json({ error: 'Failed to fetch policies' });
    }
});

/**
 * GET /api/dataguard/policies/:id
 */
router.get('/policies/:id', requireAuth, requirePermission('device.view'), async (req, res) => {
    try {
        const db = getAdapter();
        const policy = await db.getDlpPolicyById(Number(req.params.id));
        if (!policy) return res.status(404).json({ error: 'Policy not found' });
        policy.rules = typeof policy.rules === 'string' ? JSON.parse(policy.rules) : (policy.rules || []);
        res.json(policy);
    } catch (err) {
        console.error('[DataGuard] GET /policies/:id error:', err.message);
        res.status(500).json({ error: 'Failed to fetch policy' });
    }
});

/**
 * POST /api/dataguard/policies
 * Body: { name, description?, enabled?, rules? }
 * rules is an array of objects: [{ rule_type, action, filter }]
 */
router.post('/policies', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const { name, description, policy_type, action, scope, enabled, rules } = req.body;
        if (!name || typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ error: 'Policy name is required' });
        }
        // Validate rules array
        if (rules !== undefined && !Array.isArray(rules)) {
            return res.status(400).json({ error: 'rules must be an array' });
        }
        const db = getAdapter();
        const policy = await db.createDlpPolicy({ name: name.trim(), description, policy_type, action, scope, enabled, rules });
        if (policy) {
            policy.rules = typeof policy.rules === 'string' ? JSON.parse(policy.rules) : (policy.rules || []);
        }
        res.status(201).json(policy);
    } catch (err) {
        console.error('[DataGuard] POST /policies error:', err.message);
        res.status(500).json({ error: 'Failed to create policy' });
    }
});

/**
 * PATCH /api/dataguard/policies/:id
 */
router.patch('/policies/:id', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const db = getAdapter();
        const id = Number(req.params.id);
        const existing = await db.getDlpPolicyById(id);
        if (!existing) return res.status(404).json({ error: 'Policy not found' });

        const { name, description, policy_type, action, scope, enabled, rules } = req.body;
        if (rules !== undefined && !Array.isArray(rules)) {
            return res.status(400).json({ error: 'rules must be an array' });
        }
        const updated = await db.updateDlpPolicy(id, { name, description, policy_type, action, scope, enabled, rules });
        if (updated) {
            updated.rules = typeof updated.rules === 'string' ? JSON.parse(updated.rules) : (updated.rules || []);
        }
        res.json(updated);
    } catch (err) {
        console.error('[DataGuard] PATCH /policies/:id error:', err.message);
        res.status(500).json({ error: 'Failed to update policy' });
    }
});

/**
 * DELETE /api/dataguard/policies/:id
 */
router.delete('/policies/:id', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const db = getAdapter();
        const ok = await db.deleteDlpPolicy(Number(req.params.id));
        if (!ok) return res.status(404).json({ error: 'Policy not found' });
        res.json({ ok: true });
    } catch (err) {
        console.error('[DataGuard] DELETE /policies/:id error:', err.message);
        res.status(500).json({ error: 'Failed to delete policy' });
    }
});

// =========================================================================
//  Admin-facing — Events & Stats
// =========================================================================

/**
 * GET /api/dataguard/events?device_id=&event_source=usb|file&event_type=&limit=&from=&to=
 */
router.get('/events', requireAuth, requirePermission('audit.view'), async (req, res) => {
    try {
        const db = getAdapter();
        const { device_id, event_source, event_type, limit, from, to } = req.query;
        const events = await db.getDlpEvents({
            device_id,
            event_source,
            event_type,
            limit: limit ? Number(limit) : undefined,
            from,
            to,
        });
        // Parse details from JSON string when needed
        const parsed = events.map(e => ({
            ...e,
            details: typeof e.details === 'string' ? JSON.parse(e.details) : (e.details || {}),
        }));
        res.json(parsed);
    } catch (err) {
        console.error('[DataGuard] GET /events error:', err.message);
        res.status(500).json({ error: 'Failed to fetch events' });
    }
});

/**
 * GET /api/dataguard/stats
 */
router.get('/stats', requireAuth, requirePermission('audit.view'), async (req, res) => {
    try {
        const db = getAdapter();
        const stats = await db.getDlpEventStats();
        res.json(stats);
    } catch (err) {
        console.error('[DataGuard] GET /stats error:', err.message);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// =========================================================================
//  Device-facing — Policy sync & event reporting
// =========================================================================

/**
 * GET /dlp-policies
 * Returns only enabled policies for the requesting agent.
 * Mounted under /api/bd so full path is /api/bd/dlp-policies
 */
router.get('/dlp-policies', requireDeviceToken, async (req, res) => {
    try {
        const db = getAdapter();
        const policies = await db.getDlpPolicies();
        const active = policies
            .filter(p => {
                const enabled = typeof p.enabled === 'number' ? p.enabled === 1 : !!p.enabled;
                return enabled;
            })
            .map(p => ({
                id: p.id,
                name: p.name,
                rules: typeof p.rules === 'string' ? JSON.parse(p.rules) : (p.rules || []),
            }));
        res.json(active);
    } catch (err) {
        console.error('[DataGuard] GET /dlp-policies error:', err.message);
        res.status(500).json({ error: 'Failed to fetch policies' });
    }
});

/**
 * POST /dlp-events
 * Body: { event_source, event_type, policy_id?, policy_name?, action?, details? }
 * Mounted under /api/bd so full path is /api/bd/dlp-events
 */
router.post('/dlp-events', requireDeviceToken, async (req, res) => {
    try {
        const deviceId = req.deviceId || (req.session && req.session.user && req.session.user.username) || 'unknown';
        const { event_source, event_type, policy_id, policy_name, action, details } = req.body;

        if (!event_source || typeof event_source !== 'string') {
            return res.status(400).json({ error: 'event_source is required (usb | file)' });
        }

        const db = getAdapter();
        const result = await db.insertDlpEvent({
            device_id: deviceId,
            event_source,
            event_type: event_type || 'info',
            policy_id: policy_id || null,
            policy_name: policy_name || '',
            action: action || 'log',
            details: details || {},
        });

        res.status(201).json({ ok: true, id: result.id });
    } catch (err) {
        console.error('[DataGuard] POST /dlp-events error:', err.message);
        res.status(500).json({ error: 'Failed to record event' });
    }
});

module.exports = router;
