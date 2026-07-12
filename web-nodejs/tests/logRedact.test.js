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

    test('sanitizeLogValue strips newlines', () => {
        const { sanitizeLogValue } = require('../lib/logRedact');
        expect(sanitizeLogValue('line1\nline2')).toBe('line1\\nline2');
    });

    test('redactAuditDetails masks username and secrets', () => {
        const { redactAuditDetails } = require('../lib/logRedact');
        expect(redactAuditDetails('Username: administrator')).toBe('Username: a***r');
        expect(redactAuditDetails('token=abc123')).toBe('token=***');
    });
});
