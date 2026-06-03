/**
 * BetterDesk Console — server P2P / relay connection mode configuration.
 *
 * Persists global connection strategy via systemd Environment= lines or
 * docker-compose.yml server environment variables.
 */

'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const config = require('../config/config');
const updateService = require('./updateService');

const CONSOLE_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(CONSOLE_ROOT, '..');
const SYSTEMD_SERVER_UNIT = '/etc/systemd/system/betterdesk-server.service';
const DOCKER_COMPOSE_PATH = path.join(REPO_ROOT, 'docker-compose.yml');

const MANAGED_ENV_KEYS = ['P2P_FIRST', 'ALWAYS_USE_RELAY', 'P2P_FALLBACK_MS', 'SAME_NAT_RELAY'];

const DEFAULTS = {
    mode: 'p2p_first',
    p2p_fallback_ms: 2000,
    same_nat_relay: true
};

function isDockerRuntime() {
    return fs.existsSync('/.dockerenv') || process.env.DOCKER === 'true';
}

function systemdUnitExists() {
    try {
        return fs.existsSync(SYSTEMD_SERVER_UNIT);
    } catch (_) {
        return false;
    }
}

function dockerComposeExists() {
    try {
        return fs.existsSync(DOCKER_COMPOSE_PATH);
    } catch (_) {
        return false;
    }
}

/**
 * Detect where connection-mode settings should be read/written.
 * @returns {'systemd'|'docker'|'defaults'}
 */
function detectDeploymentSource() {
    if (systemdUnitExists() && !isDockerRuntime()) {
        return 'systemd';
    }
    if (dockerComposeExists() && (isDockerRuntime() || !systemdUnitExists())) {
        return 'docker';
    }
    if (systemdUnitExists()) {
        return 'systemd';
    }
    return 'defaults';
}

function yn(value) {
    return value ? 'Y' : 'N';
}

function parseYn(value, defaultValue) {
    if (value === undefined || value === null || value === '') return defaultValue;
    const v = String(value).trim().toUpperCase();
    if (['Y', 'YES', '1', 'TRUE', 'ON'].includes(v)) return true;
    if (['N', 'NO', '0', 'FALSE', 'OFF'].includes(v)) return false;
    return defaultValue;
}

function modeFromEnvVars(env) {
    const alwaysRelay = parseYn(env.ALWAYS_USE_RELAY, false);
    const p2pFirst = parseYn(env.P2P_FIRST, true);
    if (alwaysRelay) return 'relay_only';
    if (p2pFirst === false) return 'relay_only';
    return 'p2p_first';
}

function envVarsFromSettings(settings) {
    const mode = settings.mode === 'relay_only' ? 'relay_only' : 'p2p_first';
    const fallbackMs = Number(settings.p2p_fallback_ms);
    const sameNatRelay = settings.same_nat_relay !== false;

    if (mode === 'relay_only') {
        return {
            P2P_FIRST: 'N',
            ALWAYS_USE_RELAY: 'Y',
            P2P_FALLBACK_MS: String(Number.isFinite(fallbackMs) && fallbackMs >= 0 ? fallbackMs : DEFAULTS.p2p_fallback_ms),
            SAME_NAT_RELAY: yn(sameNatRelay)
        };
    }
    return {
        P2P_FIRST: 'Y',
        ALWAYS_USE_RELAY: 'N',
        P2P_FALLBACK_MS: String(Number.isFinite(fallbackMs) && fallbackMs >= 0 ? fallbackMs : DEFAULTS.p2p_fallback_ms),
        SAME_NAT_RELAY: yn(sameNatRelay)
    };
}

function parseSystemdEnvironment(content) {
    const env = {};
    const re = /^Environment=(.+)$/gm;
    let match;
    while ((match = re.exec(content)) !== null) {
        let line = match[1].trim();
        if ((line.startsWith('"') && line.endsWith('"')) || (line.startsWith("'") && line.endsWith("'"))) {
            line = line.slice(1, -1);
        }
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (MANAGED_ENV_KEYS.includes(key)) {
            env[key] = value;
        }
    }
    return env;
}

