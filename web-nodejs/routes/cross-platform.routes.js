'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const { apiClient } = require('../services/betterdeskApi');
const { proxyToGo, safeSegment } = require('../lib/goApiProxy');

// ---------------------------------------------------------------------------
// Page route
// ---------------------------------------------------------------------------
router.get('/cross-platform', requireAuth, requirePermission('device.view'), (req, res) => {
    const tab = req.query.tab || 'matrix';
    res.render('cross-platform', {
        title: req.t('cross_platform.title'),
        pageStyles: ['cross-platform'],
        pageScripts: ['cross-platform'],
        currentPage: 'cross-platform',
        breadcrumb: [{ label: req.t('cross_platform.title') }],
        activeTab: tab
    });
});

// ---------------------------------------------------------------------------
// Platform Distribution — aggregate from Go server peers
// ---------------------------------------------------------------------------
router.get('/api/panel/cross-platform/distribution', requireAuth, requirePermission('device.view'), async (req, res) => {
    try {
        const resp = await apiClient({ method: 'GET', url: '/peers?page_size=9999' });
        const peers = resp.data?.peers || resp.data?.data || [];

        const platforms = {};
        const archs = {};
        const versions = {};
        let total = 0;

        for (const p of peers) {
            total++;
            const plat = (p.platform || p.os || 'Unknown').toLowerCase();
            const arch = (p.arch || 'unknown').toLowerCase();
            const ver = p.version || 'unknown';

            // Normalize platform names
            let key = 'other';
            if (plat.includes('windows')) key = 'windows';
            else if (plat.includes('linux')) key = 'linux';
            else if (plat.includes('mac') || plat.includes('darwin')) key = 'macos';
            else if (plat.includes('android')) key = 'android';
            else if (plat.includes('ios') || plat.includes('iphone') || plat.includes('ipad')) key = 'ios';
            else if (plat.includes('chrome')) key = 'chromeos';
            else if (plat !== 'unknown') key = plat;

            platforms[key] = (platforms[key] || 0) + 1;
            archs[arch] = (archs[arch] || 0) + 1;
            versions[ver] = (versions[ver] || 0) + 1;
        }

        res.json({ total, platforms, archs, versions });
    } catch (err) {
        const status = err.response?.status || 500;
        res.status(status).json({ error: 'Failed to fetch platform data' });
    }
});

// ---------------------------------------------------------------------------
// Capability report for a specific device
// ---------------------------------------------------------------------------
router.get('/api/panel/cross-platform/capabilities/:deviceId', requireAuth, requirePermission('device.view'), (req, res) => {
    // deviceId is a RustDesk peer ID (numeric string) — safeSegment accepts [a-zA-Z0-9_-]
    proxyToGo(apiClient, req, res, 'GET', () => `/peers/${safeSegment(req.params.deviceId, 'deviceId')}`);
});

// ---------------------------------------------------------------------------
// Protocol negotiation status — aggregate connected peer capabilities
// ---------------------------------------------------------------------------
router.get('/api/panel/cross-platform/protocols', requireAuth, requirePermission('device.view'), async (req, res) => {
    try {
        const resp = await apiClient({ method: 'GET', url: '/peers?page_size=9999' });
        const peers = resp.data?.peers || resp.data?.data || [];

        const codecs = {};
        const features = {};
        let totalOnline = 0;

        for (const p of peers) {
            if (!p.live_online && p.status !== 'ONLINE') continue;
            totalOnline++;

            if (p.supported_codecs) {
                for (const c of (Array.isArray(p.supported_codecs) ? p.supported_codecs : [p.supported_codecs])) {
                    codecs[c] = (codecs[c] || 0) + 1;
                }
            }
            if (p.supported_features) {
                for (const f of (Array.isArray(p.supported_features) ? p.supported_features : [p.supported_features])) {
                    features[f] = (features[f] || 0) + 1;
                }
            }
        }

        res.json({ totalOnline, codecs, features });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch protocol data' });
    }
});

module.exports = router;
