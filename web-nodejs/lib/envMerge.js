'use strict';

/**
 * Merge .env files for BetterDesk updates (issue #158).
 * On update: preserve every existing key; append only missing keys from template.
 * On fresh install: write full template (after substitution).
 */

const fs = require('fs');

/** Keys never overwritten when explicitly merging with overwritePaths (unused on update). */
const PROTECTED_KEYS = new Set([
    'SESSION_SECRET',
    'DEFAULT_ADMIN_PASSWORD',
    'DEFAULT_ADMIN_USERNAME',
    'DATABASE_URL',
    'DB_TYPE',
    'DB_PATH'
]);

/**
 * Parse .env content into ordered entries: { type: 'comment'|'blank'|'pair', key?, value?, raw? }
 */
function parseEnvLines(content) {
    const lines = String(content || '').split(/\r?\n/);
    const entries = [];
    const map = new Map();

    for (const raw of lines) {
        const trimmed = raw.trim();
        if (!trimmed) {
            entries.push({ type: 'blank', raw });
            continue;
        }
        if (trimmed.startsWith('#')) {
            entries.push({ type: 'comment', raw });
            continue;
        }
        const eq = raw.indexOf('=');
        if (eq === -1) {
            entries.push({ type: 'comment', raw });
            continue;
        }
        const key = raw.slice(0, eq).trim();
        const value = raw.slice(eq + 1);
        if (!key) {
            entries.push({ type: 'comment', raw });
            continue;
        }
        entries.push({ type: 'pair', key, value, raw });
        map.set(key, value);
    }
    return { entries, map };
}

/**
 * Apply __PLACEHOLDER__ substitutions to template text.
 * @param {string} text
 * @param {Record<string, string>} subs
 */
function applySubstitutions(text, subs = {}) {
    let out = text;
    for (const [key, val] of Object.entries(subs)) {
        const token = `__${key}__`;
        out = out.split(token).join(String(val ?? ''));
    }
    return out;
}

/**
 * Build substitution map for .env.example placeholders from existing .env and/or runtime config.
 * @param {object} [opts]
 * @param {string} [opts.existingContent]
 * @param {Map<string,string>} [opts.envMap]
 * @param {object} [opts.config] - BetterDesk config module export
 */
function buildEnvSubstitutions(opts = {}) {
    const envMap = opts.envMap || parseEnvLines(opts.existingContent || '').map;
    const config = opts.config || {};

    const pick = (key, ...fallbacks) => {
        const fromEnv = envMap.get(key);
        if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
        for (const fb of fallbacks) {
            if (fb !== undefined && fb !== null && fb !== '') return String(fb);
        }
        return '';
    };

    const rustdeskDir = pick('RUSTDESK_DIR', config.rustdeskDir, config.keysPath);
    const goPort = pick('GO_API_PORT', config.goApiPort, '21114');
    const apiPort = pick('API_PORT', config.apiPort, '21121');
    const dbType = pick('DB_TYPE', config.dbType, 'sqlite');
    const sslCert = pick('SSL_CERT_PATH', config.sslCertPath, rustdeskDir ? `${rustdeskDir}/ssl/betterdesk.crt` : '');
    const sslKey = pick('SSL_KEY_PATH', config.sslKeyPath, rustdeskDir ? `${rustdeskDir}/ssl/betterdesk.key` : '');

    const goApiBase = `http://localhost:${goPort}/api`;

    return {
        RUSTDESK_DIR: rustdeskDir,
        PUB_KEY_PATH: pick('PUB_KEY_PATH', config.pubKeyPath, rustdeskDir ? `${rustdeskDir}/id_ed25519.pub` : ''),
        API_KEY_PATH: pick('API_KEY_PATH', config.apiKeyPath, rustdeskDir ? `${rustdeskDir}/.api_key` : ''),
        DB_TYPE: dbType,
        DB_PATH: pick('DB_PATH', config.dbPath, rustdeskDir ? `${rustdeskDir}/db_v2.sqlite3` : ''),
        DATABASE_URL: pick('DATABASE_URL', config.databaseUrl, ''),
        DATA_DIR: pick('DATA_DIR', config.dataDir, ''),
        GO_API_PORT: String(goPort),
        HBBS_API_URL: pick('HBBS_API_URL', goApiBase),
        BETTERDESK_API_URL: pick('BETTERDESK_API_URL', goApiBase),
        API_PORT: String(apiPort),
        DEFAULT_ADMIN_PASSWORD: pick('DEFAULT_ADMIN_PASSWORD', ''),
        SESSION_SECRET: pick('SESSION_SECRET', config.sessionSecret, ''),
        SSL_CERT_PATH: sslCert,
        SSL_KEY_PATH: sslKey
    };
}

