/**
 * BetterDesk Console - User Sync Tests
 */

const mockApiClient = {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
};

const mockDb = {
    type: 'sqlite',
    getDb: jest.fn(),
    getAuthDb: jest.fn(),
    getAllUsersForBackup: jest.fn(),
    getAllUsers: jest.fn(),
    getUserById: jest.fn(),
    syncUserFromGo: jest.fn(),
};

jest.mock('../services/betterdeskApi', () => ({ apiClient: mockApiClient }));
jest.mock('../services/database', () => mockDb);

const userSync = require('../services/userSync');

function createSqliteMock(goUsers = [], inserts = [], updates = []) {
    const goDb = {
        prepare: jest.fn((sql) => {
            if (sql.includes('sqlite_master')) return { get: jest.fn(() => ({ name: 'users' })) };
            if (sql.startsWith('PRAGMA table_info(users)')) {
                return { all: jest.fn(() => [
                    { name: 'id' }, { name: 'username' }, { name: 'password_hash' },
                    { name: 'role' }, { name: 'auth_provider' }, { name: 'totp_secret' }, { name: 'totp_enabled' },
                    { name: 'totp_recovery_codes' }, { name: 'created_at' }, { name: 'last_login' },
                ]) };
            }
            if (sql.startsWith('SELECT id FROM users')) {
                return {
                    get: jest.fn((username) => {
                        const user = goUsers.find(u => String(u.username || '').toLowerCase() === username);
                        return user ? { id: user.id } : undefined;
                    })
                };
            }
            if (sql.startsWith('SELECT')) return { all: jest.fn(() => goUsers) };
            if (sql.startsWith('UPDATE users SET totp_')) {
                return { run: jest.fn((...args) => updates.push({ sql, args })) };
            }
            throw new Error(`Unexpected Go DB SQL: ${sql}`);
        }),
    };

    const authDb = {
        prepare: jest.fn((sql) => ({
            run: jest.fn((...args) => inserts.push({ sql, args })),
        })),
    };

    return { goDb, authDb };
}

describe('userSync', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDb.type = 'sqlite';
    });

    it('restores missing local users from Go SQLite with preserved IDs and password hashes', async () => {
        const inserts = [];
        const { goDb, authDb } = createSqliteMock([
            {
                id: 7,
                username: 'operator1',
                password_hash: 'salt0123456789ab:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
                role: 'operator',
                totp_secret: 'SECRET',
                totp_enabled: 1,
                created_at: '2026-05-01T00:00:00Z',
                last_login: null,
            },
        ], inserts);
        mockDb.getDb.mockReturnValue(goDb);
        mockDb.getAuthDb.mockReturnValue(authDb);
        mockDb.getAllUsersForBackup.mockResolvedValue([{ id: 1, username: 'admin' }]);

        const result = await userSync.backfillFromGo();

        expect(result.imported).toBe(1);
        expect(inserts).toHaveLength(1);
        expect(inserts[0].args).toEqual([
            7,
            'operator1',
            'salt0123456789ab:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            'operator',
            'local',
            '2026-05-01T00:00:00Z',
            null,
            'SECRET',
            1,
        ]);
    });

    it('does not duplicate users that already exist locally by username', async () => {
        const inserts = [];
        const { goDb, authDb } = createSqliteMock([
            { id: 7, username: 'Operator1', password_hash: 'hash', role: 'operator' },
        ], inserts);
        mockDb.getDb.mockReturnValue(goDb);
        mockDb.getAuthDb.mockReturnValue(authDb);
        mockDb.getAllUsersForBackup.mockResolvedValue([{ id: 12, username: 'operator1', role: 'operator', auth_provider: 'local' }]);

        const result = await userSync.backfillFromGo();

        expect(result.imported).toBe(0);
        expect(inserts).toHaveLength(0);
    });

    it('resolves a local user ID to the matching Go user ID by username', async () => {
        mockDb.getUserById.mockResolvedValue({ id: 12, username: 'operator1' });
        mockApiClient.get.mockResolvedValue({
            data: [{ id: 7, username: 'operator1', role: 'operator' }],
        });

        await expect(userSync.resolveGoUserId(12)).resolves.toBe(7);
    });

    it('syncs auth_provider and role from Go API in PostgreSQL mode', async () => {
        mockDb.type = 'postgres';
        mockApiClient.get.mockResolvedValue({
            data: [
                { id: 7, username: 'aduser', role: 'operator', auth_provider: 'ldap' },
            ],
        });
        mockDb.getAllUsers.mockResolvedValue([
            { id: 12, username: 'aduser', role: 'viewer', auth_provider: 'local' },
        ]);
        mockDb.syncUserFromGo.mockResolvedValue(undefined);

        const result = await userSync.backfillFromGo();

        expect(result.synced).toBe(1);
        expect(mockDb.syncUserFromGo).toHaveBeenCalledWith(12, {
            authProvider: 'ldap',
            role: 'operator',
        });
    });

    it('mirrors TOTP enable directly to the existing Go SQLite user', async () => {
        const updates = [];
        const { goDb } = createSqliteMock([
            { id: 7, username: 'Admin', password_hash: 'hash', role: 'admin' },
        ], [], updates);
        mockDb.getDb.mockReturnValue(goDb);

        await userSync.mirrorTotpEnable('admin', { secret: 'SECRET123' });

        expect(updates).toHaveLength(1);
        expect(updates[0].sql).toContain('totp_enabled = 1');
        expect(updates[0].sql).toContain('totp_recovery_codes = NULL');
        expect(updates[0].args).toEqual(['SECRET123', 7]);
        expect(mockApiClient.post).not.toHaveBeenCalled();
        expect(mockApiClient.put).not.toHaveBeenCalled();
    });

    it('does not create a Go user when TOTP enable cannot find one', async () => {
        const updates = [];
        const { goDb } = createSqliteMock([], [], updates);
        mockDb.getDb.mockReturnValue(goDb);

        await userSync.mirrorTotpEnable('missing', { secret: 'SECRET123' });

        expect(updates).toHaveLength(0);
        expect(mockApiClient.post).not.toHaveBeenCalled();
        expect(mockApiClient.put).not.toHaveBeenCalled();
    });

    it('mirrors TOTP disable directly to the existing Go SQLite user', async () => {
        const updates = [];
        const { goDb } = createSqliteMock([
            { id: 7, username: 'admin', password_hash: 'hash', role: 'admin' },
        ], [], updates);
        mockDb.getDb.mockReturnValue(goDb);

        await userSync.mirrorTotpDisable('admin');

        expect(updates).toHaveLength(1);
        expect(updates[0].sql).toContain("totp_secret = ''");
        expect(updates[0].sql).toContain('totp_enabled = 0');
        expect(updates[0].args).toEqual([7]);
        expect(mockApiClient.post).not.toHaveBeenCalled();
        expect(mockApiClient.put).not.toHaveBeenCalled();
    });
});
