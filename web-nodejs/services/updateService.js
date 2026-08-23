/**
 * BetterDesk Console - Self-Update Service
 *
 * Commit-based update system. Compares locally tracked commit SHA with
 * the HEAD of the configured GitHub branch. Downloads changed files,
 * categorises them by component (console / server / agent / scripts),
 * applies updates, and restarts affected services.
 *
 * GitHub repo:  UNITRONIX/BetterDesk
 * Tracking:     data/.update_sha (deployed commit SHA)
 *
 * Flow:
 *   1. GET /repos/{owner}/{repo}/commits/{branch} → remote HEAD SHA
 *   2. Compare with local .update_sha
 *   3. GET /repos/{owner}/{repo}/compare/{local}...{remote} → changed files
 *   4. Categorise: console / server / scripts / agent / other
 *   5. Backup current console files → data/backups/pre-update-{ts}/
 *   6. Download & overwrite changed files for all supported changed components
 *   7. npm install if package.json changed
 *   8. Restart affected services (systemd / NSSM)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { execSync, execFileSync } = require('child_process');
const config = require('../config/config');
const {
    isAllowedSystemdUnitPath,
    privilegedSystemdUnitHint,
} = require('../lib/linuxSystemdUnitPrivileged');
const {
    canUsePrivilegedUpdate,
    daemonReload: privilegedDaemonReload,
    restartService: privilegedRestartService,
} = require('../lib/privilegedUpdateHelper');
const { readProductVersion } = require('../lib/productVersion');
const { createConsoleDeployGraph } = require('../lib/consoleDeployGraph');
const { resolveChildPath, resolvePathUnderRoot, existsConfinedChild, removeConfinedChild } = require('../lib/safePath');
const { runConsoleNpmInstall } = require('../lib/consoleNpmInstall');
const {
    NON_CRITICAL_UPDATE_FAILURES,
    isNonCriticalUpdateFailure,
    isPhantomRepairFailure,
    splitUpdateFailures,
} = require('../lib/updateFailurePolicy');
const {
    assessServerBinaryDeployCapability,
    deployServerBinaryAtomic,
    resolveDeployScriptPath,
} = require('../lib/linuxServerBinaryDeploy');
const { resolveLastUpdateResultForDisplay } = require('../lib/updateResultStore');
const {
    resolveProjectRoot: resolveProjectRootFromConsole,
    ensureParentDirForFile,
    isUpdatePermissionError,
} = require('../lib/updateProjectRoot');

const GITHUB_OWNER  = process.env.UPDATE_GITHUB_OWNER  || 'UNITRONIX';
const GITHUB_REPO   = process.env.UPDATE_GITHUB_REPO   || 'BetterDesk';
const GITHUB_API    = 'https://api.github.com';

/** Update channel → GitHub branch mapping */
const UPDATE_CHANNELS = Object.freeze({
    stable: { id: 'stable', branch: 'main', label: 'Stable' },
    development: { id: 'development', branch: 'dev', label: 'Development' },
});

function getGithubBranch() {
    const branch = String(process.env.UPDATE_GITHUB_BRANCH || 'main').trim();
    return branch || 'main';
}

function branchToChannel(branch) {
    if (branch === 'dev') return 'development';
    return 'stable';
}

function getUpdateChannelInfo() {
    const branch = getGithubBranch();
    const channel = branchToChannel(branch);
    return {
        channel,
        branch,
        label: UPDATE_CHANNELS[channel]?.label || channel,
        owner: process.env.UPDATE_GITHUB_OWNER || GITHUB_OWNER,
        repo: process.env.UPDATE_GITHUB_REPO || GITHUB_REPO,
    };
}

const USER_AGENT    = `BetterDesk-Console/${config.appVersion}`;
const BACKUP_DIR    = path.join(config.dataDir, 'backups');
const SHA_FILE           = path.join(config.dataDir, '.update_sha');
const IMAGE_COMMIT_FILE  = path.join(__dirname, '..', '.image-commit'); // baked at image build
const ROOT_DIR           = path.join(__dirname, '..');          // web-nodejs/
const IS_WINDOWS         = process.platform === 'win32';

/**
 * Repo checkout: ROOT_DIR = web-nodejs/, project root = parent directory.
 * Flat Linux install: console files live directly under ROOT_DIR (e.g.
 * /opt/BetterDeskConsole) with betterdesk-server/ beside services/.
 * Windows default: C:\BetterDeskConsole — must NOT use drive root C:\ (#272).
 */
function resolveProjectRoot(rootDir = ROOT_DIR, opts) {
    return resolveProjectRootFromConsole(rootDir, opts);
}

const PROJECT_ROOT       = resolveProjectRoot();

function setUpdateChannel(channelId) {
    const channel = UPDATE_CHANNELS[channelId];
    if (!channel) {
        throw new Error(`Invalid update channel: ${channelId}`);
    }
    if (isImageBasedDockerDeployment()) {
        const tagHint = channelId === 'development' ? 'dev' : 'latest';
        const err = new Error(
            'Docker image deployments cannot switch update channel from the panel. '
            + `Set BETTERDESK_IMAGE_TAG=${tagHint} (or a release version) in compose/.env, then run: `
            + 'docker compose pull && docker compose up -d'
        );
        err.code = 'DOCKER_IMAGE_CHANNEL';
        throw err;
    }
    const envPath = path.join(ROOT_DIR, '.env');
    const previousBranch = getGithubBranch();
    const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const { upsertEnvKey } = require('../lib/envMerge');
    const updated = upsertEnvKey(existing, 'UPDATE_GITHUB_BRANCH', channel.branch);
    fs.writeFileSync(envPath, updated, { mode: 0o600 });
    process.env.UPDATE_GITHUB_BRANCH = channel.branch;
    return {
        channel: channel.id,
        branch: channel.branch,
        label: channel.label,
        previousBranch,
        previousChannel: branchToChannel(previousBranch),
    };
}

// Optional GitHub personal-access token  (60 req/h without, 5 000 with)
const GITHUB_TOKEN = process.env.UPDATE_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
const SERVER_WORKFLOW_FILE = '.github/workflows/release-server.yml';
const MAX_SERVER_BINARY_BYTES = 256 * 1024 * 1024;
const MAX_SERVER_MANIFEST_BYTES = 128 * 1024;
const MAX_SERVER_ARTIFACT_BYTES = 512 * 1024 * 1024;

/** @type {Map<string, { expires: number, data: unknown }>} */
const GH_GET_CACHE = new Map();
const GH_GET_CACHE_TTL_MS = Number(process.env.UPDATE_GITHUB_CACHE_MS) || 120_000;

// ---------- component definitions ----------
const COMPONENTS = {
    console: {
        prefix: 'web-nodejs/',
        label: 'Web Console',
        localRoot: ROOT_DIR,
        service: IS_WINDOWS ? 'BetterDeskConsole' : 'betterdesk-console',
        autoUpdate: true
    },
    server: {
        prefix: 'betterdesk-server/',
        label: 'Go Server',
        localRoot: path.join(PROJECT_ROOT, 'betterdesk-server'),
        service: IS_WINDOWS ? 'BetterDeskServer' : 'betterdesk-server',
        autoUpdate: true
    },
    agent: {
        prefix: 'betterdesk-agent/',
        label: 'Agent library',
        localRoot: null,
        service: IS_WINDOWS ? 'BetterDeskAgent' : 'betterdesk-agent',
        autoUpdate: false
    },
    supportAgent: {
        prefix: 'betterdesk-support-agent/',
        label: 'Support Agent (Generator)',
        localRoot: null,
        service: null,
        autoUpdate: false
    },
    scripts: {
        // matched by exact file names, not prefix
        files: [
            'install.sh', 'betterdesk.sh', 'betterdesk.ps1', 'betterdesk-docker.sh',
            'docker-compose.yml', 'docker-compose.single.yml', 'docker-compose.quick.yml',
            'docker-compose.quick.single.yml', 'docker-compose.quick.single.macvlan.yml',
            'Dockerfile', 'Dockerfile.server', 'Dockerfile.console',
            'docker-entrypoint.sh', 'docker/entrypoint.sh',
            'docker/server-entrypoint.sh', 'docker/console-entrypoint.sh',
            'docker/supervisord.conf', 'scripts/installer-protocol-check.js'
        ],
        label: 'Scripts & Docker',
        localRoot: PROJECT_ROOT,
        service: null,
        autoUpdate: true
    }
};

function canWriteDirOrParent(dirPath) {
    let current = path.resolve(dirPath);
    while (!fs.existsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) return false;
        current = parent;
    }
    try {
        fs.accessSync(current, fs.constants.W_OK);
        return true;
    } catch (_e) {
        return false;
    }
}

function resolveServerSourceRootForUpdate(preferredRoot = COMPONENTS.server.localRoot, opts = {}) {
    const fallbackRoot = opts.fallbackRoot || path.join(ROOT_DIR, 'betterdesk-server');
    const canWriteDir = opts.canWriteDir || canWriteDirOrParent;
    const preferred = path.resolve(preferredRoot);
    const fallback = path.resolve(fallbackRoot);

    if (IS_WINDOWS || canWriteDir(preferred) || preferred === fallback) {
        return preferred;
    }

    if (canWriteDir(fallback)) {
        console.warn(
            `[UPDATE] Server source root is not writable (${preferred}); using console-local source root ${fallback}`
        );
        return fallback;
    }

    return preferred;
}

// paths that are never downloaded during an update
// CRITICAL: anything that holds local runtime state MUST be excluded here.
// Overwriting live SQLite WAL/SHM files corrupts the database
// ("database disk image is malformed") — see issue #123.
const EXCLUDE_PATTERNS = [
    /^\.github\//,
    /^archive\//,
    /^docs\//,
    /^screenshots\//,
    /^dev_modules\//,
    /^tasks\//,
    /^sdks\//,
    /^bridges\//,
    /node_modules\//,
    /\.exe$/,
    /^betterdesk-server\/betterdesk-server/,      // compiled binaries
    // --- Runtime state (never overwrite, even if accidentally committed) ---
    /^web-nodejs\/data\//,                        // entire data dir is local state
    /(^|\/)data\//,                               // any nested data/ dir (server, agent)
    /\.sqlite3?$/,                                // .sqlite, .sqlite3
    /\.sqlite3?-(shm|wal|journal)$/,              // SQLite sidecar files
    /\.db$/,                                      // .db files (auth.db, etc.)
    /\.db-(shm|wal|journal)$/,                    // SQLite WAL/SHM/journal sidecars
    /(^|\/)\.session_secret$/,
    /(^|\/)\.update_sha$/,
    /(^|\/)\.api_key$/,
    /(^|\/)\.admin_credentials$/,
    /(^|\/)\.force_password_update$/,
    /(^|\/)\.env(\.|$)/                           // .env, .env.local, etc.
];

/** Paths in a commit diff that should refresh agent-source/ and rebuild bundles. */
const AGENT_REBUILD_TRIGGER_PATHS = [
    /^betterdesk-support-agent\//,
    /^betterdesk-agent\//,
    /^betterdesk-server\//,
    /^web-nodejs\/services\/agentBuildWorker\.js$/,
    /^web-nodejs\/services\/agentBundleConnection\.js$/,
    /^web-nodejs\/services\/agentBundleService\.js$/,
    /^web-nodejs\/routes\/generator\.routes\.js$/,
    /^scripts\/install-build-toolchain\.sh$/,
    /^betterdesk\.sh$/,
];

function shouldQueueAgentRebuild(changedData) {
    const all = Object.values(changedData?.grouped || {}).flat();
    return all.some((f) => AGENT_REBUILD_TRIGGER_PATHS.some((rx) => rx.test(f.path)));
}

/**
 * List all blob paths in the repo tree at ref (commit SHA or branch).
 */
async function ghListRepoBlobPaths(ref) {
    const data = await ghGet(
        `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/${encodeURIComponent(ref)}?recursive=1`
    );
    return (data.tree || [])
        .filter((entry) => entry.type === 'blob' && entry.path && !isExcluded(entry.path))
        .map((entry) => entry.path);
}

// ======================== HTTP Helpers ===================================

function githubApiError(statusCode, body, headers = {}) {
    const snippet = String(body || '').slice(0, 200);
    const rateLimited = (statusCode === 403 || statusCode === 429)
        && (/rate limit/i.test(body) || headers['x-ratelimit-remaining'] === '0');
    if (rateLimited) {
        const resetRaw = headers['x-ratelimit-reset'];
        const resetAt = resetRaw ? new Date(Number(resetRaw) * 1000).toISOString() : null;
        const hint = GITHUB_TOKEN
            ? 'GitHub API rate limit exceeded for the configured token.'
            : 'GitHub API rate limit exceeded for unauthenticated requests (60/hour). Set UPDATE_GITHUB_TOKEN in the console .env — a read-only Personal Access Token raises the limit to 5,000/hour.';
        const err = new Error(resetAt ? `${hint} Resets at ${resetAt}.` : hint);
        err.code = 'GITHUB_RATE_LIMIT';
        err.statusCode = statusCode;
        return err;
    }
    const err = new Error(`GitHub API ${statusCode}: ${snippet}`);
    err.statusCode = statusCode;
    return err;
}

function isGithubRateLimitError(err) {
    return !!(err && (err.code === 'GITHUB_RATE_LIMIT' || /rate limit exceeded/i.test(err.message || '')));
}

function ghGetCacheKey(urlPath) {
    const url = urlPath.startsWith('https://') ? new URL(urlPath) : new URL(urlPath, GITHUB_API);
    return url.pathname + url.search;
}

/**
 * HTTPS GET → parsed JSON. Follows one redirect.
 */
function ghGet(urlPath, { bypassCache = false } = {}) {
    const cacheKey = ghGetCacheKey(urlPath);
    if (!bypassCache && GH_GET_CACHE_TTL_MS > 0) {
        const cached = GH_GET_CACHE.get(cacheKey);
        if (cached && cached.expires > Date.now()) {
            return Promise.resolve(cached.data);
        }
    }

    return new Promise((resolve, reject) => {
        const url = urlPath.startsWith('https://') ? new URL(urlPath) : new URL(urlPath, GITHUB_API);
        const headers = { 'User-Agent': USER_AGENT, 'Accept': 'application/vnd.github+json' };
        if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;

        const req = https.get({ hostname: url.hostname, path: url.pathname + url.search, headers }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return ghGet(res.headers.location, { bypassCache }).then(resolve, reject);
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString();
                if (res.statusCode >= 400) {
                    return reject(githubApiError(res.statusCode, body, res.headers));
                }
                try {
                    const data = JSON.parse(body);
                    if (GH_GET_CACHE_TTL_MS > 0) {
                        GH_GET_CACHE.set(cacheKey, { expires: Date.now() + GH_GET_CACHE_TTL_MS, data });
                    }
                    resolve(data);
                } catch (_e) {
                    reject(new Error('Invalid JSON from GitHub API'));
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('GitHub API timeout')); });
    });
}

/**
 * Download raw file content from GitHub (binary-safe), with retry on rate limits.
 */
function isRetryableDownloadStatus(statusCode) {
    return statusCode === 429 || statusCode === 502 || statusCode === 503 || statusCode === 504;
}

function getDownloadRetryDelayMs(attempt) {
    return Math.min(1000 * Math.pow(2, Math.max(0, attempt - 1)), 15000);
}

