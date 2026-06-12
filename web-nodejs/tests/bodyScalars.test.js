'use strict';

const { bodyString, bodyInt, bodyBool, plainBodyObject } = require('../lib/bodyScalars');

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

    test('plainBodyObject rejects array bodies', () => {
        expect(plainBodyObject({ path: '/tmp' })).toEqual({ path: '/tmp' });
        expect(plainBodyObject([1, 2, 3])).toEqual({});
        expect(plainBodyObject(null)).toEqual({});
        const body = plainBodyObject({ length: 42 });
        expect(bodyInt(body.length, 0, { max: 100 })).toBe(42);
        expect(bodyInt(plainBodyObject([1, 2, 3]).length, 99, { max: 100 })).toBe(99);
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
