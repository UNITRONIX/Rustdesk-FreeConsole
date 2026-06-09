'use strict';

/**
 * Validate relative paths passed to the configured Go API client (axios baseURL).
 * Blocks absolute URLs and traversal — requests stay on BETTERDESK_API_URL host.
 */

const SAFE_API_SEGMENT = /^[a-zA-Z0-9._:@%+-]{1,256}$/;

function assertSafeGoApiRelativePath(urlPath) {
    if (typeof urlPath !== 'string' || urlPath.length === 0) {
        throw new Error('API path is required');
    }
    if (urlPath.includes('\\') || urlPath.includes('\0')) {
        throw new Error('Invalid API path');
    }
    if (/^https?:\/\//i.test(urlPath) || urlPath.startsWith('//')) {
        throw new Error('Absolute API URLs are not allowed');
    }

    const qIndex = urlPath.indexOf('?');
    const pathname = qIndex >= 0 ? urlPath.slice(0, qIndex) : urlPath;
    const query = qIndex >= 0 ? urlPath.slice(qIndex + 1) : '';

    if (!pathname.startsWith('/')) {
        throw new Error('API path must be relative to the configured Go API base URL');
    }
    if (pathname.includes('..')) {
        throw new Error('API path must not contain parent-directory segments');
    }

    for (const seg of pathname.split('/')) {
        if (seg === '.' || seg === '..') {
            throw new Error('Invalid API path segment');
        }
    }

    if (query && /[\r\n\0]/.test(query)) {
        throw new Error('Invalid query string');
    }

    return urlPath;
}

function assertSafeApiId(value, label = 'id') {
    const v = String(value || '').trim();
    if (!v || v === '.' || v === '..' || !SAFE_API_SEGMENT.test(v)) {
        throw new Error(`Invalid ${label}`);
    }
    return v;
}

module.exports = {
    assertSafeGoApiRelativePath,
    assertSafeApiId,
};
