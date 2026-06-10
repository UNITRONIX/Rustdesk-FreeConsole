'use strict';

/**
 * Redact credentials and URL userinfo before writing to logs.
 */

function redactUrlForLog(rawUrl) {
    const value = String(rawUrl || '').trim();
    if (!value) return '';

    try {
        const parsed = new URL(value);
        parsed.username = '';
        parsed.password = '';
        return parsed.toString();
    } catch (_) {
        return value.replace(/\/\/[^/@]+@/, '//***@');
    }
}

function redactUsernameForLog(username) {
    const value = typeof username === 'string' ? username.trim() : '';
    if (!value) return '(empty)';
    if (value.length <= 2) return '***';
    return `${value[0]}***${value[value.length - 1]}`;
}

module.exports = {
    redactUrlForLog,
    redactUsernameForLog,
};
