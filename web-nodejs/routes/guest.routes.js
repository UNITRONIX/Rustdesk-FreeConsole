/**
 * Guest Access Links routes — create/list/revoke (operator) + guest UI APIs.
 */

const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const { proxyToGo } = require('../lib/goApiProxy');
const betterdeskApi = require('../services/betterdeskApi');
const deviceGroupService = require('../services/deviceGroupService');
const db = require('../services/database');
const {
    getGuestToken,
    setGuestCookie,
    attachGuestGrant,
    peerAllowedByGrant,
} = require('../middleware/guestAccess');
const { rdClientPageLimiter } = require('../middleware/rateLimiter');

async function assertPeersInScope(req, peerIds) {
    const scope = await deviceGroupService.getDeviceScopeForUser(db, req.session.user, peerIds.map((id) => ({ id })));
    if (scope === null) return true;
    return peerIds.every((id) => scope.has(id));
}

// --- Operator APIs ---

router.post('/api/guest/access-links', requireAuth, requirePermission('device.connect'), async (req, res) => {
    try {
        const peerIds = Array.isArray(req.body?.peer_ids) ? req.body.peer_ids.map(String) : [];
        if (!peerIds.length) {
            return res.status(400).json({ error: 'peer_ids required' });
        }
        const ok = await assertPeersInScope(req, peerIds);
        if (!ok) {
            return res.status(403).json({ error: 'One or more devices are outside your device scope' });
        }
        return proxyToGo(betterdeskApi.apiClient, req, res, 'POST', '/guest/access-links', {
            peer_ids: peerIds,
            ttl_minutes: req.body.ttl_minutes,
            view_only: !!req.body.view_only,
            label: req.body.label || '',
            max_uses: req.body.max_uses || 0,
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

router.get('/api/guest/access-links', requireAuth, requirePermission('device.connect'), async (req, res) => {
    return proxyToGo(betterdeskApi.apiClient, req, res, 'GET', '/guest/access-links');
});

router.delete('/api/guest/access-links/:id', requireAuth, requirePermission('device.connect'), async (req, res) => {
    const id = encodeURIComponent(req.params.id);
    return proxyToGo(betterdeskApi.apiClient, req, res, 'DELETE', `/guest/access-links/${id}`);
});

// --- Public guest APIs (token-gated; no panel session) ---

router.get('/api/guest/access-links/validate', rdClientPageLimiter, async (req, res) => {
    return proxyToGo(betterdeskApi.apiClient, req, res, 'GET', () => {
        const qs = new URLSearchParams(req.query).toString();
        return '/guest/access-links/validate' + (qs ? `?${qs}` : '');
    });
});

router.get('/api/guest/access-links/peers', rdClientPageLimiter, async (req, res) => {
    const token = getGuestToken(req);
    if (!token) return res.status(400).json({ error: 'token required' });
    try {
        const result = await betterdeskApi.apiClient.get('/guest/access-links/peers', {
            params: { token },
        });
        const data = result.data || {};
        if (data.valid && data.expires_at) {
            setGuestCookie(res, token, data.expires_at);
        }
        return res.status(result.status || 200).json(data);
    } catch (err) {
        const status = err.response?.status || 500;
        return res.status(status).json(err.response?.data || { error: err.message });
    }
});

/**
 * Guest mesh desktop tunnel — validates guest or mesh_share, then proxies with API key.
 */
router.post('/api/guest/mesh/devices/:id/desktop', rdClientPageLimiter, async (req, res) => {
    const peerId = req.params.id;
    const guest = getGuestToken(req);
    const meshShare = String(req.query.mesh_share || '').trim();

    if (guest) {
        const grant = await attachGuestGrant(req, betterdeskApi, peerId);
        if (!grant || !peerAllowedByGrant(grant, peerId)) {
            return res.status(403).json({ error: 'Invalid or expired guest link' });
        }
        return proxyToGo(betterdeskApi.apiClient, req, res, 'POST', () => {
            const qs = new URLSearchParams(req.query);
            qs.delete('t');
            if (!qs.has('guest')) qs.set('guest', guest);
            if (req.guestGrant?.view_only) qs.set('view_only', '1');
            const q = qs.toString();
            return `/mesh/devices/${encodeURIComponent(peerId)}/desktop` + (q ? `?${q}` : '');
        });
    }

    if (meshShare) {
        try {
            const result = await betterdeskApi.apiClient.get('/mesh/share/validate', {
                params: { token: meshShare, peer_id: peerId },
            });
            if (!result.data?.valid) {
                return res.status(403).json({ error: 'Invalid or expired share link' });
            }
        } catch {
            return res.status(403).json({ error: 'Invalid or expired share link' });
        }
        return proxyToGo(betterdeskApi.apiClient, req, res, 'POST', () => {
            const qs = new URLSearchParams(req.query).toString();
            return `/mesh/devices/${encodeURIComponent(peerId)}/desktop` + (qs ? `?${qs}` : '');
        });
    }

    return res.status(401).json({ error: 'guest token or mesh_share required' });
});

module.exports = router;
