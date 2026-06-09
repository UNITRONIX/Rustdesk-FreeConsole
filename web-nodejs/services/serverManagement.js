/**
 * BetterDesk Console — Server Management Service (BETA)
 *
 * Provides backend helpers for the Server Management panel:
 *   • Resource snapshots (CPU / memory / disk / load / uptime)
 *   • File browser (list, read, write, delete, rename, mkdir)
 *   • Service control (systemctl on Linux, sc.exe on Windows)
 *   • Audit logging of every privileged operation
 *
 * SECURITY:
 *   • All operations require RBAC `server.config` permission.
 *   • Service names are validated against a strict regex before being
 *     passed to spawned commands.
 *   • File operations resolve absolute paths and refuse symlink escapes
 *     out of allowlisted root directories when restricted mode is on.
 *   • Spawn arguments are passed as argv (never through a shell string)
 *     unless explicitly using `shell: true` for whitelisted utilities.
 *
 * STATUS: Beta — interface may evolve.
 */

'use strict';

const os = require('os');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { resolvePathWithinAnyRoot } = require('../lib/safePath');

const SERVICE_NAME_RE = /^[A-Za-z0-9_.@:-]{1,128}$/;
const FILE_MAX_BYTES = 8 * 1024 * 1024;        // 8 MB read/write cap
const READ_PREVIEW_BYTES = 256 * 1024;          // text preview cap for browser

const isLinux = process.platform === 'linux';
const isWindows = process.platform === 'win32';

// ─── Resource snapshots ───────────────────────────────────────────────────────

let lastCpuSample = null;
let metricHistory = []; // ring buffer of {ts, cpu, mem, swap}
const HISTORY_MAX = 120;

function readCpuTimes() {
    return os.cpus().map((c) => {
        const t = c.times;
        const total = t.user + t.nice + t.sys + t.idle + t.irq;
        return { idle: t.idle, total };
    });
}

function computeCpuPercent() {
    const cur = readCpuTimes();
    if (!lastCpuSample || lastCpuSample.length !== cur.length) {
        lastCpuSample = cur;
        return 0;
    }
    let totalDiff = 0;
    let idleDiff = 0;
    for (let i = 0; i < cur.length; i++) {
        totalDiff += cur[i].total - lastCpuSample[i].total;
        idleDiff += cur[i].idle - lastCpuSample[i].idle;
    }
    lastCpuSample = cur;
    if (totalDiff <= 0) return 0;
    return Math.max(0, Math.min(100, ((totalDiff - idleDiff) / totalDiff) * 100));
}

function safeExecSync(cmd, args, timeoutMs = 4000) {
    try {
        const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs });
        if (r.error || r.status !== 0) return '';
        return (r.stdout || '').trim();
    } catch (_) {
        return '';
    }
}

function readSwapInfo() {
    if (isLinux) {
        try {
            const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
            const swapTotalMatch = /SwapTotal:\s+(\d+)/.exec(meminfo);
            const swapFreeMatch = /SwapFree:\s+(\d+)/.exec(meminfo);
            if (swapTotalMatch) {
                const total = parseInt(swapTotalMatch[1], 10) * 1024;
                const free = swapFreeMatch ? parseInt(swapFreeMatch[1], 10) * 1024 : total;
                return { total, used: total - free, free };
            }
        } catch (_) { /* ignore */ }
    }
    return { total: 0, used: 0, free: 0 };
}

function listDisksSync() {
    const disks = [];
    if (isLinux) {
        const raw = safeExecSync('df', ['-B1', '--output=target,fstype,size,used,avail']);
        raw.split('\n').slice(1).forEach((line) => {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 5) return;
            const mount = parts[0];
            const fstype = parts[1];
            const size = parseInt(parts[2], 10);
            const used = parseInt(parts[3], 10);
            const avail = parseInt(parts[4], 10);
            // skip pseudo filesystems
            if (['tmpfs', 'devtmpfs', 'squashfs', 'overlay', 'proc', 'sysfs', 'cgroup', 'cgroup2', 'devpts', 'debugfs', 'tracefs', 'pstore', 'autofs', 'fusectl'].includes(fstype)) return;
            if (!size || size < 1024 * 1024) return;
            disks.push({ mount, fstype, size, used, avail });
        });
    } else if (isWindows) {
        const raw = safeExecSync('wmic', ['logicaldisk', 'where', 'DriveType=3', 'get', 'DeviceID,FileSystem,FreeSpace,Size', '/format:csv'], 8000);
        raw.split('\n').forEach((line) => {
            const parts = line.trim().split(',');
            if (parts.length >= 5 && parts[1]) {
                const mount = parts[1];
                const fstype = parts[2] || 'NTFS';
                const free = parseInt(parts[3], 10) || 0;
                const size = parseInt(parts[4], 10) || 0;
                if (!size) return;
                disks.push({ mount, fstype, size, used: size - free, avail: free });
            }
        });
    }
    return disks;
}

