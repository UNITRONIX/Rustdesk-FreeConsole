/**
 * BetterDesk Console - Keys Routes
 */

const express = require('express');
const router = express.Router();
const keyService = require('../services/keyService');
const clientConfigHost = require('../services/clientConfigHost');
const { requireAuth } = require('../middleware/auth');

function resolveClientEndpoints(req) {
    const queryHost = typeof req.query.host === 'string' ? req.query.host : '';
    return clientConfigHost.resolveRustDeskEndpoints(req, queryHost);
}

function buildServerInfoPayload(req) {
    const endpoints = resolveClientEndpoints(req);
    const apiKey = keyService.getApiKey(true);
    return {
        server_id: endpoints.host,
        relay_server: endpoints.relay,
        api_url: endpoints.api,
        api_key_masked: apiKey || '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022',
        endpoint_sources: endpoints.sources,
        env_override_active: endpoints.env_override_active,
    };
}

/**
 * GET /keys - Keys management page
 */
router.get('/keys', requireAuth, (req, res) => {
    res.render('keys', {
        title: req.t('nav.keys'),
        activePage: 'keys'
    });
});

/**
 * GET /api/keys/public - Get public key
 */
router.get('/api/keys/public', requireAuth, async (req, res) => {
    try {
        const publicKey = await keyService.resolvePublicKey();

        if (!publicKey) {
            return res.status(404).json({
                success: false,
                error: req.t('keys.not_found')
            });
        }

        res.json({
            success: true,
            data: {
                key: publicKey
            }
        });
    } catch (err) {
        console.error('Get public key error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * GET /api/keys/public/qr - Get server config as QR code
 * Generates a QR code in rustdesk://config/<base64-json> format
 * that the RustDesk mobile app can scan to auto-configure.
 */
router.get('/api/keys/public/qr', requireAuth, async (req, res) => {
    try {
        const endpoints = resolveClientEndpoints(req);
        const qrDataUrl = await keyService.getServerConfigQR(endpoints);
        
        if (!qrDataUrl) {
            return res.status(404).json({
                success: false,
                error: req.t('keys.not_found')
            });
        }
        
        res.json({
            success: true,
            data: {
                qr: qrDataUrl
            }
        });
    } catch (err) {
        console.error('Get public key QR error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * GET /api/keys/public/download - Download public key file
 */
router.get('/api/keys/public/download', requireAuth, async (req, res) => {
    try {
        const publicKey = await keyService.resolvePublicKey();

        if (!publicKey) {
            return res.status(404).json({
                success: false,
                error: req.t('keys.not_found')
            });
        }

        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', 'attachment; filename="id_ed25519.pub"');
        res.send(publicKey);
    } catch (err) {
        console.error('Download public key error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * GET /api/keys/api - Get API key (masked)
 */
router.get('/api/keys/api', requireAuth, (req, res) => {
    try {
        const show = req.query.show === 'true';
        const apiKey = keyService.getApiKey(!show);
        
        if (!apiKey) {
            return res.status(404).json({
                success: false,
                error: req.t('keys.api_not_found')
            });
        }
        
        res.json({
            success: true,
            data: {
                key: apiKey,
                masked: !show
            }
        });
    } catch (err) {
        console.error('Get API key error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * GET /api/keys/server-info - Get server address info for config display
 */
router.get('/api/keys/server-info', requireAuth, (req, res) => {
    try {
        res.json({
            success: true,
            data: buildServerInfoPayload(req)
        });
    } catch (err) {
        console.error('Get server info error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * GET /api/keys/qr - Alias for /api/keys/public/qr (backward compatibility)
 */
router.get('/api/keys/qr', requireAuth, async (req, res) => {
    try {
        const endpoints = resolveClientEndpoints(req);
        const qrDataUrl = await keyService.getServerConfigQR(endpoints);
        
        if (!qrDataUrl) {
            return res.status(404).json({
                success: false,
                error: req.t('keys.not_found')
            });
        }
        
        res.json({
            success: true,
            data: {
                qr: qrDataUrl
            }
        });
    } catch (err) {
        console.error('Get public key QR error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

module.exports = router;
