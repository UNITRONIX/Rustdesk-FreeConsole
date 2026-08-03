'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    resolveSupportAgentSourceRoot,
    agentSourceSiblingDirs,
    writeAgentSourceFileAtomic,
} = require('../lib/agentSourcePaths');

describe('agentSourcePaths', () => {
    test('defaults beside consoleRoot instead of /opt on empty trees', () => {
        const consoleRoot = path.join(os.tmpdir(), 'BetterDeskConsole-test');
        const resolved = resolveSupportAgentSourceRoot({
            consoleRoot,
            env: {},
            existsSync: () => false,
        });
        expect(resolved).toBe(path.resolve(consoleRoot, 'agent-source', 'betterdesk-support-agent'));
        expect(resolved.includes(`${path.sep}opt${path.sep}`)).toBe(false);
    });

    test('prefers existing console agent-source over Linux /opt path', () => {
        const consoleRoot = path.join(os.tmpdir(), 'BetterDeskConsole-pref');
        const preferred = path.join(consoleRoot, 'agent-source', 'betterdesk-support-agent');
        const resolved = resolveSupportAgentSourceRoot({
            consoleRoot,
            env: {},
            existsSync: (p) => p === path.join(preferred, 'build.sh'),
        });
        expect(resolved).toBe(path.resolve(preferred));
    });

    test('honors AGENT_SOURCE_DIR override', () => {
        const custom = path.join(os.tmpdir(), 'custom-support-agent');
        const resolved = resolveSupportAgentSourceRoot({
            consoleRoot: path.join(os.tmpdir(), 'BetterDeskConsole'),
            env: { AGENT_SOURCE_DIR: custom },
            existsSync: () => false,
        });
        expect(resolved).toBe(custom);
    });

    test('agentSourceSiblingDirs places agent + server under agent-source', () => {
        const support = path.join(os.tmpdir(), 'agent-source', 'betterdesk-support-agent');
        const dirs = agentSourceSiblingDirs(support);
        expect(dirs.agentLib).toBe(path.join(path.dirname(support), 'betterdesk-agent'));
        expect(dirs.serverLib).toBe(path.join(path.dirname(support), 'betterdesk-server'));
    });

    test('writeAgentSourceFileAtomic recovers from EPERM via chmod+unlink', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-agent-src-'));
        const dest = path.join(tmp, 'betterdesk-agent', 'README.md');
        let writes = 0;
        const err = Object.assign(new Error('EPERM: operation not permitted, open'), { code: 'EPERM' });

        await writeAgentSourceFileAtomic(dest, 'ok', {
            mkdir: async (p) => { fs.mkdirSync(p, { recursive: true }); },
            writeFile: async () => {
                writes += 1;
                if (writes === 1) throw err;
            },
            chmod: async () => {},
            unlink: async () => {},
        });

        expect(writes).toBe(2);
        fs.rmSync(tmp, { recursive: true, force: true });
    });
});
