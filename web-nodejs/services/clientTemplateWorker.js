/**
 * BetterDesk Support Generator — template worker
 *
 * Patches portable desktop templates from the Support Generator module with
 * a signed/plain custom.txt and packages artifacts under data/agent-builds/.
 * Replaces agentBuildWorker for product_type=betterdesk-support.
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const AdmZip = require('adm-zip');

const db = require('./database');
const bundleService = require('./agentBundleService');
const supportModule = require('./supportGeneratorModule');
const customTxt = require('./customTxtBuilder');
const keyService = require('./keyService');
const conn = require('./agentBundleConnection');
const config = require('../config/config');
const {
    PRODUCT_TYPES,
    normalizeProductType,
    isQueuedBuildStatus,
} = require('../lib/generatorBuildTypes');

const ARTIFACT_ROOT = process.env.AGENT_ARTIFACT_DIR
    || path.join(config.dataDir || '/opt/BetterDeskConsole/data', 'agent-builds');
const WORK_ROOT = path.join(
    config.dataDir || path.join(__dirname, '..', 'data'),
    'build-cache',
    'support-templates'
);
const POLL_INTERVAL_MS = parseInt(process.env.AGENT_BUILD_POLL_MS || '5000', 10);
const BUILD_COOLDOWN_MS = parseInt(process.env.AGENT_BUILD_COOLDOWN_MS || '1000', 10);
const IS_WINDOWS = process.platform === 'win32';

let _pollHandle = null;
let _running = false;
let _activeBuilds = 0;
let _lastBuildFinishedAt = 0;
let _startupReady = false;

function _isSupportProduct(row) {
    const pt = normalizeProductType(row?.product_type);
    return pt === PRODUCT_TYPES.BETTERDESK_SUPPORT;
}

function _parseBranding(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch (_) { return {}; }
}

function _filterPlatforms(only) {
    const all = bundleService.PLATFORMS || [];
    if (!Array.isArray(only) || only.length === 0) return all;
    const filtered = all.filter((p) => only.some((o) => (
        String(o.platform || o.os || '') === p.platform
        && String(o.arch || 'x64') === p.arch
        && String(o.format || 'portable') === p.format
    )));
    return filtered.length ? filtered : all;
}

async function enqueueBuildsForHash(brandingHash, { force = false, platforms: onlyPlatforms = null } = {}) {
    if (!brandingHash) throw new Error('brandingHash required');
    if (!supportModule.isReady()) {
        throw new Error('support_generator_module_not_ready');
    }
    const platforms = _filterPlatforms(onlyPlatforms);
    for (const p of platforms) {
        const existing = await db.getAgentBundleBuild({
            brandingHash, platform: p.platform, arch: p.arch, format: p.format,
        });
        if (!force && existing && (existing.status === 'ready' || existing.status === 'building')) {
            continue;
        }
        await db.upsertAgentBundleBuild({
            brandingHash,
            platform: p.platform,
            arch: p.arch,
            format: p.format,
            status: 'queued',
            artifactPath: existing?.artifact_path || null,
            artifactSize: existing?.artifact_size || 0,
            artifactSha256: existing?.artifact_sha256 || null,
            errorMessage: '',
        });
    }
}

async function rebuildBundleById(bundleId, { platforms: onlyPlatforms = null } = {}) {
    const row = await db.getAgentBundle(bundleId);
    if (!row) return { success: false, error: 'not_found' };
    if (!_isSupportProduct(row)) return { success: false, error: 'not_betterdesk_support' };
    if (!row.branding_hash) return { success: false, error: 'missing_hash' };
    const platforms = _filterPlatforms(onlyPlatforms);
    await enqueueBuildsForHash(row.branding_hash, { force: true, platforms });
    return { success: true, platforms: platforms.length, brandingHash: row.branding_hash };
}

async function requeuePlatformBuild(brandingHash, platform, arch, format) {
    if (!brandingHash || !platform || !arch || !format) {
        return { success: false, error: 'missing_args' };
    }
    const allowed = (bundleService.PLATFORMS || []).some(
        (p) => p.platform === platform && p.arch === arch && p.format === format
    );
    if (!allowed) return { success: false, error: 'unsupported_platform' };
    await db.upsertAgentBundleBuild({
        brandingHash,
        platform,
        arch,
        format,
        status: 'queued',
        artifactPath: null,
        artifactSize: 0,
        artifactSha256: null,
        errorMessage: '',
    });
    return { success: true, brandingHash };
}

function getBuildWorkerStatus() {
    const moduleStatus = (() => {
        try {
            return {
                ready: supportModule.isReady(),
                templatesPresent: supportModule.templatesExist(),
            };
        } catch (_) {
            return { ready: false, templatesPresent: false };
        }
    })();
    return {
        workerEnabled: process.env.AGENT_BUILD_WORKER !== 'off',
        kind: 'client-template',
        moduleReady: moduleStatus.ready,
        templatesPresent: moduleStatus.templatesPresent,
        templatesDir: supportModule.templatesDir(),
        artifactRoot: ARTIFACT_ROOT,
        platforms: (bundleService.PLATFORMS || []).map((p) => ({
            platform: p.platform,
            arch: p.arch,
            format: p.format,
            label: p.label,
        })),
        activeBuilds: _activeBuilds,
        startupReady: _startupReady,
    };
}

async function getReadyArtifact({ brandingHash, platform, arch, format }) {
    const row = await db.getAgentBundleBuild({ brandingHash, platform, arch, format });
    if (!row || row.status !== 'ready' || !row.artifact_path) return null;
    try {
        await fsp.access(row.artifact_path, fs.constants.R_OK);
    } catch {
        return null;
    }
    return row;
}

function startWorker() {
    if (_pollHandle) return;
    console.log(`[clientTemplateWorker] templates=${supportModule.templatesDir()}`);
    _startupReady = true;
    _pollHandle = setInterval(() => {
        _tick().catch((e) => console.error('[clientTemplateWorker] tick error:', e.message));
    }, POLL_INTERVAL_MS);
    _tick().catch(() => {});
    console.log(`[clientTemplateWorker] started (poll ${POLL_INTERVAL_MS}ms)`);
}

function stopWorker() {
    if (_pollHandle) {
        clearInterval(_pollHandle);
        _pollHandle = null;
    }
    _startupReady = false;
}

async function _tick() {
    if (!_startupReady) return;
    if (_running || _activeBuilds > 0) return;
    if (BUILD_COOLDOWN_MS > 0 && Date.now() - _lastBuildFinishedAt < BUILD_COOLDOWN_MS) return;

    _running = true;
    try {
        const claimed = await _claimNextBuild();
        if (!claimed) return;
        _activeBuilds++;
        try {
            await _runOne(claimed);
        } catch (e) {
            console.error('[clientTemplateWorker] build crashed:', e);
        } finally {
            _activeBuilds--;
            _lastBuildFinishedAt = Date.now();
        }
    } finally {
        _running = false;
    }
}

async function _findBundleForHash(brandingHash) {
    const bundles = await db.listAgentBundles({ includeRevoked: true });
    return (bundles || []).find((b) => b.branding_hash === brandingHash) || null;
}

async function _listPendingBuilds(limit = 50) {
    const bundles = await db.listAgentBundles();
    const out = [];
    for (const b of bundles || []) {
        if (b.revoked || !_isSupportProduct(b)) continue;
        const builds = await db.listAgentBundleBuildsForHash(b.branding_hash);
        for (const row of builds || []) {
            if (isQueuedBuildStatus(row.status)) out.push(row);
            if (out.length >= limit) return out;
        }
    }
    return out;
}

async function _claimNextBuild() {
    if (!supportModule.isReady()) return null;
    const candidates = await _listPendingBuilds(50);
    candidates.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    for (const row of candidates) {
        const bundleRow = await _findBundleForHash(row.branding_hash);
        if (!bundleRow || !_isSupportProduct(bundleRow)) continue;
        if (!supportModule.resolveTemplateDir(row.platform, row.arch)) {
            await db.upsertAgentBundleBuild({
                brandingHash: row.branding_hash,
                platform: row.platform,
                arch: row.arch,
                format: row.format,
                status: 'failed',
                artifactPath: null,
                artifactSize: 0,
                artifactSha256: null,
                errorMessage: `template_missing:${row.platform}/${row.arch}`,
            });
            continue;
        }
        await db.upsertAgentBundleBuild({
            brandingHash: row.branding_hash,
            platform: row.platform,
            arch: row.arch,
            format: row.format,
            status: 'building',
            artifactPath: row.artifact_path || null,
            artifactSize: row.artifact_size || 0,
            artifactSha256: row.artifact_sha256 || null,
            errorMessage: '',
        });
        return { ...row, _bundle: bundleRow };
    }
    return null;
}

function _buildApiServer(branding) {
    if (branding.api_server) return String(branding.api_server).trim();
    const host = branding.server_host || conn.defaultServerHost();
    const useHttps = branding.use_https ?? true;
    const port = String(branding.api_port || conn.defaultApiPort());
    const scheme = useHttps ? 'https' : 'http';
    const omit = (scheme === 'https' && port === '443') || (scheme === 'http' && port === '80');
    return omit ? `${scheme}://${host}` : `${scheme}://${host}:${port}`;
}

async function _buildCustomTxtContent(branding) {
    const host = branding.server_host || conn.defaultServerHost();
    const key = branding.public_key
        || branding.server_key
        || branding.server?.public_key
        || (await keyService.resolvePublicKey())
        || '';
    const built = customTxt.buildAndSignSupportCustomTxt({
        appName: branding.app_name || branding.company_name || branding.product_name || 'BetterDesk Support Agent',
        host,
        relay: branding.relay_host || branding.relay_server || host,
        api: _buildApiServer(branding),
        key,
        disableSettings: branding.disable_settings !== false,
    }, supportModule.getSigningSeedBase64());
    return built;
}

async function _copyDir(src, dest) {
    await fsp.cp(src, dest, { recursive: true });
}

function _findCustomTxtTarget(stageDir, platform) {
    if (String(platform).toLowerCase() === 'macos') {
        const marker = _findFile(stageDir, '.custom-txt-here');
        if (marker) return path.dirname(marker);
        const app = _findDirEnding(stageDir, '.app');
        if (app) {
            const macos = path.join(app, 'Contents', 'MacOS');
            if (fs.existsSync(macos)) return macos;
        }
        const contentsMac = _findDirNamed(stageDir, 'MacOS');
        if (contentsMac) return contentsMac;
    }
    const marker = path.join(stageDir, '.custom-txt-here');
    if (fs.existsSync(marker)) return stageDir;
    return stageDir;
}

function _findFile(root, name) {
    const stack = [root];
    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) stack.push(full);
            else if (e.name === name) return full;
        }
    }
    return null;
}

function _findDirEnding(root, suffix) {
    const stack = [root];
    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            const full = path.join(dir, e.name);
            if (e.name.endsWith(suffix)) return full;
            stack.push(full);
        }
    }
    return null;
}

function _findDirNamed(root, name) {
    const stack = [root];
    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            const full = path.join(dir, e.name);
            if (e.name === name) return full;
            stack.push(full);
        }
    }
    return null;
}

function _runTar(args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn('tar', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`tar failed (${code}): ${stderr.trim() || 'unknown'}`));
        });
    });
}

async function _packArtifact(stageDir, outPath, platform) {
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    if (fs.existsSync(outPath)) await fsp.unlink(outPath);

    if (String(platform).toLowerCase() === 'windows' || outPath.endsWith('.zip')) {
        const zip = new AdmZip();
        zip.addLocalFolder(stageDir, path.basename(stageDir));
        zip.writeZip(outPath);
        return;
    }

    // tar.gz — archive the stage directory contents under a single top-level folder
    const parent = path.dirname(stageDir);
    const base = path.basename(stageDir);
    await _runTar(['-czf', outPath, base], parent);
}

function _sha256OfFile(filePath) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const s = fs.createReadStream(filePath);
        s.on('error', reject);
        s.on('data', (d) => h.update(d));
        s.on('end', () => resolve(h.digest('hex')));
    });
}

async function _runOne(buildRow) {
    const key = `${buildRow.platform}/${buildRow.arch}/${buildRow.format}`;
    const startTs = Date.now();
    console.log(`[clientTemplateWorker] build start hash=${String(buildRow.branding_hash).slice(0, 12)} ${key}`);

    const workDir = path.join(WORK_ROOT, `${buildRow.branding_hash.slice(0, 16)}_${buildRow.platform}_${buildRow.arch}`);
    try {
        await fsp.rm(workDir, { recursive: true, force: true });
        await fsp.mkdir(workDir, { recursive: true });
        await fsp.mkdir(ARTIFACT_ROOT, { recursive: true });

        const templateDir = supportModule.resolveTemplateDir(buildRow.platform, buildRow.arch);
        if (!templateDir) throw new Error(`template_missing:${key}`);

        const stageDir = path.join(workDir, `betterdesk-support-${buildRow.platform}-${buildRow.arch}`);
        await _copyDir(templateDir, stageDir);

        const branding = _parseBranding(buildRow._bundle?.branding);
        const { content, signed } = await _buildCustomTxtContent(branding);
        const injectDir = _findCustomTxtTarget(stageDir, buildRow.platform);
        await fsp.mkdir(injectDir, { recursive: true });
        await fsp.writeFile(path.join(injectDir, 'custom.txt'), content, 'utf8');

        // Drop helper markers from shipped artifacts
        try { await fsp.unlink(path.join(stageDir, '.custom-txt-here')); } catch (_) { /* ok */ }
        const nestedMarker = _findFile(stageDir, '.custom-txt-here');
        if (nestedMarker) {
            try { await fsp.unlink(nestedMarker); } catch (_) { /* ok */ }
        }

        const ext = buildRow.platform === 'windows' ? 'zip' : 'tar.gz';
        const artifactName = `betterdesk-support-${buildRow.branding_hash.slice(0, 12)}-${buildRow.platform}-${buildRow.arch}.${ext}`;
        const artifactPath = path.join(ARTIFACT_ROOT, artifactName);
        await _packArtifact(stageDir, artifactPath, buildRow.platform);

        const stat = await fsp.stat(artifactPath);
        const sha = await _sha256OfFile(artifactPath);
        await db.upsertAgentBundleBuild({
            brandingHash: buildRow.branding_hash,
            platform: buildRow.platform,
            arch: buildRow.arch,
            format: buildRow.format,
            status: 'ready',
            artifactPath,
            artifactSize: stat.size,
            artifactSha256: sha,
            errorMessage: '',
        });
        console.log(
            `[clientTemplateWorker] build ready ${key} signed=${signed}`
            + ` (${(stat.size / 1024 / 1024).toFixed(2)} MB, ${((Date.now() - startTs) / 1000).toFixed(1)}s)`
        );
    } catch (err) {
        const msg = err.message || String(err);
        console.error(`[clientTemplateWorker] build FAILED ${key}: ${msg}`);
        await db.upsertAgentBundleBuild({
            brandingHash: buildRow.branding_hash,
            platform: buildRow.platform,
            arch: buildRow.arch,
            format: buildRow.format,
            status: 'failed',
            artifactPath: null,
            artifactSize: 0,
            artifactSha256: null,
            errorMessage: msg.slice(0, 2000),
        });
    } finally {
        try { await fsp.rm(workDir, { recursive: true, force: true }); } catch (_) { /* ok */ }
    }
}

module.exports = {
    enqueueBuildsForHash,
    rebuildBundleById,
    requeuePlatformBuild,
    startWorker,
    stopWorker,
    getBuildWorkerStatus,
    getReadyArtifact,
    _internals: {
        isSupportProduct: _isSupportProduct,
        buildCustomTxtContent: _buildCustomTxtContent,
        findCustomTxtTarget: _findCustomTxtTarget,
        filterPlatforms: _filterPlatforms,
        ARTIFACT_ROOT,
        WORK_ROOT,
        IS_WINDOWS,
    },
};
