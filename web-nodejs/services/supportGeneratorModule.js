/**
 * BetterDesk Support Generator module install gate.
 *
 * Downloads portable desktop templates from BetterDesk-Client GitHub Releases
 * into `{dataDir}/modules/betterdesk-support-generator/` and tracks install state.
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');

const config = require('../config/config');

const MODULE_ID = 'betterdesk-support-generator';
const DEFAULT_CLIENT_REPO = 'UNITRONIX/BetterDesk-Client';
const STATE_STATUSES = new Set(['not_installed', 'downloading', 'ready', 'error']);
const SIGNING_SEED_NAME = 'custom-client-signing.seed';

function moduleDir() {
    return path.join(config.dataDir || path.join(__dirname, '..', 'data'), 'modules', MODULE_ID);
}

function statePath() {
    return path.join(moduleDir(), 'state.json');
}

function templatesDir() {
    return path.join(moduleDir(), 'templates');
}

function signingSeedPath() {
    return path.join(moduleDir(), SIGNING_SEED_NAME);
}

function clientRepo() {
    return String(process.env.BETTERDESK_CLIENT_REPO || DEFAULT_CLIENT_REPO).trim()
        || DEFAULT_CLIENT_REPO;
}

function defaultState() {
    return {
        termsAccepted: false,
        installedVersion: null,
        status: 'not_installed',
        error: null,
        installedAt: null,
    };
}

async function ensureModuleDir() {
    await fsp.mkdir(moduleDir(), { recursive: true });
}

async function readState() {
    await ensureModuleDir();
    try {
        const raw = await fsp.readFile(statePath(), 'utf8');
        const parsed = JSON.parse(raw);
        const base = defaultState();
        return {
            ...base,
            ...parsed,
            status: STATE_STATUSES.has(parsed.status) ? parsed.status : base.status,
            termsAccepted: !!parsed.termsAccepted,
        };
    } catch (_) {
        return defaultState();
    }
}

async function writeState(patch) {
    await ensureModuleDir();
    const current = await readState();
    const next = {
        ...current,
        ...patch,
    };
    if (!STATE_STATUSES.has(next.status)) next.status = current.status;
    await fsp.writeFile(statePath(), JSON.stringify(next, null, 2) + '\n', 'utf8');
    return next;
}

function templatesExist() {
    const root = templatesDir();
    if (!fs.existsSync(root)) return false;
    if (fs.existsSync(path.join(root, 'manifest.json'))) return true;
    try {
        const entries = fs.readdirSync(root, { withFileTypes: true });
        return entries.some((e) => e.isDirectory() && /^(windows|linux|macos)-/.test(e.name));
    } catch (_) {
        return false;
    }
}

function isReady(state) {
    const s = state || (fs.existsSync(statePath())
        ? JSON.parse(fs.readFileSync(statePath(), 'utf8'))
        : defaultState());
    return !!(s.termsAccepted && s.status === 'ready' && templatesExist());
}

async function getStatus() {
    const state = await readState();
    return {
        ...state,
        moduleDir: moduleDir(),
        templatesDir: templatesDir(),
        templatesPresent: templatesExist(),
        signingSeedPresent: fs.existsSync(signingSeedPath()),
        ready: isReady(state),
        clientRepo: clientRepo(),
    };
}

async function acceptTerms() {
    return writeState({ termsAccepted: true, error: null });
}

function _httpGetBuffer(url, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 8) {
            reject(new Error('too many redirects'));
            return;
        }
        const lib = String(url).startsWith('https:') ? https : http;
        const req = lib.get(url, {
            headers: {
                'User-Agent': 'BetterDesk-Console-Generator',
                Accept: 'application/octet-stream, application/json',
            },
            timeout: 120000,
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                _httpGetBuffer(res.headers.location, redirects + 1).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                return;
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('download timeout'));
        });
    });
}

async function _httpGetJson(url) {
    const buf = await _httpGetBuffer(url);
    return JSON.parse(buf.toString('utf8'));
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

async function _extractTarGz(archivePath, destDir) {
    await fsp.mkdir(destDir, { recursive: true });
    await _runTar(['-xzf', archivePath, '-C', destDir]);
}

async function _rimraf(target) {
    await fsp.rm(target, { recursive: true, force: true });
}

/**
 * Copy signing seed from env or a known on-disk seed into the module dir.
 */
async function copySigningSeedIfPresent() {
    await ensureModuleDir();
    const fromEnv = String(process.env.BETTERDESK_CUSTOM_CLIENT_SIGNING_SEED || '').trim();
    if (fromEnv) {
        await fsp.writeFile(signingSeedPath(), fromEnv.includes('\n') ? fromEnv : `${fromEnv}\n`, 'utf8');
        return true;
    }
    const candidates = [
        path.join(config.dataDir || path.join(__dirname, '..', 'data'), SIGNING_SEED_NAME),
        path.join(__dirname, '..', SIGNING_SEED_NAME),
        path.join(__dirname, '..', '..', 'res', 'betterdesk', SIGNING_SEED_NAME),
        path.join(process.cwd(), SIGNING_SEED_NAME),
    ];
    for (const src of candidates) {
        if (!fs.existsSync(src)) continue;
        await fsp.copyFile(src, signingSeedPath());
        return true;
    }
    return false;
}

