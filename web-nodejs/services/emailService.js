/**
 * BetterDesk Console — Email Notification Service
 *
 * SMTP-based email delivery for alert notifications.
 * Configuration is stored in the database (admin-configurable).
 *
 * @author UNITRONIX
 * @version 1.0.0
 */

'use strict';

let nodemailer;
try {
    nodemailer = require('nodemailer');
} catch (_) {
    // nodemailer is optional — alerts still work without email
    nodemailer = null;
}

const { getAdapter } = require('./dbAdapter');
const appConfig = require('../config/config');

let _transporter = null;
let _cachedConfig = null;

function countRecipients(to) {
    if (Array.isArray(to)) return to.filter(Boolean).length;
    return String(to || '')
        .split(',')
        .map((recipient) => recipient.trim())
        .filter(Boolean)
        .length;
}

/**
 * Load SMTP configuration from DB.
 * Falls back to environment variables.
 */
async function loadSmtpConfig() {
    const adapter = getAdapter();
    try {
        const cfg = await adapter.getSetting('smtp_config');
        if (cfg) {
            const parsed = typeof cfg === 'string' ? JSON.parse(cfg) : cfg;
            if (parsed.host) return parsed;
        }
    } catch (_) { /* ignore */ }

    // Env fallback
    if (process.env.SMTP_HOST) {
        return {
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || '587', 10),
            secure: process.env.SMTP_SECURE === 'true',
            user: process.env.SMTP_USER || '',
            pass: process.env.SMTP_PASS || '',
            from: process.env.SMTP_FROM || 'betterdesk@localhost',
            alert_email: process.env.SMTP_ALERT_EMAIL || '',
            tlsVerify: appConfig.smtpTlsVerify,
        };
    }
    return null;
}

function resolveTlsVerify(smtpConfig) {
    if (smtpConfig && smtpConfig.tlsVerify !== undefined) {
        return !!smtpConfig.tlsVerify;
    }
    return appConfig.smtpTlsVerify;
}

/**
 * Get or create the SMTP transporter.
 */
async function getTransporter() {
    if (!nodemailer) {
        console.warn('[Email] nodemailer not installed — email disabled');
        return null;
    }

    const smtpConfig = await loadSmtpConfig();
    if (!smtpConfig) return null;

    // Reuse cached transporter if config unchanged
    if (_transporter && _cachedConfig && JSON.stringify(_cachedConfig) === JSON.stringify(smtpConfig)) {
        return _transporter;
    }

    _transporter = nodemailer.createTransport({
        host: smtpConfig.host,
        port: smtpConfig.port || 587,
        secure: smtpConfig.secure || false,
        auth: (smtpConfig.user && smtpConfig.pass) ? { user: smtpConfig.user, pass: smtpConfig.pass } : undefined,
        tls: { rejectUnauthorized: resolveTlsVerify(smtpConfig) },
    });

    _cachedConfig = smtpConfig;
    console.log(`[Email] SMTP transporter configured: ${smtpConfig.host}:${smtpConfig.port}`);
    return _transporter;
}

/**
 * Send an email notification.
 */
async function sendEmail({ to, subject, text, html }) {
    const transporter = await getTransporter();
    if (!transporter) {
        console.warn('[Email] Cannot send — no SMTP config');
        return false;
    }

    const config = _cachedConfig;
    try {
        await transporter.sendMail({
            from: config.from || 'betterdesk@localhost',
            to,
            subject,
            text,
            html,
        });
        console.log(`[Email] Sent message to ${countRecipients(to)} recipient(s)`);
        return true;
    } catch (err) {
        console.error(`[Email] Send failed: ${err.message}`);
        return false;
    }
}

/**
 * Send an alert notification email.
 */
