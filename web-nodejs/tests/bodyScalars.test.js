'use strict';

const { bodyString, bodyInt, bodyBool } = require('../lib/bodyScalars');

describe('bodyScalars', () => {
    test('bodyString rejects arrays', () => {
        expect(bodyString(['x'])).toBe('');
        expect(bodyString('ok')).toBe('ok');
    });

    test('bodyInt rejects arrays and clamps range', () => {
        expect(bodyInt(['1'], 0)).toBe(0);
        expect(bodyInt({ length: 42 }, 0)).toBe(0);
        expect(bodyInt('42', 0)).toBe(42);
        expect(bodyInt(999, 0, { max: 100 })).toBe(100);
    });

    test('bodyString rejects objects', () => {
        expect(bodyString({ x: 1 })).toBe('');
    });

    test('bodyBool handles common truthy/falsy values', () => {
        expect(bodyBool(true)).toBe(true);
        expect(bodyBool('false')).toBe(false);
        expect(bodyBool(['true'], false)).toBe(false);
    });
});
