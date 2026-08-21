/**
 * BetterDesk Console - Users Routes Tests
 */

const request = require('supertest');
const { createTestApp, withAuth } = require('./helpers');

const mockDb = {
    getAllUsers: jest.fn(),
    getUserById: jest.fn(),
    getUserByUsername: jest.fn(),
    getAllUserGroups: jest.fn(),
    getUserGroupByGuid: jest.fn(),
    createUserGroup: jest.fn(),
    updateUserGroup: jest.fn(),
    deleteUserGroup: jest.fn(),
    getUserGroupsForUser: jest.fn(),
    setUserGroupMemberships: jest.fn(),
    updateUserProfile: jest.fn().mockResolvedValue(undefined),
    updateUserRole: jest.fn().mockResolvedValue(undefined),
    createUser: jest.fn(),
    deleteUser: jest.fn().mockResolvedValue(undefined),
    countAdmins: jest.fn().mockResolvedValue(2),
    logAction: jest.fn().mockResolvedValue(undefined),
    getUserPeerGrants: jest.fn().mockResolvedValue([]),
    setUserPeerGrants: jest.fn().mockResolvedValue(undefined),
    getUserStrategyGuid: jest.fn().mockResolvedValue(''),
    setUserStrategyAssignment: jest.fn().mockResolvedValue(''),
    getAllFolders: jest.fn().mockResolvedValue([]),
};

const mockUserSync = {
    backfillFromGo: jest.fn().mockResolvedValue({ imported: 0 }),
    resolveGoUserId: jest.fn(),
    mirrorCreate: jest.fn(),
    mirrorUpdate: jest.fn(),
    mirrorDelete: jest.fn().mockResolvedValue({ ok: true }),
    assertGoAllowsSuperAdminDelete: jest.fn().mockResolvedValue({ ok: true }),
};

const mockApiClient = jest.fn();

jest.mock('../services/database', () => mockDb);
jest.mock('../services/userSync', () => mockUserSync);
jest.mock('../services/betterdeskApi', () => ({ apiClient: mockApiClient }));
jest.mock('../services/authService', () => ({
    validatePasswordStrength: jest.fn(() => ({ strength: 'strong', feedback: [] })),
    hashPassword: jest.fn().mockResolvedValue('hashed'),
}));
jest.mock('../middleware/rateLimiter', () => ({
    passwordChangeLimiter: (_req, _res, next) => next(),
}));

const usersRoutes = require('../routes/users.routes');

