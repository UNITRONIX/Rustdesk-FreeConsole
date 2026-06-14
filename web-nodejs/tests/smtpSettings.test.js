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
