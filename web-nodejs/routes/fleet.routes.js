'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const { apiClient } = require('../services/betterdeskApi');
const { proxyToGo, safeSegment, assertSafeApiId } = require('../lib/goApiProxy');
const { requireDeviceToken, requireTokenDeviceMatch } = require('../middleware/deviceAuth');

// ---------------------------------------------------------------------------
// Page routes
// ---------------------------------------------------------------------------

router.get('/fleet', requireAuth, requirePermission('org.manage_devices'), (req, res) => {
    const tab = req.query.tab || 'resources';
    res.render('fleet', {
        title: req.t('fleet.title'),
        pageStyles: ['fleet'],
        pageScripts: ['fleet', 'fleet-builder'],
        currentPage: 'fleet',
        breadcrumb: [{ label: req.t('fleet.title') }],
        activeTab: tab
    });
});

// ---------------------------------------------------------------------------
// Resource Mapping API
// ---------------------------------------------------------------------------

router.get('/api/panel/fleet/resources/:orgId', requireAuth, requirePermission('org.manage_devices'), (req, res) => {
    proxyToGo(apiClient, req, res, 'GET', () => `/fleet/resources/${safeSegment(req.params.orgId, 'orgId')}`);
});

router.post('/api/panel/fleet/resources/:orgId', requireAuth, requirePermission('org.manage_devices'), (req, res) => {
    proxyToGo(apiClient, req, res, 'POST', () => `/fleet/resources/${safeSegment(req.params.orgId, 'orgId')}`, req.body);
});

router.put('/api/panel/fleet/resources/:orgId/:resourceId', requireAuth, requirePermission('org.manage_devices'), (req, res) => {
    proxyToGo(apiClient, req, res, 'PUT', () =>
        `/fleet/resources/${safeSegment(req.params.orgId, 'orgId')}/${safeSegment(req.params.resourceId, 'resourceId')}`, req.body);
});

router.delete('/api/panel/fleet/resources/:orgId/:resourceId', requireAuth, requirePermission('org.manage_devices'), (req, res) => {
    proxyToGo(apiClient, req, res, 'DELETE', () =>
        `/fleet/resources/${safeSegment(req.params.orgId, 'orgId')}/${safeSegment(req.params.resourceId, 'resourceId')}`);
});

// ---------------------------------------------------------------------------
// Task Scheduler API
// ---------------------------------------------------------------------------

router.get('/api/panel/fleet/tasks', requireAuth, requirePermission('org.manage_devices'), (req, res) => {
    try {
        const qs = new URLSearchParams();
        if (req.query.orgId) qs.set('org_id', assertSafeApiId(req.query.orgId, 'orgId'));
        if (req.query.status) qs.set('status', String(req.query.status).slice(0, 64));
        if (req.query.deviceId) qs.set('device_id', assertSafeApiId(req.query.deviceId, 'deviceId'));
        const q = qs.toString();
        proxyToGo(apiClient, req, res, 'GET', () => `/fleet/tasks${q ? `?${q}` : ''}`);
    } catch (err) {
        if (err.message && /^Invalid /.test(err.message)) {
            return res.status(400).json({ error: err.message });
        }
        throw err;
    }
});

router.get('/api/panel/fleet/tasks/:taskId', requireAuth, requirePermission('org.manage_devices'), (req, res) => {
    proxyToGo(apiClient, req, res, 'GET', () => `/fleet/tasks/${safeSegment(req.params.taskId, 'taskId')}`);
});

router.post('/api/panel/fleet/tasks', requireAuth, requirePermission('org.manage_devices'), (req, res) => {
    proxyToGo(apiClient, req, res, 'POST', '/fleet/tasks', {
        ...req.body,
        created_by: req.session.user?.username || 'admin'
    });
});

router.put('/api/panel/fleet/tasks/:taskId', requireAuth, requirePermission('org.manage_devices'), (req, res) => {
    proxyToGo(apiClient, req, res, 'PUT', () => `/fleet/tasks/${safeSegment(req.params.taskId, 'taskId')}`, req.body);
});

router.delete('/api/panel/fleet/tasks/:taskId', requireAuth, requirePermission('org.manage_devices'), (req, res) => {
    proxyToGo(apiClient, req, res, 'DELETE', () => `/fleet/tasks/${safeSegment(req.params.taskId, 'taskId')}`);
});

router.get('/api/panel/fleet/tasks/:taskId/output', requireAuth, requirePermission('org.manage_devices'), (req, res) => {
    proxyToGo(apiClient, req, res, 'GET', () => `/fleet/tasks/${safeSegment(req.params.taskId, 'taskId')}/output`);
});

