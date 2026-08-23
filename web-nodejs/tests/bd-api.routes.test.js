'use strict';

const request = require('supertest');
const express = require('express');
const session = require('express-session');

jest.mock('../services/authService', () => ({}));

jest.mock('../services/betterdeskApi', () => ({
    listHelpRequests: jest.fn(),
    getEnrollmentPending: jest.fn(),
}));

jest.mock('../services/database', () => ({
    shouldRejectRenamedPeerRegistration: jest.fn(),
    getRenamedPeerId: jest.fn(),
    upsertPeer: jest.fn().mockResolvedValue(undefined),
    updatePeerOnlineStatus: jest.fn().mockResolvedValue(undefined),
    getAccessToken: jest.fn(),
    touchAccessToken: jest.fn(),
    getReadNotificationIds: jest.fn().mockResolvedValue(new Set()),
    markAllNotificationsRead: jest.fn().mockResolvedValue(undefined),
    markNotificationRead: jest.fn().mockResolvedValue(undefined),
    getPendingRegistrations: jest.fn().mockResolvedValue([]),
}));

const db = require('../services/database');
const betterdeskApi = require('../services/betterdeskApi');
const bdApiRoutes = require('../routes/bd-api.routes');

describe('BD-API register rename guard', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = express();
        app.use(express.json());
        app.use('/api/bd', bdApiRoutes);
        jest.clearAllMocks();
    });

    it('rejects stale renamed ID when identity does not match successor', async () => {
        db.shouldRejectRenamedPeerRegistration.mockResolvedValue({
            reject: true,
            new_id: 'NEWID123',
        });

        const res = await request(app)
            .post('/api/bd/register')
            .set('X-Device-Id', 'OLDID123')
            .send({ device_id: 'OLDID123', uuid: 'other-uuid' });

        expect(res.status).toBe(409);
        expect(res.body.new_id).toBe('NEWID123');
        expect(db.upsertPeer).not.toHaveBeenCalled();
    });

    it('allows registration when same device owns renamed ID', async () => {
        db.shouldRejectRenamedPeerRegistration.mockResolvedValue({ reject: false });

        const res = await request(app)
            .post('/api/bd/register')
            .set('X-Device-Id', 'OLDID123')
            .send({ device_id: 'OLDID123', uuid: 'device-uuid', hostname: 'PC' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(db.upsertPeer).toHaveBeenCalled();
    });

    it('rejects a bearer-bound device from registering a different device ID', async () => {
        db.getAccessToken.mockResolvedValue({ client_id: 'BOUND123' });

        const res = await request(app)
            .post('/api/bd/register')
            .set('Authorization', 'Bearer device-token')
            .send({ device_id: 'OTHER123', uuid: 'device-uuid' });

        expect(res.status).toBe(403);
        expect(db.upsertPeer).not.toHaveBeenCalled();
    });
});

describe('BD-API notification center', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = express();
        app.use(express.json());
        app.use(session({
            secret: 'notification-test-secret',
            resave: false,
            saveUninitialized: true,
        }));
        app.use((req, _res, next) => {
            req.session.userId = 1;
            req.session.user = { id: 1, username: 'admin', role: 'admin' };
            next();
        });
        app.use('/api/bd', bdApiRoutes);

        db.getReadNotificationIds.mockResolvedValue(new Set());
        db.getPendingRegistrations.mockResolvedValue([]);
        betterdeskApi.getEnrollmentPending.mockResolvedValue({
            success: true,
            data: [],
            count: 0,
        });
        betterdeskApi.listHelpRequests.mockResolvedValue({
            success: true,
            data: [],
        });
    });

    it('merges LAN and managed enrollment requests and reports the full unread count', async () => {
        db.getPendingRegistrations.mockResolvedValue([
            {
                id: 7,
                device_id: 'LAN-123',
                hostname: 'LAN workstation',
                platform: 'Windows',
                ip_address: '192.0.2.10',
                created_at: '2026-08-23T12:00:00.000Z',
            },
        ]);
        betterdeskApi.getEnrollmentPending.mockResolvedValue({
            success: true,
            data: [{
                device_id: 'GO-456',
                hostname: 'Managed workstation',
                platform: 'Linux',
                ip: '192.0.2.11',
                created_at: '2026-08-23T12:01:00.000Z',
            }],
            count: 1,
        });

        const res = await request(app).get('/api/bd/notifications?limit=1');

        expect(res.status).toBe(200);
        expect(res.body.unread_count).toBe(2);
        expect(res.body.items).toHaveLength(1);
        expect(res.body.items[0].kind).toBe('registration');
        expect(res.body.items[0].link).toBe('/registrations');
    });

    it('does not expose registration notifications without enrollment permission', async () => {
        app = express();
        app.use(express.json());
        app.use(session({
            secret: 'notification-test-secret',
            resave: false,
            saveUninitialized: true,
        }));
        app.use((req, _res, next) => {
            req.session.userId = 2;
            req.session.user = { id: 2, username: 'viewer', role: 'viewer' };
            next();
        });
        app.use('/api/bd', bdApiRoutes);
        db.getPendingRegistrations.mockResolvedValue([{
            id: 8,
            device_id: 'LAN-456',
            created_at: '2026-08-23T12:00:00.000Z',
        }]);

        const res = await request(app).get('/api/bd/notifications');

        expect(res.status).toBe(200);
        expect(res.body.items).toEqual([]);
        expect(res.body.unread_count).toBe(0);
        expect(db.getPendingRegistrations).not.toHaveBeenCalled();
    });

    it('marks both help and registration notifications read', async () => {
        db.getPendingRegistrations.mockResolvedValue([{
            id: 9,
            device_id: 'LAN-789',
            created_at: '2026-08-23T12:00:00.000Z',
        }]);
        betterdeskApi.listHelpRequests.mockResolvedValue({
            success: true,
            data: [{ id: 'help-1', created_at: '2026-08-23T11:00:00.000Z' }],
        });

        const res = await request(app).post('/api/bd/notifications/read-all');

        expect(res.status).toBe(200);
        expect(db.markAllNotificationsRead).toHaveBeenCalledWith(1, [
            'help-1',
            'registration:lan:9',
        ]);
    });
});
