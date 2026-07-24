/**
 * BetterDesk Console - Auth Routes Tests
 */

const request = require('supertest');
const { createTestApp } = require('./helpers');

// Mock dependencies before requiring routes
jest.mock('../services/database', () => ({
    logAction: jest.fn().mockResolvedValue(undefined),
    getUser: jest.fn().mockResolvedValue(null),
    getUserById: jest.fn().mockResolvedValue({ id: 1, username: 'admin', role: 'admin', password_hash: 'hash', totp_secret: 'SECRET' }),
    getUserByUsername: jest.fn().mockResolvedValue(null),
    createUser: jest.fn().mockResolvedValue(undefined),
    syncUserFromGo: jest.fn().mockResolvedValue(undefined),
    enableTotp: jest.fn().mockResolvedValue(undefined),
    disableTotp: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../services/authService', () => ({
    authenticate: jest.fn().mockResolvedValue(null),
    isAuthFailure: jest.fn((result) => !!(result && result.__authFailure)),
    changePassword: jest.fn().mockResolvedValue({ success: true }),
    hashPassword: jest.fn().mockResolvedValue('hashed'),
    verifyPassword: jest.fn().mockResolvedValue(true),
    verifyAndEnableTotp: jest.fn().mockResolvedValue({ success: true, recoveryCodes: ['CODE1', 'CODE2'] }),
    disableTotp: jest.fn().mockResolvedValue({ success: true }),
    isTotpEnabled: jest.fn().mockResolvedValue(false),
    generateTotpSetup: jest.fn().mockResolvedValue({ success: true, qrCode: 'qr', secret: 'SECRET', otpauthUrl: 'otpauth://totp/test' }),
    generateRecoveryCodes: jest.fn().mockReturnValue(['CODE1', 'CODE2']),
    recordAttempt: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../services/userSync', () => ({
    mirrorUpdate: jest.fn().mockResolvedValue(undefined),
    mirrorTotpEnable: jest.fn().mockResolvedValue(undefined),
    mirrorTotpDisable: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../middleware/rateLimiter', () => ({
    loginLimiter: (_req, _res, next) => next(),
    passwordChangeLimiter: (_req, _res, next) => next(),
    apiLimiter: (_req, _res, next) => next()
}));

jest.mock('../services/betterdeskApi', () => ({
    exchangeOIDCCode: jest.fn(),
    getOIDCStatus: jest.fn().mockResolvedValue({ success: true, data: { enabled: false } }),
    startOIDCAuthorize: jest.fn(),
}));

const authService = require('../services/authService');
const db = require('../services/database');
const userSync = require('../services/userSync');
const betterdeskApi = require('../services/betterdeskApi');
const authRoutes = require('../routes/auth.routes');

