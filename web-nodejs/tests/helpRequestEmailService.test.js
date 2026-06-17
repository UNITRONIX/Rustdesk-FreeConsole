'use strict';

jest.mock('../services/database', () => ({
    getSetting: jest.fn(),
    hasEmailNotificationSent: jest.fn(),
    logEmailNotificationSent: jest.fn(),
}));

jest.mock('../services/emailService', () => ({
    getAlertEmail: jest.fn(),
    sendHelpRequestEmail: jest.fn(),
}));

jest.mock('../services/deviceGroupService', () => ({
    resolveOperatorEmailsForDevice: jest.fn(),
    resolveFolderNameForDevice: jest.fn(),
}));

const db = require('../services/database');
const emailService = require('../services/emailService');
const deviceGroupService = require('../services/deviceGroupService');
const {
    handleHelpRequestEvent,
    parseCommercializationEmailConfig,
} = require('../services/helpRequestEmailService');

describe('helpRequestEmailService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        db.getSetting.mockResolvedValue(null);
        db.hasEmailNotificationSent.mockResolvedValue(false);
        db.logEmailNotificationSent.mockResolvedValue(undefined);
        deviceGroupService.resolveFolderNameForDevice.mockResolvedValue('Support');
        emailService.sendHelpRequestEmail.mockResolvedValue(true);
    });

    it('uses default config when setting is missing', () => {
        const cfg = parseCommercializationEmailConfig(null);
        expect(cfg.help_requests_enabled).toBe(true);
        expect(cfg.fallback_alert_email).toBe(true);
    });

    it('sends email to assigned operators', async () => {
        deviceGroupService.resolveOperatorEmailsForDevice.mockResolvedValue([
            { username: 'alice', email: 'alice@example.com' },
        ]);

        await handleHelpRequestEvent({
            id: '42',
            device_id: 'dev-1',
            hostname: 'PC-01',
            message: 'Need help',
        });

        expect(emailService.sendHelpRequestEmail).toHaveBeenCalledWith({
            to: 'alice@example.com',
            helpRequest: expect.objectContaining({ id: '42', device_id: 'dev-1' }),
            folderName: 'Support',
        });
        expect(db.logEmailNotificationSent).toHaveBeenCalledWith('help_request', '42', 'alice@example.com');
    });

    it('falls back to alert email when no operator addresses exist', async () => {
        deviceGroupService.resolveOperatorEmailsForDevice.mockResolvedValue([]);
        emailService.getAlertEmail.mockResolvedValue('ops@example.com');

        await handleHelpRequestEvent({
            id: '43',
            device_id: 'dev-2',
            hostname: 'PC-02',
            message: 'Need help',
        });

        expect(emailService.sendHelpRequestEmail).toHaveBeenCalledWith(
            expect.objectContaining({ to: 'ops@example.com' })
        );
    });

    it('skips duplicate sends for the same recipient', async () => {
        deviceGroupService.resolveOperatorEmailsForDevice.mockResolvedValue([
            { username: 'alice', email: 'alice@example.com' },
        ]);
        db.hasEmailNotificationSent.mockResolvedValue(true);

        await handleHelpRequestEvent({
            id: '44',
            device_id: 'dev-3',
            hostname: 'PC-03',
            message: 'Need help',
        });

        expect(emailService.sendHelpRequestEmail).not.toHaveBeenCalled();
    });
});
