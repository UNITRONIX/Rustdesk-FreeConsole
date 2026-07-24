/**
 * BetterDesk Console - Auth Middleware Tests
 */

const request = require('supertest');
const { createTestApp } = require('./helpers');

const { requireAuth, requireRole, guestOnly, requireRdClientAuth, rdClientGuestOnly, normalizeRdClientReturnUrl, isSafeRdClientReturnUrl } = require('../middleware/auth');
const { apiLimiter, rdClientPageLimiter } = require('../middleware/rateLimiter');

describe('Auth Middleware', () => {
    describe('requireAuth', () => {
        it('should return 401 for unauthenticated API requests', async () => {
            const app = createTestApp();
            app.get('/api/test', requireAuth, (_req, res) => {
                res.json({ success: true });
            });

            const res = await request(app).get('/api/test');

            expect(res.status).toBe(401);
            expect(res.body.success).toBe(false);
        });

        it('should redirect to login for unauthenticated HTML requests', async () => {
            const app = createTestApp();
            app.get('/dashboard', requireAuth, (_req, res) => {
                res.send('OK');
            });

            const res = await request(app).get('/dashboard');

            expect(res.status).toBe(302);
            expect(res.headers.location).toBe('/login');
        });

        it('should pass through for authenticated requests', async () => {
            const app = createTestApp();
            app.use((req, _res, next) => {
                req.session.userId = 1;
                req.session.user = { id: 1, username: 'admin', role: 'admin' };
                next();
            });
            app.get('/api/test', requireAuth, (_req, res) => {
                res.json({ success: true });
            });

            const res = await request(app).get('/api/test');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });
    });

    describe('requireRole', () => {
        it('should allow admin access to admin-only routes', async () => {
            const app = createTestApp();
            app.use((req, _res, next) => {
                req.session.userId = 1;
                req.session.user = { id: 1, username: 'admin', role: 'admin' };
                next();
            });
            app.get('/api/admin', requireRole('admin'), (_req, res) => {
                res.json({ success: true });
            });

            const res = await request(app).get('/api/admin');

            expect(res.status).toBe(200);
        });

        it('should deny operator access to admin-only routes', async () => {
            const app = createTestApp();
            app.use((req, _res, next) => {
                req.session.userId = 2;
                req.session.user = { id: 2, username: 'operator1', role: 'operator' };
                next();
            });
            app.get('/api/admin', requireRole('admin'), (_req, res) => {
                res.json({ success: true });
            });

            const res = await request(app).get('/api/admin');

            expect(res.status).toBe(403);
        });

        it('should allow admin to access operator routes', async () => {
            const app = createTestApp();
            app.use((req, _res, next) => {
                req.session.userId = 1;
                req.session.user = { id: 1, username: 'admin', role: 'admin' };
                next();
            });
            app.get('/api/op', requireRole('operator'), (_req, res) => {
                res.json({ success: true });
            });

            const res = await request(app).get('/api/op');

            expect(res.status).toBe(200);
        });

        it('should return 401 for unauthenticated API requests', async () => {
            const app = createTestApp();
            app.get('/api/admin', requireRole('admin'), (_req, res) => {
                res.json({ success: true });
            });

            const res = await request(app).get('/api/admin');

            expect(res.status).toBe(401);
        });
    });

    describe('guestOnly', () => {
        it('should allow unauthenticated users', async () => {
            const app = createTestApp();
            app.get('/login', guestOnly, (_req, res) => {
                res.send('login page');
            });

            const res = await request(app).get('/login');

            expect(res.status).toBe(200);
        });

        it('should redirect authenticated users to dashboard', async () => {
            const app = createTestApp();
            app.use((req, _res, next) => {
                req.session.userId = 1;
                req.session.user = { id: 1, username: 'admin', role: 'admin' };
                next();
            });
            app.get('/login', guestOnly, (_req, res) => {
                res.send('login page');
            });

            const res = await request(app).get('/login');

            expect(res.status).toBe(302);
            expect(res.headers.location).toBe('/');
        });
    });

    describe('requireRdClientAuth', () => {
        it('should redirect unauthenticated HTML requests to /remote/login', async () => {
            const app = createTestApp();
            app.get('/remote', rdClientPageLimiter, requireRdClientAuth('device.connect'), (_req, res) => {
                res.send('OK');
            });

            const res = await request(app).get('/remote');

            expect(res.status).toBe(302);
            expect(res.headers.location).toBe('/remote/login?return=%2Fremote');
        });

        it('should return 401 for unauthenticated API requests', async () => {
            const app = createTestApp();
            app.get('/api/remote/sessions', apiLimiter, requireRdClientAuth(), (_req, res) => {
                res.json({ sessions: [] });
            });

            const res = await request(app).get('/api/remote/sessions');

            expect(res.status).toBe(401);
        });

        it('should pass through for authenticated operator with permission', async () => {
            const app = createTestApp();
            app.use((req, _res, next) => {
                req.session.userId = 2;
                req.session.user = { id: 2, username: 'operator1', role: 'operator' };
                next();
            });
            app.get('/remote', rdClientPageLimiter, requireRdClientAuth('device.connect'), (_req, res) => {
                res.send('OK');
            });

            const res = await request(app).get('/remote');

            expect(res.status).toBe(200);
        });
    });

    describe('isSafeRdClientReturnUrl', () => {
        it('should accept /remote paths only', () => {
            expect(isSafeRdClientReturnUrl('/remote')).toBe(true);
            expect(isSafeRdClientReturnUrl('/remote/abc123')).toBe(true);
            expect(isSafeRdClientReturnUrl('/remote?transport=cdap')).toBe(true);
            expect(isSafeRdClientReturnUrl('/login')).toBe(false);
            expect(isSafeRdClientReturnUrl('/remoteevil')).toBe(false);
            expect(isSafeRdClientReturnUrl('/remote/login')).toBe(false);
            expect(isSafeRdClientReturnUrl('//evil.com/remote')).toBe(false);
            expect(isSafeRdClientReturnUrl('/remote/%0aevil')).toBe(false);
        });

        it('should normalize safe return URLs', () => {
            expect(normalizeRdClientReturnUrl('/remote/dev1?transport=cdap')).toBe('/remote/dev1?transport=cdap');
            expect(normalizeRdClientReturnUrl('https://evil.example/remote')).toBeNull();
            expect(normalizeRdClientReturnUrl('/remote/login?return=%2Fremote')).toBeNull();
        });
    });

    describe('rdClientGuestOnly', () => {
        it('should redirect authenticated operator to return URL', async () => {
            const app = createTestApp();
            app.use((req, _res, next) => {
                req.session.userId = 2;
                req.session.user = { id: 2, username: 'operator1', role: 'operator' };
                next();
            });
            app.get('/remote/login', rdClientGuestOnly, (_req, res) => {
                res.send('login');
            });

            const res = await request(app).get('/remote/login?return=%2Fremote%2Fdev1');

            expect(res.status).toBe(302);
            expect(res.headers.location).toBe('/remote/dev1');
        });
    });
});
