/**
 * BetterDesk Console - System Routes
 * Provides API endpoints for dashboard widgets:
 *   GET  /api/system/info          — process list + disk usage
 *   GET  /api/logs/recent          — recent log lines
 *   GET  /api/database/stats       — database table row counts + size
 *   GET  /api/docker/containers    — docker container list
 *   POST /api/system/exec          — execute a whitelisted command (admin only)
 *   GET  /api/speed-test           — download payload for bandwidth measurement
 */

const express = require('express');
const router = express.Router();
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { requireAuth, requirePermission } = require('../middleware/auth');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeExec(cmd, timeout) {
    try {
        return execSync(cmd, { timeout: timeout || 5000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch (e) {
        return '';
    }
}

// ─── GET /api/system/info ─────────────────────────────────────────────────────

router.get('/api/system/info', requireAuth, requirePermission('metrics.view'), (req, res) => {
    try {
        const result = { processes: [], disks: [] };

        // --- Processes (top CPU consumers) ---
        if (process.platform === 'linux') {
            const raw = safeExec('ps aux --sort=-%cpu | head -16');
            const lines = raw.split('\n').slice(1); // skip header
            lines.forEach(line => {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 11) {
                    result.processes.push({
                        name: parts.slice(10).join(' ').substring(0, 64),
                        cpu: parseFloat(parts[2]) || 0,
                        mem: (parseFloat(parts[3]) || 0) / 100 * (os.totalmem() / 1048576) // percentage -> MB
                    });
                }
            });
        } else if (process.platform === 'win32') {
            const raw = safeExec('powershell -NoProfile -Command "Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 | ForEach-Object { $_.ProcessName + \'|\' + [math]::Round($_.CPU,1) + \'|\' + [math]::Round($_.WorkingSet64/1MB,1) }"', 10000);
            raw.split('\n').forEach(line => {
                const parts = line.trim().split('|');
                if (parts.length >= 3) {
                    result.processes.push({
                        name: parts[0],
                        cpu: parseFloat(parts[1]) || 0,
                        mem: parseFloat(parts[2]) || 0
                    });
                }
            });
        }

        // --- Disk usage ---
        if (process.platform === 'linux') {
            const raw = safeExec('df -B1 --output=target,size,used,avail 2>/dev/null | tail -n +2');
            raw.split('\n').forEach(line => {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 4) {
                    const mount = parts[0];
                    // Skip pseudo filesystems
                    if (mount.startsWith('/dev') || mount.startsWith('/sys') || mount.startsWith('/proc') || mount.startsWith('/run') || mount.startsWith('/snap')) return;
                    const total = parseInt(parts[1], 10) || 0;
                    const used = parseInt(parts[2], 10) || 0;
                    if (total < 1048576) return; // skip tiny
                    result.disks.push({ mount, total, used, free: total - used });
                }
            });
        } else if (process.platform === 'win32') {
            const raw = safeExec('wmic logicaldisk where "DriveType=3" get DeviceID,FreeSpace,Size /format:csv', 10000);
            raw.split('\n').forEach(line => {
                const parts = line.trim().split(',');
                if (parts.length >= 4 && parts[1]) {
                    const mount = parts[1];
                    const free = parseInt(parts[2], 10) || 0;
                    const total = parseInt(parts[3], 10) || 0;
                    if (total > 0) {
                        result.disks.push({ mount, name: mount, total, used: total - free, free });
                    }
                }
            });
        }

        // Add Node.js process info
        const mem = process.memoryUsage();
        result.node = {
            pid: process.pid,
            uptime: Math.floor(process.uptime()),
            heapUsed: Math.round(mem.heapUsed / 1048576),
            heapTotal: Math.round(mem.heapTotal / 1048576),
            rss: Math.round(mem.rss / 1048576)
        };

        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Failed to gather system info' });
    }
});

// ─── GET /api/logs/recent ─────────────────────────────────────────────────────

router.get('/api/logs/recent', requireAuth, requirePermission('metrics.view'), (req, res) => {
    try {
        const source = req.query.source || 'console';
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        let lines = [];

        if (source === 'go') {
            // Try to read Go server journal logs
            if (process.platform === 'linux') {
                const raw = safeExec(`journalctl -u betterdesk-server --no-pager -n ${limit} --output=short-iso 2>/dev/null || journalctl -u betterdesk-go --no-pager -n ${limit} --output=short-iso 2>/dev/null`);
                if (raw) lines = raw.split('\n');
            }
            if (!lines.length) {
                // Fallback: try log file
                const logPaths = ['/opt/rustdesk/betterdesk-server.log', '/opt/betterdesk/server.log', '/var/log/betterdesk-server.log'];
                for (const lp of logPaths) {
                    if (fs.existsSync(lp)) {
                        const content = fs.readFileSync(lp, 'utf8');
                        lines = content.split('\n').slice(-limit);
                        break;
                    }
                }
            }
        } else {
            // Console logs from journal
            if (process.platform === 'linux') {
                const raw = safeExec(`journalctl -u betterdesk-console --no-pager -n ${limit} --output=short-iso 2>/dev/null`);
                if (raw) lines = raw.split('\n');
            }
            if (!lines.length) {
                // Fallback: try PM2-style log file or stdout capture
                const logPaths = ['/opt/rustdesk/console.log', '/var/log/betterdesk-console.log'];
                for (const lp of logPaths) {
                    if (fs.existsSync(lp)) {
                        const content = fs.readFileSync(lp, 'utf8');
                        lines = content.split('\n').slice(-limit);
                        break;
                    }
                }
            }
        }

        res.json({ source, lines: lines.filter(l => l.trim()) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read logs' });
    }
});

// ─── GET /api/database/stats ──────────────────────────────────────────────────

router.get('/api/database/stats', requireAuth, requirePermission('metrics.view'), async (req, res) => {
    try {
        const db = require('../services/dbAdapter');
        const config = require('../config/config');
        const isPostgres = config.dbType === 'postgresql' || (config.databaseUrl || '').startsWith('postgres');
        const result = { type: isPostgres ? 'PostgreSQL' : 'SQLite', tables: [], size: '-' };

        if (isPostgres) {
            // PostgreSQL table stats
            const tables = await db.allAsync(
                `SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename`
            );
            for (const tbl of tables) {
                try {
                    const row = await db.getAsync(`SELECT COUNT(*) AS count FROM "${tbl.name}"`);
                    result.tables.push({ name: tbl.name, count: row ? row.count : 0 });
                } catch (e) { /* skip */ }
            }
            // DB size
            try {
                const sizeRow = await db.getAsync(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`);
                if (sizeRow) result.size = sizeRow.size;
            } catch (e) { /* skip */ }
        } else {
            // SQLite table stats
            const tables = await db.allAsync(
                `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
            );
            for (const tbl of tables) {
                try {
                    const row = await db.getAsync(`SELECT COUNT(*) AS count FROM "${tbl.name}"`);
                    result.tables.push({ name: tbl.name, count: row ? row.count : 0 });
                } catch (e) { /* skip */ }
            }
            // DB file size
            const dbPath = config.dbPath || path.join(__dirname, '..', 'data', 'auth.db');
            if (fs.existsSync(dbPath)) {
                const stat = fs.statSync(dbPath);
                const kb = stat.size / 1024;
                result.size = kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : Math.round(kb) + ' KB';
            }
        }

        // Check last backup
        const backupDir = path.join(__dirname, '..', 'data', 'backups');
        if (fs.existsSync(backupDir)) {
            try {
                const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.db') || f.endsWith('.sql') || f.endsWith('.gz'));
                if (files.length) {
                    const latest = files.sort().pop();
                    const stat = fs.statSync(path.join(backupDir, latest));
                    result.last_backup = stat.mtime.toISOString();
                }
            } catch (e) { /* skip */ }
        }

        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Failed to get database stats' });
    }
});

// ─── GET /api/docker/containers ───────────────────────────────────────────────

router.get('/api/docker/containers', requireAuth, requirePermission('metrics.view'), (req, res) => {
    try {
        const raw = safeExec('docker ps -a --format "{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}|{{.Ports}}" 2>/dev/null', 10000);
        if (!raw) {
            return res.json({ containers: [], available: false });
        }
        const containers = raw.split('\n').filter(l => l.trim()).map(line => {
            const parts = line.split('|');
            return {
                name: parts[0] || '',
                image: parts[1] || '',
                state: parts[2] || '',
                status: parts[3] || '',
                ports: parts[4] || ''
            };
        });
        res.json({ containers, available: true });
    } catch (err) {
        res.json({ containers: [], available: false });
    }
});

// ─── POST /api/system/exec ────────────────────────────────────────────────────

// Admin-only command execution with strict whitelist
const ALLOWED_COMMANDS = new Set([
    'uptime', 'date', 'hostname', 'whoami', 'df -h', 'free -m',
    'uname -a', 'cat /etc/os-release', 'systemctl status betterdesk-server',
    'systemctl status betterdesk-console', 'docker ps', 'docker stats --no-stream',
    'ip addr', 'ss -tlnp', 'netstat -tlnp', 'top -bn1 | head -20'
]);

router.post('/api/system/exec', requireAuth, requirePermission('server.config'), (req, res) => {
    try {
        const { command } = req.body;
        if (!command || typeof command !== 'string') {
            return res.status(400).json({ error: 'Command is required' });
        }

        const trimmed = command.trim();

        // Security: only allow whitelisted commands
        if (!ALLOWED_COMMANDS.has(trimmed)) {
            return res.status(403).json({ error: 'Command not in allowed list. Allowed: ' + Array.from(ALLOWED_COMMANDS).join(', ') });
        }

        const output = safeExec(trimmed, 10000);
        res.json({ output: output || '(no output)', command: trimmed });
    } catch (err) {
        res.status(500).json({ error: 'Execution failed' });
    }
});

// ─── GET /api/speed-test ──────────────────────────────────────────────────────

router.get('/api/speed-test', requireAuth, requirePermission('metrics.view'), (req, res) => {
    const size = Math.min(parseInt(req.query.size, 10) || 1048576, 10485760); // max 10MB
    res.set({
        'Content-Type': 'application/octet-stream',
        'Content-Length': size,
        'Cache-Control': 'no-store'
    });
    // Generate random-ish data in chunks to avoid large memory allocation
    const chunkSize = 65536;
    let remaining = size;
    const chunk = Buffer.alloc(chunkSize, 0x42); // fill with 'B'
    while (remaining > 0) {
        const toWrite = Math.min(remaining, chunkSize);
        res.write(toWrite === chunkSize ? chunk : chunk.slice(0, toWrite));
        remaining -= toWrite;
    }
    res.end();
});

module.exports = router;
