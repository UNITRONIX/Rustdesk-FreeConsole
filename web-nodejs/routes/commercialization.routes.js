'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const { apiClient } = require('../services/betterdeskApi');

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

async function goApiBinaryProxy(req, res, method, path) {
    try {
        const resp = await apiClient({
            method,
            url: path,
            responseType: 'arraybuffer'
        });
        const ct = resp.headers['content-type'];
        const cd = resp.headers['content-disposition'];
        if (ct) res.set('Content-Type', ct);
        if (cd) res.set('Content-Disposition', cd);
        res.status(resp.status).send(Buffer.from(resp.data));
    } catch (err) {
        const status = err.response?.status || 500;
        if (err.response?.data) {
            try {
                const text = Buffer.from(err.response.data).toString('utf8');
                const json = JSON.parse(text);
                return res.status(status).json(json);
            } catch (_) { /* fall through */ }
        }
        res.status(status).json({ error: 'Go server unreachable' });
    }
}

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
    goApiProxy(req, res, 'GET', '/timesync/status');
});

router.post('/api/panel/billing/timesync/check', requireAuth, requirePermission('server.config'), (req, res) => {
    goApiProxy(req, res, 'POST', '/timesync/check');
});

router.get('/api/panel/billing/packages', requireAuth, requirePermission('billing.view'), (req, res) => {
    goApiProxy(req, res, 'GET', '/billing/packages');
});

router.post('/api/panel/billing/packages', requireAuth, requirePermission('billing.manage'), (req, res) => {
    goApiProxy(req, res, 'POST', '/billing/packages', req.body);
});

router.put('/api/panel/billing/packages/:id', requireAuth, requirePermission('billing.manage'), (req, res) => {
    goApiProxy(req, res, 'PUT', `/billing/packages/${encodeURIComponent(req.params.id)}`, req.body);
});

router.delete('/api/panel/billing/packages/:id', requireAuth, requirePermission('billing.manage'), (req, res) => {
    goApiProxy(req, res, 'DELETE', `/billing/packages/${encodeURIComponent(req.params.id)}`);
});

router.get('/api/panel/billing/contracts', requireAuth, requirePermission('billing.view'), (req, res) => {
    const q = new URLSearchParams(req.query).toString();
    goApiProxy(req, res, 'GET', `/billing/contracts${q ? '?' + q : ''}`);
});

router.post('/api/panel/billing/contracts', requireAuth, requirePermission('billing.manage'), (req, res) => {
    goApiProxy(req, res, 'POST', '/billing/contracts', req.body);
});

router.put('/api/panel/billing/contracts/:id', requireAuth, requirePermission('billing.manage'), (req, res) => {
    goApiProxy(req, res, 'PUT', `/billing/contracts/${encodeURIComponent(req.params.id)}`, req.body);
});

router.get('/api/panel/billing/sessions', requireAuth, requirePermission('billing.view'), (req, res) => {
    const q = new URLSearchParams(req.query).toString();
    goApiProxy(req, res, 'GET', `/billing/sessions${q ? '?' + q : ''}`);
});

router.get('/api/panel/billing/sessions/pending', requireAuth, requirePermission('billing.reports'), (req, res) => {
    const q = new URLSearchParams(req.query).toString();
    goApiProxy(req, res, 'GET', `/billing/sessions/pending${q ? '?' + q : ''}`);
});

router.get('/api/panel/billing/sessions/export', requireAuth, requirePermission('billing.export'), (req, res) => {
    const q = new URLSearchParams(req.query).toString();
    goApiBinaryProxy(req, res, 'GET', `/billing/sessions/export${q ? '?' + q : ''}`);
});

router.get('/api/panel/billing/reports', requireAuth, requirePermission('billing.view'), (req, res) => {
    const q = new URLSearchParams(req.query).toString();
    goApiProxy(req, res, 'GET', `/billing/reports${q ? '?' + q : ''}`);
});

router.get('/api/panel/billing/reports/export', requireAuth, requirePermission('billing.export'), (req, res) => {
    const q = new URLSearchParams(req.query).toString();
    goApiBinaryProxy(req, res, 'GET', `/billing/reports/export${q ? '?' + q : ''}`);
});

router.post('/api/panel/billing/sessions/:id/report', requireAuth, requirePermission('billing.reports'), (req, res) => {
    goApiProxy(req, res, 'POST', `/billing/sessions/${encodeURIComponent(req.params.id)}/report`, req.body);
});

router.get('/api/panel/billing/currencies', requireAuth, requirePermission('billing.view'), (req, res) => {
    goApiProxy(req, res, 'GET', '/billing/currencies');
});

router.put('/api/panel/billing/currencies/:code', requireAuth, requirePermission('billing.manage'), (req, res) => {
    goApiProxy(req, res, 'PUT', `/billing/currencies/${encodeURIComponent(req.params.code)}`, req.body);
});

module.exports = router;
