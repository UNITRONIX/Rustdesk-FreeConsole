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
const SOURCE_ROOT      = _resolveSourceRoot();
const AGENT_LIB_ROOT   = _resolveAgentLibRoot();
const POLL_INTERVAL_MS = parseInt(process.env.AGENT_BUILD_POLL_MS || '5000', 10);
const WORKER_CONCURRENCY = parseInt(process.env.AGENT_BUILD_CONCURRENCY || '1', 10);
const BUILD_TIMEOUT_MS = parseInt(process.env.AGENT_BUILD_TIMEOUT_MS || (30 * 60 * 1000), 10);

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

const GO_BIN = process.env.GO_BIN || _resolveBin(['/usr/bin/go', '/usr/local/go/bin/go']);
const BASE_BUILD_ENV = {
    PATH: `/usr/local/go/bin:/usr/bin:/bin:${process.env.PATH || ''}`,
    HOME: `/home/${BUILD_USER}`,
    CGO_ENABLED: '1',
    GOPATH: process.env.GOPATH || `/home/${BUILD_USER}/go`,
};

const BUILD_PROFILES = {
    'windows/x64/portable':  { os: 'windows', ext: '.zip',  pack: 'zip-portable' },
    'windows/x64/installed': { os: 'windows', ext: '.exe',  pack: 'raw' },
    'linux/x64/portable':    { os: 'linux',   ext: '.tar.gz',   pack: 'tar-portable' },
    'linux/x64/appimage':    { os: 'linux',   ext: '.AppImage', pack: 'appimage' },
    'linux/x64/installed':   { os: 'linux',   ext: '.deb',      pack: 'deb' },
    'linux/x64/rpm':         { os: 'linux',   ext: '.rpm',  pack: 'rpm' },
};

function _resolveBin(candidates) {
    for (const c of candidates) { if (fs.existsSync(c)) return c; }
    return candidates[0];
}

let _running = false;
let _activeBuilds = 0;
let _pollHandle = null;

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

function startWorker() {
    if (_pollHandle) return;
    console.log(`[agentBuildWorker] Go support-agent source=${SOURCE_ROOT}`);
    _ensureDirs().catch((e) => console.error('[agentBuildWorker] dir init failed:', e));
    _pollHandle = setInterval(() => {
        _tick().catch((e) => console.error('[agentBuildWorker] tick error:', e.message));
    }, POLL_INTERVAL_MS);
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
                'If the window fails with an OpenGL/WGL error (common in VMs or RDP):\r\n' +
                '  1. Install "OpenGL Compatibility Pack" from Microsoft Store, or\r\n' +
                '  2. Run: betterdesk-support.exe -nogui\r\n' +
                '     (or use Uruchom-bez-okna.bat)\r\n\r\n' +
                '-nogui runs the agent in the background without a window.\r\n' +
                'Supervised session prompts require the normal GUI build.\r\n',
                'utf8');
            await fsp.writeFile(path.join(stage, 'Uruchom-bez-okna.bat'),
                '@echo off\r\nstart "" "%~dp0betterdesk-support.exe" -nogui\r\n',
                'utf8');
            const zipPath = path.join(packDir, `betterdesk-support-${label}-portable.zip`);
            await _runProcess('zip', ['-j', zipPath,
                path.join(stage, baseName),
                path.join(stage, 'portable'),
                path.join(stage, 'README.txt'),
                path.join(stage, 'Uruchom-bez-okna.bat'),
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
            env: { ...BASE_BUILD_ENV, ...(opts.env || {}) },
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
    startWorker,
    stopWorker,
    getReadyArtifact,
    _internals: { BUILD_PROFILES, BUILD_CACHE_DIR, ARTIFACT_ROOT, SOURCE_ROOT },
};
