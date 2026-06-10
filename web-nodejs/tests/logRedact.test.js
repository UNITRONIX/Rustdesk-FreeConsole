'use strict';

const { redactUrlForLog, redactUsernameForLog } = require('../lib/logRedact');

describe('logRedact', () => {
    test('redactUrlForLog strips credentials', () => {
        expect(redactUrlForLog('https://user:secret@example.com/path'))
            .toBe('https://example.com/path');
    });

    test('redactUsernameForLog masks username', () => {
        expect(redactUsernameForLog('admin')).toBe('a***n');
        expect(redactUsernameForLog('')).toBe('(empty)');
    });
});
