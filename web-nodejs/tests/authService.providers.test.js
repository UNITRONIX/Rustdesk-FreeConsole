/**
 * Auth provider helpers and database facade (Issue #148)
 */

const mockAdapter = {
    createUser: jest.fn(),
    syncUserFromGo: jest.fn(),
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

const authService = require('../services/authService');
const db = require('../services/database');

describe('authService provider helpers', () => {
    it('normalizeAuthProvider accepts ldap, oidc, local', () => {
        expect(authService.normalizeAuthProvider('LDAP')).toBe('ldap');
        expect(authService.normalizeAuthProvider('oidc')).toBe('oidc');
        expect(authService.normalizeAuthProvider('')).toBe('local');
        expect(authService.normalizeAuthProvider('saml')).toBe('local');
    });

    it('inferAuthProviderFromSSO prefers Go response auth_provider', () => {
        expect(authService.inferAuthProviderFromSSO(
            { auth_provider: 'ldap', role: 'operator' },
            { ldap: true, oidc: false, any: true }
        )).toBe('ldap');
    });

    it('inferAuthProviderFromSSO falls back to SSO status when Go omits provider', () => {
        expect(authService.inferAuthProviderFromSSO(
            { role: 'viewer' },
            { ldap: false, oidc: true, any: true }
        )).toBe('oidc');
        expect(authService.inferAuthProviderFromSSO(
            { role: 'viewer' },
            { ldap: true, oidc: false, any: true }
        )).toBe('ldap');
    });
});

describe('database facade auth_provider', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockAdapter.createUser.mockResolvedValue({ id: 1, username: 'u', role: 'viewer', auth_provider: 'ldap' });
        mockAdapter.syncUserFromGo.mockResolvedValue(undefined);
    });

    it('createUser forwards authProvider to the adapter', async () => {
        await db.createUser('aduser', 'hash', 'operator', 'ldap');
        expect(mockAdapter.createUser).toHaveBeenCalledWith('aduser', 'hash', 'operator', 'ldap');
    });

    it('syncUserFromGo is exposed on the facade', async () => {
        await db.syncUserFromGo(3, { authProvider: 'ldap', role: 'admin' });
        expect(mockAdapter.syncUserFromGo).toHaveBeenCalledWith(3, { authProvider: 'ldap', role: 'admin' });
    });
});
