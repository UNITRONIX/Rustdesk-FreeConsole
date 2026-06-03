'use strict';

const assert = require('assert');
const { buildEnvSubstitutions, applySubstitutions, mergeEnv } = require('../lib/envMerge');

const existing = `PORT=5000
RUSTDESK_DIR=/opt/custom
SESSION_SECRET=keep-me
`;

const subs = buildEnvSubstitutions({
    existingContent: existing,
    config: { goApiPort: 21114, apiPort: 21121, dataDir: '/app/data' }
});

assert.strictEqual(subs.RUSTDESK_DIR, '/opt/custom');
assert.strictEqual(subs.SESSION_SECRET, 'keep-me');
assert.strictEqual(subs.GO_API_PORT, '21114');
assert(!subs.HBBS_API_URL.includes('__'), 'HBBS_API_URL resolved');

const template = applySubstitutions(`TRUST_PROXY=false
HOST=0.0.0.0
SESSION_SECRET=__SESSION_SECRET__
`, subs);

const { content, added } = mergeEnv(existing, template);
assert(content.includes('TRUST_PROXY=false'));
assert(content.includes('HOST=0.0.0.0'));
assert(content.includes('SESSION_SECRET=keep-me'));
assert(!content.includes('__SESSION_SECRET__'));
assert(added.includes('TRUST_PROXY'));

console.log('buildEnvSubstitutions tests passed');
