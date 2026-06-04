/**
 * BetterDesk Console — Agent Generator routes
 *
 * Provides:
 *   - "Generator Agenta" admin panel (/generator) — branding editor + bundle list
 *   - Bundle management REST API (/api/generator/bundles/*)
 *   - Public download portal per bundle (/d/:bundleId) with platform cards
 *   - Legacy RustDesk TOML config generator (kept for backward compat,
 *     marked deprecated in code only — UI no longer exposes it)
 */

'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');
const keyService = require('../services/keyService');
const bundleService = require('../services/agentBundleService');
const buildWorker = require('../services/agentBuildWorker');
const db = require('../services/database');
const config = require('../config/config');
const brandingService = require('../services/brandingService');
const betterdeskApi = require('../services/betterdeskApi');
const conn = require('../services/agentBundleConnection');

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
    return {
        bundle_id:       row.bundle_id,
        name:            row.name,
        branding:        publicBrandingView(parseBranding(row.branding)),
        branding_hash:   row.branding_hash,
        revoked:         !!row.revoked,
        download_count:  Number(row.download_count || 0),
        created_at:      row.created_at,
        updated_at:      row.updated_at,
        download_url:    `/d/${row.bundle_id}`,
    };
}

function injectServerBranding(input) {
    // Legacy alias — use finalizeBundleBranding for new bundles.
    return finalizeBundleBrandingSync(input);
}

function finalizeBundleBrandingSync(input) {
    const branding = { ...(input || {}) };
    const host = branding.server_host || conn.defaultServerHost();
    const useHttps = branding.use_https ?? conn.defaultUseHttps();
    const urls = conn.buildServerUrls(host, useHttps);
    branding.server = {
        address: urls.address,
        api_url: urls.api_url,
        public_key: keyService.getPublicKey() || '',
        cdap_port: urls.cdap_port,
        cdap_url: urls.cdap_url,
    };
    branding.server_address = branding.server.address;
    branding.server_key = branding.server.public_key;
    branding.use_https = !!useHttps;
    return branding;
}

/**
 * Merge operator connection settings, inject server key, and optionally
 * mint a new enrollment token (baked into the support-agent binary).
 */
async function finalizeBundleBranding(input, bundleId, { regenerateToken = true, previous = null } = {}) {
    const branding = finalizeBundleBrandingSync(input);

    if (regenerateToken || !previous?.enrollment_token) {
        const tokenRes = await betterdeskApi.createDeviceToken({
            name: `bundle-${bundleId}`,
            max_uses: 0,
            note: `Support agent bundle ${bundleId}`,
        });
        if (!tokenRes.success || !tokenRes.data?.token) {
            throw new Error(tokenRes.error || 'enrollment_token_failed');
        }
        branding.enrollment_token = tokenRes.data.token;
    } else {
        branding.enrollment_token = previous.enrollment_token;
    }

    // Operator-editable fields kept for UI reload; not hashed separately from server URLs.
    branding.server_host = input.server_host || conn.defaultServerHost();
    branding.use_https = !!(input.use_https ?? conn.defaultUseHttps());
    branding.has_enrollment_token = true;

    return branding;
}

