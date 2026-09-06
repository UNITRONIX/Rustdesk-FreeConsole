/**
 * BetterDesk Console — RdClient desktop build worker (Tauri)
 *
 * Builds branded RdClient installers when generator bundles have product_type=rdclient.
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
const {
    PRODUCT_TYPES,
    normalizeProductType,
    isQueuedBuildStatus,
} = require('../lib/generatorBuildTypes');

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
    console.warn('[rdclientBuildWorker] could not load build env file:', e.message);
}

const BUILD_CACHE_DIR = process.env.BUILD_CACHE_DIR
    || path.join(config.dataDir || '/opt/BetterDeskConsole/data', 'build-cache');
const WORK_ROOT = path.join(BUILD_CACHE_DIR, 'rdclient-work');
const ARTIFACT_ROOT = process.env.RDCLIENT_ARTIFACT_DIR
    || path.join(config.dataDir || '/opt/BetterDeskConsole/data', 'rdclient-builds');
const POLL_INTERVAL_MS = parseInt(process.env.RDCLIENT_BUILD_POLL_MS || '8000', 10);
const BUILD_TIMEOUT_MS = parseInt(process.env.RDCLIENT_BUILD_TIMEOUT_MS || (45 * 60 * 1000), 10);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SOURCE_ROOT = path.join(REPO_ROOT, 'rdclient-desktop');

const BUILD_PROFILES = {
    'windows/x64/portable': { os: 'windows', bundles: [], artifact: 'exe' },
    'windows/x64/installed': { os: 'windows', bundles: ['msi'], artifact: 'msi' },
    'linux/x64/portable': { os: 'linux', bundles: [], artifact: 'tgz' },
    'linux/x64/appimage': { os: 'linux', bundles: ['appimage'], artifact: 'appimage' },
    'linux/x64/installed': { os: 'linux', bundles: ['deb'], artifact: 'deb' },
    'linux/x64/rpm': { os: 'linux', bundles: ['rpm'], artifact: 'rpm' },
};

function _isRdclientBundle(_bundle) {
    // Product types collapsed to betterdesk-support; rdclient worker is unused.
    return false;
}

let _pollTimer = null;
let _running = false;
let _activeBuilds = 0;

function _run(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            cwd: opts.cwd,
            env: { ...process.env, ...(opts.env || {}) },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { out += d.toString(); });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`timeout after ${BUILD_TIMEOUT_MS}ms`));
        }, BUILD_TIMEOUT_MS);
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(out);
            else reject(new Error(`${cmd} exited ${code}: ${out.slice(-4000)}`));
        });
    });
}

async function _copyDir(src, dest) {
    await fsp.mkdir(dest, { recursive: true });
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const ent of entries) {
        const s = path.join(src, ent.name);
        const d = path.join(dest, ent.name);
        if (ent.name === 'node_modules' || ent.name === 'target') continue;
        if (ent.isDirectory()) await _copyDir(s, d);
        else await fsp.copyFile(s, d);
    }
}

async function _findBundleForHash(hash) {
    const all = await db.listAgentBundles({ includeRevoked: true });
    return all.find((b) => b.branding_hash === hash) || null;
}

async function _listPendingRdclientBuilds(limit) {
    const bundles = await db.listAgentBundles();
    const out = [];
    for (const b of bundles) {
        if (b.revoked || !_isRdclientBundle(b)) continue;
        const builds = await db.listAgentBundleBuildsForHash(b.branding_hash);
        for (const r of builds) {
            if (isQueuedBuildStatus(r.status)) out.push(r);
            if (out.length >= limit) break;
        }
        if (out.length >= limit) break;
    }
    return out;
}

async function _hasRdclientBuildInProgress() {
    if (_activeBuilds > 0) return true;
    const bundles = await db.listAgentBundles();
    for (const b of bundles) {
        if (!_isRdclientBundle(b) || b.revoked) continue;
        const builds = await db.listAgentBundleBuildsForHash(b.branding_hash);
        if (builds.some((r) => r.status === 'building')) return true;
    }
    return false;
}

async function enqueueBuildsForHash(brandingHash, { force = false } = {}) {
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
            status: 'queued',
            artifactPath: existing?.artifact_path || null,
            artifactSize: existing?.artifact_size || 0,
            artifactSha256: existing?.artifact_sha256 || null,
            errorMessage: '',
        });
    }
}

async function requeueAllBundleBuilds() {
    const bundles = await db.listAgentBundles({ includeRevoked: false });
    const hashes = [...new Set(
        bundles
            .filter((bundle) => !bundle.revoked && _isRdclientBundle(bundle))
            .map((bundle) => bundle.branding_hash)
            .filter(Boolean)
    )];
    for (const hash of hashes) {
        await enqueueBuildsForHash(hash, { force: true });
    }
    return { bundles: hashes.length };
}

async function rebuildBundleById(bundleId) {
    const row = await db.getAgentBundle(bundleId);
    if (!row) return { success: false, error: 'not_found' };
    if (!_isRdclientBundle(row)) return { success: false, error: 'not_rdclient' };
    if (!row.branding_hash) return { success: false, error: 'missing_hash' };
    await enqueueBuildsForHash(row.branding_hash, { force: true });
    return { success: true, platforms: (bundleService.PLATFORMS || []).length };
}

async function requeuePlatformBuild(brandingHash, platform, arch, format) {
    if (!brandingHash || !platform || !arch || !format) {
        return { success: false, error: 'missing_args' };
    }
    const allowed = (bundleService.PLATFORMS || []).some(
        (p) => p.platform === platform && p.arch === arch && p.format === format
    );
    if (!allowed) return { success: false, error: 'unsupported_platform' };
    const bundle = await _findBundleForHash(brandingHash);
    if (!bundle || !_isRdclientBundle(bundle)) {
        return { success: false, error: 'not_rdclient' };
    }
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
    return { success: true };
}

async function _materialiseWorkDir(hash, branding) {
    const workDir = path.join(WORK_ROOT, hash.slice(0, 16));
    if (fs.existsSync(workDir)) {
        await fsp.rm(workDir, { recursive: true, force: true });
    }
    await _copyDir(SOURCE_ROOT, workDir);
    const embed = {
        server_url: branding.panel_url || branding.server_url || '',
        bundle_id: branding.bundle_id || '',
    };
    await fsp.writeFile(
        path.join(workDir, 'betterdesk-rdclient.json'),
        JSON.stringify(embed, null, 2),
        'utf8'
    );
    return workDir;
}

async function _findArtifact(workDir, profile, key) {
    const bundleDir = path.join(workDir, 'src-tauri', 'target', 'release', 'bundle');
    const releaseDir = path.join(workDir, 'src-tauri', 'target', 'release');
    if (profile.artifact === 'deb') {
        const debDir = path.join(bundleDir, 'deb');
        const files = fs.existsSync(debDir) ? await fsp.readdir(debDir) : [];
        const deb = files.find((f) => f.endsWith('.deb'));
        if (deb) return path.join(debDir, deb);
    }
    if (profile.artifact === 'rpm') {
        const rpmDir = path.join(bundleDir, 'rpm');
        const files = fs.existsSync(rpmDir) ? await fsp.readdir(rpmDir) : [];
        const rpm = files.find((f) => f.endsWith('.rpm'));
        if (rpm) return path.join(rpmDir, rpm);
    }
    if (profile.artifact === 'appimage') {
        const aiDir = path.join(bundleDir, 'appimage');
        const files = fs.existsSync(aiDir) ? await fsp.readdir(aiDir) : [];
        const ai = files.find((f) => f.endsWith('.AppImage'));
        if (ai) return path.join(aiDir, ai);
    }
    if (profile.artifact === 'msi') {
        const msiDir = path.join(bundleDir, 'msi');
        const files = fs.existsSync(msiDir) ? await fsp.readdir(msiDir) : [];
        const msi = files.find((f) => f.endsWith('.msi'));
        if (msi) return path.join(msiDir, msi);
    }
    if (profile.artifact === 'exe') {
        const names = ['betterdesk-rdclient.exe', 'BetterDesk RdClient.exe', 'rdclient-desktop.exe'];
        for (const n of names) {
            const p = path.join(releaseDir, n);
            if (fs.existsSync(p)) return p;
        }
    }
    if (profile.artifact === 'tgz') {
        const names = ['betterdesk-rdclient', 'BetterDesk RdClient', 'rdclient-desktop'];
        for (const n of names) {
            const bin = path.join(releaseDir, n);
            if (fs.existsSync(bin)) {
                const stage = path.join(workDir, 'dist-portable');
                await fsp.mkdir(stage, { recursive: true });
                await fsp.copyFile(bin, path.join(stage, n));
                const launcher = path.join(SOURCE_ROOT, 'scripts', 'rdclient-launcher.sh');
                if (fs.existsSync(launcher)) {
                    await fsp.copyFile(launcher, path.join(stage, 'rdclient-launcher.sh'));
                    await fsp.chmod(path.join(stage, 'rdclient-launcher.sh'), 0o755);
                }
                const tarPath = path.join(ARTIFACT_ROOT, `${key.replace(/\//g, '-')}.tar.gz`);
                await fsp.mkdir(path.dirname(tarPath), { recursive: true });
                await _run('tar', ['-czf', tarPath, '-C', stage, '.']);
                return tarPath;
            }
        }
    }
    throw new Error(`artifact not found for ${key}`);
}

async function _sha256(filePath) {
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
    const profile = BUILD_PROFILES[key];
    if (!profile) throw new Error(`unsupported profile ${key}`);

    const bundleRow = await _findBundleForHash(buildRow.branding_hash);
    if (!bundleRow || !_isRdclientBundle(bundleRow)) {
        throw new Error('not an rdclient bundle');
    }

    const branding = JSON.parse(bundleRow.branding || '{}');
    if (!branding.panel_url && !branding.server_url) {
        throw new Error('panel_url missing in rdclient bundle branding');
    }

    console.log(`[rdclientBuildWorker] build start ${key} hash=${buildRow.branding_hash.slice(0, 12)}`);
    const workDir = await _materialiseWorkDir(buildRow.branding_hash, branding);
    await _run('npm', ['ci'], { cwd: workDir });

    const tauriArgs = ['run', 'tauri', 'build'];
    if (profile.bundles.length) {
        tauriArgs.push('--', '--bundles', profile.bundles.join(','));
    }
    await _run('npm', tauriArgs, { cwd: workDir });

    const built = await _findArtifact(workDir, profile, key);
    const destDir = path.join(ARTIFACT_ROOT, buildRow.branding_hash.slice(0, 16));
    await fsp.mkdir(destDir, { recursive: true });
    const destName = path.basename(built);
    const destPath = path.join(destDir, destName);
    if (built !== destPath) await fsp.copyFile(built, destPath);
    const stat = await fsp.stat(destPath);
    const sha = await _sha256(destPath);

    await db.upsertAgentBundleBuild({
        brandingHash: buildRow.branding_hash,
        platform: buildRow.platform,
        arch: buildRow.arch,
        format: buildRow.format,
        status: 'ready',
        artifactPath: destPath,
        artifactSize: stat.size,
        artifactSha256: sha,
        errorMessage: '',
    });
    console.log(`[rdclientBuildWorker] build ready ${key} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
}

async function _tick() {
    if (_running || _activeBuilds > 0) return;
    if (await _hasRdclientBuildInProgress()) return;
    _running = true;
    try {
        const pending = await _listPendingRdclientBuilds(1);
        if (!pending.length) return;
        const row = pending[0];
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
        _activeBuilds++;
        try {
            await _runOne(row);
        } catch (e) {
            const msg = e.message || String(e);
            console.error(`[rdclientBuildWorker] build FAILED ${row.platform}/${row.format}: ${msg}`);
            await db.upsertAgentBundleBuild({
                brandingHash: row.branding_hash,
                platform: row.platform,
                arch: row.arch,
                format: row.format,
                status: 'failed',
                artifactPath: null,
                artifactSize: 0,
                artifactSha256: null,
                errorMessage: msg.slice(0, 2000),
            });
        } finally {
            _activeBuilds--;
        }
    } finally {
        _running = false;
    }
}

function startWorker() {
    if (_pollTimer) return;
    if (!fs.existsSync(SOURCE_ROOT)) {
        console.warn('[rdclientBuildWorker] rdclient-desktop source not found — worker disabled');
        return;
    }
    fsp.mkdir(WORK_ROOT, { recursive: true }).catch(() => {});
    fsp.mkdir(ARTIFACT_ROOT, { recursive: true }).catch(() => {});
    _pollTimer = setInterval(() => {
        _tick().catch((e) => console.error('[rdclientBuildWorker] tick error:', e.message));
    }, POLL_INTERVAL_MS);
    console.log(`[rdclientBuildWorker] started (poll ${POLL_INTERVAL_MS}ms)`);
}

function stopWorker() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = null;
}

module.exports = {
    startWorker,
    stopWorker,
    enqueueBuildsForHash,
    requeueAllBundleBuilds,
    rebuildBundleById,
    requeuePlatformBuild,
    _internals: {
        isRdclientBundle: _isRdclientBundle,
        listPendingBuilds: _listPendingRdclientBuilds,
    },
};
