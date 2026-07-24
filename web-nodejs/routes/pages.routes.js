/**
 * BetterDesk Console — Page Render Routes
 *
 * Serves HTML pages for management modules. API endpoints are in separate route files.
 *
 * @module routes/pages.routes
 */

'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission, requireRole } = require('../middleware/auth');

// ── Inventory ──

router.get('/inventory', requireAuth, (req, res) => {
    res.render('inventory', {
        title: req.t('inventory.title'),
        activePage: 'inventory',
    });
});

// ── Tickets (Helpdesk) ──

router.get('/tickets', requireAuth, (req, res) => {
    res.render('tickets', {
        title: req.t('tickets.title'),
        activePage: 'tickets',
    });
});

// ── Automation (Alerts + Remote Commands) ──

router.get('/automation', requireAuth, (req, res) => {
    res.render('automation', {
        title: req.t('automation.title'),
        activePage: 'automation',
    });
});

// ── Network Monitoring ──

router.get('/network', requireAuth, (req, res) => {
    res.render('network', {
        title: req.t('network.title'),
        activePage: 'network',
    });
});

// ── Activity Monitoring ──

router.get('/activity', requireAuth, (req, res) => {
    res.render('activity', {
        title: req.t('activity.title'),
        activePage: 'activity',
    });
});

// ── Reports ──

router.get('/reports', requireAuth, (req, res) => {
    res.render('reports', {
        title: req.t('reports.title'),
        activePage: 'reports',
    });
});

// ── DataGuard (DLP) — admin only ──

router.get('/dataguard', requireAuth, requirePermission('server.config'), (req, res) => {
    res.render('dataguard', {
        title: req.t('dataguard.title'),
        activePage: 'dataguard',
    });
});

// ── Tenants — redirect to Organizations (merged) ──

router.get('/tenants', requireAuth, requireRole('admin'), (req, res) => {
    res.redirect('/organizations');
});

// ── Help Requests — operators and admins ──

router.get('/help-requests', requireAuth, (req, res) => {
    res.render('help-requests', {
        title: req.t('help_request.title'),
        activePage: 'help-requests',
    });
});

module.exports = router;
