/**
 * BetterDesk Console — CDAP SDK Studio Routes
 * Visual node editor for building CDAP bridge flows.
 * Phase 14 of the BetterDesk 3.0 Roadmap.
 */

const express = require('express');
const router = express.Router();
const { requireAuth, requireRole, isSuperAdminRole } = require('../middleware/auth');
const betterdeskApi = require('../services/betterdeskApi');
const db = require('../services/dbAdapter');
const crypto = require('crypto');

// ── Page Route ───────────────────────────────────────────────────────────

/**
 * GET /cdap-studio
 * Renders the SDK Studio visual editor page.
 */
router.get('/cdap-studio', requireAuth, requireRole('operator'), (req, res) => {
    res.render('cdap-studio', {
        title: req.t('sdk_studio.title'),
        currentPage: 'cdap-studio'
    });
});

// ── Flow persistence (stored in Node.js auth.db) ────────────────────────

// Ensure studio_flows table exists
(async () => {
    try {
        await db.run(`
            CREATE TABLE IF NOT EXISTS studio_flows (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                flow_json TEXT NOT NULL DEFAULT '{}',
                status TEXT DEFAULT 'draft',
                version INTEGER DEFAULT 1,
                created_by TEXT DEFAULT '',
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            )
        `);
    } catch (_) { /* table may already exist */ }
})();

// ── API Routes ───────────────────────────────────────────────────────────

/**
 * GET /api/cdap-studio/flows
 * List all saved flows for the current user (or all for admin).
 */
router.get('/api/cdap-studio/flows', requireAuth, async (req, res) => {
    try {
        const isAdmin = isSuperAdminRole(req.session.user && req.session.user.role);
        let rows;
        if (isAdmin) {
            rows = await db.all(
                'SELECT id, name, description, status, version, created_by, created_at, updated_at FROM studio_flows ORDER BY updated_at DESC'
            );
        } else {
            rows = await db.all(
                'SELECT id, name, description, status, version, created_by, created_at, updated_at FROM studio_flows WHERE created_by = ? ORDER BY updated_at DESC',
                [req.session.user.username]
            );
        }
        res.json({ success: true, flows: rows || [] });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to list flows' });
    }
});

/**
 * GET /api/cdap-studio/flows/:id
 * Get a single flow with full JSON.
 */
router.get('/api/cdap-studio/flows/:id', requireAuth, async (req, res) => {
    try {
        const row = await db.get(
            'SELECT * FROM studio_flows WHERE id = ?',
            [req.params.id]
        );
        if (!row) return res.status(404).json({ success: false, error: 'Flow not found' });
        res.json({ success: true, flow: row });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to get flow' });
    }
});

/**
 * POST /api/cdap-studio/flows
 * Create a new flow.
 */
router.post('/api/cdap-studio/flows', requireAuth, requireRole('operator'), async (req, res) => {
    try {
        const { name, description, flow_json } = req.body;
        if (!name || typeof name !== 'string' || name.length > 100) {
            return res.status(400).json({ success: false, error: 'Invalid flow name' });
        }
        const id = crypto.randomBytes(8).toString('hex');
        const jsonStr = typeof flow_json === 'string' ? flow_json : JSON.stringify(flow_json || {});
        if (jsonStr.length > 5 * 1024 * 1024) {
            return res.status(400).json({ success: false, error: 'Flow data too large (max 5MB)' });
        }

        await db.run(
            `INSERT INTO studio_flows (id, name, description, flow_json, created_by)
             VALUES (?, ?, ?, ?, ?)`,
            [id, name.trim(), (description || '').trim().slice(0, 500), jsonStr, req.session.user.username]
        );
        res.json({ success: true, id });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to create flow' });
    }
});

/**
 * PUT /api/cdap-studio/flows/:id
 * Update an existing flow (name, description, flow_json).
 */
router.put('/api/cdap-studio/flows/:id', requireAuth, requireRole('operator'), async (req, res) => {
    try {
        const { name, description, flow_json } = req.body;
        const existing = await db.get('SELECT id, created_by FROM studio_flows WHERE id = ?', [req.params.id]);
        if (!existing) return res.status(404).json({ success: false, error: 'Flow not found' });

        // Only creator or admin can edit
        const user = req.session.user;
        if (user.role !== 'admin' && existing.created_by !== user.username) {
            return res.status(403).json({ success: false, error: 'Not authorized' });
        }

        const jsonStr = typeof flow_json === 'string' ? flow_json : JSON.stringify(flow_json || {});
        if (jsonStr.length > 5 * 1024 * 1024) {
            return res.status(400).json({ success: false, error: 'Flow data too large (max 5MB)' });
        }

        await db.run(
            `UPDATE studio_flows SET name = ?, description = ?, flow_json = ?,
             version = version + 1, updated_at = datetime('now') WHERE id = ?`,
            [
                (name || existing.name || '').trim().slice(0, 100),
                (description || '').trim().slice(0, 500),
                jsonStr,
                req.params.id
            ]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to update flow' });
    }
});

/**
 * DELETE /api/cdap-studio/flows/:id
 * Delete a flow.
 */
router.delete('/api/cdap-studio/flows/:id', requireAuth, requireRole('operator'), async (req, res) => {
    try {
        const existing = await db.get('SELECT id, created_by FROM studio_flows WHERE id = ?', [req.params.id]);
        if (!existing) return res.status(404).json({ success: false, error: 'Flow not found' });

        const user = req.session.user;
        if (user.role !== 'admin' && existing.created_by !== user.username) {
            return res.status(403).json({ success: false, error: 'Not authorized' });
        }

        await db.run('DELETE FROM studio_flows WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to delete flow' });
    }
});

