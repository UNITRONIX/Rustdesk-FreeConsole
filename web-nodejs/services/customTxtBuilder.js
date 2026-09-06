/**
 * Build and optionally sign BetterDesk Support `custom.txt` payloads.
 *
 * Phase A: plain JSON (file starts with `{`)
 * Phase B: base64(NaCl-sign(JSON bytes)) when a signing seed is available
 */

'use strict';

const nacl = require('tweetnacl');

/**
 * @param {{
 *   appName?: string,
 *   host: string,
 *   relay?: string,
 *   api: string,
 *   key: string,
 *   disableSettings?: boolean|string,
 * }} opts
 * @returns {object}
 */
function buildSupportCustomTxt({
    appName,
    host,
    relay,
    api,
    key,
    disableSettings = true,
} = {}) {
    const rendezvous = String(host || '').trim();
    const relayHost = String(relay || host || '').trim();
    const apiServer = String(api || '').trim();
    const pubKey = String(key || '').trim();
    const disable = disableSettings === true || disableSettings === 'Y' || disableSettings === 'y'
        ? 'Y'
        : 'N';

    return {
        'app-name': String(appName || 'BetterDesk Support Agent').trim() || 'BetterDesk Support Agent',
        'conn-type': 'incoming',
        'disable-settings': disable,
        'override-settings': {
            'custom-rendezvous-server': rendezvous,
            'relay-server': relayHost,
            'api-server': apiServer,
            key: pubKey,
            'hide-server-settings': 'Y',
            'hide-help-cards': 'Y',
        },
    };
}

/**
 * Stable JSON bytes for signing (sorted keys, compact).
 * @param {object} json
 * @returns {Buffer}
 */
function stableJsonBytes(json) {
    return Buffer.from(JSON.stringify(sortKeys(json)), 'utf8');
}

function sortKeys(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(sortKeys);
    const out = {};
    for (const k of Object.keys(value).sort()) {
        out[k] = sortKeys(value[k]);
    }
    return out;
}

/**
 * Sign custom-client JSON with a 32-byte NaCl seed (base64).
 * Output matches BetterDesk-Client `sign_custom_client_config.py`:
 * base64(signature || message).
 *
 * @param {object} json
 * @param {string} seedBase64
 * @returns {{ content: string, signed: boolean }}
 */
function signCustomTxt(json, seedBase64) {
    const seedText = String(seedBase64 || '').trim();
    const message = Buffer.isBuffer(json) ? json : stableJsonBytes(json);

    if (!seedText) {
        return {
            content: message.toString('utf8'),
            signed: false,
        };
    }

    let seed;
    try {
        seed = Buffer.from(seedText, 'base64');
    } catch (_) {
        return { content: message.toString('utf8'), signed: false };
    }
    if (seed.length !== 32) {
        return { content: message.toString('utf8'), signed: false };
    }

    try {
        const keyPair = nacl.sign.keyPair.fromSeed(seed);
        const signed = nacl.sign(new Uint8Array(message), keyPair.secretKey);
        return {
            content: Buffer.from(signed).toString('base64'),
            signed: true,
        };
    } catch (_) {
        return { content: message.toString('utf8'), signed: false };
    }
}

/**
 * Build Support Agent custom.txt file contents (plain or signed).
 * @returns {{ content: string, signed: boolean, json: object }}
 */
function buildAndSignSupportCustomTxt(opts, seedBase64) {
    const json = buildSupportCustomTxt(opts);
    const result = signCustomTxt(json, seedBase64);
    return { ...result, json };
}

module.exports = {
    buildSupportCustomTxt,
    signCustomTxt,
    buildAndSignSupportCustomTxt,
    stableJsonBytes,
};
