const request = require('supertest');

jest.mock('../services/betterdeskApi', () => ({
    getCDAPStatus: jest.fn(),
    getCDAPDevices: jest.fn(),
    getCDAPDeviceInfo: jest.fn(),
    getCDAPDeviceManifest: jest.fn(),
    getCDAPDeviceState: jest.fn(),
    sendCDAPCommand: jest.fn(),
    setConfig: jest.fn(),
    getCDAPAlerts: jest.fn(),
    getLinkedPeers: jest.fn(),
    linkDevice: jest.fn(),
}));

const betterdeskApi = require('../services/betterdeskApi');
const { createTestApp, withAuth } = require('./helpers');
const cdapRoutes = require('../routes/cdap.routes');

describe('CDAP Routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('unwraps the betterdeskApi envelope for CDAP status', async () => {
        betterdeskApi.getCDAPStatus.mockResolvedValue({
            success: true,
            data: { enabled: true, connections: 2 },
        });

        const app = createTestApp();
        withAuth(app);
        app.use(cdapRoutes);

        const res = await request(app).get('/api/cdap/status');

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ enabled: true, connections: 2 });
    });

    it('rejects CDAP commands for users without operator role', async () => {
        const app = createTestApp();
        withAuth(app, { id: 3, username: 'viewer', role: 'user' });
        app.use(cdapRoutes);

        const res = await request(app)
            .post('/api/cdap/devices/device-1/command')
            .send({ widget_id: 'w1', action: 'toggle' });

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
    });

    it('validates required CDAP command fields', async () => {
        const app = createTestApp();
        withAuth(app, { username: 'operator1', role: 'operator' });
        app.use(cdapRoutes);

        const res = await request(app)
            .post('/api/cdap/devices/device-1/command')
            .send({ widget_id: 'w1' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('widget_id and action are required');
    });

    it('returns the fallback error response when CDAP device info lookup fails', async () => {
        betterdeskApi.getCDAPDeviceInfo.mockRejectedValue(new Error('offline'));

        const app = createTestApp();
        withAuth(app);
        app.use(cdapRoutes);

        const res = await request(app).get('/api/cdap/devices/device-9');

        expect(res.status).toBe(500);
        expect(res.body.error).toBe('Failed to get CDAP device info');
    });

    it('rejects invalid device id on CDAP device detail page', async () => {
        const app = createTestApp();
        withAuth(app);
        app.use(cdapRoutes);

        const res = await request(app).get('/cdap/devices/foo%3Cbar%3E');

        expect(res.status).toBe(400);
        expect(res.text).not.toMatch(/foo&lt;bar&gt;/);
    });
});