function patchSystemdEnvironment(content, vars) {
    const lines = content.split('\n');
    const managed = new Set(MANAGED_ENV_KEYS);
    const out = [];

    for (const line of lines) {
        const trimmed = line.trim();
        let skip = false;
        if (trimmed.startsWith('Environment=')) {
            let val = trimmed.slice('Environment='.length).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            }
            const key = val.split('=')[0];
            if (managed.has(key)) skip = true;
        }
        if (!skip) out.push(line);
    }

    const insertAt = out.findIndex((l) => l.trim().startsWith('[Service]'));
    let idx = insertAt >= 0 ? insertAt + 1 : out.length;
    while (idx < out.length && out[idx].trim() && !out[idx].trim().startsWith('[')) {
        if (out[idx].trim().startsWith('ExecStart=')) break;
        idx++;
    }

    const envLines = MANAGED_ENV_KEYS
        .filter((k) => vars[k] !== undefined && vars[k] !== '')
        .map((k) => `Environment=${k}=${vars[k]}`);

    out.splice(idx, 0, ...envLines);
    return out.join('\n');
}

function parseDockerComposeEnvironment(content) {
    const env = {};
    const lines = content.split('\n');
    let inServices = false;
    let inServer = false;
    let inEnvironment = false;
    let serverIndent = 0;

    for (const line of lines) {
        if (/^services:\s*$/.test(line)) {
            inServices = true;
            continue;
        }
        if (!inServices) continue;

        const serverMatch = line.match(/^(\s*)server:\s*$/);
        if (serverMatch) {
            inServer = true;
            inEnvironment = false;
            serverIndent = serverMatch[1].length;
            continue;
        }

        if (!inServer) continue;

        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
            const indent = line.match(/^(\s*)/)[1].length;
            if (indent <= serverIndent) {
                inServer = false;
                inEnvironment = false;
                continue;
            }
        }

        if (/^\s+environment:\s*$/.test(line)) {
            inEnvironment = true;
            continue;
        }

        if (inEnvironment && /^\s+-\s+/.test(line)) {
            const raw = line.replace(/^\s+-\s+/, '').trim();
            const eq = raw.indexOf('=');
            if (eq <= 0) continue;
            const key = raw.slice(0, eq).trim();
            let value = raw.slice(eq + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            if (value.includes('${')) continue;
            if (MANAGED_ENV_KEYS.includes(key)) {
                env[key] = value;
            }
            continue;
        }

        if (inEnvironment && trimmed && !/^\s+-\s+/.test(line)) {
            inEnvironment = false;
        }
    }
    return env;
}

function patchDockerComposeEnvironment(content, vars) {
    const lines = content.split('\n');
    let inServices = false;
    let inServer = false;
    let inEnvironment = false;
    let serverIndent = 0;
    let envStart = -1;
    let envEnd = -1;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^services:\s*$/.test(line)) {
            inServices = true;
            continue;
        }
        if (!inServices) continue;

        const serverMatch = line.match(/^(\s*)server:\s*$/);
        if (serverMatch) {
            inServer = true;
            inEnvironment = false;
            serverIndent = serverMatch[1].length;
            continue;
        }

        if (!inServer) continue;

        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
            const indent = line.match(/^(\s*)/)[1].length;
            if (indent <= serverIndent) {
                break;
            }
        }

        if (/^\s+environment:\s*$/.test(line)) {
            inEnvironment = true;
            envStart = i;
            envEnd = i + 1;
            continue;
        }

        if (inEnvironment && /^\s+-\s+/.test(line)) {
            envEnd = i + 1;
            continue;
        }

        if (inEnvironment && trimmed && !/^\s+-\s+/.test(line)) {
            break;
        }
    }

    if (envStart < 0) {
        throw new Error('docker_compose_server_not_found');
    }

    const out = lines.slice(0, envStart + 1);
    for (let i = envStart + 1; i < envEnd; i++) {
        const raw = lines[i].replace(/^\s+-\s+/, '').trim();
        const key = raw.split('=')[0];
        if (!MANAGED_ENV_KEYS.includes(key)) {
            out.push(lines[i]);
        }
    }
    for (const key of MANAGED_ENV_KEYS) {
        if (vars[key] !== undefined && vars[key] !== '') {
            out.push(`      - ${key}=${vars[key]}`);
        }
    }
    out.push(...lines.slice(envEnd));
    return out.join('\n');
}

