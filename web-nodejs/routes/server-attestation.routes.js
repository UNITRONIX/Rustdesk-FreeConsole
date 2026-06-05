'use strict';

/**
 * BetterDesk Console — Server Attestation Routes
 */

const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const attestation = require('../services/serverAttestation');

const REQUIRED_PERMISSION = 'server.config';
const auth = [requireAuth, requirePermission(REQUIRED_PERMISSION)];

let runPromise = null;

// ─── Page ─────────────────────────────────────────────────────────────────────

router.get('/server-attestation', ...auth, async (req, res) => {
    const lastResult = await attestation.getLastResult();
    res.render('server-attestation', {
        title: req.t('server_attestation.title'),
        pageStyles: ['server-attestation'],
        pageScripts: ['server-attestation'],
        currentPage: 'server-attestation',
        breadcrumb: [{ label: req.t('server_attestation.title') }],
        lastResult
    });
});

// ─── Authenticated API ────────────────────────────────────────────────────────

router.get('/api/server-attestation/status', ...auth, async (req, res) => {
    try {
        const status = attestation.getStatus();
        if (!status.lastResult) {
            status.lastResult = await attestation.getLastResult();
        }
        res.json({ success: true, ...status });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/api/server-attestation/run', ...auth, async (req, res) => {
    try {
        const status = attestation.getStatus();
        if (status.running) {
            return res.status(409).json({ success: false, error: 'Benchmark already running' });
        }

        runPromise = attestation.runLoadTest({
            onProgress: () => { /* polled via status */ }
        }).catch((err) => {
            console.error('[ServerAttestation] run failed:', err.message);
        }).finally(() => {
            runPromise = null;
        });

        res.json({ success: true, started: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/api/server-attestation/abort', ...auth, (req, res) => {
    const aborted = attestation.requestAbort();
    res.json({ success: true, aborted });
});

router.get('/api/server-attestation/result', ...auth, async (req, res) => {
    try {
        const result = await attestation.getLastResult();
        res.json({ success: true, result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── Public badge API (login page) ───────────────────────────────────────────

router.get('/api/public/server-attestation', async (req, res) => {
    try {
        const result = await attestation.getLastResult();
        res.json(attestation.buildPublicSummary(result));
    } catch (_) {
        res.json({ tier: null, maxConnections: 0, testedAt: null, valid: false });
    }
});

module.exports = router;
