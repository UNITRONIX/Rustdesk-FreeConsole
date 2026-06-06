'use strict';

const { buildEnvSubstitutions, applySubstitutions, mergeEnv } = require('../lib/envMerge');

describe('buildEnvSubstitutions', () => {
    it('resolves template placeholders from existing env and config', () => {
        const existing = `PORT=5000
RUSTDESK_DIR=/opt/custom
SESSION_SECRET=keep-me
`;

        const subs = buildEnvSubstitutions({
            existingContent: existing,
            config: { goApiPort: 21114, apiPort: 21121, dataDir: '/app/data' }
        });

        expect(subs.RUSTDESK_DIR).toBe('/opt/custom');
        expect(subs.SESSION_SECRET).toBe('keep-me');
        expect(subs.GO_API_PORT).toBe('21114');
        expect(subs.HBBS_API_URL.includes('__')).toBe(false);

        const template = applySubstitutions(`TRUST_PROXY=false
HOST=0.0.0.0
SESSION_SECRET=__SESSION_SECRET__
`, subs);

        const { content, added } = mergeEnv(existing, template);
        expect(content).toContain('TRUST_PROXY=false');
        expect(content).toContain('HOST=0.0.0.0');
        expect(content).toContain('SESSION_SECRET=keep-me');
        expect(content).not.toContain('__SESSION_SECRET__');
        expect(added).toContain('TRUST_PROXY');
    });
});
