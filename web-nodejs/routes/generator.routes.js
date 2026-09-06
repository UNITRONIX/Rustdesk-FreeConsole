/**
 * BetterDesk Console — Support Generator routes
 *
 * Provides:
 *   - Generator admin panel (/generator) — module install + bundle editor
 *   - Module install API (/api/generator/module/*)
 *   - Bundle management REST API (/api/generator/bundles/*)
 *   - Public download portal per bundle (/d/:slug)
 */

'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');
const keyService = require('../services/keyService');
const bundleService = require('../services/agentBundleService');
const clientTemplateWorker = require('../services/clientTemplateWorker');
const supportModule = require('../services/supportGeneratorModule');
const db = require('../services/database');
const config = require('../config/config');
const brandingService = require('../services/brandingService');
const conn = require('../services/agentBundleConnection');
const clientConfigHost = require('../services/clientConfigHost');
const { PRODUCT_TYPES, normalizeProductType } = require('../lib/generatorBuildTypes');

// Branding payloads may carry a base64-encoded logo up to 10 MB; expand the
// default 2 MB JSON body limit on the bundle CRUD + preview endpoints only.
const largeJson = express.json({ limit: '16mb' });
router.use(['/api/generator/bundles', '/api/generator/preview'], largeJson);

// =========================================================================
//  Helpers
// =========================================================================

function parseBranding(raw) {
    if (!raw) return bundleService.defaultBranding();
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch (_) { return bundleService.defaultBranding(); }
}

function serializeBundle(row) {
    if (!row) return null;
    const publicId = bundleService.publicBundleId(row);
    return {
        bundle_id:       row.bundle_id,
        slug:            row.slug || '',
        public_id:       publicId,
        name:            row.name,
        branding:        publicBrandingView(parseBranding(row.branding)),
        branding_hash:   row.branding_hash,
        revoked:         !!row.revoked,
        download_count:  Number(row.download_count || 0),
        created_at:      row.created_at,
        updated_at:      row.updated_at,
        download_url:    `/d/${publicId}`,
        product_type:    normalizeProductType(row.product_type),
    };
}

async function resolvePublicBundle(publicId) {
    return db.getAgentBundleByPublicId(publicId);
}

async function resolveBundleSlug({ preferred, name, fallbackId, excludeBundleId = null }) {
    const normalizedPreferred = preferred ? bundleService.normalizeSlug(preferred) : '';
    if (normalizedPreferred) {
        const check = bundleService.validateSlug(normalizedPreferred);
        if (!check.valid) {
            return { ok: false, error: check.error };
        }
        if (await db.isAgentBundleSlugTaken(normalizedPreferred, excludeBundleId)) {
            return { ok: false, error: 'slug_taken' };
        }
        return { ok: true, slug: normalizedPreferred };
    }
    const slug = bundleService.allocateUniqueSlug({
        preferred: null,
        name,
        fallbackId,
        isTaken: (s) => db.isAgentBundleSlugTaken(s, excludeBundleId),
    });
    return { ok: true, slug };
}

/**
 * Inject server host / API / public key for BetterDesk Support custom.txt builds.
 * Branding colors/logos are no longer baked into installers — Client Branding API
 * supplies runtime appearance.
 */
async function finalizeSupportBranding(input) {
    const src = input || {};
    const branding = { ...src };
    const hostNorm = conn.normalizeServerHost(
        branding.server_host || clientConfigHost.resolveClientFacingHost?.() || conn.defaultServerHost()
    );
    const host = hostNorm.valid ? hostNorm.host : String(branding.server_host || '').trim();
    const useHttps = !!(branding.use_https ?? true);
    const apiPort = String(branding.api_port || conn.defaultApiPort());
    const scheme = useHttps ? 'https' : 'http';
    const omitPort = (scheme === 'https' && apiPort === '443') || (scheme === 'http' && apiPort === '80');
    const apiServer = branding.api_server
        || (omitPort ? `${scheme}://${host}` : `${scheme}://${host}:${apiPort}`);
    const pubKey = (await keyService.resolvePublicKey()) || branding.public_key || '';

    branding.server_host = host;
    branding.relay_host = String(branding.relay_host || host).trim();
    branding.api_server = apiServer;
    branding.api_port = apiPort;
    branding.use_https = useHttps;
    branding.public_key = pubKey;
    branding.server_key = pubKey;
    branding.app_name = String(branding.app_name || branding.company_name || 'BetterDesk Support Agent').trim()
        || 'BetterDesk Support Agent';
    branding.company_name = String(branding.company_name || branding.app_name).trim();
    branding.product_name = branding.app_name;
    branding.disable_settings = branding.disable_settings !== false;
    branding.server = {
        address: omitPort ? `${scheme}://${host}` : `${scheme}://${host}:${apiPort}`,
        api_url: apiServer,
        public_key: pubKey,
    };
    delete branding.enrollment_token;
    delete branding.has_enrollment_token;
    delete branding.enrollment_token_masked;
    return branding;
}

