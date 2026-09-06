/**
 * BetterDesk Console — Client Branding (desktop clients)
 *
 * Main → Client Branding edits the Go-server source of truth used by
 * BetterDesk desktop (GET /api/branding) and stock RustDesk (heartbeat subset).
 * Distinct from Settings → Branding (console appearance / brandingService).
 */

'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const betterdeskApi = require('../services/betterdeskApi');

const largeJson = express.json({ limit: '2mb' });

router.get(
    '/client-branding',
    requireAuth,
    requirePermission('branding.edit'),
    (req, res) => {
        res.render('client-branding', {
            title: req.t('nav.client_branding'),
        });
    }
);

router.get(
    '/api/client-branding',
    requireAuth,
    requirePermission('branding.edit'),
    async (req, res) => {
        try {
            const result = await betterdeskApi.getBranding();
            if (!result.success) {
                return res.status(502).json({
                    success: false,
                    error: result.error || 'Failed to load branding from BetterDesk server',
                });
            }
            return res.json({ success: true, data: result.data });
        } catch (err) {
            console.error('[client-branding] GET failed:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
    }
);

router.post(
    '/api/client-branding',
    requireAuth,
    requirePermission('branding.edit'),
    largeJson,
    async (req, res) => {
        try {
            const body = req.body || {};
            const payload = {
                company_name: body.company_name,
                phone: body.phone,
                email: body.email,
                website: body.website,
                accent_color: body.accent_color,
                support_contact: body.support_contact,
                colors: body.colors,
            };
            if (body.clear_logo) {
                payload.clear_logo = true;
            } else if (body.logo) {
                payload.logo = body.logo;
            }

            const result = await betterdeskApi.saveBranding(payload);
            if (!result.success) {
                return res.status(502).json({
                    success: false,
                    error: result.error || 'Failed to save branding on BetterDesk server',
                });
            }
            return res.json({
                success: true,
                data: result.data,
                revision: result.data?.revision || result.revision,
            });
        } catch (err) {
            console.error('[client-branding] POST failed:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
    }
);

module.exports = router;
