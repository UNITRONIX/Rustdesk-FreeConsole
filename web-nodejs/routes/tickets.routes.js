/**
 * BetterDesk Console — Helpdesk / Ticketing API Routes
 *
 * Full CRUD for tickets, comments, attachments, and statistics.
 * Tickets can be created from the web console (admin/operator) or
 * from the desktop agent (via bearer token).
 *
 * Endpoints:
 *   GET    /api/tickets           — List tickets (with filters)
 *   GET    /api/tickets/stats     — Ticket statistics
 *   POST   /api/tickets           — Create ticket
 *   GET    /api/tickets/:id       — Get ticket detail (+ comments + attachments)
 *   PATCH  /api/tickets/:id       — Update ticket (status, priority, assign, etc.)
 *   DELETE /api/tickets/:id       — Delete ticket
 *   POST   /api/tickets/:id/comments   — Add comment
 *   GET    /api/tickets/:id/comments   — List comments
 *   POST   /api/tickets/:id/attachments — Upload attachment
 *   GET    /api/tickets/:id/attachments — List attachments
 *   GET    /api/tickets/attachments/:aid — Download attachment
 *
 * Device-facing (agent creates ticket via token):
 *   POST   /api/bd/tickets        — Create ticket from agent
 *   GET    /api/bd/tickets        — List own tickets
 *
 * @author UNITRONIX
 * @version 1.0.0
 */

'use strict';

const express = require('express');
const { resolveChildPath, resolvePathWithinRoot } = require('../lib/safePath');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { getAdapter } = require('../services/dbAdapter');
const { uploadLimiter, fileAccessLimiter } = require('../middleware/rateLimiter');

// ---------------------------------------------------------------------------
//  Config
// ---------------------------------------------------------------------------

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'attachments');

function confinedAttachmentPath(storagePath) {
    return resolvePathWithinRoot(storagePath, UPLOAD_DIR);
}

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Max attachment size: 25 MB
const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

// Valid statuses and priorities
const VALID_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'];
const VALID_CATEGORIES = ['general', 'hardware', 'software', 'network', 'access', 'other'];

// ---------------------------------------------------------------------------
//  SLA defaults (hours per priority)
// ---------------------------------------------------------------------------

const SLA_HOURS = {
    critical: 4,
    high: 8,
    medium: 24,
    low: 72,
};

function calculateSlaDue(priority) {
    const hours = SLA_HOURS[priority] || SLA_HOURS.medium;
    const due = new Date();
    due.setHours(due.getHours() + hours);
    return due.toISOString();
}

// ---------------------------------------------------------------------------
//  Auth middleware
// ---------------------------------------------------------------------------

function requireAuth(req, res, next) {
    if (req.session && req.session.user) {
        return next();
    }
    return res.status(401).json({ error: 'Authentication required' });
}

function requireAdminOrOperator(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    const role = req.session.user.role;
    if (role === 'admin' || role === 'operator') {
        return next();
    }
    return res.status(403).json({ error: 'Insufficient permissions' });
}

// ---------------------------------------------------------------------------
//  Admin/Operator endpoints
// ---------------------------------------------------------------------------

/**
 * GET /api/tickets — List tickets (with filters).
 * Query params: status, priority, category, assigned_to, device_id, search
 */
