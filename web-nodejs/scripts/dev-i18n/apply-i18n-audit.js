#!/usr/bin/env node
/**
 * Apply i18n audit translation patches to web-nodejs/lang/*.json
 *
 * Dev-only — not deployed to production consoles. Patches live in i18n-audit-data/.
 *
 * Usage (from repo root):
 *   npm run i18n:apply
 *   npm run i18n:apply -- --dry-run
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LANG_DIR = path.join(__dirname, '..', '..', 'lang');
const DATA_DIR = path.join(__dirname, 'i18n-audit-data');
const dryRun = process.argv.includes('--dry-run');

const westEu = require(path.join(DATA_DIR, 'west-eu.js'));
const southCentralEu = require(path.join(DATA_DIR, 'south-central-eu.js'));
const nordicEastern = require(path.join(DATA_DIR, 'nordic-eastern.js'));
const asiaRtl = require(path.join(DATA_DIR, 'asia-rtl.js'));
const gapFill = require(path.join(DATA_DIR, 'gap-fill.js'));
const enFallbackFixes = require(path.join(DATA_DIR, 'en-fallback-fixes.js'));
const orgDeviceGroups = require(path.join(DATA_DIR, 'org-device-groups.js'));

const ALL_PATCHES = { ...westEu, ...southCentralEu, ...nordicEastern, ...asiaRtl, ...gapFill };
const FORCE_PATCHES = { ...enFallbackFixes, ...orgDeviceGroups };

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

const UNSAFE_NESTED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function setNested(obj, dotPath, value) {
    const parts = dotPath.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (UNSAFE_NESTED_KEYS.has(p)) {
            throw new Error(`Unsafe key segment: ${p}`);
        }
        if (!cur[p] || typeof cur[p] !== 'object' || Array.isArray(cur[p])) {
            cur[p] = Object.create(null);
        }
        cur = cur[p];
    }
    const leaf = parts[parts.length - 1];
    if (UNSAFE_NESTED_KEYS.has(leaf)) {
        throw new Error(`Unsafe key segment: ${leaf}`);
    }
    cur[leaf] = value;
}

function collectPatchEntries(patch, prefix = '', entries = []) {
    for (const [key, value] of Object.entries(patch || {})) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            collectPatchEntries(value, fullKey, entries);
        } else {
            entries.push([fullKey, String(value ?? '')]);
        }
    }
    return entries;
}

function shouldApply(key, localeFlat, enFlat, localeCode) {
    if (!localeFlat.has(key)) return true;
    if (localeCode === 'en') return false;
    const current = localeFlat.get(key);
    const english = enFlat.get(key);
    if (english !== undefined && current === english) return true;
    return false;
}

function applyPatchToLocale(localeCode, patch, enFlat, forceAll = false) {
    const filePath = path.join(LANG_DIR, `${localeCode}.json`);
    if (!fs.existsSync(filePath)) {
        console.warn(`Skip missing locale file: ${localeCode}.json`);
        return { applied: 0, skipped: 0 };
    }

    const data = readJson(filePath);
    const localeFlat = flattenKeys(data);
    const entries = collectPatchEntries(patch);
    let applied = 0;
    let skipped = 0;

    for (const [key, value] of entries) {
        if (forceAll || shouldApply(key, localeFlat, enFlat, localeCode)) {
            setNested(data, key, value);
            applied++;
        } else {
            skipped++;
        }
    }

    if (!dryRun && applied > 0) {
        fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    }

    return { applied, skipped };
}

function fixPlEnglishFallbacks(enFlat) {
    const filePath = path.join(LANG_DIR, 'pl.json');
    const data = readJson(filePath);
    const localeFlat = flattenKeys(data);
    let applied = 0;

    const plLabels = {
        'settings.advanced_file_systemd-console': 'systemd: betterdesk-console (jednostka usługi)',
        'settings.advanced_file_systemd-server': 'systemd: betterdesk-server (jednostka usługi)',
        'settings.advanced_file_docker-supervisord': 'Docker: supervisord.conf (konfiguracja)',
        'settings.advanced_file_docker-compose': 'Docker: docker-compose.yml (orkiestracja)'
    };

    for (const [key, value] of Object.entries(plLabels)) {
        if (localeFlat.get(key) === enFlat.get(key)) {
            setNested(data, key, value);
            applied++;
        }
    }

    if (!dryRun && applied > 0) {
        fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    }

    return applied;
}

function main() {
    const enFlat = flattenKeys(readJson(path.join(LANG_DIR, 'en.json')));
    const plFlat = flattenKeys(readJson(path.join(LANG_DIR, 'pl.json')));
    const baseline = new Set([...enFlat.keys(), ...plFlat.keys()]);

    console.log(`Baseline keys: ${baseline.size}`);
    console.log(`Patch locales: ${Object.keys(ALL_PATCHES).sort().join(', ')}`);
    if (dryRun) console.log('DRY RUN — no files will be written\n');

    let totalApplied = 0;
    for (const [localeCode, patch] of Object.entries(ALL_PATCHES).sort()) {
        const { applied, skipped } = applyPatchToLocale(localeCode, patch, enFlat);
        totalApplied += applied;
        console.log(`${localeCode.padEnd(6)} applied=${applied} skipped=${skipped}`);
    }

    for (const [localeCode, patch] of Object.entries(FORCE_PATCHES).sort()) {
        const { applied } = applyPatchToLocale(localeCode, patch, enFlat, true);
        totalApplied += applied;
        if (applied) console.log(`${localeCode.padEnd(6)} fallback-fixes=${applied}`);
    }

    const plFixed = fixPlEnglishFallbacks(enFlat);
    if (plFixed) console.log(`pl     pl-fallback-fixes=${plFixed}`);

    console.log(`\nTotal applied: ${totalApplied}${dryRun ? ' (dry run)' : ''}`);
}

main();