function maskEnrollmentToken(token) {
    if (!token || typeof token !== 'string') return '';
    if (token.length <= 8) return '********';
    return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function publicBrandingView(branding) {
    if (!branding || typeof branding !== 'object') return branding;
    const out = { ...branding };
    if (out.enrollment_token) {
        out.enrollment_token_masked = maskEnrollmentToken(out.enrollment_token);
        delete out.enrollment_token;
    }
    return out;
}

// =========================================================================
//  Generator page
// =========================================================================

router.get('/generator', requireAuth, requireAdmin, (req, res) => {
    res.render('generator', {
        title: req.t('nav.generator'),
        activePage: 'generator',
    });
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

router.get('/api/generator/defaults', requireAuth, requireAdmin, (req, res) => {
    res.json({
        success: true,
        data: {
            server_host: conn.defaultServerHost(),
            use_https: conn.defaultUseHttps(),
            api_port: conn.defaultApiPort(),
            public_key: keyService.getPublicKey() || '',
        },
    });
});

router.post('/api/generator/bundles', requireAuth, requireAdmin, async (req, res) => {
    try {
        const name = String(req.body.name || '').trim().slice(0, 100);
        if (!name) {
            return res.status(400).json({ success: false, error: req.t('generator.errors.name_required') });
        }
        const { valid, errors, normalized: base } = bundleService.validateBranding(req.body.branding || {});
        if (!valid) {
            return res.status(400).json({ success: false, error: req.t('generator.errors.validation_failed'), errors, details: errors });
        }
        const bundleId = bundleService.generateBundleId();
        let normalized;
        try {
            normalized = await finalizeBundleBranding(base, bundleId, { regenerateToken: true });
        } catch (tokErr) {
            console.error('[generator] token mint failed:', tokErr);
            return res.status(502).json({ success: false, error: req.t('generator.errors.token_failed') });
        }
        normalized.bundle_id = bundleId;
        normalized.product_name = normalized.company_name || 'BetterDesk Support';
        const brandingHash = bundleService.hashBranding(normalized);
        const created = await db.createAgentBundle({
            bundleId,
            name,
            branding: JSON.stringify(normalized),
            brandingHash,
            createdBy: req.session?.userId || null,
        });
        // Phase 2: queue installer builds for every supported platform.
        buildWorker.enqueueBuildsForHash(brandingHash).catch((e) => {
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
        const connChanged = conn.connectionFingerprint(existingBranding) !== conn.connectionFingerprint(base);
        let normalized;
        try {
            normalized = await finalizeBundleBranding(base, req.params.bundleId, {
                regenerateToken: connChanged,
                previous: existingBranding,
            });
        } catch (tokErr) {
            console.error('[generator] token mint failed:', tokErr);
            return res.status(502).json({ success: false, error: req.t('generator.errors.token_failed') });
        }
        normalized.bundle_id = req.params.bundleId;
        normalized.product_name = normalized.company_name || 'BetterDesk Support';
        const brandingHash = bundleService.hashBranding(normalized);
        const updated = await db.updateAgentBundle(req.params.bundleId, {
            name,
            branding: JSON.stringify(normalized),
            brandingHash,
        });
        // Phase 2: if branding hash changed, queue new builds; cached artifacts
        // for the previous hash remain reusable for prior portal links.
        if (existing.branding_hash !== brandingHash) {
            buildWorker.enqueueBuildsForHash(brandingHash).catch((e) => {
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
        const result = await buildWorker.rebuildBundleById(req.params.bundleId);
        if (!result.success) {
            return res.status(404).json({ success: false, error: req.t('errors.not_found') });
        }
        const builds = await db.listAgentBundleBuildsForHash(row.branding_hash);
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

/**
 * Live preview helper — validate + normalize a branding payload without
 * persisting it. Used by the editor to render the preview without writing
 * to the DB on every keystroke.
 */
router.post('/api/generator/preview', requireAuth, requireAdmin, (req, res) => {
    try {
        const rawBranding = finalizeBundleBrandingSync(req.body.branding || {});
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

/**
 * Public landing page for an issued bundle. No auth — the bundle ID itself
 * is the access token. Revoked or unknown bundles return 404 to avoid
 * leaking which IDs exist.
 */
router.get('/d/:bundleId', async (req, res) => {
    try {
        const row = await db.getAgentBundle(req.params.bundleId);
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
        // Global console branding provides portal-wide defaults (wallpaper,
        // attribution) shared by every bundle that does not override them.
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
            t: req.t.bind(req),
        });
    } catch (err) {
        console.error('[generator] portal error:', err);
        res.status(500).render('errors/500', { title: req.t('errors.server_error'), layout: false });
    }
});

/**
 * Public manifest endpoint — JSON shape the portal page polls to refresh
 * platform build status without a full reload.
 */
router.get('/api/d/:bundleId/manifest', async (req, res) => {
    try {
        const row = await db.getAgentBundle(req.params.bundleId);
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
            data: { bundle_id: row.bundle_id, name: row.name, platforms },
        });
    } catch (err) {
        console.error('[generator] manifest error:', err);
        res.status(500).json({ success: false });
    }
});

/**
 * Public download endpoint. Phase 1 returns 503 with `build_pending` until
 * the Phase 2 build pipeline is wired; the route exists so the portal can
 * link to it today and Phase 2 is a pure backend swap.
 */
router.get('/api/d/:bundleId/download/:platform/:arch/:format', async (req, res) => {
    try {
        const row = await db.getAgentBundle(req.params.bundleId);
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

router.get('/api/generator/config', requireAuth, (req, res) => {
    try {
        const publicKey = keyService.getPublicKey();
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

router.post('/api/generator/generate-config', requireAuth, (req, res) => {
    try {
        const { serverHost, serverPort, relayHost, relayPort, clientName } = req.body;
        if (!serverHost) {
            return res.status(400).json({ success: false, error: 'Server host is required' });
        }
        const publicKey = keyService.getPublicKey();
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