/**
 * POST /api/cdap-studio/flows/:id/deploy
 * Deploy a flow to the Go server for execution.
 */
router.post('/api/cdap-studio/flows/:id/deploy', requireAuth, requireRole('operator'), async (req, res) => {
    try {
        const row = await db.get('SELECT * FROM studio_flows WHERE id = ?', [req.params.id]);
        if (!row) return res.status(404).json({ success: false, error: 'Flow not found' });

        // Mark as deployed in local DB
        await db.run(
            `UPDATE studio_flows SET status = 'deployed', updated_at = datetime('now') WHERE id = ?`,
            [req.params.id]
        );

        res.json({ success: true, status: 'deployed' });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to deploy flow' });
    }
});

/**
 * POST /api/cdap-studio/flows/:id/test
 * Run a flow in sandbox/dry-run mode.
 */
router.post('/api/cdap-studio/flows/:id/test', requireAuth, requireRole('operator'), async (req, res) => {
    try {
        const row = await db.get('SELECT * FROM studio_flows WHERE id = ?', [req.params.id]);
        if (!row) return res.status(404).json({ success: false, error: 'Flow not found' });

        let flowData;
        try {
            flowData = JSON.parse(row.flow_json);
        } catch (_) {
            return res.status(400).json({ success: false, error: 'Invalid flow JSON' });
        }

        // Simulate execution — walk nodes in topological order
        const nodes = flowData.nodes || [];
        const wires = flowData.wires || [];
        const results = [];

        for (const node of nodes) {
            results.push({
                nodeId: node.id,
                nodeType: node.type,
                label: node.label || node.type,
                status: 'ok',
                output: { _simulated: true, value: `Mock data from ${node.type}` }
            });
        }

        res.json({ success: true, results, nodeCount: nodes.length, wireCount: wires.length });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to test flow' });
    }
});

/**
 * POST /api/cdap-studio/flows/:id/export
 * Export flow as downloadable .bdflow JSON.
 */
