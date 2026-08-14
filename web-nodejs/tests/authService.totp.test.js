/**
 * TOTP setup otpauth URI / QR payload (Issue #368)
 */

const mockAdapter = {
    getUserById: jest.fn(),
    saveTotpSecret: jest.fn(),
};

jest.mock('../services/dbAdapter', () => ({
    getAdapter: () => mockAdapter,
    DB_TYPE: 'sqlite',
}));

jest.mock('../config/config', () => ({
    dataDir: '/tmp',
    dbPath: '/tmp/test.db',
    dbType: 'sqlite',
}));

const { authenticator } = require('otplib');
const authService = require('../services/authService');

describe('buildTotpOtpauthUrl', () => {
    it('uses BetterDesk issuer without spaces and omits algorithm', () => {
        const uri = authService.buildTotpOtpauthUrl('admin', 'K5MQOUIXDV6D4BLCPFKQ6YRRJ4LQS43T');
        expect(uri).toMatch(/^otpauth:\/\/totp\/BetterDesk:admin\?/);
        expect(uri).not.toMatch(/ /);
        expect(uri).not.toMatch(/algorithm=/i);
        expect(uri).toContain('secret=K5MQOUIXDV6D4BLCPFKQ6YRRJ4LQS43T');
        expect(uri).toContain('issuer=BetterDesk');
        expect(uri).toContain('digits=6');
        expect(uri).toContain('period=30');
    });

    it('percent-encodes spaces in account name', () => {
        const uri = authService.buildTotpOtpauthUrl('admin user', 'ABCDEFGH');
        expect(uri).toContain('BetterDesk:admin%20user');
        expect(uri).not.toMatch(/BetterDesk:admin user/);
    });
});

describe('generateTotpSetup', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockAdapter.getUserById.mockResolvedValue({ id: 1, username: 'admin' });
        mockAdapter.saveTotpSecret.mockResolvedValue(undefined);
    });

    it('returns 20-byte secret, matching otpauth URI, and QR data URL', async () => {
        const result = await authService.generateTotpSetup(1);

        expect(result.success).toBe(true);
        expect(result.secret).toMatch(/^[A-Z2-7]{32}$/);
        expect(result.otpauthUrl).toMatch(/^otpauth:\/\/totp\/BetterDesk:admin\?/);
        expect(result.otpauthUrl).not.toMatch(/ /);
        expect(result.otpauthUrl).not.toMatch(/algorithm=/i);
        expect(result.otpauthUrl).toContain(`secret=${result.secret}`);
        expect(result.qrCode).toMatch(/^data:image\/png;base64,/);

        expect(mockAdapter.saveTotpSecret).toHaveBeenCalledWith(1, result.secret);

        const token = authenticator.generate(result.secret);
        expect(authenticator.verify({ token, secret: result.secret })).toBe(true);
    });

    it('returns error when user is missing', async () => {
        mockAdapter.getUserById.mockResolvedValue(null);
        const result = await authService.generateTotpSetup(999);
        expect(result).toEqual({ success: false, error: 'User not found' });
        expect(mockAdapter.saveTotpSecret).not.toHaveBeenCalled();
    });
});
