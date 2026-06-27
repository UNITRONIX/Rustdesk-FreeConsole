/**
 * Resolve the hostname/IP shown in RustDesk client configuration.
 * Clients must reach the server on a public or LAN-routable address, which may
 * differ from the Host header when operators open the panel on localhost.
 */

'use strict';

const fs = require('fs');
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

function readPanelPublicHost() {
    const content = publicEndpoints.parseEnvFile(
        fs.existsSync(publicEndpoints.ENV_PATH)
            ? fs.readFileSync(publicEndpoints.ENV_PATH, 'utf8')
            : ''
    );
    const fromFile = content.PANEL_PUBLIC_HOST;
    if (fromFile !== undefined && fromFile !== '') {
        return String(fromFile).trim();
    }
    return process.env.PANEL_PUBLIC_HOST || '';
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
};
