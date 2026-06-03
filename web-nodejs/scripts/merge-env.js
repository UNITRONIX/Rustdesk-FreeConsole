#!/usr/bin/env node
'use strict';

/**
 * CLI: merge or create console .env from .env.example (issue #158).
 *
 * Usage:
 *   node scripts/merge-env.js --target /path/.env [--fresh] [--subst KEY=VALUE ...]
 *
 * Exit 0 on success; prints JSON summary to stdout.
 */

const fs = require('fs');
const path = require('path');
const { mergeEnvFile } = require('../lib/envMerge');

function usage() {
    console.error(`Usage: node merge-env.js --target PATH [--fresh] [--subst KEY=VALUE ...]`);
    process.exit(2);
}

function main() {
    const args = process.argv.slice(2);
    let targetPath = null;
    let freshInstall = false;
    const substitutions = {};

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--target' && args[i + 1]) {
            targetPath = args[++i];
        } else if (a === '--fresh') {
            freshInstall = true;
        } else if (a === '--subst-file' && args[i + 1]) {
            const filePath = args[++i];
            Object.assign(substitutions, JSON.parse(fs.readFileSync(filePath, 'utf8')));
        } else if (a === '--subst' && args[i + 1]) {
            const pair = args[++i];
            const eq = pair.indexOf('=');
            if (eq === -1) usage();
            substitutions[pair.slice(0, eq)] = pair.slice(eq + 1);
        } else if (a === '--help' || a === '-h') {
            usage();
        }
    }

    if (!targetPath) usage();

    const templatePath = path.join(__dirname, '..', '.env.example');
    try {
        const result = mergeEnvFile({
            targetPath,
            templatePath,
            freshInstall,
            substitutions
        });
        console.log(JSON.stringify({ success: true, ...result }));
    } catch (err) {
        console.error(JSON.stringify({ success: false, error: err.message }));
        process.exit(1);
    }
}

main();
