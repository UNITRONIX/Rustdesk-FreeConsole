'use strict';

const request = require('supertest');
const { createTestApp, withAuth } = require('./helpers');

const mockDb = {
    getSetting: jest.fn(),
    setSetting: jest.fn().mockResolvedValue(undefined),
    logAction: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../services/database', () => mockDb);
jest.mock('../services/betterdeskApi', () => ({ apiClient: jest.fn() }));
jest.mock('../lib/smtpSettingsHandlers', () => ({
    getSmtpSettings: (_req, res) => res.json({ configured: true, host: 'smtp.test' }),
}));

const commercializationRoutes = require('../routes/commercialization.routes');

describe('Commercialization email config routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDb.getSetting.mockResolvedValue(JSON.stringify({
            help_requests_enabled: true,
            notify_assigned_operators: true,
            fallback_alert_email: false,
            include_folder_in_subject: true,
        }));
    });

    it('returns email notification config', async () => {
        const app = createTestApp();
        withAuth(app, { id: 1, username: 'admin', role: 'global_admin' });
        app.use(commercializationRoutes);

        const res = await request(app).get('/api/panel/commercialization/email-config');
        expect(res.status).toBe(200);
        expect(res.body.config.fallback_alert_email).toBe(false);
    });

    it('persists email notification config', async () => {
        const app = createTestApp();
        withAuth(app, { id: 1, username: 'admin', role: 'global_admin' });
        app.use(commercializationRoutes);

        const res = await request(app)
            .put('/api/panel/commercialization/email-config')
            .send({ help_requests_enabled: false, notify_assigned_operators: true });

        expect(res.status).toBe(200);
        expect(mockDb.setSetting).toHaveBeenCalledWith(
            'commercialization_email_config',
            expect.stringContaining('"help_requests_enabled":false')
        );
    });
});