function publicBrandingView(branding) {
    if (!branding || typeof branding !== 'object') return branding;
    const out = { ...branding };
    delete out.enrollment_token;
    delete out.has_enrollment_token;
    delete out.enrollment_token_masked;
    return out;
}

function resolveBuildWorker() {
    return clientTemplateWorker;
}

// =========================================================================
//  Generator page
// =========================================================================

router.get('/generator', requireAuth, requireAdmin, (req, res) => {
    res.render('generator', {
        title: req.t('nav.generator'),
        activePage: 'generator',
        supportedLangs: bundleService.SUPPORTED_LANGS,
        localeLabels: bundleService.LOCALE_LABELS,
    });
});

// =========================================================================
//  Module install gate
// =========================================================================

router.get('/api/generator/module/status', requireAuth, requireAdmin, async (req, res) => {
    try {
        const status = await supportModule.getStatus();
        res.json({ success: true, data: status });
    } catch (err) {
        console.error('[generator] module status error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

router.post('/api/generator/module/accept-terms', requireAuth, requireAdmin, async (req, res) => {
    try {
        const state = await supportModule.acceptTerms();
        res.json({ success: true, data: state });
    } catch (err) {
        console.error('[generator] accept-terms error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

router.post('/api/generator/module/install', requireAuth, requireAdmin, async (req, res) => {
    try {
        const repo = req.body?.repo ? String(req.body.repo).trim() : undefined;
        const tag = req.body?.tag ? String(req.body.tag).trim() : undefined;
        const state = await supportModule.installFromGitHub({ repo, tag });
        res.json({ success: true, data: state });
    } catch (err) {
        const code = err.code || '';
        if (code === 'terms_not_accepted') {
            return res.status(400).json({ success: false, error: 'terms_not_accepted' });
        }
        console.error('[generator] module install error:', err);
        res.status(500).json({
            success: false,
            error: err.message || req.t('errors.server_error'),
        });
    }
});

// =========================================================================
//  Bundle management API (admin only)
// =========================================================================

router.get('/api/generator/bundles', requireAuth, requireAdmin, async (req, res) => {
    try {
        const includeRevoked = req.query.includeRevoked === '1';
        const rows = await db.listAgentBundles({ includeRevoked });
        res.json({ success: true, data: { bundles: rows.map(serializeBundle) } });
    } catch (err) {
        console.error('[generator] list bundles error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

router.get('/api/generator/bundles/:bundleId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const row = await db.getAgentBundle(req.params.bundleId);
        if (!row) return res.status(404).json({ success: false, error: req.t('errors.not_found') });
        const bundle = serializeBundle(row);
        const builds = await db.listAgentBundleBuildsForHash(row.branding_hash);
        bundle.builds = builds || [];
        res.json({ success: true, data: { bundle } });
    } catch (err) {
        console.error('[generator] get bundle error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

router.get('/api/generator/defaults', requireAuth, requireAdmin, async (req, res) => {
    const host = clientConfigHost.resolveClientFacingHost(req) || conn.defaultServerHost();
    res.json({
        success: true,
        data: {
            server_host: host,
            relay_host: host,
            use_https: conn.defaultUseHttps(),
            api_port: conn.defaultApiPort(),
            public_key: (await keyService.resolvePublicKey()) || '',
            app_name: 'BetterDesk Support Agent',
        },
    });
});

router.post('/api/generator/bundles', requireAuth, requireAdmin, async (req, res) => {
    try {
        if (!supportModule.isReady()) {
            return res.status(400).json({ success: false, error: 'module_not_ready' });
        }
        const name = String(req.body.name || '').trim().slice(0, 100);
        if (!name) {
            return res.status(400).json({ success: false, error: req.t('generator.errors.name_required') });
        }
        const productType = PRODUCT_TYPES.BETTERDESK_SUPPORT;
        const { valid, errors, normalized: base } = bundleService.validateBranding(req.body.branding || {});
        if (!valid) {
            return res.status(400).json({ success: false, error: req.t('generator.errors.validation_failed'), errors, details: errors });
        }
        const bundleId = bundleService.generateBundleId();
        const slugResult = await resolveBundleSlug({
            preferred: String(req.body.slug || '').trim(),
            name,
            fallbackId: bundleId,
        });
        if (!slugResult.ok) {
            return res.status(400).json({
                success: false,
                error: req.t('generator.errors.validation_failed'),
                errors: [slugResult.error],
                details: [slugResult.error],
            });
        }
        const normalized = await finalizeSupportBranding(base);
        normalized.bundle_id = bundleId;
        const brandingHash = bundleService.hashBranding(normalized);
        const created = await db.createAgentBundle({
            bundleId,
            slug: slugResult.slug,
            name,
            branding: JSON.stringify(normalized),
            brandingHash,
            createdBy: req.session?.userId || null,
            productType,
        });
        const platformsFilter = Array.isArray(req.body.platforms) ? req.body.platforms : null;
        resolveBuildWorker().enqueueBuildsForHash(brandingHash, {
            platforms: platformsFilter,
        }).catch((e) => {
            console.error('[generator] enqueue builds failed:', e.message);
        });
        res.json({ success: true, data: { bundle: serializeBundle(created) } });
    } catch (err) {
        console.error('[generator] create bundle error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

router.put('/api/generator/bundles/:bundleId', requireAuth, requireAdmin, async (req, res) => {
    try {
        if (!supportModule.isReady()) {
            return res.status(400).json({ success: false, error: 'module_not_ready' });
        }
        const existing = await db.getAgentBundle(req.params.bundleId);
        if (!existing) return res.status(404).json({ success: false, error: req.t('errors.not_found') });
        const name = String(req.body.name || existing.name).trim().slice(0, 100);
        if (!name) {
            return res.status(400).json({ success: false, error: req.t('generator.errors.name_required') });
        }
        const existingBranding = parseBranding(existing.branding);
        const { valid, errors, normalized: base } = bundleService.validateBranding(req.body.branding || existingBranding);
        if (!valid) {
            return res.status(400).json({ success: false, error: req.t('generator.errors.validation_failed'), errors, details: errors });
        }
        const normalized = await finalizeSupportBranding(base);
        normalized.bundle_id = req.params.bundleId;
        const brandingHash = bundleService.hashBranding(normalized);
        let slug = existing.slug || '';
        if (req.body.slug !== undefined) {
            const slugResult = await resolveBundleSlug({
                preferred: String(req.body.slug || '').trim(),
                name,
                fallbackId: existing.bundle_id,
                excludeBundleId: existing.bundle_id,
            });
            if (!slugResult.ok) {
                return res.status(400).json({
                    success: false,
                    error: req.t('generator.errors.validation_failed'),
                    errors: [slugResult.error],
                    details: [slugResult.error],
                });
            }
            slug = slugResult.slug;
        } else if (!slug) {
            const slugResult = await resolveBundleSlug({
                preferred: null,
                name,
                fallbackId: existing.bundle_id,
                excludeBundleId: existing.bundle_id,
            });
            slug = slugResult.slug;
        }
        const updated = await db.updateAgentBundle(req.params.bundleId, {
            name,
            slug,
            branding: JSON.stringify(normalized),
            brandingHash,
        });
        if (existing.branding_hash !== brandingHash) {
            const platformsFilter = Array.isArray(req.body.platforms) ? req.body.platforms : null;
            resolveBuildWorker().enqueueBuildsForHash(brandingHash, {
                platforms: platformsFilter,
            }).catch((e) => {
                console.error('[generator] enqueue builds failed:', e.message);
            });
        }
        res.json({ success: true, data: { bundle: serializeBundle(updated) } });
    } catch (err) {
        console.error('[generator] update bundle error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

router.post('/api/generator/bundles/:bundleId/rebuild', requireAuth, requireAdmin, async (req, res) => {
    try {
        const row = await db.getAgentBundle(req.params.bundleId);
        if (!row) return res.status(404).json({ success: false, error: req.t('errors.not_found') });
        if (row.revoked) {
            return res.status(400).json({ success: false, error: req.t('generator.errors.rebuild_revoked') });
        }
        if (!supportModule.isReady()) {
            return res.status(400).json({ success: false, error: 'module_not_ready' });
        }
        const platformsFilter = Array.isArray(req.body?.platforms) ? req.body.platforms : null;
        const result = await resolveBuildWorker().rebuildBundleById(
            req.params.bundleId,
            platformsFilter ? { platforms: platformsFilter } : undefined
        );
        if (!result.success) {
            return res.status(404).json({ success: false, error: req.t('errors.not_found') });
        }
        const listHash = result.brandingHash || row.branding_hash;
        const builds = await db.listAgentBundleBuildsForHash(listHash);
        res.json({
            success: true,
            data: {
                queued: result.platforms,
                builds: builds || [],
            },
        });
    } catch (err) {
        console.error('[generator] rebuild bundle error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

router.post(
    '/api/generator/bundles/:bundleId/rebuild/:platform/:arch/:format',
    requireAuth,
    requireAdmin,
    async (req, res) => {
        try {
            const row = await db.getAgentBundle(req.params.bundleId);
            if (!row) return res.status(404).json({ success: false, error: req.t('errors.not_found') });
            if (row.revoked) {
                return res.status(400).json({ success: false, error: req.t('generator.errors.rebuild_revoked') });
            }
            if (!row.branding_hash) {
                return res.status(400).json({ success: false, error: req.t('generator.errors.missing_hash') });
            }
            if (!supportModule.isReady()) {
                return res.status(400).json({ success: false, error: 'module_not_ready' });
            }
            const worker = resolveBuildWorker();
            const result = await worker.requeuePlatformBuild(
                row.branding_hash,
                req.params.platform,
                req.params.arch,
                req.params.format
            );
            if (!result.success) {
                const errKey = result.error === 'unsupported_platform'
                    ? 'generator.errors.unsupported_platform'
                    : 'errors.bad_request';
                return res.status(400).json({ success: false, error: req.t(errKey) });
            }
            const listHash = result.brandingHash || row.branding_hash;
            const builds = await db.listAgentBundleBuildsForHash(listHash);
            res.json({ success: true, data: { builds: builds || [] } });
        } catch (err) {
            console.error('[generator] rebuild platform error:', err);
            res.status(500).json({ success: false, error: req.t('errors.server_error') });
        }
    }
);

router.get('/api/generator/build-status', requireAuth, requireAdmin, (req, res) => {
    try {
        const status = clientTemplateWorker.getBuildWorkerStatus();
        res.json({ success: true, data: status });
    } catch (err) {
        console.error('[generator] build-status error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

router.post('/api/generator/bundles/:bundleId/revoke', requireAuth, requireAdmin, async (req, res) => {
    try {
        const revoked = req.body.revoked !== false;
        const row = await db.setAgentBundleRevoked(req.params.bundleId, revoked);
        if (!row) return res.status(404).json({ success: false, error: req.t('errors.not_found') });
        res.json({ success: true, data: { bundle: serializeBundle(row) } });
    } catch (err) {
        console.error('[generator] revoke bundle error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

router.delete('/api/generator/bundles/:bundleId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const ok = await db.deleteAgentBundle(req.params.bundleId);
        if (!ok) return res.status(404).json({ success: false, error: req.t('errors.not_found') });
        res.json({ success: true });
    } catch (err) {
        console.error('[generator] delete bundle error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

router.post('/api/generator/preview', requireAuth, requireAdmin, async (req, res) => {
    try {
        const rawBranding = await finalizeSupportBranding(req.body.branding || {});
        const { valid, errors, normalized } = bundleService.validateBranding(rawBranding);
        res.json({ success: true, data: { valid, errors, branding: publicBrandingView(normalized) }, errors });
    } catch (err) {
        console.error('[generator] preview error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

router.get('/api/generator/platforms', requireAuth, requireAdmin, (req, res) => {
    res.json({ success: true, data: { platforms: bundleService.PLATFORMS } });
});

// =========================================================================
//  Public download portal
// =========================================================================

router.get('/d/:publicId', async (req, res) => {
    try {
        const row = await resolvePublicBundle(req.params.publicId);
        if (!row || row.revoked) {
            return res.status(404).render('errors/404', {
                title: req.t('errors.not_found'),
                layout: false,
            });
        }
        const bundle = serializeBundle(row);
        const builds = await db.listAgentBundleBuildsForHash(row.branding_hash);
        const buildMap = {};
        for (const b of (builds || [])) {
            buildMap[`${b.platform}/${b.arch}/${b.format}`] = b.status;
        }
        const platforms = bundleService.PLATFORMS.map(p => ({
            ...p,
            status: buildMap[`${p.platform}/${p.arch}/${p.format}`] || 'pending',
        }));
        const gb = brandingService.getBranding();
        const globalBranding = {
            background: brandingService.buildBackgroundValue(gb.agentBgType, gb.agentBgColor, gb.agentBgGradient, gb.agentBgImageUrl),
            showPoweredBy: gb.agentShowPoweredBy !== 'false',
            appName: gb.appName || 'BetterDesk',
            logoUrl: gb.logoType === 'image' ? gb.logoUrl : '',
        };
        res.render('agent-download', {
            bundle,
            platforms,
            globalBranding,
            productType: normalizeProductType(row.product_type),
            t: req.t.bind(req),
        });
    } catch (err) {
        console.error('[generator] portal error:', err);
        res.status(500).render('errors/500', { title: req.t('errors.server_error'), layout: false });
    }
});

router.get('/api/d/:publicId/manifest', async (req, res) => {
    try {
        const row = await resolvePublicBundle(req.params.publicId);
        if (!row || row.revoked) return res.status(404).json({ success: false });
        const builds = await db.listAgentBundleBuildsForHash(row.branding_hash);
        const buildMap = {};
        for (const b of (builds || [])) {
            buildMap[`${b.platform}/${b.arch}/${b.format}`] = {
                status: b.status,
                size: Number(b.artifact_size || 0),
                sha256: b.artifact_sha256 || null,
            };
        }
        const platforms = bundleService.PLATFORMS.map(p => ({
            ...p,
            ...(buildMap[`${p.platform}/${p.arch}/${p.format}`] || { status: 'pending' }),
        }));
        res.json({
            success: true,
            data: {
                bundle_id: row.bundle_id,
                public_id: bundleService.publicBundleId(row),
                name: row.name,
                product_type: normalizeProductType(row.product_type),
                platforms,
            },
        });
    } catch (err) {
        console.error('[generator] manifest error:', err);
        res.status(500).json({ success: false });
    }
});

router.get('/api/d/:publicId/download/:platform/:arch/:format', async (req, res) => {
    try {
        const row = await resolvePublicBundle(req.params.publicId);
        if (!row || row.revoked) return res.status(404).json({ success: false });
        const build = await db.getAgentBundleBuild({
            brandingHash: row.branding_hash,
            platform: req.params.platform,
            arch: req.params.arch,
            format: req.params.format,
        });
        if (!build || build.status !== 'ready' || !build.artifact_path) {
            return res.status(503).json({
                success: false,
                error: 'build_pending',
                status: build ? build.status : 'pending',
            });
        }
        await db.incrementAgentBundleDownload(row.bundle_id);
        return res.download(build.artifact_path);
    } catch (err) {
        console.error('[generator] download error:', err);
        res.status(500).json({ success: false });
    }
});

// =========================================================================
//  Legacy TOML config generator (deprecated, kept for compatibility)
// =========================================================================

router.get('/api/generator/config', requireAuth, async (req, res) => {
    try {
        const publicKey = await keyService.resolvePublicKey();
        res.json({
            success: true,
            data: {
                publicKey,
                serverUrl: config.hbbsApiUrl.replace('/api', ''),
                defaults: { rendezvousServer: '', apiServer: '', key: publicKey || '' },
            },
        });
    } catch (err) {
        console.error('Get generator config error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

router.post('/api/generator/generate-config', requireAuth, async (req, res) => {
    try {
        const { serverHost, serverPort, relayHost, relayPort, clientName } = req.body;
        if (!serverHost) {
            return res.status(400).json({ success: false, error: 'Server host is required' });
        }
        const publicKey = await keyService.resolvePublicKey();
        const lines = [];
        lines.push(`rendezvous_server = ${serverHost}:${serverPort || 21116}`);
        if (relayHost) lines.push(`relay_server = ${relayHost}:${relayPort || 21117}`);
        if (publicKey) lines.push(`key = ${publicKey}`);
        if (clientName) lines.push(`name = ${clientName}`);
        res.json({
            success: true,
            data: { config: lines.join('\n'), fileName: 'rustdesk.toml' },
        });
    } catch (err) {
        console.error('Generate config error:', err);
        res.status(500).json({ success: false, error: req.t('errors.server_error') });
    }
});

module.exports = router;
