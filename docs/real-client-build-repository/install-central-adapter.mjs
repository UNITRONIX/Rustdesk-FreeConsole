import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEMPLATE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const FILES = Object.freeze([
    ['decrypt-payload.mjs', '.betterdesk/decrypt-payload.mjs'],
    ['extract-build-input.mjs', '.betterdesk/extract-build-input.mjs'],
    ['verify-source-revision.mjs', '.betterdesk/verify-source-revision.mjs'],
    ['apply-source-patches.mjs', '.betterdesk/apply-source-patches.mjs'],
    ['sign-custom-config.mjs', '.betterdesk/sign-custom-config.mjs'],
    ['build-real-client.mjs', '.betterdesk/build-real-client.mjs'],
    ['validate-output.mjs', '.betterdesk/validate-output.mjs'],
    ['verify-central-repository.mjs', '.betterdesk/verify-central-repository.mjs'],
    ['real-client-build.yml', '.github/workflows/real-client-build.yml'],
]);
const VENDORS = Object.freeze([
    {
        url: 'https://github.com/rustdesk-org/RustDeskTempTopMostWindow.git',
        path: '.betterdesk/vendor/RustDeskTempTopMostWindow',
        commit: '53b548a5398624f7149a382000397993542ad796',
    },
    {
        url: 'https://github.com/flathub/shared-modules.git',
        path: '.betterdesk/vendor/flatpak-shared-modules',
        commit: '7b858d89ffe3bf9ce6e0390fe72691c9c5f322d3',
    },
]);

function fail(message) {
    throw new Error(message);
}

function git(root, args, options = {}) {
    const result = spawnSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        windowsHide: true,
        ...options,
    });
    if (result.status !== 0) {
        fail(`git ${args.join(' ')} failed: ${String(result.stderr || result.stdout).trim()}`);
    }
    return result.stdout.trim();
}

async function validateRustDeskRoot(directory) {
    const root = await fs.realpath(path.resolve(directory));
    const gitRoot = await fs.realpath(git(root, ['rev-parse', '--show-toplevel']));
    if (root !== gitRoot) fail('target path must be the root of the private RustDesk fork');
    for (const relative of ['Cargo.toml', 'build.py', 'flutter/pubspec.yaml']) {
        const stat = await fs.lstat(path.join(root, relative)).catch((error) => {
            if (error.code === 'ENOENT') fail(`target does not look like a RustDesk fork: ${relative} is missing`);
            throw error;
        });
        if (!stat.isFile() || stat.isSymbolicLink()) fail(`${relative} must be a regular file`);
    }
    return root;
}

async function equalFiles(left, right) {
    try {
        const [a, b] = await Promise.all([fs.readFile(left), fs.readFile(right)]);
        return a.equals(b);
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

async function atomicCopy(source, destination, force) {
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    if (await equalFiles(source, destination)) return 'unchanged';
    const exists = await fs.lstat(destination).then(() => true, (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
    });
    if (exists && !force) fail(`${destination} differs; review it and rerun with --force to replace it`);
    if (exists) {
        const stat = await fs.lstat(destination);
        if (!stat.isFile() || stat.isSymbolicLink()) fail(`${destination} is not a regular file`);
    }
    const temporary = `${destination}.betterdesk-${process.pid}.tmp`;
    await fs.copyFile(source, temporary);
    await fs.chmod(temporary, 0o600);
    try {
        await fs.rename(temporary, destination);
    } catch (error) {
        if (!exists || !['EEXIST', 'EPERM'].includes(error.code)) throw error;
        await fs.rm(destination);
        await fs.rename(temporary, destination);
    }
    return exists ? 'updated' : 'created';
}

async function installVendors(root) {
    for (const vendor of VENDORS) {
        const destination = path.join(root, vendor.path);
        const exists = await fs.lstat(destination).then(() => true, (error) => {
            if (error.code === 'ENOENT') return false;
            throw error;
        });
        if (!exists) git(root, ['submodule', 'add', vendor.url, vendor.path], { stdio: 'pipe' });
        const actualRemote = git(destination, ['remote', 'get-url', 'origin']);
        if (actualRemote !== vendor.url && actualRemote !== vendor.url.replace(/\.git$/, '')) {
            fail(`${vendor.path} has an unexpected origin: ${actualRemote}`);
        }
        git(destination, ['fetch', '--no-tags', '--depth=1', 'origin', vendor.commit], { stdio: 'pipe' });
        git(destination, ['checkout', '--detach', vendor.commit], { stdio: 'pipe' });
        git(root, ['add', '.gitmodules', vendor.path]);
    }
}

async function install(root, { force, initVendors }) {
    const dirty = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (dirty) fail('target RustDesk fork must be clean before installing the adapter');
    const changed = [];
    for (const [sourceName, destinationName] of FILES) {
        const result = await atomicCopy(path.join(TEMPLATE_ROOT, sourceName), path.join(root, destinationName), force);
        changed.push(`${result}: ${destinationName}`);
    }

    const dependabot = path.join(root, '.github/dependabot.yml');
    const hasDependabot = await fs.lstat(dependabot).then(() => true, (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
    });
    if (!hasDependabot) {
        changed.push(`${await atomicCopy(path.join(TEMPLATE_ROOT, 'dependabot.yml'), dependabot, false)}: .github/dependabot.yml`);
    } else if (!(await equalFiles(path.join(TEMPLATE_ROOT, 'dependabot.yml'), dependabot))) {
        changed.push('preserved: .github/dependabot.yml (merge the github-actions entry manually)');
    }

    if (initVendors) await installVendors(root);
    process.stdout.write(`${changed.join('\n')}\n`);
    if (!initVendors) {
        process.stdout.write('Vendor submodules were not changed. Rerun from a clean checkout with --init-vendors, then commit and use --check.\n');
    }
}

async function check(root) {
    for (const [sourceName, destinationName] of FILES) {
        if (!(await equalFiles(path.join(TEMPLATE_ROOT, sourceName), path.join(root, destinationName)))) {
            fail(`${destinationName} is missing or differs from this BetterDesk adapter release`);
        }
    }
    const verifier = path.join(root, '.betterdesk/verify-central-repository.mjs');
    const result = spawnSync(process.execPath, [verifier, root], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) fail(String(result.stderr || result.stdout).trim());
    process.stdout.write(result.stdout);
}

function usage() {
    return 'Usage: node install-central-adapter.mjs <rustdesk-fork-root> (--install [--force] [--init-vendors] | --check)';
}

try {
    const args = new Set(process.argv.slice(3));
    const directory = process.argv[2];
    const installMode = args.has('--install');
    const checkMode = args.has('--check');
    if (!directory || installMode === checkMode) fail(usage());
    for (const value of args) {
        if (!['--install', '--check', '--force', '--init-vendors'].includes(value)) fail(`Unknown option ${value}. ${usage()}`);
    }
    if (checkMode && (args.has('--force') || args.has('--init-vendors'))) fail('--force and --init-vendors are install-only options');
    const root = await validateRustDeskRoot(directory);
    if (installMode) await install(root, { force: args.has('--force'), initVendors: args.has('--init-vendors') });
    else await check(root);
} catch (error) {
    process.stderr.write(`Central adapter setup failed: ${error.message}\n`);
    process.exitCode = 1;
}
