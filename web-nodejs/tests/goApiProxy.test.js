'use strict';

const { safeSegment } = require('../lib/goApiProxy');

describe('goApiProxy', () => {
    test('safeSegment encodes valid RustDesk-style peer IDs', () => {
        expect(safeSegment('1192137448', 'deviceId')).toBe('1192137448');
        expect(safeSegment('peer-abc_1', 'deviceId')).toBe('peer-abc_1');
    });

    test('safeSegment rejects path-smuggling segments', () => {
        expect(() => safeSegment('foo/bar', 'orgId')).toThrow(/Invalid orgId/i);
        expect(() => safeSegment('..', 'orgId')).toThrow(/Invalid orgId/i);
    });
});