function readNetIfaces() {
    const ifs = os.networkInterfaces();
    const result = [];
    Object.keys(ifs).forEach((name) => {
        (ifs[name] || []).forEach((addr) => {
            if (addr.internal) return;
            result.push({
                name,
                family: addr.family,
                address: addr.address,
                mac: addr.mac,
                cidr: addr.cidr
            });
        });
    });
    return result;
}

function getResourceSnapshot() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const cpuPercent = computeCpuPercent();
    const swap = readSwapInfo();
    const sample = {
        ts: Date.now(),
        cpu: Math.round(cpuPercent * 10) / 10,
        mem: {
            total: totalMem,
            free: freeMem,
            used: totalMem - freeMem,
            percent: Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10
        },
        swap
    };

    metricHistory.push({ ts: sample.ts, cpu: sample.cpu, mem: sample.mem.percent });
    if (metricHistory.length > HISTORY_MAX) metricHistory = metricHistory.slice(-HISTORY_MAX);

    return {
        ...sample,
        load: os.loadavg(),
        uptime: os.uptime(),
        nodeUptime: process.uptime(),
        cpuCount: os.cpus().length,
        cpuModel: (os.cpus()[0] && os.cpus()[0].model) || 'unknown',
        platform: process.platform,
        arch: process.arch,
        hostname: os.hostname(),
        release: os.release(),
        nodeVersion: process.version,
        disks: listDisksSync(),
        network: readNetIfaces(),
        history: metricHistory.slice()
    };
}

// ─── File browser ─────────────────────────────────────────────────────────────

function getAllowedFileRoots() {
    const roots = new Set([
        path.resolve(process.env.BETTERDESK_PATH || '/opt/rustdesk'),
        path.resolve(process.env.BETTERDESK_CONSOLE_PATH || process.cwd()),
        path.resolve(os.homedir()),
        '/var/log',
        os.tmpdir(),
        '/tmp',
        '/var/tmp',
    ]);
    const extra = process.env.BETTERDESK_FILE_ALLOWED_ROOTS;
    if (extra) {
        for (const entry of extra.split(',')) {
            const trimmed = entry.trim();
            if (trimmed) roots.add(path.resolve(trimmed));
        }
    }
    return [...roots];
}

/**
 * Resolve a user-supplied path to an absolute path within allowed roots.
 * Rejects null bytes, empty strings, symlink escapes, and paths outside roots.
 */
function resolvePath(p) {
    return resolvePathWithinAnyRoot(p, getAllowedFileRoots());
}

async function listDirectory(dirPath) {
    const abs = resolvePath(dirPath);
    const stat = await fsp.stat(abs);
    if (!stat.isDirectory()) throw new Error('Not a directory');
    const entries = await fsp.readdir(abs, { withFileTypes: true });
    const items = [];
    for (const e of entries) {
        const full = path.join(abs, e.name);
        let st = null;
        try { st = await fsp.lstat(full); } catch (_) { /* permission denied etc. */ }
        items.push({
            name: e.name,
            path: full,
            isDirectory: st ? st.isDirectory() : e.isDirectory(),
            isFile: st ? st.isFile() : e.isFile(),
            isSymlink: st ? st.isSymbolicLink() : false,
            size: st ? st.size : 0,
            mtime: st ? st.mtime.toISOString() : null,
            mode: st ? (st.mode & 0o777) : null,
            uid: st ? st.uid : null,
            gid: st ? st.gid : null
        });
    }
    items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    return { path: abs, parent: path.dirname(abs), items };
}

async function readFilePreview(filePath) {
    const abs = resolvePath(filePath);
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw new Error('Not a regular file');
    if (st.size > FILE_MAX_BYTES) throw new Error('File too large for inline edit (>8 MB)');
    const fh = await fsp.open(abs, 'r');
    try {
        const sliceBytes = Math.min(st.size, READ_PREVIEW_BYTES);
        const buf = Buffer.alloc(sliceBytes);
        await fh.read(buf, 0, sliceBytes, 0);
        // crude binary detection: any null byte in slice
        const isBinary = buf.includes(0);
        let content = '';
        if (!isBinary) {
            content = buf.toString('utf8');
        }
        return {
            path: abs,
            size: st.size,
            mtime: st.mtime.toISOString(),
            mode: st.mode & 0o777,
            isBinary,
            truncated: st.size > sliceBytes,
            content
        };
    } finally {
        await fh.close();
    }
}

