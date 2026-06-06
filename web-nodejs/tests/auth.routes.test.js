/**
 * BetterDesk Console - Auth Routes Tests
 */

const request = require('supertest');
const { createTestApp } = require('./helpers');

// Mock dependencies before requiring routes
jest.mock('../services/database', () => ({
    logAction: jest.fn().mockResolvedValue(undefined),
    getUser: jest.fn().mockResolvedValue(null),
    enableTotp: jest.fn().mockResolvedValue(undefined),
    disableTotp: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../services/authService', () => ({
    authenticate: jest.fn().mockResolvedValue(null),
    isAuthFailure: jest.fn((result) => !!(result && result.__authFailure)),
    changePassword: jest.fn().mockResolvedValue(true),
    hashPassword: jest.fn().mockResolvedValue('hashed'),
    generateRecoveryCodes: jest.fn().mockReturnValue(['CODE1', 'CODE2']),
    recordAttempt: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../middleware/rateLimiter', () => ({
    loginLimiter: (_req, _res, next) => next(),
    passwordChangeLimiter: (_req, _res, next) => next(),
    apiLimiter: (_req, _res, next) => next()
}));

const authService = require('../services/authService');
const db = require('../services/database');
const authRoutes = require('../routes/auth.routes');

describe('Auth Routes', () => {
    let app;

    beforeEach(() => {
        app = createTestApp();
        app.use('/', authRoutes);
        jest.clearAllMocks();
    });

    describe('POST /api/auth/login', () => {
        it('should return 400 when username is missing', async () => {
            const res = await request(app)
                .post('/api/auth/login')
                .send({ password: 'test123' });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
        });

        it('should return 400 when password is missing', async () => {
            const res = await request(app)
                .post('/api/auth/login')
                .send({ username: 'admin' });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
        });

        it('should return 400 when username exceeds 128 chars', async () => {
            const res = await request(app)
                .post('/api/auth/login')
                .send({ username: 'a'.repeat(129), password: 'test123' });

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
        });

        it('should return 401 when credentials are invalid', async () => {
            authService.authenticate.mockResolvedValue(null);

            const res = await request(app)
                .post('/api/auth/login')
                .send({ username: 'admin', password: 'wrong' });

            expect(res.status).toBe(401);
            expect(res.body.success).toBe(false);
            expect(db.logAction).toHaveBeenCalledWith(
                null, 'login_failed', expect.stringContaining('admin'), expect.anything()
            );
        });

        it('should return 409 when local/SSO username collision is detected', async () => {
            authService.authenticate.mockResolvedValue({ __authFailure: 'username_collision' });

            const res = await request(app)
                .post('/api/auth/login')
                .send({ username: 'domainuser', password: 'ad-pass' });

            expect(res.status).toBe(409);
            expect(res.body.success).toBe(false);
            expect(res.body.code).toBe('username_collision');
            expect(db.logAction).toHaveBeenCalledWith(
                null, 'login_failed', expect.stringContaining('collision'), expect.anything()
            );
        });

        it('should return 200 with user on valid login', async () => {
            authService.authenticate.mockResolvedValue({
                id: 1,
                username: 'admin',
                role: 'admin'
            });

            const res = await request(app)
                .post('/api/auth/login')
                .send({ username: 'admin', password: 'correct' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.user).toBeDefined();
            expect(res.body.user.username).toBe('admin');
        });

        it('should return totpRequired when 2FA is enabled', async () => {
            authService.authenticate.mockResolvedValue({
                id: 1,
                username: 'admin',
                role: 'admin',
                totpRequired: true
            });

            const res = await request(app)
                .post('/api/auth/login')
                .send({ username: 'admin', password: 'correct' });

            expect(res.status).toBe(200);
            expect(res.body.totpRequired).toBe(true);
        });
    });

    describe('POST /api/auth/logout', () => {
        it('should destroy session on logout', async () => {
            // Set up auth
            app.use((req, _res, next) => {
                req.session.userId = 1;
                req.session.user = { id: 1, username: 'admin', role: 'admin' };
                next();
            });
            // Re-mount routes after auth middleware
            const logoutApp = createTestApp();
            logoutApp.use((req, _res, next) => {
                req.session.userId = 1;
                req.session.user = { id: 1, username: 'admin', role: 'admin' };
                next();
            });
            logoutApp.use('/', authRoutes);

            const res = await request(logoutApp)
                .post('/api/auth/logout');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });
    });
});
