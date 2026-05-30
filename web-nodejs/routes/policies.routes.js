/**
 * BetterDesk Console — Organization Policy Management Routes (v3.0.0)
 *
 * Provides policy CRUD for organizations + device-facing policy fetch
 * + device attestation management.
 *
 * Page routes:
 *   GET /policies                          — Policy management page
 *   GET /policies/:orgId                   — Org-specific policies
 *   GET /attestation                       — Device attestation dashboard
 *
 * API routes (proxy to Go server /api/org/{id}/policy):
 *   GET    /api/panel/policies/:orgId              — Get all policies for org
 *   PUT    /api/panel/policies/:orgId/connection    — Set connection policy
 *   PUT    /api/panel/policies/:orgId/features      — Set feature policy
 *   PUT    /api/panel/policies/:orgId/security      — Set security policy
 *   PUT    /api/panel/policies/:orgId/network       — Set network policy
 *   PUT    /api/panel/policies/:orgId/update        — Set update policy
 *   GET    /api/panel/policies/:orgId/effective/:deviceId — Get merged policy
 *   GET    /api/panel/policies/:orgId/audit         — Policy change audit log
 *
 * Device-facing:
 *   GET    /api/bd/device-policy                    — Agent fetches its policy
 *
 * Attestation:
 *   GET    /api/panel/attestation                   — List attestation records
 *   GET    /api/panel/attestation/:deviceId         — Get device attestation
 *   POST   /api/bd/attestation                      — Agent reports attestation
 */

'use strict';

const express = require('express');
const router = express.Router();
const { apiClient } = require('../services/betterdeskApi');
const { requireAuth, requireAdmin } = require('../middleware/auth');

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
        // If Go server returns 404 for policy routes, return empty defaults
        // so the page works gracefully (common when Go binary is outdated).
        if (status === 404 && method === 'get' && path.endsWith('/policy')) {
            console.warn('[Policies] Go server returned 404 for %s — returning empty defaults. Rebuild Go binary.', path);
            return res.json({});
        }
        res.status(status).json(data);
    }
}

// ---------------------------------------------------------------------------
//  Page routes
// ---------------------------------------------------------------------------

router.get('/policies', requireAuth, requireAdmin, (req, res) => {
    res.render('policies', {
        title: 'Organization Policies',
        user: req.session.user,
        currentPage: 'policies',
    });
});

router.get('/policies/:orgId', requireAuth, requireAdmin, (req, res) => {
    res.render('policies', {
        title: 'Organization Policies',
        user: req.session.user,
        currentPage: 'policies',
        orgId: req.params.orgId,
    });
});

router.get('/attestation', requireAuth, requireAdmin, (req, res) => {
    res.render('attestation', {
        title: 'Device Attestation',
        user: req.session.user,
        currentPage: 'attestation',
    });
});

// ---------------------------------------------------------------------------
//  API routes — Policy management (admin panel)
// ---------------------------------------------------------------------------

// Get all policies for organization
router.get('/api/panel/policies/:orgId', requireAuth, (req, res) =>
    goApiProxy(req, res, 'get', `/org/${req.params.orgId}/policy`));

// Set connection policy
router.put('/api/panel/policies/:orgId/connection', requireAdmin, (req, res) =>
    goApiProxy(req, res, 'put', `/org/${req.params.orgId}/policy/connection`, req.body));

// Set feature policy
router.put('/api/panel/policies/:orgId/features', requireAdmin, (req, res) =>
    goApiProxy(req, res, 'put', `/org/${req.params.orgId}/policy/features`, req.body));

// Set security policy
router.put('/api/panel/policies/:orgId/security', requireAdmin, (req, res) =>
    goApiProxy(req, res, 'put', `/org/${req.params.orgId}/policy/security`, req.body));

// Set network policy
router.put('/api/panel/policies/:orgId/network', requireAdmin, (req, res) =>
    goApiProxy(req, res, 'put', `/org/${req.params.orgId}/policy/network`, req.body));

// Set update policy
router.put('/api/panel/policies/:orgId/update', requireAdmin, (req, res) =>
    goApiProxy(req, res, 'put', `/org/${req.params.orgId}/policy/update`, req.body));

// Get effective (merged) policy for a device
router.get('/api/panel/policies/:orgId/effective/:deviceId', requireAuth, (req, res) =>
    goApiProxy(req, res, 'get', `/org/${req.params.orgId}/policy/effective/${req.params.deviceId}`));

// Policy audit log
router.get('/api/panel/policies/:orgId/audit', requireAuth, (req, res) =>
    goApiProxy(req, res, 'get', `/org/${req.params.orgId}/policy/audit`));

// ---------------------------------------------------------------------------
//  Device-facing: agent fetches its policy
// ---------------------------------------------------------------------------

router.get('/api/bd/device-policy', async (req, res) => {
    const deviceId = req.query.device_id || req.headers['x-device-id'];
    if (!deviceId) {
        return res.status(400).json({ error: 'device_id required' });
    }
    try {
        const resp = await apiClient({ method: 'get', url: `/peers/${deviceId}/policy` });
        res.json(resp.data);
    } catch (err) {
        const status = err.response?.status || 500;
        res.status(status).json(err.response?.data || { error: 'Policy fetch failed' });
    }
});

// ---------------------------------------------------------------------------
//  Attestation routes
// ---------------------------------------------------------------------------

// List attestation records
// NOTE: Go server does not have /attestation endpoint yet — return empty data gracefully
router.get('/api/panel/attestation', requireAuth, requireAdmin, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    try {
        const resp = await apiClient({ method: 'get', url: `/attestation?limit=${limit}&offset=${offset}` });
        res.json(resp.data);
    } catch (err) {
        // Go server doesn't have attestation endpoint — return empty records
        if (err.response?.status === 404 || err.code === 'ECONNREFUSED') {
            return res.json({ records: [], total: 0 });
        }
        const status = err.response?.status || 500;
        res.status(status).json(err.response?.data || { error: 'Attestation fetch failed' });
    }
});

// Get attestation for specific device
router.get('/api/panel/attestation/:deviceId', requireAuth, async (req, res) => {
    try {
        const resp = await apiClient({ method: 'get', url: `/attestation/${req.params.deviceId}` });
        res.json(resp.data);
    } catch (err) {
        if (err.response?.status === 404 || err.code === 'ECONNREFUSED') {
            return res.json({ status: 'unknown', device_id: req.params.deviceId });
        }
        const status = err.response?.status || 500;
        res.status(status).json(err.response?.data || { error: 'Attestation fetch failed' });
    }
});

// Device reports attestation data
router.post('/api/bd/attestation', async (req, res) => {
    const { device_id, fingerprint, platform_data } = req.body;
    if (!device_id || !fingerprint) {
        return res.status(400).json({ error: 'device_id and fingerprint required' });
    }
    try {
        const resp = await apiClient({
            method: 'post',
            url: `/peers/${device_id}/attestation`,
            data: { fingerprint, platform_data }
        });
        res.json(resp.data);
    } catch (err) {
        const status = err.response?.status || 500;
        res.status(status).json(err.response?.data || { error: 'Attestation report failed' });
    }
});

module.exports = router;
