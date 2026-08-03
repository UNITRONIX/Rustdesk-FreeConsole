'use strict';

const fs = require('fs');
const path = require('path');

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
 * @returns {string}
 */
function resolveSupportAgentSourceRoot(opts = {}) {
    const env = opts.env || process.env;
    if (env.AGENT_SOURCE_DIR) return env.AGENT_SOURCE_DIR;

    const exists = opts.existsSync || fs.existsSync;
    const consoleRoot = path.resolve(opts.consoleRoot || path.join(__dirname, '..'));
    const candidates = [
        path.join(consoleRoot, 'agent-source', 'betterdesk-support-agent'),
        '/opt/BetterDeskConsole/agent-source/betterdesk-support-agent',
        path.resolve(consoleRoot, '..', 'betterdesk-support-agent'),
        path.resolve(process.cwd(), 'betterdesk-support-agent'),
    ];

    const seen = new Set();
    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        if (exists(path.join(resolved, 'build.sh'))) return resolved;
    }
    // Default beside the running console (writable on normal Windows installs).
    return path.resolve(candidates[0]);
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
    resolveSupportAgentSourceRoot,
    agentSourceSiblingDirs,
    writeAgentSourceFileAtomic,
};
