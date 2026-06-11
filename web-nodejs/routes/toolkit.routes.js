/**
 * BetterDesk Console — Toolkit Routes
 *
 * Server-side API endpoints for admin toolkit utilities:
 *   - SSL certificate inspection
 *   - Hash generation (MD5, SHA-256, SHA-512)
 *   - Password generation
 *   - Base64 encode/decode
 *   - Whois lookup
 *   - Wake-on-LAN
 *   - QR code generation
 *
 * Network tools (ping, tcp, http, dns) are in network.routes.js.
 * System tools (processes, disk, docker, logs, speed-test) are in system.routes.js.
 *
 * @module routes/toolkit.routes
 */

'use strict';

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const tls     = require('tls');
const https   = require('https');
const dgram   = require('dgram');
const dns     = require('dns');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { bodyInt, bodyBool } = require('../lib/bodyScalars');
const { assertSafeResolvedHost, SsrfBlockedError } = require('../lib/ssrfGuard');

// ── Page ────────────────────────────────────────────────────────────────────

router.get('/toolkit', requireAuth, (req, res) => {
    res.render('toolkit', {
        title: req.t('toolkit.title'),
        activePage: 'toolkit',
    });
});

// ── SSL Certificate Inspector ───────────────────────────────────────────────

router.post('/api/toolkit/ssl', requireAuth, async (req, res) => {
    const { host, port } = req.body;
    if (!host || typeof host !== 'string') {
        return res.status(400).json({ success: false, error: 'Host is required' });
    }

    const cleanHost = host.replace(/^https?:\/\//, '').split('/')[0].split(':')[0].trim();
    if (!cleanHost || cleanHost.length > 253 || /[\s<>{}|\\^`]/.test(cleanHost)) {
        return res.status(400).json({ success: false, error: 'Invalid hostname' });
    }

    try {
        await assertSafeResolvedHost(cleanHost, { allowPrivate: true });
    } catch (err) {
        const msg = err instanceof SsrfBlockedError ? err.message : 'Invalid hostname';
        return res.status(400).json({ success: false, error: msg });
    }

    const sslPort = parseInt(port, 10) || 443;
    if (sslPort < 1 || sslPort > 65535) {
        return res.status(400).json({ success: false, error: 'Invalid port' });
    }

    const socket = tls.connect(sslPort, cleanHost, {
        servername: cleanHost,
        rejectUnauthorized: false,
        timeout: 8000,
    }, () => {
        try {
            const cert = socket.getPeerCertificate(true);
            if (!cert || !cert.subject) {
                socket.destroy();
                return res.json({ success: false, error: 'No certificate returned' });
            }

            const now = Date.now();
            const validFrom = new Date(cert.valid_from);
            const validTo   = new Date(cert.valid_to);
            const daysLeft  = Math.floor((validTo - now) / 86400000);

            const chain = [];
            let current = cert;
            const seen = new Set();
            while (current && current.issuerCertificate && !seen.has(current.fingerprint256)) {
                seen.add(current.fingerprint256);
                chain.push({
                    subject:  current.subject ? current.subject.CN || '' : '',
                    issuer:   current.issuer ? current.issuer.CN || current.issuer.O || '' : '',
                    serial:   current.serialNumber || '',
                });
                if (current === current.issuerCertificate) break;
                current = current.issuerCertificate;
            }

            res.json({
                success: true,
                data: {
                    subject:      cert.subject.CN || cert.subject.O || '',
                    issuer:       cert.issuer ? (cert.issuer.CN || cert.issuer.O || '') : '',
                    organization: cert.issuer ? (cert.issuer.O || '') : '',
                    validFrom:    validFrom.toISOString(),
                    validTo:      validTo.toISOString(),
                    daysLeft:     daysLeft,
                    serial:       cert.serialNumber || '',
                    fingerprint:  cert.fingerprint256 || cert.fingerprint || '',
                    altNames:     cert.subjectaltname ? cert.subjectaltname.split(', ').map(s => s.replace('DNS:', '')) : [],
                    protocol:     socket.getProtocol ? socket.getProtocol() : '',
                    cipher:       socket.getCipher ? socket.getCipher() : null,
                    authorized:   socket.authorized,
                    chain:        chain,
                },
            });
        } catch (e) {
            res.json({ success: false, error: e.message });
        } finally {
            socket.destroy();
        }
    });

    socket.on('timeout', () => {
        socket.destroy();
        res.json({ success: false, error: 'Connection timed out' });
    });
    socket.on('error', (err) => {
        res.json({ success: false, error: err.message });
    });
});

// ── Hash Generator ──────────────────────────────────────────────────────────

router.post('/api/toolkit/hash', requireAuth, (req, res) => {
    const { text, algorithm } = req.body;
    if (typeof text !== 'string') {
        return res.status(400).json({ success: false, error: 'Text is required' });
    }
    if (text.length > 1048576) {
        return res.status(400).json({ success: false, error: 'Input too large (max 1 MB)' });
    }

    const allowed = ['md5', 'sha1', 'sha256', 'sha512'];
    const algo = allowed.includes(algorithm) ? algorithm : 'sha256';

    try {
        const hash = crypto.createHash(algo).update(text, 'utf8').digest('hex');
        res.json({ success: true, data: { algorithm: algo, hash } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── Password Generator ──────────────────────────────────────────────────────

router.post('/api/toolkit/password', requireAuth, (req, res) => {
    let { length, uppercase, lowercase, digits, symbols } = req.body;
    length = bodyInt(length, 16, { min: 4, max: 128 });

    let charset = '';
    if (bodyBool(uppercase, true)) charset += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (bodyBool(lowercase, true)) charset += 'abcdefghijklmnopqrstuvwxyz';
    if (bodyBool(digits, true)) charset += '0123456789';
    if (bodyBool(symbols, false)) charset += '!@#$%^&*()-_=+[]{}|;:,.<>?';
    if (!charset) charset = 'abcdefghijklmnopqrstuvwxyz0123456789';

    const charsetLen = charset.length;
    const maxUnbiased = 256 - (256 % charsetLen);
    const bytes = crypto.randomBytes(length * 2);
    let password = '';
    for (let i = 0; i < bytes.length && password.length < length; i++) {
        const b = bytes[i];
        if (b >= maxUnbiased) continue;
        password += charset[b % charsetLen];
    }
    while (password.length < length) {
        const extra = crypto.randomBytes(length);
        for (let i = 0; i < extra.length && password.length < length; i++) {
            const b = extra[i];
            if (b >= maxUnbiased) continue;
            password += charset[b % charsetLen];
        }
    }

    // Calculate entropy
    const entropy = Math.round(length * Math.log2(charset.length));

    res.json({ success: true, data: { password, length, entropy, charsetSize: charset.length } });
});

// ── Base64 Encode / Decode ──────────────────────────────────────────────────

router.post('/api/toolkit/base64', requireAuth, (req, res) => {
    const { text, mode } = req.body;
    if (typeof text !== 'string') {
        return res.status(400).json({ success: false, error: 'Text is required' });
    }
    if (text.length > 1048576) {
        return res.status(400).json({ success: false, error: 'Input too large (max 1 MB)' });
    }

    try {
        let result;
        if (mode === 'decode') {
            result = Buffer.from(text, 'base64').toString('utf8');
        } else {
            result = Buffer.from(text, 'utf8').toString('base64');
        }
        res.json({ success: true, data: { result, mode: mode || 'encode' } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── Wake-on-LAN ─────────────────────────────────────────────────────────────

router.post('/api/toolkit/wol', requireAuth, requirePermission('device.connect'), (req, res) => {
    const { mac, broadcast } = req.body;
    if (!mac || typeof mac !== 'string') {
        return res.status(400).json({ success: false, error: 'MAC address is required' });
    }

    // Validate & normalize MAC
    const cleaned = mac.replace(/[:-]/g, '').toUpperCase();
    if (!/^[0-9A-F]{12}$/.test(cleaned)) {
        return res.status(400).json({ success: false, error: 'Invalid MAC address format' });
    }

    // Build magic packet: 6× 0xFF + 16× MAC
    const macBuf = Buffer.from(cleaned, 'hex');
    const magic  = Buffer.alloc(102);
    magic.fill(0xFF, 0, 6);
    for (let i = 0; i < 16; i++) {
        macBuf.copy(magic, 6 + i * 6);
    }

    const bcast = (broadcast && typeof broadcast === 'string') ? broadcast : '255.255.255.255';
    const client = dgram.createSocket('udp4');
    client.bind(() => {
        client.setBroadcast(true);
        client.send(magic, 0, magic.length, 9, bcast, (err) => {
            client.close();
            if (err) {
                return res.json({ success: false, error: err.message });
            }
            res.json({ success: true, data: { mac: cleaned.match(/.{2}/g).join(':'), broadcast: bcast } });
        });
    });
});

// ── Whois Lookup (DNS-based) ────────────────────────────────────────────────

router.post('/api/toolkit/whois', requireAuth, async (req, res) => {
    const { domain } = req.body;
    if (!domain || typeof domain !== 'string') {
        return res.status(400).json({ success: false, error: 'Domain is required' });
    }

    const clean = domain.replace(/^https?:\/\//, '').split('/')[0].split(':')[0].trim().toLowerCase();
    if (!clean || clean.length > 253 || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(clean)) {
        return res.status(400).json({ success: false, error: 'Invalid domain' });
    }

    try {
        await assertSafeResolvedHost(clean, { allowPrivate: true });
    } catch (err) {
        const msg = err instanceof SsrfBlockedError ? err.message : 'Invalid domain';
        return res.status(400).json({ success: false, error: msg });
    }

    // Perform comprehensive DNS lookup
    const results = {};
    let pending = 5;
    const done = () => {
        if (--pending === 0) {
            res.json({ success: true, data: { domain: clean, dns: results } });
        }
    };

    dns.resolve4(clean, (err, addrs) => { results.A = err ? [] : addrs; done(); });
    dns.resolve6(clean, (err, addrs) => { results.AAAA = err ? [] : addrs; done(); });
    dns.resolveMx(clean, (err, recs) => { results.MX = err ? [] : recs.map(r => ({ priority: r.priority, exchange: r.exchange })); done(); });
    dns.resolveTxt(clean, (err, recs) => { results.TXT = err ? [] : recs.map(r => r.join('')); done(); });
    dns.resolveNs(clean, (err, recs) => { results.NS = err ? [] : recs; done(); });
});

// ── URL Encoder / Decoder ───────────────────────────────────────────────────

router.post('/api/toolkit/urlencode', requireAuth, (req, res) => {
    const { text, mode } = req.body;
    if (typeof text !== 'string') {
        return res.status(400).json({ success: false, error: 'Text is required' });
    }
    if (text.length > 1048576) {
        return res.status(400).json({ success: false, error: 'Input too large (max 1 MB)' });
    }

    try {
        let result;
        if (mode === 'decode') {
            result = decodeURIComponent(text);
        } else {
            result = encodeURIComponent(text);
        }
        res.json({ success: true, data: { result, mode: mode || 'encode' } });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// ── JWT Decoder (read-only, no verification) ────────────────────────────────

router.post('/api/toolkit/jwt-decode', requireAuth, (req, res) => {
    const { token } = req.body;
    if (!token || typeof token !== 'string') {
        return res.status(400).json({ success: false, error: 'Token is required' });
    }

    try {
        const parts = token.split('.');
        if (parts.length < 2) {
            return res.status(400).json({ success: false, error: 'Invalid JWT format' });
        }

        const header  = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));

        // Calculate expiry info
        let expiry = null;
        if (payload.exp) {
            const expDate = new Date(payload.exp * 1000);
            expiry = {
                date: expDate.toISOString(),
                expired: Date.now() > expDate.getTime(),
                secondsLeft: Math.floor((expDate.getTime() - Date.now()) / 1000),
            };
        }

        res.json({
            success: true,
            data: { header, payload, expiry, hasSig: parts.length === 3 },
        });
    } catch (e) {
        res.status(400).json({ success: false, error: 'Failed to decode JWT: ' + e.message });
    }
});

module.exports = router;
