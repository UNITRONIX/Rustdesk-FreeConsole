'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Linux install default `/opt/BetterDeskConsole/...` resolves on Windows to
 * `C:\opt\BetterDeskConsole\...` (current drive + \opt\...). That tree is
 * usually unwritable by the console service account (EPERM).
 *
 * @param {string} filePath
 * @param {string} [platform]
 * @returns {boolean}
 */
function isWindowsLinuxOptTrap(filePath, platform = process.platform) {
    if (platform !== 'win32') return false;
    const norm = path.resolve(String(filePath || ''))
        .replace(/\//g, '\\')
        .toLowerCase();
    return /^[a-z]:\\opt\\betterdeskconsole(?:\\|$)/.test(norm);
}

/**
 * Resolve where the Support Agent build worker stages GitHub source trees.
 *
 * Prefer `<consoleRoot>/agent-source/betterdesk-support-agent` so Windows panel
 * installs (`C:\BetterDeskConsole`) never fall back to the Linux default
 * `/opt/...` (which becomes `C:\opt\BetterDeskConsole\...` and often hits EPERM).
 *
 * @param {object} [opts]
 * @param {string} [opts.consoleRoot]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {(p: string) => boolean} [opts.existsSync]
 * @param {string} [opts.platform]
 * @returns {string}
 */
function resolveSupportAgentSourceRoot(opts = {}) {
    const env = opts.env || process.env;
    const platform = opts.platform || process.platform;
    const exists = opts.existsSync || fs.existsSync;
    const consoleRoot = path.resolve(opts.consoleRoot || path.join(__dirname, '..'));
    const besideConsole = path.join(consoleRoot, 'agent-source', 'betterdesk-support-agent');

    if (env.AGENT_SOURCE_DIR) {
        const override = path.resolve(env.AGENT_SOURCE_DIR);
        // Stale NSSM/.env overrides from older Linux-path docs must not pin
        // Windows installs to the unwritable C:\opt\... tree.
        if (!isWindowsLinuxOptTrap(override, platform)) {
            return override;
        }
    }

    const candidates = [besideConsole];
    // Never probe /opt on Windows — orphan trees from older builds still have
    // build.sh and would otherwise win over an empty console agent-source/.
    if (platform !== 'win32') {
        candidates.push('/opt/BetterDeskConsole/agent-source/betterdesk-support-agent');
    }
    candidates.push(
        path.resolve(consoleRoot, '..', 'betterdesk-support-agent'),
        path.resolve(process.cwd(), 'betterdesk-support-agent'),
    );

    const seen = new Set();
    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        if (isWindowsLinuxOptTrap(resolved, platform)) continue;
        if (exists(path.join(resolved, 'build.sh'))) return resolved;
    }
    // Default beside the running console (writable on normal Windows installs).
    return path.resolve(besideConsole);
}

/**
 * Sibling trees under agent-source/ (or repo checkout) used by sync + builds.
 * @param {string} supportAgentRoot
 */
function agentSourceSiblingDirs(supportAgentRoot) {
    const base = path.dirname(path.resolve(supportAgentRoot));
    return {
        base,
        supportAgent: path.resolve(supportAgentRoot),
        agentLib: path.join(base, 'betterdesk-agent'),
        serverLib: path.join(base, 'betterdesk-server'),
    };
}

/**
 * Write agent-source file content, clearing Windows read-only / ACL traps that
 * surface as EPERM on open during overwrite.
 *
 * @param {string} dest
 * @param {Buffer|string} content
 * @param {{ mkdir?: Function, writeFile?: Function, chmod?: Function, unlink?: Function, platform?: string }} [deps]
 */
async function writeAgentSourceFileAtomic(dest, content, deps = {}) {
    const mkdir = deps.mkdir || ((p, o) => fs.promises.mkdir(p, o));
    const writeFile = deps.writeFile || ((p, c) => fs.promises.writeFile(p, c));
    const chmod = deps.chmod || ((p, m) => fs.promises.chmod(p, m));
    const unlink = deps.unlink || ((p) => fs.promises.unlink(p));

    await mkdir(path.dirname(dest), { recursive: true });
    try {
        await writeFile(dest, content);
        return;
    } catch (err) {
        if (!err || (err.code !== 'EPERM' && err.code !== 'EACCES')) throw err;
    }

    // Overwrite blocked (common on Windows when the previous sync left
    // read-only attributes, or when ACLs deny replace-in-place).
    try { await chmod(dest, 0o666); } catch (_) { /* may not exist yet */ }
    try { await unlink(dest); } catch (_) { /* ok if missing */ }
    await writeFile(dest, content);
}

module.exports = {
    isWindowsLinuxOptTrap,
    resolveSupportAgentSourceRoot,
    agentSourceSiblingDirs,
    writeAgentSourceFileAtomic,
};