function ghDownloadFileOnce(owner, repo, ref, filePath) {
    const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${filePath}`;
    return new Promise((resolve, reject) => {
        const headers = { 'User-Agent': USER_AGENT };
        if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;

        const follow = (target) => {
            const req = https.get(target, { headers }, (res) => {
                if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
                    return follow(res.headers.location);
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`Download failed (${res.statusCode}): ${filePath}`));
                }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
            });
            req.on('error', reject);
            req.setTimeout(30000, () => { req.destroy(); reject(new Error(`Download timeout: ${filePath}`)); });
        };
        follow(url);
    });
}

async function ghDownloadFile(owner, repo, ref, filePath, opts = {}) {
    const maxAttempts = Number(opts.maxAttempts) > 0 ? Number(opts.maxAttempts) : 4;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await ghDownloadFileOnce(owner, repo, ref, filePath);
        } catch (err) {
            lastErr = err;
            const match = /Download failed \((\d+)\)/.exec(err.message || '');
            const statusCode = match ? Number(match[1]) : 0;
            if (!isRetryableDownloadStatus(statusCode) || attempt >= maxAttempts) {
                throw err;
            }
            const delayMs = getDownloadRetryDelayMs(attempt);
            console.warn(
                `[UPDATE] Download retry ${attempt}/${maxAttempts} for ${filePath}`
                + ` after ${delayMs}ms (${err.message})`
            );
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
    throw lastErr;
}

// ======================== Docker image deployment ========================

function shasMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    return a.startsWith(b.slice(0, 7)) || b.startsWith(a.slice(0, 7));
}

function isDockerDeployment() {
    return !!config.isDocker;
}

/**
 * Pre-built GHCR images ship console/server binaries without a full Go tree.
 * In-app GitHub file download + compile must be disabled in that mode (#158).
 */
function isImageBasedDockerDeployment() {
    if (!isDockerDeployment()) return false;
    const mode = (process.env.BETTERDESK_UPDATE_MODE || '').trim().toLowerCase();
    if (mode === 'source') return false;
    if (mode === 'image') return true;
    return !fs.existsSync(path.join(PROJECT_ROOT, 'betterdesk-server', 'go.mod'));
}

function getImageEmbeddedSHA() {
    const fromEnv = (process.env.BETTERDESK_IMAGE_SHA || '').trim();
    if (/^[0-9a-f]{7,40}$/i.test(fromEnv) && fromEnv !== 'unknown') return fromEnv;
    try {
        if (fs.existsSync(IMAGE_COMMIT_FILE)) {
            const sha = fs.readFileSync(IMAGE_COMMIT_FILE, 'utf8').trim();
            if (/^[0-9a-f]{7,40}$/i.test(sha) && sha !== 'unknown') return sha;
        }
    } catch (_e) { /* unreadable marker */ }
    return null;
}

function getDockerLayout() {
    const layout = (process.env.BETTERDESK_DOCKER_LAYOUT || '').trim().toLowerCase();
    if (layout === 'single' || layout === 'split') return layout;
    return 'split';
}

function getDockerUpdateInstructions() {
    const tag = (process.env.BETTERDESK_IMAGE_TAG || 'latest').trim() || 'latest';
    const owner = (process.env.UPDATE_GITHUB_OWNER || GITHUB_OWNER).toLowerCase();
    const layout = getDockerLayout();
    const channelInfo = getUpdateChannelInfo();

    const base = {
        channelNote:
            'Panel “Update channel” does not change GHCR images. '
            + 'Use BETTERDESK_IMAGE_TAG=latest (stable) or BETTERDESK_IMAGE_TAG=dev (development), then pull/recreate.',
        suggestedTags: {
            stable: 'latest',
            development: 'dev',
        },
        currentTag: tag,
        updateChannel: channelInfo.channel,
    };

    if (layout === 'single') {
        return {
            ...base,
            summary: 'Pull and recreate the official all-in-one container image.',
            commands: [
                'docker compose pull',
                'docker compose up -d'
            ],
            images: [
                `ghcr.io/${owner}/betterdesk:${tag}`
            ],
            composeHint: 'docker-compose.quick.single.yml',
            layout: 'single'
        };
    }

    return {
        ...base,
        summary: 'Pull and recreate the published container images.',
        commands: [
            'docker compose pull',
            'docker compose up -d'
        ],
        images: [
            `ghcr.io/${owner}/betterdesk-console:${tag}`,
            `ghcr.io/${owner}/betterdesk-server:${tag}`
        ],
        composeHint: 'docker-compose.quick.yml',
        layout: 'split'
    };
}

function withDeploymentMeta(result) {
    const channelInfo = getUpdateChannelInfo();
    const base = {
        ...result,
        updateChannel: channelInfo.channel,
        githubBranch: channelInfo.branch,
        githubOwner: channelInfo.owner,
        githubRepo: channelInfo.repo,
    };
    const dockerImageMode = isImageBasedDockerDeployment();
    if (!dockerImageMode) {
        return { ...base, deploymentMode: 'native' };
    }
    return {
        ...base,
        deploymentMode: 'docker-image',
        dockerImageMode: true,
        imageSHA: getImageEmbeddedSHA(),
        dockerUpdate: getDockerUpdateInstructions(),
        inAppUpdateSupported: false
    };
}

/**
 * On Docker image startup, prefer the image-embedded commit over a stale
 * data/.update_sha left by a previous in-app update attempt (#158).
 */
function bootstrapDockerImageDeployment() {
    if (!isImageBasedDockerDeployment()) return;
    clearServerBinaryStale();
    const imageSha = getImageEmbeddedSHA();
    if (!imageSha) {
        console.warn('[UPDATE] Docker image mode: no embedded build SHA — pull a current GHCR image for accurate version checks');
        return;
    }
    let volumeSha = null;
    try {
        if (fs.existsSync(SHA_FILE)) volumeSha = fs.readFileSync(SHA_FILE, 'utf8').trim();
    } catch (_e) { /* ok */ }
    if (!shasMatch(volumeSha, imageSha)) {
        saveLocalSHA(imageSha);
        console.log(
            `[UPDATE] Docker: synced commit baseline to image (${imageSha.slice(0, 7)}`
            + `${volumeSha ? `, was ${volumeSha.slice(0, 7)}` : ''})`
        );
    }

    // External image update (docker compose pull) — drop stale in-app panel errors (#192).
    try {
        resolveLastUpdateResultForDisplay(config.dataDir, {
            rootDir: ROOT_DIR,
            localSHA: imageSha,
            remoteSHA: imageSha,
        });
    } catch (err) {
        console.warn(`[UPDATE] Could not clear stale update result: ${err.message}`);
    }
}

// ======================== SHA Tracking ===================================

function getLocalSHA() {
    if (isImageBasedDockerDeployment()) {
        const imageSha = getImageEmbeddedSHA();
        if (imageSha) return imageSha;
        // Legacy GHCR images without an embedded commit: ignore a polluted
        // data/.update_sha left by a previous in-app update attempt (#158).
        return null;
    }
    if (fs.existsSync(SHA_FILE)) {
        const sha = fs.readFileSync(SHA_FILE, 'utf8').trim();
        if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha;
    }
    // Fall back to git if available
    try {
        const sha = execSync('git rev-parse HEAD', { cwd: PROJECT_ROOT, timeout: 5000, stdio: 'pipe' })
            .toString().trim();
        if (/^[0-9a-f]{40}$/i.test(sha)) { saveLocalSHA(sha); return sha; }
    } catch (_e) { /* no git */ }
    return null;
}

function saveLocalSHA(sha) {
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return;
    fs.mkdirSync(path.dirname(SHA_FILE), { recursive: true });
    fs.writeFileSync(SHA_FILE, sha.trim() + '\n');
}

// ---- Server binary staleness marker ---------------------------------------
// When a server update applies the Go source files (including dependency
// bumps in go.mod/go.sum) but the binary cannot be rebuilt or deployed
// (Issue #154 classifies that step as non-critical so the SHA is still
// saved), the running binary is left behind — potentially missing the very
// security fix that triggered the update. We persist a marker so the panel
// can surface a clear "server binary is out of date" warning and offer an
// explicit rebuild, instead of silently reporting "up to date".
const SERVER_STALE_FILE = path.join(config.dataDir, '.server_binary_stale');

function markServerBinaryStale(info = {}) {
    try {
        fs.mkdirSync(path.dirname(SERVER_STALE_FILE), { recursive: true });
        fs.writeFileSync(SERVER_STALE_FILE, JSON.stringify({
            stale: true,
            reason: info.reason || 'unknown',
            detail: info.detail || null,
            sha: info.sha || null,
            since: new Date().toISOString()
        }, null, 2));
    } catch (_e) { /* best-effort marker */ }
}

function clearServerBinaryStale() {
    try { if (fs.existsSync(SERVER_STALE_FILE)) fs.unlinkSync(SERVER_STALE_FILE); } catch (_e) { /* ok */ }
}

function getServerBinaryStatus() {
    if (isImageBasedDockerDeployment()) {
        return { stale: false, dockerMode: true };
    }
    try {
        if (fs.existsSync(SERVER_STALE_FILE)) {
            const data = JSON.parse(fs.readFileSync(SERVER_STALE_FILE, 'utf8'));
            return {
                stale: true,
                reason: data.reason || null,
                detail: data.detail || null,
                sha: data.sha || null,
                since: data.since || null
            };
        }
    } catch (_e) { /* corrupt marker — treat as healthy */ }
    return { stale: false };
}

async function getRemoteHeadSHA() {
    const data = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits/${getGithubBranch()}`);
    return {
        sha: data.sha,
        message: (data.commit?.message || '').split('\n')[0],
        date: data.commit?.committer?.date || data.commit?.author?.date || '',
        author: data.commit?.author?.name || ''
    };
}

function getLocalVersion() {
    return readProductVersion({ rootDir: PROJECT_ROOT }) || config.appVersion;
}

// ======================== Classify ======================================

function classifyFile(filepath) {
    if (COMPONENTS.scripts.files.includes(filepath)) return 'scripts';
    for (const [name, comp] of Object.entries(COMPONENTS)) {
        if (comp.prefix && filepath.startsWith(comp.prefix)) return name;
    }
    return 'other';
}

function isExcluded(filepath) {
    return EXCLUDE_PATTERNS.some(rx => rx.test(filepath));
}

/**
 * Defense-in-depth: refuse to write to any path that maps to runtime state,
 * even if the file somehow slipped past EXCLUDE_PATTERNS earlier in the
 * pipeline. Prevents reintroducing issue #123 (corrupted SQLite WAL/SHM
 * after update overwrote live state files).
 *
 * @param {string} fullPath  Absolute destination path on disk.
 * @returns {boolean}
 */
function isProtectedRuntimePath(fullPath) {
    if (!fullPath) return false;
    const normalized = fullPath.replace(/\\/g, '/');
    if (/\/web-nodejs\/data(\/|$)/.test(normalized)) return true;
    if (/\/data\/(db_v2|address_book|peer)\b/.test(normalized)) return true;
    const base = path.basename(normalized);
    if (/\.sqlite3?$/.test(base)) return true;
    if (/\.sqlite3?-(shm|wal|journal)$/.test(base)) return true;
    if (/\.db$/.test(base)) return true;
    if (/\.db-(shm|wal|journal)$/.test(base)) return true;
    if (['.session_secret', '.update_sha', '.api_key', '.admin_credentials', '.force_password_update'].includes(base)) return true;
    if (/^\.env(\..+)?$/.test(base)) return true;
    return false;
}

// ======================== Server Build Support ===========================

let _updateInProgress = false;

/**
 * Run a shell command as a promise (non-blocking unlike execSync).
 * Prefer spawnPromise() when arguments are known — avoids shell interpolation.
 */
function execPromise(cmd, opts = {}) {
    return new Promise((resolve, reject) => {
        const { exec } = require('child_process');
        exec(cmd, { maxBuffer: 5 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
            if (err) {
                err.stderr = stderr;
                err.stdout = stdout;
                return reject(err);
            }
            resolve({ stdout, stderr });
        });
    });
}

function spawnPromise(command, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const { spawn } = require('child_process');
        const proc = spawn(command, args, { shell: false, ...opts });
        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (chunk) => { stdout += chunk; });
        proc.stderr?.on('data', (chunk) => { stderr += chunk; });
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code !== 0) {
                const err = new Error(`${command} exited with code ${code}`);
                err.stderr = stderr;
                err.stdout = stdout;
                return reject(err);
            }
            resolve({ stdout, stderr });
        });
    });
}

/**
 * Copy directory recursively.
 */
function copyDirRecursive(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

function getGoVersionNumber(versionOutput) {
    const text = String(versionOutput || '');
    const goMatch = text.match(/go(\d+(?:\.\d+){1,2})/i);
    if (goMatch) return goMatch[1];
    const genericMatch = text.match(/(\d+\.\d+(?:\.\d+)?)/);
    return genericMatch ? genericMatch[1] : null;
}

function quoteCommand(cmd) {
    if (!cmd) return '';
    return /\s/.test(cmd) ? `"${cmd}"` : cmd;
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function stripIncompatibleGoApiTLSArgs(value, compact = false) {
    const stripped = String(value || '')
        .replace(/[ \t]+-(?:tls-api|force-https)(?=(?:\s|$))/g, '');
    return compact ? stripped.replace(/[ \t]{2,}/g, ' ').trim() : stripped;
}

function readTextFilePrivileged(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        if (!IS_WINDOWS && (err.code === 'EACCES' || err.code === 'EPERM')) {
            const detail = isAllowedSystemdUnitPath(filePath)
                ? privilegedSystemdUnitHint()
                : 'Run the update preparation step as root.';
            throw new Error(`${err.message || err}. ${detail}`);
        }
        throw err;
    }
}

function writeTextFilePrivileged(filePath, content) {
    try {
        fs.writeFileSync(filePath, content);
    } catch (err) {
        if (!IS_WINDOWS && (err.code === 'EACCES' || err.code === 'EPERM')) {
            throw new Error(`${err.message || err}. ${privilegedSystemdUnitHint()}`);
        }
        throw err;
    }
}

function runPrivileged(command, options = {}) {
    void options;
    if (IS_WINDOWS) {
        throw new Error('Privileged Linux service operation requested on Windows');
    }
    if (command === 'systemctl daemon-reload') {
        return privilegedDaemonReload();
    }
    const restartMatch = /^systemctl restart '?([A-Za-z0-9_.@-]+)'?$/.exec(String(command || ''));
    if (restartMatch) {
        return privilegedRestartService(restartMatch[1]);
    }
    throw new Error('Unallowlisted privileged service command');
}

/**
 * Keep the Go REST API on plain HTTP even when signal/relay TLS is enabled.
 * RustDesk clients call the consolidated Go API (21121) over HTTP for heartbeat,
 * sysinfo, login and address-book endpoints; -tls-api breaks that contract.
 */
/**
 * Ensure MESH_ENABLED=Y is present in Go server service environment (one-time migration).
 */
const BILLING_ENV_KEYS = [
    'NTP_SERVERS',
    'BILLING_MAX_CLOCK_SKEW_MS',
    'BILLING_REQUIRE_SYNCED_CLOCK',
    'BILLING_TRUST_OS_NTP',
];

function parseEnvFileKeys(content, keys) {
    const out = {};
    if (!content || typeof content !== 'string') return out;
    const wanted = new Set(keys);
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        if (!wanted.has(key)) continue;
        out[key] = trimmed.slice(eq + 1).trim();
    }
    return out;
}

