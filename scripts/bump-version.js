#!/usr/bin/env node
'use strict';

/**
 * BetterDesk product version bump / verify (Tier 1 + Tier 2).
 *
 * Usage:
 *   node scripts/bump-version.js --patch
 *   node scripts/bump-version.js --minor
 *   node scripts/bump-version.js --set 3.1.0
 *   node scripts/bump-version.js --verify
 *   node scripts/bump-version.js --sync
 *   node scripts/bump-version.js --patch --dry-run
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const VERSION_FILE = path.join(REPO_ROOT, 'VERSION');
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

const FILE_RULES = [
    {
        id: 'version-file',
        path: 'VERSION',
        extract: (content) => content.trim(),
        apply: (content, version) => `${version}\n`,
    },
    {
        id: 'package-json',
        path: 'web-nodejs/package.json',
        extract: (content) => {
            const pkg = JSON.parse(content);
            return pkg.version;
        },
        apply: (content, version) => {
            const pkg = JSON.parse(content);
            pkg.version = version;
            return `${JSON.stringify(pkg, null, 2)}\n`;
        },
    },
    {
        id: 'betterdesk-sh',
        path: 'betterdesk.sh',
        extract: (content) => content.match(/^VERSION="([^"]+)"/m)?.[1],
        apply: (content, version) => {
            const fileVersion = content.match(/^VERSION="([^"]+)"/m)?.[1];
            if (!fileVersion || fileVersion === version) return content;
            return replaceAllLiteral(content, [
                [`VERSION="${fileVersion}"`, `VERSION="${version}"`],
                [`BetterDesk Console Manager v${fileVersion}`, `BetterDesk Console Manager v${version}`],
            ]);
        },
    },
    {
        id: 'betterdesk-ps1',
        path: 'betterdesk.ps1',
        extract: (content) => content.match(/^\$script:VERSION = "([^"]+)"/m)?.[1],
        apply: (content, version) => {
            const fileVersion = content.match(/^\$script:VERSION = "([^"]+)"/m)?.[1];
            if (!fileVersion || fileVersion === version) return content;
            return replaceAllLiteral(content, [
                [`$script:VERSION = "${fileVersion}"`, `$script:VERSION = "${version}"`],
                [`BetterDesk Console Manager v${fileVersion}`, `BetterDesk Console Manager v${version}`],
            ]);
        },
    },
    {
        id: 'betterdesk-docker-sh',
        path: 'betterdesk-docker.sh',
        extract: (content) => content.match(/^VERSION="([^"]+)"/m)?.[1],
        apply: (content, version) => {
            const fileVersion = content.match(/^VERSION="([^"]+)"/m)?.[1];
            if (!fileVersion || fileVersion === version) return content;
            return replaceAllLiteral(content, [
                [`VERSION="${fileVersion}"`, `VERSION="${version}"`],
                [`BetterDesk Console Manager v${fileVersion}`, `BetterDesk Console Manager v${version}`],
            ]);
        },
    },
    {
        id: 'readme-badge',
        path: 'README.md',
        extract: (content) => {
            const m = content.match(/img\.shields\.io\/badge\/version-([^-]+(?:--[^-]+)?)-/);
            if (!m) return null;
            return m[1].replace(/--/g, '-');
        },
        apply: (content, version) => {
            const m = content.match(/img\.shields\.io\/badge\/version-([^-]+(?:--[^-]+)?)-/);
            const fileVersion = m ? m[1].replace(/--/g, '-') : null;
            if (!fileVersion || fileVersion === version) return content;
            const badgeOld = fileVersion.replace(/-/g, '--');
            const badgeNew = version.replace(/-/g, '--');
            return content
                .replace(
                    new RegExp(`(img\\.shields\\.io\\/badge\\/version-)${escapeRegExp(badgeOld)}(-)`, 'g'),
                    `$1${badgeNew}$2`
                )
                .replace(
                    new RegExp(`(img\\.shields\\.io\\/badge\\/version-)${escapeRegExp(fileVersion)}(-)`, 'g'),
                    `$1${badgeNew}$2`
                );
        },
    },
    {
        id: 'dockerfile',
        path: 'Dockerfile',
        extract: (content) => content.match(/LABEL version="([^"]+)"/)?.[1],
        apply: (content, version) => {
            const fileVersion = content.match(/LABEL version="([^"]+)"/)?.[1];
            if (!fileVersion || fileVersion === version) return content;
            return content.replace(`LABEL version="${fileVersion}"`, `LABEL version="${version}"`);
        },
    },
    {
        id: 'dockerfile-server',
        path: 'Dockerfile.server',
        extract: (content) => content.match(/LABEL version="([^"]+)"/)?.[1],
        apply: (content, version) => {
            const fileVersion = content.match(/LABEL version="([^"]+)"/)?.[1];
            if (!fileVersion || fileVersion === version) return content;
            return content.replace(`LABEL version="${fileVersion}"`, `LABEL version="${version}"`);
        },
    },
    {
        id: 'dockerfile-console',
        path: 'Dockerfile.console',
        extract: (content) => content.match(/LABEL version="([^"]+)"/)?.[1],
        apply: (content, version) => {
            const fileVersion = content.match(/LABEL version="([^"]+)"/)?.[1];
            if (!fileVersion || fileVersion === version) return content;
            return content.replace(`LABEL version="${fileVersion}"`, `LABEL version="${version}"`);
        },
    },
    {
        id: 'docker-compose-quick',
        path: 'docker-compose.quick.yml',
        extract: (content) => {
            const m = content.match(/\$\{BETTERDESK_IMAGE_TAG:-([^}]+)\}/);
            return m?.[1];
        },
        apply: (content, version) =>
            content.replace(/\$\{BETTERDESK_IMAGE_TAG:-[^}]+\}/g, `\${BETTERDESK_IMAGE_TAG:-${version}}`),
    },
    {
        id: 'docker-compose-quick-single',
        path: 'docker-compose.quick.single.yml',
        extract: (content) => {
            const m = content.match(/\$\{BETTERDESK_IMAGE_TAG:-([^}]+)\}/);
            return m?.[1];
        },
        apply: (content, version) =>
            content.replace(/\$\{BETTERDESK_IMAGE_TAG:-[^}]+\}/g, `\${BETTERDESK_IMAGE_TAG:-${version}}`),
    },
    {
        id: 'docker-compose-quick-single-macvlan',
        path: 'docker-compose.quick.single.macvlan.yml',
        extract: (content) => {
            const m = content.match(/\$\{BETTERDESK_IMAGE_TAG:-([^}]+)\}/);
            return m?.[1];
        },
        apply: (content, version) =>
            content.replace(/\$\{BETTERDESK_IMAGE_TAG:-[^}]+\}/g, `\${BETTERDESK_IMAGE_TAG:-${version}}`),
    },
    {
        id: 'docker-compose-quick-macvlan',
        path: 'docker-compose.quick.macvlan.yml',
        extract: (content) => {
            const m = content.match(/\$\{BETTERDESK_IMAGE_TAG:-([^}]+)\}/);
            return m?.[1];
        },
        apply: (content, version) =>
            content.replace(/\$\{BETTERDESK_IMAGE_TAG:-[^}]+\}/g, `\${BETTERDESK_IMAGE_TAG:-${version}}`),
    },
    {
        id: 'docker-entrypoint',
        path: 'docker/entrypoint.sh',
        extract: (content) => content.match(/\$\{BETTERDESK_IMAGE_VERSION:-([^}]+)\}/)?.[1],
        apply: (content, version) => {
            const fileVersion = content.match(/\$\{BETTERDESK_IMAGE_VERSION:-([^}]+)\}/)?.[1];
            if (!fileVersion || fileVersion === version) return content;
            return content.replace(
                `\${BETTERDESK_IMAGE_VERSION:-${fileVersion}}`,
                `\${BETTERDESK_IMAGE_VERSION:-${version}}`
            );
        },
    },
    {
        id: 'docker-entrypoint-root',
        path: 'docker-entrypoint.sh',
        extract: (content) => content.match(/\$\{BETTERDESK_IMAGE_VERSION:-([^}]+)\}/)?.[1],
        apply: (content, version) => {
            const fileVersion = content.match(/\$\{BETTERDESK_IMAGE_VERSION:-([^}]+)\}/)?.[1];
            if (!fileVersion || fileVersion === version) return content;
            return content.replace(
                `\${BETTERDESK_IMAGE_VERSION:-${fileVersion}}`,
                `\${BETTERDESK_IMAGE_VERSION:-${version}}`
            );
        },
    },
    {
        id: 'betterdesk-server-version',
        path: 'betterdesk-server/VERSION',
        extract: (content) => content.trim(),
        apply: (_content, version) => `${version}\n`,
    },
    {
        id: 'betterdesk-server-productversion-embed',
        path: 'betterdesk-server/internal/productversion/VERSION',
        extract: (content) => content.trim(),
        apply: (_content, version) => `${version}\n`,
    },
];

const CHANGELOG_PATH = 'CHANGELOG.md';

function getManagedPaths() {
    const paths = FILE_RULES.map((rule) => rule.path);
    if (!paths.includes(CHANGELOG_PATH)) {
        paths.push(CHANGELOG_PATH);
    }
    return paths;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceAllLiteral(content, pairs) {
    let out = content;
    for (const [from, to] of pairs) {
        if (from && out.includes(from)) out = out.split(from).join(to);
    }
    return out;
}

function readCanonicalVersion() {
    if (!fs.existsSync(VERSION_FILE)) {
        throw new Error('VERSION file not found');
    }
    const version = fs.readFileSync(VERSION_FILE, 'utf8').trim();
    if (!SEMVER_RE.test(version)) {
        throw new Error(`Invalid VERSION file content: ${version}`);
    }
    return version;
}

function parseSemver(version) {
    const m = SEMVER_RE.exec(version);
    if (!m) throw new Error(`Invalid semver: ${version}`);
    return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function formatSemver(parts) {
    return `${parts.major}.${parts.minor}.${parts.patch}`;
}

function bumpPatch(version) {
    const p = parseSemver(version);
    p.patch += 1;
    return formatSemver(p);
}

function bumpMinor(version) {
    const p = parseSemver(version);
    p.minor += 1;
    p.patch = 0;
    return formatSemver(p);
}

function readRuleFile(rule) {
    const fullPath = path.join(REPO_ROOT, rule.path);
    if (!fs.existsSync(fullPath)) {
        return { fullPath, missing: true, content: '' };
    }
    return { fullPath, missing: false, content: fs.readFileSync(fullPath, 'utf8') };
}

function extractVersion(rule) {
    const file = readRuleFile(rule);
    if (file.missing) return { file: rule.path, missing: true, version: null };
    try {
        const version = rule.extract(file.content);
        return { file: rule.path, missing: false, version: version || null };
    } catch (err) {
        return { file: rule.path, missing: false, version: null, error: err.message };
    }
}

function updateChangelog(oldVersion, newVersion, dryRun) {
    const changelogPath = path.join(REPO_ROOT, 'CHANGELOG.md');
    if (!fs.existsSync(changelogPath)) return { changed: false, path: 'CHANGELOG.md' };

    let content = fs.readFileSync(changelogPath, 'utf8');
    const today = new Date().toISOString().slice(0, 10);
    const unreleasedHeader = '## [Unreleased]';
    const newReleaseHeader = `## [${newVersion}] — ${today}`;

    if (content.includes(newReleaseHeader)) {
        return { changed: false, path: 'CHANGELOG.md', skipped: true };
    }

    if (content.includes(unreleasedHeader)) {
        content = content.replace(unreleasedHeader, newReleaseHeader);
    } else {
        content = `${newReleaseHeader}\n\n### Changed\n- Version bump to ${newVersion}.\n\n---\n\n${content}`;
    }

    const compareAnchor = `[${newVersion}]: https://github.com/UNITRONIX/BetterDesk/compare/v${oldVersion}...v${newVersion}`;
    if (!content.includes(`[${newVersion}]:`)) {
        content = `${content.trimEnd()}\n${compareAnchor}\n`;
    }

    content = `## [Unreleased]\n\n### Changed\n- _(none yet)_\n\n---\n\n${content}`;

    if (!dryRun) {
        fs.writeFileSync(changelogPath, content, 'utf8');
    }
    return { changed: true, path: 'CHANGELOG.md' };
}

function applyVersionToFiles(newVersion, { dryRun = false } = {}) {
    const changed = [];
    for (const rule of FILE_RULES) {
        const file = readRuleFile(rule);
        if (file.missing) continue;
        const updated = rule.apply(file.content, newVersion);
        if (updated !== file.content) {
            changed.push(rule.path);
            if (!dryRun) {
                fs.writeFileSync(file.fullPath, updated, 'utf8');
            }
        }
    }
    return changed;
}

function applyVersion(newVersion, { dryRun = false } = {}) {
    const oldVersion = readCanonicalVersion();
    if (oldVersion === newVersion) {
        console.log(`Version already ${newVersion}; nothing to bump.`);
        return { oldVersion, newVersion, changed: [] };
    }

    const changed = applyVersionToFiles(newVersion, { dryRun });

    const changelog = updateChangelog(oldVersion, newVersion, dryRun);
    if (changelog.changed) changed.push(changelog.path);

    return { oldVersion, newVersion, changed, dryRun };
}

function syncDrift({ dryRun = false } = {}) {
    const canonical = readCanonicalVersion();
    const changed = applyVersionToFiles(canonical, { dryRun });
    return { canonical, changed, dryRun };
}

function verifyVersions() {
    const canonical = readCanonicalVersion();
    const mismatches = [];

    for (const rule of FILE_RULES) {
        const result = extractVersion(rule);
        if (result.missing) {
            mismatches.push({ file: result.file, expected: canonical, actual: '(missing file)' });
            continue;
        }
        if (result.error) {
            mismatches.push({ file: result.file, expected: canonical, actual: `(parse error: ${result.error})` });
            continue;
        }
        if (result.version !== canonical) {
            mismatches.push({ file: result.file, expected: canonical, actual: result.version ?? '(not found)' });
        }
    }

    if (mismatches.length) {
        console.error('Version mismatch detected (canonical VERSION = %s):', canonical);
        for (const row of mismatches) {
            console.error('  - %s: expected %s, got %s', row.file, row.expected, row.actual);
        }
        process.exit(1);
    }

    console.log('All Tier 1/2 version files match VERSION (%s).', canonical);
}

function printUsage() {
    console.log(`Usage: node scripts/bump-version.js [--patch | --minor | --set X.Y.Z] [--dry-run] [--verify] [--list-paths]

  --patch       Bump patch (+0.0.1)
  --minor       Bump minor (+0.1.0, reset patch)
  --set X.Y.Z   Set explicit version
  --verify      Exit 1 if Tier 1/2 files disagree with VERSION
  --sync        Align drifted Tier 1/2 files to canonical VERSION (no bump)
  --list-paths  Print managed file paths (one per line) for CI git add
  --dry-run     Print planned version without writing files`);
}

function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const verify = args.includes('--verify');
    const sync = args.includes('--sync');
    const listPaths = args.includes('--list-paths');

    if (listPaths) {
        for (const filePath of getManagedPaths()) {
            console.log(filePath);
        }
        return;
    }

    if (verify) {
        verifyVersions();
        return;
    }

    if (sync) {
        const result = syncDrift({ dryRun });
        const prefix = dryRun ? '[dry-run] ' : '';
        if (result.changed.length) {
            console.log(`${prefix}Synced drifted files to VERSION (${result.canonical}):`);
            for (const file of result.changed) console.log(`  - ${file}`);
        } else {
            console.log(`${prefix}All Tier 1/2 files already match VERSION (${result.canonical}).`);
        }
        return;
    }

    let newVersion = null;
    if (args.includes('--patch')) {
        newVersion = bumpPatch(readCanonicalVersion());
    } else if (args.includes('--minor')) {
        newVersion = bumpMinor(readCanonicalVersion());
    } else {
        const setIdx = args.indexOf('--set');
        if (setIdx !== -1 && args[setIdx + 1]) {
            newVersion = args[setIdx + 1].trim();
            if (!SEMVER_RE.test(newVersion)) {
                console.error('Invalid --set version (expected X.Y.Z):', newVersion);
                process.exit(1);
            }
        }
    }

    if (!newVersion) {
        printUsage();
        process.exit(1);
    }

    const result = applyVersion(newVersion, { dryRun });
    const prefix = dryRun ? '[dry-run] ' : '';
    console.log(`${prefix}Version ${result.oldVersion} → ${result.newVersion}`);
    if (result.changed.length) {
        console.log(`${prefix}Updated files:`);
        for (const file of result.changed) console.log(`  - ${file}`);
    } else {
        console.log(`${prefix}No file changes required.`);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    FILE_RULES,
    getManagedPaths,
    readCanonicalVersion,
    bumpPatch,
    bumpMinor,
    applyVersion,
    syncDrift,
    verifyVersions,
    SEMVER_RE,
};
