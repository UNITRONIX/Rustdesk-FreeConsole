/**
 * BetterDesk Console — Agent Build Worker (Go support-agent)
 *
 * Compiles branded betterdesk-support-agent binaries per bundle.
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const db = require('./database');
const bundleService = require('./agentBundleService');
const config = require('../config/config');

try {
    const envFile = process.env.BETTERDESK_BUILD_ENV_FILE || '/etc/betterdesk/build.env';
    if (fs.existsSync(envFile)) {
        const txt = fs.readFileSync(envFile, 'utf8');
        for (const line of txt.split(/\r?\n/)) {
            const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
            if (!m) continue;
            const [, key, val] = m;
            if (process.env[key] === undefined) process.env[key] = val;
        }
    }
} catch (e) {
    console.warn('[agentBuildWorker] could not load build env file:', e.message);
}

const BUILD_USER       = process.env.BUILD_USER || 'unitronix';
const BUILD_CACHE_DIR  = process.env.BUILD_CACHE_DIR
    || path.join(config.dataDir || '/opt/BetterDeskConsole/data', 'build-cache');
const WORK_ROOT        = path.join(BUILD_CACHE_DIR, 'work');
const ARTIFACT_ROOT    = process.env.AGENT_ARTIFACT_DIR
    || path.join(config.dataDir || '/opt/BetterDeskConsole/data', 'agent-builds');
const POLL_INTERVAL_MS = parseInt(process.env.AGENT_BUILD_POLL_MS || '5000', 10);
const WORKER_CONCURRENCY = parseInt(process.env.AGENT_BUILD_CONCURRENCY || '1', 10);
const BUILD_TIMEOUT_MS = parseInt(process.env.AGENT_BUILD_TIMEOUT_MS || (30 * 60 * 1000), 10);
const IS_WINDOWS = process.platform === 'win32';
const VENDORED_GO_BIN = path.join(
    config.dataDir || path.join(__dirname, '..', 'data'),
    'go-toolchain', 'go', 'bin', IS_WINDOWS ? 'go.exe' : 'go'
);

function _resolveBin(candidates) {
    for (const c of candidates) { if (fs.existsSync(c)) return c; }
    return candidates[0];
}

function _goBinaryHealthy(goBin) {
    if (!goBin || !fs.existsSync(goBin)) return false;
    try {
        const { goStdlibHealthy } = require('./updateService');
        return goStdlibHealthy(goBin);
    } catch {
        return false;
    }
}

/** Prefer a working Go toolchain (vendored console install beats broken /usr/local/go). */
function _resolveGoBin() {
    const fromEnv = process.env.GO_BIN;
    const candidates = [
        ...(fromEnv && _goBinaryHealthy(fromEnv) ? [fromEnv] : []),
        VENDORED_GO_BIN,
        '/usr/local/go/bin/go',
        '/usr/bin/go',
    ];
    for (const c of candidates) {
        if (_goBinaryHealthy(c)) return c;
    }
    return null;
}

let _activeGoBin = _resolveGoBin();

function getGoBin() {
    if (_activeGoBin && _goBinaryHealthy(_activeGoBin)) return _activeGoBin;
    _activeGoBin = _resolveGoBin();
    return _activeGoBin;
}

let _ensureGoPromise = null;

async function _ensureGoToolchain() {
    if (_goBinaryHealthy(getGoBin())) return getGoBin();
    if (!_ensureGoPromise) {
        _ensureGoPromise = (async () => {
            const updateService = require('./updateService');
            const result = await updateService.installGoToolchain(null, { maxVersion: '1.25.99' });
            if (result.success && result.binPath && _goBinaryHealthy(result.binPath)) {
                _activeGoBin = result.binPath;
                process.env.GO_BIN = result.binPath;
                console.log(`[agentBuildWorker] Go toolchain ready: ${result.version || result.binPath}`);
                return _activeGoBin;
            }
            throw new Error(result.error || 'Go toolchain install failed');
        })().finally(() => {
            _ensureGoPromise = null;
        });
    }
    return _ensureGoPromise;
}

