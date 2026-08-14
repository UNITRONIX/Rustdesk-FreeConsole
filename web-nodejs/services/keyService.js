/**
 * BetterDesk Console - Key Service
 * Reads public key and API key from filesystem; resolves live Go key as fallback.
 */

const fs = require('fs');
const QRCode = require('qrcode');
const config = require('../config/config');
const conn = require('./agentBundleConnection');

const ED25519_PUBLIC_KEY_BYTES = 32;
const GO_KEY_CACHE_TTL_MS = 30_000;

/** @type {{ key: string|null, at: number }} */
let goKeyCache = { key: null, at: 0 };

/**
 * True when value is a valid RustDesk server public key (base64 → 32 bytes).
 * Rejects empty values, unresolved env tokens, and obvious placeholders.
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidRustDeskPublicKey(value) {
    if (typeof value !== 'string') return false;
    const key = value.trim();
    if (!key) return false;
    if (/__[^_\s]+__/.test(key)) return false;
    if (/placeholder/i.test(key)) return false;
    if (/^YOUR[_-]?PUBLIC[_-]?KEY$/i.test(key)) return false;
    if (/\s/.test(key)) return false;

    try {
        const decoded = Buffer.from(key, 'base64');
        // Reject non-canonical base64 (padding / alphabet mismatch)
        if (decoded.length !== ED25519_PUBLIC_KEY_BYTES) return false;
        const reencoded = decoded.toString('base64');
        // Allow missing padding on input by comparing without '='
        if (reencoded.replace(/=+$/, '') !== key.replace(/=+$/, '')) return false;
        return true;
    } catch {
        return false;
    }
}

/**
 * Read and validate public key from the configured pubkey file.
 * Invalid / placeholder content is treated as missing (never returned to clients).
 * @returns {string|null}
 */
function getPublicKey() {
    try {
        if (!fs.existsSync(config.pubKeyPath)) {
            return null;
        }
        const raw = fs.readFileSync(config.pubKeyPath, 'utf8').trim();
        if (!raw) return null;
        if (!isValidRustDeskPublicKey(raw)) {
            console.warn(
                `Public key at ${config.pubKeyPath} is not a valid Ed25519 key ` +
                `(length=${raw.length}); ignoring for client deploy/config.`
            );
            return null;
        }
        return raw;
    } catch (err) {
        console.warn('Could not read public key:', err.message);
        return null;
    }
}

/**
 * Fetch the live rendezvous public key from the Go server.
 * @returns {Promise<string|null>}
 */
async function fetchPublicKeyFromGo() {
    try {
        const betterdeskApi = require('./betterdeskApi');
        const resp = await betterdeskApi.apiClient.get('/server-key', { timeout: 5000 });
        const key = typeof resp.data?.key === 'string' ? resp.data.key.trim() : '';
        if (isValidRustDeskPublicKey(key)) {
            return key;
        }
        return null;
    } catch (err) {
        console.warn('Could not fetch public key from Go /api/server-key:', err.message);
        return null;
    }
}

/**
 * Resolve the server public key: validated file first, then live Go API (cached).
 * @returns {Promise<string|null>}
 */
async function resolvePublicKey() {
    // Prefer module.exports so tests can spy on getPublicKey.
    const fromFile = module.exports.getPublicKey();
    if (fromFile) return fromFile;

    const now = Date.now();
    if (goKeyCache.key && (now - goKeyCache.at) < GO_KEY_CACHE_TTL_MS) {
        return goKeyCache.key;
    }

    const fromGo = await fetchPublicKeyFromGo();
    if (fromGo) {
        goKeyCache = { key: fromGo, at: now };
        return fromGo;
    }

    goKeyCache = { key: null, at: now };
    return null;
}

/** Test helper — clears Go key cache. */
function _resetGoKeyCacheForTests() {
    goKeyCache = { key: null, at: 0 };
}

/**
 * Get API key (masked for display)
 */
function getApiKey(masked = true) {
    try {
        if (fs.existsSync(config.apiKeyPath)) {
            const key = fs.readFileSync(config.apiKeyPath, 'utf8').trim();
            if (masked && key.length > 8) {
                return key.substring(0, 4) + '****' + key.substring(key.length - 4);
            }
            return key;
        }
        return null;
    } catch (err) {
        console.warn('Could not read API key:', err.message);
        return null;
    }
}

function normalizeHostInput(serverHost) {
    if (!serverHost) {
        return 'localhost';
    }
    const normalized = conn.normalizeServerHost(serverHost);
    return normalized.valid ? normalized.host : String(serverHost).trim() || 'localhost';
}

function apiUrlForHost(host, useHttps) {
    const port = String(config.goApiPort || config.apiPort || 21114);
    const scheme = useHttps ? 'https' : 'http';
    if (useHttps && port === '443') {
        return `https://${host}`;
    }
    if (!useHttps && port === '80') {
        return `http://${host}`;
    }
    return `${scheme}://${host}:${port}`;
}

/**
 * RustDesk client config JSON payload: { host, relay, api, key }
 * @param {{ host: string, relay?: string, api?: string } | string} endpointsOrHost
 * @param {{ useHttps?: boolean, publicKey?: string }} [options]
 */
