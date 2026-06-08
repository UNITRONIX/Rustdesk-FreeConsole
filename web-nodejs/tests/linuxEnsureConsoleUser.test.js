'use strict';

const {
    buildUpdateSudoersContent,
    resolveSystemctlPath,
    SVC_USER,
} = require('../scripts/linux-ensure-console-user');
const { resolveDeployScriptPath } = require('../lib/linuxServerBinaryDeploy');
const { ensureBindCapabilityInServiceUnit } = require('../lib/privilegedPorts');

describe('linux-ensure-console-user helpers', () => {
    test('buildUpdateSudoersContent references resolved binary paths', () => {
        const content = buildUpdateSudoersContent();
        expect(content).toContain('# Managed by BetterDesk linux-ensure-console-user.js');
        expect(content).toContain(`${SVC_USER} ALL=(root) NOPASSWD: ${resolveSystemctlPath()}`);
        expect(content).toMatch(/NOPASSWD: \/usr\/bin\/journalctl|NOPASSWD: \/bin\/journalctl/);
        expect(content).toContain('linux-deploy-server-binary.js');
    });

    test('resolveSystemctlPath returns an existing path when available', () => {
        const resolved = resolveSystemctlPath();
        expect(typeof resolved).toBe('string');
        expect(resolved.endsWith('systemctl')).toBe(true);
    });

    test('ensureBindCapabilityInServiceUnit inserts capability lines after User=', () => {
        const unit = [
            '[Service]',
            'User=betterdesk',
            'ExecStart=/usr/bin/node server.js',
        ].join('\n');
        const patched = ensureBindCapabilityInServiceUnit(unit);
        expect(patched.changed).toBe(true);
        expect(patched.content.indexOf('User=betterdesk')).toBeLessThan(
            patched.content.indexOf('AmbientCapabilities=CAP_NET_BIND_SERVICE')
        );
    });
});
