#!/usr/bin/env node
'use strict';

/**
 * Dependency-free syntax gate for browser JavaScript. The console intentionally
 * uses classic script globals instead of a bundler, so Node's parser provides a
 * stable baseline without imposing module-only lint rules on legacy files.
 */

const { readdirSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');

const root = join(__dirname, '..', 'public', 'js');
const files = [];

function collect(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isDirectory()) collect(file);
        else if (entry.isFile() && entry.name.endsWith('.js')) files.push(file);
    }
}

collect(root);
const failures = [];

for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) failures.push(`${file}\n${result.stderr || result.stdout}`);
}

if (failures.length) {
    console.error(`Frontend syntax check failed in ${failures.length} file(s):\n${failures.join('\n')}`);
    process.exit(1);
}

console.log(`Frontend syntax check passed for ${files.length} browser scripts.`);
