/**
 * BetterDesk Console — Agent Build Worker
 *
 * Background queue that compiles branded Tauri agent installers per bundle
 * (Phase 2 / Generator Agenta).
 *
 * Pipeline per build row in `agent_bundle_builds`:
 *   1. Claim a pending row (status pending → building)
 *   2. Materialise workspace at $BUILD_CACHE_DIR/work/<hash>/
 *   3. Copy betterdesk-agent-client/ source tree (cached / hard-linked)
 *   4. Write src-tauri/resources/branding.json from the bundle's branding blob
 *   5. cargo tauri build --bundles <format> [--target <triple>]
 *   6. Locate produced artifact, hash + move to <ARTIFACT_ROOT>/<hash>/<file>
 *   7. Update build row (status ready/failed, path, sha256, size)
 *
 * Concurrency: 1 active build at a time (cargo + linker are CPU heavy and
 * the prod host has 4 cores / 8 GB). Configurable via WORKER_CONCURRENCY.
 *
 * Idempotency: artifacts are keyed by (branding_hash, platform, arch, format)
 * — re-runs reuse cached artifacts when the hash hasn't changed.
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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Load /etc/betterdesk/build.env (written by install-build-toolchain.sh)
// before reading any of our build vars so systemd's empty env doesn't make
// us default BUILD_USER to "root".
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

const BUILD_USER       = process.env.BUILD_USER      || 'unitronix';
const BUILD_CACHE_DIR  = process.env.CARGO_TARGET_DIR
    || process.env.BUILD_CACHE_DIR
    || path.join(config.dataDir || '/opt/BetterDeskConsole/data', 'build-cache');
const WORK_ROOT        = path.join(BUILD_CACHE_DIR, 'work');
const ARTIFACT_ROOT    = process.env.AGENT_ARTIFACT_DIR
    || path.join(config.dataDir || '/opt/BetterDeskConsole/data', 'agent-builds');
const SOURCE_ROOT      = _resolveSourceRoot();
const POLL_INTERVAL_MS = parseInt(process.env.AGENT_BUILD_POLL_MS || '5000', 10);

function _resolveSourceRoot() {
    if (process.env.AGENT_SOURCE_DIR) return process.env.AGENT_SOURCE_DIR;
    const candidates = [
        '/opt/BetterDeskConsole/agent-source/betterdesk-agent-client',
        path.resolve(__dirname, '..', '..', 'betterdesk-agent-client'),
        path.resolve(process.cwd(), 'betterdesk-agent-client'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(path.join(c, 'src-tauri', 'Cargo.toml'))) return c;
    }
    return candidates[0]; // best guess; worker will surface a clear error
}
const WORKER_CONCURRENCY = parseInt(process.env.AGENT_BUILD_CONCURRENCY || '1', 10);
const BUILD_TIMEOUT_MS = parseInt(process.env.AGENT_BUILD_TIMEOUT_MS || (30 * 60 * 1000), 10); // 30 min
const CARGO_HOME       = process.env.CARGO_HOME || `/home/${BUILD_USER}/.cargo`;

// Resolve absolute paths for spawned binaries (Node spawn ENOENT happens if
// PATH lookup fails despite env override — using absolute paths is robust).
function _resolveBin(candidates) {
    for (const c of candidates) { if (fs.existsSync(c)) return c; }
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
    '/opt/node/bin/npm',
]);

// Build env handed to cargo / tauri — sourced from /etc/betterdesk/build.env
const BASE_BUILD_ENV = {
    PATH: `${CARGO_HOME}/bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: `/home/${BUILD_USER}`,
    CARGO_HOME,
    RUSTUP_HOME: process.env.RUSTUP_HOME || `/home/${BUILD_USER}/.rustup`,
    CARGO_TARGET_DIR: BUILD_CACHE_DIR,
    DEBIAN_FRONTEND: 'noninteractive',
    LANG: 'C.UTF-8',
};

// Map our platform/arch/format → tauri-cli flags + artifact glob
const BUILD_PROFILES = {
    'linux/x64/deb':      { bundle: 'deb',      target: null,                            ext: '.deb',     bundleSubdir: 'deb' },
    'linux/x64/rpm':      { bundle: 'rpm',      target: null,                            ext: '.rpm',     bundleSubdir: 'rpm' },
    'linux/x64/AppImage': { bundle: 'appimage', target: null,                            ext: '.AppImage', bundleSubdir: 'appimage' },
    'windows/x64/exe':    { bundle: 'nsis',     target: 'x86_64-pc-windows-msvc',         ext: '.exe',     bundleSubdir: 'nsis', runner: 'cargo-xwin' },
};

let _running = false;
let _activeBuilds = 0;
let _pollHandle = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a pending row for every supported platform of the given bundle hash.
 * Idempotent: re-runs for the same hash are no-ops.
 */
