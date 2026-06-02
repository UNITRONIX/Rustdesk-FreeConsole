/**
 * BetterDesk Console — Advanced configuration file editor
 *
 * Exposes a curated allowlist of server config files for in-panel editing.
 * All paths are resolved at runtime; callers must use file ids, never raw paths.
 */

'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const config = require('../config/config');
const updateService = require('./updateService');

const CONSOLE_ROOT = path.join(__dirname, '..');
const MAX_BYTES = 512 * 1024;

/** Which components to restart after editing a given file (console / server). */
const FILE_RESTART_COMPONENTS = {
    'console-env': ['console'],
    'console-env-local': ['console'],
    'go-blocklist': ['server'],
    'systemd-console': ['console'],
    'systemd-server': ['server']
};

const SYSTEMD_FILE_IDS = new Set(['systemd-console', 'systemd-server']);

/** @type {Array<{id: string, path: () => string, category: string, requiresRestart: string, canCreate?: boolean, platform?: string}>} */
const FILE_CATALOG = [
    {
        id: 'console-env',
        path: () => path.join(CONSOLE_ROOT, '.env'),
        category: 'console',
        requiresRestart: 'console'
    },
    {
        id: 'console-env-local',
        path: () => path.join(CONSOLE_ROOT, '.env.local'),
        category: 'console',
        requiresRestart: 'console',
        canCreate: true
    },
    {
        id: 'go-blocklist',
        path: () => path.join(config.keysPath, 'blocklist.txt'),
        category: 'goserver',
        requiresRestart: 'goserver',
        canCreate: true
    },
    {
        id: 'systemd-console',
        path: () => '/etc/systemd/system/betterdesk-console.service',
        category: 'system',
        requiresRestart: 'systemd',
        platform: 'linux'
    },
    {
        id: 'systemd-server',
        path: () => '/etc/systemd/system/betterdesk-server.service',
        category: 'system',
        requiresRestart: 'systemd',
        platform: 'linux'
    }
];

function getDefinition(id) {
    if (typeof id !== 'string' || !id.length) return null;
    return FILE_CATALOG.find((f) => f.id === id) || null;
}

function isPlatformAllowed(def) {
    if (!def.platform) return true;
    return process.platform === def.platform;
}

async function statEntry(def) {
    const abs = def.path();
    try {
        const st = await fsp.stat(abs);
        return {
            exists: true,
            size: st.size,
            mtime: st.mtime.toISOString(),
            readable: true,
            writable: await canWrite(abs, st)
        };
    } catch (err) {
        if (err.code === 'ENOENT') {
            return {
                exists: false,
                size: 0,
                mtime: null,
                readable: false,
                writable: !!def.canCreate
            };
        }
        return {
            exists: false,
            size: 0,
            mtime: null,
            readable: false,
            writable: false,
            error: err.message
        };
    }
}

async function canWrite(abs, st) {
    try {
        await fsp.access(abs, fs.constants.W_OK);
        return true;
    } catch (_) {
        if (st && st.isFile()) return false;
        const dir = path.dirname(abs);
        try {
            await fsp.access(dir, fs.constants.W_OK);
            return true;
        } catch (_) {
            return false;
        }
    }
}

/**
 * List catalog entries with filesystem metadata.
 */
async function listFiles() {
    const items = [];
    for (const def of FILE_CATALOG) {
        if (!isPlatformAllowed(def)) continue;
        const abs = def.path();
        const meta = await statEntry(def);
        items.push({
            id: def.id,
            path: abs,
            category: def.category,
            requiresRestart: def.requiresRestart,
            canCreate: !!def.canCreate,
            ...meta
        });
    }
    return items;
}

async function readFile(id) {
    const def = getDefinition(id);
    if (!def || !isPlatformAllowed(def)) {
        throw new Error('unknown_file');
    }
    const abs = path.resolve(def.path());
    let st;
    try {
        st = await fsp.stat(abs);
    } catch (err) {
        if (err.code === 'ENOENT') throw new Error('not_found');
        throw err;
    }
    if (!st.isFile()) throw new Error('not_a_file');
    if (st.size > MAX_BYTES) throw new Error('file_too_large');

    const buf = await fsp.readFile(abs);
    if (buf.includes(0)) throw new Error('binary_file');

    return {
        id: def.id,
        path: abs,
        size: st.size,
        mtime: st.mtime.toISOString(),
        requiresRestart: def.requiresRestart,
        content: buf.toString('utf8')
    };
}

async function writeBackup(abs) {
    try {
        if (!fs.existsSync(abs)) return null;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${abs}.bak.${stamp}`;
        await fsp.copyFile(abs, backupPath);
        return backupPath;
    } catch (_) {
        return null;
    }
}

async function writeFile(id, content) {
    const def = getDefinition(id);
    if (!def || !isPlatformAllowed(def)) {
        throw new Error('unknown_file');
    }
    if (typeof content !== 'string') throw new Error('invalid_content');

    const byteLen = Buffer.byteLength(content, 'utf8');
    if (byteLen > MAX_BYTES) throw new Error('file_too_large');

    const abs = path.resolve(def.path());
    let exists = false;
    try {
        const st = await fsp.stat(abs);
        if (!st.isFile()) throw new Error('not_a_file');
        exists = true;
        if (st.size > MAX_BYTES) throw new Error('file_too_large');
    } catch (err) {
        if (err.code === 'ENOENT') {
            if (!def.canCreate) throw new Error('not_found');
        } else {
            throw err;
        }
    }

    if (!exists && !def.canCreate) throw new Error('not_found');

    const access = await statEntry(def);
    if (!access.writable) throw new Error('not_writable');

    const backupPath = exists ? await writeBackup(abs) : null;

    const parent = path.dirname(abs);
    await fsp.mkdir(parent, { recursive: true });
    await fsp.writeFile(abs, content, { encoding: 'utf8', mode: 0o600 });

    const st = await fsp.stat(abs);
    return {
        id: def.id,
        path: abs,
        size: st.size,
        mtime: st.mtime.toISOString(),
        backupPath,
        requiresRestart: def.requiresRestart,
        created: !exists
    };
}

/**
 * Restart services related to a config file. Systemd unit edits run
 * daemon-reload first on Linux.
 */
function restartForFile(id) {
    const def = getDefinition(id);
    if (!def || !isPlatformAllowed(def)) {
        throw new Error('unknown_file');
    }
    const components = FILE_RESTART_COMPONENTS[id];
    if (!components || !components.length) {
        throw new Error('no_restart');
    }

    const result = {
        fileId: id,
        daemonReload: null,
        restarts: [],
        needsConsolePoll: false
    };

    if (SYSTEMD_FILE_IDS.has(id) && process.platform === 'linux') {
        result.daemonReload = updateService.daemonReload();
        if (!result.daemonReload.success) {
            return result;
        }
    }

    for (const key of components) {
        const comp = updateService.COMPONENTS[key];
        if (!comp || !comp.service) continue;
        const r = updateService.restartService(comp.service);
        result.restarts.push({ component: key, service: comp.service, ...r });
        if (key === 'console') result.needsConsolePoll = true;
    }

    return result;
}

module.exports = {
    MAX_BYTES,
    listFiles,
    readFile,
    writeFile,
    restartForFile,
    getDefinition
};
