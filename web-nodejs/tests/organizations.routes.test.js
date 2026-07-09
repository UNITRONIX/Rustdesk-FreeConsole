const request = require('supertest');

jest.mock('../services/betterdeskApi', () => ({
    apiClient: jest.fn(),
}));

jest.mock('../services/userSync', () => ({
    resolveGoUserId: jest.fn(),
}));

const { apiClient } = require('../services/betterdeskApi');
const { createTestApp, withAuth } = require('./helpers');
const organizationsRoutes = require('../routes/organizations.routes');

describe('Organizations Routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('returns 401 for unauthenticated organization API requests', async () => {
        const app = createTestApp();
        app.use(organizationsRoutes);

        const res = await request(app).get('/api/panel/org');

        expect(res.status).toBe(401);
        expect(res.body.error).toBe('Unauthorized. Please log in.');
    });

    it('returns 403 for non-admin organization writes', async () => {
        const app = createTestApp();
        withAuth(app, { id: 2, username: 'operator1', role: 'operator' });
        app.use(organizationsRoutes);

        const res = await request(app)
            .post('/api/panel/org')
            .send({ name: 'Ops', slug: 'ops' });

        expect(res.status).toBe(403);
        expect(res.body.error).toBe('Permission denied: org.create');
    });

    it('proxies organization list requests to the Go API', async () => {
        apiClient.mockResolvedValue({
            status: 200,
            data: { organizations: [{ id: 'org-1', name: 'Acme' }] },
        });

        const app = createTestApp();
        withAuth(app);
        app.use(organizationsRoutes);

        const res = await request(app).get('/api/panel/org');

        expect(res.status).toBe(200);
        expect(res.body.organizations).toHaveLength(1);
        expect(apiClient).toHaveBeenCalledWith({ method: 'get', url: '/org' });
    });

    it('forwards Go API failures for organization detail requests', async () => {
        apiClient.mockRejectedValue({
            response: {
                status: 502,
                data: { error: 'Upstream failure' },
            },
        });

        const app = createTestApp();
        withAuth(app);
        app.use(organizationsRoutes);

        const res = await request(app).get('/api/panel/org/org-42');

        expect(res.status).toBe(502);
        expect(res.body.error).toBe('Upstream failure');
        expect(apiClient).toHaveBeenCalledWith({ method: 'get', url: '/org/org-42' });
    });

    it('rejects path-smuggling org ids before proxying', async () => {
        const app = createTestApp();
        withAuth(app);
        app.use(organizationsRoutes);

        const res = await request(app).get('/api/panel/org/foo%2Fbar');

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/Invalid orgId/i);
        expect(apiClient).not.toHaveBeenCalled();
    });

    it('rejects invalid org id on organization detail page', async () => {
        const app = createTestApp();
        withAuth(app);
        app.use(organizationsRoutes);

        const res = await request(app).get('/organizations/foo%3Cbar%3E');

        expect(res.status).toBe(400);
        expect(res.text).not.toMatch(/foo&lt;bar&gt;/);
    });
});