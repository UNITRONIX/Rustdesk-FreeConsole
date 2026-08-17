/**
 * Resolve the hostname/IP shown in RustDesk client configuration.
 * Clients must reach the server on a public or LAN-routable address, which may
 * differ from the Host header when operators open the panel on localhost.
 */

'use strict';

const conn = require('./agentBundleConnection');
const keyService = require('./keyService');
const publicEndpoints = require('./rustDeskPublicEndpointsService');

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
 * Hosts that phones typically cannot reach when scanning a config QR (#368).
 * Used for operator warnings only — does not change encoding.
 * @param {string} host
 * @returns {boolean}
 */
function isPhoneUnreachableHost(host) {
    const h = String(host || '').trim().toLowerCase();
    if (!h) return false;
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return true;
    if (h.endsWith('.local')) return true;
    return false;
}

/** Same precedence as PUBLIC_*: non-empty process.env → durable → .env */
function readPanelPublicHost() {
    return publicEndpoints.readPanelPublicHostValue();
}

/**
 * @param {import('express').Request} [req]
 * @param {string} [queryHost] - optional ?host= override from API caller
 */
function resolveClientFacingHost(req, queryHost) {
    const envOverrides = publicEndpoints.readPublicEndpointEnv();
    if (envOverrides.public_server_id) {
        return envOverrides.public_server_id;
    }

    if (queryHost) {
        const normalized = conn.normalizeServerHost(queryHost);
        if (normalized.valid) {
            return normalized.host;
        }
    }

    const panelHost = readPanelPublicHost();
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

function detectHostSource(req, queryHost, envOverrides) {
    if (envOverrides.public_server_id) return 'env';
    if (queryHost) {
        const normalized = conn.normalizeServerHost(queryHost);
        if (normalized.valid) return 'query';
    }
    const panelHost = readPanelPublicHost();
    if (panelHost) {
        const normalized = conn.normalizeServerHost(panelHost);
        if (normalized.valid) return 'panel_host';
    }
    if (conn.defaultServerHost()) return 'config';
    if (req) return 'request';
    return 'default';
}

/**
 * Resolve RustDesk client-facing ID, relay, and API endpoints.
 * @param {import('express').Request} [req]
 * @param {string} [queryHost]
 */
function resolveRustDeskEndpoints(req, queryHost) {
    const envOverrides = publicEndpoints.readPublicEndpointEnv();
    const host = resolveClientFacingHost(req, queryHost);
    const relay = envOverrides.public_relay_server || host;
    const api = envOverrides.public_api_url
        || keyService.apiUrlForHost(host, conn.defaultUseHttps());

    const hostSource = detectHostSource(req, queryHost, envOverrides);
    const relaySource = envOverrides.public_relay_server ? 'env' : hostSource;
    const apiSource = envOverrides.public_api_url ? 'env' : (hostSource === 'env' ? 'derived' : hostSource);

    return {
        host,
        relay,
        api,
        sources: {
            host: hostSource,
            relay: relaySource,
            api: apiSource,
        },
        env_override_active: publicEndpoints.isEnvOverrideActive(envOverrides),
    };
}

module.exports = {
    resolveClientFacingHost,
    resolveRustDeskEndpoints,
    stripRequestHost,
    readPanelPublicHost,
    isPhoneUnreachableHost,
};
