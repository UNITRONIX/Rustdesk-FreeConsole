/**
 * BetterDesk Console — Agent Client build worker (Tauri + Go sidecar)
 *
 * Builds branded betterdesk-agent-client installers when generator bundles
 * have product_type=agent-client.
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
    console.warn('[agentClientBuildWorker] could not load build env file:', e.message);
}

const BUILD_USER = process.env.BUILD_USER || 'unitronix';
const BUILD_CACHE_DIR = process.env.CARGO_TARGET_DIR
    || process.env.BUILD_CACHE_DIR
    || path.join(config.dataDir || '/opt/BetterDeskConsole/data', 'build-cache');
const WORK_ROOT = path.join(BUILD_CACHE_DIR, 'agent-client-work');
const AGENT_LIB_CACHE = path.join(BUILD_CACHE_DIR, 'agent-client-lib');
const ARTIFACT_ROOT = process.env.AGENT_CLIENT_ARTIFACT_DIR
    || path.join(config.dataDir || '/opt/BetterDeskConsole/data', 'agent-client-builds');
const POLL_INTERVAL_MS = parseInt(process.env.AGENT_CLIENT_BUILD_POLL_MS || '8000', 10);
const BUILD_TIMEOUT_MS = parseInt(process.env.AGENT_CLIENT_BUILD_TIMEOUT_MS || (45 * 60 * 1000), 10);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function _resolveSourceRoot() {
    if (process.env.AGENT_CLIENT_SOURCE_DIR) return process.env.AGENT_CLIENT_SOURCE_DIR;
    const candidates = [
        path.join(REPO_ROOT, 'betterdesk-agent-client'),
        '/opt/BetterDeskConsole/agent-source/betterdesk-agent-client',
    ];
    for (const c of candidates) {
        if (fs.existsSync(path.join(c, 'src-tauri', 'Cargo.toml'))) return c;
    }
    return candidates[0];
}

function _resolveAgentLibRoot() {
    if (process.env.AGENT_LIB_DIR) return process.env.AGENT_LIB_DIR;
    const candidates = [
        path.join(REPO_ROOT, 'betterdesk-agent'),
        '/opt/BetterDeskConsole/agent-source/betterdesk-agent',
    ];
    for (const c of candidates) {
        if (fs.existsSync(path.join(c, 'go.mod'))) return c;
    }
    return candidates[0];
}

const SOURCE_ROOT = _resolveSourceRoot();
const AGENT_LIB_ROOT = _resolveAgentLibRoot();
const CARGO_HOME = process.env.CARGO_HOME || `/home/${BUILD_USER}/.cargo`;

function _resolveBin(candidates) {
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return candidates[0];
}

const CARGO_BIN = process.env.CARGO_BIN || _resolveBin([
    `${CARGO_HOME}/bin/cargo`,
    '/usr/local/bin/cargo',
    '/usr/bin/cargo',
]);
const NPM_BIN = process.env.NPM_BIN || _resolveBin([
    '/usr/bin/npm',
    '/usr/local/bin/npm',
]);

const BASE_BUILD_ENV = {
    PATH: `${CARGO_HOME}/bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: `/home/${BUILD_USER}`,
    CARGO_HOME,
    RUSTUP_HOME: process.env.RUSTUP_HOME || `/home/${BUILD_USER}/.rustup`,
    CARGO_TARGET_DIR: BUILD_CACHE_DIR,
    DEBIAN_FRONTEND: 'noninteractive',
    LANG: 'C.UTF-8',
    APPIMAGE_EXTRACT_AND_RUN: '1',
    NO_STRIP: '1',
};

const BUILD_PROFILES = {
    'windows/x64/portable': {
        os: 'windows', target: 'x86_64-pc-windows-msvc', bundles: ['nsis'], artifact: 'exe', runner: 'cargo-xwin',
    },
    'windows/x64/installed': {
        os: 'windows', target: 'x86_64-pc-windows-msvc', bundles: ['msi'], artifact: 'msi', runner: 'cargo-xwin',
    },
    'linux/x64/portable': { os: 'linux', target: null, bundles: [], artifact: 'tgz' },
    'linux/x64/appimage': { os: 'linux', target: null, bundles: ['appimage'], artifact: 'appimage' },
    'linux/x64/installed': { os: 'linux', target: null, bundles: ['deb'], artifact: 'deb' },
    'linux/x64/rpm': { os: 'linux', target: null, bundles: ['rpm'], artifact: 'rpm' },
};

const SIDECAR_NAMES = {
    'linux/x64': 'betterdesk-agent-x86_64-unknown-linux-gnu',
    'windows/x64': 'betterdesk-agent-x86_64-pc-windows-msvc.exe',
};

let _pollTimer = null;
let _running = false;
let _activeBuilds = 0;

function _run(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            cwd: opts.cwd,
            env: { ...BASE_BUILD_ENV, ...(opts.env || {}) },
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
    const SKIP = new Set(['node_modules', 'target', 'dist', '.git', 'data']);
    await fsp.mkdir(dest, { recursive: true });
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const ent of entries) {
        if (SKIP.has(ent.name)) continue;
        const s = path.join(src, ent.name);
        const d = path.join(dest, ent.name);
        if (ent.isDirectory()) await _copyDir(s, d);
        else await fsp.copyFile(s, d);
    }
}

function _agentClientBranding(branding) {
    const b = { ...(branding || {}) };
    delete b.enrollment_token;
    delete b.has_enrollment_token;
    delete b.enrollment_token_masked;
    return {
        product_name: b.product_name || b.company_name || 'BetterDesk Agent',
        company_name: b.company_name || 'BetterDesk',
        tagline: b.short_text || b.tagline || '',
        short_text: b.short_text || b.tagline || '',
        support_email: b.contact_email || b.support_email || '',
        contact_email: b.contact_email || b.support_email || '',
        support_phone: b.contact_phone || b.support_phone || '',
        contact_phone: b.contact_phone || b.support_phone || '',
        contact_url: b.contact_url || '',
        primary_color: b.primary_color || '#2563eb',
        accent_color: b.accent_color || '#0ea5e9',
        logo_data_url: b.logo_data_url || '',
        default_language: b.default_lang || b.default_language || 'en',
        default_lang: b.default_lang || b.default_language || 'en',
        allow_unattended: !!b.allow_unattended,
        server_address: b.server_address || b.server?.address || '',
        server_key: b.server_key || b.server?.public_key || '',
        bundle_id: b.bundle_id || '',
        server: b.server || undefined,
    };
}

async function _ensureAgentLib() {
    if (!fs.existsSync(path.join(AGENT_LIB_ROOT, 'go.mod'))) {
        throw new Error(`betterdesk-agent source missing at ${AGENT_LIB_ROOT}`);
    }
    if (fs.existsSync(AGENT_LIB_CACHE)) {
        await fsp.rm(AGENT_LIB_CACHE, { recursive: true, force: true });
    }
    await _copyDir(AGENT_LIB_ROOT, AGENT_LIB_CACHE);
    return AGENT_LIB_CACHE;
}

async function _buildSidecar(profile, destPath) {
    const agentBuildWorker = require('./agentBuildWorker');
    const goBin = typeof agentBuildWorker.getGoBin === 'function'
        ? agentBuildWorker.getGoBin()
        : null;
    if (!goBin) throw new Error('Go toolchain not available for sidecar build');

    const agentLib = await _ensureAgentLib();
    const goos = profile.os === 'windows' ? 'windows' : 'linux';
    const goarch = 'amd64';
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    await _run(goBin, [
        'build', '-ldflags', '-s -w',
        '-o', destPath,
        '.',
    ], {
        cwd: agentLib,
        env: { CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch },
    });
    if (profile.os === 'linux') {
        await fsp.chmod(destPath, 0o755);
    }
}

async function _materialiseWorkDir(hash, branding, profile) {
    const workDir = path.join(WORK_ROOT, hash.slice(0, 16));
    if (fs.existsSync(workDir)) {
        await fsp.rm(workDir, { recursive: true, force: true });
    }
    await _copyDir(SOURCE_ROOT, workDir);

    const sidecarKey = `${profile.os}/${profile.target ? 'x64' : 'x64'}`;
    const sidecarName = SIDECAR_NAMES[sidecarKey]
        || (profile.os === 'windows'
            ? 'betterdesk-agent-x86_64-pc-windows-msvc.exe'
            : 'betterdesk-agent-x86_64-unknown-linux-gnu');
    const binariesDir = path.join(workDir, 'src-tauri', 'binaries');
    await fsp.mkdir(binariesDir, { recursive: true });
    const sidecarDest = path.join(binariesDir, sidecarName);
    await _buildSidecar(profile, sidecarDest);

    const agentLibSibling = path.join(path.dirname(workDir), 'betterdesk-agent');
    if (fs.existsSync(agentLibSibling)) {
        await fsp.rm(agentLibSibling, { recursive: true, force: true });
    }
    await _copyDir(AGENT_LIB_ROOT, agentLibSibling);

    const resDir = path.join(workDir, 'src-tauri', 'resources');
    await fsp.mkdir(resDir, { recursive: true });
    await fsp.writeFile(
        path.join(resDir, 'branding.json'),
        JSON.stringify(_agentClientBranding(branding), null, 2),
        'utf8'
    );
    return workDir;
}

async function _findArtifact(workDir, profile, key) {
    const bundleBase = profile.target
        ? path.join(BUILD_CACHE_DIR, profile.target, 'release', 'bundle')
        : path.join(BUILD_CACHE_DIR, 'release', 'bundle');
    const releaseDir = profile.target
        ? path.join(BUILD_CACHE_DIR, profile.target, 'release')
        : path.join(BUILD_CACHE_DIR, 'release');

    if (profile.artifact === 'deb') {
        const debDir = path.join(bundleBase, 'deb');
        const files = fs.existsSync(debDir) ? await fsp.readdir(debDir) : [];
        const deb = files.find((f) => f.endsWith('.deb'));
        if (deb) return path.join(debDir, deb);
    }
    if (profile.artifact === 'rpm') {
        const rpmDir = path.join(bundleBase, 'rpm');
        const files = fs.existsSync(rpmDir) ? await fsp.readdir(rpmDir) : [];
        const rpm = files.find((f) => f.endsWith('.rpm'));
        if (rpm) return path.join(rpmDir, rpm);
    }
    if (profile.artifact === 'appimage') {
        const aiDir = path.join(bundleBase, 'appimage');
        const files = fs.existsSync(aiDir) ? await fsp.readdir(aiDir) : [];
        const ai = files.find((f) => f.endsWith('.AppImage'));
        if (ai) return path.join(aiDir, ai);
    }
    if (profile.artifact === 'msi') {
        const msiDir = path.join(bundleBase, 'msi');
        const files = fs.existsSync(msiDir) ? await fsp.readdir(msiDir) : [];
        const msi = files.find((f) => f.endsWith('.msi'));
        if (msi) return path.join(msiDir, msi);
    }
    if (profile.artifact === 'exe') {
        const nsisDir = path.join(bundleBase, 'nsis');
        const files = fs.existsSync(nsisDir) ? await fsp.readdir(nsisDir) : [];
        const exe = files.find((f) => f.endsWith('-setup.exe') || f.endsWith('.exe'));
        if (exe) return path.join(nsisDir, exe);
        for (const n of ['betterdesk-agent-client.exe', 'BetterDesk Agent.exe']) {
            const p = path.join(releaseDir, n);
            if (fs.existsSync(p)) return p;
        }
    }
    if (profile.artifact === 'tgz') {
        const names = ['betterdesk-agent-client', 'BetterDesk Agent'];
        for (const n of names) {
            const bin = path.join(releaseDir, n);
            if (fs.existsSync(bin)) {
                const stage = path.join(workDir, 'dist-portable');
                await fsp.mkdir(stage, { recursive: true });
                await fsp.copyFile(bin, path.join(stage, n));
                await fsp.copyFile(
                    path.join(workDir, 'src-tauri', 'binaries', SIDECAR_NAMES['linux/x64']),
                    path.join(stage, SIDECAR_NAMES['linux/x64'])
                );
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

async function _findBundleForHash(hash) {
    const all = await db.listAgentBundles({ includeRevoked: true });
    return all.find((b) => b.branding_hash === hash) || null;
}

async function _listPendingAgentClientBuilds(limit) {
    const bundles = await db.listAgentBundles();
    const out = [];
    for (const b of bundles) {
        if (b.revoked || (b.product_type || 'agent') !== 'agent-client') continue;
        const builds = await db.listAgentBundleBuildsForHash(b.branding_hash);
        for (const r of builds) {
            if (r.status === 'pending') out.push(r);
            if (out.length >= limit) break;
        }
        if (out.length >= limit) break;
    }
    return out;
}

async function _hasAgentClientBuildInProgress() {
    if (_activeBuilds > 0) return true;
    const bundles = await db.listAgentBundles();
    for (const b of bundles) {
        if ((b.product_type || 'agent') !== 'agent-client' || b.revoked) continue;
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
            status: 'pending',
            artifactPath: existing?.artifact_path || null,
            artifactSize: existing?.artifact_size || 0,
            artifactSha256: existing?.artifact_sha256 || null,
            errorMessage: '',
        });
    }
}

async function rebuildBundleById(bundleId) {
    const row = await db.getAgentBundle(bundleId);
    if (!row) return { success: false, error: 'not_found' };
    if ((row.product_type || 'agent') !== 'agent-client') {
        return { success: false, error: 'not_agent_client' };
    }
    await enqueueBuildsForHash(row.branding_hash, { force: true });
    return { success: true, platforms: (bundleService.PLATFORMS || []).length };
}

async function _runOne(buildRow) {
    const key = `${buildRow.platform}/${buildRow.arch}/${buildRow.format}`;
    const profile = BUILD_PROFILES[key];
    if (!profile) throw new Error(`unsupported profile ${key}`);

    const bundleRow = await _findBundleForHash(buildRow.branding_hash);
    if (!bundleRow || (bundleRow.product_type || 'agent') !== 'agent-client') {
        throw new Error('not an agent-client bundle');
    }

    const branding = JSON.parse(bundleRow.branding || '{}');
    console.log(`[agentClientBuildWorker] build start ${key} hash=${buildRow.branding_hash.slice(0, 12)}`);
    const workDir = await _materialiseWorkDir(buildRow.branding_hash, branding, profile);
    await _run(NPM_BIN, ['ci', '--no-audit', '--no-fund'], { cwd: workDir });

    const npmTauriArgs = ['run', 'tauri', 'build'];
    if (profile.runner) npmTauriArgs.push('--runner', profile.runner);
    if (profile.target || profile.bundles.length) {
        npmTauriArgs.push('--');
        if (profile.target) npmTauriArgs.push('--target', profile.target);
        if (profile.bundles.length) npmTauriArgs.push('--bundles', profile.bundles.join(','));
    }
    await _run(NPM_BIN, npmTauriArgs, { cwd: workDir });

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
    console.log(`[agentClientBuildWorker] build ready ${key} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
}

async function _tick() {
    if (_running || _activeBuilds > 0) return;
    if (await _hasAgentClientBuildInProgress()) return;
    _running = true;
    try {
        const pending = await _listPendingAgentClientBuilds(1);
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
            console.error(`[agentClientBuildWorker] build FAILED ${row.platform}/${row.format}: ${msg}`);
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
    if (!fs.existsSync(path.join(SOURCE_ROOT, 'src-tauri', 'Cargo.toml'))) {
        console.warn('[agentClientBuildWorker] betterdesk-agent-client source not found — worker disabled');
        return;
    }
    fsp.mkdir(WORK_ROOT, { recursive: true }).catch(() => {});
    fsp.mkdir(ARTIFACT_ROOT, { recursive: true }).catch(() => {});
    _pollTimer = setInterval(() => {
        _tick().catch((e) => console.error('[agentClientBuildWorker] tick error:', e.message));
    }, POLL_INTERVAL_MS);
    console.log(`[agentClientBuildWorker] started source=${SOURCE_ROOT} poll=${POLL_INTERVAL_MS}ms`);
}

function stopWorker() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = null;
}

module.exports = {
    startWorker,
    stopWorker,
    enqueueBuildsForHash,
    rebuildBundleById,
};