function mergeBillingEnvIntoWindowsServiceExtra(existingExtra, billingVars) {
    const lines = (existingExtra || '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    const map = new Map();
    for (const line of lines) {
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        map.set(line.slice(0, eq), line.slice(eq + 1));
    }
    let changed = false;
    for (const key of BILLING_ENV_KEYS) {
        if (billingVars[key] === undefined) continue;
        const nextVal = billingVars[key];
        if (map.get(key) !== nextVal) {
            map.set(key, nextVal);
            changed = true;
        }
    }
    if (!changed) return { text: existingExtra, changed: false };
    const merged = [...map.entries()].map(([k, v]) => `${k}=${v}`).join('\n');
    return { text: merged, changed: true };
}

function syncBillingEnvToWindowsGoServer() {
    const envPath = path.join(ROOT_DIR, '.env');
    if (!fs.existsSync(envPath)) return { changed: false };
    const billingVars = parseEnvFileKeys(fs.readFileSync(envPath, 'utf8'), BILLING_ENV_KEYS);
    if (!Object.keys(billingVars).length) return { changed: false };

    const serviceName = COMPONENTS.server.service;
    const serverEnvRaw = execSync(`nssm get "${serviceName}" AppEnvironmentExtra 2>nul`, {
        timeout: 5000,
        stdio: 'pipe'
    }).toString();
    const patch = mergeBillingEnvIntoWindowsServiceExtra(serverEnvRaw, billingVars);
    if (!patch.changed) return { changed: false };
    execFileSync('nssm', ['set', serviceName, 'AppEnvironmentExtra', patch.text], {
        timeout: 5000,
        stdio: 'pipe'
    });
    return { changed: true };
}

function ensureMeshEnabledInServiceEnv(envText) {
    if (!envText || typeof envText !== 'string') return { text: envText, changed: false };
    if (/^MESH_ENABLED=/m.test(envText)) return { text: envText, changed: false };
    const trimmed = envText.replace(/\r\n/g, '\n').replace(/\n+$/, '');
    const line = 'MESH_ENABLED=Y';
    return { text: trimmed ? `${trimmed}\n${line}` : line, changed: true };
}

/**
 * Ensure Go server systemd unit loads console .env (NTP / billing keys for timesync).
 */
function ensureGoServerEnvironmentFile(unitText, envFilePath) {
    if (!unitText || typeof unitText !== 'string') return { text: unitText, changed: false };
    if (/^EnvironmentFile=/m.test(unitText)) return { text: unitText, changed: false };
    const envLine = `EnvironmentFile=-${envFilePath}`;
    if (/^Environment=AUTH_DB_PATH=/m.test(unitText)) {
        return {
            text: unitText.replace(/^(Environment=AUTH_DB_PATH=.*)$/m, `${envLine}\n$1`),
            changed: true
        };
    }
    if (/^\[Service\]/m.test(unitText)) {
        return {
            text: unitText.replace(/^\[Service\]/m, `[Service]\n${envLine}`),
            changed: true
        };
    }
    return { text: `${envLine}\n${unitText}`, changed: true };
}

/**
 * Ensure Go signal/relay/API ports are not overridden by shared console .env (#219).
 * @param {string} unitText
 * @returns {{ text: string, changed: boolean }}
 */
function ensureGoServerSignalRelayPorts(unitText) {
    if (!unitText || typeof unitText !== 'string') {
        return { text: unitText, changed: false };
    }
    let text = unitText;
    let changed = false;
    const ports = [
        ['SIGNAL_PORT', '21116'],
        ['RELAY_PORT', '21117'],
        ['GO_API_PORT', '21114'],
    ];
    for (const [key, value] of ports) {
        const line = `Environment=${key}=${value}`;
        if (new RegExp(`^Environment=${key}=`, 'm').test(text)) {
            continue;
        }
        if (/^Environment=AUTH_DB_PATH=/m.test(text)) {
            text = text.replace(/^(Environment=AUTH_DB_PATH=.*)$/m, `$1\n${line}`);
        } else if (/^\[Service\]/m.test(text)) {
            text = text.replace(/^\[Service\]/m, `[Service]\n${line}`);
        } else {
            text = `${line}\n${text}`;
        }
        changed = true;
    }
    return { text, changed };
}

function sanitizeGoServerServiceConfig() {
    const result = { changed: false, changes: [], error: null, needsRestart: false };

    try {
        if (IS_WINDOWS) {
            const serviceName = COMPONENTS.server.service;
            const args = execSync(`nssm get "${serviceName}" AppParameters 2>nul`, {
                timeout: 5000,
                stdio: 'pipe'
            }).toString();
            const cleanArgs = stripIncompatibleGoApiTLSArgs(args, true);
            if (cleanArgs !== args.trim()) {
                execFileSync('nssm', ['set', serviceName, 'AppParameters', cleanArgs], {
                    timeout: 5000,
                    stdio: 'pipe'
                });
                result.changed = true;
                result.changes.push('removed Go API TLS flags from NSSM service parameters');
            }

            try {
                const serverEnvRaw = execSync(`nssm get "${serviceName}" AppEnvironmentExtra 2>nul`, {
                    timeout: 5000,
                    stdio: 'pipe'
                }).toString();
                const meshPatch = ensureMeshEnabledInServiceEnv(serverEnvRaw);
                if (meshPatch.changed) {
                    execFileSync('nssm', ['set', serviceName, 'AppEnvironmentExtra', meshPatch.text], {
                        timeout: 5000,
                        stdio: 'pipe'
                    });
                    result.changed = true;
                    result.needsRestart = true;
                    result.changes.push('set MESH_ENABLED=Y on BetterDesk Go Server NSSM environment');
                }
            } catch (_e) { /* server service may not exist */ }

            try {
                const billingPatch = syncBillingEnvToWindowsGoServer();
                if (billingPatch.changed) {
                    result.changed = true;
                    result.needsRestart = true;
                    result.changes.push('synced billing/NTP env to BetterDesk Go Server NSSM environment');
                }
            } catch (_e) { /* server service may not exist */ }

            try {
                const consoleService = COMPONENTS.console.service;
                const envRaw = execSync(`nssm get "${consoleService}" AppEnvironmentExtra 2>nul`, {
                    timeout: 5000,
                    stdio: 'pipe'
                }).toString();
                const cleanEnv = envRaw
                    .replace(/HBBS_API_URL=https:\/\/localhost/g, 'HBBS_API_URL=http://localhost')
                    .replace(/BETTERDESK_API_URL=https:\/\/localhost/g, 'BETTERDESK_API_URL=http://localhost');
                if (cleanEnv !== envRaw) {
                    execFileSync('nssm', ['set', consoleService, 'AppEnvironmentExtra', cleanEnv], {
                        timeout: 5000,
                        stdio: 'pipe'
                    });
                    result.changed = true;
                    result.changes.push('kept console Go API URLs on HTTP in NSSM environment');
                }
            } catch (_e) { /* console service may not exist */ }

            return result;
        }

        const serviceName = COMPONENTS.server.service;
        let fragmentPath = execSync(`systemctl show ${shellQuote(serviceName)} --property=FragmentPath --value 2>/dev/null || true`, {
            timeout: 5000,
            stdio: 'pipe'
        }).toString().trim();
        if (!fragmentPath) fragmentPath = `/etc/systemd/system/${serviceName}.service`;
        if (!fs.existsSync(fragmentPath)) return result;

        const original = readTextFilePrivileged(fragmentPath);
        let clean = stripIncompatibleGoApiTLSArgs(original)
            .replace(/Environment=HBBS_API_URL=https:\/\/localhost/g, 'Environment=HBBS_API_URL=http://localhost')
            .replace(/Environment=BETTERDESK_API_URL=https:\/\/localhost/g, 'Environment=BETTERDESK_API_URL=http://localhost');

        if (!/^Environment=MESH_ENABLED=/m.test(clean)) {
            const meshLine = 'Environment=MESH_ENABLED=Y';
            if (/^Environment=AUTH_DB_PATH=/m.test(clean)) {
                clean = clean.replace(/^(Environment=AUTH_DB_PATH=.*)$/m, `$1\n${meshLine}`);
            } else if (/^\[Service\]/m.test(clean)) {
                clean = clean.replace(/^\[Service\]/m, `[Service]\n${meshLine}`);
            } else {
                clean = `${meshLine}\n${clean}`;
            }
            result.needsRestart = true;
            result.changes.push('set MESH_ENABLED=Y in betterdesk-server systemd unit');
        }

        const consoleEnvPath = path.join(ROOT_DIR, '.env');
        const envFilePatch = ensureGoServerEnvironmentFile(clean, consoleEnvPath);
        if (envFilePatch.changed) {
            clean = envFilePatch.text;
            result.needsRestart = true;
            result.changes.push('set EnvironmentFile for console .env on betterdesk-server systemd unit');
        }

        const signalPortPatch = ensureGoServerSignalRelayPorts(clean);
        if (signalPortPatch.changed) {
            clean = signalPortPatch.text;
            result.needsRestart = true;
            result.changes.push('set SIGNAL_PORT=21116 / RELAY_PORT=21117 / GO_API_PORT=21114 on betterdesk-server systemd unit (#219)');
        }

        if (clean !== original) {
            writeTextFilePrivileged(fragmentPath, clean);
            runPrivileged('systemctl daemon-reload', { timeout: 10000, stdio: 'pipe' });
            result.changed = true;
            if (!result.changes.some((c) => c.includes('MESH_ENABLED'))) {
                result.changes.push('patched betterdesk-server systemd unit');
            }
        }
    } catch (err) {
        result.error = err.message || String(err);
    }

    return result;
}

function createGoInfo(version, binPath, source) {
    const versionNumber = getGoVersionNumber(version);
    const meetsMinimum = !!versionNumber && compareGoVersion(versionNumber, GO_MIN_VERSION) >= 0;
    return {
        available: true,
        version,
        versionNumber,
        binPath,
        source,
        meetsMinimum,
        needsUpgrade: !meetsMinimum
    };
}

function probeGoBinary(binPath, source) {
    if (!binPath) return null;
    try {
        const version = execFileSync(binPath, ['version'], {
            timeout: 10000,
            stdio: 'pipe'
        }).toString().trim();
        return createGoInfo(version, binPath, source);
    } catch (_e) {
        return null;
    }
}

/**
 * Check if Go toolchain is available.
 * Searches PATH first, then well-known install locations (snap, tarball,
 * Homebrew, vendored toolchain). Returns the absolute path so callers can
 * `exec` it even when the console process started without a complete PATH.
 *
 * @returns {{ available: boolean, version: string|null, binPath: string|null, source: string|null }}
 */
function checkGoAvailable() {
    const found = [];
    const seen = new Set();
    const addCandidate = (binPath, source) => {
        if (!binPath) return;
        const key = path.resolve(binPath === 'go' ? binPath : binPath.toLowerCase());
        if (seen.has(key)) return;
        seen.add(key);
        const info = probeGoBinary(binPath, source);
        if (info) found.push(info);
    };

    // 1. Try the regular PATH lookup first
    try {
        let binPath = null;
        try {
            binPath = execSync(IS_WINDOWS ? 'where go' : 'command -v go', {
                timeout: 5000, stdio: 'pipe'
            }).toString().split(/\r?\n/)[0].trim() || null;
        } catch (_e) { /* ok */ }
        addCandidate(binPath || 'go', 'path');
    } catch (_e) { /* fall through */ }

    // 2. Scan well-known install locations
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const localGoBin = path.join(config.dataDir, 'go-toolchain', 'go', 'bin', IS_WINDOWS ? 'go.exe' : 'go');
    const candidates = IS_WINDOWS
        ? [
            localGoBin,
            'C:\\Go\\bin\\go.exe',
            'C:\\Program Files\\Go\\bin\\go.exe',
            path.join(home, 'go', 'bin', 'go.exe'),
            path.join(home, '.local', 'go', 'bin', 'go.exe')
        ]
        : [
            localGoBin,
            '/usr/local/go/bin/go',
            '/snap/bin/go',
            '/opt/go/bin/go',
            '/usr/lib/go/bin/go',
            '/usr/lib/go-1.22/bin/go',
            '/usr/lib/go-1.23/bin/go',
            '/usr/lib/go-1.24/bin/go',
            path.join(home, 'go', 'bin', 'go'),
            path.join(home, '.local', 'go', 'bin', 'go'),
            '/opt/homebrew/bin/go',
            '/usr/local/bin/go'
        ];

    for (const candidate of candidates) {
        if (!candidate || !fs.existsSync(candidate)) continue;
        const source = candidate === localGoBin ? 'vendored' : 'system';
        addCandidate(candidate, source);
    }

    if (found.length) {
        found.sort((a, b) => {
            if (a.meetsMinimum !== b.meetsMinimum) return a.meetsMinimum ? -1 : 1;
            const versionDiff = compareGoVersion(b.versionNumber || b.version, a.versionNumber || a.version);
            if (versionDiff !== 0) return versionDiff;
            if (a.source === 'vendored' && b.source !== 'vendored') return -1;
            if (b.source === 'vendored' && a.source !== 'vendored') return 1;
            return 0;
        });
        return found[0];
    }

    return {
        available: false,
        version: null,
        versionNumber: null,
        binPath: null,
        source: null,
        meetsMinimum: false,
        needsUpgrade: false
    };
}

/**
 * Writable Go module/build cache under the console data directory.
 * The betterdesk system user often has HOME=/var/lib/betterdesk, which may be
 * root-owned or missing — Go then fails with "could not create module cache".
 */
function getGoCacheDirs() {
    const base = path.join(config.dataDir, 'go-cache');
    return {
        modCache: path.join(base, 'mod'),
        buildCache: path.join(base, 'build'),
    };
}

function ensureGoCacheDirs() {
    const { modCache, buildCache } = getGoCacheDirs();
    fs.mkdirSync(modCache, { recursive: true });
    fs.mkdirSync(buildCache, { recursive: true });
    return { modCache, buildCache };
}

/**
 * Wrap an exec environment so a manually located `go` binary is on PATH.
 */
function buildEnvWithGo(goBinPath) {
    const env = { ...process.env, CGO_ENABLED: '0' };
    if (goBinPath && goBinPath !== 'go') {
        const goBinDir = path.dirname(goBinPath);
        const sep = IS_WINDOWS ? ';' : ':';
        env.PATH = goBinDir + sep + (env.PATH || '');
    }
    try {
        const { modCache, buildCache } = ensureGoCacheDirs();
        env.GOMODCACHE = modCache;
        env.GOCACHE = buildCache;
        // betterdesk user's HOME is often /var/lib/betterdesk (root-owned).
        // Go also writes toolchain/sumdb state under $HOME/go — redirect HOME.
        env.HOME = config.dataDir;
    } catch (err) {
        console.warn(`[UPDATE] Could not prepare Go cache dirs: ${err.message}`);
    }
    return env;
}

/**
 * Detect the installed Go server binary path from the system service.
 * @returns {string|null}
 */
function detectServerBinaryPath() {
    // 1. Explicit environment variable
    if (process.env.BETTERDESK_SERVER_BINARY) {
        const p = process.env.BETTERDESK_SERVER_BINARY;
        if (fs.existsSync(p)) return p;
    }

    // 2. Read from systemd / NSSM service definition
    try {
        if (IS_WINDOWS) {
            const out = execSync('nssm get BetterDeskServer Application 2>nul', {
                timeout: 5000, stdio: 'pipe'
            }).toString().trim();
            if (out && fs.existsSync(out)) return out;
        } else {
            const raw = execSync(
                'systemctl show betterdesk-server --property=ExecStart --value 2>/dev/null || true',
                { timeout: 5000, stdio: 'pipe' }
            ).toString().trim();
            // ExecStart value may look like: /opt/rustdesk/betterdesk-server --flag ...
            const binPath = raw.replace(/^\{[^}]*path=/, '').replace(/\s*;.*$/, '').split(/\s+/)[0];
            if (binPath && fs.existsSync(binPath)) return binPath;
        }
    } catch (_e) { /* service may not be installed */ }

    // 3. Well-known installation paths
    const candidates = IS_WINDOWS
        ? [
            path.join(config.rustdeskDir || 'C:\\BetterDesk', 'betterdesk-server.exe'),
            'C:\\BetterDesk\\betterdesk-server.exe',
            'C:\\betterdesk\\betterdesk-server.exe',
            'C:\\Program Files\\BetterDesk\\betterdesk-server.exe',
            path.join(PROJECT_ROOT, 'betterdesk-server', 'betterdesk-server.exe'),
            path.join(ROOT_DIR, 'betterdesk-server', 'betterdesk-server.exe'),
        ]
        : [
            '/opt/rustdesk/betterdesk-server',
            '/opt/betterdesk/betterdesk-server',
            '/usr/local/bin/betterdesk-server',
            path.join(PROJECT_ROOT, 'betterdesk-server', 'betterdesk-server'),
            path.join(ROOT_DIR, 'betterdesk-server', 'betterdesk-server'),
        ];

    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

/**
 * Ensure full Go server source code is present locally.
 *
 * When `opts.force` is false (default) and go.mod already exists, the source is
 * assumed present and only the per-file compare diff is applied elsewhere.
 *
 * When `opts.force` is true, the COMPLETE source tree is (re)downloaded even if
 * go.mod exists. This is required because GitHub's compare API caps its `files`
 * array at 300 entries: for large updates the diff is truncated, so changed
 * dependency files (e.g. codec/ws.go, peer/map.go, auth/ldap.go, auth/oidc.go)
 * may never be downloaded. The result is an inconsistent on-disk source where
 * updated callers (signal/ws.go, api/server.go) reference symbols that are
 * missing from stale callees, breaking `go build` (issue #158). Forcing a full
 * sync before every compile/rebuild guarantees source consistency.
 *
 * @param {string} remoteSHA
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{ strategy: string, filesDownloaded: number }>}
 */
async function ensureServerSource(remoteSHA, opts = {}) {
    const serverDir = resolveServerSourceRootForUpdate();
    const goModPath = path.join(serverDir, 'go.mod');
    if (!opts.force && fs.existsSync(goModPath)) {
        return { strategy: 'incremental', filesDownloaded: 0 };
    }

    fs.mkdirSync(serverDir, { recursive: true });

    // --- Try git clone --depth=1, then pin it to the already verified SHA ---
    try {
        if (!/^[a-f0-9]{40}$/i.test(String(remoteSHA || ''))) {
            throw new Error('Refusing to clone an invalid remote commit SHA');
        }
        const tmpDir = path.join(config.dataDir, '_tmp_server_clone');
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });

        const repoUrl = GITHUB_TOKEN
            ? `https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git`
            : `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git`;

        execFileSync('git', [
            'clone', '--depth=1', '--single-branch', '--branch', getGithubBranch(), repoUrl, tmpDir
        ], { timeout: 120000, stdio: 'pipe' });
        const clonedSHA = String(execFileSync(
            'git', ['-C', tmpDir, 'rev-parse', 'HEAD'], { timeout: 10_000, encoding: 'utf8' }
        )).trim().toLowerCase();
        if (clonedSHA !== String(remoteSHA).toLowerCase()) {
            throw new Error(`Cloned commit ${clonedSHA} does not match requested ${remoteSHA}`);
        }

        const srcDir = path.join(tmpDir, 'betterdesk-server');
        if (fs.existsSync(srcDir)) {
            copyDirRecursive(srcDir, serverDir);
        }
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ok */ }
        return { strategy: 'git-clone', filesDownloaded: -1 };
    } catch (_e) {
        /* git not available or clone failed — fall through to API */
    }

    // --- Fallback: GitHub tree API + raw file downloads ---
    const tree = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/${remoteSHA}?recursive=1`);
    const serverFiles = (tree.tree || []).filter(t =>
        t.path.startsWith('betterdesk-server/') &&
        t.type === 'blob' &&
        !EXCLUDE_PATTERNS.some(rx => rx.test(t.path))
    );

    let downloaded = 0;
    for (const file of serverFiles) {
        try {
            const localPath = file.path.slice(COMPONENTS.server.prefix.length);
            const dest = path.join(serverDir, localPath);
            if (isProtectedRuntimePath(dest)) {
                console.warn(`[UPDATE] Refusing to overwrite runtime state file: ${file.path}`);
                continue;
            }
            const content = await ghDownloadFile(GITHUB_OWNER, GITHUB_REPO, remoteSHA, file.path);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, content);
            downloaded++;
        } catch (err) {
            console.error(`[UPDATE] Failed to download ${file.path}: ${err.message}`);
        }
    }

    return { strategy: 'api-download', filesDownloaded: downloaded };
}

/** GitHub compare API returns at most this many changed files (issue #158, #173). */
const GITHUB_COMPARE_FILE_LIMIT = 300;

function getConsoleDeployGraph() {
    const modPath = require.resolve('../lib/consoleDeployGraph');
    delete require.cache[modPath];
    const { createConsoleDeployGraph: createGraph } = require('../lib/consoleDeployGraph');
    return createGraph(ROOT_DIR);
}

const _consoleDeployGraph = createConsoleDeployGraph(ROOT_DIR);
const {
    isConsoleDeployLocalPath,
    resolveConsoleRequire,
    isResolvedByIndexModule,
    collectConsoleRequiredFiles,
    CONSOLE_INTEGRITY_SEEDS,
} = _consoleDeployGraph;

function isCompareLikelyTruncated(fileCount) {
    return Number(fileCount) >= GITHUB_COMPARE_FILE_LIMIT;
}

function resolveConsoleLocalPath(localPath) {
    return resolvePathUnderRoot(ROOT_DIR, localPath);
}

async function downloadConsoleFile(remoteSHA, localPath) {
    const repoPath = `${COMPONENTS.console.prefix}${localPath}`;
    const content = await ghDownloadFile(GITHUB_OWNER, GITHUB_REPO, remoteSHA, repoPath);
    const dest = resolveConsoleLocalPath(localPath);
    if (isProtectedRuntimePath(dest)) {
        throw new Error(`Refusing to write protected runtime path: ${localPath}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
    return dest;
}

/**
 * Download the full web-nodejs tree when the GitHub compare diff is truncated.
 * Mirrors ensureServerSource() for issue #158.
 */