function settingsFromEnv(env, source) {
    const mode = modeFromEnvVars(env);
    const fallbackRaw = env.P2P_FALLBACK_MS;
    let p2pFallbackMs = DEFAULTS.p2p_fallback_ms;
    if (fallbackRaw !== undefined && fallbackRaw !== '') {
        const n = parseInt(fallbackRaw, 10);
        if (Number.isFinite(n) && n >= 0) p2pFallbackMs = n;
    }
    return {
        mode,
        p2p_fallback_ms: p2pFallbackMs,
        same_nat_relay: parseYn(env.SAME_NAT_RELAY, DEFAULTS.same_nat_relay),
        source,
        writable: source !== 'defaults'
    };
}

async function readSystemdSettings() {
    const content = await fsp.readFile(SYSTEMD_SERVER_UNIT, 'utf8');
    return settingsFromEnv(parseSystemdEnvironment(content), 'systemd');
}

async function readDockerSettings() {
    const content = await fsp.readFile(DOCKER_COMPOSE_PATH, 'utf8');
    return settingsFromEnv(parseDockerComposeEnvironment(content), 'docker');
}

async function getConnectionMode() {
    const source = detectDeploymentSource();
    try {
        if (source === 'systemd') return await readSystemdSettings();
        if (source === 'docker') return await readDockerSettings();
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    return { ...DEFAULTS, source: 'defaults', writable: false };
}

async function writeSystemdSettings(settings) {
    const content = await fsp.readFile(SYSTEMD_SERVER_UNIT, 'utf8');
    const vars = envVarsFromSettings(settings);
    const next = patchSystemdEnvironment(content, vars);
    await fsp.writeFile(SYSTEMD_SERVER_UNIT, next, { encoding: 'utf8', mode: 0o644 });
    return { path: SYSTEMD_SERVER_UNIT, vars };
}

async function writeDockerSettings(settings) {
    const content = await fsp.readFile(DOCKER_COMPOSE_PATH, 'utf8');
    const vars = envVarsFromSettings(settings);
    const next = patchDockerComposeEnvironment(content, vars);
    await fsp.writeFile(DOCKER_COMPOSE_PATH, next, { encoding: 'utf8', mode: 0o644 });
    return { path: DOCKER_COMPOSE_PATH, vars };
}

async function setConnectionMode(settings) {
    const source = detectDeploymentSource();
    if (source === 'defaults') {
        throw new Error('not_configurable');
    }

    const normalized = {
        mode: settings.mode === 'relay_only' ? 'relay_only' : 'p2p_first',
        p2p_fallback_ms: Number(settings.p2p_fallback_ms),
        same_nat_relay: settings.same_nat_relay !== false
    };

    if (source === 'systemd') {
        return { ...(await writeSystemdSettings(normalized)), source: 'systemd', settings: normalized };
    }
    return { ...(await writeDockerSettings(normalized)), source: 'docker', settings: normalized };
}

function restartServer() {
    const source = detectDeploymentSource();
    const result = { source, daemonReload: null, restarts: [] };

    if (source === 'systemd') {
        result.daemonReload = updateService.daemonReload();
        if (!result.daemonReload.success) return result;
        const comp = updateService.COMPONENTS.server;
        const r = updateService.restartService(comp.service);
        result.restarts.push({ component: 'server', service: comp.service, ...r });
        return result;
    }

    if (source === 'docker') {
        try {
            const { execSync } = require('child_process');
            execSync('docker compose up -d server', {
                cwd: REPO_ROOT,
                timeout: 120000,
                stdio: 'pipe'
            });
            result.restarts.push({ component: 'server', service: 'betterdesk-server', success: true });
        } catch (err) {
            result.restarts.push({
                component: 'server',
                service: 'betterdesk-server',
                success: false,
                error: err.message
            });
        }
        return result;
    }

    throw new Error('no_restart');
}

module.exports = {
    DEFAULTS,
    MANAGED_ENV_KEYS,
    detectDeploymentSource,
    parseSystemdEnvironment,
    patchSystemdEnvironment,
    parseDockerComposeEnvironment,
    patchDockerComposeEnvironment,
    modeFromEnvVars,
    envVarsFromSettings,
    getConnectionMode,
    setConnectionMode,
    restartServer
};
