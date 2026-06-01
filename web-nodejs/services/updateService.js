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
const path = require('path');
const https = require('https');
const { execSync, execFileSync } = require('child_process');
const config = require('../config/config');

const GITHUB_OWNER  = process.env.UPDATE_GITHUB_OWNER  || 'UNITRONIX';
const GITHUB_REPO   = process.env.UPDATE_GITHUB_REPO   || 'BetterDesk';
const GITHUB_BRANCH = process.env.UPDATE_GITHUB_BRANCH || 'main';
const GITHUB_API    = 'https://api.github.com';
const USER_AGENT    = `BetterDesk-Console/${config.appVersion}`;
const BACKUP_DIR    = path.join(config.dataDir, 'backups');
const SHA_FILE      = path.join(config.dataDir, '.update_sha');
const ROOT_DIR      = path.join(__dirname, '..');          // web-nodejs/
const PROJECT_ROOT  = path.join(ROOT_DIR, '..');           // repo root
const IS_WINDOWS    = process.platform === 'win32';

// Optional GitHub personal-access token  (60 req/h without, 5 000 with)
const GITHUB_TOKEN = process.env.UPDATE_GITHUB_TOKEN || '';

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
        label: 'Agent',
        localRoot: null,
        service: IS_WINDOWS ? 'BetterDeskAgent' : 'betterdesk-agent',
        autoUpdate: false
    },
    scripts: {
        // matched by exact file names, not prefix
        files: [
            'betterdesk.sh', 'betterdesk.ps1', 'betterdesk-docker.sh',
            'docker-compose.yml', 'docker-compose.single.yml', 'docker-compose.quick.yml',
            'Dockerfile', 'Dockerfile.server', 'Dockerfile.console'
        ],
        label: 'Scripts & Docker',
        localRoot: PROJECT_ROOT,
        service: null,
        autoUpdate: true
    }
};

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

// ======================== HTTP Helpers ===================================

/**
 * HTTPS GET → parsed JSON. Follows one redirect.
 */
function ghGet(urlPath) {
    return new Promise((resolve, reject) => {
        const url = urlPath.startsWith('https://') ? new URL(urlPath) : new URL(urlPath, GITHUB_API);
        const headers = { 'User-Agent': USER_AGENT, 'Accept': 'application/vnd.github+json' };
        if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;

        const req = https.get({ hostname: url.hostname, path: url.pathname + url.search, headers }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return ghGet(res.headers.location).then(resolve, reject);
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString();
                if (res.statusCode >= 400) {
                    return reject(new Error(`GitHub API ${res.statusCode}: ${body.slice(0, 200)}`));
                }
                try { resolve(JSON.parse(body)); }
                catch (_e) { reject(new Error('Invalid JSON from GitHub API')); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('GitHub API timeout')); });
    });
}

/**
 * Download raw file content from GitHub (binary-safe).
 */
