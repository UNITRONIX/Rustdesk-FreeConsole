/**
 * Signed Support Agent release profile helpers.
 * Used by the Generator save path and by rebuild/requeue so incomplete or
 * expired profiles can be re-issued without a manual UI save.
 */

'use strict';

const keyService = require('./keyService');
const conn = require('./agentBundleConnection');

const CERT_PIN_RE = /^[a-f0-9]{64}$/;
const PROFILE_ERROR =
    'Support Agent bundle profile is incomplete or expired; save the bundle again to issue a signed profile';

function finalizeBundleBrandingSync(input) {
    const branding = { ...(input || {}) };
    const host = branding.server_host || conn.defaultServerHost();
    const useHttps = branding.use_https ?? true;
    const urls = conn.buildServerUrls(host, useHttps);
    branding.server = {
        address: urls.address,
        api_url: urls.api_url,
        public_key: keyService.getPublicKey() || '',
        cdap_port: urls.cdap_port,
        cdap_url: urls.cdap_url,
    };
    branding.server_address = branding.server.address;
    branding.server_key = branding.server.public_key;
    branding.use_https = !!useHttps;
    return branding;
}

/**
 * Merge operator connection settings and inject server key.
 * Support-agent bundles do NOT embed a shared enrollment token — each
 * installation registers on its own and receives a unique device_token
 * after operator approval (managed enrollment).
 */
async function refreshSupportAgentBranding(input) {
    const src = input || {};
    const branding = finalizeBundleBrandingSync(src);
    const pubKey = (await keyService.resolvePublicKey()) || '';
    if (branding.server) {
        branding.server.public_key = pubKey;
    }
    branding.server_key = pubKey;
    delete branding.enrollment_token;
    delete branding.has_enrollment_token;
    delete branding.enrollment_token_masked;
    branding.server_host = src.server_host || conn.defaultServerHost();
    branding.use_https = !!(src.use_https ?? true);
    return branding;
}

function addSupportProfileValidity(branding, now = new Date()) {
    const ttlDaysRaw = Number.parseInt(process.env.BETTERDESK_AGENT_PROFILE_TTL_DAYS || '365', 10);
    const ttlDays = Number.isFinite(ttlDaysRaw)
        ? Math.max(1, Math.min(ttlDaysRaw, 730))
        : 365;
    const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
    const endpoints = [
        branding.server?.address,
        branding.server?.api_url,
        branding.server?.cdap_url,
    ].filter((endpoint, index, all) => {
        if (typeof endpoint !== 'string' || !endpoint) return false;
        // Allow HTTPS/WSS or HTTP/WS (LAN / RustDesk-style plaintext transport).
        if (!/^https?:\/\//i.test(endpoint) && !/^wss?:\/\//i.test(endpoint)) return false;
        return all.indexOf(endpoint) === index;
    });
    branding.profile_issued_at = now.toISOString();
    branding.profile_expires_at = expiresAt.toISOString();
    branding.allowed_endpoints = endpoints;
    return branding;
}

function assertReleaseSupportProfile(branding) {
    const issuedAt = Date.parse(String(branding?.profile_issued_at || ''));
    const expiresAt = Date.parse(String(branding?.profile_expires_at || ''));
    const endpoints = Array.isArray(branding?.allowed_endpoints) ? branding.allowed_endpoints : [];
    const certPin = String(branding?.server?.cert_pin || '').replace(/:/g, '').trim().toLowerCase();
    const required = [
        branding?.bundle_id,
        branding?.server?.address,
        branding?.server?.api_url,
        branding?.server?.cdap_url,
    ];
    if (required.some((value) => !String(value || '').trim())
        || !Number.isFinite(issuedAt)
        || !Number.isFinite(expiresAt)
        || expiresAt <= Math.max(issuedAt, Date.now())
        || endpoints.length < 3
        || endpoints.some((endpoint) => !/^https?:\/\//i.test(endpoint) && !/^wss?:\/\//i.test(endpoint))
        || (certPin && !CERT_PIN_RE.test(certPin))) {
        throw new Error(PROFILE_ERROR);
    }
}

function isReleaseSupportProfileValid(branding) {
    try {
        assertReleaseSupportProfile(branding);
        return true;
    } catch (_) {
        return false;
    }
}

module.exports = {
    CERT_PIN_RE,
    PROFILE_ERROR,
    finalizeBundleBrandingSync,
    refreshSupportAgentBranding,
    addSupportProfileValidity,
    assertReleaseSupportProfile,
    isReleaseSupportProfileValid,
};
