'use strict';

const request = require('supertest');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const { withAuth } = require('./helpers');
const { csrfTokenProvider, doubleCsrfProtection } = require('../middleware/csrf');
const commercializationRoutes = require('../routes/commercialization.routes');

jest.mock('../services/database', () => ({
    getSetting: jest.fn(),
    setSetting: jest.fn().mockResolvedValue(undefined),
    logAction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/betterdeskApi', () => ({ apiClient: jest.fn() }));
jest.mock('../lib/goApiProxy', () => ({
    proxyToGo: (_c, _req, res) => res.json({ ok: true }),
    proxyBinaryToGo: jest.fn(),
    safeSegment: (v) => v,
}));
jest.mock('../services/billingClockConfigService', () => ({
    getClockSettings: () => ({ ntp_servers: 'pool.ntp.org', max_skew_ms: 2000 }),
    saveClockSettings: jest.fn().mockResolvedValue({ settings: {}, restart: {} }),
}));
jest.mock('../lib/smtpSettingsHandlers', () => ({
    getSmtpSettings: (_req, res) => res.json({ configured: true }),
}));

function createCsrfApp() {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(session({
        secret: 'test-csrf-secret-key-32chars!!',
        resave: false,
        saveUninitialized: true,
        cookie: { secure: false },
    }));
    app.use((req, _res, next) => {
        req.t = (key) => key;
        next();
    });
    app.use(csrfTokenProvider);
    app.use((req, res, next) => doubleCsrfProtection(req, res, next));
    app.use((err, req, res, next) => {
        if (err.code === 'EBADCSRFTOKEN' || err.message?.includes('csrf') || err.message?.includes('CSRF')) {
            return res.status(403).json({ success: false, error: 'Invalid CSRF token. Please refresh the page and try again.' });
        }
        next(err);
    });
    return app;
}

describe('Commercialization CSRF protection', () => {
    it('rejects PUT clock settings without CSRF token', async () => {
        const app = createCsrfApp();
        withAuth(app, { id: 1, username: 'admin', role: 'global_admin' });
        app.use(commercializationRoutes);

        const res = await request(app)
            .put('/api/panel/billing/clock/settings')
            .send({ ntp_servers: 'pool.ntp.org', max_skew_ms: 2000 });

        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/CSRF/i);
    });
});
