const request = require('supertest');
const { createTestApp } = require('./helpers');

const securityMiddleware = require('../middleware/security');

function getScriptSrcDirective(cspHeader) {
    const match = cspHeader.match(/script-src ([^;]+)/);
    return match ? match[1] : '';
}

describe('Security Middleware', () => {
    function createSecureApp() {
        const app = createTestApp();
        app.use(securityMiddleware);
        return app;
    }

    it('sets nonce-based CSP on standard pages without unsafe inline script execution', async () => {
        const app = createSecureApp();
        app.get('/dashboard', (_req, res) => {
            res.send('<html><body>ok</body></html>');
        });

        const res = await request(app).get('/dashboard');
        const scriptSrc = getScriptSrcDirective(res.headers['content-security-policy']);

        expect(res.status).toBe(200);
        expect(scriptSrc).toMatch(/'self' 'nonce-[^']+'/);
        expect(scriptSrc).not.toContain("'unsafe-inline'");
        expect(scriptSrc).not.toContain("'unsafe-eval'");
    });

    it('allows unsafe-eval only on remote viewer routes while still issuing a nonce', async () => {
        const app = createSecureApp();
        app.get('/remote/device-123', (_req, res) => {
            res.send('<html><body>remote</body></html>');
        });

        const res = await request(app).get('/remote/device-123');
        const scriptSrc = getScriptSrcDirective(res.headers['content-security-policy']);

        expect(res.status).toBe(200);
        expect(scriptSrc).toMatch(/'self' 'nonce-[^']+'/);
        expect(scriptSrc).toContain("'unsafe-eval'");
        expect(scriptSrc).not.toContain("'unsafe-inline'");
    });

    it('omits HSTS when HTTPS with self-signed certs (ALLOW_SELF_SIGNED_CERTS=true)', async () => {
        const originalHttps = process.env.HTTPS_ENABLED;
        const originalAllow = process.env.ALLOW_SELF_SIGNED_CERTS;
        const originalHsts = process.env.HSTS_ENABLED;
        process.env.HTTPS_ENABLED = 'true';
        process.env.ALLOW_SELF_SIGNED_CERTS = 'true';
        delete process.env.HSTS_ENABLED;

        jest.resetModules();
        const securityMw = require('../middleware/security');
        const app = createTestApp();
        app.use(securityMw);
        app.get('/hsts-check', (_req, res) => res.send('ok'));

        const res = await request(app).get('/hsts-check');
        expect(res.status).toBe(200);
        expect(res.headers['strict-transport-security']).toBeUndefined();

        process.env.HTTPS_ENABLED = originalHttps;
        process.env.ALLOW_SELF_SIGNED_CERTS = originalAllow;
        if (originalHsts !== undefined) process.env.HSTS_ENABLED = originalHsts;
        else delete process.env.HSTS_ENABLED;
        jest.resetModules();
    });
});