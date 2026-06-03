#!/usr/bin/env node
'use strict';

/**
 * Write JSON substitution file for merge-env.js (safe for special chars in passwords/paths).
 * Reads BD_SUBST_* environment variables set by betterdesk.sh / betterdesk.ps1.
 *
 * Usage: node write-installer-env-subst.js /path/to/subst.json
 */

const fs = require('fs');

const KEYS = [
    'RUSTDESK_DIR', 'PUB_KEY_PATH', 'API_KEY_PATH', 'DB_TYPE', 'DB_PATH', 'DATABASE_URL',
    'DATA_DIR', 'GO_API_PORT', 'HBBS_API_URL', 'BETTERDESK_API_URL', 'API_PORT',
    'DEFAULT_ADMIN_PASSWORD', 'SESSION_SECRET', 'SSL_CERT_PATH', 'SSL_KEY_PATH'
];

const outPath = process.argv[2];
if (!outPath) {
    console.error('Usage: node write-installer-env-subst.js OUTPUT.json');
    process.exit(2);
}

const subs = {};
for (const key of KEYS) {
    subs[key] = process.env[`BD_SUBST_${key}`] || '';
}

fs.writeFileSync(outPath, JSON.stringify(subs), { mode: 0o600 });
