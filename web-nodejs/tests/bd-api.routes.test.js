'use strict';

const request = require('supertest');
const express = require('express');

jest.mock('../services/authService', () => ({}));

jest.mock('../services/database', () => ({
    shouldRejectRenamedPeerRegistration: jest.fn(),
    getRenamedPeerId: jest.fn(),
    upsertPeer: jest.fn().mockResolvedValue(undefined),
    updatePeerOnlineStatus: jest.fn().mockResolvedValue(undefined),
    getAccessToken: jest.fn(),
    touchAccessToken: jest.fn(),
}));

const db = require('../services/database');
const bdApiRoutes = require('../routes/bd-api.routes');

describe('BD-API register rename guard', () => {
    let app;

    beforeEach(() => {
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
});