const BASE_BUILD_ENV = {
    HOME: `/home/${BUILD_USER}`,
    CGO_ENABLED: '1',
    GOPATH: process.env.GOPATH || `/home/${BUILD_USER}/go`,
};

function _buildEnv(extra = {}) {
    const goBin = getGoBin();
    if (!goBin) {
        throw new Error('Go toolchain not available');
    }
    const goDir = path.dirname(goBin);
    const goroot = path.dirname(goDir);
    return {
        ...BASE_BUILD_ENV,
        ...extra,
        GO_BIN: goBin,
        GOROOT: goroot,
        PATH: `${goDir}:/usr/bin:/bin:${process.env.PATH || ''}`,
    };
}

function _resolveSourceRoot() {
    if (process.env.AGENT_SOURCE_DIR) return process.env.AGENT_SOURCE_DIR;
    const candidates = [
        '/opt/BetterDeskConsole/agent-source/betterdesk-support-agent',
        path.resolve(__dirname, '..', '..', 'betterdesk-support-agent'),
        path.resolve(process.cwd(), 'betterdesk-support-agent'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(path.join(c, 'build.sh'))) return c;
    }
    return candidates[0];
}

function _resolveAgentLibRoot() {
    const candidates = [
        path.join(path.dirname(SOURCE_ROOT), 'betterdesk-agent'),
        path.resolve(__dirname, '..', '..', 'betterdesk-agent'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(path.join(c, 'go.mod'))) return c;
    }
    return candidates[1];
}

const SOURCE_ROOT = _resolveSourceRoot();
const AGENT_LIB_ROOT = _resolveAgentLibRoot();

const BUILD_PROFILES = {
    'windows/x64/portable':  { os: 'windows', ext: '.zip',  pack: 'zip-portable' },
    'windows/x64/installed': { os: 'windows', ext: '.exe',  pack: 'raw' },
    'linux/x64/portable':    { os: 'linux',   ext: '.tar.gz',   pack: 'tar-portable' },
    'linux/x64/appimage':    { os: 'linux',   ext: '.AppImage', pack: 'appimage' },
    'linux/x64/installed':   { os: 'linux',   ext: '.deb',      pack: 'deb' },
    'linux/x64/rpm':         { os: 'linux',   ext: '.rpm',  pack: 'rpm' },
};

let _running = false;
let _activeBuilds = 0;
let _pollHandle = null;

const REBUILD_FLAG_FILE = path.join(config.dataDir || path.join(__dirname, '..', 'data'), '.agent_rebuild_pending');
const AGENT_SOURCE_STAMP_FILE = path.join(config.dataDir || path.join(__dirname, '..', 'data'), '.agent_source_sha');
const AGENT_SOURCE_PREFIXES = ['betterdesk-support-agent/', 'betterdesk-agent/'];

function _agentSourceDirs() {
    const supportAgent = SOURCE_ROOT;
    const base = path.dirname(supportAgent);
    return {
        base,
        supportAgent,
        agentLib: path.join(base, 'betterdesk-agent'),
    };
}

async function enqueueBuildsForHash(brandingHash, { force = false } = {}) {
    if (!brandingHash) throw new Error('brandingHash required');
    const platforms = bundleService.PLATFORMS || [];
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
            status: 'pending',
            artifactPath: existing?.artifact_path || null,
            artifactSize: existing?.artifact_size || 0,
            artifactSha256: existing?.artifact_sha256 || null,
            errorMessage: '',
        });
    }
}

/** Queue rebuilds for every non-revoked generator bundle (e.g. after agent source update). */
async function requeueAllBundleBuilds() {
    const bundles = await db.listAgentBundles({ includeRevoked: false });
    const hashes = [...new Set(
        bundles.filter(b => !b.revoked).map(b => b.branding_hash).filter(Boolean)
    )];
    for (const hash of hashes) {
        await enqueueBuildsForHash(hash, { force: true });
    }
    return { bundles: hashes.length };
}

