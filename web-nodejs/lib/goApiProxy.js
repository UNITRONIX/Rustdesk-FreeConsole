'use strict';

/**
 * Shared helpers for panel → Go API proxy routes.
 * Validates path segments before building URLs (blocks path-smuggling) while
 * accepting RustDesk peer IDs ([a-zA-Z0-9_-], up to 256 chars).
 */

const { assertSafeApiId } = require('./goApiPath');

function safeSegment(value, label = 'id') {
    return encodeURIComponent(assertSafeApiId(value, label));
}

async function proxyToGo(apiClient, req, res, method, pathBuilder, body) {
    try {
        const path = typeof pathBuilder === 'function' ? pathBuilder() : pathBuilder;
        const opts = { method, url: path };
        if (body !== undefined) opts.data = body;
        const resp = await apiClient(opts);
        res.status(resp.status).json(resp.data);
    } catch (err) {
        if (err.message && /^Invalid /.test(err.message)) {
            return res.status(400).json({ error: err.message });
        }
        const status = err.response?.status || 500;
        const data = err.response?.data || { error: 'Go server unreachable' };
        res.status(status).json(data);
    }
}

async function proxyBinaryToGo(apiClient, req, res, method, pathBuilder) {
    try {
        const path = typeof pathBuilder === 'function' ? pathBuilder() : pathBuilder;
        const resp = await apiClient({
            method,
            url: path,
            responseType: 'arraybuffer',
        });
        const ct = resp.headers['content-type'];
        const cd = resp.headers['content-disposition'];
        if (ct) res.set('Content-Type', ct);
        if (cd) res.set('Content-Disposition', cd);
        res.status(resp.status).send(Buffer.from(resp.data));
    } catch (err) {
        if (err.message && /^Invalid /.test(err.message)) {
            return res.status(400).json({ error: err.message });
        }
        const status = err.response?.status || 500;
        if (err.response?.data) {
            try {
                const text = Buffer.from(err.response.data).toString('utf8');
                const json = JSON.parse(text);
                return res.status(status).json(json);
            } catch (_e) { /* fall through */ }
        }
        res.status(status).json({ error: 'Go server unreachable' });
    }
}

module.exports = {
    assertSafeApiId,
    safeSegment,
    proxyToGo,
    proxyBinaryToGo,
};
