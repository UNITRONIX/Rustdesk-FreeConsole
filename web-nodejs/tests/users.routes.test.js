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
    createUser: jest.fn(),
    logAction: jest.fn().mockResolvedValue(undefined),
};

const mockUserSync = {
    backfillFromGo: jest.fn().mockResolvedValue({ imported: 0 }),
    resolveGoUserId: jest.fn(),
    mirrorCreate: jest.fn(),
    mirrorUpdate: jest.fn(),
    mirrorDelete: jest.fn(),
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
});
