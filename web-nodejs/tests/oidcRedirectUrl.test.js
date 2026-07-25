'use strict';

const {
    isValidOidcRedirectUrl,
    parseOidcRedirectUrl,
    suggestOidcRedirectUrl,
} = require('../lib/oidcRedirectUrl');

describe('oidcRedirectUrl', () => {
    it('accepts panel and API callback paths', () => {
        expect(isValidOidcRedirectUrl('https://host:5443/api/auth/oidc/callback')).toBe(true);
        expect(isValidOidcRedirectUrl('http://host:21114/api/auth/oidc/callback')).toBe(true);
        expect(isValidOidcRedirectUrl('https://host:21121/api/oidc/callback')).toBe(true);
        expect(isValidOidcRedirectUrl('https://host/api/auth/oidc/callback/')).toBe(true);
    });

    it('rejects wrong path, scheme, or empty', () => {
        expect(isValidOidcRedirectUrl('')).toBe(false);
        expect(isValidOidcRedirectUrl('https://host:5443/login')).toBe(false);
        expect(isValidOidcRedirectUrl('https://host:5443/api/auth/oidc/session')).toBe(false);
        expect(isValidOidcRedirectUrl('ftp://host/api/auth/oidc/callback')).toBe(false);
        expect(parseOidcRedirectUrl('not a url').ok).toBe(false);
    });

    it('suggests panel callback URL', () => {
        expect(suggestOidcRedirectUrl('https://192.168.0.110:5443')).toBe(
            'https://192.168.0.110:5443/api/auth/oidc/callback'
        );
        expect(suggestOidcRedirectUrl('https://example.com/')).toBe(
            'https://example.com/api/auth/oidc/callback'
        );
        expect(suggestOidcRedirectUrl('')).toBe('');
    });
});
