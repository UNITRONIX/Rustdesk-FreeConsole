'use strict';

const assert = require('assert');
const { mergeEnv, applySubstitutions } = require('../lib/envMerge');

// Existing operator .env keeps custom keys and values.
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
assert(content.includes('MY_FEATURE=true'), 'custom key preserved');
assert(content.includes('SESSION_SECRET=keep-me'), 'session secret not overwritten');
assert(content.includes('HOST=0.0.0.0'), 'missing key appended');
assert(content.includes('TRUST_PROXY=false'), 'missing key appended');
assert(added.includes('HOST'), 'HOST reported as added');
assert(added.includes('TRUST_PROXY'), 'TRUST_PROXY reported as added');
assert(!added.includes('SESSION_SECRET'), 'SESSION_SECRET not re-added');

console.log('envMerge tests passed');