async function writeFile(filePath, content) {
    const abs = resolvePath(filePath);
    if (typeof content !== 'string') throw new Error('Content must be a string');
    if (Buffer.byteLength(content, 'utf8') > FILE_MAX_BYTES) {
        throw new Error('Content exceeds 8 MB limit');
    }
    await fsp.writeFile(abs, content, { encoding: 'utf8' });
    return { path: abs, size: Buffer.byteLength(content, 'utf8') };
}

async function deletePath(p) {
    const abs = resolvePath(p);
    if (abs === '/' || /^[A-Za-z]:\\?$/.test(abs)) {
        throw new Error('Refusing to delete filesystem root');
    }
    const st = await fsp.lstat(abs);
    if (st.isDirectory()) {
        await fsp.rm(abs, { recursive: true, force: false });
    } else {
        await fsp.unlink(abs);
    }
    return { path: abs };
}

async function makeDirectory(p) {
    const abs = resolvePath(p);
    await fsp.mkdir(abs, { recursive: false });
    return { path: abs };
}

async function renamePath(oldPath, newPath) {
    const a = resolvePath(oldPath);
    const b = resolvePath(newPath);
    await fsp.rename(a, b);
    return { from: a, to: b };
}

// ─── Services ─────────────────────────────────────────────────────────────────

const ALLOWED_SERVICE_ACTIONS_LINUX = new Set(['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'status']);
const ALLOWED_SERVICE_ACTIONS_WINDOWS = new Set(['start', 'stop', 'restart', 'status']);

function listServicesLinux() {
    // List loaded units of type service with state info
    const raw = safeExecSync('systemctl', ['list-units', '--type=service', '--all', '--no-legend', '--no-pager', '--plain'], 8000);
    const services = [];
    raw.split('\n').forEach((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) return;
        const unit = parts[0];
        const load = parts[1];
        const active = parts[2];
        const sub = parts[3];
        const description = parts.slice(4).join(' ');
        if (!unit.endsWith('.service')) return;
        services.push({ name: unit, load, active, sub, description });
    });
    return services;
}

function listServicesWindows() {
    const raw = safeExecSync('powershell', ['-NoProfile', '-Command', "Get-Service | Select-Object Name,Status,DisplayName | ConvertTo-Csv -NoTypeInformation"], 10000);
    const services = [];
    raw.split('\n').slice(1).forEach((line) => {
        const m = line.match(/^"([^"]*)","([^"]*)","([^"]*)"$/);
        if (m) {
            services.push({
                name: m[1],
                active: m[2].toLowerCase() === 'running' ? 'active' : 'inactive',
                sub: m[2].toLowerCase(),
                description: m[3]
            });
        }
    });
    return services;
}

function listServices() {
    if (isLinux) return listServicesLinux();
    if (isWindows) return listServicesWindows();
    return [];
}

function controlServiceLinux(name, action) {
    if (!SERVICE_NAME_RE.test(name)) throw new Error('Invalid service name');
    if (!ALLOWED_SERVICE_ACTIONS_LINUX.has(action)) throw new Error('Action not allowed');
    return new Promise((resolve) => {
        const child = spawn('systemctl', [action, name], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
        child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
        const t = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
        }, 15000);
        child.on('close', (code) => {
            clearTimeout(t);
            resolve({
                name,
                action,
                exitCode: code === null ? -1 : code,
                stdout: stdout.slice(-4096),
                stderr: stderr.slice(-4096)
            });
        });
    });
}

function controlServiceWindows(name, action) {
    if (!SERVICE_NAME_RE.test(name)) throw new Error('Invalid service name');
    if (!ALLOWED_SERVICE_ACTIONS_WINDOWS.has(action)) throw new Error('Action not allowed');
    let psAction = action === 'restart' ? 'Restart-Service' : action === 'start' ? 'Start-Service' : action === 'stop' ? 'Stop-Service' : 'Get-Service';
    return new Promise((resolve) => {
        const args = ['-NoProfile', '-Command', `${psAction} -Name '${name.replace(/'/g, "''")}' | Out-String`];
        const child = spawn('powershell', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
        child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
        const t = setTimeout(() => {
            try { child.kill(); } catch (_) { /* ignore */ }
        }, 20000);
        child.on('close', (code) => {
            clearTimeout(t);
            resolve({
                name,
                action,
                exitCode: code === null ? -1 : code,
                stdout: stdout.slice(-4096),
                stderr: stderr.slice(-4096)
            });
        });
    });
}

function controlService(name, action) {
    if (isLinux) return controlServiceLinux(name, action);
    if (isWindows) return controlServiceWindows(name, action);
    return Promise.reject(new Error('Service control not supported on this platform'));
}

module.exports = {
    SERVICE_NAME_RE,
    FILE_MAX_BYTES,
    getResourceSnapshot,
    listDirectory,
    readFilePreview,
    writeFile,
    deletePath,
    makeDirectory,
    renamePath,
    listServices,
    controlService
};