describe('Users Routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDb.getAllUsers.mockResolvedValue([
            { id: 1, username: 'admin', role: 'super_admin', created_at: '2026-05-01', last_login: null },
            { id: 12, username: 'operator1', role: 'operator', created_at: '2026-05-02', last_login: null },
        ]);
        mockDb.getAllUserGroups.mockResolvedValue([
            { guid: 'volunteers', name: 'Volunteers', member_count: 1 },
        ]);
        mockDb.getUserGroupByGuid.mockResolvedValue({ guid: 'volunteers', name: 'Volunteers', note: '', member_count: 1 });
        mockDb.createUserGroup.mockResolvedValue({ guid: 'new-group', name: 'New Group', note: 'Ops', member_count: 0 });
        mockDb.updateUserGroup.mockResolvedValue({ guid: 'volunteers', name: 'Field Operators', note: 'Updated', member_count: 1 });
        mockDb.deleteUserGroup.mockResolvedValue(true);
        mockDb.getUserByUsername.mockResolvedValue(null);
        mockDb.getUserGroupsForUser.mockImplementation(async (userId) => (
            Number(userId) === 12 ? [{ guid: 'volunteers', name: 'Volunteers' }] : []
        ));
        mockDb.setUserGroupMemberships.mockResolvedValue([]);
        mockDb.createUser.mockResolvedValue({ id: 22, username: 'viewer1', role: 'viewer' });
        mockDb.getUserPeerGrants.mockResolvedValue([]);
        mockDb.setUserPeerGrants.mockResolvedValue(undefined);
        mockDb.getUserStrategyGuid.mockResolvedValue('');
        mockDb.setUserStrategyAssignment.mockResolvedValue('');
        mockDb.getAllFolders.mockResolvedValue([]);
    });

    it('backfills Go users before returning the System Users list', async () => {
        const app = createTestApp();
        withAuth(app, { id: 1, username: 'admin', role: 'server_admin' });
        app.use(usersRoutes);

        const res = await request(app).get('/api/users');

        expect(res.status).toBe(200);
        expect(mockUserSync.backfillFromGo).toHaveBeenCalledTimes(1);
        expect(res.body.data.users).toHaveLength(2);
        expect(res.body.data.users[1].user_groups).toEqual(['volunteers']);
    });

    it('does not forbid server_admin from the Users management page', async () => {
        const app = createTestApp();
        withAuth(app, { id: 1, username: 'admin', role: 'server_admin' });
        app.use(usersRoutes);

        const res = await request(app).get('/users');

        expect(res.status).not.toBe(403);
        expect(res.status).not.toBe(401);
    });

    it('returns user groups for panel assignment UIs', async () => {
        const app = createTestApp();
        withAuth(app, { id: 1, username: 'admin', role: 'server_admin' });
        app.use(usersRoutes);

        const res = await request(app).get('/api/panel/user-groups');

        expect(res.status).toBe(200);
        expect(res.body.data.groups).toEqual([
            expect.objectContaining({ guid: 'volunteers', name: 'Volunteers' }),
        ]);
    });

    it('creates a user group from the panel API', async () => {
        const app = createTestApp();
        withAuth(app, { id: 1, username: 'admin', role: 'global_admin' });
        app.use(usersRoutes);

        const res = await request(app)
            .post('/api/panel/user-groups')
            .send({ name: 'New Group', note: 'Ops' });

        expect(res.status).toBe(200);
        expect(mockDb.createUserGroup).toHaveBeenCalledWith({ name: 'New Group', note: 'Ops', team_id: '' });
        expect(res.body.data.group).toEqual(expect.objectContaining({ guid: 'new-group', name: 'New Group' }));
    });

    it('updates a user group from the panel API', async () => {
        const app = createTestApp();
        withAuth(app, { id: 1, username: 'admin', role: 'global_admin' });
        app.use(usersRoutes);

        const res = await request(app)
            .patch('/api/panel/user-groups/volunteers')
            .send({ name: 'Field Operators', note: 'Updated' });

        expect(res.status).toBe(200);
        expect(mockDb.getUserGroupByGuid).toHaveBeenCalledWith('volunteers');
        expect(mockDb.updateUserGroup).toHaveBeenCalledWith('volunteers', { name: 'Field Operators', note: 'Updated', team_id: '' });
        expect(res.body.data.group).toEqual(expect.objectContaining({ guid: 'volunteers', name: 'Field Operators' }));
    });

    it('deletes a user group from the panel API', async () => {
        const app = createTestApp();
        withAuth(app, { id: 1, username: 'admin', role: 'global_admin' });
        app.use(usersRoutes);

        const res = await request(app).delete('/api/panel/user-groups/volunteers');

        expect(res.status).toBe(200);
        expect(mockDb.getUserGroupByGuid).toHaveBeenCalledWith('volunteers');
        expect(mockDb.deleteUserGroup).toHaveBeenCalledWith('volunteers');
    });

    it('stores user group memberships when creating a user', async () => {
        const app = createTestApp();
        withAuth(app, { id: 1, username: 'admin', role: 'global_admin' });
        app.use(usersRoutes);

        const res = await request(app)
            .post('/api/users')
            .send({ username: 'viewer1', password: 'StrongPass123!', role: 'viewer', groupGuids: ['volunteers'] });

        expect(res.status).toBe(200);
        expect(mockDb.createUser).toHaveBeenCalledWith('viewer1', 'hashed', 'viewer');
        expect(mockDb.setUserGroupMemberships).toHaveBeenCalledWith(22, ['volunteers']);
    });

    it('persists peerIds when creating a user (Issue #380)', async () => {
        mockDb.getUserPeerGrants.mockResolvedValue(['1234567']);

        const app = createTestApp();
        withAuth(app, { id: 1, username: 'admin', role: 'global_admin' });
        app.use(usersRoutes);

        const res = await request(app)
            .post('/api/users')
            .send({
                username: 'viewer1',
                password: 'StrongPass123!',
                role: 'operator',
                peerIds: ['1234567'],
            });

        expect(res.status).toBe(200);
        expect(mockDb.setUserPeerGrants).toHaveBeenCalledWith(22, ['1234567']);
        expect(res.body.data.peer_grants).toEqual(['1234567']);
    });

    it('persists peerIds when updating a user (Issue #380)', async () => {
        mockDb.getUserById.mockResolvedValue({
            id: 12,
            username: 'operator1',
            role: 'operator',
            auth_provider: 'local',
        });
        mockDb.getUserPeerGrants.mockResolvedValue(['1234567', '7654321']);

        const app = createTestApp();
        withAuth(app, { id: 1, username: 'admin', role: 'super_admin' });
        app.use(usersRoutes);

        const res = await request(app)
            .patch('/api/users/12')
            .send({ peerIds: ['1234567', '7654321'] });

        expect(res.status).toBe(200);
        expect(mockDb.setUserPeerGrants).toHaveBeenCalledWith(12, ['1234567', '7654321']);
        expect(res.body.data).toMatchObject({
            id: 12,
            username: 'operator1',
            peer_grants: ['1234567', '7654321'],
        });
    });

    it('returns 500 when peer grant setter is unavailable (no silent no-op)', async () => {
        const previous = mockDb.setUserPeerGrants;
        mockDb.setUserPeerGrants = undefined;

        try {
            const app = createTestApp();
            withAuth(app, { id: 1, username: 'admin', role: 'global_admin' });
            app.use(usersRoutes);

            const res = await request(app)
                .post('/api/users')
                .send({
                    username: 'viewer1',
                    password: 'StrongPass123!',
                    role: 'operator',
                    peerIds: ['1234567'],
                });

            expect(res.status).toBe(500);
            expect(res.body.success).toBe(false);
            expect(String(res.body.error || '')).toMatch(/peer grants|setUserPeerGrants/i);
            expect(mockDb.createUser).not.toHaveBeenCalled();
        } finally {
            mockDb.setUserPeerGrants = previous;
        }
    });

    it('returns 500 when strategy assignment setter is unavailable', async () => {
        mockDb.getUserById.mockResolvedValue({
            id: 12,
            username: 'operator1',
            role: 'operator',
            auth_provider: 'local',
        });
        const previous = mockDb.setUserStrategyAssignment;
        mockDb.setUserStrategyAssignment = undefined;

        try {
            const app = createTestApp();
            withAuth(app, { id: 1, username: 'admin', role: 'super_admin' });
            app.use(usersRoutes);

            const res = await request(app)
                .patch('/api/users/12')
                .send({ strategyGuid: 'strat-1', role: 'viewer' });

            expect(res.status).toBe(500);
            expect(res.body.success).toBe(false);
            expect(String(res.body.error || '')).toMatch(/strategy|setUserStrategyAssignment/i);
            expect(mockDb.updateUserRole).not.toHaveBeenCalled();
        } finally {
            mockDb.setUserStrategyAssignment = previous;
        }
    });

    it('returns peer_grants on the System Users list (Issue #380)', async () => {
        mockDb.getUserPeerGrants.mockImplementation(async (userId) => (
            Number(userId) === 12 ? ['1234567'] : []
        ));

        const app = createTestApp();
        withAuth(app, { id: 1, username: 'admin', role: 'server_admin' });
        app.use(usersRoutes);

        const res = await request(app).get('/api/users');

        expect(res.status).toBe(200);
        expect(mockDb.getUserPeerGrants).toHaveBeenCalled();
        expect(res.body.data.users[1].peer_grants).toEqual(['1234567']);
        expect(res.body.data.users[0].peer_grants).toEqual([]);
    });

    it('does not let global_admin create a super_admin user', async () => {
        const app = createTestApp();
        withAuth(app, { id: 1, username: 'global-admin', role: 'global_admin' });
        app.use(usersRoutes);

        const res = await request(app)
            .post('/api/users')
            .send({ username: 'elevated1', password: 'StrongPass123!', role: 'super_admin' });

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
        expect(mockDb.createUser).not.toHaveBeenCalled();
        expect(mockUserSync.mirrorCreate).not.toHaveBeenCalled();
    });

    it('does not let global_admin promote a user to super_admin', async () => {
        mockDb.getUserById.mockResolvedValue({
            id: 12,
            username: 'operator1',
            role: 'operator',
            auth_provider: 'local',
        });

        const app = createTestApp();
        withAuth(app, { id: 1, username: 'global-admin', role: 'global_admin' });
        app.use(usersRoutes);

        const res = await request(app)
            .patch('/api/users/12')
            .send({ role: 'super_admin' });

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
        expect(mockDb.updateUserRole).not.toHaveBeenCalled();
        expect(mockUserSync.mirrorUpdate).not.toHaveBeenCalled();
    });

    it('maps unique username constraint errors to username_exists', async () => {
        const uniqueErr = new Error('duplicate key value violates unique constraint "users_username_key"');
        uniqueErr.code = '23505';
        mockDb.createUser.mockRejectedValue(uniqueErr);

        const app = createTestApp();
        withAuth(app, { id: 1, username: 'admin', role: 'global_admin' });
        app.use(usersRoutes);

        const res = await request(app)
            .post('/api/users')
            .send({ username: 'Gerardo', password: 'StrongPass123!', role: 'viewer' });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(String(res.body.error || '')).toMatch(/exists|username/i);
        expect(mockUserSync.mirrorCreate).not.toHaveBeenCalled();
    });

    it('uses the Go user ID when assigning a local user to an organization', async () => {
        mockDb.getUserById.mockResolvedValue({ id: 12, username: 'operator1', role: 'operator' });
        mockUserSync.resolveGoUserId.mockResolvedValue(7);
        mockApiClient.mockResolvedValue({
            status: 201,
            data: { id: 'org-user-1', server_user_id: 7, org_id: 'org-1' },
        });

        const app = createTestApp();
        withAuth(app, { id: 1, username: 'admin', role: 'global_admin' });
        app.use(usersRoutes);

        const res = await request(app)
            .post('/api/users/12/organizations')
            .send({ org_id: 'org-1', role: 'operator' });

        expect(res.status).toBe(201);
        expect(mockApiClient).toHaveBeenCalledWith({
            method: 'post',
            url: '/users/7/organizations',
            data: { org_id: 'org-1', role: 'operator' },
        });
    });

    it('updates user email via PATCH', async () => {
        mockDb.getUserById.mockResolvedValue({
            id: 12,
            username: 'operator1',
            role: 'operator',
            auth_provider: 'local',
        });

        const app = createTestApp();
        withAuth(app, { id: 1, username: 'admin', role: 'super_admin' });
        app.use(usersRoutes);

        const res = await request(app)
            .patch('/api/users/12')
            .send({ email: 'operator1@example.com' });

        expect(res.status).toBe(200);
        expect(mockDb.updateUserProfile).toHaveBeenCalledWith(12, { email: 'operator1@example.com' });
    });

    it('rejects invalid email on PATCH', async () => {
        mockDb.getUserById.mockResolvedValue({
            id: 12,
            username: 'operator1',
            role: 'operator',
            auth_provider: 'local',
        });

        const app = createTestApp();
        withAuth(app, { id: 1, username: 'admin', role: 'super_admin' });
        app.use(usersRoutes);

        const res = await request(app)
            .patch('/api/users/12')
            .send({ email: 'not-an-email' });

        expect(res.status).toBe(400);
        expect(mockDb.updateUserProfile).not.toHaveBeenCalled();
    });

    it('deletes a user after successful Go mirror (Issue #315)', async () => {
        mockDb.getUserById.mockResolvedValue({
            id: 2,
            username: 'admin',
            role: 'admin',
            password_hash: 'hash',
        });
        mockDb.countAdmins.mockResolvedValue(2);
        mockUserSync.assertGoAllowsSuperAdminDelete.mockResolvedValue({ ok: true, goAdminCount: 2 });
        mockUserSync.mirrorDelete.mockResolvedValue({ ok: true });

        const app = createTestApp();
        withAuth(app, { id: 99, username: 'otheradmin', role: 'super_admin' });
        app.use(usersRoutes);

        const res = await request(app).delete('/api/users/2');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(mockUserSync.assertGoAllowsSuperAdminDelete).toHaveBeenCalledWith('admin');
        expect(mockUserSync.mirrorDelete).toHaveBeenCalledWith('admin');
        expect(mockDb.deleteUser).toHaveBeenCalledWith(2);
    });

    it('refuses delete when Go still has only one Super Admin (Issue #315)', async () => {
        mockDb.getUserById.mockResolvedValue({
            id: 2,
            username: 'admin',
            role: 'admin',
            password_hash: 'hash',
        });
        mockDb.countAdmins.mockResolvedValue(2);
        mockUserSync.assertGoAllowsSuperAdminDelete.mockResolvedValue({
            ok: false,
            status: 409,
            reason: 'last_admin_go',
            goAdminCount: 1,
        });

        const app = createTestApp();
        withAuth(app, { id: 99, username: 'otheradmin', role: 'super_admin' });
        app.use(usersRoutes);

        const res = await request(app).delete('/api/users/2');

        expect(res.status).toBe(409);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe('users.last_admin_go');
        expect(mockDb.deleteUser).not.toHaveBeenCalled();
        expect(mockUserSync.mirrorDelete).not.toHaveBeenCalled();
    });

    it('refuses delete and skips local delete when mirrorDelete returns 409', async () => {
        mockDb.getUserById.mockResolvedValue({
            id: 2,
            username: 'admin',
            role: 'admin',
            password_hash: 'hash',
        });
        mockDb.countAdmins.mockResolvedValue(2);
        mockUserSync.assertGoAllowsSuperAdminDelete.mockResolvedValue({ ok: true, goAdminCount: 2 });
        mockUserSync.mirrorDelete.mockResolvedValue({ ok: false, status: 409, conflict: true });

        const app = createTestApp();
        withAuth(app, { id: 99, username: 'otheradmin', role: 'super_admin' });
        app.use(usersRoutes);

        const res = await request(app).delete('/api/users/2');

        expect(res.status).toBe(409);
        expect(res.body.error).toBe('users.last_admin_go');
        expect(mockDb.deleteUser).not.toHaveBeenCalled();
    });

    it('blocks deleting the last local Super Admin', async () => {
        mockDb.getUserById.mockResolvedValue({
            id: 1,
            username: 'admin',
            role: 'super_admin',
        });
        mockDb.countAdmins.mockResolvedValue(1);

        const app = createTestApp();
        withAuth(app, { id: 99, username: 'operator', role: 'global_admin' });
        app.use(usersRoutes);

        const res = await request(app).delete('/api/users/1');

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('users.last_admin');
        expect(mockUserSync.assertGoAllowsSuperAdminDelete).not.toHaveBeenCalled();
        expect(mockDb.deleteUser).not.toHaveBeenCalled();
    });
});
