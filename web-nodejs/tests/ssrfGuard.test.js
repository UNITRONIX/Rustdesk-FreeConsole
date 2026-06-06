'use strict';

const {
    isBlockedIp,
    assertSafeHostname,
    assertSafeResolvedHost,
    assertSafeHttpUrl,
    SsrfBlockedError,
} = require('../lib/ssrfGuard');

describe('ssrfGuard', () => {
    describe('isBlockedIp', () => {
        it('blocks loopback and RFC1918', () => {
            expect(isBlockedIp('127.0.0.1')).toBe(true);
            expect(isBlockedIp('10.0.0.1')).toBe(true);
            expect(isBlockedIp('192.168.1.1')).toBe(true);
            expect(isBlockedIp('169.254.169.254')).toBe(true);
        });

        it('allows public IPv4', () => {
            expect(isBlockedIp('8.8.8.8')).toBe(false);
            expect(isBlockedIp('1.1.1.1')).toBe(false);
        });

        it('allows RFC1918 in monitoring mode', () => {
            expect(isBlockedIp('192.168.1.1', { allowPrivate: true })).toBe(false);
            expect(isBlockedIp('10.0.0.1', { allowPrivate: true })).toBe(false);
            expect(isBlockedIp('127.0.0.1', { allowPrivate: true })).toBe(true);
        });
    });

    describe('assertSafeHostname', () => {
        it('rejects localhost', () => {
            expect(() => assertSafeHostname('localhost')).toThrow(SsrfBlockedError);
        });

        it('rejects private IPs', () => {
            expect(() => assertSafeHostname('10.0.0.5')).toThrow(SsrfBlockedError);
        });
    });

    describe('assertSafeHttpUrl', () => {
        it('rejects file and internal schemes', async () => {
            await expect(assertSafeHttpUrl('file:///etc/passwd')).rejects.toThrow(SsrfBlockedError);
            await expect(assertSafeHttpUrl('http://127.0.0.1/')).rejects.toThrow(SsrfBlockedError);
        });

        it('allows public http URLs for public IPs without DNS', async () => {
            const parsed = await assertSafeHttpUrl('http://1.1.1.1/');
            expect(parsed.hostname).toBe('1.1.1.1');
        });
    });

    describe('assertSafeResolvedHost', () => {
        it('accepts public IPs without DNS lookup', async () => {
            await expect(assertSafeResolvedHost('1.1.1.1')).resolves.toBe('1.1.1.1');
        });
    });
});
