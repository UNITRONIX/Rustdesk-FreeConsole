/**
 * BetterDesk Console - Settings Routes
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../config/config');
const keyService = require('../services/keyService');
const db = require('../services/database');
const brandingService = require('../services/brandingService');
const fontService = require('../services/fontService');
const serverBackend = require('../services/serverBackend');
const backupService = require('../services/backupService');
const updateService = require('../services/updateService');
const { resolveChildPath } = require('../lib/safePath');
const { canScheduleConsoleRestart } = require('../lib/updateFailurePolicy');
const {
    persistUpdateResult,
    clearLastUpdateResult,
    resolveLastUpdateResultForDisplay,
} = require('../lib/updateResultStore');
const { splitUpdateFailures } = require('../lib/updateFailurePolicy');
const advancedConfig = require('../services/advancedConfigService');
const serverConnectionConfig = require('../services/serverConnectionConfigService');
const rustDeskPublicEndpoints = require('../services/rustDeskPublicEndpointsService');
const clientConfigHost = require('../services/clientConfigHost');
const { getSmtpSettings, putSmtpSettings, testSmtpSettings } = require('../lib/smtpSettingsHandlers');
const { apiClient } = require('../services/betterdeskApi');
const { requireAuth, requirePermission, roleHasPermission } = require('../middleware/auth');
const deviceGroupService = require('../services/deviceGroupService');
const os = require('os');
const multer = require('multer');

/**
 * GET /settings - Settings page
 */
router.get('/settings', requireAuth, (req, res) => {
    const userRole = req.session.user && req.session.user.role;
    res.render('settings', {
        title: req.t('nav.settings'),
        activePage: 'settings',
        canServerConfig: roleHasPermission(userRole, 'server.config'),
        canBrandingEdit: roleHasPermission(userRole, 'branding.edit')
    });
});

/**
 * GET /api/settings/restart-status - Lightweight liveness probe used by the
 * browser updater after the console process exits and starts again. This stays
 * intentionally public and minimal: it only confirms that the Node.js console
 * is serving requests from the current boot, without touching DB/Go backend
 * dependencies that may still be warming up.
 */
router.get('/api/settings/restart-status', (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.json({
        success: true,
        data: {
            status: 'ok',
            cacheVersion: req.app?.locals?.cacheVersion || '',
            uptime: Math.floor(process.uptime())
        }
    });
});

/**
 * GET /api/settings/info - Get server configuration info
 */
