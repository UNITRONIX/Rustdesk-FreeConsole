#!/usr/bin/env node
/**
 * BetterDesk i18n audit
 *
 * Audits all active translation systems against the EN+PL key baseline and
 * reports structural gaps plus likely English fallback values. This script is
 * intentionally read-only: adding missing keys with English text would hide
 * untranslated UI behind a false 100% key coverage result.
 *
 * Usage:
 *   node web-nodejs/scripts/i18n-check.js
 *   node web-nodejs/scripts/i18n-check.js --system web-nodejs
 *   node web-nodejs/scripts/i18n-check.js --system agent-client
 *   node web-nodejs/scripts/i18n-check.js --system mgmt
 *   node web-nodejs/scripts/i18n-check.js --json
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REFERENCE_FILES = ['en.json', 'pl.json'];
const DEFAULT_SYSTEMS = [
    { id: 'web-nodejs', label: 'Web Console', dir: 'web-nodejs/lang' },
    { id: 'agent-client', label: 'Agent Client', dir: 'betterdesk-agent-client/src/locales' },
    { id: 'mgmt', label: 'MGMT Client', dir: 'betterdesk-mgmt/src/locales' }
];

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const verbose = args.includes('--verbose');
const systemArgIndex = args.indexOf('--system');
const requestedSystem = systemArgIndex >= 0 ? args[systemArgIndex + 1] : null;

if (args.includes('--fix')) {
    console.error('Automatic i18n --fix is disabled. Missing keys must be translated in the target language, not filled with English fallback text.');
    process.exit(2);
}

if (args.includes('--help') || args.includes('-h')) {
    console.log(`BetterDesk i18n audit\n\nUsage:\n  node web-nodejs/scripts/i18n-check.js [--system web-nodejs|agent-client|mgmt] [--json] [--verbose]\n\nChecks:\n  - EN and PL key parity\n  - every locale has the same EN+PL key baseline\n  - no empty values\n  - no likely English fallback values in non-English locales\n\nThe script is read-only. It never inserts English values into target locales.`);
    process.exit(0);
}

const ROOT_DIR = path.resolve(__dirname, '..', '..');

const SHARED_EXACT_VALUES = new Set([
    '',
    'OK',
    'ID',
    'API',
    'API Key',
    'API Keys',
    'Auto',
    'Automatic',
    'BETA',
    'Beta',
    'CDAP',
    'CPU',
    'DataGuard',
    'GPU',
    'HTTP',
    'HTTPS',
    'IoT',
    'JSON',
    'JWT',
    'LAN',
    'LDAP',
    'LDAPS (TLS)',
    'OIDC',
    'OAuth2',
    'RAM',
    'SCADA',
    'SDK',
    'SDK Studio',
    'SSO',
    'StartTLS',
    'TCP',
    'TLS',
    'TOTP',
    'UDP',
    'URL',
    'UTF-8',
    'WS',
    'WSS',
    'WebSocket',
    'Windows',
    'Linux',
    'macOS',
    'Node.js',
    'RustDesk',
    'BetterDesk',
    'BetterDesk MGMT',
    'Ctrl+Alt+Del',
    'Ctrl+K',
    'Wake on LAN',
    'OpenID Connect',
    'Active Directory',
    'Azure AD',
    'Okta',
    'Google',
    'Keycloak',
    'GitHub',
    'Docker',
    'PostgreSQL',
    'SQLite',
    'NSIS',
    'MSI',
    'AppImage'
]);

const SHARED_SHORT_TERMS = new Set([
    'Admin',
    'Agent',
    'Audit',
    'Chat',
    'Desktop',
    'Error',
    'Generator',
    'Info',
    'Login',
    'Logo',
    'Media',
    'Model',
    'Offline',
    'Online',
    'Operator',
    'Pro',
    'Status',
    'System',
    'Terminal',
    'Toolkit'
]);

const ALLOWED_IDENTICAL_KEY_PATTERNS = [
    /(^|\.)(id|lang|direction|flag|code|version|name|native_name)$/i,
    /(^|\.)(api_key|api_key_placeholder|api_key_hint|key_prefix|token|secret)$/i,
    /(^|\.)(platform|protocol|port|host|hostname|os|cpu|gpu|ram|disk|memory)$/i,
    /(^|\.)(ctrl_alt_del|totp_code|ldap_|oidc_|cdap_|sdk_)/i,
    /(^|\.)(filter_type_rustdesk|filter_type_scada|filter_type_iot)$/i
];

const ENGLISH_HINT = /\b(the|and|or|to|from|with|without|for|this|that|these|those|your|you|are|is|was|were|will|can|cannot|could|should|please|enter|select|search|loading|failed|successfully|required|available|enabled|disabled|device|devices|server|settings|management|dashboard|connection|connections|operator|operators|permission|permissions|password|username|language|translation|translations|configure|configuration|clipboard|screen|session|sessions|request|requests|history|metrics|automation|notification|notifications|delete|deleted|save|saved|create|created|update|updated|restart|shutdown|confirm|cancel|close|open|view|edit|back|next|finish|remote|toolbar|display|sync|ready|organization|organizations|member|members|policy|policies|group|groups|file|files|send|share|terminal|widget|widgets|overview|basics|tour|setup)\b/i;

function readJson(filePath) {
    const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(content);
}

function flattenKeys(obj, prefix = '', result = new Map()) {
    for (const [key, value] of Object.entries(obj || {})) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            flattenKeys(value, fullKey, result);
        } else {
            result.set(fullKey, String(value ?? ''));
        }
    }
    return result;
}

function isIgnoredExtra(key) {
    return key.startsWith('_meta.');
}

function isSharedExactValue(value) {
    const normalized = value.trim();
    return SHARED_EXACT_VALUES.has(normalized) || SHARED_SHORT_TERMS.has(normalized);
}

function isAllowedIdentical(key, value) {
    const normalized = value.trim();
    if (!/[A-Za-z]/.test(normalized)) return true;
    if (isSharedExactValue(normalized)) return true;
    if (/^[A-Z0-9_./:+ -]{1,14}$/.test(normalized)) return true;
    if (/^https?:\/\//i.test(normalized)) return true;
    if (/^\{\{?[A-Za-z0-9_]+\}?\}$/.test(normalized)) return true;
    if (/^[A-Za-z0-9_.-]+\.(json|db|sqlite3|exe|sh|ps1|dll|msi|nsi|nsh)$/i.test(normalized)) return true;
    return ALLOWED_IDENTICAL_KEY_PATTERNS.some(pattern => pattern.test(key));
}

function looksLikeEnglishFallback(key, value) {
    const normalized = value.trim();
    if (!normalized || !/[A-Za-z]/.test(normalized)) return false;
    if (isAllowedIdentical(key, normalized)) return false;
    if (ENGLISH_HINT.test(normalized)) return true;
    if (/\s/.test(normalized) && normalized.length >= 12) return true;
    if (/[.!?]$/.test(normalized) && normalized.length >= 8) return true;
    return false;
}

function auditSystem(system) {
    const dir = path.join(ROOT_DIR, system.dir);
    if (!fs.existsSync(dir)) {
        return { ...system, skipped: true, reason: `Directory not found: ${system.dir}` };
    }

    const files = fs.readdirSync(dir)
        .filter(file => file.endsWith('.json'))
        .sort();

    const referenceMaps = new Map();
    for (const refFile of REFERENCE_FILES) {
        const refPath = path.join(dir, refFile);
        if (!fs.existsSync(refPath)) {
            throw new Error(`${system.id}: missing reference file ${refFile}`);
        }
        referenceMaps.set(refFile, flattenKeys(readJson(refPath)));
    }

    const enKeys = referenceMaps.get('en.json');
    const plKeys = referenceMaps.get('pl.json');
    const baselineKeys = new Set([...enKeys.keys(), ...plKeys.keys()]);
    const enMissingVsPL = [...plKeys.keys()].filter(key => !enKeys.has(key));
    const plMissingVsEN = [...enKeys.keys()].filter(key => !plKeys.has(key));

    const rows = [];
    for (const file of files) {
        const filePath = path.join(dir, file);
        let data;
        try {
            data = readJson(filePath);
        } catch (error) {
            rows.push({
                file,
                parseError: error.message,
                keys: 0,
                missing: [],
                extra: [],
                ignoredExtra: [],
                empty: [],
                englishFallback: []
            });
            continue;
        }

        const localeKeys = flattenKeys(data);
        const localeKeySet = new Set(localeKeys.keys());
        const missing = [...baselineKeys].filter(key => !localeKeySet.has(key));
        const extraAll = [...localeKeySet].filter(key => !baselineKeys.has(key));
        const extra = extraAll.filter(key => !isIgnoredExtra(key));
        const ignoredExtra = extraAll.filter(isIgnoredExtra);
        const empty = [...baselineKeys].filter(key => localeKeySet.has(key) && localeKeys.get(key).trim() === '');
        const englishFallback = [];

        if (file !== 'en.json') {
            for (const [key, englishValue] of enKeys) {
                if (!baselineKeys.has(key) || !localeKeySet.has(key)) continue;
                const value = localeKeys.get(key);
                if (value === englishValue && looksLikeEnglishFallback(key, value)) {
                    englishFallback.push(key);
                }
            }
        }

        rows.push({
            file,
            keys: localeKeys.size,
            missing,
            extra,
            ignoredExtra,
            empty,
            englishFallback
        });
    }

    return {
        ...system,
        dir: system.dir,
        files: files.length,
        baselineCount: baselineKeys.size,
        enCount: enKeys.size,
        plCount: plKeys.size,
        enMissingVsPL,
        plMissingVsEN,
        rows
    };
}

function summarizeStatus(row) {
    if (row.parseError) return 'PARSE_ERROR';
    if (row.missing.length || row.extra.length || row.empty.length || row.englishFallback.length) return 'FAIL';
    return 'OK';
}

function printHuman(results) {
    console.log('\nBetterDesk i18n audit');
    console.log('Reference baseline: union of en.json and pl.json keys');
    console.log('English fallback check: exact EN values filtered through a technical-term allowlist\n');

    for (const result of results) {
        if (result.skipped) {
            console.log(`=== ${result.label} (${result.id}) ===`);
            console.log(`Skipped: ${result.reason}\n`);
            continue;
        }

        console.log(`=== ${result.label} (${result.dir}) ===`);
        console.log(`files=${result.files} baseline=${result.baselineCount} en=${result.enCount} pl=${result.plCount} en_missing_vs_pl=${result.enMissingVsPL.length} pl_missing_vs_en=${result.plMissingVsEN.length}`);
        if (result.enMissingVsPL.length) console.log(`  EN missing keys present in PL: ${result.enMissingVsPL.slice(0, 20).join(', ')}${result.enMissingVsPL.length > 20 ? ' ...' : ''}`);
        if (result.plMissingVsEN.length) console.log(`  PL missing keys present in EN: ${result.plMissingVsEN.slice(0, 20).join(', ')}${result.plMissingVsEN.length > 20 ? ' ...' : ''}`);

        const tableRows = result.rows.map(row => ({
            file: row.file,
            keys: row.keys,
            missing: row.missing.length,
            extra: row.extra.length,
            ignoredExtra: row.ignoredExtra.length,
            empty: row.empty.length,
            englishFallback: row.englishFallback.length,
            status: summarizeStatus(row)
        }));
        console.table(tableRows);

        for (const row of result.rows) {
            const status = summarizeStatus(row);
            if (status === 'OK' && !verbose) continue;
            console.log(`-- ${row.file}`);
            if (row.parseError) console.log(`  parse-error: ${row.parseError}`);
            if (row.missing.length) console.log(`  missing(${row.missing.length}): ${row.missing.slice(0, 30).join(', ')}${row.missing.length > 30 ? ' ...' : ''}`);
            if (row.extra.length) console.log(`  extra(${row.extra.length}): ${row.extra.slice(0, 30).join(', ')}${row.extra.length > 30 ? ' ...' : ''}`);
            if (row.ignoredExtra.length && verbose) console.log(`  ignored-extra(${row.ignoredExtra.length}): ${row.ignoredExtra.join(', ')}`);
            if (row.empty.length) console.log(`  empty(${row.empty.length}): ${row.empty.slice(0, 30).join(', ')}${row.empty.length > 30 ? ' ...' : ''}`);
            if (row.englishFallback.length) console.log(`  english-fallback(${row.englishFallback.length}): ${row.englishFallback.slice(0, 40).join(', ')}${row.englishFallback.length > 40 ? ' ...' : ''}`);
        }
        console.log('');
    }
}

function hasFailures(results) {
    return results.some(result => {
        if (result.skipped) return false;
        if (result.enMissingVsPL.length || result.plMissingVsEN.length) return true;
        return result.rows.some(row => summarizeStatus(row) !== 'OK');
    });
}

let systems = DEFAULT_SYSTEMS;
if (requestedSystem) {
    systems = DEFAULT_SYSTEMS.filter(system => system.id === requestedSystem);
    if (systems.length === 0) {
        console.error(`Unknown i18n system: ${requestedSystem}`);
        console.error(`Known systems: ${DEFAULT_SYSTEMS.map(system => system.id).join(', ')}`);
        process.exit(2);
    }
}

let results;
try {
    results = systems.map(auditSystem);
} catch (error) {
    console.error(`i18n audit failed: ${error.message}`);
    process.exit(1);
}

if (jsonMode) {
    console.log(JSON.stringify(results, null, 2));
} else {
    printHuman(results);
}

if (hasFailures(results)) {
    if (!jsonMode) {
        console.log('i18n audit failed: every active locale must match the EN+PL key baseline and must not contain English fallback text.');
    }
    process.exit(1);
}

if (!jsonMode) {
    console.log('i18n audit passed: all active locales have complete key coverage and no detected English fallback text.');
}