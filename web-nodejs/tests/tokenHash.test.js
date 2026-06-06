'use strict';

const { hashAccessToken } = require('../lib/tokenHash');

describe('tokenHash', () => {
    it('produces stable SHA-256 hex for the same token', () => {
        const token = 'a'.repeat(64);
        expect(hashAccessToken(token)).toHaveLength(64);
        expect(hashAccessToken(token)).toBe(hashAccessToken(token));
    });

    it('differs for different tokens', () => {
        const a = hashAccessToken('a'.repeat(64));
        const b = hashAccessToken('b'.repeat(64));
        expect(a).not.toBe(b);
    });
});