/** Force-requeue every platform build for one generator bundle. */
async function rebuildBundleById(bundleId) {
    const row = await db.getAgentBundle(bundleId);
    if (!row) return { success: false, error: 'not_found' };
    if (!row.branding_hash) return { success: false, error: 'missing_hash' };
    await enqueueBuildsForHash(row.branding_hash, { force: true });
    const platforms = (bundleService.PLATFORMS || []).length;
    return { success: true, platforms, brandingHash: row.branding_hash };
}

/** Re-queue builds that failed only because the host Go install was broken. */
async function requeueFailedToolchainBuilds() {
    if (!_goBinaryHealthy(getGoBin())) return { requeued: 0 };

    const bundles = await db.listAgentBundles({ includeRevoked: false });
    let requeued = 0;
    for (const b of bundles) {
        if (b.revoked) continue;
        const builds = await db.listAgentBundleBuildsForHash(b.branding_hash);
        for (const row of builds) {
            const err = String(row.error_message || '');
            if (row.status !== 'failed') continue;
            if (!/not in std|Go toolchain|stdlib verification/i.test(err)) continue;
            await db.upsertAgentBundleBuild({
                brandingHash: row.branding_hash,
                platform: row.platform,
                arch: row.arch,
                format: row.format,
                status: 'pending',
                artifactPath: row.artifact_path || null,
                artifactSize: row.artifact_size || 0,
                artifactSha256: row.artifact_sha256 || null,
                errorMessage: '',
            });
            requeued++;
        }
    }
    if (requeued > 0) {
        console.log(`[agentBuildWorker] requeued ${requeued} failed build(s) after Go toolchain recovery`);
    }
    return { requeued };
}

function markRebuildPending(reason = 'update') {
    fs.mkdirSync(path.dirname(REBUILD_FLAG_FILE), { recursive: true });
    fs.writeFileSync(REBUILD_FLAG_FILE, JSON.stringify({
        reason,
        at: new Date().toISOString(),
    }));
}

/** On console startup, rebuild generator clients when an update left a pending flag. */
async function processPendingRebuildOnStartup() {
    if (!fs.existsSync(REBUILD_FLAG_FILE)) return null;
    let meta = {};
    try {
        meta = JSON.parse(fs.readFileSync(REBUILD_FLAG_FILE, 'utf8'));
    } catch (_) { /* use defaults */ }
    try {
        fs.unlinkSync(REBUILD_FLAG_FILE);
    } catch (_) { /* ok */ }

    const result = await requeueAllBundleBuilds();
    console.log(
        `[agentBuildWorker] auto-rebuild queued for ${result.bundles} bundle(s)`
        + (meta.reason ? ` (reason: ${meta.reason})` : '')
    );
    return { ...result, reason: meta.reason || 'pending' };
}

/**
 * Stage support-agent / betterdesk-agent files downloaded during an in-app update
 * into the build worker source tree (agent-source/).
 */
async function stageSourcesFromGitHub({ remoteSHA, files, download }) {
    if (!files?.length || typeof download !== 'function') {
        return { staged: 0 };
    }
    const owner = process.env.UPDATE_GITHUB_OWNER || 'UNITRONIX';
    const repo = process.env.UPDATE_GITHUB_REPO || 'BetterDesk';
    let staged = 0;
    for (const file of files) {
        if (file.status === 'removed') continue;
        if (await _writeAgentSourceFile(owner, repo, remoteSHA, file.path, download)) {
            staged++;
        }
    }
    return { staged };
}

/**
 * Download the full support-agent + betterdesk-agent trees at remoteSHA.
 * Used after updates so agent-source/ stays consistent even when an individual
 * commit diff only touches the build worker or generator routes.
 */
