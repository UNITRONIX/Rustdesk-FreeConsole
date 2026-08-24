'use strict';

/**
 * readAdminCredentialsFile prefers keysPath over dataDir (issue #385).
 */

jest.mock('bcrypt', () => ({
    hash: jest.fn(async () => '$2b$12$mock'),
    compare: jest.fn(async () => true)
}));

jest.mock('../config/config', () => ({
    keysPath: '/opt/rustdesk',
    dataDir: '/app/data',
}));

jest.mock('../services/database', () => ({}));

jest.mock('fs', () => ({
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
}));

const fs = require('fs');
const authService = require('../services/authService');

describe('readAdminCredentialsFile', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.DOCKER;
    });

    test('prefers keysPath credentials over dataDir when both exist', () => {
        fs.existsSync.mockImplementation((filePath) => {
            return filePath.endsWith('.admin_credentials');
        });
        fs.readFileSync.mockImplementation((filePath) => {
            const normalized = filePath.replace(/\\/g, '/');
            if (normalized.includes('/opt/rustdesk/')) {
                return 'Admin Username: admin\nAdmin Password: from-rustdesk\n';
            }
            if (normalized.includes('/app/data/')) {
                return 'Admin Username: admin\nAdmin Password: from-console\n';
            }
            return '';
        });

        expect(authService.readAdminCredentialsFile()).toBe('from-rustdesk');
    });

    test('returns null when no credentials file exists', () => {
        fs.existsSync.mockReturnValue(false);
        expect(authService.readAdminCredentialsFile()).toBeNull();
    });
});
