/**
 * BetterDesk Console - Key Service
 * Reads public key and API key from filesystem
 */

const fs = require('fs');
const QRCode = require('qrcode');
const config = require('../config/config');
const conn = require('./agentBundleConnection');

/**
 * Read public key from file
 */
function getPublicKey() {
    try {
        if (fs.existsSync(config.pubKeyPath)) {
            return fs.readFileSync(config.pubKeyPath, 'utf8').trim();
        }
        return null;
    } catch (err) {
        console.warn('Could not read public key:', err.message);
        return null;
    }
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
 * @param {string} serverHost
 * @param {{ useHttps?: boolean }} [options]
 */
function buildRustDeskConfigPayload(serverHost, options = {}) {
    const host = normalizeHostInput(serverHost);
    const pubKey = getPublicKey() || '';
    const useHttps = options.useHttps ?? conn.defaultUseHttps();
    return {
        host,
        relay: host,
        api: apiUrlForHost(host, useHttps),
        key: pubKey,
    };
}

/**
 * QR / deep-link format: rustdesk://config/<standard-base64-json>
 */
function encodeRustDeskConfigUri(payload) {
    const jsonStr = JSON.stringify(payload);
    const b64 = Buffer.from(jsonStr).toString('base64');
    return `rustdesk://config/${b64}`;
}

/**
 * CLI / Import format for `rustdesk.exe --config`: reverse(base64(json)) without padding.
 */
function encodeRustDeskCliConfigString(payload) {
    const jsonStr = JSON.stringify(payload);
    let b64 = Buffer.from(jsonStr).toString('base64');
    b64 = b64.replace(/=+$/, '');
    return b64.split('').reverse().join('');
}

/**
 * Generate QR code containing the RustDesk configuration URI.
 * Format: rustdesk://config/<base64-encoded-json>
 * @param {string} serverHost - server host/IP used for the config
 */
async function getServerConfigQR(serverHost) {
    const pubKey = getPublicKey();
    if (!pubKey) {
        return null;
    }

    try {
        const configPayload = buildRustDeskConfigPayload(serverHost);
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
 */
function getClientConfig(serverHost) {
    const payload = buildRustDeskConfigPayload(serverHost);
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
    const pubKey = getPublicKey();
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
function getServerConfig() {
    return {
        publicKey: getPublicKey(),
        apiKeyMasked: getApiKey(true),
        hbbsApiUrl: config.hbbsApiUrl,
        dbPath: config.dbPath,
        pubKeyPath: config.pubKeyPath,
        apiKeyPath: config.apiKeyPath,
    };
}

module.exports = {
    getPublicKey,
    getApiKey,
    getPublicKeyQR,
    getServerConfigQR,
    getClientConfig,
    getServerConfig,
    buildRustDeskConfigPayload,
    encodeRustDeskConfigUri,
    encodeRustDeskCliConfigString,
    normalizeHostInput,
    apiUrlForHost,
};
