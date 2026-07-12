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

/** Strip control chars that enable log injection (CR/LF). */
function sanitizeLogValue(value) {
    if (value == null) return value;
    if (typeof value === 'string') {
        return value.replace(/[\r\n\u2028\u2029]/g, '\\n');
    }
    if (typeof value === 'object') {
        try {
            return JSON.parse(sanitizeLogValue(JSON.stringify(value)));
        } catch (_) {
            return value;
        }
    }
    return value;
}

const SENSITIVE_DETAIL_KEY = /password|secret|token|api[_-]?key|^key$/i;

/**
 * Redact sensitive fragments in audit_log.details free text before DB insert.
 */
function redactAuditDetails(details) {
    if (details == null || details === '') return details;
    let text = sanitizeLogValue(String(details));

    // "Username: alice" / "User: bob"
    text = text.replace(/\b(Username|User):\s*(\S+)/gi, (_, label, user) => {
        return `${label}: ${redactUsernameForLog(user)}`;
    });

    // key=value sensitive pairs
    text = text.replace(/(\b(?:password|secret|token|api_key|api-key|key)\s*[:=]\s*)(\S+)/gi, '$1***');

    return text;
}

module.exports = {
    redactUrlForLog,
    redactUsernameForLog,
    sanitizeLogValue,
    redactAuditDetails,
    SENSITIVE_DETAIL_KEY,
};
