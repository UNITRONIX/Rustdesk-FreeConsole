/**
 * BetterDesk Console — Reports API Routes
 *
 * Generates on-demand and saved reports from aggregated data across
 * all modules: devices, activity, security/DLP, tickets, network,
 * inventory, and alerts.
 *
 * Endpoints:
 *
 * Admin-facing (web console session):
 *   GET    /api/reports/types            — List available report types
 *   POST   /api/reports/generate         — Generate a report on-demand
 *   POST   /api/reports/generate/csv     — Generate and download CSV
 *   GET    /api/reports/saved            — List saved reports
 *   GET    /api/reports/saved/:id        — Get a saved report
 *   POST   /api/reports/save             — Generate and save a report
 *   DELETE /api/reports/saved/:id        — Delete a saved report
 *
 * @author  UNITRONIX
 * @version 1.0.0
 */

'use strict';

const express = require('express');
const router = express.Router();
const { getAdapter } = require('../services/dbAdapter');
const { generateReport, listReportTypes, toCsv } = require('../services/reportEngine');
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
//  Report types
// =========================================================================

/**
 * GET /api/reports/types
 */
router.get('/types', requireSession, (_req, res) => {
    res.json(listReportTypes());
});

// =========================================================================
//  On-demand generation
// =========================================================================

/**
 * POST /api/reports/generate
 * Body: { type, from?, to?, device_id?, limit? }
 */
router.post('/generate', requireSession, async (req, res) => {
    try {
        const { type, from, to, device_id, limit } = req.body;
        if (!type) return res.status(400).json({ error: 'Report type is required' });
        const report = await generateReport(type, { from, to, device_id, limit });
        res.json(report);
    } catch (err) {
        console.error('[Reports] generate error:', err.message);
        if (err.message.startsWith('Unknown report type')) {
            return res.status(400).json({ error: err.message });
        }
        res.status(500).json({ error: 'Failed to generate report' });
    }
});

/**
 * POST /api/reports/generate/csv
 * Body: { type, from?, to?, device_id?, limit?, section? }
 * section: key inside data to flatten for CSV (e.g. "targets", "top_applications")
 */
router.post('/generate/csv', requireSession, async (req, res) => {
    try {
        const { type, from, to, device_id, limit, section } = req.body;
        if (!type) return res.status(400).json({ error: 'Report type is required' });
        const report = await generateReport(type, { from, to, device_id, limit });

        // Determine rows to export
        let rows;
        if (section && report.data[section] && Array.isArray(report.data[section])) {
            rows = report.data[section];
        } else {
            // Flatten top-level scalars into a single row
            const flat = {};
            for (const [k, v] of Object.entries(report.data)) {
                if (typeof v !== 'object' || v === null) {
                    flat[k] = v;
                }
            }
            rows = Object.keys(flat).length > 0 ? [flat] : [];
        }

        const csv = toCsv(rows);
        const filename = `betterdesk_${type}_${new Date().toISOString().slice(0, 10)}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csv);
    } catch (err) {
        console.error('[Reports] CSV export error:', err.message);
        res.status(500).json({ error: 'Failed to export CSV' });
    }
});

// =========================================================================
//  Saved reports
// =========================================================================

/**
 * GET /api/reports/saved
 */
router.get('/saved', requireSession, async (req, res) => {
    try {
        const db = getAdapter();
        const reports = await db.getSavedReports();
        res.json(reports);
    } catch (err) {
        console.error('[Reports] get saved error:', err.message);
        res.status(500).json({ error: 'Failed to fetch saved reports' });
    }
});

/**
 * GET /api/reports/saved/:id
 */
router.get('/saved/:id', requireSession, async (req, res) => {
    try {
        const db = getAdapter();
        const report = await db.getSavedReportById(Number(req.params.id));
        if (!report) return res.status(404).json({ error: 'Saved report not found' });
        // Parse payload
        report.payload = typeof report.payload === 'string'
            ? JSON.parse(report.payload) : (report.payload || {});
        res.json(report);
    } catch (err) {
        console.error('[Reports] get saved/:id error:', err.message);
        res.status(500).json({ error: 'Failed to fetch report' });
    }
});

/**
 * POST /api/reports/save
 * Body: { type, title?, from?, to?, device_id?, limit? }
 * Generates the report and saves it.
 */
router.post('/save', requireAdmin, async (req, res) => {
    try {
        const { type, title, from, to, device_id, limit } = req.body;
        if (!type) return res.status(400).json({ error: 'Report type is required' });
        const report = await generateReport(type, { from, to, device_id, limit });

        const db = getAdapter();
        const saved = await db.createSavedReport({
            title: title || `${report.label} — ${report.generated_at}`,
            report_type: type,
            filters: JSON.stringify(report.filters || {}),
            payload: JSON.stringify(report.data),
            created_by: req.session.user.username,
        });

        res.status(201).json(saved);
    } catch (err) {
        console.error('[Reports] save error:', err.message);
        res.status(500).json({ error: 'Failed to save report' });
    }
});

/**
 * DELETE /api/reports/saved/:id
 */
router.delete('/saved/:id', requireAdmin, async (req, res) => {
    try {
        const db = getAdapter();
        const ok = await db.deleteSavedReport(Number(req.params.id));
        if (!ok) return res.status(404).json({ error: 'Report not found' });
        res.json({ ok: true });
    } catch (err) {
        console.error('[Reports] delete saved error:', err.message);
        res.status(500).json({ error: 'Failed to delete report' });
    }
});

module.exports = router;
