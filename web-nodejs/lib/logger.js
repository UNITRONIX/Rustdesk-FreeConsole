'use strict';

/**
 * BetterDesk Console — structured console logger with level gating and redaction.
 *
 * LOG_LEVEL: error | warn | info | debug (default: warn in production, info otherwise)
 */

const { sanitizeLogValue, redactUsernameForLog } = require('./logRedact');

const LEVEL_RANK = { error: 0, warn: 1, info: 2, debug: 3 };

function resolveLogLevel() {
    const raw = (process.env.LOG_LEVEL || '').trim().toLowerCase();
    if (raw && Object.prototype.hasOwnProperty.call(LEVEL_RANK, raw)) {
        return raw;
    }
    return process.env.NODE_ENV === 'production' ? 'warn' : 'info';
}

const activeLevel = resolveLogLevel();
const activeRank = LEVEL_RANK[activeLevel];

function formatPart(part) {
    const sanitized = sanitizeLogValue(part);
    if (typeof sanitized !== 'string') return sanitized;

    // Mask quoted usernames in common auth log patterns: for 'admin', user 'admin'
    return sanitized
        .replace(/(?:for|user|account|credentials for|local user|synced)\s+'([^']+)'/gi, (m, user) => {
            return m.replace(user, redactUsernameForLog(user));
        })
        .replace(/'([^']{2,64})'/g, (m, inner) => {
            // Heuristic: skip obvious non-usernames (paths, env flags)
            if (/[/\\.:]|^https?:|^BETTERDESK_|^LDAP\+|^Go server|^PBKDF2|^bcrypt/i.test(inner)) {
                return m;
            }
            if (/^(admin|operator|viewer|user|role|provider|hash type|empty|invalid)$/i.test(inner)) {
                return m;
            }
            if (/^[a-zA-Z0-9._@-]+$/.test(inner) && inner.length >= 2) {
                return `'${redactUsernameForLog(inner)}'`;
            }
            return m;
        });
}

function formatArgs(args) {
    return args.map(formatPart);
}

function write(level, prefix, args) {
    if (LEVEL_RANK[level] > activeRank) return;
    const line = prefix ? [`[${prefix}]`, ...formatArgs(args)] : formatArgs(args);
    if (level === 'error') {
        console.error(...line);
    } else if (level === 'warn') {
        console.warn(...line);
    } else {
        console.log(...line);
    }
}

function child(prefix) {
    return {
        error: (...args) => write('error', prefix, args),
        warn: (...args) => write('warn', prefix, args),
        info: (...args) => write('info', prefix, args),
        debug: (...args) => write('debug', prefix, args),
    };
}

module.exports = {
    level: activeLevel,
    error: (...args) => write('error', null, args),
    warn: (...args) => write('warn', null, args),
    info: (...args) => write('info', null, args),
    debug: (...args) => write('debug', null, args),
    child,
};