function ghDownloadFile(owner, repo, ref, filePath) {
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

// ======================== SHA Tracking ===================================

function getLocalSHA() {
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
    const data = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits/${GITHUB_BRANCH}`);
    return {
        sha: data.sha,
        message: (data.commit?.message || '').split('\n')[0],
        date: data.commit?.committer?.date || data.commit?.author?.date || '',
        author: data.commit?.author?.name || ''
    };
}

function getLocalVersion() {
    const versionFile = path.join(PROJECT_ROOT, 'VERSION');
    if (fs.existsSync(versionFile)) {
        const v = fs.readFileSync(versionFile, 'utf8').trim();
        if (v) return v;
    }
    return config.appVersion;
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
            return execSync(`sudo cat ${shellQuote(filePath)}`, { timeout: 5000, stdio: 'pipe' }).toString();
        }
        throw err;
    }
}

function writeTextFilePrivileged(filePath, content) {
    try {
        fs.writeFileSync(filePath, content);
    } catch (err) {
        if (!IS_WINDOWS && (err.code === 'EACCES' || err.code === 'EPERM')) {
            execSync(`sudo tee ${shellQuote(filePath)} >/dev/null`, {
                input: content,
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            return;
        }
        throw err;
    }
}

function runPrivileged(command, options = {}) {
    const prefix = !IS_WINDOWS && typeof process.getuid === 'function' && process.getuid() !== 0 ? 'sudo ' : '';
    return execSync(prefix + command, options);
}

/**
 * Keep the Go REST API on plain HTTP even when signal/relay TLS is enabled.
 * RustDesk clients call the consolidated Go API (21121) over HTTP for heartbeat,
 * sysinfo, login and address-book endpoints; -tls-api breaks that contract.
 */
function sanitizeGoServerServiceConfig() {
    const result = { changed: false, changes: [], error: null };

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

        if (clean !== original) {
            writeTextFilePrivileged(fragmentPath, clean);
            runPrivileged('systemctl daemon-reload', { timeout: 10000, stdio: 'pipe' });
            result.changed = true;
            result.changes.push('removed Go API TLS flags from systemd service');
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
        const version = execSync(`${quoteCommand(binPath)} version`, {
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
 * Wrap an exec environment so a manually located `go` binary is on PATH.
 */
function buildEnvWithGo(goBinPath) {
    const env = { ...process.env, CGO_ENABLED: '0' };
    if (goBinPath && goBinPath !== 'go') {
        const goBinDir = path.dirname(goBinPath);
        const sep = IS_WINDOWS ? ';' : ':';
        env.PATH = goBinDir + sep + (env.PATH || '');
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
            'C:\\betterdesk\\betterdesk-server.exe',
            'C:\\Program Files\\BetterDesk\\betterdesk-server.exe',
            path.join(PROJECT_ROOT, 'betterdesk-server', 'betterdesk-server.exe')
        ]
        : [
            '/opt/rustdesk/betterdesk-server',
            '/opt/betterdesk/betterdesk-server',
            '/usr/local/bin/betterdesk-server',
            path.join(PROJECT_ROOT, 'betterdesk-server', 'betterdesk-server')
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
    const serverDir = COMPONENTS.server.localRoot;
    const goModPath = path.join(serverDir, 'go.mod');
    if (!opts.force && fs.existsSync(goModPath)) {
        return { strategy: 'incremental', filesDownloaded: 0 };
    }

    fs.mkdirSync(serverDir, { recursive: true });

    // --- Try git clone --depth=1 (fastest) ---
    try {
        const tmpDir = path.join(config.dataDir, '_tmp_server_clone');
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });

        const repoUrl = GITHUB_TOKEN
            ? `https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git`
            : `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git`;

        execSync(
            `git clone --depth=1 --single-branch --branch "${GITHUB_BRANCH}" "${repoUrl}" "${tmpDir}"`,
            { timeout: 120000, stdio: 'pipe' }
        );

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

/**
 * Build the Go server binary from local source.
 * Uses async exec to avoid blocking the Node.js event loop.
 *
 * @returns {Promise<{ success: boolean, binaryPath: string|null, error?: string, duration?: number }>}
 */
async function buildGoServer(preferredGoBinPath = null) {
    const serverDir = COMPONENTS.server.localRoot;
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
    // Quote when path contains spaces (Windows "Program Files")
    const goCmd = /\s/.test(goBin) ? `"${goBin}"` : goBin;

    try {
        await execPromise(`${goCmd} mod download`, {
            cwd: serverDir,
            timeout: 120000,
            env: buildEnv
        });

        await execPromise(
            `${goCmd} build -trimpath -ldflags="-s -w" -o "${binaryName}" .`,
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
// Minimum Go version required to build the server (must match
// betterdesk-server/go.mod). The actual point release is selected at
// install time from the live go.dev manifest.
const GO_MIN_VERSION = '1.23.0';

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
async function resolveGoRelease() {
    const key = getToolchainKey();
    const data = await httpsDownload('https://go.dev/dl/?mode=json');
    const releases = JSON.parse(data.toString('utf8'));
    if (!Array.isArray(releases) || !releases.length) {
        throw new Error('go.dev manifest empty');
    }
    // Pick the highest stable release that meets GO_MIN_VERSION.
    const stable = releases
        .filter(r => r.stable && compareGoVersion(r.version, GO_MIN_VERSION) >= 0)
        .sort((a, b) => compareGoVersion(b.version, a.version));
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
 *
 * @param {(phase: string, detail?: string) => void} [onProgress]
 * @returns {Promise<{ success: boolean, binPath: string|null, version: string|null, error?: string }>}
 */
async function installGoToolchain(onProgress) {
    const log = (phase, detail) => { try { (onProgress || (() => {}))(phase, detail); } catch (_e) { /* ignore */ } };
    const goRoot = path.join(GO_TOOLCHAIN_DIR, 'go');
    const goBin  = path.join(goRoot, 'bin', IS_WINDOWS ? 'go.exe' : 'go');

    fs.mkdirSync(GO_TOOLCHAIN_DIR, { recursive: true });

    let installed = null;
    if (fs.existsSync(goBin)) {
        installed = probeGoBinary(goBin, 'vendored');
    }

    let release;
    try {
        log('resolving', 'go.dev/dl');
        release = await resolveGoRelease();
    } catch (err) {
        if (installed?.meetsMinimum) {
            log('ready', installed.version);
            return { success: true, binPath: goBin, version: installed.version, reused: true };
        }
        return { success: false, binPath: null, version: null, error: `Cannot resolve Go release: ${err.message}` };
    }

    if (installed?.versionNumber && compareGoVersion(installed.versionNumber, release.version) >= 0) {
        log('ready', installed.version);
        return { success: true, binPath: goBin, version: installed.version, reused: true };
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
            await execPromise(`tar -xzf "${archivePath}" -C "${GO_TOOLCHAIN_DIR}"`, { timeout: 300000 });
        }

        try { fs.unlinkSync(archivePath); } catch (_e) { /* ignore */ }

        if (!fs.existsSync(goBin)) {
            return { success: false, binPath: null, version: null, error: 'Extraction succeeded but go binary not found' };
        }
        if (!IS_WINDOWS) {
            try { fs.chmodSync(goBin, 0o755); } catch (_e) { /* ignore */ }
        }

        const v = execSync(`"${goBin}" version`, { timeout: 5000, stdio: 'pipe' }).toString().trim();
        log('ready', v);
        return { success: true, binPath: goBin, version: v };
    } catch (err) {
        try { if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath); } catch (_e) { /* ignore */ }
        return { success: false, binPath: null, version: null, error: err.message || String(err) };
    }
}

/**
 * Deploy the compiled binary to the service installation path.
 * Creates a timestamped backup of the existing binary first.
 *
 * @param {string} builtBinaryPath  Path to the newly compiled binary
 * @param {string} targetPath       Service binary path
 * @returns {{ success: boolean, backupPath?: string, error?: string }}
 */
function deployServerBinary(builtBinaryPath, targetPath) {
    if (!builtBinaryPath || !fs.existsSync(builtBinaryPath)) {
        return { success: false, error: 'Compiled binary not found' };
    }
    if (!targetPath) {
        return { success: false, error: 'Target binary path not detected — set BETTERDESK_SERVER_BINARY env var' };
    }

    // Backup existing binary
    let backupPath = null;
    if (fs.existsSync(targetPath)) {
        backupPath = targetPath + '.bak.' + Date.now();
        try {
            fs.copyFileSync(targetPath, backupPath);
        } catch (err) {
            return { success: false, error: `Backup failed: ${err.message}` };
        }
    }

    // Atomic replace: write to staging file in same dir, then rename over the
    // target. On Linux, rename(2) replaces a running executable's directory
    // entry without touching the existing inode, so a live server keeps
    // running on the old image while the new one becomes available for the
    // next start (this avoids ETXTBSY which copyFileSync hits when the
    // target is busy). On Windows the running .exe is locked, so we first
    // rename the target out of the way, then move the new one in.
    const stagingPath = targetPath + '.new.' + process.pid + '.' + Date.now();
    try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(builtBinaryPath, stagingPath);
        if (!IS_WINDOWS) {
            try { fs.chmodSync(stagingPath, 0o755); } catch (_e) { /* ok */ }
        }

        if (IS_WINDOWS && fs.existsSync(targetPath)) {
            const lockedAside = targetPath + '.old.' + Date.now();
            try { fs.renameSync(targetPath, lockedAside); } catch (_e) { /* may fail if not locked */ }
        }

        try {
            fs.renameSync(stagingPath, targetPath);
        } catch (renameErr) {
            // Cross-device rename or other rename failure — fall back to copy
            // (still wraps the ETXTBSY case for non-Linux platforms or when
            // staging dir is on a different filesystem).
            try {
                fs.copyFileSync(stagingPath, targetPath);
                try { fs.unlinkSync(stagingPath); } catch (_e) { /* ok */ }
                if (!IS_WINDOWS) {
                    try { fs.chmodSync(targetPath, 0o755); } catch (_e) { /* ok */ }
                }
            } catch (copyErr) {
                throw renameErr.code === 'ETXTBSY' ? renameErr : copyErr;
            }
        }
        return { success: true, backupPath };
    } catch (err) {
        // Cleanup staging if it survived
        try { if (fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath); } catch (_e) { /* ok */ }
        // Attempt to restore backup on failure
        if (backupPath && fs.existsSync(backupPath) && !fs.existsSync(targetPath)) {
            try { fs.copyFileSync(backupPath, targetPath); } catch (_e) { /* critical */ }
        }
        return { success: false, error: `Deploy failed: ${err.message}` };
    }
}

/**
 * Determine the expected binary asset name for this platform+arch on GitHub Releases.
 * @returns {string}
 */
function getReleaseBinaryName() {
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    if (IS_WINDOWS) return `betterdesk-server-windows-${arch}.exe`;
    const os = process.platform === 'darwin' ? 'darwin' : 'linux';
    return `betterdesk-server-${os}-${arch}`;
}

/**
 * Check if a pre-built binary is available on GitHub Releases.
 * Looks for the latest release, then for a binary asset matching the current OS/arch.
 *
 * @returns {Promise<{ available: boolean, downloadUrl: string|null, releaseName: string|null, releaseTag: string|null, assetSize: number|null }>}
 */
async function checkPrebuiltAvailable() {
    try {
        const release = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`);
        if (!release || !release.assets || !release.assets.length) {
            return { available: false, downloadUrl: null, releaseName: null, releaseTag: null, assetSize: null };
        }

        const binaryName = getReleaseBinaryName();
        // Also check common alternative names (without os-arch suffix for Windows)
        const altNames = IS_WINDOWS
            ? [binaryName, 'betterdesk-server.exe']
            : [binaryName, `betterdesk-server-${process.platform === 'darwin' ? 'darwin' : 'linux'}`];

        const asset = release.assets.find(a =>
            altNames.some(name => a.name === name || a.name.toLowerCase() === name.toLowerCase())
        );

        if (asset) {
            return {
                available: true,
                downloadUrl: asset.browser_download_url,
                releaseName: release.name || release.tag_name,
                releaseTag: release.tag_name,
                assetSize: asset.size || null
            };
        }

        return { available: false, downloadUrl: null, releaseName: release.name, releaseTag: release.tag_name, assetSize: null };
    } catch (_e) {
        return { available: false, downloadUrl: null, releaseName: null, releaseTag: null, assetSize: null };
    }
}

