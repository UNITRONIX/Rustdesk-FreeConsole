/**
 * Backward compatibility: WAN :21121 → Go :21114.
 * Default API is Go :21114 (direct). Node only forwards legacy client URLs after wanSecurity.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const config = require('../config/config');

const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade', 'host'
]);

function getGoApiOrigin() {
    const raw = config.betterdeskApiUrl || config.hbbsApiUrl || 'http://127.0.0.1:21114/api';
    const u = new URL(raw.endsWith('/') ? raw : `${raw}/`);
    return `${u.protocol}//${u.host}`;
}

/**
 * Express middleware: forward request to Go HTTP API (same path + query).
 */
function goApiProxy(req, res) {
    let target;
    try {
        target = new URL(req.originalUrl || req.url, getGoApiOrigin());
    } catch (err) {
        console.error('[rustdesk-api-proxy] invalid target URL:', err.message);
        return res.status(502).json({ error: 'Bad Gateway' });
    }

    const headers = { ...req.headers };
    for (const h of HOP_BY_HOP) {
        delete headers[h];
    }
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.headers['x-real-ip']
        || req.ip
        || req.socket?.remoteAddress;
    if (clientIp) {
        headers['x-forwarded-for'] = req.headers['x-forwarded-for']
            ? `${req.headers['x-forwarded-for']}, ${clientIp}`
            : clientIp;
        headers['x-real-ip'] = clientIp;
    }
    headers.host = target.host;

    const isTls = target.protocol === 'https:';
    const port = target.port || (isTls ? 443 : 80);
    const transport = isTls ? https : http;

    const opts = {
        hostname: target.hostname,
        port,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers,
        timeout: 15000,
        rejectUnauthorized: !config.allowSelfSignedCerts
    };

    const proxyReq = transport.request(opts, (proxyRes) => {
        const outHeaders = { ...proxyRes.headers };
        delete outHeaders['transfer-encoding'];
        res.writeHead(proxyRes.statusCode, outHeaders);
        proxyRes.pipe(res);
    });

    proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) {
            res.status(504).json({ error: 'Gateway Timeout' });
        }
    });

    proxyReq.on('error', (err) => {
        console.error(`[rustdesk-api-proxy] ${req.method} ${req.path} → ${target.origin}: ${err.message}`);
        if (!res.headersSent) {
            res.status(502).json({ error: 'Bad Gateway' });
        }
    });

    req.pipe(proxyReq);
}

module.exports = { goApiProxy, getGoApiOrigin };