router.get('/api/settings/info', requireAuth, async (req, res) => {
    try {
        const serverHealth = await serverBackend.getHealth();
        const serverConfig = keyService.getServerConfig();
        const stats = await db.getStats();
        
        res.json({
            success: true,
            data: {
                app: {
                    name: config.appName,
                    version: config.appVersion,
                    nodeVersion: process.version,
                    env: config.nodeEnv
                },
                server: {
                    hostname: os.hostname(),
                    platform: os.platform(),
                    arch: os.arch(),
                    uptime: Math.floor(process.uptime()),
                    memoryUsage: process.memoryUsage().heapUsed
                },
                goServer: serverHealth,
                backend: serverBackend.getActiveBackend(),
                paths: {
                    database: config.dbPath,
                    publicKey: config.pubKeyPath,
                    apiKey: config.apiKeyPath
                },
                stats: stats
            }
        });
    } catch (err) {
        console.error('Get server info error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * GET /api/settings/server-info - Alias for /api/keys/server-info (backward compatibility)
 */
router.get('/api/settings/server-info', requireAuth, (req, res) => {
    try {
        const endpoints = clientConfigHost.resolveRustDeskEndpoints(req, '');
        const apiKey = keyService.getApiKey(true);

        res.json({
            success: true,
            data: {
                server_id: endpoints.host,
                relay_server: endpoints.relay,
                api_url: endpoints.api,
                api_key_masked: apiKey || '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022',
                endpoint_sources: endpoints.sources,
                env_override_active: endpoints.env_override_active,
            }
        });
    } catch (err) {
        console.error('Get server info error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

/**
 * GET /api/settings/device-scope - Default device visibility mode for non-admin users.
 */
router.get('/api/settings/device-scope', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const stored = await db.getSetting('device_scope_default');
        const mode = stored && String(stored).toLowerCase() === 'restricted' ? 'restricted' : 'open';
        res.json({ success: true, data: { mode } });
    } catch (err) {
        console.error('Get device scope setting error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/settings/device-scope - Set default device visibility mode.
 */
router.post('/api/settings/device-scope', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const mode = String((req.body && req.body.mode) || 'open').toLowerCase();
        if (mode !== 'open' && mode !== 'restricted') {
            return res.status(400).json({ success: false, error: req.t('settings.device_scope_invalid') });
        }
        await db.setSetting('device_scope_default', mode);
        deviceGroupService.invalidateDeviceScopeDefaultCache();
        await db.logAction(req.session.userId, 'device_scope_default_updated', `Device scope default: ${mode}`, req.ip);
        res.json({ success: true, data: { mode } });
    } catch (err) {
        console.error('Set device scope setting error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * GET /api/settings/audit - Get audit log
 */
router.get('/api/settings/audit', requireAuth, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit, 10) || 100;
        const logs = await db.getAuditLogs(limit);
        
        res.json({
            success: true,
            data: logs
        });
    } catch (err) {
        console.error('Get audit logs error:', err);
        res.status(500).json({
            success: false,
            error: req.t('errors.server_error')
        });
    }
});

// ==================== Branding / Theming API ====================

/**
 * GET /api/settings/branding - Get current branding configuration
 */
router.get('/api/settings/branding', requireAuth, (req, res) => {
    try {
        const branding = brandingService.getBranding();
        res.json({
            success: true,
            data: branding,
            appearance: brandingService.getAppearanceModel(branding),
            readability: brandingService.assessAppearanceReadability(branding),
            revision: brandingService.getBrandingRevision()
        });
    } catch (err) {
        console.error('Get branding error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * GET /api/settings/appearance - Versioned appearance model for the settings UI
 */
router.get('/api/settings/appearance', requireAuth, (req, res) => {
    try {
        const branding = brandingService.getBranding();
        res.json({
            success: true,
            data: brandingService.getAppearanceModel(branding),
            flat: branding,
            readability: brandingService.assessAppearanceReadability(branding),
            revision: brandingService.getBrandingRevision()
        });
    } catch (err) {
        console.error('Get appearance error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/settings/branding - Save branding configuration (admin only)
 */
router.post('/api/settings/branding', requireAuth, requirePermission('branding.edit'), async (req, res) => {
    try {
        const updates = req.body;
        if (!updates || typeof updates !== 'object') {
            return res.status(400).json({ success: false, error: 'Invalid branding data' });
        }
        
        await brandingService.saveBranding(updates);
        const savedBranding = brandingService.getBranding();
        const readability = brandingService.assessAppearanceReadability(savedBranding);
        
        await db.logAction(req.session?.userId, 'branding_update', 'Updated branding configuration', req.ip);
        
        res.json({
            success: true,
            data: savedBranding,
            appearance: brandingService.getAppearanceModel(savedBranding),
            readability,
            revision: brandingService.getBrandingRevision()
        });
    } catch (err) {
        console.error('Save branding error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

// ── Logo image upload (disk storage) ─────────────────────────────────────────
const UPLOADS_DIR = path.join(config.dataDir || path.join(__dirname, '..', 'data'), 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const logoUpload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
        filename: (_req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase() || '.png';
            const hash = crypto.randomBytes(8).toString('hex');
            cb(null, `logo-${hash}${ext}`);
        }
    }),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const allowed = /^image\/(png|jpeg|gif|webp|svg\+xml)$/;
        if (allowed.test(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type'));
        }
    }
});

/**
 * POST /api/settings/branding/upload-logo - Upload logo image to server disk
 */
router.post('/api/settings/branding/upload-logo', requireAuth, requirePermission('branding.edit'), (req, res) => {
    logoUpload.single('logo')(req, res, async (err) => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 2 MB)' : (err.message || 'Upload failed');
            return res.status(400).json({ success: false, error: msg });
        }
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file provided' });
        }
        const url = `/uploads/${req.file.filename}`;

        // Remove previous uploaded logo if it was in the uploads dir.
        // Security: defense-in-depth path validation — resolve real paths and
        // verify the candidate is (a) inside UPLOADS_DIR and (b) matches the
        // managed filename pattern (logo-<hex>.<ext>) before unlinking.
        try {
            const branding = brandingService.getBranding();
            if (branding.logoUrl && branding.logoUrl.startsWith('/uploads/')) {
                const baseName = path.basename(branding.logoUrl);
                // Managed logos use crypto.randomBytes(8).toString('hex') => 16 hex chars
                const managedPattern = /^logo-[0-9a-f]{16}\.(png|jpg|jpeg|gif|webp|svg)$/i;
                if (managedPattern.test(baseName)) {
                    const prev = path.resolve(UPLOADS_DIR, baseName);
                    const uploadsRoot = path.resolve(UPLOADS_DIR);
                    const newPath = path.resolve(UPLOADS_DIR, req.file.filename);
                    if (prev.startsWith(uploadsRoot + path.sep) && prev !== newPath && fs.existsSync(prev)) {
                        // Final guard: stat must be a regular file (not symlink to elsewhere)
                        const st = fs.lstatSync(prev);
                        if (st.isFile() && !st.isSymbolicLink()) {
                            fs.unlinkSync(prev);
                        }
                    }
                }
            }
        } catch (_) { /* ignore cleanup errors */ }

        await db.logAction(req.session?.userId, 'branding_logo_upload', `Uploaded logo: ${req.file.filename}`, req.ip);
        res.json({ success: true, url });
    });
});

// ── Background image upload (disk storage) ───────────────────────────────────
const bgUpload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
        filename: (_req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
            const hash = crypto.randomBytes(8).toString('hex');
            cb(null, `bg-${hash}${ext}`);
        }
    }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const allowed = /^image\/(png|jpeg|gif|webp|svg\+xml)$/;
        if (allowed.test(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type'));
        }
    }
});

/**
 * GET /api/settings/branding/backgrounds - List uploaded background images.
 */
router.get('/api/settings/branding/backgrounds', requireAuth, (req, res) => {
    try {
        const uploadsRoot = path.resolve(UPLOADS_DIR);
        const managedPattern = /^bg-[0-9a-f]{16}\.(png|jpg|jpeg|gif|webp)$/i;
        const files = fs.readdirSync(uploadsRoot)
            .filter((name) => managedPattern.test(name))
            .map((name) => {
                const fullPath = path.resolve(uploadsRoot, name);
                if (!fullPath.startsWith(uploadsRoot + path.sep)) return null;
                const stat = fs.lstatSync(fullPath);
                if (!stat.isFile() || stat.isSymbolicLink()) return null;
                return {
                    name,
                    url: `/uploads/${name}`,
                    size: stat.size,
                    updatedAt: stat.mtime.toISOString()
                };
            })
            .filter(Boolean)
            .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

        res.json({ success: true, data: files });
    } catch (err) {
        console.error('List branding backgrounds error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/settings/branding/upload-background - Upload a background image.
 * Used by the console / login / agent-portal wallpaper pickers. Returns the
 * served URL; the caller decides which branding field to assign it to. Old
 * background files are not auto-removed because a single image may be shared
 * across console/login/agent backgrounds.
 */
router.post('/api/settings/branding/upload-background', requireAuth, requirePermission('branding.edit'), (req, res) => {
    bgUpload.single('background')(req, res, async (err) => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 8 MB)' : (err.message || 'Upload failed');
            return res.status(400).json({ success: false, error: msg });
        }
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file provided' });
        }
        const url = `/uploads/${req.file.filename}`;
        const targetMap = {
            bgImageUrl: 'bgType',
            loginBgImageUrl: 'loginBgType',
            agentBgImageUrl: 'agentBgType',
            rdclientBgImageUrl: 'rdclientBgType'
        };
        const target = String(req.body?.target || '').trim();
        let branding = null;

        if (target && targetMap[target]) {
            const updates = {
                [target]: url,
                [targetMap[target]]: 'image'
            };
            await brandingService.saveBranding(updates);
            branding = brandingService.getBranding();
        }

        await db.logAction(
            req.session?.userId,
            'branding_bg_upload',
            target && targetMap[target]
                ? `Uploaded and applied background: ${req.file.filename} (${target})`
                : `Uploaded background: ${req.file.filename}`,
            req.ip
        );
        res.json({
            success: true,
            url,
            applied: !!branding,
            data: branding,
            revision: branding ? brandingService.getBrandingRevision() : undefined
        });
    });
});

/**
 * POST /api/settings/branding/reset - Reset branding to defaults (admin only)
 */
router.post('/api/settings/branding/reset', requireAuth, requirePermission('branding.edit'), async (req, res) => {
    try {
        await brandingService.resetBranding();
        
        await db.logAction(req.session?.userId, 'branding_reset', 'Reset branding to defaults', req.ip);
        
        res.json({ success: true, message: 'Branding reset to defaults' });
    } catch (err) {
        console.error('Reset branding error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * GET /api/settings/branding/export - Export branding preset as JSON
 */
router.get('/api/settings/branding/export', requireAuth, requirePermission('branding.edit'), (req, res) => {
    try {
        const preset = brandingService.exportPreset();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename="betterdesk-theme.json"');
        res.json(preset);
    } catch (err) {
        console.error('Export branding error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/settings/branding/import - Import branding preset from JSON (admin only)
 */
router.post('/api/settings/branding/import', requireAuth, requirePermission('branding.edit'), async (req, res) => {
    try {
        const preset = req.body;
        const success = await brandingService.importPreset(preset);
        
        if (!success) {
            return res.status(400).json({ success: false, error: 'Invalid theme preset file' });
        }
        
        await db.logAction(req.session?.userId, 'branding_import', 'Imported branding preset', req.ip);
        
        res.json({ success: true, message: 'Theme imported successfully' });
    } catch (err) {
        console.error('Import branding error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

// ==================== Branding Profiles ====================

/**
 * GET /api/settings/branding/profiles - List saved appearance profiles
 */
router.get('/api/settings/branding/profiles', requireAuth, async (req, res) => {
    try {
        const profiles = await brandingService.listProfiles();
        res.json({ success: true, data: profiles });
    } catch (err) {
        console.error('List branding profiles error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/settings/branding/profiles - Create profile from current branding
 */
router.post('/api/settings/branding/profiles', requireAuth, requirePermission('branding.edit'), async (req, res) => {
    try {
        const name = String(req.body?.name || '').trim();
        const description = String(req.body?.description || '').trim();
        if (!name) {
            return res.status(400).json({ success: false, error: 'Profile name is required' });
        }
        let preset = null;
        if (req.body?.branding && typeof req.body.branding === 'object') {
            preset = { version: '1.0', type: 'betterdesk-theme', branding: req.body.branding };
        }
        const id = await brandingService.createProfile(name, description, preset);
        await db.logAction(req.session?.userId, 'branding_profile_create', `Created profile: ${name}`, req.ip);
        res.json({ success: true, data: { id } });
    } catch (err) {
        const msg = err.message?.includes('UNIQUE') ? 'Profile name already exists' : (err.message || req.t('errors.server_error'));
        console.error('Create branding profile error:', err);
        res.status(400).json({ success: false, error: msg });
    }
});

/**
 * PUT /api/settings/branding/profiles/:id - Update profile metadata/data
 */
router.put('/api/settings/branding/profiles/:id', requireAuth, requirePermission('branding.edit'), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) {
            return res.status(400).json({ success: false, error: 'Invalid profile id' });
        }
        await brandingService.updateProfile(id, {
            name: req.body?.name,
            description: req.body?.description,
            branding: req.body?.branding
        });
        await db.logAction(req.session?.userId, 'branding_profile_update', `Updated profile #${id}`, req.ip);
        res.json({ success: true });
    } catch (err) {
        console.error('Update branding profile error:', err);
        res.status(400).json({ success: false, error: err.message || req.t('errors.server_error') });
    }
});

/**
 * POST /api/settings/branding/profiles/:id/apply - Apply profile to active branding
 */
router.post('/api/settings/branding/profiles/:id/apply', requireAuth, requirePermission('branding.edit'), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) {
            return res.status(400).json({ success: false, error: 'Invalid profile id' });
        }
        const ok = await brandingService.applyProfile(id);
        if (!ok) {
            return res.status(404).json({ success: false, error: 'Profile not found or invalid' });
        }
        await db.logAction(req.session?.userId, 'branding_profile_apply', `Applied profile #${id}`, req.ip);
        res.json({ success: true, data: brandingService.getBranding(), revision: brandingService.getBrandingRevision() });
    } catch (err) {
        console.error('Apply branding profile error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/settings/branding/profiles/:id/duplicate - Duplicate profile
 */
router.post('/api/settings/branding/profiles/:id/duplicate', requireAuth, requirePermission('branding.edit'), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) {
            return res.status(400).json({ success: false, error: 'Invalid profile id' });
        }
        const newId = await brandingService.duplicateProfile(id, req.body?.name || '');
        res.json({ success: true, data: { id: newId } });
    } catch (err) {
        console.error('Duplicate branding profile error:', err);
        res.status(400).json({ success: false, error: err.message || req.t('errors.server_error') });
    }
});

/**
 * DELETE /api/settings/branding/profiles/:id - Delete profile
 */
router.delete('/api/settings/branding/profiles/:id', requireAuth, requirePermission('branding.edit'), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (!Number.isFinite(id)) {
            return res.status(400).json({ success: false, error: 'Invalid profile id' });
        }
        await brandingService.deleteProfile(id);
        await db.logAction(req.session?.userId, 'branding_profile_delete', `Deleted profile #${id}`, req.ip);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete branding profile error:', err);
        res.status(400).json({ success: false, error: err.message || req.t('errors.server_error') });
    }
});

/**
 * GET /api/settings/themes - List available theme presets
 */
router.get('/api/settings/themes', requireAuth, (req, res) => {
    try {
        const fs = require('fs');
        const path = require('path');
        const themesDir = path.join(__dirname, '..', 'themes');
        const themes = [];

        if (fs.existsSync(themesDir)) {
            for (const file of fs.readdirSync(themesDir)) {
                if (!file.endsWith('.json')) continue;
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(themesDir, file), 'utf8'));
                    if (data.type === 'betterdesk-theme' && data.branding) {
                        themes.push({
                            id: file.replace('.json', ''),
                            name: data.branding.appName || file.replace('.json', ''),
                            description: data.branding.appDescription || '',
                            colors: data.branding.colors || {}
                        });
                    }
                } catch { /* skip invalid files */ }
            }
        }

        res.json({ success: true, data: themes });
    } catch (err) {
        console.error('List themes error:', err);
        res.status(500).json({ success: false, error: 'Failed to list themes' });
    }
});

/**
 * POST /api/settings/themes/:id/apply - Apply a built-in theme preset (admin only)
 */
router.post('/api/settings/themes/:id/apply', requireAuth, requirePermission('branding.edit'), async (req, res) => {
    try {
        const fs = require('fs');
        const path = require('path');
        const themeId = req.params.id;
        if (!/^[a-zA-Z0-9_-]+$/.test(themeId)) {
            return res.status(400).json({ success: false, error: 'Invalid theme id' });
        }
        const themesDir = path.resolve(__dirname, '..', 'themes');
        const themeFile = resolveChildPath(themesDir, `${themeId}.json`);

        if (!fs.existsSync(themeFile)) {
            return res.status(404).json({ success: false, error: 'Theme not found' });
        }

        const preset = JSON.parse(fs.readFileSync(themeFile, 'utf8'));
        const success = await brandingService.importPreset(preset);

        if (!success) {
            return res.status(400).json({ success: false, error: 'Invalid theme format' });
        }

        const db = require('../services/database');
        await db.logAction(req.session?.userId, 'theme_apply', `Applied theme: ${req.params.id}`, req.ip);

        res.json({ success: true, message: `Theme "${req.params.id}" applied` });
    } catch (err) {
        console.error('Apply theme error:', err);
        res.status(500).json({ success: false, error: 'Failed to apply theme' });
    }
});

// ==================== Font Management API ====================

/**
 * GET /api/settings/fonts - Search available fonts
 * Query: ?q=inter&category=sans-serif
 */
router.get('/api/settings/fonts', requireAuth, (req, res) => {
    try {
        const query = String(req.query.q || '').substring(0, 100);
        const category = String(req.query.category || 'all').substring(0, 20);
        const source = String(req.query.source || 'curated').substring(0, 20);
        const fonts = source === 'google'
            ? fontService.searchGoogleFonts(query, category)
            : fontService.searchFonts(query, category);
        res.json({ success: true, data: fonts });
    } catch (err) {
        console.error('Font search error:', err);
        res.status(500).json({ success: false, error: 'Failed to search fonts' });
    }
});

/**
 * GET /api/settings/fonts/local - List locally downloaded fonts
 */
router.get('/api/settings/fonts/local', requireAuth, (req, res) => {
    try {
        const fonts = fontService.listLocalFonts();
        res.json({ success: true, data: fonts });
    } catch (err) {
        console.error('List local fonts error:', err);
        res.status(500).json({ success: false, error: 'Failed to list fonts' });
    }
});

/**
 * POST /api/settings/fonts/download - Download a Google Font to server
 * Body: { family: "Inter", weights: ["400", "500", "600", "700"] }
 */
router.post('/api/settings/fonts/download', requireAuth, requirePermission('branding.edit'), async (req, res) => {
    try {
        const { family, weights } = req.body;
        if (!family || typeof family !== 'string') {
            return res.status(400).json({ success: false, error: 'Font family is required' });
        }

        const result = await fontService.downloadFont(family, weights || ['400', '500', '600', '700']);

        await db.logAction(req.session?.userId, 'font_download', `Downloaded font: ${family} (${result.files.length} files)`, req.ip);

        res.json({ success: true, data: result });
    } catch (err) {
        console.error('Font download error:', err);
        res.status(500).json({ success: false, error: err.message || 'Failed to download font' });
    }
});

/**
 * DELETE /api/settings/fonts/:family - Delete a locally downloaded font
 */
router.delete('/api/settings/fonts/:family', requireAuth, requirePermission('branding.edit'), async (req, res) => {
    try {
        const family = decodeURIComponent(req.params.family);
        const result = fontService.deleteLocalFont(family);

        if (result) {
            await db.logAction(req.session?.userId, 'font_delete', `Deleted font: ${family}`, req.ip);
        }

        res.json({ success: true, deleted: result });
    } catch (err) {
        console.error('Font delete error:', err);
        res.status(500).json({ success: false, error: 'Failed to delete font' });
    }
});

const fontUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const ok = /\.(woff2|ttf)$/i.test(file.originalname)
            || file.mimetype === 'font/woff2'
            || file.mimetype === 'font/ttf'
            || file.mimetype === 'application/font-woff2'
            || file.mimetype === 'application/x-font-ttf';
        cb(ok ? null : new Error('Invalid font file type'), ok);
    }
});

/**
 * POST /api/settings/fonts/upload - Upload a custom font (woff2/ttf)
 */
router.post('/api/settings/fonts/upload', requireAuth, requirePermission('branding.edit'), (req, res) => {
    fontUpload.single('font')(req, res, async (err) => {
        if (err) {
            const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 5 MB)' : (err.message || 'Upload failed');
            return res.status(400).json({ success: false, error: msg });
        }
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file provided' });
        }
        try {
            const family = String(req.body?.family || path.basename(req.file.originalname, path.extname(req.file.originalname))).trim();
            const ext = path.extname(req.file.originalname).toLowerCase() === '.ttf' ? '.ttf' : '.woff2';
            const tmpDir = path.join(__dirname, '..', 'data', 'tmp');
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
            const tmpPath = path.join(tmpDir, `font-upload-${Date.now()}${ext}`);
            fs.writeFileSync(tmpPath, req.file.buffer);
            const result = await fontService.registerUploadedFont(family, tmpPath, path.basename(tmpPath));
            await db.logAction(req.session?.userId, 'font_upload', `Uploaded font: ${family}`, req.ip);
            res.json({ success: true, data: result });
        } catch (uploadErr) {
            console.error('Font upload error:', uploadErr);
            res.status(400).json({ success: false, error: uploadErr.message || 'Upload failed' });
        }
    });
});

/**
 * GET /css/branding.css - Dynamic branding overrides (no auth required, short cache)
 */
router.get('/css/branding.css', (req, res) => {
    try {
        const css = brandingService.generateThemeCss();
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.setHeader('X-Branding-Revision', brandingService.getBrandingRevision());
        res.send(css);
    } catch (err) {
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
        res.send('/* branding error */');
    }
});

/**
 * GET /css/theme.css - Legacy alias (prefer /css/branding.css)
 */
router.get('/css/theme.css', (req, res) => {
    try {
        const css = brandingService.generateThemeCss();
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.send(css);
    } catch (err) {
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
        res.send('/* theme error */');
    }
});

/**
 * GET /branding/favicon.svg - Dynamic favicon from branding (no auth required)
 */
router.get('/branding/favicon.svg', (req, res) => {
    try {
        const svg = brandingService.generateFavicon();
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.send(svg);
    } catch (err) {
        res.status(500).send('');
    }
});

// ==================== Backup & Restore API ====================

// multer configured for in-memory buffer. Full disaster-recovery archives may
// embed the raw SQLite databases and branding uploads, so allow up to 200 MB.
const backupUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024 }
});

/**
 * GET /api/settings/backup/stats - Preview backup size/contents
 */
router.get('/api/settings/backup/stats', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const stats = await backupService.getFullBackupStats();
        res.json({ success: true, data: stats });
    } catch (err) {
        console.error('Backup stats error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * GET /api/settings/backup - Download a full disaster-recovery backup (.tar.gz).
 * Pass ?format=json for the legacy JSON configuration snapshot.
 */
router.get('/api/settings/backup', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        if (req.query.format === 'json') {
            const backup = await backupService.createBackup();
            const json = JSON.stringify(backup, null, 2);
            const filename = `betterdesk-config-${new Date().toISOString().slice(0, 10)}.json`;
            await db.logAction(req.session?.userId, 'backup_created', `Config snapshot downloaded (${(json.length / 1024).toFixed(1)} KB)`, req.ip);
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            return res.send(json);
        }

        const { buffer, filename } = await backupService.createFullBackup();
        await db.logAction(req.session?.userId, 'backup_created', `Full backup downloaded (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`, req.ip);
        res.setHeader('Content-Type', 'application/gzip');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buffer);
    } catch (err) {
        console.error('Backup download error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/settings/restore - Upload and restore from a backup.
 * Accepts either a full .tar.gz disaster-recovery archive (auto-detected via
 * the gzip magic bytes) or a legacy JSON configuration snapshot.
 * Expects multipart/form-data with field "backup".
 */
router.post('/api/settings/restore', requireAuth, requirePermission('server.config'), backupUpload.single('backup'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: req.t('backup.no_file') });
        }

        const buf = req.file.buffer;
        const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;

        if (isGzip) {
            // --- Full disaster-recovery archive ---
            const opts = {
                restoreDatabase: req.body.restoreDatabase !== 'false',
                restoreUploads: req.body.restoreUploads !== 'false',
                restoreSecrets: req.body.restoreSecrets === 'true',  // Off by default — overwrites keys
                restoreEnv: req.body.restoreEnv === 'true',          // Off by default — needs restart
                restoreGoDb: req.body.restoreGoDb === 'true'         // Off by default — needs restart
            };

            let result;
            try {
                result = await backupService.restoreFullBackup(buf, opts);
            } catch (err) {
                return res.status(400).json({ success: false, error: err.message });
            }

            await db.logAction(
                req.session?.userId, 'backup_restored',
                `Full restore | Restored: ${result.restored.join(', ')} | Skipped: ${result.skipped.join(', ')}`,
                req.ip
            );

            return res.json({
                success: true,
                data: {
                    type: 'full',
                    restored: result.restored,
                    skipped: result.skipped,
                    warnings: result.warnings,
                    requiresRestart: result.requiresRestart
                }
            });
        }

        // --- Legacy JSON configuration snapshot ---
        let data;
        try {
            data = JSON.parse(buf.toString('utf-8'));
        } catch {
            return res.status(400).json({ success: false, error: req.t('backup.invalid_json') });
        }

        const validation = backupService.validateBackup(data);
        if (!validation.valid) {
            return res.status(400).json({ success: false, error: validation.errors.join('; ') });
        }

        const opts = {
            restoreSettings: req.body.restoreSettings !== 'false',
            restoreBranding: req.body.restoreBranding !== 'false',
            restoreUsers: req.body.restoreUsers === 'true',      // Off by default — destructive
            restoreFolders: req.body.restoreFolders !== 'false',
            restoreGroups: req.body.restoreGroups !== 'false',
            restoreAddressBooks: req.body.restoreAddressBooks !== 'false'
        };

        const result = await backupService.restoreBackup(data, opts);

        await db.logAction(
            req.session?.userId, 'backup_restored',
            `Config restore | Restored: ${result.restored.join(', ')} | Skipped: ${result.skipped.join(', ')}`,
            req.ip
        );

        res.json({
            success: true,
            data: {
                type: 'config',
                restored: result.restored,
                skipped: result.skipped,
                warnings: result.warnings,
                backupDate: data._created,
                backupVersion: data._console_version
            }
        });
    } catch (err) {
        console.error('Restore error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

// ==================== Self-Update API ====================

/**
 * GET /api/settings/updates/server-info - Check Go build environment for server updates
 */
router.get('/api/settings/updates/server-info', requireAuth, requirePermission('server.config'), async (_req, res) => {
    try {
        const info = updateService.getServerUpdateInfo();
        const prebuilt = await updateService.getPrebuiltInfo();
        res.json({ success: true, data: { ...info, prebuilt } });
    } catch (err) {
        console.error('Server info error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/settings/updates/install-go - Download & install the Go toolchain
 * into data/go-toolchain/ so the console can compile the Go server even when
 * Go is not present on the host. Idempotent.
 */
router.post('/api/settings/updates/install-go', requireAuth, requirePermission('server.config'), async (req, res) => {
    req.setTimeout(600000);
    res.setTimeout(600000);
    try {
        const result = await updateService.installGoToolchain();
        await db.logAction(
            req.session?.userId,
            'system_install_go',
            result.success ? `Installed Go toolchain (${result.version})` : `Go toolchain install failed: ${result.error}`,
            req.ip
        );
        if (!result.success) {
            return res.status(500).json({ success: false, error: result.error || 'Toolchain install failed' });
        }
        res.json({ success: true, data: { version: result.version, binPath: result.binPath } });
    } catch (err) {
        console.error('Go toolchain install error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/settings/updates/preflight - Pre-install environment checks (issue #158)
 */
router.get('/api/settings/updates/preflight', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const serverUpdateRequired = req.query.serverUpdate === '1' || req.query.serverUpdate === 'true';
        const result = await updateService.runUpdatePreflight({ serverUpdateRequired });
        res.json({ success: true, data: result });
    } catch (err) {
        console.error('Update preflight error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/settings/updates/channel - Current GitHub update channel (stable/dev)
 */
router.get('/api/settings/updates/channel', requireAuth, requirePermission('server.config'), (_req, res) => {
    try {
        const data = updateService.getUpdateChannelInfo();
        res.json({ success: true, data });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/settings/updates/channel - Switch update channel (writes .env)
 * Body: { channel: 'stable' | 'development' }
 */
router.post('/api/settings/updates/channel', requireAuth, requirePermission('server.config'), (req, res) => {
    try {
        const { channel } = req.body || {};
        if (!channel || !updateService.UPDATE_CHANNELS[channel]) {
            return res.status(400).json({
                success: false,
                error: 'Invalid channel. Use stable or development.'
            });
        }
        const result = updateService.setUpdateChannel(channel);
        res.json({ success: true, data: result });
    } catch (err) {
        console.error('Update channel error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/settings/updates/check - Check for available updates
 */
router.get('/api/settings/updates/check', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const result = await updateService.checkForUpdates();
        res.json({ success: true, data: result });
    } catch (err) {
        console.error('Update check error:', err);
        const rateLimited = updateService.isGithubRateLimitError(err);
        res.status(rateLimited ? 503 : 500).json({
            success: false,
            error: 'Failed to check for updates: ' + err.message,
            code: rateLimited ? 'GITHUB_RATE_LIMIT' : undefined,
        });
    }
});

/**
 * GET /api/settings/updates/last-result - Last in-app update outcome (survives closed modal)
 */
router.get('/api/settings/updates/last-result', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        let remoteSHA = null;
        try {
            const remote = await updateService.getRemoteHeadSHA();
            remoteSHA = remote?.sha || null;
        } catch (_) { /* optional for stale-banner pruning */ }

        const data = resolveLastUpdateResultForDisplay(config.dataDir, {
            rootDir: path.join(__dirname, '..'),
            localSHA: updateService.getLocalSHA(),
            remoteSHA,
        });
        res.json({ success: true, data: data || null });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/settings/updates/changes - Get list of changed files between local SHA and remote
 */
router.get('/api/settings/updates/changes', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const { sha } = req.query;
        if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) {
            return res.status(400).json({ success: false, error: 'Valid SHA parameter required' });
        }
        const result = await updateService.getChangedFiles(sha);
        res.json({ success: true, data: result });
    } catch (err) {
        console.error('Get changes error:', err);
        const rateLimited = updateService.isGithubRateLimitError(err);
        res.status(rateLimited ? 503 : 500).json({
            success: false,
            error: 'Failed to get changed files: ' + err.message,
            code: rateLimited ? 'GITHUB_RATE_LIMIT' : undefined,
        });
    }
});

/**
 * POST /api/settings/updates/install - Apply the update
 * Body: { remoteSHA, createBackup: true/false }
 * The update scope is detected server-side from the changed files. Supported
 * changed components are always applied together so operators cannot
 * accidentally skip the Go server when its source changed.
 */
router.post('/api/settings/updates/install', requireAuth, requirePermission('server.config'), async (req, res) => {
    // Extend timeout for server compilation (up to 10 minutes)
    req.setTimeout(600000);
    res.setTimeout(600000);

    try {
        if (updateService.isImageBasedDockerDeployment()) {
            const dockerUpdate = updateService.getDockerUpdateInstructions();
            return res.status(400).json({
                success: false,
                error: `In-app updates are disabled in Docker image deployments. Run: ${dockerUpdate.commands.join(' && ')}`,
                dockerImageMode: true,
                dockerUpdate
            });
        }

        const { remoteSHA, createBackup } = req.body;
        if (!remoteSHA || !/^[0-9a-f]{7,40}$/i.test(remoteSHA)) {
            return res.status(400).json({ success: false, error: 'Valid remoteSHA is required' });
        }

        // Get changed files
        const changedData = await updateService.getChangedFiles(remoteSHA);
        if (changedData.totalFiles === 0) {
            return res.json({ success: true, data: { applied: [], message: 'No files to update' } });
        }

        // Apply update
        const result = await updateService.applyUpdate(remoteSHA, changedData, {
            createBackup: createBackup !== false,
            serverStrategy: 'auto'
        });

        await db.logAction(
            req.session?.userId,
            'system_update',
            `Updated to ${remoteSHA.slice(0, 7)} (${result.applied.length} applied, ${result.failed.length} failed)`
                + (result.failed.length
                    ? ` — failed: ${result.failed.map(f => `${f.file}: ${f.error || ''}`).join('; ')}`
                    : '')
                + (result.servicesFailed?.length
                    ? ` — services: ${result.servicesFailed.map(s => `${s.service}: ${s.error || ''}`).join('; ')}`
                    : ''),
            req.ip
        );

        // Sync Linux permissions/sudoers from disk before service restarts.
        if (process.platform === 'linux') {
            try {
                const modPath = require.resolve('../scripts/linux-ensure-console-user');
                delete require.cache[modPath];
                require('../scripts/linux-ensure-console-user').ensureLinuxConsoleServiceUser();
            } catch (syncErr) {
                console.warn(`[UPDATE] Pre-restart permission sync warning: ${syncErr.message}`);
            }
        }

        // Restart Go server when its binary was updated.
        if (result.needsServerRestart) {
            const serviceName = process.platform === 'win32' ? 'BetterDeskServer' : 'betterdesk-server';
            let svc = updateService.restartService(serviceName);
            if (!svc.success) {
                svc = updateService.restartService(serviceName);
            }
            if (svc.success) result.servicesRestarted.push('server');
            else {
                const fail = { service: 'server', error: svc.error };
                if (svc.nonCritical) fail.nonCritical = true;
                if (svc.hint) fail.hint = svc.hint;
                result.servicesFailed.push(fail);
            }
        }

        // Restart console after response is sent (systemd/NSSM restarts automatically)
        let scheduleConsoleRestart = false;
        if (result.needsConsoleRestart) {
            const restartGate = canScheduleConsoleRestart(result, config.dataDir);
            if (!restartGate.allowed) {
                result.consoleRestartBlocked = restartGate.blockedReason
                    || 'Console service user permissions were not verified before restart';
                console.warn(
                    '[UPDATE] Skipping console restart — service user permissions not verified.'
                    + ` Run as root: node ${path.join(__dirname, '..', 'scripts/linux-ensure-console-user.js')}`
                    + ' && systemctl restart betterdesk-console'
                );
            } else {
                if (restartGate.note) result.consoleRestartNote = restartGate.note;
                scheduleConsoleRestart = true;
            }
        }

        try {
            const rootDir = path.join(__dirname, '..');
            const { critical: criticalFailures } = splitUpdateFailures(result.failed || [], rootDir);
            // Access-denied NSSM restarts are non-critical on Windows (#272).
            const servicesFailed = (result.servicesFailed || []).filter(s => !s.nonCritical);
            const consoleRestartBlocked = result.consoleRestartBlocked || null;
            if (criticalFailures.length === 0 && servicesFailed.length === 0 && !consoleRestartBlocked) {
                clearLastUpdateResult(config.dataDir);
            } else {
                persistUpdateResult(config.dataDir, {
                    sha: remoteSHA,
                    applied: result.applied?.length || 0,
                    failed: criticalFailures,
                    servicesFailed,
                    servicesRestarted: result.servicesRestarted || [],
                    shaSaved: result.shaSaved,
                    consoleRestartBlocked,
                    consoleRestartNote: result.consoleRestartNote || null,
                    serverBuild: result.serverBuild || null,
                    serverDeploy: result.serverDeploy || null,
                });
            }
        } catch (persistErr) {
            console.warn(`[UPDATE] Could not persist last update result: ${persistErr.message}`);
        }

        res.json({ success: true, data: result });

        if (scheduleConsoleRestart) {
            setTimeout(() => {
                console.log(`[UPDATE] Restarting console after update to ${remoteSHA.slice(0, 7)}...`);
                process.exit(0);
            }, 2000);
        }
    } catch (err) {
        console.error('Update install error:', err);
        res.status(500).json({ success: false, error: 'Update failed: ' + err.message });
    }
});

/**
 * GET /api/settings/updates/server-binary/status - Report whether the running
 * Go server binary is out of date (server source updated but binary not
 * rebuilt). Lets the panel surface a security warning instead of silently
 * reporting "up to date".
 */
router.get('/api/settings/updates/server-binary/status', requireAuth, requirePermission('server.config'), (req, res) => {
    try {
        const status = updateService.getServerBinaryStatus();
        res.json({ success: true, data: status });
    } catch (err) {
        console.error('Server binary status error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/settings/updates/server-binary/rebuild - Explicitly rebuild the Go
 * server binary from local source with the current dependency versions
 * (go.mod/go.sum) and deploy it. Bootstraps a vendored Go toolchain when one
 * is not installed.
 */
router.post('/api/settings/updates/server-binary/rebuild', requireAuth, requirePermission('server.config'), async (req, res) => {
    // Compilation may take several minutes.
    req.setTimeout(600000);
    res.setTimeout(600000);
    try {
        const result = await updateService.rebuildServerBinary({ restart: true });
        await db.logAction(
            req.session?.userId,
            'system_update',
            `Rebuilt server binary (${result.success ? 'success' : 'failed: ' + (result.error || 'unknown')})`,
            req.ip
        );
        if (!result.success) {
            return res.status(500).json({ success: false, error: result.error || 'Rebuild failed', data: result });
        }
        res.json({ success: true, data: result });
    } catch (err) {
        console.error('Server binary rebuild error:', err);
        res.status(500).json({ success: false, error: 'Rebuild failed: ' + err.message });
    }
});

/**
 * GET /api/settings/updates/backups - List pre-update backups
 */
router.get('/api/settings/updates/backups', requireAuth, requirePermission('server.config'), (req, res) => {
    try {
        const backups = updateService.listBackups();
        res.json({ success: true, data: backups });
    } catch (err) {
        console.error('List backups error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/settings/updates/restore - Restore from pre-update backup
 * Body: { backupName }
 */
router.post('/api/settings/updates/restore', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const { backupName } = req.body;
        if (!backupName || typeof backupName !== 'string') {
            return res.status(400).json({ success: false, error: 'backupName is required' });
        }

        const result = updateService.restoreFromBackup(backupName);

        await db.logAction(
            req.session?.userId,
            'system_restore',
            `Restored from backup: ${backupName} (v${result.version}, ${result.restored} files)`,
            req.ip
        );

        res.json({ success: true, data: result });

        // Restart after restore
        setTimeout(() => {
            console.log(`[UPDATE] Restarting after restore from ${backupName}...`);
            process.exit(0);
        }, 2000);
    } catch (err) {
        console.error('Restore error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * DELETE /api/settings/updates/backups/:name - Delete a single pre-update backup
 */
router.delete('/api/settings/updates/backups/:name', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const name = req.params.name;
        const result = updateService.deleteBackup(name);
        await db.logAction(req.session?.userId, 'backup_deleted', `Deleted update backup: ${name}`, req.ip);
        res.json({ success: true, data: result });
    } catch (err) {
        console.error('Delete backup error:', err);
        // 400 for validation errors, 500 for unexpected ones
        const status = /invalid|not found|outside/i.test(err.message) ? 400 : 500;
        res.status(status).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/settings/updates/backups/prune - Apply retention now
 * Body: { keep: number } — keep N newest, delete the rest
 */
router.post('/api/settings/updates/backups/prune', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const keep = parseInt(req.body?.keep, 10);
        if (!Number.isFinite(keep) || keep <= 0) {
            return res.status(400).json({ success: false, error: 'keep must be a positive integer' });
        }
        const result = updateService.pruneBackups(keep);
        if (result.deleted.length) {
            await db.logAction(
                req.session?.userId, 'backup_pruned',
                `Manual prune: kept ${keep}, deleted ${result.deleted.length} backup(s)`,
                req.ip
            );
        }
        res.json({ success: true, data: result });
    } catch (err) {
        console.error('Prune backups error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/settings/backup/retention - Read current retention count
 * Resolution: DB setting → env var BACKUP_RETENTION_COUNT → 0 (unlimited)
 */
router.get('/api/settings/backup/retention', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const dbVal = await db.getSetting('backup_retention_count');
        let count = 0;
        let source = 'unset';
        if (dbVal !== null && dbVal !== undefined && dbVal !== '') {
            const parsed = parseInt(dbVal, 10);
            if (Number.isFinite(parsed)) { count = parsed; source = 'database'; }
        } else if (process.env.BACKUP_RETENTION_COUNT) {
            const parsed = parseInt(process.env.BACKUP_RETENTION_COUNT, 10);
            if (Number.isFinite(parsed)) { count = parsed; source = 'environment'; }
        }
        res.json({ success: true, data: { count, source } });
    } catch (err) {
        console.error('Get retention error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * PUT /api/settings/backup/retention - Update retention count
 * Body: { count: number } — 0 means "keep all"
 */
router.put('/api/settings/backup/retention', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const count = parseInt(req.body?.count, 10);
        if (!Number.isFinite(count) || count < 0 || count > 1000) {
            return res.status(400).json({ success: false, error: 'count must be an integer between 0 and 1000' });
        }
        await db.setSetting('backup_retention_count', String(count));
        await db.logAction(
            req.session?.userId, 'backup_retention_changed',
            `Backup retention set to ${count === 0 ? 'unlimited' : count}`,
            req.ip
        );
        res.json({ success: true, data: { count } });
    } catch (err) {
        console.error('Set retention error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

// ==================== Device enrollment settings ============================

const betterdeskApi = require('../services/betterdeskApi');

const ENROLLMENT_SETTING_RICH = 'enrollment_rich_approve';
const ENROLLMENT_SETTING_TAG_PICKER = 'enrollment_tag_picker';

function parseBoolSetting(val, defaultValue = true) {
    if (val === null || val === undefined || val === '') return defaultValue;
    const s = String(val).toLowerCase();
    return s === '1' || s === 'true' || s === 'yes';
}

/**
 * GET /api/settings/enrollment — enrollment mode (Go) + panel UX toggles
 */
router.get('/api/settings/enrollment', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const modeResult = await betterdeskApi.getEnrollmentMode();
        const mode = (modeResult.success && modeResult.data?.mode) ? modeResult.data.mode : 'open';
        const richVal = await db.getSetting(ENROLLMENT_SETTING_RICH);
        const tagVal = await db.getSetting(ENROLLMENT_SETTING_TAG_PICKER);
        let pendingCount = 0;
        try {
            const pending = await betterdeskApi.getEnrollmentPending();
            if (pending.success) pendingCount = pending.count || 0;
        } catch (_) { /* non-fatal */ }
        res.json({
            success: true,
            data: {
                mode,
                require_approval: mode === 'managed',
                rich_approve: parseBoolSetting(richVal, true),
                tag_picker: parseBoolSetting(tagVal, true),
                pending_count: pendingCount,
            },
        });
    } catch (err) {
        console.error('Get enrollment settings error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * PUT /api/settings/enrollment
 * Body: { mode?, require_approval?, rich_approve?, tag_picker? }
 */
router.put('/api/settings/enrollment', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const body = req.body || {};
        let mode = body.mode;

        if (body.require_approval === true) {
            mode = 'managed';
        } else if (body.require_approval === false && (!mode || mode === 'managed')) {
            mode = 'open';
        }

        if (mode !== undefined) {
            const valid = ['open', 'managed', 'locked'];
            if (!valid.includes(mode)) {
                return res.status(400).json({ success: false, error: 'Invalid enrollment mode' });
            }
            const setResult = await betterdeskApi.setEnrollmentMode(mode);
            if (!setResult.success) {
                return res.status(500).json({ success: false, error: setResult.error || 'Failed to set enrollment mode' });
            }
        }

        if (body.rich_approve !== undefined) {
            await db.setSetting(ENROLLMENT_SETTING_RICH, body.rich_approve ? 'true' : 'false');
        }
        if (body.tag_picker !== undefined) {
            await db.setSetting(ENROLLMENT_SETTING_TAG_PICKER, body.tag_picker ? 'true' : 'false');
        }

        await db.logAction(
            req.session?.userId,
            'enrollment_settings_changed',
            `Enrollment settings updated (mode=${mode || 'unchanged'})`,
            req.ip
        );

        const modeResult = await betterdeskApi.getEnrollmentMode();
        const currentMode = (modeResult.success && modeResult.data?.mode) ? modeResult.data.mode : (mode || 'open');
        const richVal = await db.getSetting(ENROLLMENT_SETTING_RICH);
        const tagVal = await db.getSetting(ENROLLMENT_SETTING_TAG_PICKER);

        res.json({
            success: true,
            data: {
                mode: currentMode,
                require_approval: currentMode === 'managed',
                rich_approve: parseBoolSetting(richVal, true),
                tag_picker: parseBoolSetting(tagVal, true),
            },
        });
    } catch (err) {
        console.error('Set enrollment settings error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

// ==================== LDAP Configuration API (proxy to Go server) ===========

/**
 * GET /api/settings/ldap - Get LDAP configuration from Go server
 */
router.get('/api/settings/ldap', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const result = await betterdeskApi.getLDAPConfig();
        if (!result.success) {
            return res.status(500).json({ success: false, error: result.error || 'Failed to load LDAP config' });
        }
        res.json(result.data);
    } catch (err) {
        console.error('Get LDAP config error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * PUT /api/settings/ldap - Save LDAP configuration to Go server
 */
router.put('/api/settings/ldap', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const result = await betterdeskApi.saveLDAPConfig(req.body);
        if (!result.success) {
            return res.status(400).json({ success: false, error: result.error || 'Failed to save LDAP config' });
        }

        await db.logAction(req.session?.userId, 'ldap_config_updated', 'Updated LDAP configuration', req.ip);

        res.json({ success: true });
    } catch (err) {
        console.error('Save LDAP config error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/settings/ldap/test - Test LDAP connection via Go server
 */
router.post('/api/settings/ldap/test', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const result = await betterdeskApi.testLDAPConnection(req.body);
        if (!result.success) {
            return res.json({ success: false, error: result.error || 'Connection test failed' });
        }
        res.json(result.data);
    } catch (err) {
        console.error('Test LDAP connection error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

// ==================== RustDesk client sessions (Issue #242) ==================

const { upsertEnvKey } = require('../lib/envMerge');
const CLIENT_SESSIONS_ENV_PATH = path.join(__dirname, '..', '.env');

function clampClientSessionDays(value, fallback) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return Math.min(n, 365);
}

function parseClientSessionBool(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const v = String(value).toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
    return fallback;
}

/**
 * GET /api/settings/client-sessions
 */
router.get('/api/settings/client-sessions', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const [expiryR, slidingR, maxR] = await Promise.all([
            betterdeskApi.getConfig('client_session_expiry_days'),
            betterdeskApi.getConfig('client_session_sliding'),
            betterdeskApi.getConfig('client_session_max_days'),
        ]);

        const expiryRaw = expiryR.success ? expiryR.data?.value : '';
        const slidingRaw = slidingR.success ? slidingR.data?.value : '';
        const maxRaw = maxR.success ? maxR.data?.value : '';

        res.json({
            success: true,
            data: {
                expiry_days: clampClientSessionDays(expiryRaw, 7),
                sliding: parseClientSessionBool(slidingRaw, true),
                max_days: clampClientSessionDays(maxRaw, 30),
            },
        });
    } catch (err) {
        console.error('Get client session settings error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * PUT /api/settings/client-sessions
 * Body: { expiry_days?, sliding?, max_days? }
 */
router.put('/api/settings/client-sessions', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const body = req.body || {};
        const expiryDays = clampClientSessionDays(body.expiry_days, 7);
        const maxDays = clampClientSessionDays(body.max_days, 30);
        const sliding = body.sliding !== false;

        const results = await Promise.all([
            betterdeskApi.setConfig('client_session_expiry_days', String(expiryDays)),
            betterdeskApi.setConfig('client_session_sliding', sliding ? 'true' : 'false'),
            betterdeskApi.setConfig('client_session_max_days', String(maxDays)),
        ]);
        const failed = results.find(r => !r.success);
        if (failed) {
            return res.status(500).json({ success: false, error: failed.error || 'Failed to save client session settings' });
        }

        if (fs.existsSync(CLIENT_SESSIONS_ENV_PATH)) {
            let content = fs.readFileSync(CLIENT_SESSIONS_ENV_PATH, 'utf8');
            content = upsertEnvKey(content, 'API_TOKEN_EXPIRY_DAYS', String(expiryDays));
            fs.writeFileSync(CLIENT_SESSIONS_ENV_PATH, content, { mode: 0o600 });
        }
        process.env.API_TOKEN_EXPIRY_DAYS = String(expiryDays);

        await db.logAction(
            req.session?.userId,
            'client_session_settings_changed',
            `RustDesk client sessions: ${expiryDays}d sliding=${sliding} max=${maxDays}d`,
            req.ip
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Save client session settings error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

// ==================== OIDC Configuration API (proxy to Go server) ===========

/**
 * GET /api/settings/oidc - Get OIDC configuration from Go server
 */
router.get('/api/settings/oidc', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const result = await betterdeskApi.getOIDCConfig();
        if (!result.success) {
            return res.status(500).json({ success: false, error: result.error || 'Failed to load OIDC config' });
        }
        res.json(result.data);
    } catch (err) {
        console.error('Get OIDC config error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * PUT /api/settings/oidc - Save OIDC configuration to Go server
 */
router.put('/api/settings/oidc', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const result = await betterdeskApi.saveOIDCConfig(req.body);
        if (!result.success) {
            return res.status(400).json({ success: false, error: result.error || 'Failed to save OIDC config' });
        }

        await db.logAction(req.session?.userId, 'oidc_config_updated', 'Updated OIDC configuration', req.ip);

        res.json({ success: true });
    } catch (err) {
        console.error('Save OIDC config error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * POST /api/settings/oidc/test - Test OIDC discovery via Go server
 */
router.post('/api/settings/oidc/test', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const result = await betterdeskApi.testOIDCDiscovery(req.body);
        if (!result.success) {
            return res.json({ success: false, error: result.error || 'Discovery test failed' });
        }
        res.json(result.data);
    } catch (err) {
        console.error('Test OIDC discovery error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

// ==================== Advanced config files ==================================

function advancedConfigError(req, res, err) {
    const map = {
        unknown_file: 'settings.advanced_error_unknown',
        not_found: 'settings.advanced_error_not_found',
        not_a_file: 'settings.advanced_error_not_file',
        file_too_large: 'settings.advanced_error_too_large',
        binary_file: 'settings.advanced_error_binary',
        invalid_content: 'settings.advanced_error_invalid',
        not_writable: 'settings.advanced_error_not_writable',
        no_restart: 'settings.advanced_error_no_restart'
    };
    const key = map[err.message];
    const status = err.message === 'unknown_file' ? 404
        : (err.message === 'not_found' ? 404 : 400);
    res.status(status).json({
        success: false,
        error: key ? req.t(key) : (err.message || req.t('errors.server_error'))
    });
}

/**
 * GET /api/settings/advanced/files - List editable config files
 */
router.get('/api/settings/advanced/files', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const files = await advancedConfig.listFiles();
        res.json({ success: true, data: files });
    } catch (err) {
        console.error('List advanced config files error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * GET /api/settings/advanced/files/:id - Read a config file
 */
router.get('/api/settings/advanced/files/:id', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const data = await advancedConfig.readFile(req.params.id);
        res.json({ success: true, data });
    } catch (err) {
        if (['unknown_file', 'not_found', 'not_a_file', 'file_too_large', 'binary_file'].includes(err.message)) {
            return advancedConfigError(req, res, err);
        }
        console.error('Read advanced config file error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * PUT /api/settings/advanced/files/:id - Save a config file (backup created when overwriting)
 */
router.put('/api/settings/advanced/files/:id', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const { content } = req.body || {};
        const result = await advancedConfig.writeFile(req.params.id, content);
        await db.logAction(
            req.session?.userId,
            'advanced_config_saved',
            `Saved advanced config: ${result.path}${result.backupPath ? ` (backup: ${result.backupPath})` : ''}`,
            req.ip
        );
        res.json({
            success: true,
            data: result,
            message: req.t('settings.advanced_saved')
        });
    } catch (err) {
        if (['unknown_file', 'not_found', 'not_a_file', 'file_too_large', 'invalid_content', 'not_writable'].includes(err.message)) {
            return advancedConfigError(req, res, err);
        }
        console.error('Write advanced config file error:', err);
        res.status(500).json({ success: false, error: err.message || req.t('errors.server_error') });
    }
});

/**
 * POST /api/settings/advanced/restart - Restart services for the given config file
 * Body: { fileId }
 */
router.post('/api/settings/advanced/restart', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const fileId = req.body && req.body.fileId;
        if (!fileId || typeof fileId !== 'string') {
            return res.status(400).json({ success: false, error: req.t('settings.advanced_error_unknown') });
        }

        const result = advancedConfig.restartForFile(fileId);
        const failed = (result.restarts || []).filter((r) => !r.success);
        const daemonFailed = result.daemonReload && result.daemonReload.success === false;

        await db.logAction(
            req.session?.userId,
            'advanced_config_restart',
            `Restart after advanced config (${fileId}): ${JSON.stringify(result.restarts)}`,
            req.ip
        );

        if (daemonFailed || failed.length) {
            const parts = [];
            if (daemonFailed && result.daemonReload.error) parts.push(result.daemonReload.error);
            failed.forEach((f) => { if (f.error) parts.push(`${f.service}: ${f.error}`); });
            return res.status(500).json({
                success: false,
                error: req.t('settings.advanced_restart_failed'),
                data: result,
                details: parts.join('; ')
            });
        }

        res.json({
            success: true,
            data: result,
            message: req.t('settings.advanced_restart_started')
        });
    } catch (err) {
        if (['unknown_file', 'no_restart'].includes(err.message)) {
            return advancedConfigError(req, res, err);
        }
        console.error('Advanced config restart error:', err);
        res.status(500).json({ success: false, error: err.message || req.t('errors.server_error') });
    }
});

/**
 * GET /api/settings/connection-mode — read saved P2P/relay strategy
 */
router.get('/api/settings/connection-mode', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const saved = await serverConnectionConfig.getConnectionMode();
        let runtime = null;
        try {
            const health = await apiClient({ method: 'get', url: '/health', timeout: 5000 });
            runtime = health.data?.connection || null;
        } catch (_) { /* Go server may be down */ }

        res.json({
            success: true,
            data: {
                ...saved,
                deployment: serverConnectionConfig.detectDeploymentSource(),
                runtime
            }
        });
    } catch (err) {
        console.error('Get connection mode error:', err);
        res.status(500).json({ success: false, error: err.message || req.t('errors.server_error') });
    }
});

/**
 * PUT /api/settings/connection-mode — persist P2P/relay strategy
 * Body: { mode, p2p_fallback_ms?, same_nat_relay?, restart?: boolean }
 */
router.put('/api/settings/connection-mode', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const body = req.body || {};
        const result = await serverConnectionConfig.setConnectionMode({
            mode: body.mode,
            p2p_fallback_ms: body.p2p_fallback_ms,
            same_nat_relay: body.same_nat_relay
        });

        await db.logAction(
            req.session?.userId,
            'connection_mode_changed',
            `Connection mode set to ${result.settings.mode} (${result.source})`,
            req.ip
        );

        let restart = null;
        if (body.restart) {
            restart = serverConnectionConfig.restartServer();
        }

        res.json({
            success: true,
            data: { ...result, restart },
            message: req.t('settings.connection_mode_saved')
        });
    } catch (err) {
        if (err.message === 'not_configurable') {
            return res.status(400).json({
                success: false,
                error: req.t('settings.connection_mode_not_configurable')
            });
        }
        if (err.message === 'docker_compose_server_not_found') {
            return res.status(400).json({
                success: false,
                error: req.t('settings.connection_mode_compose_error')
            });
        }
        console.error('Set connection mode error:', err);
        res.status(500).json({ success: false, error: err.message || req.t('errors.server_error') });
    }
});

/**
 * POST /api/settings/connection-mode/restart — restart Go server after mode change
 */
router.post('/api/settings/connection-mode/restart', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const result = serverConnectionConfig.restartServer();
        const failed = (result.restarts || []).filter((r) => !r.success);
        const daemonFailed = result.daemonReload && result.daemonReload.success === false;

        await db.logAction(
            req.session?.userId,
            'connection_mode_restart',
            `Restart after connection mode change: ${JSON.stringify(result.restarts)}`,
            req.ip
        );

        if (daemonFailed || failed.length) {
            const parts = [];
            if (daemonFailed && result.daemonReload.error) parts.push(result.daemonReload.error);
            failed.forEach((f) => { if (f.error) parts.push(`${f.service}: ${f.error}`); });
            return res.status(500).json({
                success: false,
                error: req.t('settings.connection_mode_restart_failed'),
                data: result,
                details: parts.join('; ')
            });
        }

        res.json({
            success: true,
            data: result,
            message: req.t('settings.connection_mode_restart_started')
        });
    } catch (err) {
        if (err.message === 'no_restart') {
            return res.status(400).json({
                success: false,
                error: req.t('settings.connection_mode_not_configurable')
            });
        }
        console.error('Connection mode restart error:', err);
        res.status(500).json({ success: false, error: err.message || req.t('errors.server_error') });
    }
});

/**
 * GET /api/settings/public-endpoints — RustDesk public client endpoints (durable dataDir + .env)
 */
router.get('/api/settings/public-endpoints', requireAuth, requirePermission('server.config'), (req, res) => {
    try {
        const settings = rustDeskPublicEndpoints.getPublicEndpointSettings();
        res.json({
            success: true,
            data: {
                ...settings,
                env_override_active: rustDeskPublicEndpoints.isEnvOverrideActive(settings),
            },
        });
    } catch (err) {
        console.error('Get public endpoints error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

/**
 * PUT /api/settings/public-endpoints — persist RustDesk public client endpoints (dataDir + .env)
 */
router.put('/api/settings/public-endpoints', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const body = req.body || {};
        const result = await rustDeskPublicEndpoints.savePublicEndpointSettings({
            public_server_id: body.public_server_id,
            public_relay_server: body.public_relay_server,
            public_api_url: body.public_api_url,
        });

        await db.logAction(
            req.session?.userId,
            'public_endpoints_changed',
            `RustDesk public endpoints updated (ID=${result.settings.public_server_id || '-'}, relay=${result.settings.public_relay_server || '-'}, api=${result.settings.public_api_url || '-'})`,
            req.ip
        );

        res.json({
            success: true,
            data: {
                ...result.settings,
                env_override_active: rustDeskPublicEndpoints.isEnvOverrideActive(result.settings),
            },
            message: req.t('settings.public_endpoints_saved'),
        });
    } catch (err) {
        if (err.message === 'invalid_public_host') {
            return res.status(400).json({
                success: false,
                error: req.t('settings.public_endpoints_invalid_host'),
            });
        }
        if (err.message === 'invalid_public_api_url') {
            return res.status(400).json({
                success: false,
                error: req.t('settings.public_endpoints_invalid_api_url'),
            });
        }
        console.error('Save public endpoints error:', err);
        res.status(500).json({ success: false, error: err.message || req.t('errors.server_error') });
    }
});

/**
 * GET /api/settings/email/smtp — SMTP configuration (masked secrets).
 */
router.get('/api/settings/email/smtp', requireAuth, requirePermission('server.config'), getSmtpSettings);

/**
 * PUT /api/settings/email/smtp — Update SMTP configuration.
 */
router.put('/api/settings/email/smtp', requireAuth, requirePermission('server.config'), putSmtpSettings);

/**
 * POST /api/settings/email/smtp/test — Test SMTP connection.
 */
router.post('/api/settings/email/smtp/test', requireAuth, requirePermission('server.config'), testSmtpSettings);

module.exports = router;
