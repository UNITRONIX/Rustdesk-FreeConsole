/**
 * Resolve the hostname/IP shown in RustDesk client configuration.
 * Clients must reach the server on a public or LAN-routable address, which may
 * differ from the Host header when operators open the panel on localhost.
 */

'use strict';

const conn = require('./agentBundleConnection');

function stripRequestHost(rawHost) {
    const raw = String(rawHost || 'localhost');
    const firstHost = raw.split(',')[0].trim();

    if (firstHost.startsWith('[')) {
        const end = firstHost.indexOf(']');
        return end > 0 ? firstHost.slice(1, end) : firstHost;
    }

    const colonCount = (firstHost.match(/:/g) || []).length;
    if (colonCount === 1) {
        return firstHost.split(':')[0];
    }

    return firstHost;
}

/**
 * @param {import('express').Request} [req]
 * @param {string} [queryHost] - optional ?host= override from API caller
 */
function resolveClientFacingHost(req, queryHost) {
    if (queryHost) {
        const normalized = conn.normalizeServerHost(queryHost);
        if (normalized.valid) {
            return normalized.host;
        }
    }

    const panelHost = process.env.PANEL_PUBLIC_HOST;
    if (panelHost) {
        const normalized = conn.normalizeServerHost(panelHost);
        if (normalized.valid) {
            return normalized.host;
        }
    }

    const fromApi = conn.defaultServerHost();
    if (fromApi) {
        return fromApi;
    }

    if (req) {
        const rawHost = req.headers['x-forwarded-host'] || req.headers.host || req.hostname || 'localhost';
        return stripRequestHost(rawHost);
    }

    return 'localhost';
}

module.exports = {
    resolveClientFacingHost,
    stripRequestHost,
};
