'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const { apiClient } = require('../services/betterdeskApi');
const { proxyToGo, proxyBinaryToGo, safeSegment } = require('../lib/goApiProxy');

router.get('/commercialization', requireAuth, requirePermission('billing.view'), (req, res) => {
    const validTabs = ['overview', 'packages', 'sessions', 'reports', 'settings'];
    const tab = validTabs.includes(req.query.tab) ? req.query.tab : 'overview';
    const tabKey = `commercialization.tabs.${tab}`;
    res.render('commercialization', {
        title: req.t(tabKey),
        pageStyles: ['commercialization'],
        pageScripts: ['commercialization'],
        currentPage: 'commercialization',
        currentTab: tab,
        activeTab: tab,
        breadcrumb: [
            { label: req.t('commercialization.title') },
            { label: req.t(tabKey) }
        ],
        req
    });
});

router.get('/api/panel/billing/timesync/status', requireAuth, requirePermission('billing.view'), (req, res) => {
    proxyToGo(apiClient, req, res, 'GET', '/timesync/status');
});

router.post('/api/panel/billing/timesync/check', requireAuth, requirePermission('server.config'), (req, res) => {
    proxyToGo(apiClient, req, res, 'POST', '/timesync/check');
});

router.get('/api/panel/billing/packages', requireAuth, requirePermission('billing.view'), (req, res) => {
    proxyToGo(apiClient, req, res, 'GET', '/billing/packages');
});

router.post('/api/panel/billing/packages', requireAuth, requirePermission('billing.manage'), (req, res) => {
    proxyToGo(apiClient, req, res, 'POST', '/billing/packages', req.body);
});

router.put('/api/panel/billing/packages/:id', requireAuth, requirePermission('billing.manage'), (req, res) => {
    proxyToGo(apiClient, req, res, 'PUT', () => `/billing/packages/${safeSegment(req.params.id, 'packageId')}`, req.body);
});

router.delete('/api/panel/billing/packages/:id', requireAuth, requirePermission('billing.manage'), (req, res) => {
    proxyToGo(apiClient, req, res, 'DELETE', () => `/billing/packages/${safeSegment(req.params.id, 'packageId')}`);
});

router.get('/api/panel/billing/contracts', requireAuth, requirePermission('billing.view'), (req, res) => {
    const q = new URLSearchParams(req.query).toString();
    proxyToGo(apiClient, req, res, 'GET', () => `/billing/contracts${q ? `?${q}` : ''}`);
});

router.post('/api/panel/billing/contracts', requireAuth, requirePermission('billing.manage'), (req, res) => {
    proxyToGo(apiClient, req, res, 'POST', '/billing/contracts', req.body);
});

router.put('/api/panel/billing/contracts/:id', requireAuth, requirePermission('billing.manage'), (req, res) => {
    proxyToGo(apiClient, req, res, 'PUT', () => `/billing/contracts/${safeSegment(req.params.id, 'contractId')}`, req.body);
});

router.get('/api/panel/billing/sessions', requireAuth, requirePermission('billing.view'), (req, res) => {
    const q = new URLSearchParams(req.query).toString();
    proxyToGo(apiClient, req, res, 'GET', () => `/billing/sessions${q ? `?${q}` : ''}`);
});

router.get('/api/panel/billing/sessions/pending', requireAuth, requirePermission('billing.reports'), (req, res) => {
    const q = new URLSearchParams(req.query).toString();
    proxyToGo(apiClient, req, res, 'GET', () => `/billing/sessions/pending${q ? `?${q}` : ''}`);
});

router.get('/api/panel/billing/sessions/export', requireAuth, requirePermission('billing.export'), (req, res) => {
    const q = new URLSearchParams(req.query).toString();
    proxyBinaryToGo(apiClient, req, res, 'GET', () => `/billing/sessions/export${q ? `?${q}` : ''}`);
});

router.get('/api/panel/billing/reports', requireAuth, requirePermission('billing.view'), (req, res) => {
    const q = new URLSearchParams(req.query).toString();
    proxyToGo(apiClient, req, res, 'GET', () => `/billing/reports${q ? `?${q}` : ''}`);
});

router.get('/api/panel/billing/reports/export', requireAuth, requirePermission('billing.export'), (req, res) => {
    const q = new URLSearchParams(req.query).toString();
    proxyBinaryToGo(apiClient, req, res, 'GET', () => `/billing/reports/export${q ? `?${q}` : ''}`);
});

router.post('/api/panel/billing/sessions/:id/report', requireAuth, requirePermission('billing.reports'), (req, res) => {
    proxyToGo(apiClient, req, res, 'POST', () => `/billing/sessions/${safeSegment(req.params.id, 'sessionId')}/report`, req.body);
});

router.get('/api/panel/billing/currencies', requireAuth, requirePermission('billing.view'), (req, res) => {
    proxyToGo(apiClient, req, res, 'GET', '/billing/currencies');
});

router.put('/api/panel/billing/currencies/:code', requireAuth, requirePermission('billing.manage'), (req, res) => {
    proxyToGo(apiClient, req, res, 'PUT', () => `/billing/currencies/${safeSegment(req.params.code, 'currencyCode')}`, req.body);
});

module.exports = router;
