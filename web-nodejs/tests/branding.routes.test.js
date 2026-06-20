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
const config = require('../config/config');
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

    describe('GET /api/settings/appearance', () => {
        it('returns the versioned appearance model with readability status', async () => {
            const res = await request(app).get('/api/settings/appearance');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.type).toBe('betterdesk-appearance');
            expect(res.body.data.version).toBe('2.0');
            expect(res.body.data.identity.appName).toBeTruthy();
            expect(res.body.readability).toHaveProperty('ok');
        });
    });

    describe('POST /api/settings/branding/upload-background', () => {
        it('accepts a multipart background image upload', async () => {
            const res = await request(app)
                .post('/api/settings/branding/upload-background')
                .attach('background', Buffer.from('not-a-real-png-but-valid-route-test'), {
                    filename: 'wallpaper.png',
                    contentType: 'image/png'
                });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.url).toMatch(/^\/uploads\/bg-[0-9a-f]{16}\.png$/);

            const uploaded = path.join(config.dataDir, 'uploads', path.basename(res.body.url));
            if (fs.existsSync(uploaded)) fs.unlinkSync(uploaded);
        });

        it('applies uploaded console background atomically when target is provided', async () => {
            const res = await request(app)
                .post('/api/settings/branding/upload-background')
                .field('target', 'bgImageUrl')
                .attach('background', Buffer.from('new-wallpaper-content'), {
                    filename: 'new-wallpaper.png',
                    contentType: 'image/png'
                });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.applied).toBe(true);
            expect(database.saveBrandingConfigBatch).toHaveBeenCalledWith(expect.arrayContaining([
                expect.objectContaining({ key: 'bgImageUrl', value: res.body.url }),
                expect.objectContaining({ key: 'bgType', value: 'image' })
            ]));

            const uploaded = path.join(config.dataDir, 'uploads', path.basename(res.body.url));
            if (fs.existsSync(uploaded)) fs.unlinkSync(uploaded);
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

    it('includes semantic appearance aliases for rebuilt UI components', () => {
        const css = brandingService.generateThemeCss();
        expect(css).toMatch(/--color-primary: var\(--accent-blue\)/);
        expect(css).toMatch(/--color-surface: var\(--bg-secondary\)/);
        expect(css).toMatch(/--focus-ring-color: var\(--accent-blue-muted\)/);
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

    it('exposes a safe public appearance contract for RdClient', () => {
        const appearance = brandingService.getPublicAppearance();
        expect(appearance.product).toBe('betterdesk-appearance');
        expect(appearance.version).toBe('2.0');
        expect(appearance.palette.primary).toBeTruthy();
        expect(appearance.background).toHaveProperty('type');
        expect(appearance).not.toHaveProperty('customCss');
    });

    it('reports readability problems for low-contrast palettes', () => {
        const readability = brandingService.assessAppearanceReadability({
            ...brandingService.DEFAULT_BRANDING,
            colors: {
                ...brandingService.DEFAULT_BRANDING.colors,
                bgPrimary: '#000000',
                bgSecondary: '#000000',
                textPrimary: '#111111'
            }
        });
        expect(readability.ok).toBe(false);
        expect(readability.issues.some(issue => issue.id === 'page-text')).toBe(true);
    });
});
