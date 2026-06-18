/**
 * BetterDesk Console - Key Service
 * Reads public key and API key from filesystem
 */

const fs = require('fs');
const QRCode = require('qrcode');
const config = require('../config/config');

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

/**
 * Generate QR code containing the RustDesk configuration URI.
 * Format: rustdesk://config/<base64-encoded-json>
 * The JSON contains: { host, relay, api, key }
 * @param {string} serverHost - server host/IP used for the config
 */
async function getServerConfigQR(serverHost) {
    const pubKey = getPublicKey();
    if (!pubKey) {
        return null;
    }

    try {
        const apiKey = getApiKey(false); // unmasked
        const configPayload = {
            host: serverHost || 'localhost',
            relay: serverHost || 'localhost',
            api: `http://${serverHost || 'localhost'}:${config.apiPort}`,
            key: pubKey
        };
        if (apiKey) {
            configPayload.key = pubKey;
        }
        const jsonStr = JSON.stringify(configPayload);
        const b64 = Buffer.from(jsonStr).toString('base64');
        const configUri = `rustdesk://config/${b64}`;

        const qrDataUrl = await QRCode.toDataURL(configUri, {
            errorCorrectionLevel: 'M',
            type: 'image/png',
            width: 256,
            margin: 2,
            color: {
                dark: '#000000',
                light: '#ffffff'
            }
        });
        return qrDataUrl;
    } catch (err) {
        console.warn('Could not generate config QR code:', err.message);
        return null;
    }
}

/**
 * Build the RustDesk client fields operators need to enter manually.
 * Public Docker examples and the legacy client API use :21121 by default.
 */
function getClientConfig(serverHost) {
    const host = serverHost || 'localhost';
    const publicKey = getPublicKey();

    return {
        server_id: host,
        relay_server: host,
        api_url: `http://${host}:${config.apiPort}`,
        public_key: publicKey || '',
        has_public_key: Boolean(publicKey)
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
                light: '#ffffff'
            }
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
        apiKeyPath: config.apiKeyPath
    };
}

module.exports = {
    getPublicKey,
    getApiKey,
    getPublicKeyQR,
    getServerConfigQR,
    getClientConfig,
    getServerConfig
};
