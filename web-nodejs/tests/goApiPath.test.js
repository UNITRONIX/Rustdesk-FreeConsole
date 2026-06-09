'use strict';

const {
    assertSafeGoApiRelativePath,
    assertSafeApiId,
} = require('../lib/goApiPath');

describe('goApiPath', () => {
    test('accepts normal relative API paths', () => {
        expect(assertSafeGoApiRelativePath('/peers')).toBe('/peers');
        expect(assertSafeGoApiRelativePath('/org/acme/policy')).toBe('/org/acme/policy');
        expect(assertSafeGoApiRelativePath('/peers?id=1')).toBe('/peers?id=1');
    });

    test('rejects absolute and traversal paths', () => {
        expect(() => assertSafeGoApiRelativePath('http://evil.com/x')).toThrow();
        expect(() => assertSafeGoApiRelativePath('//evil.com/x')).toThrow();
        expect(() => assertSafeGoApiRelativePath('/org/../secrets')).toThrow();
        expect(() => assertSafeGoApiRelativePath('peers')).toThrow();
    });

    test('assertSafeApiId validates identifiers', () => {
        expect(assertSafeApiId('device-123', 'device')).toBe('device-123');
        expect(() => assertSafeApiId('../x', 'device')).toThrow();
    });
});
