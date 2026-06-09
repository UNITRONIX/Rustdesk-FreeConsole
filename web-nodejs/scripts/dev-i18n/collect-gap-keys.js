#!/usr/bin/env node
/**
 * Collect missing / english-fallback keys from i18n-check into _gap-keys.json
 * for generate-gap-fill.js. Dev-only.
 *
 * Usage: npm run i18n:gap-collect
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const auditScript = path.join(__dirname, '..', 'i18n-check.js');
const outPath = path.join(__dirname, 'i18n-audit-data', '_gap-keys.json');

const result = spawnSync(process.execPath, [auditScript, '--system', 'web-nodejs', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
});

if (!result.stdout) {
    console.error(result.stderr || 'i18n-check produced no output');
    process.exit(1);
}

const parsed = JSON.parse(result.stdout);
const web = parsed.find((entry) => entry.id === 'web-nodejs') || parsed[0];
if (!web || !web.rows) {
    console.error('Unexpected i18n-check JSON shape');
    process.exit(1);
}

const missingByLocale = {};
for (const row of web.rows) {
    const locale = row.file.replace(/\.json$/, '');
    missingByLocale[locale] = [...new Set([...(row.missing || []), ...(row.englishFallback || [])])];
}

fs.writeFileSync(outPath, `${JSON.stringify({ missingByLocale }, null, 2)}\n`, 'utf8');
console.log(`Wrote ${outPath}`);
for (const [locale, keys] of Object.entries(missingByLocale).sort()) {
    if (keys.length) console.log(`  ${locale}: ${keys.length} keys`);
}
