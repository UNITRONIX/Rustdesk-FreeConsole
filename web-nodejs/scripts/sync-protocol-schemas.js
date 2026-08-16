#!/usr/bin/env node
'use strict';

/**
 * The Go-server schemas are the single canonical source for the desktop-client
 * compatibility edge. The web copies are runtime artifacts fetched by the
 * browser protocol loader, so they are deliberately committed and checked for
 * byte-for-byte drift rather than hand-maintained.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const write = process.argv.includes('--write');
const repoRoot = path.resolve(__dirname, '..', '..');
const canonicalDir = path.join(repoRoot, 'betterdesk-server', 'protos');
const runtimeDir = path.join(repoRoot, 'web-nodejs', 'protos');
const schemaNames = ['message.proto', 'rendezvous.proto'];

async function main() {
    const drift = [];
    for (const name of schemaNames) {
        const source = path.join(canonicalDir, name);
        const output = path.join(runtimeDir, name);
        const contents = await fsp.readFile(source);
        let current = null;
        try {
            current = await fsp.readFile(output);
        } catch (err) {
            if (!err || err.code !== 'ENOENT') throw err;
        }
        if (current && Buffer.compare(contents, current) === 0) continue;
        if (write) {
            await fsp.mkdir(runtimeDir, { recursive: true });
            await fsp.writeFile(output, contents);
            console.log(`Generated ${path.relative(repoRoot, output)} from ${path.relative(repoRoot, source)}.`);
        } else {
            drift.push(name);
        }
    }
    if (drift.length) {
        console.error(
            `Protocol schema drift: ${drift.join(', ')}. ` +
            'Run: node web-nodejs/scripts/sync-protocol-schemas.js --write'
        );
        process.exit(1);
    }
    if (!write) console.log('Protocol runtime schemas match the canonical BetterDesk source.');
}

main().catch((err) => {
    console.error(`Protocol schema synchronization failed: ${err.message}`);
    process.exit(1);
});
