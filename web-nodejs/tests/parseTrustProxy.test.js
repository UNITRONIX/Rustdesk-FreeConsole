'use strict';

const express = require('express');
const { parseTrustProxy } = require('../lib/parseTrustProxy');

describe('parseTrustProxy', () => {
    it('defaults to false when unset', () => {
        expect(parseTrustProxy(undefined)).toBe(false);
        expect(parseTrustProxy('')).toBe(false);
    });

    it('maps common boolean strings to Express-safe values', () => {
        expect(parseTrustProxy('false')).toBe(false);
        expect(parseTrustProxy('true')).toBe(1);
        expect(parseTrustProxy('yes')).toBe(1);
        expect(parseTrustProxy('Y')).toBe(1);
    });

    it('passes numeric hop counts through', () => {
        expect(parseTrustProxy('2')).toBe(2);
    });

    it('passes Express keywords and CIDR values through', () => {
        expect(parseTrustProxy('loopback')).toBe('loopback');
        expect(parseTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
    });

    it('does not throw when applied to Express (issue #163)', () => {
        for (const raw of [undefined, 'false', 'true', '1', 'loopback']) {
            const app = express();
            expect(() => app.set('trust proxy', parseTrustProxy(raw))).not.toThrow();
        }
    });
});
