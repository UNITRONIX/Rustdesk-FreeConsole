/**
 * BetterDesk Console — Automation & Alerts API Routes
 *
 * CRUD for alert rules, alert history viewing / acknowledgement,
 * remote command execution, and SMTP configuration.
 *
 * Endpoints:
 *
 * Alert Rules (admin):
 *   GET    /api/automation/rules          — List alert rules
 *   POST   /api/automation/rules          — Create rule
 *   GET    /api/automation/rules/:id      — Get rule
 *   PATCH  /api/automation/rules/:id      — Update rule
 *   DELETE /api/automation/rules/:id      — Delete rule
 *
 * Alert History (admin):
 *   GET    /api/automation/alerts         — List alert history
 *   POST   /api/automation/alerts/:id/ack — Acknowledge alert
 *
 * Remote Commands (admin):
 *   POST   /api/automation/commands       — Send command to device
 *   GET    /api/automation/commands       — List commands
 *   GET    /api/automation/commands/:id   — Get command result
 *
 * Device-facing (agent polls for commands):
 *   GET    /api/bd/commands               — Get pending commands
 *   POST   /api/bd/commands/:id/result    — Submit command result
 *
 * SMTP Config (admin):
 *   GET    /api/automation/smtp           — Get SMTP config (masked)
 *   PUT    /api/automation/smtp           — Update SMTP config
 *   POST   /api/automation/smtp/test      — Test SMTP connection
 *
 * @author UNITRONIX
 * @version 1.0.0
 */

'use strict';

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const { getAdapter } = require('../services/dbAdapter');
const { getSmtpSettings, putSmtpSettings, testSmtpSettings } = require('../lib/smtpSettingsHandlers');

// ---------------------------------------------------------------------------
//  Valid values
// ---------------------------------------------------------------------------

const VALID_CONDITION_TYPES = ['cpu_usage', 'memory_usage', 'disk_usage', 'offline_duration', 'idle_duration', 'custom'];
const VALID_OPERATORS = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'];
const VALID_SEVERITIES = ['info', 'warning', 'critical'];
const VALID_COMMAND_TYPES = ['shell', 'powershell', 'script', 'restart_service', 'reboot'];

const { requireAuth, requirePermission } = require('../middleware/auth');

const { requireDeviceToken } = require('../middleware/deviceAuth');

// ===========================================================================
//  Alert Rules
// ===========================================================================

/**
 * GET /api/automation/rules — List all alert rules.
 */