async function sendAlertEmail(alert, rule) {
    const subject = `[BetterDesk Alert] ${rule.name} — ${alert.severity.toUpperCase()}`;
    const text = [
        `Alert: ${rule.name}`,
        `Severity: ${alert.severity}`,
        `Device: ${alert.device_id || 'N/A'}`,
        `Message: ${alert.message}`,
        `Triggered at: ${alert.triggered_at}`,
        '',
        `Rule: ${rule.description || rule.condition_type} ${rule.condition_op} ${rule.condition_value}`,
    ].join('\n');

    const html = `
        <div style="font-family: sans-serif; max-width: 600px;">
            <h2 style="color: #e74c3c;">BetterDesk Alert: ${escapeHtml(rule.name)}</h2>
            <table style="border-collapse: collapse; width: 100%;">
                <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Severity</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${alert.severity}</td></tr>
                <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Device</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${alert.device_id || 'N/A'}</td></tr>
                <tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Message</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${escapeHtml(alert.message)}</td></tr>
                <tr><td style="padding: 8px; font-weight: bold;">Time</td>
                    <td style="padding: 8px;">${alert.triggered_at}</td></tr>
            </table>
            <p style="color: #888; font-size: 12px; margin-top: 16px;">
                Rule: ${escapeHtml(rule.description || '')}
            </p>
        </div>`;

    const recipients = rule.notify_emails || '';
    if (!recipients) return false;

    return sendEmail({ to: recipients, subject, text, html });
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Test SMTP connection.
 */
async function testConnection() {
    const transporter = await getTransporter();
    if (!transporter) {
        return { success: false, error: 'No SMTP configuration' };
    }
    try {
        await transporter.verify();
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * Reset cached transporter (e.g. after config change).
 */
function resetTransporter() {
    _transporter = null;
    _cachedConfig = null;
}

/**
 * Return configured alert/warning email address (may be empty).
 */
async function getAlertEmail() {
    const cfg = await loadSmtpConfig();
    return (cfg && cfg.alert_email) ? String(cfg.alert_email).trim() : '';
}

function getPanelBaseUrl() {
    const explicit = process.env.PANEL_PUBLIC_URL || process.env.PUBLIC_URL || '';
    if (explicit) return explicit.replace(/\/$/, '');
    const host = appConfig.host === '0.0.0.0' ? '127.0.0.1' : appConfig.host;
    const protocol = appConfig.httpRedirect ? 'https' : 'http';
    return `${protocol}://${host}:${appConfig.port}`;
}

/**
 * Send help request notification email to one or more recipients.
 */
async function sendHelpRequestEmail({ to, helpRequest, folderName }) {
    const hostname = helpRequest.hostname || helpRequest.device_id || 'Unknown device';
    const message = helpRequest.message || '';
    const link = `${getPanelBaseUrl()}/help-requests`;
    const folderLine = folderName ? `Folder: ${folderName}` : '';
    const subjectPrefix = folderName ? `[${folderName}] ` : '';
    const subject = `${subjectPrefix}Help request — ${hostname}`;

    const text = [
        'A new help request was submitted.',
        '',
        `Device: ${hostname}`,
        helpRequest.device_id ? `Device ID: ${helpRequest.device_id}` : '',
        folderLine,
        '',
        `Message: ${message}`,
        '',
        `Open in panel: ${link}`,
    ].filter(Boolean).join('\n');

    const html = `
        <div style="font-family: sans-serif; max-width: 600px;">
            <h2 style="color: #2563eb;">Help request — ${escapeHtml(hostname)}</h2>
            <table style="border-collapse: collapse; width: 100%;">
                ${helpRequest.device_id ? `<tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Device ID</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${escapeHtml(helpRequest.device_id)}</td></tr>` : ''}
                ${folderName ? `<tr><td style="padding: 8px; border-bottom: 1px solid #eee; font-weight: bold;">Folder</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${escapeHtml(folderName)}</td></tr>` : ''}
                <tr><td style="padding: 8px; font-weight: bold;">Message</td>
                    <td style="padding: 8px;">${escapeHtml(message)}</td></tr>
            </table>
            <p style="margin-top: 16px;"><a href="${escapeHtml(link)}">Open help requests in BetterDesk</a></p>
        </div>`;

    return sendEmail({ to, subject, text, html });
}

module.exports = {
    sendEmail,
    sendAlertEmail,
    sendHelpRequestEmail,
    testConnection,
    resetTransporter,
    loadSmtpConfig,
    getAlertEmail,
    getPanelBaseUrl,
};