async function enqueueBuildsForHash(brandingHash) {
    if (!brandingHash) throw new Error('brandingHash required');
    const platforms = bundleService.PLATFORMS || [];
    for (const p of platforms) {
        const existing = await db.getAgentBundleBuild({
            brandingHash, platform: p.platform, arch: p.arch, format: p.format,
        });
        if (existing && (existing.status === 'ready' || existing.status === 'building')) {
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

/**
 * Start the worker poll loop. Safe to call multiple times.
 */
function startWorker() {
    if (_pollHandle) return;
    console.log(`[agentBuildWorker] paths cargo=${CARGO_BIN} npm=${NPM_BIN} source=${SOURCE_ROOT}`);
    _ensureDirs().catch((e) => console.error('[agentBuildWorker] dir init failed:', e));
    _pollHandle = setInterval(() => {
        _tick().catch((e) => console.error('[agentBuildWorker] tick error:', e.message));
    }, POLL_INTERVAL_MS);
    console.log(`[agentBuildWorker] started (poll ${POLL_INTERVAL_MS}ms, concurrency ${WORKER_CONCURRENCY})`);
}

function stopWorker() {
    if (_pollHandle) { clearInterval(_pollHandle); _pollHandle = null; }
}

/**
 * Resolve a ready artifact on disk; returns null if not yet built or missing.
 */
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

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function _ensureDirs() {
    await fsp.mkdir(WORK_ROOT,     { recursive: true });
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
            .catch((e) => console.error(`[agentBuildWorker] build crashed:`, e))
            .finally(() => { _activeBuilds--; });
    } finally {
        _running = false;
    }
}

async function _claimNextBuild() {
    // Find the oldest pending row across all hashes.
    // dbAdapter doesn't expose a "claim" helper, so we read then upsert.
    // Race safety: concurrency = 1 by default; if you raise it, add a
    // db-level UPDATE...RETURNING claim instead.
    const candidates = await _listPendingBuilds(10);
    for (const row of candidates) {
        const profile = BUILD_PROFILES[`${row.platform}/${row.arch}/${row.format}`];
        if (!profile) continue;
        await db.upsertAgentBundleBuild({
            brandingHash: row.branding_hash,
            platform:     row.platform,
            arch:         row.arch,
            format:       row.format,
            status:       'building',
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
    // Pull recent rows then filter — dbAdapter only exposes per-hash list.
    // For now, scan all bundles' hashes (small N in practice).
    const bundles = await db.listAgentBundles();
    const out = [];
    for (const b of bundles) {
        if (b.revoked_at) continue;
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
    console.log(`[agentBuildWorker] build start  hash=${buildRow.branding_hash.slice(0, 12)} ${key}`);

    try {
        const bundleRow = await _findBundleForHash(buildRow.branding_hash);
        if (!bundleRow) throw new Error(`no bundle with hash ${buildRow.branding_hash}`);

        const branding = JSON.parse(bundleRow.branding || '{}');
        const workDir  = path.join(WORK_ROOT, buildRow.branding_hash);
        await _materialiseWorkspace(workDir, branding);

        const artifact = await _runTauriBuild(workDir, profile);
        const finalDir = path.join(ARTIFACT_ROOT, buildRow.branding_hash);
        await fsp.mkdir(finalDir, { recursive: true });

        const ext  = profile.ext || path.extname(artifact);
        const dest = path.join(finalDir, `${buildRow.platform}-${buildRow.arch}${ext}`);
        await fsp.rename(artifact, dest).catch(async (e) => {
            if (e.code === 'EXDEV') {
                await fsp.copyFile(artifact, dest);
                await fsp.unlink(artifact);
            } else { throw e; }
        });

        const stat = await fsp.stat(dest);
        const sha  = await _sha256OfFile(dest);

        await db.upsertAgentBundleBuild({
            brandingHash:   buildRow.branding_hash,
            platform:       buildRow.platform,
            arch:           buildRow.arch,
            format:         buildRow.format,
            status:         'ready',
            artifactPath:   dest,
            artifactSize:   stat.size,
            artifactSha256: sha,
            errorMessage:   '',
        });

        const ms = Date.now() - startTs;
        console.log(`[agentBuildWorker] build ready  ${key} (${(stat.size/1024/1024).toFixed(2)} MB, ${(ms/1000).toFixed(1)}s)`);
    } catch (err) {
        const ms = Date.now() - startTs;
        const msg = (err && err.message) ? err.message.slice(0, 800) : String(err).slice(0, 800);
        console.error(`[agentBuildWorker] build FAILED ${key} after ${(ms/1000).toFixed(1)}s: ${msg}`);
        await db.upsertAgentBundleBuild({
            brandingHash: buildRow.branding_hash,
            platform:     buildRow.platform,
            arch:         buildRow.arch,
            format:       buildRow.format,
            status:       'failed',
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
    // Fresh source copy each build to keep things hermetic. Cargo target dir
    // is shared globally (CARGO_TARGET_DIR), so incremental compile still
    // hits the cache.
    if (fs.existsSync(workDir)) {
        await fsp.rm(workDir, { recursive: true, force: true });
    }
    await fsp.mkdir(workDir, { recursive: true });
    await _copyDir(SOURCE_ROOT, workDir);

    const resDir  = path.join(workDir, 'src-tauri', 'resources');
    await fsp.mkdir(resDir, { recursive: true });
    await fsp.writeFile(
        path.join(resDir, 'branding.json'),
        JSON.stringify(branding, null, 2),
        'utf8'
    );
}

async function _copyDir(src, dst) {
    // Skip heavy junk that should never be in the build workspace.
    const SKIP = new Set(['node_modules', 'target', 'dist', '.git']);
    const entries = await fsp.readdir(src, { withFileTypes: true });
    await fsp.mkdir(dst, { recursive: true });
    for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        if (entry.isDirectory()) {
            await _copyDir(s, d);
        } else if (entry.isSymbolicLink()) {
            const link = await fsp.readlink(s);
            await fsp.symlink(link, d);
        } else {
            await fsp.copyFile(s, d);
        }
    }
}

async function _runTauriBuild(workDir, profile) {
    // 1) Install JS deps (npm; pnpm optional)
    await _runProcess(NPM_BIN, ['install', '--no-audit', '--no-fund'], { cwd: workDir });

    // 2) cargo tauri build [--runner cargo-xwin] --bundles <fmt> [--target <triple>]
    const args = ['tauri', 'build'];
    if (profile.runner) args.push('--runner', profile.runner);
    args.push('--bundles', profile.bundle);
    if (profile.target) args.push('--target', profile.target);

    await _runProcess(CARGO_BIN, args, { cwd: workDir });

    // 3) Locate the produced artifact. When --target is omitted, cargo writes
    //    to $CARGO_TARGET_DIR/release/bundle/<subdir>/. When --target is set,
    //    cargo inserts the target triple as an extra path segment.
    const bundleDir = profile.target
        ? path.join(BUILD_CACHE_DIR, profile.target, 'release', 'bundle', profile.bundleSubdir)
        : path.join(BUILD_CACHE_DIR, 'release', 'bundle', profile.bundleSubdir);
    const files = (await fsp.readdir(bundleDir).catch(() => [])).filter(
        f => f.toLowerCase().endsWith(profile.ext.toLowerCase())
    );
    if (files.length === 0) {
        throw new Error(`no ${profile.ext} artifact in ${bundleDir}`);
    }
    // pick newest
    let pick = files[0];
    let pickMtime = 0;
    for (const f of files) {
        const m = (await fsp.stat(path.join(bundleDir, f))).mtimeMs;
        if (m > pickMtime) { pickMtime = m; pick = f; }
    }
    return path.join(bundleDir, pick);
}

function _runProcess(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const env = { ...BASE_BUILD_ENV, ...(opts.env || {}) };
        const child = spawn(cmd, args, {
            cwd: opts.cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stderrTail = '';
        const onData = (chunk) => {
            // Keep last ~8 KB of stderr for error reporting.
            stderrTail = (stderrTail + chunk.toString()).slice(-8192);
        };
        child.stderr.on('data', onData);
        child.stdout.on('data', () => {});  // drain

        const timeout = setTimeout(() => {
            try { child.kill('SIGTERM'); } catch {}
            setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
            reject(new Error(`${cmd} timed out after ${BUILD_TIMEOUT_MS}ms`));
        }, BUILD_TIMEOUT_MS);

        child.once('error', (e) => { clearTimeout(timeout); reject(e); });
        child.once('exit', (code) => {
            clearTimeout(timeout);
            if (code === 0) return resolve();
            reject(new Error(`${cmd} exited ${code}\n--- stderr tail ---\n${stderrTail}`));
        });
    });
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
    startWorker,
    stopWorker,
    getReadyArtifact,
    // exposed for tests / diagnostics
    _internals: { BUILD_PROFILES, BUILD_CACHE_DIR, ARTIFACT_ROOT, SOURCE_ROOT },
};
