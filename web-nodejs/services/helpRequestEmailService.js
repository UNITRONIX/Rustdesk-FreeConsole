'use strict';

const WebSocket = require('ws');
const db = require('./database');
const emailService = require('./emailService');
const {
    resolveOperatorEmailsForDevice,
    resolveFolderNameForDevice,
} = require('./deviceGroupService');

const log = {
    info: (...a) => console.log('[HelpRequestEmail]', ...a),
    warn: (...a) => console.warn('[HelpRequestEmail]', ...a),
    error: (...a) => console.error('[HelpRequestEmail]', ...a),
};

const RECONNECT_BASE = 3000;
const RECONNECT_MAX = 60000;
const CONFIG_KEY = 'commercialization_email_config';
const EVENT_TYPE = 'help_request';

const DEFAULT_CONFIG = {
    help_requests_enabled: true,
    notify_assigned_operators: true,
    fallback_alert_email: true,
    include_folder_in_subject: true,
};

function parseCommercializationEmailConfig(raw) {
    if (!raw) return { ...DEFAULT_CONFIG };
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return {
            help_requests_enabled: parsed.help_requests_enabled !== false,
            notify_assigned_operators: parsed.notify_assigned_operators !== false,
            fallback_alert_email: parsed.fallback_alert_email !== false,
            include_folder_in_subject: parsed.include_folder_in_subject !== false,
        };
    } catch (_) {
        return { ...DEFAULT_CONFIG };
    }
}

async function loadCommercializationEmailConfig() {
    const raw = await db.getSetting(CONFIG_KEY);
    return parseCommercializationEmailConfig(raw);
}

async function handleHelpRequestEvent(eventData) {
    const config = await loadCommercializationEmailConfig();
    if (!config.help_requests_enabled) return;

    const requestId = String(eventData.id || eventData.request_id || '').trim();
    const deviceId = String(eventData.device_id || '').trim();
    const message = String(eventData.message || '').trim();
    const hostname = String(eventData.hostname || deviceId || 'Unknown device').trim();
    if (!requestId || !deviceId) return;

    const folderName = await resolveFolderNameForDevice(db, deviceId);
    const helpRequest = { id: requestId, device_id: deviceId, hostname, message };

    const recipients = [];
    if (config.notify_assigned_operators) {
        const operatorEmails = await resolveOperatorEmailsForDevice(db, deviceId);
        for (const row of operatorEmails) recipients.push(row.email);
    }

    if (!recipients.length && config.fallback_alert_email) {
        const alertEmail = await emailService.getAlertEmail();
        if (alertEmail) recipients.push(alertEmail);
    }

    if (!recipients.length) {
        log.warn(`No email recipients for help request ${requestId} (device ${deviceId})`);
        return;
    }

    const uniqueRecipients = [...new Set(recipients.map(r => String(r).trim()).filter(Boolean))];
    const subjectFolderName = config.include_folder_in_subject ? folderName : '';

    for (const recipient of uniqueRecipients) {
        const alreadySent = await db.hasEmailNotificationSent(EVENT_TYPE, requestId, recipient);
        if (alreadySent) continue;

        const sent = await emailService.sendHelpRequestEmail({
            to: recipient,
            helpRequest,
            folderName: subjectFolderName ? folderName : '',
        });
        if (sent) {
            await db.logEmailNotificationSent(EVENT_TYPE, requestId, recipient);
            log.info(`Sent help request ${requestId} notification to ${recipient}`);
        }
    }
}

function initHelpRequestEmailService(goApiUrl, apiKey) {
    if (!goApiUrl || !apiKey) {
        log.warn('Go API URL or API key not configured, help request email disabled');
        return;
    }

    let retryDelay = RECONNECT_BASE;

    function connectToGoEventBus() {
        const wsUrl = goApiUrl
            .replace(/^http:/, 'ws:')
            .replace(/^https:/, 'wss:')
            .replace(/\/api$/, '');

        const url = `${wsUrl}/api/ws/events?filter=help_request&api_key=${encodeURIComponent(apiKey)}`;
        log.info('Connecting to Go event bus (help_request)...');

        const wsOpts = { headers: { 'X-API-Key': apiKey } };
        if (wsUrl.startsWith('wss://')) {
            wsOpts.rejectUnauthorized = !require('../config/config').allowSelfSignedCerts;
        }

        const goWs = new WebSocket(url, wsOpts);

        goWs.on('open', () => {
            log.info('Connected to Go help_request event bus');
            retryDelay = RECONNECT_BASE;
        });

        goWs.on('message', (data) => {
            try {
                const event = JSON.parse(data.toString());
                if (event.type !== 'help_request') return;
                const payload = event.data || {};
                handleHelpRequestEvent(payload).catch(err => {
                    log.error(`Failed to process help request event: ${err.message}`);
                });
            } catch (_) {
                // Ignore malformed frames
            }
        });

        goWs.on('close', () => {
            log.warn(`Go help_request event bus disconnected, retrying in ${retryDelay}ms`);
            setTimeout(connectToGoEventBus, retryDelay);
            retryDelay = Math.min(retryDelay * 2, RECONNECT_MAX);
        });

        goWs.on('error', (err) => {
            log.error('Go help_request event bus error:', err.message || err);
            goWs.close();
        });
    }

    connectToGoEventBus();
    log.info('Help request email service initialized');
}

module.exports = {
    initHelpRequestEmailService,
    handleHelpRequestEvent,
    loadCommercializationEmailConfig,
    parseCommercializationEmailConfig,
    DEFAULT_CONFIG,
    CONFIG_KEY,
};
