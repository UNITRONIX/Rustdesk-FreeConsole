/**
 * MeshCentral compatibility routes — settings, .msh download, API proxy.
 */

const express = require('express');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const { proxyToGo } = require('../lib/goApiProxy');
const betterdeskApi = require('../services/betterdeskApi');

router.get('/api/mesh/status', requireAuth, async (req, res) => {
    try {
        const result = await betterdeskApi.getMeshStatus();
        res.json(result.data || result);
    } catch (err) {
        res.status(500).json({ enabled: false, error: err.message });
    }
});

router.get('/api/mesh/server-id', requireAuth, requirePermission('server.config'), async (req, res) => {
    return proxyToGo(betterdeskApi.apiClient, req, res, 'GET', '/mesh/server-id');
});

router.get('/api/mesh/groups', requireAuth, requirePermission('server.config'), async (req, res) => {
    return proxyToGo(betterdeskApi.apiClient, req, res, 'GET', '/mesh/groups');
});

router.post('/api/mesh/groups', requireAuth, requirePermission('server.config'), async (req, res) => {
    return proxyToGo(betterdeskApi.apiClient, req, res, 'POST', '/mesh/groups', req.body);
});

router.get('/api/mesh/download.msh', requireAuth, requirePermission('server.config'), async (req, res) => {
  try {
        const qs = new URLSearchParams(req.query).toString();
        const path = '/mesh/download.msh' + (qs ? `?${qs}` : '');
        const resp = await betterdeskApi.apiClient({
            method: 'GET',
            url: path,
            responseType: 'arraybuffer',
        });
        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Disposition', 'attachment; filename="meshagents.msh"');
        res.status(resp.status).send(Buffer.from(resp.data));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/api/mesh/devices/:id/desktop', requireAuth, requirePermission('device.connect'), async (req, res) => {
    const id = req.params.id;
    return proxyToGo(betterdeskApi.apiClient, req, res, 'POST', () => `/mesh/devices/${encodeURIComponent(id)}/desktop`);
});

router.post('/api/mesh/devices/:id/terminal', requireAuth, requirePermission('mesh.terminal'), async (req, res) => {
    const id = req.params.id;
    return proxyToGo(betterdeskApi.apiClient, req, res, 'POST', () => `/mesh/devices/${encodeURIComponent(id)}/terminal`);
});

router.post('/api/mesh/devices/:id/files', requireAuth, requirePermission('mesh.files'), async (req, res) => {
    const id = req.params.id;
    return proxyToGo(betterdeskApi.apiClient, req, res, 'POST', () => `/mesh/devices/${encodeURIComponent(id)}/files`);
});

router.post('/api/mesh/devices/:id/share', requireAuth, requirePermission('device.connect'), async (req, res) => {
    const id = req.params.id;
    return proxyToGo(betterdeskApi.apiClient, req, res, 'POST', () => `/mesh/devices/${encodeURIComponent(id)}/share`, req.body);
});

router.get('/api/mesh/share/validate', async (req, res) => {
    return proxyToGo(betterdeskApi.apiClient, req, res, 'GET', () => {
        const qs = new URLSearchParams(req.query).toString();
        return '/mesh/share/validate' + (qs ? `?${qs}` : '');
    });
});

router.post('/api/mesh/devices/:id/tcp', requireAuth, requirePermission('device.connect'), async (req, res) => {
    const id = req.params.id;
    return proxyToGo(betterdeskApi.apiClient, req, res, 'POST', () => `/mesh/devices/${encodeURIComponent(id)}/tcp`, req.body);
});

router.post('/api/mesh/devices/:id/udp', requireAuth, requirePermission('device.connect'), async (req, res) => {
    const id = req.params.id;
    return proxyToGo(betterdeskApi.apiClient, req, res, 'POST', () => `/mesh/devices/${encodeURIComponent(id)}/udp`, req.body);
});

router.post('/api/mesh/devices/:id/power', requireAuth, requirePermission('mesh.power'), async (req, res) => {
    const id = req.params.id;
    return proxyToGo(betterdeskApi.apiClient, req, res, 'POST', () => `/mesh/devices/${encodeURIComponent(id)}/power`, req.body);
});

router.post('/api/mesh/devices/:id/group', requireAuth, requirePermission('server.config'), async (req, res) => {
    const id = req.params.id;
    return proxyToGo(betterdeskApi.apiClient, req, res, 'POST', () => `/mesh/devices/${encodeURIComponent(id)}/group`, req.body);
});

router.get('/api/mesh/recordings', requireAuth, requirePermission('device.view'), async (req, res) => {
    return proxyToGo(betterdeskApi.apiClient, req, res, 'GET', '/mesh/recordings');
});

router.get('/api/mesh/recordings/:id', requireAuth, requirePermission('device.connect'), async (req, res) => {
    const id = req.params.id;
    return proxyToGo(betterdeskApi.apiClient, req, res, 'GET', () => `/mesh/recordings/${encodeURIComponent(id)}`);
});

router.get('/api/session/recordings', requireAuth, requirePermission('device.view'), async (req, res) => {
    return proxyToGo(betterdeskApi.apiClient, req, res, 'GET', '/session/recordings');
});

router.post('/api/mesh/devices/:id/exec', requireAuth, requirePermission('device.connect'), async (req, res) => {
    const id = req.params.id;
    return proxyToGo(betterdeskApi.apiClient, req, res, 'POST', () => `/mesh/devices/${encodeURIComponent(id)}/exec`, req.body);
});

module.exports = router;