/**
 * Download a pre-built binary from a URL.
 * Validates the download is non-empty and reasonable size.
 *
 * @param {string} downloadUrl
 * @returns {Promise<{ success: boolean, binaryPath: string|null, error?: string, size?: number }>}
 */
async function downloadPrebuiltBinary(downloadUrl) {
    if (!downloadUrl || typeof downloadUrl !== 'string' || !downloadUrl.startsWith('https://')) {
        return { success: false, binaryPath: null, error: 'Invalid download URL' };
    }

    const serverDir = COMPONENTS.server.localRoot;
    fs.mkdirSync(serverDir, { recursive: true });

    const binaryName = IS_WINDOWS ? 'betterdesk-server.exe' : 'betterdesk-server';
    const outputPath = path.join(serverDir, binaryName);

    try {
        const data = await new Promise((resolve, reject) => {
            const headers = { 'User-Agent': USER_AGENT, 'Accept': 'application/octet-stream' };
            if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;

            const follow = (target, redirects = 0) => {
                if (redirects > 5) return reject(new Error('Too many redirects'));
                const url = new URL(target);
                const mod = url.protocol === 'https:' ? https : require('http');
                const req = mod.get({ hostname: url.hostname, path: url.pathname + url.search, headers }, (res) => {
                    if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
                        return follow(res.headers.location, redirects + 1);
                    }
                    if (res.statusCode !== 200) {
                        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
                    }
                    const chunks = [];
                    res.on('data', c => chunks.push(c));
                    res.on('end', () => resolve(Buffer.concat(chunks)));
                });
                req.on('error', reject);
                req.setTimeout(120000, () => { req.destroy(); reject(new Error('Download timeout (120s)')); });
            };
            follow(downloadUrl);
        });

        // Sanity check: binary should be at least 1MB
        if (!data || data.length < 1024 * 1024) {
            return { success: false, binaryPath: null, error: `Downloaded file too small (${data ? data.length : 0} bytes) — likely not a valid binary` };
        }

        fs.writeFileSync(outputPath, data);
        if (!IS_WINDOWS) {
            try { fs.chmodSync(outputPath, 0o755); } catch (_e) { /* ok */ }
        }

        return { success: true, binaryPath: outputPath, size: data.length };
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
    const sourcePresent = fs.existsSync(path.join(COMPONENTS.server.localRoot || '', 'go.mod'));
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
async function getPrebuiltInfo() {
    return checkPrebuiltAvailable();
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
    const localVersion = getLocalVersion();
    const localSHA = getLocalSHA();
    const remote = await getRemoteHeadSHA();

    // No baseline yet → establish one
    if (!localSHA) {
        saveLocalSHA(remote.sha);
        return {
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
        };
    }

    // Already at HEAD
    if (localSHA.startsWith(remote.sha.slice(0, 7)) || remote.sha.startsWith(localSHA.slice(0, 7)) || localSHA === remote.sha) {
        return {
            localVersion,
            localSHA,
            remoteSHA: remote.sha,
            updateAvailable: false,
            commitsBehind: 0,
            latestMessage: remote.message,
            latestDate: remote.date,
            latestAuthor: remote.author,
            components: {}
        };
    }

    // Compare
    let compare;
    try {
        compare = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/compare/${localSHA}...${remote.sha}`);
    } catch (err) {
        // SHA may have been force-pushed away
        return {
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
        };
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

    return {
        localVersion,
        localSHA,
        remoteSHA: remote.sha,
        updateAvailable: files.length > 0,
        commitsBehind: compare.total_commits || (compare.commits || []).length,
        latestMessage: remote.message,
        latestDate: remote.date,
        latestAuthor: remote.author,
        components: componentSummary
    };
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

    const grouped = { console: [], server: [], agent: [], scripts: [], other: [] };

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
async function createPreUpdateBackup(allFiles) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(BACKUP_DIR, `pre-update-${ts}`);
    fs.mkdirSync(backupPath, { recursive: true });

    const localVersion = getLocalVersion();
    const localSHA = getLocalSHA();
    let backedUp = 0;

    for (const file of allFiles) {
        if (file.component !== 'console' || !file.localPath) continue;
        const src = path.join(ROOT_DIR, file.localPath);
        if (fs.existsSync(src)) {
            const dest = path.join(backupPath, file.localPath);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
            backedUp++;
        }
    }

    fs.writeFileSync(path.join(backupPath, 'manifest.json'), JSON.stringify({
        version: localVersion,
        sha: localSHA,
        timestamp: new Date().toISOString(),
        filesBackedUp: backedUp,
        files: allFiles.filter(f => f.component === 'console' && f.localPath).map(f => f.localPath)
    }, null, 2));

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
    if (_updateInProgress) throw new Error('Another update is already in progress');
    _updateInProgress = true;

    try {
    const { createBackup = true } = opts;
    const selectedComponents = getAutoUpdateComponents(changedData);

    let backupInfo = null;
    if (createBackup) {
        const allFiles = Object.values(changedData.grouped).flat();
        backupInfo = await createPreUpdateBackup(allFiles);
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
        for (const file of changedData.grouped.console) {
            try {
                if (file.status === 'removed') {
                    const localFile = path.join(ROOT_DIR, file.localPath);
                    if (isProtectedRuntimePath(localFile)) { results.skipped.push(file.path); continue; }
                    if (fs.existsSync(localFile)) { fs.unlinkSync(localFile); results.removed.push(file.path); }
                    continue;
                }
                if (/^(node_modules|test|tests)\//.test(file.localPath) || file.localPath === 'package-lock.json') {
                    results.skipped.push(file.path);
                    continue;
                }
                const dest = path.join(ROOT_DIR, file.localPath);
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
                results.failed.push({ file: file.path, error: err.message });
            }
        }
        // npm install when package.json changed
        if (changedData.grouped.console.some(f => f.localPath === 'package.json')) {
            try {
                execSync('npm install --omit=dev --no-audit --no-fund', { cwd: ROOT_DIR, timeout: 120000, stdio: 'pipe' });
                results.npmInstalled = true;
            } catch (_e) {
                results.failed.push({ file: 'npm install', error: 'npm install failed' });
            }
        }
        results.needsConsoleRestart = true;
    }

    // ---- Script / Docker files ----
    if (selectedComponents.includes('scripts') && changedData.grouped.scripts?.length) {
        for (const file of changedData.grouped.scripts) {
            try {
                if (file.status === 'removed') continue;
                const dest = path.join(PROJECT_ROOT, file.localPath);
                if (isProtectedRuntimePath(dest)) {
                    console.warn(`[UPDATE] Refusing to overwrite runtime state file: ${file.path}`);
                    results.skipped.push(file.path);
                    continue;
                }
                const content = await ghDownloadFile(GITHUB_OWNER, GITHUB_REPO, remoteSHA, file.path);
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.writeFileSync(dest, content);
                if (!IS_WINDOWS && file.localPath.endsWith('.sh')) {
                    try { fs.chmodSync(dest, 0o755); } catch (_e) { /* ok */ }
                }
                results.applied.push(file.path);
            } catch (err) {
                results.failed.push({ file: file.path, error: err.message });
            }
        }
    }

    // ---- Server source files + compile/download + deploy ----
    if (changedData.grouped.server?.length && selectedComponents.includes('server')) {
        const strategy = opts.serverStrategy || 'auto'; // 'auto', 'compile', 'download', 'install-go'
        let goInfo = checkGoAvailable();
        let goAvailable = goInfo.available && goInfo.meetsMinimum;
        let serverBinaryPath = null;
        let buildUsed = null;
        let preferredGoBinPath = null;
        let prebuiltInfo = null;

        const getPrebuiltOnce = async () => {
            if (!prebuiltInfo) prebuiltInfo = await checkPrebuiltAvailable();
            return prebuiltInfo;
        };

        // ---- Strategy: download Go toolchain on demand ----
        // Triggered explicitly ('install-go') or by auto-fallback (no Go + no
        // matching pre-built binary).
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
        } else if (strategy === 'auto' && !goAvailable) {
            // Auto-fallback: only attempt toolchain install if no pre-built
            // release is reachable. This keeps the default path light.
            try {
                const prebuilt = await getPrebuiltOnce();
                if (!prebuilt.available || !prebuilt.downloadUrl) {
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
            || (strategy === 'auto' && goAvailable);

        // Keep local Go server source in sync for every server update path.
        // Even when a pre-built binary is used, the next source build must not
        // start from stale files. Force a FULL source resync (issue #158): the
        // GitHub compare diff is capped at 300 files and can omit changed
        // dependency files, leaving the on-disk source inconsistent and
        // unbuildable. A full resync guarantees all callee files are present.
        try {
            const sourceResult = await ensureServerSource(remoteSHA, { force: true });
            console.log(`[UPDATE] Server source: strategy=${sourceResult.strategy}, files=${sourceResult.filesDownloaded}`);
        } catch (err) {
            results.failed.push({ file: 'server-source', error: `Source download failed: ${err.message}` });
        }

        const serverDir = COMPONENTS.server.localRoot;
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
                results.failed.push({ file: file.path, error: err.message });
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
            const prebuilt = await getPrebuiltOnce();

            if (prebuilt.available && prebuilt.downloadUrl) {
                downloadResult = await downloadPrebuiltBinary(prebuilt.downloadUrl);
            }

            // If release download failed, try direct raw download of the binary from the repo tree
            if (!downloadResult || !downloadResult.success) {
                const binaryName = IS_WINDOWS ? 'betterdesk-server.exe' : 'betterdesk-server-linux-amd64';
                const repoPath = `betterdesk-server/${binaryName}`;
                try {
                    console.log(`[UPDATE] Trying raw binary download from repo: ${repoPath}`);
                    const data = await ghDownloadFile(GITHUB_OWNER, GITHUB_REPO, remoteSHA, repoPath);
                    if (data && data.length > 1024 * 1024) {
                        const serverDir = COMPONENTS.server.localRoot;
                        fs.mkdirSync(serverDir, { recursive: true });
                        const outName = IS_WINDOWS ? 'betterdesk-server.exe' : 'betterdesk-server';
                        const outputPath = path.join(serverDir, outName);
                        fs.writeFileSync(outputPath, data);
                        if (!IS_WINDOWS) {
                            try { fs.chmodSync(outputPath, 0o755); } catch (_e) { /* ok */ }
                        }
                        downloadResult = { success: true, binaryPath: outputPath, size: data.length };
                    }
                } catch (_e) {
                    // Binary not in repo tree — expected
                }
            }

            if (downloadResult && downloadResult.success) {
                results.serverBuild = {
                    success: true,
                    duration: 0,
                    error: null,
                    method: 'download',
                    size: downloadResult.size || 0
                };
                serverBinaryPath = downloadResult.binaryPath;
                buildUsed = 'download';
            } else {
                const errMsg = downloadResult?.error || 'No pre-built binary available and Go not installed';
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
                method: buildUsed
            };

            if (deployResult.success) {
                const serviceConfig = sanitizeGoServerServiceConfig();
                results.serverServiceConfig = serviceConfig;
                if (serviceConfig.error) {
                    results.failed.push({
                        file: 'betterdesk-server.service',
                        error: `Service config cleanup failed: ${serviceConfig.error}`
                    });
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

    if (changedData.grouped.agent?.length) {
        for (const f of changedData.grouped.agent) {
            results.skipped.push(f.path + ' (agent — rebuild required)');
        }
    }

    // ---- Update SHA tracking ----
    // Separate critical failures (file download/write errors that leave the
    // local codebase in an inconsistent state) from non-critical ones (server
    // binary compilation/download unavailable — source files were still
    // applied, so the codebase is consistent, just the compiled binary is
    // missing and can be rebuilt later).
    //
    // Issue #154: When pre-built binaries are not available on GitHub
    // Releases and Go is not installed, the server binary step always
    // fails, preventing the SHA from ever being saved. This causes the
    // same update to be reported as available after every console restart,
    // creating an infinite update loop.
    const NON_CRITICAL_FILES = new Set([
        'betterdesk-server',          // binary compile/download failure
        'betterdesk-server-deploy',   // binary deployment failure
        'server-source',              // full source tree download failure (incremental still applied)
    ]);
    const criticalFailures = results.failed.filter(f => !NON_CRITICAL_FILES.has(f.file));
    const nonCriticalFailures = results.failed.filter(f => NON_CRITICAL_FILES.has(f.file));

    // Security visibility: if the Go server source changed (e.g. a go.mod
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
        console.warn(`[UPDATE] Server source updated but binary not rebuilt — running binary may be missing security fixes: ${detail}`);
    }

    if (criticalFailures.length === 0) {
        saveLocalSHA(remoteSHA);
        results.shaSaved = true;

        // ---- Pull remote VERSION file ----
        try {
            const versionContent = await ghDownloadFile(GITHUB_OWNER, GITHUB_REPO, remoteSHA, 'VERSION');
            fs.writeFileSync(path.join(PROJECT_ROOT, 'VERSION'), versionContent);
        } catch (_e) { /* non-critical */ }

        if (nonCriticalFailures.length > 0) {
            console.log(`[UPDATE] SHA saved despite ${nonCriticalFailures.length} non-critical failure(s): ${nonCriticalFailures.map(f => f.file).join(', ')}`);
        }
    } else {
        results.skipped.push('SHA tracking (critical update steps incomplete)');
    }

    return results;
    } finally {
        _updateInProgress = false;
    }
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
        return { success: false, service: serviceName, error: err.message };
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
            const dir = path.join(BACKUP_DIR, d);
            const mPath = path.join(dir, 'manifest.json');
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

/**
 * Recursively delete a directory. Refuses to delete anything outside
 * BACKUP_DIR to defend against path-traversal bugs upstream.
 */
function deleteBackup(name) {
    if (!isValidBackupName(name)) {
        throw new Error('Invalid backup name');
    }
    const target = path.resolve(BACKUP_DIR, name);
    const root = path.resolve(BACKUP_DIR);
    if (!target.startsWith(root + path.sep) && target !== root) {
        throw new Error('Backup path is outside the backup directory');
    }
    if (target === root) {
        throw new Error('Refusing to delete the backup directory itself');
    }
    if (!fs.existsSync(target)) {
        throw new Error('Backup not found');
    }
    fs.rmSync(target, { recursive: true, force: true });
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

/**
 * Restore console files from a pre-update backup and revert the SHA.
 */
function restoreFromBackup(backupName) {
    if (!isValidBackupName(backupName)) throw new Error('Invalid backup name');
    const backupPath = path.join(BACKUP_DIR, backupName);
    if (!fs.existsSync(backupPath)) throw new Error('Backup not found');

    const manifestPath = path.join(backupPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error('Invalid backup — missing manifest');

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    let restored = 0;
    for (const filePath of (manifest.files || [])) {
        const src = path.join(backupPath, filePath);
        const dest = path.join(ROOT_DIR, filePath);
        if (fs.existsSync(src)) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
            restored++;
        }
    }

    // Revert SHA to the pre-update value
    if (manifest.sha) saveLocalSHA(manifest.sha);

    return { restored, version: manifest.version, sha: manifest.sha, totalFiles: (manifest.files || []).length };
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

module.exports = {
    checkForUpdates,
    getChangedFiles,
    createPreUpdateBackup,
    applyUpdate,
    restartService,
    listBackups,
    deleteBackup,
    pruneBackups,
    restoreFromBackup,
    getLocalVersion,
    getLocalSHA,
    saveLocalSHA,
    getServerUpdateInfo,
    getPrebuiltInfo,
    installGoToolchain,
    checkGoAvailable,
    getServerBinaryStatus,
    rebuildServerBinary,
    COMPONENTS
};