router.post('/api/panel/fleet/tasks/:taskId/retry', requireAuth, requirePermission('org.manage_devices'), (req, res) => {
    proxyToGo(apiClient, req, res, 'POST', () => `/fleet/tasks/${safeSegment(req.params.taskId, 'taskId')}/retry`);
});

// ---------------------------------------------------------------------------
// Workflow / Visual Builder API
// ---------------------------------------------------------------------------

router.get('/api/panel/fleet/workflows', requireAuth, requirePermission('org.manage_devices'), (req, res) => {
    proxyToGo(apiClient, req, res, 'GET', '/fleet/workflows');
});

router.get('/api/panel/fleet/workflows/:workflowId', requireAuth, requirePermission('org.manage_devices'), (req, res) => {
    proxyToGo(apiClient, req, res, 'GET', () => `/fleet/workflows/${safeSegment(req.params.workflowId, 'workflowId')}`);
});

router.post('/api/panel/fleet/workflows', requireAuth, requirePermission('org.manage_devices'), (req, res) => {
    proxyToGo(apiClient, req, res, 'POST', '/fleet/workflows', {
        ...req.body,
        created_by: req.session.user?.username || 'admin'
    });
});

router.put('/api/panel/fleet/workflows/:workflowId', requireAuth, requirePermission('org.manage_devices'), (req, res) => {
    proxyToGo(apiClient, req, res, 'PUT', () => `/fleet/workflows/${safeSegment(req.params.workflowId, 'workflowId')}`, req.body);
});

router.delete('/api/panel/fleet/workflows/:workflowId', requireAuth, requirePermission('org.manage_devices'), (req, res) => {
    proxyToGo(apiClient, req, res, 'DELETE', () => `/fleet/workflows/${safeSegment(req.params.workflowId, 'workflowId')}`);
});

router.post('/api/panel/fleet/workflows/:workflowId/execute', requireAuth, requirePermission('org.manage_devices'), (req, res) => {
    proxyToGo(apiClient, req, res, 'POST', () => `/fleet/workflows/${safeSegment(req.params.workflowId, 'workflowId')}/execute`, req.body);
});

router.get('/api/panel/fleet/workflows/:workflowId/history', requireAuth, requirePermission('org.manage_devices'), (req, res) => {
    proxyToGo(apiClient, req, res, 'GET', () => `/fleet/workflows/${safeSegment(req.params.workflowId, 'workflowId')}/history`);
});

// ---------------------------------------------------------------------------
// Compliance API
// ---------------------------------------------------------------------------

router.get('/api/panel/fleet/compliance', requireAuth, requirePermission('org.manage_devices'), (req, res) => {
    try {
        const qs = new URLSearchParams();
        if (req.query.orgId) qs.set('org_id', assertSafeApiId(req.query.orgId, 'orgId'));
        const q = qs.toString();
        proxyToGo(apiClient, req, res, 'GET', () => `/fleet/compliance${q ? `?${q}` : ''}`);
    } catch (err) {
        if (err.message && /^Invalid /.test(err.message)) {
            return res.status(400).json({ error: err.message });
        }
        throw err;
    }
});

router.get('/api/panel/fleet/compliance/:deviceId', requireAuth, requirePermission('org.manage_devices'), (req, res) => {
    proxyToGo(apiClient, req, res, 'GET', () => `/fleet/compliance/${safeSegment(req.params.deviceId, 'deviceId')}`);
});

router.post('/api/panel/fleet/compliance/:deviceId/scan', requireAuth, requirePermission('org.manage_devices'), (req, res) => {
    proxyToGo(apiClient, req, res, 'POST', () => `/fleet/compliance/${safeSegment(req.params.deviceId, 'deviceId')}/scan`);
});

router.post('/api/panel/fleet/compliance/:deviceId/remediate', requireAuth, requirePermission('org.manage_devices'), (req, res) => {
    proxyToGo(apiClient, req, res, 'POST', () => `/fleet/compliance/${safeSegment(req.params.deviceId, 'deviceId')}/remediate`, req.body);
});

// ---------------------------------------------------------------------------
// Device-facing API (agents report back — body JSON, unchanged for compatibility)
// ---------------------------------------------------------------------------

router.post('/api/bd/fleet/task-result', requireDeviceToken, requireTokenDeviceMatch, (req, res) => {
    proxyToGo(apiClient, req, res, 'POST', '/fleet/task-result', req.body);
});

router.post('/api/bd/fleet/software', requireDeviceToken, requireTokenDeviceMatch, (req, res) => {
    proxyToGo(apiClient, req, res, 'POST', '/fleet/software', req.body);
});

module.exports = router;