describe('Auth Routes', () => {
    let app;

    beforeEach(() => {
        app = createTestApp();
        app.use('/', authRoutes);
        jest.clearAllMocks();
    });

    function authenticatedApp(user = { id: 1, username: 'admin', role: 'admin' }) {
        const authed = createTestApp();
        authed.use((req, _res, next) => {
            req.session.userId = user.id;
            req.session.user = user;
            next();
        });
        authed.use('/', authRoutes);
        return authed;
    }

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

    describe('POST /api/auth/password', () => {
        it('mirrors successful self-service password changes to Go', async () => {
            const res = await request(authenticatedApp())
                .post('/api/auth/password')
                .send({
                    currentPassword: 'old-password',
                    newPassword: 'new-password-123',
                    confirmPassword: 'new-password-123'
                });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(userSync.mirrorUpdate).toHaveBeenCalledWith('admin', { password: 'new-password-123' });
        });

        it('does not fail password changes when Go mirror is unavailable', async () => {
            userSync.mirrorUpdate.mockRejectedValueOnce(new Error('go offline'));

            const res = await request(authenticatedApp())
                .post('/api/auth/password')
                .send({
                    currentPassword: 'old-password',
                    newPassword: 'new-password-123',
                    confirmPassword: 'new-password-123'
                });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });
    });

    describe('POST /api/auth/totp/enable', () => {
        it('mirrors enabled TOTP state to Go without issuing tokens', async () => {
            const res = await request(authenticatedApp())
                .post('/api/auth/totp/enable')
                .send({ code: '123456' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(userSync.mirrorTotpEnable).toHaveBeenCalledWith('admin', { secret: 'SECRET' });
        });
    });

    describe('POST /api/auth/totp/disable', () => {
        it('mirrors disabled TOTP state to Go after password verification', async () => {
            const res = await request(authenticatedApp())
                .post('/api/auth/totp/disable')
                .send({ password: 'current-password' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(authService.verifyPassword).toHaveBeenCalledWith('current-password', expect.anything());
            expect(userSync.mirrorTotpDisable).toHaveBeenCalledWith('admin');
        });
    });

    describe('GET /api/auth/oidc/authorize', () => {
        it('redirects the browser to the IdP URL from Go (not localhost API)', async () => {
            const idpUrl = 'https://idp.example.com/oauth/authorize?client_id=abc&redirect_uri=https%3A%2F%2Fdomain.com%2Fapi%2Fauth%2Foidc%2Fcallback';
            betterdeskApi.startOIDCAuthorize.mockResolvedValue({
                success: true,
                data: { auth_url: idpUrl },
            });

            const res = await request(app).get('/api/auth/oidc/authorize?return_url=%2Fdashboard');

            expect(res.status).toBe(302);
            expect(res.headers.location).toBe(idpUrl);
            expect(res.headers.location).not.toMatch(/localhost|127\.0\.0\.1/);
            expect(betterdeskApi.startOIDCAuthorize).toHaveBeenCalledWith('/dashboard');
        });

        it('sanitizes unsafe return_url before calling Go', async () => {
            betterdeskApi.startOIDCAuthorize.mockResolvedValue({
                success: true,
                data: { auth_url: 'https://idp.example.com/auth' },
            });

            await request(app).get('/api/auth/oidc/authorize?return_url=https://evil.example');

            expect(betterdeskApi.startOIDCAuthorize).toHaveBeenCalledWith('/');
        });

        it('redirects to oidc_error when Go authorize fails', async () => {
            betterdeskApi.startOIDCAuthorize.mockResolvedValue({
                success: false,
                error: 'OIDC is not enabled',
            });

            const res = await request(app).get('/api/auth/oidc/authorize');

            expect(res.status).toBe(302);
            expect(res.headers.location).toBe('/login?error=oidc_error');
        });

        it('redirects to oidc_error when auth_url is missing', async () => {
            betterdeskApi.startOIDCAuthorize.mockResolvedValue({ success: true, data: {} });

            const res = await request(app).get('/api/auth/oidc/authorize');

            expect(res.status).toBe(302);
            expect(res.headers.location).toBe('/login?error=oidc_error');
        });
    });

    describe('GET /api/auth/oidc/session', () => {
        it('redirects to oidc_invalid when code is missing', async () => {
            const res = await request(app).get('/api/auth/oidc/session');

            expect(res.status).toBe(302);
            expect(res.headers.location).toBe('/login?error=oidc_invalid');
            expect(betterdeskApi.exchangeOIDCCode).not.toHaveBeenCalled();
        });

        it('redirects to oidc_invalid when Go exchange fails', async () => {
            betterdeskApi.exchangeOIDCCode.mockResolvedValue({ success: false, error: 'invalid or expired code' });

            const res = await request(app).get('/api/auth/oidc/session?code=bad-code');

            expect(res.status).toBe(302);
            expect(res.headers.location).toBe('/login?error=oidc_invalid');
            expect(betterdeskApi.exchangeOIDCCode).toHaveBeenCalledWith('bad-code');
        });

        it('creates an OIDC session and redirects to the safe return URL', async () => {
            betterdeskApi.exchangeOIDCCode.mockResolvedValue({
                success: true,
                data: {
                    token: 'go-jwt-token',
                    username: 'sso-user',
                    role: 'operator',
                    return_url: '/dashboard',
                },
            });
            db.getUserByUsername.mockResolvedValue({
                id: 42,
                username: 'sso-user',
                role: 'viewer',
                preferred_language: null,
            });

            const agent = request.agent(app);
            const res = await agent.get('/api/auth/oidc/session?code=valid-code');

            expect(res.status).toBe(302);
            expect(res.headers.location).toBe('/dashboard');
            expect(betterdeskApi.exchangeOIDCCode).toHaveBeenCalledWith('valid-code');
            expect(db.syncUserFromGo).toHaveBeenCalledWith(42, {
                role: 'operator',
                authProvider: 'oidc',
            });

            const verify = await agent.get('/api/auth/verify');
            expect(verify.status).toBe(200);
            expect(verify.body.success).toBe(true);
            expect(verify.body.user).toEqual({
                id: 42,
                username: 'sso-user',
                role: 'operator',
                preferred_language: null,
            });
        });
    });
});
