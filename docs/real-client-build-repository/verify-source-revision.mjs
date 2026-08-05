import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [planPath = '.betterdesk-build/input/build-plan.json', sourceRoot = 'rustdesk-source'] = process.argv.slice(2);
const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
const expected = String(plan.sourceCommit || '').toLowerCase();
if (plan.schema !== 'betterdesk-real-client-plan/v1' || !/^[0-9a-f]{40}$/.test(expected)) {
    throw new Error('Build plan does not contain a valid immutable source commit');
}

const root = path.resolve(sourceRoot);
const stat = await fs.lstat(root);
if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('RustDesk source root must be a real directory');

function git(...args) {
    return execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
    }).trim();
}

const actual = git('rev-parse', 'HEAD^{commit}').toLowerCase();
if (actual !== expected) {
    throw new Error(`RustDesk checkout identity mismatch (expected ${expected}, received ${actual})`);
}
const trackedChanges = git('status', '--porcelain', '--untracked-files=no');
if (trackedChanges) throw new Error('RustDesk source checkout is not clean before BetterDesk transformations');

process.stdout.write(`Verified immutable RustDesk source commit ${actual}.\n`);
