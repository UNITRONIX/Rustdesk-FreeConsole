'use strict';

const request = require('supertest');
const express = require('express');
const { createTestApp, withAuth } = require('./helpers');

const mockAdapter = {
    getSetting: jest.fn(),
    setSetting: jest.fn().mockResolvedValue(undefined),
    logAction: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../services/dbAdapter', () => ({
    getAdapter: () => mockAdapter,
}));

jest.mock('../services/emailService', () => ({
    loadSmtpConfig: jest.fn(),
    resetTransporter: jest.fn(),
    testConnection: jest.fn().mockResolvedValue({ success: true }),
}));

const emailService = require('../services/emailService');
const { getSmtpSettings, putSmtpSettings, testSmtpSettings } = require('../lib/smtpSettingsHandlers');

describe('SMTP settings handlers', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
        withAuth(app, { id: 1, username: 'admin', role: 'server_admin' });
        app.get('/smtp', getSmtpSettings);
        app.put('/smtp', putSmtpSettings);
        app.post('/smtp/test', testSmtpSettings);
    });

    it('returns configured=false when SMTP is missing', async () => {
        emailService.loadSmtpConfig.mockResolvedValue(null);
        const res = await request(app).get('/smtp');
        expect(res.status).toBe(200);
        expect(res.body.configured).toBe(false);
    });

    it('masks SMTP password on read', async () => {
        emailService.loadSmtpConfig.mockResolvedValue({
            host: 'smtp.example.com',
            port: 587,
            secure: false,
            user: 'user',
            pass: 'secret',
            from: 'from@example.com',
            alert_email: 'ops@example.com',
        });
        const res = await request(app).get('/smtp');
        expect(res.body.configured).toBe(true);
        expect(res.body.pass).toBe('********');
        expect(res.body.alert_email).toBe('ops@example.com');
    });

    it('preserves existing password when masked value is submitted', async () => {
        mockAdapter.getSetting.mockResolvedValue(JSON.stringify({
            host: 'smtp.example.com',
            port: 587,
            secure: false,
            user: 'user',
            pass: 'existing-secret',
            from: 'from@example.com',
        }));

        const res = await request(app).put('/smtp').send({
            host: 'smtp.example.com',
            port: 587,
            secure: false,
            user: 'user',
            pass: '********',
            from: 'from@example.com',
            alert_email: 'ops@example.com',
        });

        expect(res.status).toBe(200);
        expect(mockAdapter.setSetting).toHaveBeenCalledWith(
            'smtp_config',
            expect.stringContaining('"pass":"existing-secret"')
        );
    });

    it('tests SMTP connection', async () => {
        const res = await request(app).post('/smtp/test');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

/** Same logic as routes/index.js requireJsonContentType */
function requireJsonContentType(req, res, next) {
    if (['GET', 'DELETE', 'OPTIONS', 'HEAD'].includes(req.method)) {
        return next();
    }
    if (!req.path.startsWith('/api/')) {
        return next();
    }
    if (req.path.includes('/upload') || req.path.includes('/import')) {
        return next();
    }
    if (!req.is('application/json')) {
        return res.status(415).json({
            success: false,
            error: 'Content-Type must be application/json',
        });
    }
    next();
}

describe('SMTP test route JSON Content-Type enforcement', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = createTestApp();
        withAuth(app, { id: 1, username: 'admin', role: 'server_admin' });
        app.use(requireJsonContentType);
        app.post('/api/settings/email/smtp/test', testSmtpSettings);
    });

    it('returns 415 when POST has no Content-Type header', async () => {
        const res = await request(app).post('/api/settings/email/smtp/test');
        expect(res.status).toBe(415);
        expect(res.body.error).toBe('Content-Type must be application/json');
        expect(emailService.testConnection).not.toHaveBeenCalled();
    });

    it('allows POST with application/json Content-Type', async () => {
        const res = await request(app)
            .post('/api/settings/email/smtp/test')
            .set('Content-Type', 'application/json')
            .send({});
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(emailService.testConnection).toHaveBeenCalled();
    });
});
