const express = require('express');
const request = require('supertest');

const mockDb = {
    getAccessToken: jest.fn(),
    touchAccessToken: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../services/database', () => mockDb);

const {
    requireDeviceToken,
    requireTokenDeviceMatch,
} = require('../middleware/deviceAuth');

function buildApp() {
    const app = express();
    app.use(express.json());
    app.post('/device', requireDeviceToken, requireTokenDeviceMatch, (req, res) => {
        res.json({ device_id: req.deviceId });
    });
    return app;
}

describe('device authentication middleware', () => {
    beforeEach(() => jest.clearAllMocks());

    test('rejects X-Device-Id without a Bearer token', async () => {
        const res = await request(buildApp())
            .post('/device')
            .set('X-Device-Id', 'device-a')
            .send({ device_id: 'device-a' });

        expect(res.status).toBe(401);
        expect(mockDb.getAccessToken).not.toHaveBeenCalled();
    });

    test('rejects unbound access tokens', async () => {
        mockDb.getAccessToken.mockResolvedValue({ user_id: 1, client_id: null });

        const res = await request(buildApp())
            .post('/device')
            .set('Authorization', 'Bearer operator-token')
            .send({ device_id: 'device-a' });

        expect(res.status).toBe(401);
    });

    test('binds the request to the token client and rejects mismatches', async () => {
        mockDb.getAccessToken.mockResolvedValue({ user_id: 1, client_id: 'device-a' });

        const res = await request(buildApp())
            .post('/device')
            .set('Authorization', 'Bearer device-token')
            .send({ device_id: 'device-b' });

        expect(res.status).toBe(403);
        expect(mockDb.touchAccessToken).toHaveBeenCalledWith('device-token');
    });

    test('accepts a bound token when no spoofed device id is supplied', async () => {
        mockDb.getAccessToken.mockResolvedValue({ user_id: 1, client_id: 'device-a' });

        const res = await request(buildApp())
            .post('/device')
            .set('Authorization', 'Bearer device-token')
            .send({});

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ device_id: 'device-a' });
    });
});