/**
 * Reject template values that still contain unresolved __PLACEHOLDER__ tokens.
 */
function assertResolvedSubstitutions(subs) {
    for (const [key, val] of Object.entries(subs)) {
        if (/__[^_]+__/.test(String(val))) {
            throw new Error(`Unresolved .env substitution for ${key}`);
        }
    }
}

/**
 * Merge template into existing .env (update mode).
 * Existing keys are never changed; missing keys are appended from template.
 * @param {string} existingContent
 * @param {string} templateContent
 * @returns {{ content: string, added: string[] }}
 */
function mergeEnv(existingContent, templateContent) {
    const existing = parseEnvLines(existingContent);
    const template = parseEnvLines(templateContent);
    const added = [];

    let content = existingContent;
    if (!content.endsWith('\n') && content.length) content += '\n';

    let pendingComment = '';
    for (const entry of template.entries) {
        if (entry.type === 'comment') {
            pendingComment += entry.raw + '\n';
            continue;
        }
        if (entry.type === 'blank') {
            pendingComment += entry.raw + '\n';
            continue;
        }
        if (existing.map.has(entry.key)) continue;

        if (pendingComment) {
            content += pendingComment;
            pendingComment = '';
        }
        content += `${entry.key}=${entry.value}\n`;
        added.push(entry.key);
    }

    return { content, added };
}

/**
 * Build full .env from template (fresh install).
 */
function buildFreshEnv(templateContent) {
    return templateContent.endsWith('\n') ? templateContent : templateContent + '\n';
}

/**
 * Upsert a single key in .env content (preserve comments and order).
 */
function upsertEnvKey(existingContent, key, value) {
    const safeValue = String(value ?? '');
    const lines = String(existingContent || '').split(/\r?\n/);
    let replaced = false;
    const out = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        const eq = line.indexOf('=');
        if (eq <= 0) return line;
        const lineKey = line.slice(0, eq).trim();
        if (lineKey !== key) return line;
        replaced = true;
        return `${key}=${safeValue}`;
    });
    let content = out.join('\n');
    if (!replaced) {
        if (content.length && !content.endsWith('\n')) content += '\n';
        content += `${key}=${safeValue}\n`;
    } else if (!content.endsWith('\n')) {
        content += '\n';
    }
    return content;
}

/**
 * Read template, apply substitutions, merge or replace target file.
 * @param {object} opts
 * @param {string} opts.targetPath - path to .env
 * @param {string} opts.templatePath - path to .env.example
 * @param {boolean} [opts.freshInstall=false]
 * @param {Record<string, string>} [opts.substitutions={}]
 */
function mergeEnvFile(opts) {
    const { targetPath, templatePath, freshInstall = false, substitutions = {} } = opts;
    if (!fs.existsSync(templatePath)) {
        throw new Error(`Template not found: ${templatePath}`);
    }
    assertResolvedSubstitutions(substitutions);
    const templateRaw = applySubstitutions(fs.readFileSync(templatePath, 'utf8'), substitutions);
    const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : '';

    if (freshInstall || !existing.trim()) {
        const content = buildFreshEnv(templateRaw);
        fs.writeFileSync(targetPath, content, { mode: 0o600 });
        return { mode: 'fresh', added: [...parseEnvLines(templateRaw).map.keys()] };
    }

    const { content, added } = mergeEnv(existing, templateRaw);
    fs.writeFileSync(targetPath, content, { mode: 0o600 });
    return { mode: 'merge', added };
}

module.exports = {
    PROTECTED_KEYS,
    parseEnvLines,
    applySubstitutions,
    buildEnvSubstitutions,
    assertResolvedSubstitutions,
    mergeEnv,
    buildFreshEnv,
    upsertEnvKey,
    mergeEnvFile
};