async function ensureConsoleSource(remoteSHA, opts = {}) {
    const marker = path.join(ROOT_DIR, 'server.js');
    if (!opts.force && fs.existsSync(marker)) {
        return { strategy: 'incremental', filesDownloaded: 0, filesSkipped: 0 };
    }

    const tree = await ghGet(
        `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/${encodeURIComponent(remoteSHA)}?recursive=1`
    );
    if (tree.truncated) {
        console.warn('[UPDATE] GitHub tree listing was truncated — console full sync may be incomplete');
    }

    const prefix = COMPONENTS.console.prefix;
    const consolePaths = (tree.tree || [])
        .filter(entry => entry.type === 'blob' && entry.path && entry.path.startsWith(prefix))
        .map(entry => entry.path);

    let downloaded = 0;
    let skipped = 0;
    const failed = [];
    for (const repoPath of consolePaths) {
        const localPath = repoPath.slice(prefix.length);
        if (!isConsoleDeployLocalPath(localPath)) {
            skipped++;
            continue;
        }
        try {
            await downloadConsoleFile(remoteSHA, localPath);
            downloaded++;
        } catch (err) {
            failed.push({ path: repoPath, error: err.message });
            console.error(`[UPDATE] Failed to download ${repoPath}: ${err.message}`);
        }
    }

    return { strategy: 'full-tree', filesDownloaded: downloaded, filesSkipped: skipped, failed };
}

async function repairMissingConsoleFiles(remoteSHA, changedConsoleFiles = []) {
    const graph = getConsoleDeployGraph();
    const required = graph.collectConsoleRequiredFiles(changedConsoleFiles);
    const removedPaths = new Set(
        (changedConsoleFiles || [])
            .filter((f) => f?.status === 'removed' && f.localPath)
            .map((f) => f.localPath)
    );
    const repaired = [];
    const failed = [];
    for (const localPath of required) {
        if (removedPaths.has(localPath)) continue;
        if (!graph.isConsoleDeployLocalPath(localPath)) continue;
        if (graph.isResolvedByIndexModule(localPath)) continue;
        const dest = resolveConsoleLocalPath(localPath);
        if (fs.existsSync(dest)) continue;
        try {
            await downloadConsoleFile(remoteSHA, localPath);
            repaired.push(localPath);
        } catch (err) {
            const repoPath = `web-nodejs/${localPath}`;
            failed.push({
                path: repoPath,
                error: err.message,
                nonCritical: isPhantomRepairFailure(repoPath, ROOT_DIR),
            });
            console.error(`[UPDATE] Failed to repair ${localPath}: ${err.message}`);
        }
    }
    return { repaired, checked: required.size, failed };
}

/**
 * Build the Go server binary from local source.
 * Uses async exec to avoid blocking the Node.js event loop.
 *
 * @returns {Promise<{ success: boolean, binaryPath: string|null, error?: string, duration?: number }>}
 */
async function buildGoServer(preferredGoBinPath = null) {
    const serverDir = resolveServerSourceRootForUpdate();
    if (!fs.existsSync(path.join(serverDir, 'go.mod'))) {
        return { success: false, binaryPath: null, error: 'go.mod not found — server source incomplete' };
    }

    const goCheck = preferredGoBinPath
        ? (probeGoBinary(preferredGoBinPath, 'vendored') || checkGoAvailable())
        : checkGoAvailable();
    if (!goCheck.available) {
        return { success: false, binaryPath: null, error: 'Go toolchain not installed. Install Go from https://go.dev/dl/' };
    }
    if (!goCheck.meetsMinimum) {
        return {
            success: false,
            binaryPath: null,
            error: `Go ${GO_MIN_VERSION}+ is required. Found ${goCheck.version || 'unknown Go version'}.`
        };
    }

    const binaryName = IS_WINDOWS ? 'betterdesk-server.exe' : 'betterdesk-server';
    const outputPath = path.join(serverDir, binaryName);
    const start = Date.now();
    const goBin = goCheck.binPath || 'go';
    const buildEnv = buildEnvWithGo(goBin);

    try {
        await spawnPromise(goBin, ['mod', 'download'], {
            cwd: serverDir,
            timeout: 120000,
            env: buildEnv
        });

        const productVersion = readProductVersion({ rootDir: PROJECT_ROOT });
        const ldflags = `-s -w -X main.Version=${productVersion}`;
        await spawnPromise(
            goBin,
            ['build', '-trimpath', `-ldflags=${ldflags}`, '-o', binaryName, '.'],
            { cwd: serverDir, timeout: 600000, env: buildEnv }
        );

        if (!fs.existsSync(outputPath)) {
            return { success: false, binaryPath: null, error: 'Build completed but binary not found' };
        }

        return { success: true, binaryPath: outputPath, duration: Date.now() - start, goVersion: goCheck.version, goSource: goCheck.source };
    } catch (err) {
        const stderr = (err.stderr || '').toString().slice(0, 500);
        return { success: false, binaryPath: null, error: `Build failed: ${stderr || err.message}`.trim() };
    }
}

// ---------- Vendored Go toolchain bootstrap ----------

const GO_TOOLCHAIN_DIR = path.join(config.dataDir, 'go-toolchain');
// Minimum Go version required to build the server. Keep this aligned with the
// toolchain pinned in betterdesk-server/go.mod so builds do not trigger a
// hidden automatic toolchain download.
const GO_MIN_VERSION = '1.26.6';

function getToolchainKey() {
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    if (IS_WINDOWS) return { os: 'windows', arch, kind: 'archive' };
    if (process.platform === 'darwin') return { os: 'darwin', arch, kind: 'archive' };
    return { os: 'linux', arch, kind: 'archive' };
}

/**
 * Compare semantic-ish Go versions ("go1.23.4" or "1.23.4").
 * Returns >0 if a > b, 0 if equal, <0 if a < b.
 */
function compareGoVersion(a, b) {
    const norm = (v) => String(v || '').replace(/^go/, '').split(/[^\d]+/).map(Number).filter(Number.isFinite);
    const aa = norm(a), bb = norm(b);
    const len = Math.max(aa.length, bb.length);
    for (let i = 0; i < len; i++) {
        const x = aa[i] || 0, y = bb[i] || 0;
        if (x !== y) return x - y;
    }
    return 0;
}

function goBuildCacheDir() {
    return path.join(config.dataDir || path.join(__dirname, '..', 'data'), 'build-cache');
}

function goEnvForBin(binPath) {
    const goroot = path.dirname(path.dirname(binPath));
    const cacheRoot = goBuildCacheDir();
    const gocache = path.join(cacheRoot, 'gocache');
    const gomodcache = path.join(cacheRoot, 'gomod');
    try {
        fs.mkdirSync(gocache, { recursive: true });
        fs.mkdirSync(gomodcache, { recursive: true });
    } catch (_) { /* best effort */ }
    return {
        ...process.env,
        GOROOT: goroot,
        GO111MODULE: 'off',
        GOCACHE: gocache,
        GOMODCACHE: gomodcache,
        HOME: cacheRoot,
        PATH: `${path.dirname(binPath)}:${process.env.PATH || ''}`,
    };
}

/** Verify stdlib can compile — go list is unreliable on some Go installs. */
function goStdlibHealthy(binPath) {
    if (!binPath || !fs.existsSync(binPath)) return false;
    const goEnv = goEnvForBin(binPath);
    try {
        execFileSync(binPath, ['version'], { timeout: 10000, stdio: 'pipe', env: goEnv });
    } catch {
        return false;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-go-probe-'));
    try {
        const src = path.join(tmpDir, 'probe.go');
        const out = path.join(tmpDir, IS_WINDOWS ? 'probe.exe' : 'probe');
        fs.writeFileSync(src, 'package main\nimport _ "encoding/json"\nfunc main() {}\n');
        execFileSync(binPath, ['build', '-o', out, src], {
            timeout: 120000,
            stdio: 'pipe',
            env: goEnv,
            cwd: tmpDir,
        });
        return true;
    } catch {
        return false;
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ok */ }
    }
}

/**
 * Download a binary file via HTTPS (with up to 5 redirects).
 * @returns {Promise<Buffer>}
 */