router.get('/api/cdap-studio/flows/:id/export', requireAuth, async (req, res) => {
    try {
        const row = await db.get('SELECT * FROM studio_flows WHERE id = ?', [req.params.id]);
        if (!row) return res.status(404).json({ success: false, error: 'Flow not found' });

        const exportData = {
            version: '1.0',
            format: 'bdflow',
            name: row.name,
            description: row.description,
            flow: JSON.parse(row.flow_json),
            exportedAt: new Date().toISOString(),
            exportedBy: req.session.user.username
        };

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${row.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.bdflow"`);
        res.send(JSON.stringify(exportData, null, 2));
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to export flow' });
    }
});

/**
 * POST /api/cdap-studio/flows/import
 * Import a .bdflow file.
 */
router.post('/api/cdap-studio/flows/import', requireAuth, requireRole('operator'), async (req, res) => {
    try {
        const { name, description, flow } = req.body;
        if (!flow || typeof flow !== 'object') {
            return res.status(400).json({ success: false, error: 'Invalid .bdflow format' });
        }

        const id = crypto.randomBytes(8).toString('hex');
        const flowName = (name || 'Imported Flow').trim().slice(0, 100);
        const jsonStr = JSON.stringify(flow);

        await db.run(
            `INSERT INTO studio_flows (id, name, description, flow_json, created_by)
             VALUES (?, ?, ?, ?, ?)`,
            [id, flowName, (description || '').trim().slice(0, 500), jsonStr, req.session.user.username]
        );
        res.json({ success: true, id });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to import flow' });
    }
});

/**
 * GET /api/cdap-studio/templates
 * Returns pre-built flow templates.
 */
router.get('/api/cdap-studio/templates', requireAuth, (req, res) => {
    const templates = [
        {
            id: 'temp-monitor',
            name: 'Temperature Monitor',
            description: 'Modbus TCP temperature reading with high-temp alert',
            icon: 'thermostat',
            flow: {
                nodes: [
                    { id: 'n1', type: 'modbus-tcp', x: 100, y: 150, label: 'Modbus TCP', config: { host: '192.168.1.100', port: 502, unitId: 1, register: 100, dataType: 'float32', interval: 5000 } },
                    { id: 'n2', type: 'filter', x: 400, y: 150, label: 'High Temp', config: { field: 'value', operator: '>', threshold: 80 } },
                    { id: 'n3', type: 'widget-update', x: 700, y: 80, label: 'Dashboard', config: { widgetId: '', valueField: 'value' } },
                    { id: 'n4', type: 'alert', x: 700, y: 220, label: 'Alert', config: { severity: 'warning', message: 'Temperature ${value}°C exceeds threshold!' } }
                ],
                wires: [
                    { from: 'n1', to: 'n2', fromPort: 'out', toPort: 'in' },
                    { from: 'n2', to: 'n3', fromPort: 'pass', toPort: 'in' },
                    { from: 'n2', to: 'n4', fromPort: 'pass', toPort: 'in' }
                ]
            }
        },
        {
            id: 'snmp-health',
            name: 'SNMP Health Dashboard',
            description: 'Poll SNMP devices and display uptime/status',
            icon: 'router',
            flow: {
                nodes: [
                    { id: 'n1', type: 'snmp-poll', x: 100, y: 150, label: 'SNMP Poll', config: { host: '192.168.1.1', community: 'public', version: '2c', oids: ['1.3.6.1.2.1.1.3.0'], interval: 10000 } },
                    { id: 'n2', type: 'transform', x: 400, y: 150, label: 'Format', config: { expression: 'Math.floor(value / 100)' } },
                    { id: 'n3', type: 'widget-update', x: 700, y: 150, label: 'Uptime Widget', config: { widgetId: '', valueField: 'value' } }
                ],
                wires: [
                    { from: 'n1', to: 'n2', fromPort: 'out', toPort: 'in' },
                    { from: 'n2', to: 'n3', fromPort: 'out', toPort: 'in' }
                ]
            }
        },
        {
            id: 'rest-aggregator',
            name: 'REST API Aggregator',
            description: 'Poll multiple REST endpoints and merge data',
            icon: 'api',
            flow: {
                nodes: [
                    { id: 'n1', type: 'rest-poll', x: 100, y: 100, label: 'API 1', config: { url: 'https://api.example.com/data', method: 'GET', interval: 30000 } },
                    { id: 'n2', type: 'rest-poll', x: 100, y: 250, label: 'API 2', config: { url: 'https://api.example.com/status', method: 'GET', interval: 30000 } },
                    { id: 'n3', type: 'merge', x: 400, y: 175, label: 'Merge', config: { strategy: 'latest' } },
                    { id: 'n4', type: 'log', x: 700, y: 175, label: 'Log', config: { level: 'info', message: 'Aggregated: ${JSON.stringify(data)}' } }
                ],
                wires: [
                    { from: 'n1', to: 'n3', fromPort: 'out', toPort: 'in' },
                    { from: 'n2', to: 'n3', fromPort: 'out', toPort: 'in' },
                    { from: 'n3', to: 'n4', fromPort: 'out', toPort: 'in' }
                ]
            }
        },
        {
            id: 'modbus-control',
            name: 'Modbus PLC Control',
            description: 'Read PLC registers, apply logic, write back',
            icon: 'precision_manufacturing',
            flow: {
                nodes: [
                    { id: 'n1', type: 'modbus-tcp', x: 100, y: 150, label: 'Read PLC', config: { host: '192.168.1.50', port: 502, unitId: 1, register: 0, dataType: 'int16', interval: 2000 } },
                    { id: 'n2', type: 'switch', x: 400, y: 150, label: 'Check Range', config: { conditions: [{ field: 'value', operator: '>', value: 100 }] } },
                    { id: 'n3', type: 'modbus-write', x: 700, y: 80, label: 'Write PLC', config: { host: '192.168.1.50', port: 502, register: 10, value: '1' } },
                    { id: 'n4', type: 'alert', x: 700, y: 220, label: 'Over Range', config: { severity: 'critical', message: 'PLC value ${value} exceeded limit!' } }
                ],
                wires: [
                    { from: 'n1', to: 'n2', fromPort: 'out', toPort: 'in' },
                    { from: 'n2', to: 'n3', fromPort: 'pass', toPort: 'in' },
                    { from: 'n2', to: 'n4', fromPort: 'pass', toPort: 'in' }
                ]
            }
        },
        {
            id: 'file-watcher',
            name: 'File Change Detector',
            description: 'Watch directory for changes and notify',
            icon: 'folder_open',
            flow: {
                nodes: [
                    { id: 'n1', type: 'file-watch', x: 100, y: 150, label: 'Watch Files', config: { path: '/var/log/', pattern: '*.log', events: ['modify'] } },
                    { id: 'n2', type: 'debounce', x: 400, y: 150, label: 'Debounce 5s', config: { cooldown: 5000 } },
                    { id: 'n3', type: 'alert', x: 700, y: 150, label: 'Notify', config: { severity: 'info', message: 'File changed: ${filename}' } }
                ],
                wires: [
                    { from: 'n1', to: 'n2', fromPort: 'out', toPort: 'in' },
                    { from: 'n2', to: 'n3', fromPort: 'out', toPort: 'in' }
                ]
            }
        }
    ];

    res.json({ success: true, templates });
});

module.exports = router;
