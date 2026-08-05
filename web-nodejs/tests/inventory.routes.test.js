/**
 * BetterDesk Console - Inventory Routes Tests
 */

const request = require('supertest');
const { createTestApp, withAuth } = require('./helpers');

const mockDb = {
    getAccessToken: jest.fn(),
    touchAccessToken: jest.fn().mockResolvedValue(undefined),
};

const mockAdapter = {
    getInventory: jest.fn(),
    getAllInventories: jest.fn(),
    getTelemetry: jest.fn(),
};

const mockBetterdeskApi = {
    getAllPeers: jest.fn(),
};

jest.mock('../services/database', () => mockDb);
jest.mock('../services/dbAdapter', () => ({
    getAdapter: jest.fn(() => mockAdapter),
}));
jest.mock('../services/betterdeskApi', () => mockBetterdeskApi);

const inventoryRoutes = require('../routes/inventory.routes');

describe('Inventory Routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockAdapter.getAllInventories.mockResolvedValue([]);
        mockBetterdeskApi.getAllPeers.mockResolvedValue([]);
    });

    it('rejects an unauthenticated device inventory read', async () => {
        const app = createTestApp();
        app.use('/api/bd', inventoryRoutes);

        const res = await request(app).get('/api/bd/inventory/device-a');

        expect(res.status).toBe(401);
        expect(mockDb.getAccessToken).not.toHaveBeenCalled();
        expect(mockAdapter.getInventory).not.toHaveBeenCalled();
    });

    it('rejects an X-Device-Id-only inventory read', async () => {
        const app = createTestApp();
        app.use('/api/bd', inventoryRoutes);

        const res = await request(app)
            .get('/api/bd/inventory/device-a')
            .set('X-Device-Id', 'device-a');

        expect(res.status).toBe(401);
        expect(mockDb.getAccessToken).not.toHaveBeenCalled();
        expect(mockAdapter.getInventory).not.toHaveBeenCalled();
    });

    it('rejects a valid device token reading another device inventory', async () => {
        mockDb.getAccessToken.mockResolvedValue({ client_id: 'device-b' });

        const app = createTestApp();
        app.use('/api/bd', inventoryRoutes);

        const res = await request(app)
            .get('/api/bd/inventory/device-a')
            .set('Authorization', 'Bearer valid-device-b-token');

        expect(res.status).toBe(403);
        expect(mockDb.touchAccessToken).toHaveBeenCalledWith('valid-device-b-token');
        expect(mockAdapter.getInventory).not.toHaveBeenCalled();
    });

    it('paginates the admin inventory list without per-device telemetry reads', async () => {
        mockAdapter.getAllInventories.mockResolvedValue([
            {
                device_id: 'device-a',
                hardware: { hostname: 'alpha', cpu: { usage_percent: 20 } },
                software: {},
                received_at: '2026-08-05T10:00:00.000Z',
            },
            {
                device_id: 'device-b',
                hardware: { hostname: 'bravo', cpu: { usage_percent: 40 } },
                software: {},
                received_at: '2026-08-05T09:00:00.000Z',
            },
        ]);

        const app = createTestApp();
        withAuth(app, { id: 1, username: 'global-admin', role: 'global_admin' });
        app.use('/api/inventory', inventoryRoutes);

        const res = await request(app).get('/api/inventory?page=1&limit=1');

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            total: 2,
            page: 1,
            limit: 1,
            total_pages: 2,
        });
        expect(res.body.devices).toHaveLength(1);
        expect(res.body.devices[0]).toMatchObject({ device_id: 'device-a', cpu_usage: 20 });
        expect(mockAdapter.getTelemetry).not.toHaveBeenCalled();
    });

    it('caps an oversized admin inventory page size', async () => {
        mockAdapter.getAllInventories.mockResolvedValue([]);

        const app = createTestApp();
        withAuth(app, { id: 1, username: 'global-admin', role: 'global_admin' });
        app.use('/api/inventory', inventoryRoutes);

        const res = await request(app).get('/api/inventory?page=1&limit=1000000');

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ page: 1, limit: 100, total: 0, total_pages: 0 });
    });
});