function httpsDownload(url, redirects = 5) {
    return new Promise((resolve, reject) => {
        if (redirects < 0) return reject(new Error('Too many redirects'));
        const req = https.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return resolve(httpsDownload(res.headers.location, redirects - 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(600000, () => req.destroy(new Error('Download timeout')));
    });
}

/**
 * Resolve the latest stable Go release for this OS/arch by querying
 * https://go.dev/dl/?mode=json. Returns the asset metadata including
 * the canonical SHA-256 sum so the download can be verified securely.
 */
async function resolveGoRelease(opts = {}) {
    // The server's go.mod pins this toolchain. Callers may explicitly request
    // another compatible release for a separate build target.
    const maxVersion = opts.maxVersion || GO_MIN_VERSION;
    const key = getToolchainKey();
    const data = await httpsDownload('https://go.dev/dl/?mode=json');
    const releases = JSON.parse(data.toString('utf8'));
    if (!Array.isArray(releases) || !releases.length) {
        throw new Error('go.dev manifest empty');
    }
    // Pick the highest stable release that meets GO_MIN_VERSION (optionally capped).
    let stable = releases
        .filter(r => r.stable && compareGoVersion(r.version, GO_MIN_VERSION) >= 0);
    if (maxVersion) {
        stable = stable.filter(r => compareGoVersion(r.version, maxVersion) <= 0);
    }
    stable.sort((a, b) => compareGoVersion(b.version, a.version));
    const target = stable[0] || releases[0];
    const ext = key.os === 'windows' ? 'zip' : 'tar.gz';
    const file = (target.files || []).find(f =>
        f.os === key.os && f.arch === key.arch && f.kind === 'archive' && f.filename && f.filename.endsWith(ext)
    );
    if (!file || !file.sha256 || !file.filename) {
        throw new Error(`No Go ${target.version} archive for ${key.os}/${key.arch}`);
    }
    return {
        version: target.version,
        filename: file.filename,
        sha256: file.sha256,
        size: file.size || 0,
        url: `https://go.dev/dl/${file.filename}`
    };
}

/**
 * Install (or refresh) the Go toolchain into data/go-toolchain/.
 * Serialized — concurrent callers share one download/extract.
 */
let _installGoInFlight = null;

async function installGoToolchain(onProgress, opts = {}) {
    if (_installGoInFlight) return _installGoInFlight;
    _installGoInFlight = _installGoToolchainBody(onProgress, opts).finally(() => {
        _installGoInFlight = null;
    });
    return _installGoInFlight;
}

async function _installGoToolchainBody(onProgress, opts = {}) {
    const log = (phase, detail) => { try { (onProgress || (() => {}))(phase, detail); } catch (_e) { /* ignore */ } };
    const goRoot = path.join(GO_TOOLCHAIN_DIR, 'go');
    const goBin  = path.join(goRoot, 'bin', IS_WINDOWS ? 'go.exe' : 'go');

    fs.mkdirSync(GO_TOOLCHAIN_DIR, { recursive: true });

    let installed = null;
    if (fs.existsSync(goBin)) {
        installed = probeGoBinary(goBin, 'vendored');
        if (installed && !goStdlibHealthy(goBin)) {
            log('repairing', 'vendored Go stdlib incomplete — reinstalling');
            installed = null;
            try { fs.rmSync(goRoot, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
        }
    }

    let release;
    try {
        log('resolving', 'go.dev/dl');
        release = await resolveGoRelease(opts);
    } catch (err) {
        if (installed?.meetsMinimum && goStdlibHealthy(goBin)) {
            log('ready', installed.version);
            return { success: true, binPath: goBin, version: installed.version, reused: true };
        }
        return { success: false, binPath: null, version: null, error: `Cannot resolve Go release: ${err.message}` };
    }

    if (installed?.versionNumber && compareGoVersion(installed.versionNumber, release.version) >= 0) {
        if (goStdlibHealthy(goBin)) {
            log('ready', installed.version);
            return { success: true, binPath: goBin, version: installed.version, reused: true };
        }
        log('repairing', 'vendored Go stdlib incomplete — reinstalling');
        try { fs.rmSync(goRoot, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
        installed = null;
    }

    if (installed?.version) {
        log('updating', `${installed.versionNumber || installed.version} → ${release.version}`);
    }

    const archivePath = path.join(GO_TOOLCHAIN_DIR, release.filename);
    try {
        log('downloading', `${release.version} (${Math.round((release.size || 0) / 1048576)} MB)`);
        const buf = await httpsDownload(release.url);

        const crypto = require('crypto');
        const sha = crypto.createHash('sha256').update(buf).digest('hex');
        if (sha.toLowerCase() !== release.sha256.toLowerCase()) {
            return {
                success: false, binPath: null, version: null,
                error: `Go toolchain checksum mismatch (expected ${release.sha256.slice(0, 12)}…, got ${sha.slice(0, 12)}…)`
            };
        }
        fs.writeFileSync(archivePath, buf);
        log('extracting', release.filename);

        if (fs.existsSync(goRoot)) {
            try { fs.rmSync(goRoot, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
        }

        if (IS_WINDOWS) {
            await execPromise(
                `powershell -NoProfile -Command "Expand-Archive -Force -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${GO_TOOLCHAIN_DIR.replace(/'/g, "''")}'"`,
                { timeout: 300000 }
            );
        } else {
            await spawnPromise('tar', ['-xzf', archivePath, '-C', GO_TOOLCHAIN_DIR], { timeout: 300000 });
        }

        try { fs.unlinkSync(archivePath); } catch (_e) { /* ignore */ }

        if (!fs.existsSync(goBin)) {
            return { success: false, binPath: null, version: null, error: 'Extraction succeeded but go binary not found' };
        }
        if (!IS_WINDOWS) {
            try { fs.chmodSync(goBin, 0o755); } catch (_e) { /* ignore */ }
        }

        const v = execSync(`"${goBin}" version`, { timeout: 5000, stdio: 'pipe' }).toString().trim();
        if (!goStdlibHealthy(goBin)) {
            return { success: false, binPath: null, version: null, error: 'Go toolchain extracted but stdlib verification failed' };
        }
        log('ready', v);
        return { success: true, binPath: goBin, version: v };
    } catch (err) {
        try { if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath); } catch (_e) { /* ignore */ }
        return { success: false, binPath: null, version: null, error: err.message || String(err) };
    }
}

/** Report Linux privilege state without running repository code as root. */
function syncLinuxPanelUpdatePrivileges() {
    if (IS_WINDOWS) return { skipped: true, reason: 'not-linux' };

    try {
        if (typeof process.getuid === 'function' && process.getuid() !== 0) {
            return {
                skipped: true,
                reason: 'root maintenance required; the panel will not execute repository scripts via sudo',
            };
        }
        const modPath = require.resolve('../scripts/linux-ensure-console-user');
        delete require.cache[modPath];
        return require('../scripts/linux-ensure-console-user').ensureLinuxConsoleServiceUser();
    } catch (err) {
        console.warn(`[UPDATE] Linux privilege sync warning: ${err.message}`);
        return { error: err.message || String(err) };
    }
}

function deployServerBinaryPrivileged(builtBinaryPath, targetPath) {
    const scriptPath = resolveDeployScriptPath(ROOT_DIR);
    if (!fs.existsSync(scriptPath)) {
        return { success: false, error: 'Privileged deploy helper not installed' };
    }
    if (!IS_WINDOWS && typeof process.getuid === 'function' && process.getuid() !== 0) {
        return {
            success: false,
            error: 'Go server binary is root-owned. Run the release deploy helper once as root; '
                + 'the panel will not execute repository code through sudo.',
        };
    }

    const payload = JSON.stringify({
        source: builtBinaryPath,
        target: targetPath,
        consoleRoot: ROOT_DIR,
        projectRoot: PROJECT_ROOT,
        serverSourceRoot: resolveServerSourceRootForUpdate(),
    });

    try {
        const out = execSync(`${shellQuote(scriptPath)}`, {
            input: payload,
            timeout: 120000,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        const parsed = JSON.parse(out || '{}');
        if (!parsed.success) {
            return { success: false, error: parsed.error || 'Privileged deploy failed' };
        }
        return {
            success: true,
            backupPath: parsed.backupPath || null,
            method: 'privileged',
        };
    } catch (err) {
        let detail = err.message || String(err);
        if (err.stdout) {
            try {
                const parsed = JSON.parse(String(err.stdout).trim());
                if (parsed.error) detail = parsed.error;
            } catch (_e) { /* ignore */ }
        }
        return { success: false, error: detail };
    }
}

/**
 * Deploy the compiled binary to the service installation path.
 * Creates a timestamped backup of the existing binary first.
 *
 * @param {string} builtBinaryPath  Path to the newly compiled binary
 * @param {string} targetPath       Service binary path
 * @returns {{ success: boolean, backupPath?: string, error?: string, method?: string }}
 */
function deployServerBinary(builtBinaryPath, targetPath) {
    if (!builtBinaryPath || !fs.existsSync(builtBinaryPath)) {
        return { success: false, error: 'Compiled binary not found' };
    }
    if (!targetPath) {
        return { success: false, error: 'Target binary path not detected — set BETTERDESK_SERVER_BINARY env var' };
    }

    if (IS_WINDOWS) {
        let backupPath = null;
        if (fs.existsSync(targetPath)) {
            backupPath = targetPath + '.bak.' + Date.now();
            try {
                fs.copyFileSync(targetPath, backupPath);
            } catch (err) {
                return { success: false, error: `Backup failed: ${err.message}` };
            }
        }

        const stagingPath = targetPath + '.new.' + process.pid + '.' + Date.now();
        try {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.copyFileSync(builtBinaryPath, stagingPath);
            if (fs.existsSync(targetPath)) {
                const lockedAside = targetPath + '.old.' + Date.now();
                try { fs.renameSync(targetPath, lockedAside); } catch (_e) { /* may fail if not locked */ }
            }
            try {
                fs.renameSync(stagingPath, targetPath);
            } catch (renameErr) {
                try {
                    fs.copyFileSync(stagingPath, targetPath);
                    try { fs.unlinkSync(stagingPath); } catch (_e) { /* ok */ }
                } catch (copyErr) {
                    throw renameErr.code === 'ETXTBSY' ? renameErr : copyErr;
                }
            }
            return { success: true, backupPath, method: 'direct' };
        } catch (err) {
            try { if (fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath); } catch (_e) { /* ok */ }
            if (backupPath && fs.existsSync(backupPath) && !fs.existsSync(targetPath)) {
                try { fs.copyFileSync(backupPath, targetPath); } catch (_e) { /* critical */ }
            }
            return { success: false, error: `Deploy failed: ${err.message}` };
        }
    }

    const capability = assessServerBinaryDeployCapability(targetPath, { consoleRoot: ROOT_DIR });
    if (capability.ready && capability.method === 'privileged') {
        return deployServerBinaryPrivileged(builtBinaryPath, targetPath);
    }

    const direct = deployServerBinaryAtomic(builtBinaryPath, targetPath);
    if (direct.success) {
        return { ...direct, method: 'direct' };
    }

    if (/EACCES|EPERM|permission denied/i.test(direct.error || '')) {
        const privileged = deployServerBinaryPrivileged(builtBinaryPath, targetPath);
        if (privileged.success) return privileged;
    }

    return direct;
}

/**
 * Determine the expected binary names for this platform+arch.
 * @returns {{ goos: string, goarch: string, suffix: string, assetName: string, binaryName: string }}
 */
function getServerBinaryTarget() {
    const goarch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const goos = IS_WINDOWS ? 'windows' : (process.platform === 'darwin' ? 'darwin' : 'linux');
    const suffix = `${goos}-${goarch}${goos === 'windows' ? '.exe' : ''}`;
    const assetName = `betterdesk-server-${suffix}`;
    return {
        goos,
        goarch,
        suffix,
        assetName,
        binaryName: IS_WINDOWS ? 'betterdesk-server.exe' : 'betterdesk-server',
    };
}

function getReleaseBinaryName() {
    return getServerBinaryTarget().assetName;
}

function isAllowedGithubDownloadHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    return host === 'api.github.com'
        || host === 'github.com'
        || host === 'raw.githubusercontent.com'
        || host === 'objects.githubusercontent.com'
        || host === 'release-assets.githubusercontent.com'
        || host.endsWith('.blob.core.windows.net');
}

function downloadGithubBuffer(downloadUrl, { maxBytes = MAX_SERVER_BINARY_BYTES, accept = 'application/octet-stream' } = {}) {
    if (!downloadUrl || typeof downloadUrl !== 'string') {
        return Promise.reject(new Error('Invalid GitHub download URL'));
    }

    const follow = (target, redirects = 0) => {
        if (redirects > 5) return Promise.reject(new Error('Too many GitHub download redirects'));
        let url;
        try {
            url = new URL(target);
        } catch (_e) {
            return Promise.reject(new Error('Invalid GitHub download URL'));
        }
        if (url.protocol !== 'https:' || !isAllowedGithubDownloadHost(url.hostname)) {
            return Promise.reject(new Error(`Blocked GitHub download host: ${url.hostname}`));
        }

        return new Promise((resolve, reject) => {
            const headers = { 'User-Agent': USER_AGENT, Accept: accept };
            // Signed artifact redirects do not need the API token. Never send
            // the token to a storage host.
            if (GITHUB_TOKEN && url.hostname.toLowerCase() === 'api.github.com') {
                headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
            }
            const req = https.get({
                hostname: url.hostname,
                path: url.pathname + url.search,
                headers,
            }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return follow(new URL(res.headers.location, url).toString(), redirects + 1)
                        .then(resolve, reject);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error(`GitHub download failed: HTTP ${res.statusCode}`));
                }

                const declaredSize = Number(res.headers['content-length'] || 0);
                if (declaredSize > maxBytes) {
                    res.resume();
                    return reject(new Error(`GitHub download exceeds ${maxBytes} byte limit`));
                }
                const chunks = [];
                let received = 0;
                res.on('data', (chunk) => {
                    received += chunk.length;
                    if (received > maxBytes) {
                        req.destroy(new Error(`GitHub download exceeds ${maxBytes} byte limit`));
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
            });
            req.on('error', reject);
            req.setTimeout(120000, () => {
                req.destroy(new Error('GitHub download timeout (120s)'));
            });
        });
    };

    return follow(downloadUrl);
}

function commitsMatch(expected, actual) {
    const left = String(expected || '').toLowerCase();
    const right = String(actual || '').toLowerCase();
    return /^[0-9a-f]{7,40}$/.test(left)
        && /^[0-9a-f]{7,40}$/.test(right)
        && (left === right || left.startsWith(right) || right.startsWith(left));
}

function validateServerBinaryManifest(manifest, binaryData, expected) {
    if (!manifest || typeof manifest !== 'object') {
        return 'Server binary manifest is missing or invalid';
    }
    if (!commitsMatch(expected.remoteSHA, manifest.commit)) {
        return `Server binary commit mismatch (expected ${expected.remoteSHA}, got ${manifest.commit || 'missing'})`;
    }
    if (manifest.goos !== expected.goos || manifest.goarch !== expected.goarch) {
        return `Server binary target mismatch (expected ${expected.goos}/${expected.goarch})`;
    }
    if (manifest.asset !== expected.assetName) {
        return `Server binary asset mismatch (expected ${expected.assetName})`;
    }
    if (!Number.isSafeInteger(Number(manifest.size)) || Number(manifest.size) !== binaryData.length) {
        return 'Server binary size does not match its manifest';
    }
    if (!/^[0-9a-f]{64}$/i.test(String(manifest.sha256 || ''))) {
        return 'Server binary manifest has no valid SHA-256';
    }
    const actualSha = crypto.createHash('sha256').update(binaryData).digest('hex');
    if (actualSha.toLowerCase() !== String(manifest.sha256).toLowerCase()) {
        return 'Server binary SHA-256 does not match its manifest';
    }
    return null;
}

function getSafeZipEntryName(entryName) {
    const normalized = String(entryName || '').replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)) return null;
    const parts = normalized.split('/');
    if (parts.some((part) => part === '..' || part === '')) return null;
    return normalized;
}

async function findSuccessfulServerWorkflowRun(remoteSHA) {
    if (!/^[0-9a-f]{7,40}$/i.test(String(remoteSHA || ''))) return null;
    const data = await ghGet(
        `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/release-server.yml/runs`
            + `?head_sha=${encodeURIComponent(remoteSHA)}&per_page=20`,
        { bypassCache: true }
    );
    const runs = (data.workflow_runs || [])
        .filter((run) => commitsMatch(remoteSHA, run.head_sha)
            && run.status === 'completed'
            && run.conclusion === 'success')
        .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
    for (const run of runs) {
        const jobsData = await ghGet(
            `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${encodeURIComponent(run.id)}/jobs?per_page=100`,
            { bypassCache: true }
        );
        const jobs = jobsData.jobs || [];
        const buildJobs = jobs.filter((job) => /^build(\s|\()/i.test(job.name || ''));
        if (buildJobs.length > 0) {
            const missingTarget = ['linux-amd64', 'linux-arm64', 'windows-amd64.exe']
                .find((suffix) => !buildJobs.some((job) => (job.name || '').includes(suffix)));
            if (missingTarget) continue;
            if (buildJobs.some((job) => job.conclusion !== 'success')) continue;
        }
        return { ...run, jobs };
    }
    return null;
}

async function findWorkflowServerArtifact(remoteSHA, target) {
    const run = await findSuccessfulServerWorkflowRun(remoteSHA);
    if (!run) return null;
    const artifactsData = await ghGet(
        `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runs/${encodeURIComponent(run.id)}/artifacts?per_page=100`,
        { bypassCache: true }
    );
    const artifactName = `betterdesk-server-${target.suffix}`;
    const artifact = (artifactsData.artifacts || []).find((item) =>
        item.name === artifactName && !item.expired && Number(item.size_in_bytes || 0) > 0
    );
    if (!artifact) return null;
    return {
        available: true,
        exact: true,
        source: 'github-actions',
        downloadUrl: artifact.archive_download_url,
        archive: true,
        artifactName,
        artifactId: artifact.id,
        runId: run.id,
        runUrl: run.html_url || null,
        releaseName: run.display_title || run.name || null,
        releaseTag: null,
        assetSize: artifact.size_in_bytes || null,
        commit: run.head_sha,
    };
}

async function findExactReleaseAsset(remoteSHA, target) {
    const releases = await ghGet(
        `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=100`,
        { bypassCache: true }
    );
    for (const release of releases || []) {
        const binary = (release.assets || []).find((asset) => asset.name === target.assetName);
        const manifestAsset = (release.assets || []).find(
            (asset) => asset.name === `${target.assetName}.manifest.json`
        );
        if (!binary || !manifestAsset) continue;
        try {
            const manifestData = await downloadGithubBuffer(manifestAsset.browser_download_url, {
                maxBytes: MAX_SERVER_MANIFEST_BYTES,
                accept: 'application/octet-stream',
            });
            const manifest = JSON.parse(manifestData.toString('utf8'));
            if (commitsMatch(remoteSHA, manifest.commit)
                && manifest.goos === target.goos
                && manifest.goarch === target.goarch
                && manifest.asset === target.assetName) {
                return {
                    available: true,
                    exact: true,
                    source: 'release',
                    downloadUrl: binary.browser_download_url,
                    manifestUrl: manifestAsset.browser_download_url,
                    manifest,
                    archive: false,
                    artifactName: null,
                    artifactId: null,
                    runId: null,
                    runUrl: null,
                    releaseName: release.name || release.tag_name,
                    releaseTag: release.tag_name,
                    assetSize: binary.size || null,
                    commit: manifest.commit,
                };
            }
        } catch (_e) {
            // Ignore malformed or unavailable release candidates.
        }
    }
    return null;
}

/**
 * Check if a pre-built binary is available on GitHub Releases.
 * For an update SHA, prefer an exact successful Actions run and then an
 * exact Release asset. Without a SHA, return only an informational latest
 * release candidate for the Settings diagnostics.
 *
 * @returns {Promise<object>}
 */
async function checkPrebuiltAvailable(remoteSHA = null) {
    const target = getServerBinaryTarget();
    const unavailable = {
        available: false,
        exact: false,
        source: null,
        downloadUrl: null,
        manifestUrl: null,
        archive: false,
        artifactName: null,
        artifactId: null,
        runId: null,
        runUrl: null,
        releaseName: null,
        releaseTag: null,
        assetSize: null,
        commit: null,
        reason: null,
        ...target,
    };
    try {
        if (remoteSHA) {
            try {
                const workflowArtifact = await findWorkflowServerArtifact(remoteSHA, target);
                if (workflowArtifact) return { ...unavailable, ...workflowArtifact, ...target };
            } catch (err) {
                unavailable.reason = `GitHub Actions lookup failed: ${err.message}`;
            }
            try {
                const releaseAsset = await findExactReleaseAsset(remoteSHA, target);
                if (releaseAsset) return { ...unavailable, ...releaseAsset, ...target };
            } catch (err) {
                unavailable.reason = unavailable.reason
                    || `GitHub Release lookup failed: ${err.message}`;
            }
            return {
                ...unavailable,
                reason: unavailable.reason || 'No verified binary was built for this commit',
            };
        }

        const release = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`);
        if (!release || !release.assets || !release.assets.length) {
            return { ...unavailable, reason: 'No GitHub Release is available' };
        }

        const asset = release.assets.find((item) => item.name === target.assetName);

        if (asset) {
            return {
                ...unavailable,
                available: true,
                exact: false,
                source: 'release',
                downloadUrl: asset.browser_download_url,
                releaseName: release.name || release.tag_name,
                releaseTag: release.tag_name,
                assetSize: asset.size || null,
                reason: 'Latest release candidate; exact commit is checked during install',
            };
        }

        return {
            ...unavailable,
            releaseName: release.name,
            releaseTag: release.tag_name,
            reason: `Release has no ${target.assetName} asset`,
        };
    } catch (_e) {
        return { ...unavailable, reason: 'GitHub Release lookup failed' };
    }
}

/**
 * Download a pre-built binary from a URL.
 * Validates the download is non-empty and reasonable size.
 *
 * @param {string} downloadUrl
 * @param {object} expected
 * @returns {Promise<{ success: boolean, binaryPath: string|null, error?: string, size?: number }>}
 */
async function downloadPrebuiltBinary(downloadUrl, expected = {}) {
    const target = getServerBinaryTarget();
    const metadata = { ...target, ...expected };
    const serverDir = resolveServerSourceRootForUpdate();
    fs.mkdirSync(serverDir, { recursive: true });

    try {
        const payload = await downloadGithubBuffer(downloadUrl, {
            maxBytes: metadata.archive ? MAX_SERVER_ARTIFACT_BYTES : MAX_SERVER_BINARY_BYTES,
        });
        let binaryData = payload;
        let manifest = metadata.manifest || null;

        if (metadata.archive) {
            const zip = new AdmZip(payload);
            const entries = zip.getEntries();
            for (const entry of entries) {
                if (!getSafeZipEntryName(entry.entryName)) {
                    return { success: false, binaryPath: null, error: 'Unsafe path in server artifact ZIP' };
                }
            }
            const binaryEntry = entries.find((entry) =>
                !entry.isDirectory && getSafeZipEntryName(entry.entryName)
                    .split('/').pop() === metadata.assetName
            );
            const manifestEntry = entries.find((entry) =>
                !entry.isDirectory && getSafeZipEntryName(entry.entryName)
                    .split('/').pop() === `${metadata.assetName}.manifest.json`
            );
            if (!binaryEntry || !manifestEntry) {
                return { success: false, binaryPath: null, error: 'Server artifact is missing binary or manifest' };
            }
            binaryData = binaryEntry.getData();
            try {
                manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
            } catch (_e) {
                return { success: false, binaryPath: null, error: 'Server artifact manifest is invalid JSON' };
            }
        } else if (metadata.manifestUrl && !manifest) {
            const manifestData = await downloadGithubBuffer(metadata.manifestUrl, {
                maxBytes: MAX_SERVER_MANIFEST_BYTES,
            });
            manifest = JSON.parse(manifestData.toString('utf8'));
        }

        if (binaryData.length < 1024 * 1024) {
            return { success: false, binaryPath: null, error: `Downloaded file too small (${binaryData.length} bytes) — likely not a valid binary` };
        }
        const manifestError = validateServerBinaryManifest(manifest, binaryData, metadata);
        if (manifestError) {
            return { success: false, binaryPath: null, error: manifestError };
        }

        const outputPath = path.join(serverDir, metadata.binaryName);
        const temporaryPath = `${outputPath}.download-${process.pid}-${Date.now()}`;
        fs.writeFileSync(temporaryPath, binaryData, { mode: 0o755 });
        if (!IS_WINDOWS) {
            try { fs.chmodSync(temporaryPath, 0o755); } catch (_e) { /* ok */ }
        }
        try {
            fs.renameSync(temporaryPath, outputPath);
        } catch (renameErr) {
            try { fs.rmSync(temporaryPath, { force: true }); } catch (_e) { /* best effort */ }
            throw renameErr;
        }

        return {
            success: true,
            binaryPath: outputPath,
            size: binaryData.length,
            sha256: manifest.sha256,
            commit: manifest.commit,
        };
    } catch (err) {
        return { success: false, binaryPath: null, error: `Binary download failed: ${err.message}` };
    }
}

/**
 * Get server update readiness info for the UI.
 * Returns information about all available update strategies.
 */
function getServerUpdateInfo() {
    const goInfo = checkGoAvailable();
    const binaryPath = detectServerBinaryPath();
    const sourceRoot = resolveServerSourceRootForUpdate();
    const sourcePresent = fs.existsSync(path.join(sourceRoot || '', 'go.mod'));
    const vendoredGoPath = path.join(GO_TOOLCHAIN_DIR, 'go', 'bin', IS_WINDOWS ? 'go.exe' : 'go');
    const vendoredGoInstalled = fs.existsSync(vendoredGoPath);

    return {
        goAvailable: goInfo.available,
        goVersion: goInfo.version,
        goVersionNumber: goInfo.versionNumber,
        goPath: goInfo.binPath,
        goSource: goInfo.source,           // 'path' | 'system' | 'vendored' | null
        goMeetsMinimum: goInfo.meetsMinimum,
        goNeedsUpgrade: goInfo.needsUpgrade,
        goMinimumVersion: GO_MIN_VERSION,
        vendoredGoInstalled,
        canInstallGo: true,                // toolchain bootstrap is always available
        binaryPath,
        sourcePresent,
        canAutoUpdate: true,
        // Platform info for binary matching
        platform: IS_WINDOWS ? 'windows' : process.platform,
        arch: process.arch === 'arm64' ? 'arm64' : 'amd64',
        expectedBinary: getReleaseBinaryName()
    };
}

/**
 * Check pre-built binary availability (async — called separately from getServerUpdateInfo).
 */
async function getPrebuiltInfo(remoteSHA = null) {
    return checkPrebuiltAvailable(remoteSHA);
}

function getAutoUpdateComponents(changedData) {
    const grouped = changedData?.grouped || {};
    return ['console', 'scripts', 'server'].filter(component => grouped[component]?.length > 0);
}

// ======================== Public API ====================================

/**
 * Check for updates by comparing local commit SHA with remote HEAD.
 */
async function checkForUpdates() {
    bootstrapDockerImageDeployment();

    const localVersion = getLocalVersion();
    const localSHA = getLocalSHA();
    const remote = await getRemoteHeadSHA();
    const dockerImageMode = isImageBasedDockerDeployment();

    // No baseline yet → establish one (native installs only)
    if (!localSHA) {
        if (dockerImageMode) {
            return withDeploymentMeta({
                localVersion,
                localSHA: null,
                remoteSHA: remote.sha,
                updateAvailable: false,
                commitsBehind: 0,
                latestMessage: remote.message,
                latestDate: remote.date,
                latestAuthor: remote.author,
                components: {},
                dockerShaUnknown: true
            });
        }
        saveLocalSHA(remote.sha);
        return withDeploymentMeta({
            localVersion,
            localSHA: remote.sha,
            remoteSHA: remote.sha,
            updateAvailable: false,
            baselineEstablished: true,
            commitsBehind: 0,
            latestMessage: remote.message,
            latestDate: remote.date,
            latestAuthor: remote.author,
            components: {}
        });
    }

    // Already at HEAD
    if (localSHA.startsWith(remote.sha.slice(0, 7)) || remote.sha.startsWith(localSHA.slice(0, 7)) || localSHA === remote.sha) {
        try {
            resolveLastUpdateResultForDisplay(config.dataDir, {
                rootDir: ROOT_DIR,
                localSHA,
                remoteSHA: remote.sha,
            });
        } catch (_) { /* best-effort stale banner cleanup */ }

        return withDeploymentMeta({
            localVersion,
            localSHA,
            remoteSHA: remote.sha,
            updateAvailable: false,
            commitsBehind: 0,
            latestMessage: remote.message,
            latestDate: remote.date,
            latestAuthor: remote.author,
            components: {}
        });
    }

    // Compare
    let compare;
    try {
        compare = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/compare/${localSHA}...${remote.sha}`);
    } catch (err) {
        // SHA may have been force-pushed away
        return withDeploymentMeta({
            localVersion,
            localSHA,
            remoteSHA: remote.sha,
            updateAvailable: true,
            commitsBehind: -1,
            latestMessage: remote.message,
            latestDate: remote.date,
            latestAuthor: remote.author,
            components: {},
            compareError: err.message
        });
    }

    const files = (compare.files || []).filter(f => !isExcluded(f.filename));
    const componentSummary = {};
    for (const file of files) {
        const comp = classifyFile(file.filename);
        if (!componentSummary[comp]) {
            componentSummary[comp] = {
                changed: true,
                fileCount: 0,
                label: COMPONENTS[comp]?.label || 'Other',
                autoUpdate: COMPONENTS[comp]?.autoUpdate ?? false
            };
        }
        componentSummary[comp].fileCount++;
    }

    return withDeploymentMeta({
        localVersion,
        localSHA,
        remoteSHA: remote.sha,
        updateAvailable: files.length > 0,
        commitsBehind: compare.total_commits || (compare.commits || []).length,
        latestMessage: remote.message,
        latestDate: remote.date,
        latestAuthor: remote.author,
        components: componentSummary
    });
}

/**
 * Get detailed list of changed files between local SHA and the given remote SHA.
 * Returns files grouped by component plus a flat list and recent commits.
 */
async function getChangedFiles(remoteSHA) {
    const localSHA = getLocalSHA();
    if (!localSHA) throw new Error('No local baseline SHA — run update check first');
    if (!/^[0-9a-f]{7,40}$/i.test(remoteSHA)) throw new Error('Invalid remote SHA');

    const compare = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/compare/${localSHA}...${remoteSHA}`);
    const files = (compare.files || []).filter(f => !isExcluded(f.filename));

    const grouped = { console: [], server: [], agent: [], supportAgent: [], scripts: [], other: [] };

    for (const f of files) {
        const comp = classifyFile(f.filename);
        const entry = {
            path: f.filename,
            status: f.status || 'modified',
            sha: f.sha || '',
            component: comp
        };
        if (comp === 'console') {
            entry.localPath = f.filename.slice(COMPONENTS.console.prefix.length);
        } else if (comp === 'scripts') {
            entry.localPath = f.filename;
        }
        (grouped[comp] || grouped.other).push(entry);
    }

    return {
        files: files.map(f => ({
            path: f.filename,
            status: f.status || 'modified',
            component: classifyFile(f.filename)
        })),
        grouped,
        totalFiles: files.length,
        compareTruncated: isCompareLikelyTruncated(files.length),
        commitsBehind: compare.total_commits || (compare.commits || []).length,
        commits: (compare.commits || []).slice(-30).reverse().map(c => ({
            sha: c.sha?.slice(0, 7),
            message: (c.commit?.message || '').split('\n')[0],
            date: c.commit?.committer?.date || '',
            author: c.commit?.author?.name || ''
        }))
    };
}

/**
 * Create a pre-update backup of console files that will be changed.
 */
async function createPreUpdateBackup(allFiles, opts = {}) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupName = `pre-update-${ts}`;
    const backupPath = resolveChildPath(path.resolve(BACKUP_DIR), backupName);
    fs.mkdirSync(backupPath, { recursive: true });

    const localVersion = getLocalVersion();
    const localSHA = getLocalSHA();
    let backedUp = 0;
    const backedUpFiles = [];
    const removeOnRestore = [];

    const copyFileToBackup = (src, relativePath) => {
        if (!relativePath || isProtectedRuntimePath(src)) return false;
        const dest = resolvePathUnderRoot(backupPath, relativePath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        backedUpFiles.push(relativePath.replace(/\\/g, '/'));
        backedUp++;
        return true;
    };

    for (const file of allFiles) {
        if (!file.localPath) continue;
        const sourceRoot = file.component === 'console'
            ? ROOT_DIR
            : file.component === 'scripts'
                ? PROJECT_ROOT
                : file.component === 'server'
                    ? resolveServerSourceRootForUpdate()
                    : null;
        if (!sourceRoot) continue;
        const relativePath = file.component === 'console'
            ? file.localPath
            : file.component === 'server'
                ? file.path.slice(COMPONENTS.server.prefix.length)
                : file.localPath;
        const src = path.join(sourceRoot, relativePath);
        if (fs.existsSync(src) && fs.statSync(src).isFile()) {
            copyFileToBackup(src, `${file.component}/${relativePath}`);
        } else {
            removeOnRestore.push(`${file.component}/${relativePath}`.replace(/\\/g, '/'));
        }
    }

    // A truncated GitHub compare diff is followed by a full tree sync. Back
    // up the complete deployable console tree in that case, otherwise a
    // restore could only recover the files listed by the truncated compare.
    if (opts.fullConsole) {
        const walkConsoleTree = (currentDir, relativeDir = '') => {
            for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
                const relativePath = path.join(relativeDir, entry.name);
                const sourcePath = path.join(currentDir, entry.name);
                if (['data', 'node_modules'].includes(entry.name) && !relativeDir) continue;
                if (entry.isSymbolicLink()) continue;
                if (entry.isDirectory()) {
                    walkConsoleTree(sourcePath, relativePath);
                    continue;
                }
                if (entry.isFile() && isConsoleDeployLocalPath(relativePath)) {
                    copyFileToBackup(sourcePath, `console/${relativePath}`);
                }
            }
        };
        walkConsoleTree(ROOT_DIR);
    }

    fs.writeFileSync(resolveChildPath(backupPath, 'manifest.json'), JSON.stringify({
        version: localVersion,
        sha: localSHA,
        timestamp: new Date().toISOString(),
        filesBackedUp: backedUp,
        fullConsole: !!opts.fullConsole,
        files: backedUpFiles,
        removeOnRestore
    }, null, 2));

    // Mesh agent-server cert (loss requires re-enrolling all MeshAgents)
    try {
        const rustdeskDir = config.rustdeskDir || config.keysPath;
        if (rustdeskDir) {
            const meshCert = path.join(rustdeskDir, 'mesh_agent_server.pem');
            if (fs.existsSync(meshCert)) {
                const dest = resolveChildPath(backupPath, 'special/mesh_agent_server.pem');
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.copyFileSync(meshCert, dest);
                backedUp++;
            }
        }
    } catch (err) {
        console.warn(`[UPDATE] Mesh agent cert backup skipped: ${err.message}`);
    }

    // Auto-prune old backups based on retention setting.
    // Resolution order: DB setting `backup_retention_count` → env var
    // BACKUP_RETENTION_COUNT → 0 (keep all). Operator-controlled.
    try {
        let retention = 0;
        try {
            const db = require('./database');
            const dbVal = await db.getSetting('backup_retention_count');
            if (dbVal !== null && dbVal !== undefined && dbVal !== '') {
                retention = parseInt(dbVal, 10);
            }
        } catch (_e) { /* DB unavailable — fall through to env */ }
        if (!Number.isFinite(retention) || retention <= 0) {
            retention = parseInt(process.env.BACKUP_RETENTION_COUNT, 10);
        }
        if (Number.isFinite(retention) && retention > 0) {
            const pruneResult = pruneBackups(retention);
            if (pruneResult.deleted.length) {
                console.log(`[UPDATE] Pruned ${pruneResult.deleted.length} old backup(s) (retention=${retention})`);
            }
        }
    } catch (err) {
        console.warn(`[UPDATE] Auto-prune failed: ${err.message}`);
    }

    return { backupPath, backedUp };
}

/**
 * Merge missing .env keys from .env.example with resolved install paths (issue #158).
 * @returns {{ mode: string, added: string[] }|null}
 */
function mergeConsoleEnvAfterUpdate() {
    const envExample = path.join(ROOT_DIR, '.env.example');
    const envTarget = path.join(ROOT_DIR, '.env');
    if (!fs.existsSync(envExample) || !fs.existsSync(envTarget)) return null;

    const existing = fs.readFileSync(envTarget, 'utf8');
    const { mergeEnvFile, buildEnvSubstitutions } = require('../lib/envMerge');
    const subs = buildEnvSubstitutions({ existingContent: existing, config });
    return mergeEnvFile({
        targetPath: envTarget,
        templatePath: envExample,
        freshInstall: false,
        substitutions: subs
    });
}

/** In-place service definition patch (TLS API flags, HTTP URLs, console user). */
function patchServiceDefinitions() {
    const goPatch = sanitizeGoServerServiceConfig();
    if (process.platform !== 'linux') {
        return goPatch;
    }
    try {
        const modPath = require.resolve('../scripts/linux-ensure-console-user');
        delete require.cache[modPath];
        const { ensureLinuxConsoleServiceUser } = require('../scripts/linux-ensure-console-user');
        const consolePatch = ensureLinuxConsoleServiceUser();
        if (consolePatch.changed) {
            goPatch.changed = true;
            goPatch.changes.push(...(consolePatch.changes || []));
        }
        if (consolePatch.fatal && consolePatch.error) {
            goPatch.consoleUserError = consolePatch.error;
        }
        if (consolePatch.warnings && consolePatch.warnings.length) {
            goPatch.consoleUserWarnings = consolePatch.warnings;
        }
        if (consolePatch.error && !consolePatch.fatal) {
            goPatch.consoleUserWarnings = (goPatch.consoleUserWarnings || []).concat(consolePatch.error);
        }
        if (typeof consolePatch.permissionsOk === 'boolean') {
            goPatch.consolePermissionsOk = consolePatch.permissionsOk;
        }
    } catch (err) {
        goPatch.consoleUserError = err.message || String(err);
        goPatch.consolePermissionsOk = false;
    }
    return goPatch;
}

/** Run additive DB/security migrations + verify after console file update. */
function runPostConsoleSecurityHooks() {
    const out = { verify: null, error: null };
    try {
        execSync('node scripts/security-patch-verify.js', {
            cwd: ROOT_DIR,
            timeout: 120000,
            stdio: 'pipe',
        });
        out.verify = 'ok';
    } catch (err) {
        out.verify = 'failed';
        out.error = (err.stderr && err.stderr.toString()) || err.message || String(err);
        console.warn(`[UPDATE] Security verify warning: ${out.error}`);
    }
    return out;
}

/**
 * Apply update — download changed files, run npm install if needed,
 * update SHA tracking file.
 *
 * @param {string} remoteSHA
 * @param {object} changedData        Output of getChangedFiles()
 * @param {object} opts
 * @param {boolean}  opts.createBackup  default true
 * @param {string}   opts.serverStrategy default 'auto'
 */
async function applyUpdate(remoteSHA, changedData, opts = {}) {
    if (isImageBasedDockerDeployment()) {
        const hint = getDockerUpdateInstructions().commands.join(' && ');
        throw new Error(`In-app updates are disabled in Docker image deployments. Update containers instead: ${hint}`);
    }
    if (_updateInProgress) throw new Error('Another update is already in progress');
    _updateInProgress = true;

    try {
    const { createBackup = true } = opts;
    const selectedComponents = getAutoUpdateComponents(changedData);

    let backupInfo = null;
    if (createBackup) {
        const allFiles = Object.values(changedData.grouped).flat();
        backupInfo = await createPreUpdateBackup(allFiles, {
            fullConsole: !!changedData.compareTruncated,
        });
    }

    const results = {
        applied: [],
        failed: [],
        removed: [],
        skipped: [],
        npmInstalled: false,
        servicesRestarted: [],
        servicesFailed: [],
        backupPath: backupInfo?.backupPath || null,
        backedUp: backupInfo?.backedUp || 0,
        needsConsoleRestart: false,
        needsServerRestart: false,
        needsAgentRestart: false,
        selectedComponents,
        shaSaved: false
    };

    // ---- Console files ----
    if (selectedComponents.includes('console') && changedData.grouped.console?.length) {
        const consoleFiles = changedData.grouped.console;
        const useFullConsoleSync = !!changedData.compareTruncated;

        if (useFullConsoleSync) {
            console.warn(
                `[UPDATE] Console compare diff hit the ${GITHUB_COMPARE_FILE_LIMIT}-file GitHub cap`
                + ' — performing full console tree sync (#173)'
            );
            try {
                const sync = await ensureConsoleSource(remoteSHA, { force: true });
                results.consoleSync = sync;
                results.applied.push('web-nodejs/(full-tree-sync)');
                for (const failure of sync.failed || []) {
                    results.failed.push({ file: failure.path, error: failure.error });
                }
            } catch (err) {
                results.failed.push({ file: 'console-source', error: err.message });
            }
        } else {
            for (const file of consoleFiles) {
                try {
                    if (file.status === 'removed') {
                        const localFile = resolveConsoleLocalPath(file.localPath);
                        if (isProtectedRuntimePath(localFile)) { results.skipped.push(file.path); continue; }
                        if (fs.existsSync(localFile)) { fs.unlinkSync(localFile); results.removed.push(file.path); }
                        continue;
                    }
                    if (!isConsoleDeployLocalPath(file.localPath)) {
                        results.skipped.push(file.path);
                        continue;
                    }
                    const dest = resolveConsoleLocalPath(file.localPath);
                    if (isProtectedRuntimePath(dest)) {
                        console.warn(`[UPDATE] Refusing to overwrite runtime state file: ${file.path}`);
                        results.skipped.push(file.path);
                        continue;
                    }
                    await downloadConsoleFile(remoteSHA, file.localPath);
                    results.applied.push(file.path);
                } catch (err) {
                    results.failed.push({ file: file.path, error: err.message });
                }
            }
        }

        try {
            const repair = await repairMissingConsoleFiles(remoteSHA, consoleFiles);
            results.consoleRepaired = repair;
            for (const localPath of repair.repaired || []) {
                results.applied.push(`web-nodejs/${localPath} (repair)`);
            }
            for (const failure of repair.failed || []) {
                results.failed.push({
                    file: failure.path,
                    error: failure.error,
                    nonCritical: failure.nonCritical,
                });
            }
        } catch (err) {
            results.failed.push({ file: 'console-repair', error: err.message });
        }

        // npm install when package.json changed
        if (consoleFiles.some(f => f.localPath === 'package.json')) {
            const npmResult = runConsoleNpmInstall({ rootDir: ROOT_DIR, dataDir: config.dataDir, execSync });
            if (npmResult.success) {
                results.npmInstalled = true;
            } else {
                results.failed.push({
                    file: 'npm install',
                    error: npmResult.error || 'npm install failed',
                    nodeModulesOk: npmResult.nodeModulesOk,
                    nonCritical: npmResult.nodeModulesOk,
                });
                console.error(`[UPDATE] npm install failed: ${npmResult.error || 'unknown'}`);
            }
        }
        results.needsConsoleRestart = true;
    }

    // ---- Script / Docker files ----
    if (selectedComponents.includes('scripts') && changedData.grouped.scripts?.length) {
        for (const file of changedData.grouped.scripts) {
            try {
                if (file.status === 'removed') {
                    const dest = path.join(PROJECT_ROOT, file.localPath);
                    if (isProtectedRuntimePath(dest)) { results.skipped.push(file.path); continue; }
                    if (fs.existsSync(dest)) { fs.unlinkSync(dest); results.removed.push(file.path); }
                    continue;
                }
                const dest = path.join(PROJECT_ROOT, file.localPath);
                if (isProtectedRuntimePath(dest)) {
                    console.warn(`[UPDATE] Refusing to overwrite runtime state file: ${file.path}`);
                    results.skipped.push(file.path);
                    continue;
                }
                const content = await ghDownloadFile(GITHUB_OWNER, GITHUB_REPO, remoteSHA, file.path);
                ensureParentDirForFile(dest);
                fs.writeFileSync(dest, content);
                if (!IS_WINDOWS && file.localPath.endsWith('.sh')) {
                    try { fs.chmodSync(dest, 0o755); } catch (_e) { /* ok */ }
                }
                results.applied.push(file.path);
            } catch (err) {
                const entry = { file: file.path, error: err.message };
                if (isUpdatePermissionError(err)) {
                    entry.nonCritical = true;
                    console.warn(`[UPDATE] Skipping installer script (no write access): ${file.path}`);
                }
                results.failed.push(entry);
            }
        }
    }

    // ---- Server source files + compile/download + deploy ----
    if (changedData.grouped.server?.length && selectedComponents.includes('server')) {
        if (!IS_WINDOWS) {
            results.linuxPrivilegeSync = syncLinuxPanelUpdatePrivileges();
        }

        const strategy = opts.serverStrategy || 'auto'; // 'auto', 'compile', 'download', 'install-go'
        let goInfo = checkGoAvailable();
        let goAvailable = goInfo.available && goInfo.meetsMinimum;
        let serverBinaryPath = null;
        let buildUsed = null;
        let preferredGoBinPath = null;
        let prebuiltInfo = null;

        const getPrebuiltOnce = async () => {
            if (!prebuiltInfo) prebuiltInfo = await checkPrebuiltAvailable(remoteSHA);
            return prebuiltInfo;
        };

        // In auto mode, an exact verified GitHub binary is faster than a local
        // compile. A local build remains the fallback when the CI job/artifact
        // is unavailable or does not match this update SHA.
        let prebuilt = null;
        if (strategy === 'auto' || strategy === 'download') {
            prebuilt = await getPrebuiltOnce();
        }

        let toolchainInstalled = false;
        if (strategy === 'install-go' && !goAvailable) {
            const tc = await installGoToolchain();
            results.toolchainInstall = {
                success: tc.success,
                version: tc.version || null,
                error: tc.error || null,
                binPath: tc.binPath || null
            };
            if (tc.success) {
                toolchainInstalled = true;
                goAvailable = true;
                preferredGoBinPath = tc.binPath || null;
            }
        } else if (strategy === 'auto' && !prebuilt?.available && !goAvailable) {
            try {
                const tc = await installGoToolchain();
                results.toolchainInstall = {
                    success: tc.success,
                    version: tc.version || null,
                    error: tc.error || null,
                    binPath: tc.binPath || null,
                    autoTriggered: true
                };
                if (tc.success) {
                    toolchainInstalled = true;
                    goAvailable = true;
                    preferredGoBinPath = tc.binPath || null;
                }
            } catch (err) {
                console.error('[UPDATE] auto-fallback toolchain install failed:', err.message);
            }
        } else if (strategy === 'compile' && !goAvailable) {
            const tc = await installGoToolchain();
            results.toolchainInstall = {
                success: tc.success,
                version: tc.version || null,
                error: tc.error || null,
                binPath: tc.binPath || null,
                autoTriggered: true
            };
            if (tc.success) {
                toolchainInstalled = true;
                goAvailable = true;
                preferredGoBinPath = tc.binPath || null;
            }
        }

        const wantsCompile = strategy === 'compile' || strategy === 'install-go' || toolchainInstalled
            || (strategy === 'auto' && !prebuilt?.available && goAvailable);

        // Keep local Go server source in sync for every server update path.
        // Even when a pre-built binary is used, the next source build must not
        // start from stale files. Force a FULL source resync (issue #158): the
        // GitHub compare diff is capped at 300 files and can omit changed
        // dependency files, leaving the on-disk source inconsistent and
        // unbuildable. A full resync guarantees all callee files are present.
        try {
            const sourceResult = await ensureServerSource(remoteSHA, { force: true });
            console.log(`[UPDATE] Server source: strategy=${sourceResult.strategy}, files=${sourceResult.filesDownloaded}`);
            for (const failure of sourceResult.failed || []) {
                results.failed.push({
                    file: failure.path || 'server-source',
                    error: failure.error || 'Server source file download failed',
                });
            }
        } catch (err) {
            results.failed.push({ file: 'server-source', error: `Source download failed: ${err.message}` });
        }

        const serverDir = resolveServerSourceRootForUpdate();
        for (const file of changedData.grouped.server) {
            try {
                const localPath = file.path.slice(COMPONENTS.server.prefix.length);
                const dest = path.join(serverDir, localPath);
                if (file.status === 'removed') {
                    if (isProtectedRuntimePath(dest)) { results.skipped.push(file.path); continue; }
                    if (fs.existsSync(dest)) { fs.unlinkSync(dest); results.removed.push(file.path); }
                    continue;
                }
                if (isProtectedRuntimePath(dest)) {
                    console.warn(`[UPDATE] Refusing to overwrite runtime state file: ${file.path}`);
                    results.skipped.push(file.path);
                    continue;
                }
                const content = await ghDownloadFile(GITHUB_OWNER, GITHUB_REPO, remoteSHA, file.path);
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.writeFileSync(dest, content);
                results.applied.push(file.path);
            } catch (err) {
                const entry = { file: file.path, error: err.message };
                if (isUpdatePermissionError(err)) {
                    entry.nonCritical = true;
                    console.warn(`[UPDATE] Skipping server source file (no write access): ${file.path}`);
                }
                results.failed.push(entry);
            }
        }

        if (wantsCompile && goAvailable) {
            // ---- Strategy: Compile from source ----
            const buildResult = await buildGoServer(preferredGoBinPath);
            results.serverBuild = {
                success: buildResult.success,
                duration: buildResult.duration || 0,
                error: buildResult.error || null,
                method: 'compile'
            };

            if (buildResult.success) {
                serverBinaryPath = buildResult.binaryPath;
                buildUsed = 'compile';
            } else {
                results.failed.push({ file: 'betterdesk-server', error: buildResult.error || 'Server build failed' });
            }
        } else {
            // ---- Strategy: Download pre-built binary ----
            console.log('[UPDATE] Go not available or download strategy selected — trying pre-built binary download');

            // Try to get from GitHub Releases first
            let downloadResult = null;
            if (prebuilt.available && prebuilt.downloadUrl) {
                downloadResult = await downloadPrebuiltBinary(prebuilt.downloadUrl, {
                    ...prebuilt,
                    remoteSHA,
                });
            }

            if (downloadResult && downloadResult.success) {
                results.serverBuild = {
                    success: true,
                    duration: 0,
                    error: null,
                    method: 'download',
                    source: prebuilt.source || null,
                    runId: prebuilt.runId || null,
                    releaseTag: prebuilt.releaseTag || null,
                    commit: downloadResult.commit || prebuilt.commit || null,
                    sha256: downloadResult.sha256 || null,
                    verified: true,
                    size: downloadResult.size || 0
                };
                serverBinaryPath = downloadResult.binaryPath;
                buildUsed = 'download';
            } else {
                const errMsg = downloadResult?.error
                    || prebuilt?.reason
                    || 'No verified pre-built binary available and Go not installed';
                results.serverBuild = {
                    success: false,
                    duration: 0,
                    error: errMsg,
                    method: 'download'
                };
                results.failed.push({ file: 'betterdesk-server', error: errMsg });
            }
        }

        // 4. Deploy to service path (common for both strategies)
        if (serverBinaryPath) {
            const targetPath = detectServerBinaryPath();
            const deployResult = deployServerBinary(serverBinaryPath, targetPath);
            results.serverDeploy = {
                success: deployResult.success,
                backupPath: deployResult.backupPath || null,
                error: deployResult.error || null,
                method: buildUsed,
                targetPath
            };

            if (deployResult.success) {
                const serviceConfig = sanitizeGoServerServiceConfig();
                results.serverServiceConfig = serviceConfig;
                if (serviceConfig.error) {
                    results.failed.push({
                        file: 'betterdesk-server.service',
                        error: `Service config cleanup failed: ${serviceConfig.error}`,
                        nonCritical: true,
                    });
                }
                if (serviceConfig.needsRestart) {
                    results.needsServerRestart = true;
                }
                results.needsServerRestart = true;
                // Fresh binary (with updated dependencies) is in place — any
                // previous staleness warning no longer applies.
                clearServerBinaryStale();
            } else {
                results.failed.push({ file: 'betterdesk-server-deploy', error: deployResult.error || 'Server deploy failed' });
            }
        }
    }

    // ---- Update SHA tracking ----
    const { critical: criticalFailures, nonCritical: nonCriticalFailures } = splitUpdateFailures(
        results.failed,
        ROOT_DIR
    );
    results.criticalFailures = criticalFailures;
    results.nonCriticalFailures = nonCriticalFailures;

    if (criticalFailures.length > 0 && createBackup && opts.autoRollback !== false && backupInfo?.backupPath) {
        try {
            const rollback = restoreFromBackup(path.basename(backupInfo.backupPath));
            const binaryRollback = results.serverDeploy?.backupPath
                ? restoreServerBinaryBackup(
                    results.serverDeploy.backupPath,
                    results.serverDeploy.targetPath
                )
                : { restored: false, skipped: true };
            results.rollback = {
                attempted: true,
                success: !binaryRollback.error && rollback.restored >= 0,
                filesRestored: rollback.restored,
                filesRemoved: rollback.removed || 0,
                binary: binaryRollback,
            };
            console.warn(
                `[UPDATE] Critical update failure — restored ${rollback.restored} file(s)`
                + ` and removed ${rollback.removed || 0} new file(s)`
            );
        } catch (rollbackErr) {
            results.rollback = {
                attempted: true,
                success: false,
                error: rollbackErr.message || String(rollbackErr),
            };
            console.error(`[UPDATE] Automatic rollback failed: ${rollbackErr.message}`);
        }
    }

    // Security visibility: if the Go server source changed
    // dependency bump shipping a security fix) but the binary could not be
    // rebuilt/deployed, the running process is still the OLD binary. Persist a
    // staleness marker and flag it on the result so the panel can warn the
    // admin and offer an explicit rebuild instead of silently reporting
    // success.
    const serverSourceChanged = !!changedData.grouped.server?.length;
    const serverBinaryFailed = nonCriticalFailures.some(f =>
        f.file === 'betterdesk-server' || f.file === 'betterdesk-server-deploy'
    );
    if (serverSourceChanged && serverBinaryFailed && !results.needsServerRestart) {
        const detail = (results.serverBuild && results.serverBuild.error)
            || (nonCriticalFailures.find(f => f.file === 'betterdesk-server' || f.file === 'betterdesk-server-deploy') || {}).error
            || 'Server binary could not be rebuilt';
        markServerBinaryStale({ reason: 'rebuild_failed', detail, sha: remoteSHA });
        results.serverBinaryStale = true;
        results.serverBinaryStaleReason = detail;
        console.warn(`[UPDATE] Server source updated but binary not rebuilt — attempting auto-rebuild: ${detail}`);

        // Issue #158: retry build/deploy automatically before leaving the install stale.
        try {
            const autoRebuild = await rebuildServerBinary({ sha: remoteSHA, restart: false });
            results.autoRebuild = {
                success: autoRebuild.success,
                error: autoRebuild.error || null,
                steps: autoRebuild.steps || null
            };
            if (autoRebuild.success) {
                clearServerBinaryStale();
                results.serverBinaryStale = false;
                results.serverBinaryStaleReason = null;
                results.needsServerRestart = true;
                console.log('[UPDATE] Auto-rebuild succeeded — server binary deployed');
            } else {
                console.warn(`[UPDATE] Auto-rebuild failed: ${autoRebuild.error || 'unknown'}`);
            }
        } catch (autoErr) {
            results.autoRebuild = { success: false, error: autoErr.message };
            console.warn(`[UPDATE] Auto-rebuild error: ${autoErr.message}`);
        }
    }

    if (criticalFailures.length === 0) {
        saveLocalSHA(remoteSHA);
        results.shaSaved = true;

        // ---- Pull remote VERSION file ----
        try {
            const versionContent = await ghDownloadFile(GITHUB_OWNER, GITHUB_REPO, remoteSHA, 'VERSION');
            const versionDest = path.join(PROJECT_ROOT, 'VERSION');
            ensureParentDirForFile(versionDest);
            fs.writeFileSync(versionDest, versionContent);
        } catch (_e) { /* non-critical */ }

        // ---- Support Agent generator: defer to post-restart phase ----
        // Agent Client and RdClient use their own workers. Keeping this rebuild
        // scoped prevents a Support Agent source update from invalidating their
        // ready artifacts, while legacy "agent" rows normalize to Support Agent.
        // The source tree can contain hundreds of files, so neither its sync nor
        // the queue operation may delay completion of the console update.
        if (shouldQueueAgentRebuild(changedData)) {
            try {
                const agentBuildWorker = require('./agentBuildWorker');
                agentBuildWorker.markRebuildPending('in-app update', { remoteSHA });
                results.agentRebuildDeferred = true;
                results.agentRebuildRemoteSHA = remoteSHA;
                results.agentRebuildProductType = 'support-agent';
                console.log(
                    `[UPDATE] Support Agent rebuild deferred until console startup at ${remoteSHA.slice(0, 7)}`
                );
            } catch (err) {
                results.failed.push({ file: 'support-agent-rebuild-defer', error: err.message, nonCritical: true });
                console.warn(`[UPDATE] Could not defer Support Agent rebuild: ${err.message}`);
            }
        }

        const finalFailures = splitUpdateFailures(results.failed, ROOT_DIR);
        results.criticalFailures = finalFailures.critical;
        results.nonCriticalFailures = finalFailures.nonCritical;
        if (finalFailures.nonCritical.length > 0) {
            console.log(`[UPDATE] SHA saved despite ${finalFailures.nonCritical.length} non-critical failure(s): ${finalFailures.nonCritical.map(f => f.file).join(', ')}`);
        }
    } else {
        results.skipped.push('SHA tracking (critical update steps incomplete)');
        console.error(`[UPDATE] ${criticalFailures.length} critical failure(s): ${criticalFailures.map(f => `${f.file}: ${f.error}`).join(' | ')}`);
    }

    if (criticalFailures.length === 0) {
        try {
            const merged = mergeConsoleEnvAfterUpdate();
            if (merged) results.envMerged = merged.added || [];
        } catch (err) {
            console.warn(`[UPDATE] .env merge skipped: ${err.message}`);
        }
    }

    if (serverSourceChanged || results.needsServerRestart || results.needsConsoleRestart) {
        if (!IS_WINDOWS) {
            results.linuxPrivilegeSyncFinal = syncLinuxPanelUpdatePrivileges();
        }
        results.servicePatch = patchServiceDefinitions();
    }

    if (results.needsConsoleRestart && criticalFailures.length === 0) {
        results.securityHooks = runPostConsoleSecurityHooks();
    }

    return results;
    } finally {
        _updateInProgress = false;
    }
}

/** Sync full support-agent trees from GitHub at the given commit SHA. */
async function syncAgentSourceAtSha(remoteSHA) {
    const agentBuildWorker = require('./agentBuildWorker');
    return agentBuildWorker.syncFullAgentSourceFromGitHub({
        remoteSHA,
        download: ghDownloadFile,
        listPaths: ghListRepoBlobPaths,
    });
}

/**
 * Restart a system service.
 * Returns { success, service, error? }.
 */
function restartService(serviceName) {
    try {
        if (IS_WINDOWS) {
            execSync(`nssm restart "${serviceName}"`, { timeout: 30000, stdio: 'pipe' });
        } else {
            runPrivileged(`systemctl restart ${shellQuote(serviceName)}`, { timeout: 30000, stdio: 'pipe' });
        }
        return { success: true, service: serviceName };
    } catch (err) {
        const message = err.message || String(err);
        // Console service account often lacks rights to OpenService on sibling
        // NSSM units (BetterDeskServer). Treat as non-critical so SHA save /
        // success banner are not blocked — operator can restart via PS1 (#272).
        const nonCritical = IS_WINDOWS && /access is denied|OpenService/i.test(message);
        return {
            success: false,
            service: serviceName,
            error: message,
            nonCritical,
            hint: nonCritical
                ? 'Restart BetterDeskServer manually (Admin PowerShell: nssm restart BetterDeskServer) or run betterdesk.ps1 → Update'
                : undefined,
        };
    }
}

/**
 * Reload systemd unit definitions after editing .service files (Linux only).
 */
function daemonReload() {
    if (IS_WINDOWS) {
        return { success: true, skipped: true };
    }
    try {
        runPrivileged('systemctl daemon-reload', { timeout: 10000, stdio: 'pipe' });
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * Recursively compute total size in bytes of a directory.
 * Returns 0 on error so the UI can still render.
 */
function getDirectorySize(dirPath) {
    let total = 0;
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dirPath, entry.name);
            try {
                if (entry.isDirectory()) {
                    total += getDirectorySize(full);
                } else if (entry.isFile()) {
                    total += fs.statSync(full).size;
                }
            } catch (_e) { /* skip unreadable entry */ }
        }
    } catch (_e) { /* skip unreadable dir */ }
    return total;
}

/**
 * List pre-update backups (newest first).
 */
function listBackups() {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR)
        .filter(d => d.startsWith('pre-update-'))
        .map(d => {
            const dir = resolveChildPath(path.resolve(BACKUP_DIR), d);
            const mPath = resolveChildPath(dir, 'manifest.json');
            let m = {};
            if (fs.existsSync(mPath)) {
                try { m = JSON.parse(fs.readFileSync(mPath, 'utf8')); } catch (_e) { /* skip */ }
            }
            return {
                name: d,
                path: dir,
                version: m.version || 'unknown',
                sha: (m.sha || '').slice(0, 7),
                timestamp: m.timestamp || '',
                filesBackedUp: m.filesBackedUp || 0,
                fileCount: m.filesBackedUp || 0,
                sizeBytes: getDirectorySize(dir)
            };
        })
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * Validate a backup directory name to prevent path traversal.
 * Only allows the canonical `pre-update-{ISO-timestamp}` format.
 */
function isValidBackupName(name) {
    return typeof name === 'string' && /^pre-update-[\d\-T]+$/.test(name);
}

function isValidManifestRelativePath(relPath) {
    if (typeof relPath !== 'string' || relPath.length === 0 || relPath.includes('\0')) return false;
    const normalized = relPath.replace(/\\/g, '/');
    if (path.isAbsolute(normalized) || normalized.startsWith('/') || normalized.startsWith('..')) return false;
    if (normalized.split('/').some((seg) => seg === '..')) return false;
    return true;
}

/**
 * Recursively delete a directory. Refuses to delete anything outside
 * BACKUP_DIR to defend against path-traversal bugs upstream.
 */
function deleteBackup(name) {
    if (!isValidBackupName(name)) {
        throw new Error('Invalid backup name');
    }
    const root = path.resolve(BACKUP_DIR);
    if (!existsConfinedChild(root, name)) {
        throw new Error('Backup not found');
    }
    removeConfinedChild(root, name, { recursive: true, force: true });
    return { deleted: name };
}

/**
 * Apply retention: keep the `keep` newest backups, delete older ones.
 * keep <= 0 means "keep everything" (no-op).
 */
function pruneBackups(keep) {
    const n = parseInt(keep, 10);
    if (!Number.isFinite(n) || n <= 0) {
        return { kept: -1, deleted: [] };
    }
    const all = listBackups();
    if (all.length <= n) {
        return { kept: n, deleted: [] };
    }
    const toDelete = all.slice(n);
    const deleted = [];
    for (const b of toDelete) {
        try {
            deleteBackup(b.name);
            deleted.push(b.name);
        } catch (err) {
            console.error(`[UPDATE] Failed to prune backup ${b.name}: ${err.message}`);
        }
    }
    return { kept: n, deleted };
}

function restoreServerBinaryBackup(backupPath, targetPath) {
    if (!backupPath || !targetPath) {
        return { restored: false, error: 'Server binary backup path is incomplete' };
    }
    const backup = path.resolve(backupPath);
    const target = path.resolve(targetPath);
    const expectedPrefix = `${path.basename(target)}.bak.`;
    if (path.dirname(backup) !== path.dirname(target)
        || !path.basename(backup).startsWith(expectedPrefix)
        || !fs.existsSync(backup)) {
        return { restored: false, error: 'Server binary backup path failed validation' };
    }

    const staging = `${target}.rollback.${process.pid}.${Date.now()}`;
    try {
        fs.copyFileSync(backup, staging);
        if (IS_WINDOWS) {
            fs.copyFileSync(staging, target);
            fs.unlinkSync(staging);
        } else {
            fs.renameSync(staging, target);
        }
        return { restored: true, targetPath: target };
    } catch (err) {
        try { if (fs.existsSync(staging)) fs.unlinkSync(staging); } catch (_e) { /* best effort */ }
        return { restored: false, error: err.message || String(err), targetPath: target };
    }
}

/**
 * Restore files from a pre-update backup and revert the SHA.
 *
 * Current manifests prefix entries with `console/`, `server/` or `scripts/`
 * so a restore can recover more than the console tree. Older manifests used
 * unprefixed console paths and remain supported for backwards compatibility.
 */
function restoreFromBackup(backupName) {
    if (!isValidBackupName(backupName)) throw new Error('Invalid backup name');
    const backupRoot = path.resolve(BACKUP_DIR);
    if (!existsConfinedChild(backupRoot, backupName)) throw new Error('Backup not found');
    const backupPath = resolveChildPath(backupRoot, backupName);

    const manifestPath = resolveChildPath(backupPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error('Invalid backup — missing manifest');

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    let restored = 0;
    let removed = 0;
    const resolveManifestTarget = (backupFilePath) => {
        let filePath = backupFilePath;
        let targetRoot = ROOT_DIR;
        if (backupFilePath.startsWith('console/')) {
            filePath = backupFilePath.slice('console/'.length);
        } else if (backupFilePath.startsWith('server/')) {
            filePath = backupFilePath.slice('server/'.length);
            targetRoot = resolveServerSourceRootForUpdate();
        } else if (backupFilePath.startsWith('scripts/')) {
            filePath = backupFilePath.slice('scripts/'.length);
            targetRoot = PROJECT_ROOT;
        }
        if (!isValidManifestRelativePath(filePath)) {
            throw new Error(`Invalid target path in backup manifest: ${filePath}`);
        }
        return {
            backupFilePath,
            filePath,
            targetRoot,
        };
    };

    for (const backupFilePath of (manifest.files || [])) {
        if (!isValidManifestRelativePath(backupFilePath)) {
            throw new Error(`Invalid path in backup manifest: ${backupFilePath}`);
        }
        const target = resolveManifestTarget(backupFilePath);
        const src = resolvePathUnderRoot(backupPath, backupFilePath);
        const dest = resolvePathUnderRoot(target.targetRoot, target.filePath);
        if (fs.existsSync(src)) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
            restored++;
        }
    }

    for (const backupFilePath of (manifest.removeOnRestore || [])) {
        if (!isValidManifestRelativePath(backupFilePath)) {
            throw new Error(`Invalid remove path in backup manifest: ${backupFilePath}`);
        }
        const target = resolveManifestTarget(backupFilePath);
        const dest = resolvePathUnderRoot(target.targetRoot, target.filePath);
        if (fs.existsSync(dest)) {
            fs.rmSync(dest, { force: true });
            removed++;
        }
    }

    // Mesh agent certificates live beside the server data, not in the
    // console root. Older backups placed this file at the backup root; accept
    // both formats but always restore to the configured runtime directory.
    const rustdeskDir = config.rustdeskDir || config.keysPath;
    if (rustdeskDir) {
        const meshSources = [
            resolveChildPath(backupPath, 'special/mesh_agent_server.pem'),
            resolveChildPath(backupPath, 'mesh_agent_server.pem'),
        ];
        const meshSource = meshSources.find((candidate) => fs.existsSync(candidate));
        if (meshSource) {
            const meshTarget = path.join(rustdeskDir, 'mesh_agent_server.pem');
            fs.mkdirSync(path.dirname(meshTarget), { recursive: true });
            fs.copyFileSync(meshSource, meshTarget);
            restored++;
        }
    }

    // Revert SHA to the pre-update value
    if (manifest.sha) saveLocalSHA(manifest.sha);

    return {
        restored,
        removed,
        version: manifest.version,
        sha: manifest.sha,
        totalFiles: (manifest.files || []).length,
    };
}

/**
 * Explicitly rebuild the Go server binary from the local source with the
 * current dependency versions (go.mod/go.sum) and deploy it.
 *
 * This is the recovery path for the case where a previous update applied the
 * server source (including security-relevant dependency bumps) but the binary
 * step failed and was left stale. It is idempotent and self-contained:
 *   1. sync the server source to the tracked SHA (when known),
 *   2. ensure a usable Go toolchain (bootstrapping a vendored one if needed),
 *   3. `go mod download` + `go build` to link the updated dependencies,
 *   4. deploy the binary to the service path and sanitize the service config,
 *   5. clear the staleness marker and restart the service.
 *
 * @param {{ sha?: string, restart?: boolean }} opts
 * @returns {Promise<{ success: boolean, error?: string, steps: object }>}
 */
async function rebuildServerBinary(opts = {}) {
    if (isImageBasedDockerDeployment()) {
        const hint = getDockerUpdateInstructions().commands.join(' && ');
        return {
            success: false,
            dockerMode: true,
            error: `Server rebuild is not available in Docker image deployments. Update the server container instead: ${hint}`,
            steps: {}
        };
    }
    const result = { success: false, steps: {} };
    const remoteSHA = opts.sha || getLocalSHA();

    // 1. Sync source so the build links the latest go.mod/go.sum.
    //    Force a FULL resync (issue #158) so a previously truncated compare
    //    diff cannot leave the local source inconsistent and unbuildable.
    try {
        if (remoteSHA) {
            const src = await ensureServerSource(remoteSHA, { force: true });
            result.steps.source = { success: true, strategy: src.strategy, files: src.filesDownloaded };
        } else {
            result.steps.source = { success: true, strategy: 'local', files: 0 };
        }
    } catch (err) {
        result.steps.source = { success: false, error: err.message };
        result.error = `Source sync failed: ${err.message}`;
        return result;
    }

    // 2. Ensure a Go toolchain capable of building the server.
    let preferredGoBinPath = null;
    const goInfo = checkGoAvailable();
    if (!goInfo.available || !goInfo.meetsMinimum) {
        const tc = await installGoToolchain();
        result.steps.toolchain = { success: tc.success, version: tc.version || null, error: tc.error || null };
        if (!tc.success) {
            result.error = `Go toolchain unavailable: ${tc.error || 'install failed'}`;
            markServerBinaryStale({ reason: 'no_toolchain', detail: result.error, sha: remoteSHA });
            return result;
        }
        preferredGoBinPath = tc.binPath || null;
    } else {
        result.steps.toolchain = { success: true, version: goInfo.version, existing: true };
    }

    // 3. Build with the updated dependencies.
    const build = await buildGoServer(preferredGoBinPath);
    result.steps.build = {
        success: build.success,
        duration: build.duration || 0,
        error: build.error || null,
        goVersion: build.goVersion || null
    };
    if (!build.success) {
        result.error = build.error || 'Build failed';
        markServerBinaryStale({ reason: 'rebuild_failed', detail: result.error, sha: remoteSHA });
        return result;
    }

    // 4. Deploy to the service path.
    if (!IS_WINDOWS) {
        result.steps.linuxPrivilegeSync = syncLinuxPanelUpdatePrivileges();
    }
    const targetPath = detectServerBinaryPath();
    const deploy = deployServerBinary(build.binaryPath, targetPath);
    result.steps.deploy = {
        success: deploy.success,
        backupPath: deploy.backupPath || null,
        error: deploy.error || null,
        targetPath
    };
    if (!deploy.success) {
        result.error = deploy.error || 'Deploy failed';
        markServerBinaryStale({ reason: 'deploy_failed', detail: result.error, sha: remoteSHA });
        return result;
    }

    // 5. Sanitize the service config and clear the staleness marker.
    result.steps.serviceConfig = sanitizeGoServerServiceConfig();
    clearServerBinaryStale();

    // 6. Restart the service so the new binary takes effect.
    if (opts.restart !== false) {
        result.steps.restart = restartService(IS_WINDOWS ? 'BetterDeskServer' : 'betterdesk-server');
    }

    result.success = true;
    return result;
}

/**
 * Pre-install checks for panel update (issue #158).
 * @returns {Promise<{ ready: boolean, issues: string[], warnings: string[], go: object, prebuiltAvailable: boolean, canBuildServer: boolean }>}
 */
function checkUpdateDiskSpace(targetPath = ROOT_DIR) {
    const minimumFreeBytes = Math.max(
        64 * 1024 * 1024,
        (Number.parseInt(process.env.UPDATE_MIN_FREE_MB, 10) || 512) * 1024 * 1024
    );
    const result = {
        availableBytes: null,
        minimumFreeBytes,
        path: targetPath,
        supported: typeof fs.statfsSync === 'function',
        sufficient: null,
    };

    if (!result.supported) return result;

    try {
        const stats = fs.statfsSync(targetPath);
        result.availableBytes = Number(stats.bavail) * Number(stats.bsize);
        if (Number.isFinite(result.availableBytes)) {
            result.sufficient = result.availableBytes >= minimumFreeBytes;
        } else {
            // Some Node/platform combinations expose statfsSync but do not
            // return usable block statistics. Treat that as unsupported
            // rather than incorrectly blocking every Windows update.
            result.supported = false;
            result.availableBytes = null;
        }
    } catch (_e) {
        result.supported = false;
    }
    return result;
}

async function runUpdatePreflight(opts = {}) {
    const issues = [];
    const warnings = [];
    const serverUpdateRequired = !!opts.serverUpdateRequired;
    const remoteSHA = opts.remoteSHA || null;

    if (isImageBasedDockerDeployment()) {
        const hint = getDockerUpdateInstructions().commands.join(' && ');
        return {
            ready: false,
            issues: [`Docker image deployment — use "${hint}" instead of in-app install`],
            warnings: [],
            go: checkGoAvailable(),
            prebuiltAvailable: false,
            canBuildServer: false,
            dockerImageMode: true,
            dockerUpdate: getDockerUpdateInstructions()
        };
    }

    try {
        execSync('node --version', { timeout: 5000, stdio: 'pipe' });
    } catch (_e) {
        issues.push('Node.js is not available on PATH');
    }

    try {
        execSync('npm --version', { timeout: 5000, stdio: 'pipe' });
    } catch (_e) {
        warnings.push('npm is not available — console dependency install may fail');
    }

    try {
        fs.mkdirSync(config.dataDir, { recursive: true });
        fs.accessSync(config.dataDir, fs.constants.W_OK);
    } catch (_e) {
        issues.push(`Console data directory is not writable: ${config.dataDir}`);
    }

    const disk = checkUpdateDiskSpace(config.dataDir);
    if (disk.sufficient === false) {
        issues.push(
            `Insufficient free disk space under ${disk.path}: `
            + `${Math.floor(disk.availableBytes / 1024 / 1024)} MiB available, `
            + `${Math.floor(disk.minimumFreeBytes / 1024 / 1024)} MiB required`
        );
    } else if (!disk.supported) {
        warnings.push('Free disk-space check is unavailable on this platform');
    }

    try {
        const { ensureConsoleNpmDirs } = require('../lib/consoleNpmInstall');
        ensureConsoleNpmDirs(config.dataDir);
        fs.accessSync(path.join(config.dataDir, 'npm-cache'), fs.constants.W_OK);
    } catch (_e) {
        warnings.push(`Console npm cache is not writable under ${config.dataDir}/npm-cache`);
    }

    if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() !== 0) {
        if (!canUsePrivilegedUpdate()) {
            warnings.push(
                'The fixed root update broker is not installed — run linux-ensure-console-user.js as root once'
            );
        }
    }

    const binaryPath = detectServerBinaryPath();
    if (binaryPath) {
        const capability = assessServerBinaryDeployCapability(binaryPath, { consoleRoot: ROOT_DIR });
        if (!capability.ready) {
            warnings.push(
                `Server binary directory is not writable: ${capability.targetDir || path.dirname(binaryPath)}`
                + ' — run the documented Go server deploy helper as root; the panel will not sudo repository code'
            );
        }
    } else {
        warnings.push('Go server binary path could not be detected — deploy step may require manual repair');
    }

    let prebuiltAvailable = false;
    let prebuilt = null;
    try {
        prebuilt = await checkPrebuiltAvailable(remoteSHA);
        prebuiltAvailable = !!(prebuilt && prebuilt.available);
    } catch (_e) { /* optional */ }

    const goInfo = checkGoAvailable();
    const canBuildServer = prebuiltAvailable || (goInfo.available && goInfo.meetsMinimum);

    if (!canBuildServer) {
        const msg = 'Neither a compatible Go toolchain nor a pre-built server binary is available';
        if (serverUpdateRequired) {
            issues.push(`${msg} — server update cannot complete`);
        } else {
            warnings.push(`${msg} — server compile may fail (auto-rebuild will retry)`);
        }
    }

    try {
        await getRemoteHeadSHA();
    } catch (err) {
        issues.push(`Cannot reach GitHub API: ${err.message}`);
    }

    return {
        ready: issues.length === 0,
        issues,
        warnings,
        go: goInfo,
        prebuiltAvailable,
        prebuilt,
        canBuildServer,
        disk,
        remoteSHA
    };
}

module.exports = {
    getUpdateChannelInfo,
    setUpdateChannel,
    UPDATE_CHANNELS,
    getGithubBranch,
    checkForUpdates,
    getChangedFiles,
    createPreUpdateBackup,
    applyUpdate,
    runUpdatePreflight,
    sanitizeGoServerServiceConfig,
    syncBillingEnvToWindowsGoServer,
    BILLING_ENV_KEYS,
    restartService,
    daemonReload,
    listBackups,
    deleteBackup,
    pruneBackups,
    restoreFromBackup,
    restoreServerBinaryBackup,
    getLocalVersion,
    getLocalSHA,
    saveLocalSHA,
    getRemoteHeadSHA,
    getServerUpdateInfo,
    getPrebuiltInfo,
    checkPrebuiltAvailable,
    downloadPrebuiltBinary,
    getServerBinaryTarget,
    validateServerBinaryManifest,
    getSafeZipEntryName,
    installGoToolchain,
    checkGoAvailable,
    getServerBinaryStatus,
    rebuildServerBinary,
    mergeConsoleEnvAfterUpdate,
    patchServiceDefinitions,
    shouldQueueAgentRebuild,
    syncAgentSourceAtSha,
    goStdlibHealthy,
    isImageBasedDockerDeployment,
    getImageEmbeddedSHA,
    bootstrapDockerImageDeployment,
    getDockerUpdateInstructions,
    isGithubRateLimitError,
    ensureMeshEnabledInServiceEnv,
    ensureGoServerEnvironmentFile,
    ensureGoServerSignalRelayPorts,
    githubApiError,
    COMPONENTS,
    NON_CRITICAL_UPDATE_FAILURES,
    isNonCriticalUpdateFailure,
    GITHUB_COMPARE_FILE_LIMIT,
    isCompareLikelyTruncated,
    isRetryableDownloadStatus,
    getDownloadRetryDelayMs,
    resolveConsoleRequire,
    collectConsoleRequiredFiles,
    isResolvedByIndexModule,
    getConsoleDeployGraph,
    splitUpdateFailures,
    repairMissingConsoleFiles,
    resolveServerSourceRootForUpdate,
    resolveProjectRoot,
    ensureParentDirForFile,
    isUpdatePermissionError,
    readLastUpdateResult: () => require('../lib/updateResultStore').readLastUpdateResult(config.dataDir),
    ensureConsoleSource,
    checkUpdateDiskSpace,
};

bootstrapDockerImageDeployment();