router.get('/', requireAuth, async (req, res) => {
    try {
        const adapter = getAdapter();
        const filters = {};
        for (const key of ['status', 'priority', 'category', 'assigned_to', 'device_id', 'search']) {
            if (req.query[key]) filters[key] = req.query[key];
        }
        // Viewers can only see tickets assigned to them
        if (req.session.user.role === 'viewer') {
            filters.assigned_to = req.session.user.username;
        }
        const tickets = await adapter.getAllTickets(filters);
        res.json({ tickets, total: tickets.length });
    } catch (err) {
        console.error('[Tickets] List error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/tickets/stats — Ticket statistics.
 */
router.get('/stats', requireAuth, async (req, res) => {
    try {
        const adapter = getAdapter();
        const stats = await adapter.getTicketStats();
        res.json(stats);
    } catch (err) {
        console.error('[Tickets] Stats error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/tickets — Create ticket.
 */
router.post('/', uploadLimiter, requireAdminOrOperator, async (req, res) => {
    try {
        const { title, description, priority, category, device_id, assigned_to } = req.body;

        if (!title || !title.trim()) {
            return res.status(400).json({ error: 'Title is required' });
        }
        if (priority && !VALID_PRIORITIES.includes(priority)) {
            return res.status(400).json({ error: `Invalid priority. Valid: ${VALID_PRIORITIES.join(', ')}` });
        }
        if (category && !VALID_CATEGORIES.includes(category)) {
            return res.status(400).json({ error: `Invalid category. Valid: ${VALID_CATEGORIES.join(', ')}` });
        }

        const adapter = getAdapter();
        const effectivePriority = priority || 'medium';
        const ticket = await adapter.createTicket({
            title: title.trim(),
            description: description || '',
            priority: effectivePriority,
            category: category || 'general',
            deviceId: device_id || null,
            createdBy: req.session.user.username,
            assignedTo: assigned_to || null,
            slaDueAt: calculateSlaDue(effectivePriority),
        });

        // Log audit
        try {
            await adapter.logAction(
                req.session.user.id,
                'ticket_created',
                `Ticket #${ticket.id}: ${title}`,
                req.ip
            );
        } catch (_) { /* ignore */ }

        console.log(`[Tickets] #${ticket.id} created by ${req.session.user.username}: ${title}`);
        res.status(201).json({ success: true, ticket });
    } catch (err) {
        console.error('[Tickets] Create error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/tickets/:id — Get ticket detail (with comments and attachments).
 */
router.get('/:id(\\d+)', requireAuth, async (req, res) => {
    try {
        const adapter = getAdapter();
        const ticket = await adapter.getTicketById(+req.params.id);
        if (!ticket) {
            return res.status(404).json({ error: 'Ticket not found' });
        }

        const comments = await adapter.getTicketComments(ticket.id);
        const attachments = await adapter.getTicketAttachments(ticket.id);

        // Filter internal comments for viewers
        const filteredComments = req.session.user.role === 'viewer'
            ? comments.filter(c => !c.is_internal)
            : comments;

        res.json({
            ...ticket,
            comments: filteredComments,
            attachments: attachments.map(a => ({
                id: a.id,
                filename: a.filename,
                mimetype: a.mimetype,
                size_bytes: a.size_bytes,
                uploaded_by: a.uploaded_by,
                created_at: a.created_at,
            })),
        });
    } catch (err) {
        console.error('[Tickets] Detail error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * PATCH /api/tickets/:id — Update ticket.
 */
router.patch('/:id(\\d+)', requireAdminOrOperator, async (req, res) => {
    try {
        const adapter = getAdapter();
        const ticket = await adapter.getTicketById(+req.params.id);
        if (!ticket) {
            return res.status(404).json({ error: 'Ticket not found' });
        }

        const { title, description, status, priority, category, assigned_to, sla_due_at } = req.body;

        if (status && !VALID_STATUSES.includes(status)) {
            return res.status(400).json({ error: `Invalid status. Valid: ${VALID_STATUSES.join(', ')}` });
        }
        if (priority && !VALID_PRIORITIES.includes(priority)) {
            return res.status(400).json({ error: `Invalid priority. Valid: ${VALID_PRIORITIES.join(', ')}` });
        }

        const updates = {};
        if (title !== undefined) updates.title = title.trim();
        if (description !== undefined) updates.description = description;
        if (status !== undefined) updates.status = status;
        if (priority !== undefined) updates.priority = priority;
        if (category !== undefined) updates.category = category;
        if (assigned_to !== undefined) updates.assigned_to = assigned_to;
        if (sla_due_at !== undefined) updates.sla_due_at = sla_due_at;

        await adapter.updateTicket(ticket.id, updates);

        // Log audit
        try {
            const changes = Object.keys(updates).join(', ');
            await adapter.logAction(
                req.session.user.id,
                'ticket_updated',
                `Ticket #${ticket.id} updated: ${changes}`,
                req.ip
            );
        } catch (_) { /* ignore */ }

        console.log(`[Tickets] #${ticket.id} updated by ${req.session.user.username}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[Tickets] Update error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * DELETE /api/tickets/:id — Delete ticket.
 */
router.delete('/:id(\\d+)', uploadLimiter, requireAdminOrOperator, async (req, res) => {
    try {
        const adapter = getAdapter();
        const ticket = await adapter.getTicketById(+req.params.id);
        if (!ticket) {
            return res.status(404).json({ error: 'Ticket not found' });
        }

        // Delete attachment files from disk
        const attachments = await adapter.getTicketAttachments(ticket.id);
        for (const att of attachments) {
            try {
                fs.unlinkSync(confinedAttachmentPath(att.storage_path));
            } catch (_) { /* ignore */ }
        }

        await adapter.deleteTicket(ticket.id);

        try {
            await adapter.logAction(req.session.user.id, 'ticket_deleted', `Ticket #${ticket.id}: ${ticket.title}`, req.ip);
        } catch (_) { /* ignore */ }

        console.log(`[Tickets] #${ticket.id} deleted by ${req.session.user.username}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[Tickets] Delete error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ---------------------------------------------------------------------------
//  Comments
// ---------------------------------------------------------------------------

/**
 * POST /api/tickets/:id/comments — Add comment to ticket.
 */
router.post('/:id(\\d+)/comments', uploadLimiter, requireAuth, async (req, res) => {
    try {
        const adapter = getAdapter();
        const ticket = await adapter.getTicketById(+req.params.id);
        if (!ticket) {
            return res.status(404).json({ error: 'Ticket not found' });
        }

        const { body, is_internal } = req.body;
        if (!body || !body.trim()) {
            return res.status(400).json({ error: 'Comment body is required' });
        }

        // Viewers cannot post internal comments
        const internal = req.session.user.role === 'viewer' ? false : !!is_internal;

        const comment = await adapter.addTicketComment(
            ticket.id,
            req.session.user.username,
            body.trim(),
            internal
        );

        res.status(201).json({ success: true, comment });
    } catch (err) {
        console.error('[Tickets] Comment error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/tickets/:id/comments — List ticket comments.
 */
router.get('/:id(\\d+)/comments', requireAuth, async (req, res) => {
    try {
        const adapter = getAdapter();
        const comments = await adapter.getTicketComments(+req.params.id);
        const filtered = req.session.user.role === 'viewer'
            ? comments.filter(c => !c.is_internal)
            : comments;
        res.json({ comments: filtered });
    } catch (err) {
        console.error('[Tickets] Comments list error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ---------------------------------------------------------------------------
//  Attachments
// ---------------------------------------------------------------------------

/**
 * POST /api/tickets/:id/attachments — Upload attachment.
 * Expects multipart/form-data or raw binary with headers.
 * For simplicity, accepts base64-encoded body: { filename, data }
 */
router.post('/:id(\\d+)/attachments', uploadLimiter, requireAdminOrOperator, async (req, res) => {
    try {
        const adapter = getAdapter();
        const ticket = await adapter.getTicketById(+req.params.id);
        if (!ticket) {
            return res.status(404).json({ error: 'Ticket not found' });
        }

        const { filename, data, mimetype } = req.body;
        if (!filename || !data) {
            return res.status(400).json({ error: 'Filename and data (base64) are required' });
        }

        const buffer = Buffer.from(data, 'base64');
        if (buffer.length > MAX_ATTACHMENT_SIZE) {
            return res.status(413).json({ error: `Attachment too large. Max ${MAX_ATTACHMENT_SIZE / 1048576} MB` });
        }

        // Sanitize filename
        const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const uniqueName = `${ticket.id}_${crypto.randomBytes(8).toString('hex')}_${safeName}`;
        const storagePath = resolveChildPath(UPLOAD_DIR, uniqueName);

        fs.writeFileSync(storagePath, buffer);

        const att = await adapter.addTicketAttachment(ticket.id, {
            filename: safeName,
            mimetype: mimetype || 'application/octet-stream',
            sizeBytes: buffer.length,
            storagePath,
            uploadedBy: req.session.user.username,
        });

        console.log(`[Tickets] Attachment ${safeName} uploaded to ticket #${ticket.id}`);
        res.status(201).json({ success: true, attachment: { id: att.id, filename: safeName, size_bytes: buffer.length } });
    } catch (err) {
        console.error('[Tickets] Attachment upload error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/tickets/:id/attachments — List attachments.
 */
router.get('/:id(\\d+)/attachments', fileAccessLimiter, requireAuth, async (req, res) => {
    try {
        const adapter = getAdapter();
        const attachments = await adapter.getTicketAttachments(+req.params.id);
        res.json({
            attachments: attachments.map(a => ({
                id: a.id,
                filename: a.filename,
                mimetype: a.mimetype,
                size_bytes: a.size_bytes,
                uploaded_by: a.uploaded_by,
                created_at: a.created_at,
            })),
        });
    } catch (err) {
        console.error('[Tickets] Attachments list error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/tickets/attachments/:aid — Download attachment file.
 */
router.get('/attachments/:aid(\\d+)', fileAccessLimiter, requireAuth, async (req, res) => {
    try {
        const adapter = getAdapter();
        const att = await adapter.getAttachmentById(+req.params.aid);
        if (!att) {
            return res.status(404).json({ error: 'Attachment not found' });
        }
        const filePath = confinedAttachmentPath(att.storage_path);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Attachment file missing' });
        }
        res.setHeader('Content-Disposition', `attachment; filename="${att.filename}"`);
        res.setHeader('Content-Type', att.mimetype);
        res.sendFile(filePath);
    } catch (err) {
        console.error('[Tickets] Attachment download error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ---------------------------------------------------------------------------
//  Device-facing endpoints (agent creates/views tickets via token)
// ---------------------------------------------------------------------------

const db = require('../services/database');
const { requireDeviceToken } = require('../middleware/deviceAuth');

/**
 * POST /api/bd/tickets — Create ticket from desktop agent.
 */
router.post('/bd', requireDeviceToken, async (req, res) => {
    try {
        const { title, description, priority, category } = req.body;

        if (!title || !title.trim()) {
            return res.status(400).json({ error: 'Title is required' });
        }

        const effectivePriority = VALID_PRIORITIES.includes(priority) ? priority : 'medium';
        const effectiveCategory = VALID_CATEGORIES.includes(category) ? category : 'general';

        const adapter = getAdapter();
        const ticket = await adapter.createTicket({
            title: title.trim(),
            description: description || '',
            priority: effectivePriority,
            category: effectiveCategory,
            deviceId: req.deviceId,
            createdBy: `agent:${req.deviceId}`,
            assignedTo: null,
            slaDueAt: calculateSlaDue(effectivePriority),
        });

        console.log(`[Tickets] #${ticket.id} created by agent ${req.deviceId}: ${title}`);
        res.status(201).json({ success: true, ticket_id: ticket.id });
    } catch (err) {
        console.error('[Tickets] Agent create error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * GET /api/bd/tickets — List own tickets (agent).
 */
router.get('/bd', requireDeviceToken, async (req, res) => {
    try {
        const adapter = getAdapter();
        const tickets = await adapter.getAllTickets({ device_id: req.deviceId });
        res.json({ tickets, total: tickets.length });
    } catch (err) {
        console.error('[Tickets] Agent list error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
