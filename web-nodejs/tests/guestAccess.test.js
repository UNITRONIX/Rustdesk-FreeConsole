/**
 * Guest access middleware / allowlist helpers
 */
const { peerAllowedByGrant, getGuestToken } = require('../middleware/guestAccess');

describe('guestAccess helpers', () => {
    test('peerAllowedByGrant checks allowlist', () => {
        expect(peerAllowedByGrant({ peer_ids: ['A', 'B'] }, 'A')).toBe(true);
        expect(peerAllowedByGrant({ peer_ids: ['A', 'B'] }, 'C')).toBe(false);
        expect(peerAllowedByGrant(null, 'A')).toBe(false);
    });

    test('getGuestToken reads query guest or t', () => {
        expect(getGuestToken({ query: { guest: 'abc' }, cookies: {} })).toBe('abc');
        expect(getGuestToken({ query: { t: 'xyz' }, cookies: {} })).toBe('xyz');
        expect(getGuestToken({ query: {}, cookies: { 'bd.guest': 'cookieTok' } })).toBe('cookieTok');
    });
});
