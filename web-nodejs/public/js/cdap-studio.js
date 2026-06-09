/**
 * BetterDesk Console — CDAP SDK Studio
 * Visual node-based flow editor for building CDAP bridge configurations.
 * Phase 14 of the BetterDesk 3.0 Roadmap.
 *
 * Architecture:
 *   - Flow state  = { nodes: [], wires: [] } stored as JSON
 *   - Canvas      = SVG with pan/zoom via transform on a <g> wrapper
 *   - Nodes       = SVG <g> groups with rect + text + port circles
 *   - Wires       = SVG <path> cubic bezier curves
 *   - Drag & drop = mousedown/mousemove/mouseup on palette items & nodes
 *   - Inspector   = DOM panel dynamically rebuilt per selected node
 *   - Persistence = REST API to /api/cdap-studio/flows/*
 */
(function () {
    'use strict';

    const _ = window._ || (k => k);

    // ─── Node Registry ──────────────────────────────────────────────

    const NODE_DEFS = {
        // Sources
        'modbus-tcp':       { cat: 'sources', icon: 'electrical_services', label: 'Modbus TCP', desc: 'Read Modbus registers via TCP', ports: { in: 0, out: 1 }, config: { host: '192.168.1.100', port: 502, unitId: 1, register: 100, dataType: 'float32', interval: 5000 } },
        'modbus-rtu':       { cat: 'sources', icon: 'usb',               label: 'Modbus RTU', desc: 'Read serial Modbus', ports: { in: 0, out: 1 }, config: { serialPort: '/dev/ttyUSB0', baud: 9600, parity: 'none', slaveId: 1, register: 0, dataType: 'int16', interval: 5000 } },
        'snmp-poll':        { cat: 'sources', icon: 'router',            label: 'SNMP Poll', desc: 'Poll SNMP OIDs', ports: { in: 0, out: 1 }, config: { host: '192.168.1.1', community: 'public', version: '2c', oids: '1.3.6.1.2.1.1.3.0', interval: 10000 } },
        'rest-poll':        { cat: 'sources', icon: 'api',               label: 'REST Poll', desc: 'Poll HTTP/REST endpoint', ports: { in: 0, out: 1 }, config: { url: 'https://api.example.com/data', method: 'GET', headers: '', interval: 30000, jmesPath: '' } },
        'mqtt-subscribe':   { cat: 'sources', icon: 'cell_tower',        label: 'MQTT Subscribe', desc: 'Listen to MQTT topic', ports: { in: 0, out: 1 }, config: { broker: 'mqtt://broker:1883', topic: 'sensors/#', qos: 0, tls: false } },
        'webhook-listen':   { cat: 'sources', icon: 'webhook',           label: 'Webhook', desc: 'Receive HTTP webhooks', ports: { in: 0, out: 1 }, config: { path: '/webhook/data', method: 'POST', authToken: '' } },
        'device-telemetry': { cat: 'sources', icon: 'developer_board',   label: 'Device Telemetry', desc: 'BetterDesk agent metrics', ports: { in: 0, out: 1 }, config: { deviceId: '', metrics: 'cpu,memory,disk' } },
        'database-query':   { cat: 'sources', icon: 'storage',           label: 'Database Query', desc: 'Poll SQL database', ports: { in: 0, out: 1 }, config: { dsn: '', query: 'SELECT 1', interval: 60000 } },
        'file-watch':       { cat: 'sources', icon: 'folder_open',       label: 'File Watch', desc: 'Watch file changes', ports: { in: 0, out: 1 }, config: { path: '/var/log/', pattern: '*.log', events: 'modify' } },

        // Processing
        'filter':    { cat: 'processing', icon: 'filter_alt', label: 'Filter', desc: 'Pass/block based on condition', ports: { in: 1, out: 1, pass: 1 }, config: { field: 'value', operator: '>', threshold: 0 } },
        'transform': { cat: 'processing', icon: 'swap_horiz', label: 'Transform', desc: 'Map/rename/calculate fields', ports: { in: 1, out: 1 }, config: { expression: 'value * 1' } },
        'aggregate': { cat: 'processing', icon: 'functions',  label: 'Aggregate', desc: 'Combine inputs (avg/min/max)', ports: { in: 1, out: 1 }, config: { mode: 'avg', window: 10 } },
        'delay':     { cat: 'processing', icon: 'timer',      label: 'Delay', desc: 'Hold data for N seconds', ports: { in: 1, out: 1 }, config: { duration: 5000, bufferSize: 100 } },
        'debounce':  { cat: 'processing', icon: 'slow_motion_video', label: 'Debounce', desc: 'Suppress rapid changes', ports: { in: 1, out: 1 }, config: { cooldown: 5000 } },
        'switch':    { cat: 'processing', icon: 'call_split', label: 'Switch', desc: 'Route to different paths', ports: { in: 1, out: 1, pass: 1 }, config: { conditions: [{ field: 'value', operator: '>', value: 0 }] } },
        'merge':     { cat: 'processing', icon: 'merge',      label: 'Merge', desc: 'Combine multiple streams', ports: { in: 2, out: 1 }, config: { strategy: 'latest' } },
        'script':    { cat: 'processing', icon: 'code',       label: 'Script', desc: 'Custom JavaScript code', ports: { in: 1, out: 1 }, config: { code: '// msg.payload\nreturn msg;' } },

        // Outputs
        'widget-update': { cat: 'outputs', icon: 'dashboard',     label: 'Widget Update', desc: 'Update CDAP widget', ports: { in: 1, out: 0 }, config: { widgetId: '', valueField: 'value' } },
        'alert':         { cat: 'outputs', icon: 'notifications', label: 'Alert', desc: 'Trigger alert/notification', ports: { in: 1, out: 0 }, config: { severity: 'warning', message: 'Alert: ${value}' } },
        'command':       { cat: 'outputs', icon: 'send',          label: 'Command', desc: 'Send command to device', ports: { in: 1, out: 0 }, config: { deviceId: '', commandType: '', payload: '{}' } },
        'log':           { cat: 'outputs', icon: 'list_alt',      label: 'Log', desc: 'Write to audit log', ports: { in: 1, out: 0 }, config: { level: 'info', message: '${JSON.stringify(data)}' } },
        'rest-call':     { cat: 'outputs', icon: 'http',          label: 'REST Call', desc: 'Call external API', ports: { in: 1, out: 0 }, config: { url: '', method: 'POST', headers: '', bodyTemplate: '${JSON.stringify(data)}' } },
        'mqtt-publish':  { cat: 'outputs', icon: 'publish',      label: 'MQTT Publish', desc: 'Publish to MQTT', ports: { in: 1, out: 0 }, config: { broker: '', topic: '', payloadTemplate: '${JSON.stringify(data)}' } },
        'database-write':{ cat: 'outputs', icon: 'save',         label: 'Database Write', desc: 'Insert/update SQL', ports: { in: 1, out: 0 }, config: { dsn: '', table: '', fieldMapping: '' } },
        'email':         { cat: 'outputs', icon: 'email',         label: 'Email', desc: 'Send email notification', ports: { in: 1, out: 0 }, config: { to: '', subject: '', body: '' } },
        'modbus-write':  { cat: 'outputs', icon: 'edit_note',     label: 'Modbus Write', desc: 'Write Modbus register', ports: { in: 1, out: 0 }, config: { host: '', port: 502, register: 0, value: '0' } }
    };

    // ─── State ──────────────────────────────────────────────────────

    let flow = { nodes: [], wires: [] };
    let flowMeta = { id: null, name: _('sdk_studio.untitled'), description: '' };
    let selectedNodeId = null;
    let selectedWireIdx = null;
    let zoomLevel = 1;
    let panX = 0, panY = 0;
    let isPanning = false;
    let panStart = { x: 0, y: 0 };
    let isDraggingNode = false;
    let dragNodeId = null;
    let dragOffset = { x: 0, y: 0 };
    let isDrawingWire = false;
    let wireStart = { nodeId: null, portName: null };
    let undoStack = [];
    let redoStack = [];
    let nodeIdCounter = 0;
    let showGrid = true;

    // ─── DOM References ─────────────────────────────────────────────

    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const svgEl = $('#studio-canvas-svg');
    const wiresLayer = $('#studio-wires-layer');
    const nodesLayer = $('#studio-nodes-layer');
    const tempWire = $('#studio-temp-wire');
    const canvasWrap = $('#studio-canvas-wrap');
    const emptyState = $('#studio-empty-state');
    const inspectorBody = $('#studio-inspector-body');
    const consoleBody = $('#studio-console-body');

    // ─── Helpers ────────────────────────────────────────────────────

    function sanitizeMaterialIcon(name) {
        const s = String(name || 'apps').trim();
        return /^[a-z0-9_]+$/.test(s) ? s : 'apps';
    }

    function esc(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    function genId() {
        return 'n' + (++nodeIdCounter);
    }

    function timeStr() {
        const d = new Date();
        return String(d.getHours()).padStart(2, '0') + ':' +
               String(d.getMinutes()).padStart(2, '0') + ':' +
               String(d.getSeconds()).padStart(2, '0');
    }

    function logConsole(msg, level) {
        level = level || 'info';
        const line = document.createElement('div');
        line.className = 'studio-console-line studio-console-' + level;
        line.innerHTML = `<span class="studio-console-time">${timeStr()}</span><span class="studio-console-msg">${esc(msg)}</span>`;
        consoleBody.appendChild(line);
        consoleBody.scrollTop = consoleBody.scrollHeight;
    }

    function pushUndo() {
        undoStack.push(JSON.stringify(flow));
        if (undoStack.length > 50) undoStack.shift();
        redoStack = [];
    }

    function doUndo() {
        if (!undoStack.length) return;
        redoStack.push(JSON.stringify(flow));
        flow = JSON.parse(undoStack.pop());
        selectedNodeId = null;
        selectedWireIdx = null;
        renderAll();
        logConsole('Undo', 'info');
    }

    function doRedo() {
        if (!redoStack.length) return;
        undoStack.push(JSON.stringify(flow));
        flow = JSON.parse(redoStack.pop());
        selectedNodeId = null;
        selectedWireIdx = null;
        renderAll();
        logConsole('Redo', 'info');
    }

    function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

    function svgPoint(clientX, clientY) {
        // Convert client coords to canvas coords accounting for pan/zoom
        const rect = canvasWrap.getBoundingClientRect();
        return {
            x: (clientX - rect.left - panX) / zoomLevel,
            y: (clientY - rect.top - panY) / zoomLevel
        };
    }

    // ─── Palette ────────────────────────────────────────────────────

    function buildPalette() {
        const cats = { sources: [], processing: [], outputs: [] };
        for (const [type, def] of Object.entries(NODE_DEFS)) {
            cats[def.cat].push({ type, ...def });
        }

        for (const cat of ['sources', 'processing', 'outputs']) {
            const container = $(`#palette-${cat}`);
            if (!container) continue;
            container.innerHTML = '';
            for (const n of cats[cat]) {
                const el = document.createElement('div');
                el.className = 'studio-palette-node';
                el.dataset.type = n.type;
                el.dataset.cat = cat;
                el.draggable = true;
                el.title = n.desc;
                el.innerHTML = `<span class="studio-node-dot"></span><span class="material-icons studio-node-icon">${sanitizeMaterialIcon(n.icon)}</span><span>${esc(n.label)}</span>`;
                container.appendChild(el);
            }
        }

        // Category toggle
        for (const btn of $$('.studio-palette-cat-btn')) {
            btn.addEventListener('click', () => {
                btn.closest('.studio-palette-category').classList.toggle('collapsed');
            });
        }

        // Search filter
        const searchInput = $('#palette-search');
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                const q = searchInput.value.toLowerCase();
                for (const item of $$('.studio-palette-node')) {
                    const visible = !q || item.textContent.toLowerCase().includes(q);
                    item.style.display = visible ? '' : 'none';
                }
            });
        }

        // Drag from palette
        for (const item of $$('.studio-palette-node')) {
            item.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', item.dataset.type);
                e.dataTransfer.effectAllowed = 'copy';
            });
        }
    }

    // ─── Canvas Drop ────────────────────────────────────────────────

    function initCanvasDrop() {
        canvasWrap.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });

        canvasWrap.addEventListener('drop', (e) => {
            e.preventDefault();
            const type = e.dataTransfer.getData('text/plain');
            if (!NODE_DEFS[type]) return;

            const pos = svgPoint(e.clientX, e.clientY);
            pushUndo();
            addNode(type, pos.x, pos.y);
            renderAll();
            logConsole(`Added node: ${NODE_DEFS[type].label}`, 'success');
        });
    }

    // ─── Node Operations ────────────────────────────────────────────

    function addNode(type, x, y, label, config, id) {
        const def = NODE_DEFS[type];
        if (!def) return null;

        const node = {
            id: id || genId(),
            type,
            x: Math.round(x),
            y: Math.round(y),
            label: label || def.label,
            config: config ? { ...config } : { ...def.config }
        };
        flow.nodes.push(node);
        updateStatus();
        return node;
    }

    function deleteNode(nodeId) {
        pushUndo();
        flow.nodes = flow.nodes.filter(n => n.id !== nodeId);
        flow.wires = flow.wires.filter(w => w.from !== nodeId && w.to !== nodeId);
        if (selectedNodeId === nodeId) selectedNodeId = null;
        renderAll();
        logConsole('Node deleted', 'warn');
    }

    function getNode(id) {
        return flow.nodes.find(n => n.id === id);
    }

    // ─── Wire Operations ────────────────────────────────────────────

    function addWire(fromNodeId, fromPort, toNodeId, toPort) {
        // Prevent duplicate
        const exists = flow.wires.some(w =>
            w.from === fromNodeId && w.fromPort === fromPort &&
            w.to === toNodeId && w.toPort === toPort
        );
        if (exists) return;
        // Prevent self-connect
        if (fromNodeId === toNodeId) return;

        flow.wires.push({
            from: fromNodeId, fromPort: fromPort || 'out',
            to: toNodeId, toPort: toPort || 'in'
        });
        updateStatus();
    }

    function deleteWire(idx) {
        if (idx < 0 || idx >= flow.wires.length) return;
        pushUndo();
        flow.wires.splice(idx, 1);
        if (selectedWireIdx === idx) selectedWireIdx = null;
        renderAll();
        logConsole('Wire removed', 'warn');
    }

    // ─── Port Positions ─────────────────────────────────────────────

    const NODE_W = 180;
    const NODE_H = 52;
    const PORT_R = 6;

    function getPortPos(node, portName) {
        const def = NODE_DEFS[node.type] || {};
        const ports = def.ports || { in: 1, out: 1 };

        if (portName === 'in') {
            return { x: node.x, y: node.y + NODE_H / 2 };
        }
        if (portName === 'out') {
            return { x: node.x + NODE_W, y: node.y + NODE_H / 2 };
        }
        if (portName === 'pass') {
            return { x: node.x + NODE_W, y: node.y + NODE_H / 2 - 14 };
        }
        // Default: out
        return { x: node.x + NODE_W, y: node.y + NODE_H / 2 };
    }

    // ─── Rendering ──────────────────────────────────────────────────

    function renderAll() {
        renderNodes();
        renderWires();
        renderMinimap();
        updateEmptyState();
        updateStatus();
        if (selectedNodeId) renderInspector(selectedNodeId);
    }

    function renderNodes() {
        nodesLayer.innerHTML = '';

        for (const node of flow.nodes) {
            const def = NODE_DEFS[node.type] || {};
            const cat = def.cat || 'sources';
            const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            g.setAttribute('class', 'studio-node' + (node.id === selectedNodeId ? ' selected' : ''));
            g.setAttribute('data-id', node.id);
            g.setAttribute('data-category', cat);
            g.setAttribute('transform', `translate(${node.x}, ${node.y})`);

            // Body rect
            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('class', 'studio-node-body');
            rect.setAttribute('width', NODE_W);
            rect.setAttribute('height', NODE_H);
            g.appendChild(rect);

            // Accent bar (left edge color by category)
            const accent = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            accent.setAttribute('class', 'studio-node-accent');
            accent.setAttribute('x', 0);
            accent.setAttribute('y', 0);
            accent.setAttribute('width', 4);
            accent.setAttribute('height', NODE_H);
            g.appendChild(accent);

            // Icon
            const icon = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            icon.setAttribute('class', 'studio-node-icon');
            icon.setAttribute('x', 14);
            icon.setAttribute('y', 22);
            icon.textContent = def.icon || 'category';
            g.appendChild(icon);

            // Label
            const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            label.setAttribute('class', 'studio-node-label');
            label.setAttribute('x', 36);
            label.setAttribute('y', 22);
            label.textContent = (node.label || def.label || node.type).slice(0, 20);
            g.appendChild(label);

            // Type subtitle
            const typeTxt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            typeTxt.setAttribute('class', 'studio-node-type');
            typeTxt.setAttribute('x', 36);
            typeTxt.setAttribute('y', 38);
            typeTxt.textContent = node.type;
            g.appendChild(typeTxt);

            // Input ports
            const ports = def.ports || { in: 1, out: 1 };
            if (ports.in) {
                for (let i = 0; i < ports.in; i++) {
                    const cy = NODE_H / 2 + (i - (ports.in - 1) / 2) * 18;
                    const port = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                    port.setAttribute('class', 'studio-port studio-port-in');
                    port.setAttribute('cx', 0);
                    port.setAttribute('cy', cy);
                    port.setAttribute('r', PORT_R);
                    port.dataset.nodeId = node.id;
                    port.dataset.port = 'in';
                    g.appendChild(port);
                }
            }

            // Output ports
            const outPorts = [];
            if (ports.out) outPorts.push('out');
            if (ports.pass) outPorts.push('pass');

            for (let i = 0; i < outPorts.length; i++) {
                const pName = outPorts[i];
                const cy = NODE_H / 2 + (i - (outPorts.length - 1) / 2) * 18;
                const port = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                port.setAttribute('class', 'studio-port studio-port-out');
                port.setAttribute('cx', NODE_W);
                port.setAttribute('cy', cy);
                port.setAttribute('r', PORT_R);
                port.dataset.nodeId = node.id;
                port.dataset.port = pName;
                g.appendChild(port);
            }

            nodesLayer.appendChild(g);
        }
    }

    function renderWires() {
        wiresLayer.innerHTML = '';

        for (let i = 0; i < flow.wires.length; i++) {
            const w = flow.wires[i];
            const fromNode = getNode(w.from);
            const toNode = getNode(w.to);
            if (!fromNode || !toNode) continue;

            const p1 = getPortPos(fromNode, w.fromPort || 'out');
            const p2 = getPortPos(toNode, w.toPort || 'in');

            const dx = Math.abs(p2.x - p1.x) * 0.5;
            const d = `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`;

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('class', 'studio-wire' + (i === selectedWireIdx ? ' selected' : ''));
            path.setAttribute('d', d);
            path.dataset.wireIdx = i;
            wiresLayer.appendChild(path);
        }
    }

    function renderMinimap() {
        const canvas = $('#studio-minimap-canvas');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const W = 160, H = 100;
        ctx.clearRect(0, 0, W, H);

        if (!flow.nodes.length) return;

        // Find bounds
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of flow.nodes) {
            if (n.x < minX) minX = n.x;
            if (n.y < minY) minY = n.y;
            if (n.x + NODE_W > maxX) maxX = n.x + NODE_W;
            if (n.y + NODE_H > maxY) maxY = n.y + NODE_H;
        }

        const pad = 40;
        minX -= pad; minY -= pad; maxX += pad; maxY += pad;
        const sw = maxX - minX || 1;
        const sh = maxY - minY || 1;
        const scale = Math.min(W / sw, H / sh);

        // Draw wires
        ctx.strokeStyle = 'rgba(88,166,255,0.3)';
        ctx.lineWidth = 1;
        for (const w of flow.wires) {
            const from = getNode(w.from);
            const to = getNode(w.to);
            if (!from || !to) continue;
            ctx.beginPath();
            ctx.moveTo((from.x + NODE_W - minX) * scale, (from.y + NODE_H / 2 - minY) * scale);
            ctx.lineTo((to.x - minX) * scale, (to.y + NODE_H / 2 - minY) * scale);
            ctx.stroke();
        }

        // Draw nodes
        for (const n of flow.nodes) {
            const def = NODE_DEFS[n.type] || {};
            ctx.fillStyle = def.cat === 'sources' ? '#1f6feb' : def.cat === 'processing' ? '#9e6a03' : '#238636';
            ctx.fillRect((n.x - minX) * scale, (n.y - minY) * scale, NODE_W * scale, NODE_H * scale);
        }
    }

    function updateEmptyState() {
        if (emptyState) {
            emptyState.style.display = flow.nodes.length ? 'none' : '';
        }
    }

    function updateStatus() {
        const sn = $('#status-nodes');
        const sw = $('#status-wires');
        const sf = $('#status-flow-label');
        const fn = $('#studio-flow-name');
        if (sn) sn.textContent = flow.nodes.length;
        if (sw) sw.textContent = flow.wires.length;
        if (sf) sf.textContent = flowMeta.name;
        if (fn) fn.textContent = flowMeta.name;
    }

    // ─── Inspector ──────────────────────────────────────────────────

    function renderInspector(nodeId) {
        const node = getNode(nodeId);
        if (!node) {
            clearInspector();
            return;
        }

        const def = NODE_DEFS[node.type] || {};
        let html = '';

        // Node header
        html += `<div class="studio-inspector-section">${esc(node.label || def.label)} <small>(${esc(node.type)})</small></div>`;

        // Label field
        html += `<div class="studio-field">
            <label>${_('sdk_studio.label')}</label>
            <input type="text" data-field="label" value="${esc(node.label || '')}" maxlength="40">
        </div>`;

        // Config fields
        html += `<div class="studio-inspector-section">${_('sdk_studio.configuration')}</div>`;

        const cfg = node.config || {};
        for (const [key, defaultVal] of Object.entries(def.config || {})) {
            const val = cfg[key] !== undefined ? cfg[key] : defaultVal;
            const fieldLabel = key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ');

            if (typeof defaultVal === 'boolean') {
                html += `<div class="studio-field">
                    <label>${esc(fieldLabel)}</label>
                    <select data-config="${esc(key)}">
                        <option value="true" ${val ? 'selected' : ''}>true</option>
                        <option value="false" ${!val ? 'selected' : ''}>false</option>
                    </select>
                </div>`;
            } else if (typeof defaultVal === 'number') {
                html += `<div class="studio-field">
                    <label>${esc(fieldLabel)}</label>
                    <input type="number" data-config="${esc(key)}" value="${val}">
                </div>`;
            } else if (key === 'code' || key === 'expression') {
                html += `<div class="studio-field">
                    <label>${esc(fieldLabel)}</label>
                    <textarea data-config="${esc(key)}" rows="4">${esc(String(val))}</textarea>
                </div>`;
            } else if (key === 'operator') {
                html += `<div class="studio-field">
                    <label>${esc(fieldLabel)}</label>
                    <select data-config="${esc(key)}">
                        ${['>', '<', '==', '!=', '>=', '<=', 'contains'].map(op =>
                            `<option value="${op}" ${val === op ? 'selected' : ''}>${op}</option>`
                        ).join('')}
                    </select>
                </div>`;
            } else if (key === 'severity') {
                html += `<div class="studio-field">
                    <label>${esc(fieldLabel)}</label>
                    <select data-config="${esc(key)}">
                        ${['info', 'warning', 'critical'].map(s =>
                            `<option value="${s}" ${val === s ? 'selected' : ''}>${s}</option>`
                        ).join('')}
                    </select>
                </div>`;
            } else if (key === 'level') {
                html += `<div class="studio-field">
                    <label>${esc(fieldLabel)}</label>
                    <select data-config="${esc(key)}">
                        ${['info', 'warn', 'error', 'debug'].map(l =>
                            `<option value="${l}" ${val === l ? 'selected' : ''}>${l}</option>`
                        ).join('')}
                    </select>
                </div>`;
            } else if (key === 'method') {
                html += `<div class="studio-field">
                    <label>${esc(fieldLabel)}</label>
                    <select data-config="${esc(key)}">
                        ${['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m =>
                            `<option value="${m}" ${val === m ? 'selected' : ''}>${m}</option>`
                        ).join('')}
                    </select>
                </div>`;
            } else if (key === 'mode' || key === 'strategy') {
                const opts = key === 'mode'
                    ? ['avg', 'min', 'max', 'sum', 'count']
                    : ['latest', 'all', 'zip'];
                html += `<div class="studio-field">
                    <label>${esc(fieldLabel)}</label>
                    <select data-config="${esc(key)}">
                        ${opts.map(o => `<option value="${o}" ${val === o ? 'selected' : ''}>${o}</option>`).join('')}
                    </select>
                </div>`;
            } else if (key === 'dataType') {
                html += `<div class="studio-field">
                    <label>${esc(fieldLabel)}</label>
                    <select data-config="${esc(key)}">
                        ${['int16', 'uint16', 'int32', 'uint32', 'float32', 'float64'].map(t =>
                            `<option value="${t}" ${val === t ? 'selected' : ''}>${t}</option>`
                        ).join('')}
                    </select>
                </div>`;
            } else {
                html += `<div class="studio-field">
                    <label>${esc(fieldLabel)}</label>
                    <input type="text" data-config="${esc(key)}" value="${esc(String(val))}">
                </div>`;
            }
        }

        // Connections info
        const inWires = flow.wires.filter(w => w.to === nodeId);
        const outWires = flow.wires.filter(w => w.from === nodeId);
        html += `<div class="studio-inspector-section">${_('sdk_studio.connections')}</div>`;
        html += `<div class="studio-inspector-connections">
            <span>⮕ ${_('sdk_studio.inputs')}: ${inWires.length}</span>
            <span>⮕ ${_('sdk_studio.outputs')}: ${outWires.length}</span>
        </div>`;

        // Delete button
        html += `<button class="studio-delete-node-btn" id="btn-delete-selected-node">
            <span class="material-icons" style="font-size:14px;vertical-align:middle">delete</span>
            ${_('sdk_studio.delete_node')}
        </button>`;

        inspectorBody.innerHTML = html;

        // Bind field change handlers
        for (const input of inspectorBody.querySelectorAll('[data-field]')) {
            input.addEventListener('change', () => {
                const node = getNode(selectedNodeId);
                if (!node) return;
                pushUndo();
                node[input.dataset.field] = input.value;
                renderAll();
            });
        }

        for (const input of inspectorBody.querySelectorAll('[data-config]')) {
            input.addEventListener('change', () => {
                const node = getNode(selectedNodeId);
                if (!node) return;
                pushUndo();
                let val = input.value;
                if (input.type === 'number') val = Number(val);
                if (input.tagName === 'SELECT' && (val === 'true' || val === 'false')) val = val === 'true';
                node.config[input.dataset.config] = val;
            });
        }

        // Delete button
        const delBtn = $('#btn-delete-selected-node');
        if (delBtn) {
            delBtn.addEventListener('click', () => deleteNode(selectedNodeId));
        }
    }

    function clearInspector() {
        inspectorBody.innerHTML = `<div class="studio-inspector-empty">
            <span class="material-icons">touch_app</span>
            <p>${_('sdk_studio.select_node')}</p>
        </div>`;
    }

    // ─── Pan & Zoom ─────────────────────────────────────────────────

    function applyTransform() {
        const g = nodesLayer;
        const gw = wiresLayer;
        const transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel})`;
        g.style.transform = transform;
        gw.style.transform = transform;
        g.style.transformOrigin = '0 0';
        gw.style.transformOrigin = '0 0';

        const gridRect = $('#studio-grid-rect');
        if (gridRect) {
            gridRect.setAttribute('transform', `translate(${panX}, ${panY}) scale(${zoomLevel})`);
        }

        $('#studio-zoom-label').textContent = Math.round(zoomLevel * 100) + '%';
    }

    function zoomTo(newZoom, cx, cy) {
        newZoom = clamp(newZoom, 0.25, 4);
        if (cx !== undefined && cy !== undefined) {
            const rect = canvasWrap.getBoundingClientRect();
            const wx = cx - rect.left;
            const wy = cy - rect.top;
            panX = wx - (wx - panX) * (newZoom / zoomLevel);
            panY = wy - (wy - panY) * (newZoom / zoomLevel);
        }
        zoomLevel = newZoom;
        applyTransform();
        renderMinimap();
    }

    function zoomFit() {
        if (!flow.nodes.length) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of flow.nodes) {
            if (n.x < minX) minX = n.x;
            if (n.y < minY) minY = n.y;
            if (n.x + NODE_W > maxX) maxX = n.x + NODE_W;
            if (n.y + NODE_H > maxY) maxY = n.y + NODE_H;
        }
        const pad = 60;
        const cw = canvasWrap.clientWidth;
        const ch = canvasWrap.clientHeight;
        const sw = maxX - minX + pad * 2;
        const sh = maxY - minY + pad * 2;
        zoomLevel = clamp(Math.min(cw / sw, ch / sh), 0.25, 2);
        panX = (cw - sw * zoomLevel) / 2 - (minX - pad) * zoomLevel;
        panY = (ch - sh * zoomLevel) / 2 - (minY - pad) * zoomLevel;
        applyTransform();
        renderMinimap();
    }

    // ─── Canvas Interaction ─────────────────────────────────────────

    function initCanvasInteraction() {
        // Wheel zoom
        canvasWrap.addEventListener('wheel', (e) => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            zoomTo(zoomLevel * delta, e.clientX, e.clientY);
        }, { passive: false });

        // Pan (middle-click or space+drag)
        canvasWrap.addEventListener('mousedown', (e) => {
            // Click on port → start wire
            if (e.target.classList.contains('studio-port')) {
                e.preventDefault();
                isDrawingWire = true;
                wireStart.nodeId = e.target.dataset.nodeId;
                wireStart.portName = e.target.dataset.port;
                const node = getNode(wireStart.nodeId);
                if (node) {
                    const pos = getPortPos(node, wireStart.portName);
                    tempWire.setAttribute('x1', pos.x);
                    tempWire.setAttribute('y1', pos.y);
                    tempWire.setAttribute('x2', pos.x);
                    tempWire.setAttribute('y2', pos.y);
                    tempWire.style.display = '';
                    tempWire.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel})`;
                    tempWire.style.transformOrigin = '0 0';
                }
                return;
            }

            // Click on node → select / start drag
            const nodeG = e.target.closest('.studio-node');
            if (nodeG && e.button === 0) {
                e.preventDefault();
                const nId = nodeG.dataset.id;
                selectedNodeId = nId;
                selectedWireIdx = null;
                isDraggingNode = true;
                dragNodeId = nId;
                const node = getNode(nId);
                if (node) {
                    const pos = svgPoint(e.clientX, e.clientY);
                    dragOffset.x = pos.x - node.x;
                    dragOffset.y = pos.y - node.y;
                }
                renderNodes();
                renderInspector(nId);
                return;
            }

            // Click on wire → select
            if (e.target.classList.contains('studio-wire')) {
                e.preventDefault();
                selectedWireIdx = parseInt(e.target.dataset.wireIdx, 10);
                selectedNodeId = null;
                renderWires();
                clearInspector();
                return;
            }

            // Middle-click or left-click on empty canvas → pan
            if (e.button === 1 || (e.button === 0 && !nodeG)) {
                isPanning = true;
                panStart.x = e.clientX - panX;
                panStart.y = e.clientY - panY;
                canvasWrap.style.cursor = 'grabbing';

                // Deselect when clicking empty canvas
                if (e.button === 0 && !nodeG) {
                    selectedNodeId = null;
                    selectedWireIdx = null;
                    renderNodes();
                    renderWires();
                    clearInspector();
                }
            }
        });

        window.addEventListener('mousemove', (e) => {
            if (isPanning) {
                panX = e.clientX - panStart.x;
                panY = e.clientY - panStart.y;
                applyTransform();
                return;
            }

            if (isDraggingNode && dragNodeId) {
                const pos = svgPoint(e.clientX, e.clientY);
                const node = getNode(dragNodeId);
                if (node) {
                    node.x = Math.round(pos.x - dragOffset.x);
                    node.y = Math.round(pos.y - dragOffset.y);
                    // Snap to grid (20px)
                    if (showGrid) {
                        node.x = Math.round(node.x / 20) * 20;
                        node.y = Math.round(node.y / 20) * 20;
                    }
                    renderNodes();
                    renderWires();
                }
                return;
            }

            if (isDrawingWire) {
                const pos = svgPoint(e.clientX, e.clientY);
                tempWire.setAttribute('x2', pos.x);
                tempWire.setAttribute('y2', pos.y);
            }
        });

        window.addEventListener('mouseup', (e) => {
            if (isPanning) {
                isPanning = false;
                canvasWrap.style.cursor = '';
                renderMinimap();
            }

            if (isDraggingNode) {
                if (dragNodeId) pushUndo();
                isDraggingNode = false;
                dragNodeId = null;
                renderMinimap();
            }

            if (isDrawingWire) {
                isDrawingWire = false;
                tempWire.style.display = 'none';

                // Check if dropped on a port
                const target = document.elementFromPoint(e.clientX, e.clientY);
                if (target && target.classList.contains('studio-port')) {
                    const toNodeId = target.dataset.nodeId;
                    const toPort = target.dataset.port;

                    if (wireStart.nodeId !== toNodeId) {
                        pushUndo();
                        // Determine direction: if start was input, swap
                        if (wireStart.portName === 'in') {
                            addWire(toNodeId, toPort, wireStart.nodeId, wireStart.portName);
                        } else {
                            addWire(wireStart.nodeId, wireStart.portName, toNodeId, toPort);
                        }
                        renderWires();
                        renderMinimap();
                        logConsole('Wire connected', 'success');
                    }
                }
            }
        });

        // Delete key
        document.addEventListener('keydown', (e) => {
            // Skip if typing in input
            if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (selectedNodeId) {
                    deleteNode(selectedNodeId);
                } else if (selectedWireIdx !== null) {
                    deleteWire(selectedWireIdx);
                }
            }

            if (e.ctrlKey && e.key === 'z') { e.preventDefault(); doUndo(); }
            if (e.ctrlKey && e.key === 'y') { e.preventDefault(); doRedo(); }
            if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveFlow(); }
        });
    }

    // ─── Flow Persistence (API) ─────────────────────────────────────

    function getCsrf() {
        return window.BetterDesk && window.BetterDesk.csrfToken
            ? { 'x-csrf-token': window.BetterDesk.csrfToken }
            : {};
    }

    async function listFlows() {
        try {
            const resp = await fetch('/api/cdap-studio/flows', {
                headers: { ...getCsrf() }
            });
            const data = await resp.json();
            return data.flows || [];
        } catch (err) {
            logConsole('Failed to list flows: ' + err.message, 'error');
            return [];
        }
    }

    async function loadFlow(id) {
        try {
            const resp = await fetch(`/api/cdap-studio/flows/${encodeURIComponent(id)}`, {
                headers: { ...getCsrf() }
            });
            const data = await resp.json();
            if (!data.success || !data.flow) throw new Error('Flow not found');

            flowMeta.id = data.flow.id;
            flowMeta.name = data.flow.name;
            flowMeta.description = data.flow.description;

            try {
                flow = JSON.parse(data.flow.flow_json);
            } catch (_) {
                flow = { nodes: [], wires: [] };
            }
            if (!flow.nodes) flow.nodes = [];
            if (!flow.wires) flow.wires = [];

            // Recalculate node ID counter
            let maxId = 0;
            for (const n of flow.nodes) {
                const num = parseInt((n.id || '').replace('n', ''), 10);
                if (num > maxId) maxId = num;
            }
            nodeIdCounter = maxId;

            selectedNodeId = null;
            selectedWireIdx = null;
            undoStack = [];
            redoStack = [];

            renderAll();
            clearInspector();
            zoomFit();
            logConsole(`Loaded flow: ${flowMeta.name}`, 'success');
        } catch (err) {
            logConsole('Failed to load flow: ' + err.message, 'error');
        }
    }

    async function saveFlow() {
        const nameInput = $('#save-flow-name');
        const descInput = $('#save-flow-desc');
        if (nameInput) nameInput.value = flowMeta.name || '';
        if (descInput) descInput.value = flowMeta.description || '';

        showModal('modal-save-flow');
    }

    async function doSaveFlow() {
        const name = ($('#save-flow-name') || {}).value || _('sdk_studio.untitled');
        const desc = ($('#save-flow-desc') || {}).value || '';

        flowMeta.name = name.trim();
        flowMeta.description = desc.trim();

        try {
            const body = {
                name: flowMeta.name,
                description: flowMeta.description,
                flow_json: JSON.stringify(flow)
            };

            let resp;
            if (flowMeta.id) {
                // Update existing
                resp = await fetch(`/api/cdap-studio/flows/${encodeURIComponent(flowMeta.id)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', ...getCsrf() },
                    body: JSON.stringify(body)
                });
            } else {
                // Create new
                resp = await fetch('/api/cdap-studio/flows', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...getCsrf() },
                    body: JSON.stringify(body)
                });
            }

            const data = await resp.json();
            if (!data.success) throw new Error(data.error || 'Save failed');
            if (data.id) flowMeta.id = data.id;

            closeAllModals();
            updateStatus();
            logConsole(`Flow saved: ${flowMeta.name}`, 'success');
        } catch (err) {
            logConsole('Save failed: ' + err.message, 'error');
        }
    }

    async function deployFlow() {
        if (!flowMeta.id) {
            logConsole('Save the flow before deploying', 'warn');
            return;
        }

        try {
            const resp = await fetch(`/api/cdap-studio/flows/${encodeURIComponent(flowMeta.id)}/deploy`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getCsrf() }
            });
            const data = await resp.json();
            if (!data.success) throw new Error(data.error || 'Deploy failed');

            logConsole(`Flow deployed: ${flowMeta.name}`, 'success');

            // Update status dot
            const dot = $('.studio-status-dot');
            if (dot) {
                dot.className = 'studio-status-dot studio-status-running';
            }
            const txt = $('#status-state-text');
            if (txt) txt.textContent = _('sdk_studio.status_deployed');
        } catch (err) {
            logConsole('Deploy failed: ' + err.message, 'error');
        }
    }

    async function testFlow() {
        if (!flowMeta.id) {
            logConsole('Save the flow before testing', 'warn');
            return;
        }

        logConsole('Running test (dry-run)...', 'info');

        try {
            const resp = await fetch(`/api/cdap-studio/flows/${encodeURIComponent(flowMeta.id)}/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getCsrf() }
            });
            const data = await resp.json();
            if (!data.success) throw new Error(data.error || 'Test failed');

            logConsole(`Test complete: ${data.nodeCount} nodes, ${data.wireCount} wires`, 'success');

            for (const r of (data.results || [])) {
                logConsole(`  [${r.label}] → ${JSON.stringify(r.output)}`, 'data');
            }
        } catch (err) {
            logConsole('Test failed: ' + err.message, 'error');
        }
    }

    async function exportFlow() {
        if (!flowMeta.id) {
            logConsole('Save the flow before exporting', 'warn');
            return;
        }

        window.open(`/api/cdap-studio/flows/${encodeURIComponent(flowMeta.id)}/export`);
        logConsole('Exported flow as .bdflow', 'success');
    }

    function importFlow() {
        var fileInput = document.getElementById('import-flow-input');
        if (!fileInput) return;
        fileInput.value = '';
        fileInput.click();
    }

    function handleImportFile(e) {
        var file = e.target.files && e.target.files[0];
        if (!file) return;

        var reader = new FileReader();
        reader.onload = function (ev) {
            try {
                var data = JSON.parse(ev.target.result);
                if (data.format !== 'bdflow' || !data.flow) {
                    logConsole('Invalid .bdflow file format', 'error');
                    return;
                }
                flow = data.flow;
                flowMeta = {
                    id: null,
                    name: data.name || _('sdk_studio.untitled'),
                    description: data.description || '',
                    status: 'draft'
                };
                selectedNodeId = null;
                selectedWireIdx = null;
                undoStack = [];
                redoStack = [];
                renderAll();
                clearInspector();
                zoomFit();
                logConsole('Imported flow: ' + flowMeta.name, 'success');
            } catch (err) {
                logConsole('Import failed: ' + err.message, 'error');
            }
        };
        reader.readAsText(file);
    }

    // ─── Modals ─────────────────────────────────────────────────────

    function showModal(id) {
        const m = document.getElementById(id);
        if (m) m.style.display = 'flex';
    }

    function closeAllModals() {
        for (const m of $$('.modal-overlay')) {
            m.style.display = 'none';
        }
    }

    function initModals() {
        // Close buttons
        for (const btn of $$('[data-close]')) {
            btn.addEventListener('click', () => {
                const m = document.getElementById(btn.dataset.close);
                if (m) m.style.display = 'none';
            });
        }

        // Close on backdrop click
        for (const m of $$('.modal-overlay')) {
            m.addEventListener('click', (e) => {
                if (e.target === m) m.style.display = 'none';
            });
        }
    }

    // ─── Open Flow Modal ────────────────────────────────────────────

    async function showOpenFlowModal() {
        const container = $('#flow-list-container');
        if (!container) return;
        container.innerHTML = `<p class="text-muted">${_('sdk_studio.loading')}</p>`;
        showModal('modal-open-flow');

        const flows = await listFlows();
        if (!flows.length) {
            container.innerHTML = `<p class="text-muted">${_('sdk_studio.no_flows')}</p>`;
            return;
        }

        container.innerHTML = flows.map(f => `
            <div class="studio-flow-item" data-id="${esc(f.id)}">
                <div class="studio-flow-item-info">
                    <div class="studio-flow-item-name">${esc(f.name)}</div>
                    <div class="studio-flow-item-desc">${esc(f.description || '')}</div>
                    <div class="studio-flow-item-meta">v${f.version || 1} · ${f.status || 'draft'} · ${f.created_by || ''}</div>
                </div>
                <div class="studio-flow-item-actions">
                    <button class="flow-action-export" data-id="${esc(f.id)}" title="Export">
                        <span class="material-icons">download</span>
                    </button>
                    <button class="flow-action-delete danger" data-id="${esc(f.id)}" title="Delete">
                        <span class="material-icons">delete</span>
                    </button>
                </div>
            </div>
        `).join('');

        // Click to load
        for (const item of container.querySelectorAll('.studio-flow-item')) {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.studio-flow-item-actions')) return;
                closeAllModals();
                loadFlow(item.dataset.id);
            });
        }

        // Delete
        for (const btn of container.querySelectorAll('.flow-action-delete')) {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!confirm(_('sdk_studio.confirm_delete'))) return;
                try {
                    await fetch(`/api/cdap-studio/flows/${encodeURIComponent(btn.dataset.id)}`, {
                        method: 'DELETE',
                        headers: { ...getCsrf() }
                    });
                    showOpenFlowModal(); // Refresh
                } catch (_) {}
            });
        }

        // Export
        for (const btn of container.querySelectorAll('.flow-action-export')) {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                window.open(`/api/cdap-studio/flows/${encodeURIComponent(btn.dataset.id)}/export`);
            });
        }
    }

    // ─── Templates Modal ────────────────────────────────────────────

    async function showTemplatesModal() {
        const container = $('#template-grid-container');
        if (!container) return;
        container.innerHTML = `<p class="text-muted">${_('sdk_studio.loading')}</p>`;
        showModal('modal-templates');

        try {
            const resp = await fetch('/api/cdap-studio/templates', { headers: { ...getCsrf() } });
            const data = await resp.json();
            const templates = data.templates || [];

            container.innerHTML = templates.map(t => `
                <div class="studio-template-card" data-id="${esc(t.id)}">
                    <span class="material-icons">${esc(t.icon || 'auto_awesome')}</span>
                    <h4>${esc(t.name)}</h4>
                    <p>${esc(t.description)}</p>
                </div>
            `).join('');

            for (const card of container.querySelectorAll('.studio-template-card')) {
                card.addEventListener('click', () => {
                    const tpl = templates.find(t => t.id === card.dataset.id);
                    if (!tpl || !tpl.flow) return;

                    closeAllModals();
                    pushUndo();

                    flow = JSON.parse(JSON.stringify(tpl.flow));
                    if (!flow.nodes) flow.nodes = [];
                    if (!flow.wires) flow.wires = [];

                    flowMeta.id = null;
                    flowMeta.name = tpl.name;
                    flowMeta.description = tpl.description;

                    // Recalculate node ID counter
                    let maxId = 0;
                    for (const n of flow.nodes) {
                        const num = parseInt((n.id || '').replace('n', ''), 10);
                        if (num > maxId) maxId = num;
                    }
                    nodeIdCounter = maxId;

                    renderAll();
                    clearInspector();
                    zoomFit();
                    logConsole(`Loaded template: ${tpl.name}`, 'success');
                });
            }
        } catch (err) {
            container.innerHTML = `<p class="text-muted">Failed to load templates</p>`;
        }
    }

    // ─── New Flow ───────────────────────────────────────────────────

    function newFlow() {
        pushUndo();
        flow = { nodes: [], wires: [] };
        flowMeta = { id: null, name: _('sdk_studio.untitled'), description: '' };
        selectedNodeId = null;
        selectedWireIdx = null;
        nodeIdCounter = 0;
        undoStack = [];
        redoStack = [];
        panX = 0;
        panY = 0;
        zoomLevel = 1;
        applyTransform();
        renderAll();
        clearInspector();
        logConsole('New flow created', 'info');
    }

    // ─── Toolbar Buttons ────────────────────────────────────────────

    function initToolbar() {
        const bind = (id, fn) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', fn);
        };

        bind('btn-new-flow', newFlow);
        bind('btn-open-flow', showOpenFlowModal);
        bind('btn-save-flow', saveFlow);
        bind('btn-import-flow', importFlow);
        bind('btn-run-flow', testFlow);
        bind('btn-debug-flow', testFlow); // Debug = test for now
        bind('btn-deploy-flow', deployFlow);
        bind('btn-undo', doUndo);
        bind('btn-redo', doRedo);
        bind('btn-zoom-in', () => zoomTo(zoomLevel * 1.2));
        bind('btn-zoom-out', () => zoomTo(zoomLevel * 0.8));
        bind('btn-zoom-fit', zoomFit);
        bind('btn-clear-console', () => { consoleBody.innerHTML = ''; });
        bind('btn-save-confirm', doSaveFlow);
        bind('btn-empty-template', showTemplatesModal);

        // Grid toggle
        bind('btn-toggle-grid', () => {
            showGrid = !showGrid;
            svgEl.classList.toggle('no-grid', !showGrid);
        });

        // Code mode toggle (placeholder — shows raw JSON)
        bind('btn-toggle-code', () => {
            const json = JSON.stringify(flow, null, 2);
            logConsole('--- Flow JSON ---', 'info');
            // Output lines (max 20)
            const lines = json.split('\n');
            for (let i = 0; i < Math.min(lines.length, 20); i++) {
                logConsole(lines[i], 'data');
            }
            if (lines.length > 20) logConsole(`... (${lines.length - 20} more lines)`, 'info');
        });
    }

    // ─── Initialize ─────────────────────────────────────────────────

    function init() {
        buildPalette();
        initCanvasDrop();
        initCanvasInteraction();
        initToolbar();
        initModals();
        renderAll();
        applyTransform();

        // Import file input handler
        var importInput = document.getElementById('import-flow-input');
        if (importInput) importInput.addEventListener('change', handleImportFile);

        logConsole(_('sdk_studio.console_ready'), 'info');
        logConsole('Drag nodes from the palette to the canvas to start building a flow.', 'info');
    }

    // Wait for DOM
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Export for external access
    window.CdapStudio = {
        init,
        newFlow,
        saveFlow,
        loadFlow,
        testFlow,
        deployFlow,
        exportFlow,
        importFlow,
        getFlow: () => flow,
        getFlowMeta: () => flowMeta
    };

})();