async function syncFullAgentSourceFromGitHub({ remoteSHA, download, listPaths }) {
    if (typeof download !== 'function' || typeof listPaths !== 'function') {
        throw new Error('download and listPaths are required');
    }
    const owner = process.env.UPDATE_GITHUB_OWNER || 'UNITRONIX';
    const repo = process.env.UPDATE_GITHUB_REPO || 'BetterDesk';
    const allPaths = await listPaths(remoteSHA);
    const agentPaths = allPaths.filter((fp) =>
        AGENT_SOURCE_PREFIXES.some((pref) => fp.startsWith(pref))
    );

    let staged = 0;
    for (const fp of agentPaths) {
        if (await _writeAgentSourceFile(owner, repo, remoteSHA, fp, download)) {
            staged++;
        }
    }

    if (remoteSHA) {
        fs.mkdirSync(path.dirname(AGENT_SOURCE_STAMP_FILE), { recursive: true });
        fs.writeFileSync(AGENT_SOURCE_STAMP_FILE, String(remoteSHA).trim());
    }
    return { staged, paths: agentPaths.length };
}

async function _writeAgentSourceFile(owner, repo, remoteSHA, fp, download) {
    let destRoot;
    let rel;
    if (fp.startsWith('betterdesk-support-agent/')) {
        destRoot = _agentSourceDirs().supportAgent;
        rel = fp.slice('betterdesk-support-agent/'.length);
    } else if (fp.startsWith('betterdesk-agent/')) {
        destRoot = _agentSourceDirs().agentLib;
        rel = fp.slice('betterdesk-agent/'.length);
    } else {
        return false;
    }
    if (!rel) return false;

    const dest = path.join(destRoot, rel);
    const content = await download(owner, repo, remoteSHA, fp);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, content);
    if (!IS_WINDOWS && (rel.endsWith('.sh') || rel === 'build.sh')) {
        try { await fsp.chmod(dest, 0o755); } catch (_) { /* ok */ }
    }
    return true;
}

/**
 * If agent-source was never stamped or is missing expected files while bundles
 * exist, sync from the deployed commit SHA and queue rebuilds.
 */
async function reconcileAgentSourceDrift() {
    if (fs.existsSync(REBUILD_FLAG_FILE)) return null;

    const bundles = await db.listAgentBundles({ includeRevoked: false });
    const active = bundles.filter((b) => !b.revoked);
    if (active.length === 0) return null;

    const supportRoot = _agentSourceDirs().supportAgent;
    const missingCore = !fs.existsSync(path.join(supportRoot, 'build.sh'))
        || !fs.existsSync(path.join(supportRoot, 'urls.go'));
    const stampedSha = fs.existsSync(AGENT_SOURCE_STAMP_FILE)
        ? fs.readFileSync(AGENT_SOURCE_STAMP_FILE, 'utf8').trim()
        : '';

    if (!missingCore && stampedSha) return null;

    const shaFile = path.join(config.dataDir || path.join(__dirname, '..', 'data'), '.update_sha');
    const deployedSha = fs.existsSync(shaFile)
        ? fs.readFileSync(shaFile, 'utf8').trim()
        : '';

    if (deployedSha) {
        try {
            const updateService = require('./updateService');
            const synced = await updateService.syncAgentSourceAtSha(deployedSha);
            console.log(
                `[agentBuildWorker] agent-source repaired from ${deployedSha.slice(0, 7)}`
                + ` (${synced.staged}/${synced.paths} files)`
            );
        } catch (err) {
            console.warn(`[agentBuildWorker] agent-source repair sync failed: ${err.message}`);
        }
    }

    markRebuildPending('agent-source drift');
    return processPendingRebuildOnStartup();
}

