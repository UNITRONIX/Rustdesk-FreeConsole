/**
 * BetterDesk Console — Registration Routes Tests (#351 sidebar badge)
 */

'use strict';

const request = require('supertest');
const { createTestApp } = require('./helpers');

const mockDb = {
    getPendingRegistrationCount: jest.fn().mockResolvedValue(0),
    logAction: jest.fn().mockResolvedValue(undefined),
};

const mockBetterdeskApi = {
    getEnrollmentPending: jest.fn().mockResolvedValue({ success: true, data: [], count: 0 }),
};

jest.mock('../services/database', () => mockDb);
jest.mock('../services/betterdeskApi', () => mockBetterdeskApi);
jest.mock('../services/deviceGroupService', () => ({}));
jest.mock('../services/serverBackend', () => ({}));

const registrationRoutes = require('../routes/registration.routes');

describe('Registration Routes — pending count', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        mockDb.getPendingRegistrationCount.mockResolvedValue(0);
        mockBetterdeskApi.getEnrollmentPending.mockResolvedValue({ success: true, data: [], count: 0 });

        app = createTestApp();
        app.use((req, _res, next) => {
            req.session.userId = 1;
            req.session.user = { id: 1, username: 'admin', role: 'admin' };
            next();
        });
        app.use('/', registrationRoutes);
    });

    it('GET /api/registrations/count sums LAN + Go managed enrollment pending', async () => {
        mockDb.getPendingRegistrationCount.mockResolvedValue(0);
        mockBetterdeskApi.getEnrollmentPending.mockResolvedValue({
            success: true,
            data: [{ device_id: 'Client-A' }],
            count: 2,
        });

        const res = await request(app).get('/api/registrations/count');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.count).toBe(2);
        expect(mockDb.getPendingRegistrationCount).toHaveBeenCalled();
        expect(mockBetterdeskApi.getEnrollmentPending).toHaveBeenCalled();
    });

    it('GET /api/registrations/count adds LAN and enrollment counts', async () => {
        mockDb.getPendingRegistrationCount.mockResolvedValue(3);
        mockBetterdeskApi.getEnrollmentPending.mockResolvedValue({
            success: true,
            data: [],
            count: 1,
        });

        const res = await request(app).get('/api/registrations/count');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(4);
    });

    it('GET /api/registrations/count treats Go failure as zero enrollment pending', async () => {
        mockDb.getPendingRegistrationCount.mockResolvedValue(5);
        mockBetterdeskApi.getEnrollmentPending.mockResolvedValue({
            success: false,
            error: 'connection refused',
            data: [],
            count: 0,
        });

        const res = await request(app).get('/api/registrations/count');

        expect(res.status).toBe(200);
        expect(res.body.count).toBe(5);
    });
});
