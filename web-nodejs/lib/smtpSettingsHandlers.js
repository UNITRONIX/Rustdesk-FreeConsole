'use strict';

const { getAdapter } = require('../services/dbAdapter');
const emailService = require('../services/emailService');

const MASKED_PASS = '********';

function serializeSmtpConfig(config) {
    if (!config || !config.host) {
        return { configured: false };
    }
    return {
        configured: true,
        host: config.host,
        port: config.port,
        secure: !!config.secure,
        user: config.user || '',
        pass: config.pass ? MASKED_PASS : '',
        from: config.from || '',
        alert_email: config.alert_email || '',
        tlsVerify: config.tlsVerify !== undefined ? !!config.tlsVerify : undefined,
    };
}

async function loadStoredSmtpConfig() {
    const adapter = getAdapter();
    const raw = await adapter.getSetting('smtp_config');
    if (!raw) return null;
    try {
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (_) {
        return null;
    }
}

async function getSmtpSettings(req, res) {
    try {
        const config = await emailService.loadSmtpConfig();
        res.json(serializeSmtpConfig(config));
    } catch (err) {
        console.error('[Settings] SMTP get error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
}

async function putSmtpSettings(req, res) {
    try {
        const { host, port, secure, user, pass, from, alert_email, tlsVerify } = req.body || {};
        if (!host) {
            return res.status(400).json({ error: 'SMTP host is required' });
        }

        const existing = await loadStoredSmtpConfig();
        let resolvedPass = pass || '';
        if (!resolvedPass || resolvedPass === MASKED_PASS) {
            resolvedPass = existing && existing.pass ? existing.pass : '';
        }

        const config = {
            host: String(host).trim(),
            port: parseInt(port, 10) || 587,
            secure: !!secure,
            user: user || '',
            pass: resolvedPass,
            from: from || 'betterdesk@localhost',
            alert_email: alert_email ? String(alert_email).trim() : '',
            tlsVerify: tlsVerify !== undefined ? !!tlsVerify : undefined,
        };

        const adapter = getAdapter();
        await adapter.setSetting('smtp_config', JSON.stringify(config));
        emailService.resetTransporter();

        try {
            const userId = req.session?.userId ?? req.session?.user?.id ?? null;
            await adapter.logAction(userId, 'smtp_config_updated', `SMTP: ${config.host}:${config.port}`, req.ip);
        } catch (_) { /* ignore */ }

        res.json({ success: true });
    } catch (err) {
        console.error('[Settings] SMTP update error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
}

async function testSmtpSettings(req, res) {
    try {
        const result = await emailService.testConnection();
        res.json(result);
    } catch (err) {
        console.error('[Settings] SMTP test error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
}

module.exports = {
    getSmtpSettings,
    putSmtpSettings,
    testSmtpSettings,
    MASKED_PASS,
};
