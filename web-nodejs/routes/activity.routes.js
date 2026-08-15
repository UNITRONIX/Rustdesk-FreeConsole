/**
 * BetterDesk Console — Activity Monitoring API Routes
 *
 * Receives application usage sessions and idle state from the
 * BetterDesk desktop agent.  Provides admin endpoints for viewing
 * activity summaries and per-device session details.
 *
 * Endpoints:
 *
 * Device-facing (authenticated via token / X-Device-Id):
 *   POST   /api/bd/activity      — Upload activity sessions + idle info
 *
 * Admin-facing (web console session):
 *   GET    /api/activity          — List all activity summaries
 *   GET    /api/activity/:id      — Per-device activity detail
 *   GET    /api/activity/:id/top  — Top apps for a device
 *
 * @author UNITRONIX
 * @version 1.0.0
 */

'use strict';

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const { getAdapter } = require('../services/dbAdapter');

const { requireAuth, requirePermission } = require('../middleware/auth');

const {
    requireDeviceToken,
    requireTokenDeviceMatch,
} = require('../middleware/deviceAuth');

// ---------------------------------------------------------------------------
//  Device-facing endpoint
// ---------------------------------------------------------------------------

/**
 * POST /api/bd/activity — Upload activity sessions and idle state.
 *
 * Body: {
 *   device_id: string,
 *   sessions: [{ app_name, window_title, category, started_at, ended_at, duration_secs }],
 *   idle_seconds: number,
 *   timestamp: string (ISO 8601)
 * }
 */
router.post('/activity', requireDeviceToken, requireTokenDeviceMatch, async (req, res) => {
    try {
        const { device_id, sessions, idle_seconds, timestamp } = req.body;

        if (!device_id) {
            return res.status(400).json({ success: false, error: 'Missing device_id' });
        }

        // Validate that the authenticated device matches
        if (req.deviceId && req.deviceId !== device_id) {
            return res.status(403).json({ success: false, error: 'Device ID mismatch' });
        }

        const adapter = getAdapter();

        // Insert individual activity sessions (if any)
        if (Array.isArray(sessions) && sessions.length > 0) {
            // Validate and sanitize sessions
            const valid = sessions
                .filter(s => s.started_at && s.ended_at)
                .slice(0, 500); // Max 500 per upload

            if (valid.length > 0) {
                await adapter.insertActivitySessions(device_id, valid);
            }
        }

        // Upsert summary
        const totalActive = Array.isArray(sessions)
            ? sessions.reduce((sum, s) => sum + (s.duration_secs || 0), 0)
            : 0;

        await adapter.upsertActivitySummary(device_id, {
            idle_seconds: idle_seconds ?? 0,
            session_count: Array.isArray(sessions) ? sessions.length : 0,
            total_active_secs: totalActive,
            reported_at: timestamp || new Date().toISOString(),
        });

        console.log(`[Activity] Received ${sessions?.length || 0} sessions from ${device_id} (idle: ${idle_seconds ?? 0}s)`);
        res.json({ success: true });
    } catch (err) {
        console.error('[Activity] Upload error:', err.message);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// ---------------------------------------------------------------------------
//  Admin-facing endpoints
// ---------------------------------------------------------------------------

/**
 * GET /api/activity — List all activity summaries.
 * Query params: from, to (ISO 8601 date strings)
 */
router.get('/', requireAuth, requirePermission('audit.view'), async (req, res) => {
    try {
        const adapter = getAdapter();
        const { from, to } = req.query;
        const summaries = await adapter.getAllActivitySummaries({ from, to });

        // Enrich with peer info
        const enriched = await Promise.all(summaries.map(async s => {
            let hostname = s.device_id;
            try {
                const peer = await db.getPeerById(s.device_id);
                if (peer) {
                    const info = peer.info ? JSON.parse(peer.info) : {};
                    hostname = peer.note || info.hostname || s.device_id;
                }
            } catch (_) { /* ignore */ }

            return {
                device_id: s.device_id,
                hostname,
                idle_seconds: s.idle_seconds,
                session_count: s.session_count,
                total_active_secs: s.total_active_secs,
                detail_count: s.detail_count || 0,
                reported_at: s.reported_at,
                received_at: s.received_at,
            };
        }));

        res.json({ summaries: enriched, total: enriched.length });
    } catch (err) {
        console.error('[Activity] List error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/activity/:id — Per-device activity detail.
 * Query params: from, to, limit
 */
router.get('/:id', requireAuth, requirePermission('audit.view'), async (req, res) => {
    try {
        const adapter = getAdapter();
        const deviceId = req.params.id;
        const { from, to, limit } = req.query;

        const [sessions, summaries] = await Promise.all([
            adapter.getActivitySessions(deviceId, {
                from,
                to,
                limit: limit ? parseInt(limit, 10) : 100,
            }),
            adapter.getActivitySummaries(deviceId, { from, to }),
        ]);

        // Peer info
        let hostname = deviceId;
        try {
            const peer = await db.getPeerById(deviceId);
            if (peer) {
                const info = peer.info ? JSON.parse(peer.info) : {};
                hostname = peer.note || info.hostname || deviceId;
            }
        } catch (_) { /* ignore */ }

        res.json({
            device_id: deviceId,
            hostname,
            sessions,
            summaries,
            session_count: sessions.length,
        });
    } catch (err) {
        console.error('[Activity] Detail error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/activity/:id/top — Top applications for a device.
 * Query params: from, to, limit (default 10)
 */
router.get('/:id/top', requireAuth, requirePermission('audit.view'), async (req, res) => {
    try {
        const adapter = getAdapter();
        const deviceId = req.params.id;
        const { from, to, limit } = req.query;

        const topApps = await adapter.getTopApps(deviceId, {
            from,
            to,
            limit: limit ? parseInt(limit, 10) : 10,
        });

        res.json({ device_id: deviceId, top_apps: topApps });
    } catch (err) {
        console.error('[Activity] Top apps error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
