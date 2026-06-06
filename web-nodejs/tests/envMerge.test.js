'use strict';

const { mergeEnv, applySubstitutions } = require('../lib/envMerge');

describe('envMerge', () => {
    it('preserves existing keys and appends missing template keys', () => {
        const existing = `# custom
MY_FEATURE=true
PORT=5000
SESSION_SECRET=keep-me
`;

        const template = applySubstitutions(`PORT=5000
HOST=0.0.0.0
TRUST_PROXY=false
SESSION_SECRET=__SESSION_SECRET__
`, { SESSION_SECRET: 'new-should-not-apply' });

        const { content, added } = mergeEnv(existing, template);
        expect(content).toContain('MY_FEATURE=true');
        expect(content).toContain('SESSION_SECRET=keep-me');
        expect(content).toContain('HOST=0.0.0.0');
        expect(content).toContain('TRUST_PROXY=false');
        expect(added).toContain('HOST');
        expect(added).toContain('TRUST_PROXY');
        expect(added).not.toContain('SESSION_SECRET');
    });
});
