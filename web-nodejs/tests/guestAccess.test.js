/**
 * Guest access middleware / allowlist helpers
 */
const {
    peerAllowedByGrant,
    getGuestToken,
    getGuestTokenFromQuery,
    getGuestTokenFromCookie,
    clearGuestCookie,
    GUEST_COOKIE,
} = require('../middleware/guestAccess');

describe('guestAccess helpers', () => {
    test('peerAllowedByGrant checks allowlist', () => {
        expect(peerAllowedByGrant({ peer_ids: ['A', 'B'] }, 'A')).toBe(true);
        expect(peerAllowedByGrant({ peer_ids: ['A', 'B'] }, 'C')).toBe(false);
        expect(peerAllowedByGrant(null, 'A')).toBe(false);
    });

    test('getGuestToken reads query guest or t before cookie', () => {
        expect(getGuestToken({ query: { guest: 'abc' }, cookies: {} })).toBe('abc');
        expect(getGuestToken({ query: { t: 'xyz' }, cookies: {} })).toBe('xyz');
        expect(getGuestToken({ query: {}, cookies: { [GUEST_COOKIE]: 'cookieTok' } })).toBe('cookieTok');
        expect(getGuestToken({
            query: { guest: 'fromQuery' },
            cookies: { [GUEST_COOKIE]: 'fromCookie' },
        })).toBe('fromQuery');
    });

    test('getGuestTokenFromQuery ignores cookie', () => {
        expect(getGuestTokenFromQuery({
            query: {},
            cookies: { [GUEST_COOKIE]: 'cookieTok' },
        })).toBe('');
        expect(getGuestTokenFromQuery({ query: { t: 'q' }, cookies: {} })).toBe('q');
    });

    test('getGuestTokenFromCookie ignores query', () => {
        expect(getGuestTokenFromCookie({
            query: { guest: 'q' },
            cookies: { [GUEST_COOKIE]: 'c' },
        })).toBe('c');
        expect(getGuestTokenFromCookie({ query: { guest: 'q' }, cookies: {} })).toBe('');
    });

    test('clearGuestCookie clears with matching path', () => {
        const cleared = [];
        const res = {
            clearCookie(name, opts) {
                cleared.push({ name, opts });
            },
        };
        clearGuestCookie(res);
        expect(cleared).toHaveLength(1);
        expect(cleared[0].name).toBe(GUEST_COOKIE);
        expect(cleared[0].opts.path).toBe('/');
    });
});

describe('remote-guest EJS bootstrap serialization', () => {
    test('guestMeta serializes outside template-literal interpolation', () => {
        const ejs = require('ejs');
        const fs = require('fs');
        const path = require('path');
        const tpl = fs.readFileSync(path.join(__dirname, '../views/remote-guest.ejs'), 'utf8');
        const guestMeta = {
            view_only: false,
            expires_at: '2026-07-21T00:00:00Z',
            label: 'lab`el ${x}',
            devices: [{ id: '6700120', hostname: 'DIAMOS `Serwer` 2', platform: 'windows' }],
        };
        const html = ejs.render(tpl, {
            title: 'Guest Remote',
            guestToken: 'tok`en${x}',
            guestMeta,
            _: (k) => k,
            lang: 'en',
            appName: 'BetterDesk',
            cacheVersion: '1',
            translations: {},
            user: null,
            branding: {},
            availableLanguageList: [],
            cspNonce: 'n',
        }, { filename: path.join(__dirname, '../views/remote-guest.ejs') });
        expect(html).toContain('window.__guestAccess =');
        expect(html).toContain('6700120');
        expect(html).toContain(JSON.stringify(guestMeta));
        expect(html).not.toMatch(/500 - Server Error/);
    });
});
