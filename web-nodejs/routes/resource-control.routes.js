'use strict';

const express = require('express');
const router = express.Router();
const { assertSafeApiId } = require('../lib/goApiPath');
const { requireAuth, requirePermission } = require('../middleware/auth');

let apiClient;
try {
    apiClient = require('../services/betterdeskApi').apiClient;
} catch (e) {
    apiClient = null;
}

async function goApiProxy(req, res, method, path, body) {
    try {
        if (!apiClient) {
            return res.status(503).json({ error: 'Go server API not available' });
        }
        const resp = await apiClient({ method, url: path, data: body });
        res.status(resp.status).json(resp.data);
    } catch (err) {
        const status = err.response?.status || 500;
        const data = err.response?.data || { error: 'Failed to reach Go server' };
        res.status(status).json(data);
    }
}

function deviceResourcePath(deviceId, suffix = '') {
    const id = assertSafeApiId(deviceId, 'deviceId');
    return `/devices/${encodeURIComponent(id)}/resources${suffix}`;
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

// --- Page Route ---

router.get('/resource-control', requireAuth, requirePermission('server.config'), (req, res) => {
    res.render('resource-control', {
        title: req.t('nav.resource_control'),
        pageStyles: ['resource-control'],
        pageScripts: ['resource-control'],
        currentPage: 'resource-control',
        breadcrumb: [{ label: req.t('nav.resource_control') }]
    });
});

// --- API Routes ---

/**
 * GET /api/panel/resource-control/devices — List devices with resource policy status
 */
router.get('/api/panel/resource-control/devices', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        if (!apiClient) {
            return res.json({ devices: [], total: 0 });
        }
        const resp = await apiClient.get('/peers', { params: { limit: 200 } });
        const peers = resp.data?.data || resp.data?.peers || resp.data || [];
        const devices = (Array.isArray(peers) ? peers : []).map(p => ({
            id: p.id,
            hostname: p.hostname || '',
            platform: p.platform || '',
            status: p.live_status || p.status || 'offline',
            device_type: p.device_type || '',
            tags: p.tags || ''
        }));
        res.json({ devices, total: devices.length });
    } catch (err) {
        res.json({ devices: [], total: 0 });
    }
});

/**
 * GET /api/panel/resource-control/policies/:deviceId — Get resource policy for a device
 */
router.get('/api/panel/resource-control/policies/:deviceId', requireAuth, requirePermission('server.config'), (req, res) => {
    goApiProxySafe(req, res, 'get', () => deviceResourcePath(req.params.deviceId));
});

/**
 * POST /api/panel/resource-control/policies/:deviceId/usb — Set USB policy
 */
router.post('/api/panel/resource-control/policies/:deviceId/usb', requireAuth, requirePermission('server.config'), (req, res) => {
    goApiProxySafe(req, res, 'post', () => deviceResourcePath(req.params.deviceId, '/usb'), req.body);
});

/**
 * POST /api/panel/resource-control/policies/:deviceId/optical — Set optical drive policy
 */
router.post('/api/panel/resource-control/policies/:deviceId/optical', requireAuth, requirePermission('server.config'), (req, res) => {
    goApiProxySafe(req, res, 'post', () => deviceResourcePath(req.params.deviceId, '/optical'), req.body);
});

/**
 * POST /api/panel/resource-control/policies/:deviceId/monitors — Set monitor policy
 */
router.post('/api/panel/resource-control/policies/:deviceId/monitors', requireAuth, requirePermission('server.config'), (req, res) => {
    goApiProxySafe(req, res, 'post', () => deviceResourcePath(req.params.deviceId, '/monitors'), req.body);
});

/**
 * POST /api/panel/resource-control/policies/:deviceId/disks — Set disk policy
 */
router.post('/api/panel/resource-control/policies/:deviceId/disks', requireAuth, requirePermission('server.config'), (req, res) => {
    goApiProxySafe(req, res, 'post', () => deviceResourcePath(req.params.deviceId, '/disks'), req.body);
});

/**
 * POST /api/panel/resource-control/policies/:deviceId/quotas — Set per-user quotas
 */
router.post('/api/panel/resource-control/policies/:deviceId/quotas', requireAuth, requirePermission('server.config'), (req, res) => {
    goApiProxySafe(req, res, 'post', () => deviceResourcePath(req.params.deviceId, '/quotas'), req.body);
});

/**
 * GET /api/panel/resource-control/compliance — Get compliance summary
 */
router.get('/api/panel/resource-control/compliance', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        if (!apiClient) {
            return res.json({
                total_devices: 0,
                compliant: 0,
                non_compliant: 0,
                no_policy: 0,
                compliance_rate: 0,
                categories: {
                    usb: { enforced: 0, total: 0 },
                    optical: { enforced: 0, total: 0 },
                    monitors: { enforced: 0, total: 0 },
                    disks: { enforced: 0, total: 0 },
                    quotas: { enforced: 0, total: 0 }
                }
            });
        }
        const resp = await apiClient.get('/org/default/resource-policy/compliance');
        res.json(resp.data);
    } catch (err) {
        res.json({
            total_devices: 0,
            compliant: 0,
            non_compliant: 0,
            no_policy: 0,
            compliance_rate: 0,
            categories: {
                usb: { enforced: 0, total: 0 },
                optical: { enforced: 0, total: 0 },
                monitors: { enforced: 0, total: 0 },
                disks: { enforced: 0, total: 0 },
                quotas: { enforced: 0, total: 0 }
            }
        });
    }
});

/**
 * GET /api/panel/resource-control/org-policy — Get org-wide default policy
 */
router.get('/api/panel/resource-control/org-policy', requireAuth, requirePermission('server.config'), (req, res) => {
    goApiProxy(req, res, 'get', '/org/default/resource-policy');
});

/**
 * PUT /api/panel/resource-control/org-policy — Update org-wide default policy
 */
router.put('/api/panel/resource-control/org-policy', requireAuth, requirePermission('server.config'), (req, res) => {
    goApiProxy(req, res, 'put', '/org/default/resource-policy', req.body);
});

// --- Device-facing API ---

/**
 * GET /api/bd/resource-policy — Agent fetches its resource policy
 */
router.get('/api/bd/resource-policy', async (req, res) => {
    const deviceId = req.headers['x-device-id'] || req.query.device_id;
    if (!deviceId) {
        return res.status(400).json({ error: 'Missing device_id' });
    }
    try {
        if (!apiClient) {
            return res.json({ policy: null });
        }
        const resp = await apiClient.get(deviceResourcePath(deviceId));
        res.json(resp.data);
    } catch (err) {
        if (err.message && /^Invalid /.test(err.message)) {
            return res.status(400).json({ error: err.message });
        }
        res.json({ policy: null });
    }
});

module.exports = router;