function buildRustDeskConfigPayload(endpointsOrHost, options = {}) {
    const pubKey = options.publicKey !== undefined
        ? (isValidRustDeskPublicKey(options.publicKey) ? String(options.publicKey).trim() : '')
        : (module.exports.getPublicKey() || '');
    const useHttps = options.useHttps ?? conn.defaultUseHttps();

    if (typeof endpointsOrHost === 'string') {
        const host = normalizeHostInput(endpointsOrHost);
        return {
            host,
            relay: host,
            api: apiUrlForHost(host, useHttps),
            key: pubKey,
        };
    }

    const host = normalizeHostInput(endpointsOrHost.host);
    const relay = normalizeHostInput(endpointsOrHost.relay || host);
    const api = endpointsOrHost.api || apiUrlForHost(host, useHttps);
    return {
        host,
        relay,
        api,
        key: pubKey,
    };
}

/**
 * Like buildRustDeskConfigPayload but resolves the live public key (file → Go).
 * @param {{ host: string, relay?: string, api?: string } | string} endpointsOrHost
 * @param {{ useHttps?: boolean, publicKey?: string }} [options]
 */
async function buildRustDeskConfigPayloadAsync(endpointsOrHost, options = {}) {
    const publicKey = options.publicKey !== undefined
        ? options.publicKey
        : (await resolvePublicKey()) || '';
    return buildRustDeskConfigPayload(endpointsOrHost, { ...options, publicKey });
}

/**
 * CLI / Import format for `rustdesk.exe --config`: reverse(base64(json)) without padding.
 * Same string as RustDesk Export Server Config / Import Server Config.
 */
function encodeRustDeskCliConfigString(payload) {
    const jsonStr = JSON.stringify(payload);
    let b64 = Buffer.from(jsonStr).toString('base64');
    b64 = b64.replace(/=+$/, '');
    return b64.split('').reverse().join('');
}

/**
 * QR / deep-link format: rustdesk://config/<reversed-deploy-string>
 * Path must match Export/`--config` (not standard base64) so RustDesk ServerConfig.decode works (#368).
 */
function encodeRustDeskConfigUri(payload) {
    return `rustdesk://config/${encodeRustDeskCliConfigString(payload)}`;
}

/**
 * Generate QR code containing the RustDesk configuration URI.
 * Format: rustdesk://config/<reversed-deploy-string>
 * @param {{ host: string, relay?: string, api?: string } | string} endpointsOrHost
 */
async function getServerConfigQR(endpointsOrHost) {
    const pubKey = await resolvePublicKey();
    if (!pubKey) {
        return null;
    }

    try {
        const configPayload = await buildRustDeskConfigPayloadAsync(endpointsOrHost, { publicKey: pubKey });
        const configUri = encodeRustDeskConfigUri(configPayload);

        const qrDataUrl = await QRCode.toDataURL(configUri, {
            errorCorrectionLevel: 'M',
            type: 'image/png',
            width: 256,
            margin: 2,
            color: {
                dark: '#000000',
                light: '#ffffff',
            },
        });
        return qrDataUrl;
    } catch (err) {
        console.warn('Could not generate config QR code:', err.message);
        return null;
    }
}

/**
 * Build the RustDesk client fields operators need to enter manually.
 * Uses validated file key, then live Go /api/server-key as fallback (#340).
 * @param {{ host: string, relay?: string, api?: string } | string} endpointsOrHost
 */
async function getClientConfig(endpointsOrHost) {
    const payload = await buildRustDeskConfigPayloadAsync(endpointsOrHost);
    const publicKey = payload.key;

    return {
        server_id: payload.host,
        relay_server: payload.relay,
        api_url: payload.api,
        public_key: publicKey,
        has_public_key: Boolean(publicKey),
        deploy_config_string: publicKey ? encodeRustDeskCliConfigString(payload) : '',
        config_uri: publicKey ? encodeRustDeskConfigUri(payload) : '',
    };
}

/**
 * Generate QR code for public key (legacy — raw key text)
 */
async function getPublicKeyQR() {
    const pubKey = await resolvePublicKey();
    if (!pubKey) {
        return null;
    }

    try {
        const qrDataUrl = await QRCode.toDataURL(pubKey, {
            errorCorrectionLevel: 'M',
            type: 'image/png',
            width: 256,
            margin: 2,
            color: {
                dark: '#000000',
                light: '#ffffff',
            },
        });
        return qrDataUrl;
    } catch (err) {
        console.warn('Could not generate QR code:', err.message);
        return null;
    }
}

/**
 * Get server configuration info
 */
async function getServerConfig() {
    return {
        publicKey: await resolvePublicKey(),
        apiKeyMasked: getApiKey(true),
        hbbsApiUrl: config.hbbsApiUrl,
        dbPath: config.dbPath,
        pubKeyPath: config.pubKeyPath,
        apiKeyPath: config.apiKeyPath,
    };
}

module.exports = {
    isValidRustDeskPublicKey,
    getPublicKey,
    resolvePublicKey,
    getApiKey,
    getPublicKeyQR,
    getServerConfigQR,
    getClientConfig,
    getServerConfig,
    buildRustDeskConfigPayload,
    buildRustDeskConfigPayloadAsync,
    encodeRustDeskConfigUri,
    encodeRustDeskCliConfigString,
    normalizeHostInput,
    apiUrlForHost,
    _resetGoKeyCacheForTests,
};
