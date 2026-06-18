/**
 * BetterDesk Console - Branding CSS & Profiles Tests
 */

const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { createTestApp } = require('./helpers');

const mockBranding = {
    appName: 'TestDesk',
    colors: { bgPrimary: '#111111', accentBlue: '#3366ff' },
    fontHeading: '',
    fontBody: '',
    bgType: 'none',
    loginBgType: 'inherit',
    customCss: ''
};

jest.mock('../services/database', () => ({
    logAction: jest.fn().mockResolvedValue(undefined),
    getBrandingConfig: jest.fn().mockResolvedValue([]),
    getBrandingConfigRevision: jest.fn().mockResolvedValue('rev-1'),
    saveBrandingConfigBatch: jest.fn().mockResolvedValue(undefined),
    resetBrandingConfig: jest.fn().mockResolvedValue(undefined),
    listBrandingProfiles: jest.fn().mockResolvedValue([
        { id: 1, name: 'Default', description: '', is_active: 1, created_at: '', updated_at: '' }
    ]),
    getBrandingProfile: jest.fn().mockResolvedValue({
        id: 1,
        name: 'Default',
        description: '',
        data: JSON.stringify({ version: '1.0', type: 'betterdesk-theme', branding: mockBranding }),
        is_active: 1
    }),
    createBrandingProfile: jest.fn().mockResolvedValue(2),
    updateBrandingProfile: jest.fn().mockResolvedValue(undefined),
    setActiveBrandingProfile: jest.fn().mockResolvedValue(undefined),
    deleteBrandingProfile: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../middleware/rateLimiter', () => ({
    apiLimiter: (_req, _res, next) => next()
}));

jest.mock('../services/fontService', () => ({
    searchFonts: jest.fn(() => []),
    searchGoogleFonts: jest.fn(() => []),
    listLocalFonts: jest.fn(() => []),
    downloadFont: jest.fn(async () => ({ success: true })),
    deleteLocalFont: jest.fn(() => true),
    registerUploadedFont: jest.fn(async () => ({ family: 'Custom', downloaded: true })),
    generateFontCss: jest.fn(() => ''),
    sanitizeFontName: jest.fn((n) => String(n).toLowerCase().replace(/\s+/g, '-'))
}));

const brandingService = require('../services/brandingService');
const database = require('../services/database');
const settingsRoutes = require('../routes/settings.routes');

describe('Branding routes', () => {
    let app;

    beforeAll(async () => {
        brandingService.invalidateCache();
        await brandingService.loadBranding();
    });

    beforeEach(() => {
        app = createTestApp();
        app.use((req, _res, next) => {
            req.session.userId = 1;
            req.session.user = { id: 1, username: 'admin', role: 'admin' };
            next();
        });
        app.use('/', settingsRoutes);
        jest.clearAllMocks();
    });

    describe('GET /css/branding.css', () => {
        it('returns text/css with :root overrides when branding has colors', async () => {
            const css = brandingService.generateThemeCss();
            jest.spyOn(brandingService, 'generateThemeCss').mockReturnValue(css || ':root { --bg-primary: #111111; }\n');

            const res = await request(app).get('/css/branding.css');

            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toMatch(/text\/css/);
            expect(res.text).toMatch(/:root/);
            expect(res.text).toMatch(/--surface-glass-blur|--bg-primary/);

            brandingService.generateThemeCss.mockRestore();
        });
    });

    describe('GET /api/settings/branding/profiles', () => {
        it('lists profiles for authenticated users', async () => {
            const res = await request(app).get('/api/settings/branding/profiles');
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(Array.isArray(res.body.data)).toBe(true);
        });
    });
});

describe('brandingService.generateThemeCss', () => {
    it('returns a CSS string', () => {
        const css = brandingService.generateThemeCss();
        expect(typeof css).toBe('string');
    });

    it('includes glass surface CSS variables by default', () => {
        const css = brandingService.generateThemeCss();
        expect(css).toMatch(/--surface-glass-blur/);
        expect(css).toMatch(/--surface-glass-bg-secondary/);
        expect(css).toMatch(/--sidebar-glass-bg-rail/);
        expect(css).toMatch(/--sidebar-glass-bg-flyout/);
    });

    it('places console wallpaper behind the whole app shell', async () => {
        database.getBrandingConfig.mockResolvedValueOnce([
            { key: 'bgType', value: 'image' },
            { key: 'bgImageUrl', value: '/uploads/bg-test.jpg' },
            { key: 'bgOverlay', value: '20' },
            { key: 'bgSize', value: 'cover' }
        ]);
        brandingService.invalidateCache();
        await brandingService.loadBranding();

        try {
            const css = brandingService.generateThemeCss();
            expect(css).toMatch(/body\.app-page::before/);
            expect(css).toMatch(/background: url\("\/uploads\/bg-test\.jpg"\)/);
            expect(css).toMatch(/z-index: 0/);
            expect(css).toMatch(/body\.app-page \.app-layout/);
            expect(css).toMatch(/body\.app-page \.main-content \{ background: transparent; \}/);
        } finally {
            database.getBrandingConfig.mockResolvedValue([]);
            brandingService.invalidateCache();
            await brandingService.loadBranding();
        }
    });

    it('uses glass tokens for the sidebar backgrounds', () => {
        const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'main.css'), 'utf8');
        expect(css).toMatch(/\.sidebar-rail\s*\{[\s\S]*background: var\(--sidebar-glass-bg-rail/);
        expect(css).toMatch(/\.sidebar-flyout\s*\{[\s\S]*background: var\(--sidebar-glass-bg-flyout/);
    });
});