function startWorker() {
    if (_pollHandle) return;
    console.log(`[agentBuildWorker] Go support-agent source=${SOURCE_ROOT} go=${getGoBin()}`);
    _ensureDirs().catch((e) => console.error('[agentBuildWorker] dir init failed:', e));
    _pollHandle = setInterval(() => {
        _tick().catch((e) => console.error('[agentBuildWorker] tick error:', e.message));
    }, POLL_INTERVAL_MS);
    processPendingRebuildOnStartup().catch((e) => {
        console.error('[agentBuildWorker] pending rebuild failed:', e.message);
    });
    reconcileAgentSourceDrift().catch((e) => {
        console.warn('[agentBuildWorker] agent-source drift check skipped:', e.message);
    });
    (async () => {
        try {
            await _ensureGoToolchain();
            await requeueFailedToolchainBuilds();
        } catch (e) {
            console.warn('[agentBuildWorker] Go toolchain preflight:', e.message);
        }
    })();
    console.log(`[agentBuildWorker] started (poll ${POLL_INTERVAL_MS}ms)`);
}

function stopWorker() {
    if (_pollHandle) { clearInterval(_pollHandle); _pollHandle = null; }
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

async function _ensureDirs() {
    await fsp.mkdir(WORK_ROOT, { recursive: true });
    await fsp.mkdir(ARTIFACT_ROOT, { recursive: true });
}

async function _tick() {
    if (_running) return;
    if (_activeBuilds >= WORKER_CONCURRENCY) return;
    _running = true;
    try {
        const claimed = await _claimNextBuild();
        if (!claimed) return;
        _activeBuilds++;
        _runOne(claimed)
            .catch((e) => console.error('[agentBuildWorker] build crashed:', e))
            .finally(() => { _activeBuilds--; });
    } finally {
        _running = false;
    }
}

async function _claimNextBuild() {
    const candidates = await _listPendingBuilds(10);
    for (const row of candidates) {
        const profile = BUILD_PROFILES[`${row.platform}/${row.arch}/${row.format}`];
        if (!profile) continue;
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
        return row;
    }
    return null;
}

async function _listPendingBuilds(limit) {
    const bundles = await db.listAgentBundles();
    const out = [];
    for (const b of bundles) {
        if (b.revoked) continue;
        const builds = await db.listAgentBundleBuildsForHash(b.branding_hash);
        for (const r of builds) {
            if (r.status === 'pending') out.push(r);
            if (out.length >= limit) break;
        }
        if (out.length >= limit) break;
    }
    out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return out.slice(0, limit);
}

async function _runOne(buildRow) {
    const key = `${buildRow.platform}/${buildRow.arch}/${buildRow.format}`;
    const profile = BUILD_PROFILES[key];
    const startTs = Date.now();
    console.log(`[agentBuildWorker] build start hash=${buildRow.branding_hash.slice(0, 12)} ${key}`);

    try {
        const bundleRow = await _findBundleForHash(buildRow.branding_hash);
        if (!bundleRow) throw new Error(`no bundle with hash ${buildRow.branding_hash}`);

        const branding = JSON.parse(bundleRow.branding || '{}');
        const workDir = path.join(WORK_ROOT, buildRow.branding_hash, key.replace(/\//g, '_'));
        const brandingFile = path.join(workDir, 'resources', 'branding.json');
        const binaryName = profile.os === 'windows' ? 'betterdesk-support.exe' : 'betterdesk-support';
        const binaryPath = path.join(workDir, 'dist', binaryName);

        await _materialiseWorkspace(workDir, branding);
        await _ensureGoToolchain();
        await _runGoBuild(workDir, brandingFile, binaryPath, profile.os);

        const packed = await _packArtifact(workDir, binaryPath, profile, buildRow.branding_hash.slice(0, 8), branding);
        const finalDir = path.join(ARTIFACT_ROOT, buildRow.branding_hash);
        await fsp.mkdir(finalDir, { recursive: true });
        const dest = path.join(finalDir, `${buildRow.platform}-${buildRow.arch}-${buildRow.format}${profile.ext}`);
        await fsp.copyFile(packed, dest);

        const stat = await fsp.stat(dest);
        const sha = await _sha256OfFile(dest);

        await db.upsertAgentBundleBuild({
            brandingHash: buildRow.branding_hash,
            platform: buildRow.platform,
            arch: buildRow.arch,
            format: buildRow.format,
            status: 'ready',
            artifactPath: dest,
            artifactSize: stat.size,
            artifactSha256: sha,
            errorMessage: '',
        });
        console.log(`[agentBuildWorker] build ready ${key} (${(stat.size / 1024 / 1024).toFixed(2)} MB, ${((Date.now() - startTs) / 1000).toFixed(1)}s)`);
    } catch (err) {
        const msg = (err && err.message) ? err.message.slice(0, 800) : String(err).slice(0, 800);
        console.error(`[agentBuildWorker] build FAILED ${key}: ${msg}`);
        await db.upsertAgentBundleBuild({
            brandingHash: buildRow.branding_hash,
            platform: buildRow.platform,
            arch: buildRow.arch,
            format: buildRow.format,
            status: 'failed',
            artifactPath: null,
            artifactSize: 0,
            artifactSha256: null,
            errorMessage: msg,
        }).catch(() => {});
    }
}

async function _findBundleForHash(hash) {
    const all = await db.listAgentBundles();
    return all.find(b => b.branding_hash === hash) || null;
}

async function _materialiseWorkspace(workDir, branding) {
    if (fs.existsSync(workDir)) {
        await fsp.rm(workDir, { recursive: true, force: true });
    }
    await fsp.mkdir(workDir, { recursive: true });
    await _copyDir(SOURCE_ROOT, workDir);
    // go.mod replace => ../betterdesk-agent — refresh sibling lib each build
    // (legacy Tauri sidecar caches may leave binaries without go.mod here).
    const agentLibDest = path.join(workDir, '..', 'betterdesk-agent');
    if (fs.existsSync(agentLibDest)) {
        await fsp.rm(agentLibDest, { recursive: true, force: true });
    }
    await fsp.mkdir(path.dirname(agentLibDest), { recursive: true });
    await _copyDir(AGENT_LIB_ROOT, agentLibDest);
    await fsp.mkdir(path.join(workDir, 'resources'), { recursive: true });
    await fsp.writeFile(
        path.join(workDir, 'resources', 'branding.json'),
        JSON.stringify(branding, null, 2),
        'utf8'
    );
}

async function _copyDir(src, dst) {
    const SKIP = new Set(['node_modules', 'target', 'dist', '.git', 'data']);
    const entries = await fsp.readdir(src, { withFileTypes: true });
    await fsp.mkdir(dst, { recursive: true });
    for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        if (entry.isDirectory()) {
            await _copyDir(s, d);
        } else {
            await fsp.copyFile(s, d);
        }
    }
}

async function _runGoBuild(workDir, brandingPath, outputPath, targetOS) {
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    const buildScript = path.join(workDir, 'build.sh');
    await _runProcess('/bin/bash', [
        buildScript,
        '-b', brandingPath,
        '-o', outputPath,
        '-p', targetOS,
    ], { cwd: workDir });
    await fsp.access(outputPath, fs.constants.R_OK);
}

async function _packArtifact(workDir, binaryPath, profile, label, branding = {}) {
    const packDir = path.join(workDir, 'pack');
    await fsp.mkdir(packDir, { recursive: true });
    const baseName = path.basename(binaryPath);

    switch (profile.pack) {
        case 'raw': {
            const out = path.join(packDir, baseName);
            await fsp.copyFile(binaryPath, out);
            return out;
        }
        case 'zip-portable': {
            const stage = path.join(packDir, 'stage');
            await fsp.mkdir(stage, { recursive: true });
            await fsp.copyFile(binaryPath, path.join(stage, baseName));
            await fsp.writeFile(path.join(stage, 'portable'), '', 'utf8');
            await fsp.writeFile(path.join(stage, 'README.txt'),
                'BetterDesk Support Agent (portable)\r\n\r\n' +
                'Uruchom.bat (or double-click the .exe) starts the agent in the background.\r\n' +
                'No OpenGL is required on Windows.\r\n\r\n' +
                'Optional GUI (needs OpenGL/WGL): betterdesk-support.exe -gui\r\n' +
                'Supervised access prompts need -gui; unattended mode works headless.\r\n',
                'utf8');
            await fsp.writeFile(path.join(stage, 'Uruchom.bat'),
                '@echo off\r\nstart "" "%~dp0betterdesk-support.exe"\r\n',
                'utf8');
            await fsp.writeFile(path.join(stage, 'Uruchom-z-oknem.bat'),
                '@echo off\r\nstart "" "%~dp0betterdesk-support.exe" -gui\r\n',
                'utf8');
            const zipPath = path.join(packDir, `betterdesk-support-${label}-portable.zip`);
            await _runProcess('zip', ['-j', zipPath,
                path.join(stage, baseName),
                path.join(stage, 'portable'),
                path.join(stage, 'README.txt'),
                path.join(stage, 'Uruchom.bat'),
                path.join(stage, 'Uruchom-z-oknem.bat'),
            ], { cwd: packDir });
            return zipPath;
        }
        case 'tar-portable': {
            const stage = path.join(packDir, 'stage');
            await fsp.mkdir(stage, { recursive: true });
            await fsp.copyFile(binaryPath, path.join(stage, baseName));
            await fsp.chmod(path.join(stage, baseName), 0o755);
            await fsp.writeFile(path.join(stage, 'portable'), '', 'utf8');
            const tarPath = path.join(packDir, `betterdesk-support-${label}-portable.tar.gz`);
            await _runProcess('tar', ['-czf', tarPath, '-C', stage, baseName, 'portable'], { cwd: packDir });
            return tarPath;
        }
        case 'deb': {
            const pkgRoot = path.join(packDir, 'pkg');
            const binDest = path.join(pkgRoot, 'usr', 'local', 'bin', 'betterdesk-support');
            await fsp.mkdir(path.dirname(binDest), { recursive: true });
            await fsp.copyFile(binaryPath, binDest);
            await fsp.chmod(binDest, 0o755);
            const postinst = `#!/bin/sh\n/usr/local/bin/betterdesk-support -install || true\n`;
            const debianDir = path.join(pkgRoot, 'DEBIAN');
            await fsp.mkdir(debianDir, { recursive: true });
            await fsp.writeFile(path.join(debianDir, 'postinst'), postinst, { mode: 0o755 });
            await fsp.writeFile(path.join(debianDir, 'control'),
                `Package: betterdesk-support\nVersion: 1.0.0\nArchitecture: amd64\nMaintainer: BetterDesk\nDescription: BetterDesk Support Agent\n`,
                'utf8');
            const debPath = path.join(packDir, `betterdesk-support-${label}.deb`);
            await _runProcess('dpkg-deb', ['--build', pkgRoot, debPath], { cwd: packDir });
            return debPath;
        }
        case 'rpm': {
            const topdir = path.join(packDir, 'rpmbuild');
            for (const sub of ['BUILD', 'RPMS', 'SOURCES', 'SPECS', 'SRPMS', 'BUILDROOT']) {
                await fsp.mkdir(path.join(topdir, sub), { recursive: true });
            }
            await fsp.copyFile(binaryPath, path.join(topdir, 'SOURCES', 'betterdesk-support'));
            const spec = `Name:           betterdesk-support
Version:        1.0.0
Release:        1%{?dist}
Summary:        BetterDesk Support Agent
License:        Proprietary
BuildArch:      x86_64
AutoReqProv:    no
Source0:        betterdesk-support

%description
BetterDesk branded support agent for end-user workstations.

%prep
# binary-only package

%build
# binary-only package

%install
mkdir -p %{buildroot}/usr/local/bin
install -m 755 %{SOURCE0} %{buildroot}/usr/local/bin/betterdesk-support

%post
/usr/local/bin/betterdesk-support -install || true

%files
/usr/local/bin/betterdesk-support
`;
            const specPath = path.join(topdir, 'SPECS', 'betterdesk-support.spec');
            await fsp.writeFile(specPath, spec, 'utf8');
            await _runProcess('rpmbuild', [
                '-bb',
                '--define', `_topdir ${topdir}`,
                specPath,
            ], { cwd: packDir });
            const rpmsDir = path.join(topdir, 'RPMS', 'x86_64');
            const files = await fsp.readdir(rpmsDir);
            const rpmFile = files.find((f) => f.endsWith('.rpm'));
            if (!rpmFile) throw new Error('rpmbuild produced no .rpm artifact');
            return path.join(rpmsDir, rpmFile);
        }
        case 'appimage': {
            const appDir = path.join(packDir, 'BetterDeskSupport.AppDir');
            const binDir = path.join(appDir, 'usr', 'bin');
            await fsp.mkdir(binDir, { recursive: true });
            const binDest = path.join(binDir, 'betterdesk-support');
            await fsp.copyFile(binaryPath, binDest);
            await fsp.chmod(binDest, 0o755);
            await fsp.writeFile(path.join(binDir, 'portable'), '', 'utf8');

            const displayName = String(branding.product_name || branding.company_name || 'BetterDesk Support')
                .replace(/[\r\n\t]/g, ' ')
                .trim()
                .slice(0, 80);

            await fsp.writeFile(path.join(appDir, 'AppRun'), `#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
export PATH="$HERE/usr/bin:$PATH"
exec "$HERE/usr/bin/betterdesk-support" "$@"
`, { mode: 0o755 });

            await fsp.writeFile(path.join(appDir, 'betterdesk-support.desktop'),
                `[Desktop Entry]
Type=Application
Name=${displayName}
Comment=Remote support agent
Exec=betterdesk-support
Icon=betterdesk-support
Categories=Network;Utility;
Terminal=false
StartupNotify=true
`, 'utf8');

            await _writeAppImageIcon(appDir, branding);

            const outPath = path.join(packDir, `betterdesk-support-${label}-portable.AppImage`);
            await _runProcess('appimagetool', ['--no-appstream', appDir, outPath], {
                cwd: packDir,
                env: { ARCH: 'x86_64', APPIMAGE_EXTRACT_AND_RUN: '1' },
            });
            return outPath;
        }
        default:
            throw new Error(`unknown pack profile ${profile.pack}`);
    }
}

function _runProcess(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            cwd: opts.cwd,
            env: _buildEnv(opts.env || {}),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderrTail = '';
        child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-8192); });
        child.stdout.on('data', () => {});
        const timeout = setTimeout(() => {
            try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
            reject(new Error(`${cmd} timed out`));
        }, BUILD_TIMEOUT_MS);
        child.once('error', (e) => { clearTimeout(timeout); reject(e); });
        child.once('exit', (code) => {
            clearTimeout(timeout);
            if (code === 0) return resolve();
            reject(new Error(`${cmd} exited ${code}\n${stderrTail}`));
        });
    });
}

// 1×1 PNG fallback when branding logo is missing or unsupported for AppImage.
const DEFAULT_APPIMAGE_ICON = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);

async function _writeAppImageIcon(appDir, branding) {
    const iconPath = path.join(appDir, 'betterdesk-support.png');
    const logo = branding?.logo_data_url || '';
    const match = logo.match(/^data:image\/(png|jpe?g);base64,(.+)$/i);
    if (match) {
        await fsp.writeFile(iconPath, Buffer.from(match[2], 'base64'));
        return;
    }
    await fsp.writeFile(iconPath, DEFAULT_APPIMAGE_ICON);
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

module.exports = {
    enqueueBuildsForHash,
    requeueAllBundleBuilds,
    rebuildBundleById,
    requeueFailedToolchainBuilds,
    markRebuildPending,
    processPendingRebuildOnStartup,
    reconcileAgentSourceDrift,
    stageSourcesFromGitHub,
    syncFullAgentSourceFromGitHub,
    startWorker,
    stopWorker,
    getReadyArtifact,
    _internals: { BUILD_PROFILES, BUILD_CACHE_DIR, ARTIFACT_ROOT, SOURCE_ROOT },
};
