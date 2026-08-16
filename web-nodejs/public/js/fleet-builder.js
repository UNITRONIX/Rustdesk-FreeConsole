/* fleet-builder.js — Visual workflow builder (SVG node editor) */
'use strict';
(function () {
    const _ = window._ || (k => k);

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const NODE_W = 180;
    const NODE_H = 56;
    const PORT_R = 6;

    let _svg = null;
    let _group = null; // top-level <g> for zoom/pan
    let _zoom = 1;
    let _panX = 0, _panY = 0;

    let _nodes = [];       // { id, type, category, label, x, y, config: {} }
    let _connections = [];  // { id, from, to }
    let _nextId = 1;
    let _selected = null;
    let _dragging = null;
    let _connecting = null; // { fromId, startX, startY, line }
    let _panning = false;
    let _panStart = null;

    let _workflowId = null;
    let _workflowName = 'Untitled';

    // Category → color mapping
    const CATS = {
        trigger:   { color: '#58a6ff', headerFill: 'rgba(88,166,255,.15)' },
        condition: { color: '#f0b429', headerFill: 'rgba(240,180,41,.15)' },
        action:    { color: '#3fb950', headerFill: 'rgba(63,185,80,.15)' },
        result:    { color: '#f85149', headerFill: 'rgba(248,81,73,.15)' },
        transform: { color: '#bc8cff', headerFill: 'rgba(188,140,255,.15)' }
    };

    // Node type → category + default label
    const NODE_DEFS = {
        trigger_manual:    { cat: 'trigger',   label: 'Manual Trigger' },
        trigger_schedule:  { cat: 'trigger',   label: 'Schedule' },
        trigger_event:     { cat: 'trigger',   label: 'Event Trigger' },
        cond_os:           { cat: 'condition', label: 'OS Check' },
        cond_threshold:    { cat: 'condition', label: 'Threshold' },
        cond_time_window:  { cat: 'condition', label: 'Time Window' },
        action_script:     { cat: 'action',    label: 'Run Script' },
        action_install:    { cat: 'action',    label: 'Install Software' },
        action_restart:    { cat: 'action',    label: 'Restart Service' },
        action_file_deploy:{ cat: 'action',    label: 'Deploy File' },
        action_message:    { cat: 'action',    label: 'Send Message' },
        result_log:        { cat: 'result',    label: 'Log Output' },
        result_alert:      { cat: 'result',    label: 'Send Alert' },
        result_chain:      { cat: 'result',    label: 'Chain Workflow' },
        transform_parse:   { cat: 'transform', label: 'Parse JSON' },
        transform_filter:  { cat: 'transform', label: 'Filter' },
        transform_delay:   { cat: 'transform', label: 'Delay' }
    };

    // -----------------------------------------------------------------------
    // Init
    // -----------------------------------------------------------------------
    function init() {
        _svg = document.getElementById('builder-canvas');
        if (!_svg) return;

        // Marker for arrowheads
        const defs = svgEl('defs');
        const marker = svgEl('marker', { id: 'arrowhead', markerWidth: '8', markerHeight: '6', refX: '8', refY: '3', orient: 'auto' });
        const poly = svgEl('polygon', { points: '0 0, 8 3, 0 6', fill: '#8b949e' });
        marker.appendChild(poly);
        defs.appendChild(marker);
        _svg.appendChild(defs);

        _group = svgEl('g');
        _svg.appendChild(_group);

        // Events
        _svg.addEventListener('mousedown', onCanvasMouseDown);
        _svg.addEventListener('mousemove', onCanvasMouseMove);
        _svg.addEventListener('mouseup', onCanvasMouseUp);
        _svg.addEventListener('wheel', onWheel, { passive: false });

        // Palette drag & drop
        document.querySelectorAll('.palette-node[draggable]').forEach(el => {
            el.addEventListener('dragstart', onPaletteDragStart);
        });
        _svg.parentElement.addEventListener('dragover', e => e.preventDefault());
        _svg.parentElement.addEventListener('drop', onPaletteDrop);

        // Keyboard
        document.addEventListener('keydown', onKeyDown);

        // Load workflow list
        if (window.Fleet) Fleet.loadWorkflowList();
    }

    // -----------------------------------------------------------------------
    // SVG helpers
    // -----------------------------------------------------------------------
    function svgEl(tag, attrs) {
        const el = document.createElementNS(SVG_NS, tag);
        if (attrs) Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
        return el;
    }

    function updateTransform() {
        _group.setAttribute('transform', `translate(${_panX},${_panY}) scale(${_zoom})`);
        const zoomEl = document.getElementById('builder-zoom-level');
        if (zoomEl) zoomEl.textContent = Math.round(_zoom * 100) + '%';
    }

    function svgPoint(e) {
        const rect = _svg.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left - _panX) / _zoom,
            y: (e.clientY - rect.top - _panY) / _zoom
        };
    }

    // -----------------------------------------------------------------------
    // Node creation
    // -----------------------------------------------------------------------
    function addNode(type, x, y) {
        const def = NODE_DEFS[type];
        if (!def) return null;
        const id = 'n' + (_nextId++);
        const node = { id, type, category: def.cat, label: def.label, x, y, config: {} };
        _nodes.push(node);
        renderNode(node);
        return node;
    }

    function renderNode(node) {
        const cat = CATS[node.category] || CATS.action;
        const g = svgEl('g', { class: 'node-group', 'data-id': node.id, transform: `translate(${node.x},${node.y})` });

        // Body
        const body = svgEl('rect', { class: 'node-body', x: '0', y: '0', width: NODE_W, height: NODE_H });
        g.appendChild(body);

        // Header band
        const header = svgEl('rect', { class: 'node-header ' + node.category, x: '0', y: '0', width: NODE_W, height: '22' });
        g.appendChild(header);

        // Category dot
        const dot = svgEl('circle', { cx: '12', cy: '11', r: '4', fill: cat.color });
        g.appendChild(dot);

        // Title
        const title = svgEl('text', { class: 'node-title', x: '22', y: '11' });
        title.textContent = node.label.length > 20 ? node.label.slice(0, 18) + '…' : node.label;
        g.appendChild(title);

        // Input port (left center)
        if (node.category !== 'trigger') {
            const inPort = svgEl('circle', {
                class: 'node-port port-in', cx: '0', cy: String(NODE_H / 2), r: PORT_R,
                'data-node': node.id, 'data-dir': 'in'
            });
            g.appendChild(inPort);
        }

        // Output port (right center)
        const outPort = svgEl('circle', {
            class: 'node-port port-out', cx: String(NODE_W), cy: String(NODE_H / 2), r: PORT_R,
            'data-node': node.id, 'data-dir': 'out'
        });
        g.appendChild(outPort);

        // Drag events on the group
        g.addEventListener('mousedown', onNodeMouseDown);

        _group.appendChild(g);
    }

    function removeNode(id) {
        _nodes = _nodes.filter(n => n.id !== id);
        _connections = _connections.filter(c => c.from !== id && c.to !== id);
        const el = _group.querySelector(`[data-id="${id}"]`);
        if (el) el.remove();
        redrawConnections();
        if (_selected === id) { _selected = null; hideProps(); }
    }

    // -----------------------------------------------------------------------
    // Connections
    // -----------------------------------------------------------------------
    function addConnection(fromId, toId) {
        if (fromId === toId) return;
        if (_connections.find(c => c.from === fromId && c.to === toId)) return;
        const id = 'c' + (_nextId++);
        _connections.push({ id, from: fromId, to: toId });
        redrawConnections();
    }

    function redrawConnections() {
        _group.querySelectorAll('.connection-line').forEach(el => el.remove());
        _connections.forEach(c => {
            const fromNode = _nodes.find(n => n.id === c.from);
            const toNode = _nodes.find(n => n.id === c.to);
            if (!fromNode || !toNode) return;
            const x1 = fromNode.x + NODE_W;
            const y1 = fromNode.y + NODE_H / 2;
            const x2 = toNode.x;
            const y2 = toNode.y + NODE_H / 2;
            const cpx = Math.abs(x2 - x1) * 0.4;
            const d = `M${x1},${y1} C${x1 + cpx},${y1} ${x2 - cpx},${y2} ${x2},${y2}`;
            const path = svgEl('path', { class: 'connection-line', d, 'data-conn': c.id });
            path.addEventListener('dblclick', () => {
                _connections = _connections.filter(cc => cc.id !== c.id);
                path.remove();
            });
            // Insert connections below nodes
            _group.insertBefore(path, _group.firstChild);
        });
    }

    // -----------------------------------------------------------------------
    // Palette drag & drop
    // -----------------------------------------------------------------------
    function onPaletteDragStart(e) {
        e.dataTransfer.setData('text/plain', e.currentTarget.dataset.type);
    }

    function onPaletteDrop(e) {
        e.preventDefault();
        const type = e.dataTransfer.getData('text/plain');
        if (!type || !NODE_DEFS[type]) return;
        const pt = svgPoint(e);
        addNode(type, pt.x - NODE_W / 2, pt.y - NODE_H / 2);
    }

    // -----------------------------------------------------------------------
    // Mouse events
    // -----------------------------------------------------------------------
    function onNodeMouseDown(e) {
        const g = e.currentTarget;
        const nodeId = g.dataset.id;
        const target = e.target;

        // Port click → start connection
        if (target.classList.contains('node-port')) {
            e.stopPropagation();
            if (target.dataset.dir === 'out') {
                const node = _nodes.find(n => n.id === nodeId);
                if (!node) return;
                const sx = node.x + NODE_W;
                const sy = node.y + NODE_H / 2;
                const line = svgEl('path', { class: 'connection-line', d: `M${sx},${sy} L${sx},${sy}` });
                _group.appendChild(line);
                _connecting = { fromId: nodeId, sx, sy, line };
            }
            return;
        }

        e.stopPropagation();
        selectNode(nodeId);

        // Start drag
        const pt = svgPoint(e);
        const node = _nodes.find(n => n.id === nodeId);
        if (!node) return;
        _dragging = { id: nodeId, offX: pt.x - node.x, offY: pt.y - node.y };
    }

    function onCanvasMouseDown(e) {
        if (e.target === _svg || e.target === _group) {
            selectNode(null);
            // Start pan
            _panning = true;
            _panStart = { x: e.clientX - _panX, y: e.clientY - _panY };
        }
    }

    function onCanvasMouseMove(e) {
        if (_dragging) {
            const pt = svgPoint(e);
            const node = _nodes.find(n => n.id === _dragging.id);
            if (!node) return;
            node.x = pt.x - _dragging.offX;
            node.y = pt.y - _dragging.offY;
            const g = _group.querySelector(`[data-id="${_dragging.id}"]`);
            if (g) g.setAttribute('transform', `translate(${node.x},${node.y})`);
            redrawConnections();
        }
        if (_connecting) {
            const pt = svgPoint(e);
            const cpx = Math.abs(pt.x - _connecting.sx) * 0.4;
            _connecting.line.setAttribute('d',
                `M${_connecting.sx},${_connecting.sy} C${_connecting.sx + cpx},${_connecting.sy} ${pt.x - cpx},${pt.y} ${pt.x},${pt.y}`
            );
        }
        if (_panning && _panStart) {
            _panX = e.clientX - _panStart.x;
            _panY = e.clientY - _panStart.y;
            updateTransform();
        }
    }

    function onCanvasMouseUp(e) {
        if (_connecting) {
            _connecting.line.remove();
            // Check if dropped on an input port
            const target = e.target;
            if (target.classList.contains('node-port') && target.dataset.dir === 'in') {
                addConnection(_connecting.fromId, target.dataset.node);
            }
            _connecting = null;
        }
        _dragging = null;
        _panning = false;
        _panStart = null;
    }

    function onWheel(e) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.08 : 0.08;
        _zoom = Math.max(0.3, Math.min(3, _zoom + delta));
        updateTransform();
    }

    function onKeyDown(e) {
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (_selected && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
                removeNode(_selected);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Selection & properties
    // -----------------------------------------------------------------------
    function selectNode(id) {
        _group.querySelectorAll('.node-selected').forEach(g => g.classList.remove('node-selected'));
        _selected = id;
        if (id) {
            const g = _group.querySelector(`[data-id="${id}"]`);
            if (g) g.classList.add('node-selected');
            showProps(id);
        } else {
            hideProps();
        }
    }

    function showProps(id) {
        const node = _nodes.find(n => n.id === id);
        if (!node) return;
        const panel = document.getElementById('builder-props');
        const body = document.getElementById('props-body');
        const title = document.getElementById('props-title');
        if (!panel || !body) return;
        panel.style.display = 'block';
        title.textContent = node.label;
        body.innerHTML = buildPropsForm(node);
    }

    function hideProps() {
        const panel = document.getElementById('builder-props');
        if (panel) panel.style.display = 'none';
    }

    function closeProps() { hideProps(); selectNode(null); }

    function buildPropsForm(node) {
        let html = `
            <div class="form-group">
                <label>Label</label>
                <input class="form-control" value="${esc(node.label)}" onchange="FleetBuilder.updateNodeProp('${node.id}','label',this.value)">
            </div>`;

        // Type-specific fields
        if (node.type === 'trigger_schedule') {
            html += field(node, 'cron', 'Cron Expression', '*/5 * * * *');
        }
        if (node.type === 'trigger_event') {
            html += selectField(node, 'event', 'Event Type', ['disk_full', 'cpu_high', 'user_login', 'service_down']);
            html += field(node, 'threshold', 'Threshold (%)', '90');
        }
        if (node.type === 'cond_os') {
            html += selectField(node, 'os', 'Target OS', ['windows', 'linux', 'android', 'any']);
        }
        if (node.type === 'cond_threshold') {
            html += selectField(node, 'metric', 'Metric', ['cpu', 'ram', 'disk', 'network']);
            html += selectField(node, 'operator', 'Operator', ['>', '<', '>=', '<=', '==']);
            html += field(node, 'value', 'Value', '80');
        }
        if (node.type === 'cond_time_window') {
            html += field(node, 'start_time', 'Start Time', '08:00');
            html += field(node, 'end_time', 'End Time', '18:00');
            html += field(node, 'days', 'Days (0=Sun..6=Sat)', '1,2,3,4,5');
        }
        if (node.type === 'action_script') {
            html += `<div class="form-group"><label>Script</label>
                <textarea class="form-control code-textarea" rows="5" onchange="FleetBuilder.updateNodeProp('${node.id}','script',this.value)">${esc(node.config.script || '')}</textarea></div>`;
            html += selectField(node, 'shell', 'Shell', ['bash', 'powershell', 'cmd', 'python']);
        }
        if (node.type === 'action_install') {
            html += field(node, 'package', 'Package/URL', '');
            html += selectField(node, 'method', 'Method', ['msi', 'deb', 'rpm', 'apt', 'chocolatey', 'winget']);
        }
        if (node.type === 'action_restart') {
            html += field(node, 'service', 'Service Name', '');
        }
        if (node.type === 'action_file_deploy') {
            html += field(node, 'source', 'Source Path/URL', '');
            html += field(node, 'destination', 'Destination Path', '');
        }
        if (node.type === 'action_message') {
            html += field(node, 'message', 'Message', '');
        }
        if (node.type === 'result_alert') {
            html += selectField(node, 'channel', 'Channel', ['console', 'email', 'webhook']);
            html += field(node, 'recipient', 'Recipient', '');
        }
        if (node.type === 'result_chain') {
            html += field(node, 'workflow_id', 'Workflow ID', '');
        }
        if (node.type === 'transform_delay') {
            html += field(node, 'seconds', 'Delay (seconds)', '10');
        }
        if (node.type === 'transform_filter') {
            html += field(node, 'expression', 'Filter Expression', '');
        }

        html += `<div class="form-group" style="margin-top:16px;">
            <button class="btn btn-secondary btn-sm" onclick="FleetBuilder.removeSelected()" style="width:100%">
                <span class="material-icons" style="font-size:14px;vertical-align:middle;">delete</span> Delete Node
            </button></div>`;
        return html;
    }

    function field(node, key, label, placeholder) {
        return `<div class="form-group"><label>${esc(label)}</label>
            <input class="form-control" placeholder="${esc(placeholder)}" value="${esc(node.config[key] || '')}"
                onchange="FleetBuilder.updateNodeProp('${node.id}','${key}',this.value)">
        </div>`;
    }

    function selectField(node, key, label, opts) {
        const val = node.config[key] || '';
        return `<div class="form-group"><label>${esc(label)}</label>
            <select class="form-control" onchange="FleetBuilder.updateNodeProp('${node.id}','${key}',this.value)">
                ${opts.map(o => `<option value="${esc(o)}" ${val === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
            </select></div>`;
    }

    function updateNodeProp(nodeId, key, value) {
        const node = _nodes.find(n => n.id === nodeId);
        if (!node) return;
        if (key === 'label') {
            node.label = value;
            const g = _group.querySelector(`[data-id="${nodeId}"]`);
            const txt = g?.querySelector('.node-title');
            if (txt) txt.textContent = value.length > 20 ? value.slice(0, 18) + '…' : value;
        } else {
            node.config[key] = value;
        }
    }

    // -----------------------------------------------------------------------
    // Workflow operations
    // -----------------------------------------------------------------------
    function newWorkflow() {
        _nodes = []; _connections = []; _nextId = 1; _selected = null; _workflowId = null;
        _workflowName = 'Untitled';
        _group.innerHTML = '';
        hideProps();
        // Add default trigger
        addNode('trigger_manual', 40, 200);
    }

    async function saveWorkflow() {
        const name = prompt(_('fleet.workflow_name') || 'Workflow name:', _workflowName);
        if (!name) return;
        _workflowName = name;
        const payload = {
            name, nodes: _nodes, connections: _connections
        };
        try {
            const url = _workflowId
                ? `/api/panel/fleet/workflows/${encodeURIComponent(_workflowId)}`
                : '/api/panel/fleet/workflows';
            const resp = await fetch(url, {
                method: _workflowId ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await resp.json();
            if (data.id) _workflowId = data.id;
            if (window.Fleet) Fleet.loadWorkflowList();
        } catch (e) { console.error('saveWorkflow', e); }
    }

    function exportWorkflow() {
        const payload = JSON.stringify({ name: _workflowName, nodes: _nodes, connections: _connections }, null, 2);
        const blob = new Blob([payload], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (_workflowName || 'workflow') + '.json';
        a.click();
        URL.revokeObjectURL(a.href);
    }

    async function loadWorkflow(id) {
        const sel = document.getElementById('workflow-select');
        const wid = id || sel?.value;
        if (!wid) return;
        try {
            const resp = await fetch(`/api/panel/fleet/workflows/${encodeURIComponent(wid)}`);
            const data = await resp.json();
            const wf = data.data || data;
            _workflowId = wf.id || wid;
            _workflowName = wf.name || 'Untitled';
            _nodes = wf.nodes || [];
            _connections = wf.connections || [];
            _nextId = Math.max(..._nodes.map(n => parseInt(n.id?.replace('n', '') || '0')), ..._connections.map(c => parseInt(c.id?.replace('c', '') || '0'))) + 1;
            _group.innerHTML = '';
            _nodes.forEach(n => renderNode(n));
            redrawConnections();
        } catch (e) { console.error('loadWorkflow', e); }
    }

    async function execute(dryRun) {
        if (!_workflowId && !_nodes.length) return;
        try {
            const id = _workflowId || 'draft';
            const resp = await fetch(`/api/panel/fleet/workflows/${encodeURIComponent(id)}/execute`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    dry_run: !!dryRun,
                    nodes: _nodes,
                    connections: _connections
                })
            });
            const data = await resp.json();
            if (data.output || data.log) {
                alert((dryRun ? '[DRY RUN]\n' : '') + (data.output || data.log || 'Workflow executed'));
            }
        } catch (e) { console.error('execute', e); }
    }

    // -----------------------------------------------------------------------
    // Zoom
    // -----------------------------------------------------------------------
    function zoomIn() { _zoom = Math.min(3, _zoom + 0.15); updateTransform(); }
    function zoomOut() { _zoom = Math.max(0.3, _zoom - 0.15); updateTransform(); }
    function zoomReset() { _zoom = 1; _panX = 0; _panY = 0; updateTransform(); }

    // Helpers
    function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    window.FleetBuilder = {
        init, newWorkflow, saveWorkflow, exportWorkflow, loadWorkflow, execute,
        zoomIn, zoomOut, zoomReset, closeProps,
        updateNodeProp, removeSelected() { if (_selected) removeNode(_selected); }
    };

    document.addEventListener('DOMContentLoaded', init);
})();
