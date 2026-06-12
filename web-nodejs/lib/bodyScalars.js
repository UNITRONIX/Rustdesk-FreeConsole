'use strict';

/**
 * Coerce request body fields to safe scalar types (arrays/objects rejected).
 */
function isPlainScalar(value) {
    return value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value);
}

/** Reject array bodies so `.length` / field access cannot be confused with array metadata. */
function plainBodyObject(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    return {};
}

function bodyString(value, fallback = '') {
    if (!isPlainScalar(value)) return fallback;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return fallback;
}

function bodyInt(value, fallback = 0, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
    if (!isPlainScalar(value)) return fallback;
    let n;
    if (typeof value === 'number' && Number.isFinite(value)) {
        n = Math.trunc(value);
    } else if (typeof value === 'string' && value.trim() !== '') {
        n = parseInt(value, 10);
    } else {
        n = fallback;
    }
    if (!Number.isFinite(n)) n = fallback;
    if (n < min) n = min;
    if (n > max) n = max;
    return n;
}

function bodyBool(value, fallback = false) {
    if (!isPlainScalar(value)) return fallback;
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 1 || value === '1') return true;
    if (value === 'false' || value === 0 || value === '0') return false;
    return fallback;
}

module.exports = {
    bodyString,
    bodyInt,
    bodyBool,
    plainBodyObject,
};