router.get('/rules', requireAuth, async (req, res) => {
    try {
        const adapter = getAdapter();
        const rules = await adapter.getAlertRules();
        res.json({ rules, total: rules.length });
    } catch (err) {
        console.error('[Automation] Rules list error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/automation/rules — Create an alert rule.
 */
router.post('/rules', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const { name, description, condition_type, condition_op, condition_value,
            severity, scope_device_id, cooldown_secs, notify_emails } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'Rule name is required' });
        }
        if (!condition_type || !VALID_CONDITION_TYPES.includes(condition_type)) {
            return res.status(400).json({ error: `Invalid condition_type. Valid: ${VALID_CONDITION_TYPES.join(', ')}` });
        }
        if (condition_op && !VALID_OPERATORS.includes(condition_op)) {
            return res.status(400).json({ error: `Invalid condition_op. Valid: ${VALID_OPERATORS.join(', ')}` });
        }

        const adapter = getAdapter();
        const rule = await adapter.createAlertRule({
            name: name.trim(),
            description: description || '',
            condition_type,
            condition_op: condition_op || 'gt',
            condition_value: condition_value ?? 0,
            severity: VALID_SEVERITIES.includes(severity) ? severity : 'warning',
            scope_device_id: scope_device_id || null,
            cooldown_secs: cooldown_secs || 300,
            notify_emails: notify_emails || '',
            created_by: req.session.user.username,
        });

        try {
            await adapter.logAction(req.session.user.id, 'alert_rule_created', `Rule: ${name}`, req.ip);
        } catch (_) { /* ignore */ }

        console.log(`[Automation] Alert rule created: ${name}`);
        res.status(201).json({ success: true, rule });
    } catch (err) {
        console.error('[Automation] Rule create error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/automation/rules/:id — Get alert rule.
 */
router.get('/rules/:id(\\d+)', requireAuth, async (req, res) => {
    try {
        const adapter = getAdapter();
        const rule = await adapter.getAlertRuleById(+req.params.id);
        if (!rule) return res.status(404).json({ error: 'Rule not found' });
        res.json(rule);
    } catch (err) {
        console.error('[Automation] Rule get error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * PATCH /api/automation/rules/:id — Update alert rule.
 */
router.patch('/rules/:id(\d+)', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const adapter = getAdapter();
        const rule = await adapter.getAlertRuleById(+req.params.id);
        if (!rule) return res.status(404).json({ error: 'Rule not found' });

        const updates = {};
        const { name, description, enabled, condition_type, condition_op, condition_value,
            severity, scope_device_id, cooldown_secs, notify_emails } = req.body;

        if (name !== undefined) updates.name = name.trim();
        if (description !== undefined) updates.description = description;
        if (enabled !== undefined) updates.enabled = enabled;
        if (condition_type !== undefined) {
            if (!VALID_CONDITION_TYPES.includes(condition_type)) {
                return res.status(400).json({ error: 'Invalid condition_type' });
            }
            updates.condition_type = condition_type;
        }
        if (condition_op !== undefined) {
            if (!VALID_OPERATORS.includes(condition_op)) {
                return res.status(400).json({ error: 'Invalid condition_op' });
            }
            updates.condition_op = condition_op;
        }
        if (condition_value !== undefined) updates.condition_value = condition_value;
        if (severity !== undefined) updates.severity = severity;
        if (scope_device_id !== undefined) updates.scope_device_id = scope_device_id;
        if (cooldown_secs !== undefined) updates.cooldown_secs = cooldown_secs;
        if (notify_emails !== undefined) updates.notify_emails = notify_emails;

        await adapter.updateAlertRule(rule.id, updates);

        console.log(`[Automation] Rule #${rule.id} updated`);
        res.json({ success: true });
    } catch (err) {
        console.error('[Automation] Rule update error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * DELETE /api/automation/rules/:id — Delete alert rule.
 */
router.delete('/rules/:id(\d+)', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const adapter = getAdapter();
        const rule = await adapter.getAlertRuleById(+req.params.id);
        if (!rule) return res.status(404).json({ error: 'Rule not found' });

        await adapter.deleteAlertRule(rule.id);

        try {
            await adapter.logAction(req.session.user.id, 'alert_rule_deleted', `Rule #${rule.id}: ${rule.name}`, req.ip);
        } catch (_) { /* ignore */ }

        console.log(`[Automation] Rule #${rule.id} deleted`);
        res.json({ success: true });
    } catch (err) {
        console.error('[Automation] Rule delete error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ===========================================================================
//  Alert History
// ===========================================================================

/**
 * GET /api/automation/alerts — List alert history.
 * Query params: device_id, severity, acknowledged, limit
 */
router.get('/alerts', requireAuth, async (req, res) => {
    try {
        const adapter = getAdapter();
        const filters = {};
        if (req.query.device_id) filters.device_id = req.query.device_id;
        if (req.query.severity) filters.severity = req.query.severity;
        if (req.query.acknowledged !== undefined) filters.acknowledged = req.query.acknowledged === 'true';
        if (req.query.limit) filters.limit = parseInt(req.query.limit, 10);

        const alerts = await adapter.getAlertHistory(filters);
        res.json({ alerts, total: alerts.length });
    } catch (err) {
        console.error('[Automation] Alerts list error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/automation/alerts/:id/ack — Acknowledge an alert.
 */
router.post('/alerts/:id(\\d+)/ack', requireAuth, async (req, res) => {
    try {
        const adapter = getAdapter();
        await adapter.acknowledgeAlert(+req.params.id, req.session.user.username);
        console.log(`[Automation] Alert #${req.params.id} acknowledged by ${req.session.user.username}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[Automation] Ack error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ===========================================================================
//  Remote Commands
// ===========================================================================

/**
 * POST /api/automation/commands — Send a command to a device.
 */
router.post('/commands', requireAuth, requirePermission('server.config'), async (req, res) => {
    try {
        const { device_id, command_type, payload } = req.body;

        if (!device_id) {
            return res.status(400).json({ error: 'device_id is required' });
        }
        if (!payload || !payload.trim()) {
            return res.status(400).json({ error: 'payload is required' });
        }
        if (command_type && !VALID_COMMAND_TYPES.includes(command_type)) {
            return res.status(400).json({ error: `Invalid command_type. Valid: ${VALID_COMMAND_TYPES.join(', ')}` });
        }

        const adapter = getAdapter();
        const cmd = await adapter.createRemoteCommand({
            device_id,
            command_type: command_type || 'shell',
            payload: payload.trim(),
            created_by: req.session.user.username,
        });

        try {
            await adapter.logAction(req.session.user.id, 'remote_command_sent',
                `${command_type || 'shell'} to ${device_id}`, req.ip);
        } catch (_) { /* ignore */ }

        console.log(`[Automation] Command sent to ${device_id}: ${command_type || 'shell'}`);
        res.status(201).json({ success: true, command: cmd });
    } catch (err) {
        console.error('[Automation] Command create error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/automation/commands — List commands.
 * Query params: device_id, status, limit
 */
router.get('/commands', requireAuth, async (req, res) => {
    try {
        const adapter = getAdapter();
        const filters = {};
        if (req.query.device_id) filters.device_id = req.query.device_id;
        if (req.query.status) filters.status = req.query.status;
        if (req.query.limit) filters.limit = parseInt(req.query.limit, 10);

        const commands = await adapter.getRemoteCommands(filters);
        res.json({ commands, total: commands.length });
    } catch (err) {
        console.error('[Automation] Commands list error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/automation/commands/:id — Get command details.
 */
router.get('/commands/:id(\\d+)', requireAuth, async (req, res) => {
    try {
        const adapter = getAdapter();
        const cmd = await adapter.getRemoteCommandById(+req.params.id);
        if (!cmd) return res.status(404).json({ error: 'Command not found' });
        res.json(cmd);
    } catch (err) {
        console.error('[Automation] Command get error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ===========================================================================
//  Device-facing: Agent polls for commands
// ===========================================================================

/**
 * GET /api/bd/commands — Get pending commands for this device.
 */
router.get('/commands', requireDeviceToken, async (req, res) => {
    try {
        const adapter = getAdapter();
        const commands = await adapter.getPendingCommands(req.deviceId);
        res.json({ commands });
    } catch (err) {
        console.error('[Automation] Pending commands error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/bd/commands/:id/result — Agent submits command result.
 */
router.post('/commands/:id(\\d+)/result', requireDeviceToken, async (req, res) => {
    try {
        const { status, result } = req.body;
        if (!status || !['completed', 'failed', 'running'].includes(status)) {
            return res.status(400).json({ error: 'Status must be completed, failed, or running' });
        }

        const adapter = getAdapter();
        const cmd = await adapter.getRemoteCommandById(+req.params.id);
        if (!cmd) {
            return res.status(404).json({ error: 'Command not found' });
        }
        if (cmd.device_id !== req.deviceId) {
            return res.status(403).json({ error: 'Device ID mismatch' });
        }

        await adapter.updateRemoteCommand(cmd.id, {
            status,
            result: result !== undefined ? String(result) : null,
        });

        console.log(`[Automation] Command #${cmd.id} result from ${req.deviceId}: ${status}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[Automation] Command result error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ===========================================================================
//  SMTP Configuration
// ===========================================================================

/**
 * GET /api/automation/smtp — Get SMTP config (password masked).
 */
router.get('/smtp', requireAuth, requirePermission('server.config'), getSmtpSettings);
router.put('/smtp', requireAuth, requirePermission('server.config'), putSmtpSettings);
router.post('/smtp/test', requireAuth, requirePermission('server.config'), testSmtpSettings);

module.exports = router;