function _pickTemplateAsset(assets) {
    const list = Array.isArray(assets) ? assets : [];
    const preferred = list.find((a) => /^generator-templates-.*\.tar\.gz$/i.test(a.name || ''));
    if (preferred) return preferred;
    return list.find((a) => /generator-templates/i.test(a.name || '') && /\.tar\.gz$/i.test(a.name || ''))
        || null;
}

/**
 * Download generator templates from BetterDesk-Client releases and extract them.
 * @param {{ repo?: string, tag?: string }} [opts]
 */
async function installFromGitHub({ repo, tag } = {}) {
    const state = await readState();
    if (!state.termsAccepted) {
        const err = new Error('terms_not_accepted');
        err.code = 'terms_not_accepted';
        throw err;
    }

    await writeState({ status: 'downloading', error: null });

    try {
        const targetRepo = String(repo || clientRepo()).trim() || clientRepo();
        const releaseTag = String(tag || '').trim();
        const apiBase = `https://api.github.com/repos/${targetRepo}/releases`;
        const releaseUrl = releaseTag
            ? `${apiBase}/tags/${encodeURIComponent(releaseTag)}`
            : `${apiBase}/latest`;

        const release = await _httpGetJson(releaseUrl);
        const asset = _pickTemplateAsset(release.assets || []);
        if (!asset || !asset.browser_download_url) {
            throw new Error(
                `No generator-templates-*.tar.gz asset found on ${targetRepo}`
                + (releaseTag ? ` tag ${releaseTag}` : ' latest release')
            );
        }

        const tmpDir = path.join(moduleDir(), '.tmp-install');
        await _rimraf(tmpDir);
        await fsp.mkdir(tmpDir, { recursive: true });
        const archivePath = path.join(tmpDir, asset.name || 'generator-templates.tar.gz');
        const body = await _httpGetBuffer(asset.browser_download_url);
        await fsp.writeFile(archivePath, body);

        const extractRoot = path.join(tmpDir, 'extract');
        await _extractTarGz(archivePath, extractRoot);

        // Archive arcname is usually "generator-templates/" — accept either layout.
        let sourceTemplates = path.join(extractRoot, 'generator-templates');
        if (!fs.existsSync(sourceTemplates)) {
            const kids = await fsp.readdir(extractRoot, { withFileTypes: true });
            const dir = kids.find((k) => k.isDirectory());
            sourceTemplates = dir ? path.join(extractRoot, dir.name) : extractRoot;
        }

        const dest = templatesDir();
        await _rimraf(dest);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.rename(sourceTemplates, dest).catch(async () => {
            // Cross-device rename fallback
            await fsp.cp(sourceTemplates, dest, { recursive: true });
        });

        await copySigningSeedIfPresent();
        await _rimraf(tmpDir);

        const version = String(release.tag_name || release.name || releaseTag || 'unknown').replace(/^v/, '');
        return writeState({
            status: 'ready',
            error: null,
            installedVersion: version,
            installedAt: new Date().toISOString(),
        });
    } catch (err) {
        await writeState({
            status: 'error',
            error: err.message || String(err),
        });
        throw err;
    }
}

function resolveTemplateDir(platform, arch) {
    const archMap = {
        x64: 'x86_64',
        amd64: 'x86_64',
        x86_64: 'x86_64',
        arm64: 'aarch64',
        aarch64: 'aarch64',
    };
    const p = String(platform || '').toLowerCase();
    const a = archMap[String(arch || '').toLowerCase()] || String(arch || '');
    const name = `${p}-${a}`;
    const candidates = [
        path.join(templatesDir(), name),
        path.join(templatesDir(), 'generator-templates', name),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return null;
}

function readManifest() {
    const p = path.join(templatesDir(), 'manifest.json');
    if (!fs.existsSync(p)) {
        const alt = path.join(templatesDir(), 'generator-templates', 'manifest.json');
        if (!fs.existsSync(alt)) return null;
        try { return JSON.parse(fs.readFileSync(alt, 'utf8')); } catch (_) { return null; }
    }
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function getSigningSeedBase64() {
    if (fs.existsSync(signingSeedPath())) {
        return fs.readFileSync(signingSeedPath(), 'utf8').trim();
    }
    const fromEnv = String(process.env.BETTERDESK_CUSTOM_CLIENT_SIGNING_SEED || '').trim();
    return fromEnv || '';
}

module.exports = {
    MODULE_ID,
    moduleDir,
    templatesDir,
    signingSeedPath,
    getStatus,
    acceptTerms,
    installFromGitHub,
    isReady,
    templatesExist,
    resolveTemplateDir,
    readManifest,
    getSigningSeedBase64,
    copySigningSeedIfPresent,
    clientRepo,
};
