'use strict';

const {
    buildUpdateSudoersContent,
    resolveSystemctlPath,
    SVC_USER,
} = require('../scripts/linux-ensure-console-user');

describe('linux-ensure-console-user helpers', () => {
    test('buildUpdateSudoersContent references resolved binary paths', () => {
        const content = buildUpdateSudoersContent();
        expect(content).toContain('# Managed by BetterDesk linux-ensure-console-user.js');
        expect(content).toContain(`${SVC_USER} ALL=(root) NOPASSWD: ${resolveSystemctlPath()}`);
        expect(content).toMatch(/NOPASSWD: \/usr\/bin\/journalctl|NOPASSWD: \/bin\/journalctl/);
    });

    test('resolveSystemctlPath returns an existing path when available', () => {
        const resolved = resolveSystemctlPath();
        expect(typeof resolved).toBe('string');
        expect(resolved.endsWith('systemctl')).toBe(true);
    });
});
