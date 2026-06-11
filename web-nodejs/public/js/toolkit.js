/**
 * BetterDesk Console — Toolkit
 *
 * Client-side logic for all toolkit tools.
 * Network tools call /api/network/* (existing endpoints).
 * Crypto/encoding/system tools call /api/toolkit/* or /api/system/*.
 *
 * @module toolkit
 */

/* global BetterDesk, _ */
'use strict';

(function () {
    // ── Helpers ─────────────────────────────────────────────────────────

    function getCsrfToken() {
        return window.BetterDesk?.csrfToken || '';
    }

    function t(key, fallback) {
        if (typeof _ === 'function') {
            var r = _(key);
            return r !== key ? r : (fallback || key);
        }
        return fallback || key;
    }

    function api(url, opts) {
        opts = opts || {};
        var headers = { 'Content-Type': 'application/json' };
        var token = getCsrfToken();
        if (token) headers['X-CSRF-Token'] = token;
        return fetch(url, {
            method: opts.method || 'POST',
            headers: headers,
            body: opts.body ? JSON.stringify(opts.body) : undefined,
            credentials: 'same-origin',
        }).then(function (r) { return r.json(); });
    }

    function apiGet(url) {
        return fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.json(); });
    }

    function esc(s) {
        if (typeof s !== 'string') s = String(s);
        var d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    function showSpinner(el) {
        el.innerHTML = '<div class="tool-spinner"><span class="material-icons">autorenew</span> ' + t('common.loading', 'Loading…') + '</div>';
    }

    function showError(el, msg) {
        el.innerHTML = '<div class="tool-result-box"><span class="result-status error"><span class="material-icons" style="font-size:16px">error</span> ' + esc(msg) + '</span></div>';
    }

    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text);
        }
    }

    function escapeJsString(text) {
        return String(text)
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'");
    }

    function copyBtn(text) {
        return '<button class="result-copy-btn" onclick="navigator.clipboard.writeText(\'' + escapeJsString(text) + '\')"><span class="material-icons">content_copy</span> ' + t('common.copy', 'Copy') + '</button>';
    }

    // ── Tab switching ───────────────────────────────────────────────────

    document.querySelectorAll('.tab-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
            document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
            btn.classList.add('active');
            var panel = document.getElementById('tab-' + btn.getAttribute('data-tab'));
            if (panel) panel.classList.add('active');
        });
    });

    // ── Card expand/collapse ────────────────────────────────────────────

    document.querySelectorAll('.tool-card-header').forEach(function (hdr) {
        hdr.addEventListener('click', function () {
            var card = hdr.closest('.tool-card');
            card.classList.toggle('expanded');
        });
    });

    // ── Chip groups ─────────────────────────────────────────────────────

    document.querySelectorAll('.chip-group').forEach(function (group) {
        group.querySelectorAll('.chip').forEach(function (chip) {
            chip.addEventListener('click', function () {
                group.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('active'); });
                chip.classList.add('active');
            });
        });
    });

    // ── Enter key runs tool ─────────────────────────────────────────────

    document.querySelectorAll('.tool-card-body input[type="text"], .tool-card-body input[type="number"]').forEach(function (input) {
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                var card = input.closest('.tool-card-body');
                var btn = card.querySelector('.tool-run-btn');
                if (btn) btn.click();
            }
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    // NETWORK TOOLS
    // ═══════════════════════════════════════════════════════════════════

    // ── Ping ────────────────────────────────────────────────────────────

    document.getElementById('ping-run').addEventListener('click', function () {
        var host = document.getElementById('ping-host').value.trim();
        if (!host) return;
        var el = document.getElementById('ping-result');
        showSpinner(el);

        api('/api/network/ping', { body: { host: host } }).then(function (res) {
            if (!res.success) return showError(el, res.error || 'Failed');
            var d = res.data || res;
            el.innerHTML = '<div class="tool-result-box">' +
                '<div class="result-row"><span class="result-label">' + t('toolkit.host', 'Host') + '</span><span class="result-value">' + esc(d.host || host) + '</span></div>' +
                '<div class="result-row"><span class="result-label">' + t('toolkit.ip_address', 'IP') + '</span><span class="result-value">' + esc(d.ip || d.numeric_host || '—') + '</span></div>' +
                '<div class="result-row"><span class="result-label">' + t('toolkit.latency', 'Latency') + '</span><span class="result-value">' + esc(d.time || d.avg || '—') + ' ms</span></div>' +
                '<div class="result-row"><span class="result-label">' + t('toolkit.ttl', 'TTL') + '</span><span class="result-value">' + esc(d.ttl || '—') + '</span></div>' +
                '<div class="result-row"><span class="result-label">' + t('toolkit.status', 'Status') + '</span><span class="result-status ' + (d.alive ? 'success' : 'error') + '">' + (d.alive ? '✓ Reachable' : '✗ Unreachable') + '</span></div>' +
                '</div>';
        }).catch(function (e) { showError(el, e.message); });
    });

    // ── TCP Port Check ──────────────────────────────────────────────────

    document.getElementById('tcp-run').addEventListener('click', function () {
        var host = document.getElementById('tcp-host').value.trim();
        var port = parseInt(document.getElementById('tcp-port').value, 10);
        if (!host || !port) return;
        var el = document.getElementById('tcp-result');
        showSpinner(el);

        api('/api/network/tcp', { body: { host: host, port: port } }).then(function (res) {
            if (!res.success) return showError(el, res.error || 'Failed');
            var d = res.data || res;
            var open = d.open || d.connected;
            el.innerHTML = '<div class="tool-result-box">' +
                '<div class="result-row"><span class="result-label">' + t('toolkit.host', 'Host') + '</span><span class="result-value">' + esc(host) + ':' + esc(port) + '</span></div>' +
                '<div class="result-row"><span class="result-label">' + t('toolkit.status', 'Status') + '</span><span class="result-status ' + (open ? 'success' : 'error') + '">' + (open ? '✓ Open' : '✗ Closed') + '</span></div>' +
                (d.latency ? '<div class="result-row"><span class="result-label">' + t('toolkit.latency', 'Latency') + '</span><span class="result-value">' + esc(d.latency) + ' ms</span></div>' : '') +
                (d.banner ? '<div class="result-row"><span class="result-label">Banner</span><span class="result-value">' + esc(d.banner) + '</span></div>' : '') +
                '</div>';
        }).catch(function (e) { showError(el, e.message); });
    });

    // ── SSL Certificate ─────────────────────────────────────────────────

    document.getElementById('ssl-run').addEventListener('click', function () {
        var host = document.getElementById('ssl-host').value.trim();
        var port = parseInt(document.getElementById('ssl-port').value, 10) || 443;
        if (!host) return;
        var el = document.getElementById('ssl-result');
        showSpinner(el);

        api('/api/toolkit/ssl', { body: { host: host, port: port } }).then(function (res) {
            if (!res.success) return showError(el, res.error || 'Failed');
            var d = res.data;
            var status = d.daysLeft > 30 ? 'success' : (d.daysLeft > 7 ? 'warning' : 'error');
            var html = '<div class="tool-result-box">' +
                '<div class="result-row"><span class="result-label">' + t('toolkit.subject', 'Subject') + '</span><span class="result-value">' + esc(d.subject) + '</span></div>' +
                '<div class="result-row"><span class="result-label">' + t('toolkit.issuer', 'Issuer') + '</span><span class="result-value">' + esc(d.issuer) + (d.organization ? ' (' + esc(d.organization) + ')' : '') + '</span></div>' +
                '<div class="result-row"><span class="result-label">' + t('toolkit.valid_from', 'Valid From') + '</span><span class="result-value">' + new Date(d.validFrom).toLocaleDateString() + '</span></div>' +
                '<div class="result-row"><span class="result-label">' + t('toolkit.valid_to', 'Valid To') + '</span><span class="result-value">' + new Date(d.validTo).toLocaleDateString() + '</span></div>' +
                '<div class="result-row"><span class="result-label">' + t('toolkit.days_left', 'Days Left') + '</span><span class="result-status ' + status + '">' + esc(d.daysLeft) + ' ' + t('toolkit.days', 'days') + '</span></div>' +
                '<div class="result-row"><span class="result-label">' + t('toolkit.protocol', 'Protocol') + '</span><span class="result-value">' + esc(d.protocol || '—') + '</span></div>';

            if (d.cipher) {
                html += '<div class="result-row"><span class="result-label">' + t('toolkit.cipher', 'Cipher') + '</span><span class="result-value">' + esc(d.cipher.name || '—') + '</span></div>';
            }
            if (d.altNames && d.altNames.length) {
                html += '<div class="result-row"><span class="result-label">' + t('toolkit.alt_names', 'SANs') + '</span><span class="result-value">' + d.altNames.map(esc).join(', ') + '</span></div>';
            }
            if (d.fingerprint) {
                html += '<div class="result-row"><span class="result-label">SHA-256</span><span class="result-value" style="font-size:11px">' + esc(d.fingerprint) + '</span></div>';
            }
            if (d.chain && d.chain.length > 1) {
                html += '<div class="result-row"><span class="result-label">' + t('toolkit.chain', 'Chain') + '</span></div>';
                html += '<ul class="ssl-chain">';
                d.chain.forEach(function (c) {
                    html += '<li>' + esc(c.subject) + ' <span style="color:var(--text-secondary)">(' + esc(c.issuer) + ')</span></li>';
                });
                html += '</ul>';
            }

            html += '</div>';
            el.innerHTML = html;
        }).catch(function (e) { showError(el, e.message); });
    });

    // ── HTTP Health Check ───────────────────────────────────────────────

    document.getElementById('http-run').addEventListener('click', function () {
        var url = document.getElementById('http-url').value.trim();
        if (!url) return;
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        var el = document.getElementById('http-result');
        showSpinner(el);

        api('/api/network/http', { body: { url: url } }).then(function (res) {
            if (!res.success) return showError(el, res.error || 'Failed');
            var d = res.data || res;
            var ok = d.status_code >= 200 && d.status_code < 400;
            el.innerHTML = '<div class="tool-result-box">' +
                '<div class="result-row"><span class="result-label">URL</span><span class="result-value">' + esc(url) + '</span></div>' +
                '<div class="result-row"><span class="result-label">' + t('toolkit.status', 'Status') + '</span><span class="result-status ' + (ok ? 'success' : 'error') + '">' + esc(d.status_code) + ' ' + esc(d.status_text || '') + '</span></div>' +
                '<div class="result-row"><span class="result-label">' + t('toolkit.latency', 'Latency') + '</span><span class="result-value">' + esc(d.latency || d.response_time || '—') + ' ms</span></div>' +
                (d.content_type ? '<div class="result-row"><span class="result-label">Content-Type</span><span class="result-value">' + esc(d.content_type) + '</span></div>' : '') +
                (d.server ? '<div class="result-row"><span class="result-label">Server</span><span class="result-value">' + esc(d.server) + '</span></div>' : '') +
                '</div>';
        }).catch(function (e) { showError(el, e.message); });
    });

    // ── DNS Lookup ──────────────────────────────────────────────────────

    document.getElementById('dns-run').addEventListener('click', function () {
        var domain = document.getElementById('dns-domain').value.trim();
        if (!domain) return;
        var el = document.getElementById('dns-result');
        showSpinner(el);

        api('/api/network/resolve', { body: { host: domain } }).then(function (res) {
            if (!res.success) return showError(el, res.error || 'Failed');
            var d = res.data || res;
            var addrs = d.addresses || d.address || [];
            if (!Array.isArray(addrs)) addrs = [addrs];
            el.innerHTML = '<div class="tool-result-box">' +
                '<div class="result-row"><span class="result-label">' + t('toolkit.domain', 'Domain') + '</span><span class="result-value">' + esc(domain) + '</span></div>' +
                '<div class="result-row"><span class="result-label">' + t('toolkit.resolved', 'Resolved') + '</span><span class="result-value">' + addrs.map(esc).join(', ') + '</span></div>' +
                '</div>';
        }).catch(function (e) { showError(el, e.message); });
    });

    // ── Whois / DNS Records ─────────────────────────────────────────────

    document.getElementById('whois-run').addEventListener('click', function () {
        var domain = document.getElementById('whois-domain').value.trim();
        if (!domain) return;
        var el = document.getElementById('whois-result');
        showSpinner(el);

        api('/api/toolkit/whois', { body: { domain: domain } }).then(function (res) {
            if (!res.success) return showError(el, res.error || 'Failed');
            var d = res.data;
            var dns = d.dns || {};
            var html = '<div class="tool-result-box">' +
                '<div class="result-row"><span class="result-label">' + t('toolkit.domain', 'Domain') + '</span><span class="result-value">' + esc(d.domain) + '</span></div>';

            // DNS records table
            html += '<table class="dns-records"><thead><tr><th>' + t('toolkit.record_type', 'Type') + '</th><th>' + t('toolkit.record_value', 'Value') + '</th></tr></thead><tbody>';
            if (dns.A && dns.A.length) dns.A.forEach(function (a) { html += '<tr><td>A</td><td>' + esc(a) + '</td></tr>'; });
            if (dns.AAAA && dns.AAAA.length) dns.AAAA.forEach(function (a) { html += '<tr><td>AAAA</td><td>' + esc(a) + '</td></tr>'; });
            if (dns.NS && dns.NS.length) dns.NS.forEach(function (a) { html += '<tr><td>NS</td><td>' + esc(a) + '</td></tr>'; });
            if (dns.MX && dns.MX.length) dns.MX.forEach(function (m) { html += '<tr><td>MX</td><td>' + esc(m.exchange) + ' (priority: ' + esc(m.priority) + ')</td></tr>'; });
            if (dns.TXT && dns.TXT.length) dns.TXT.forEach(function (t) { html += '<tr><td>TXT</td><td style="word-break:break-all">' + esc(t) + '</td></tr>'; });
            html += '</tbody></table></div>';

            el.innerHTML = html;
        }).catch(function (e) { showError(el, e.message); });
    });

    // ── Speed Test ──────────────────────────────────────────────────────

    document.getElementById('speed-run').addEventListener('click', function () {
        var el = document.getElementById('speed-result');
        showSpinner(el);

        var start = performance.now();
        fetch('/api/speed-test', { credentials: 'same-origin' }).then(function (r) {
            var bytes = parseInt(r.headers.get('content-length') || '0', 10);
            return r.arrayBuffer().then(function (buf) {
                var elapsed = (performance.now() - start) / 1000; // seconds
                var size = buf.byteLength || bytes;
                var mbps = ((size * 8) / elapsed / 1000000).toFixed(2);
                var latency = Math.round(performance.now() - start);

                el.innerHTML = '<div class="tool-result-box">' +
                    '<div class="speed-gauge">' +
                    '<div class="speed-value">' + esc(mbps) + '<span class="speed-unit">Mbps</span></div>' +
                    '<div class="speed-latency">' + esc(latency) + ' ms · ' + (size / 1024 / 1024).toFixed(2) + ' MB</div>' +
                    '</div></div>';
            });
        }).catch(function (e) { showError(el, e.message); });
    });

    // ── Wake-on-LAN ─────────────────────────────────────────────────────

    document.getElementById('wol-run').addEventListener('click', function () {
        var mac = document.getElementById('wol-mac').value.trim();
        var broadcast = document.getElementById('wol-broadcast').value.trim() || '255.255.255.255';
        if (!mac) return;
        var el = document.getElementById('wol-result');
        showSpinner(el);

        api('/api/toolkit/wol', { body: { mac: mac, broadcast: broadcast } }).then(function (res) {
            if (!res.success) return showError(el, res.error || 'Failed');
            var d = res.data;
            el.innerHTML = '<div class="tool-result-box">' +
                '<span class="result-status success"><span class="material-icons" style="font-size:16px">check_circle</span> ' +
                t('toolkit.wol_sent', 'Magic packet sent') + '</span>' +
                '<div class="result-row" style="margin-top:8px"><span class="result-label">MAC</span><span class="result-value">' + esc(d.mac) + '</span></div>' +
                '<div class="result-row"><span class="result-label">' + t('toolkit.broadcast', 'Broadcast') + '</span><span class="result-value">' + esc(d.broadcast) + '</span></div>' +
                '</div>';
        }).catch(function (e) { showError(el, e.message); });
    });

    // ═══════════════════════════════════════════════════════════════════
    // CRYPTO TOOLS
    // ═══════════════════════════════════════════════════════════════════

    // ── Hash Generator ──────────────────────────────────────────────────

    document.getElementById('hash-run').addEventListener('click', function () {
        var text = document.getElementById('hash-input').value;
        if (!text) return;
        var algoChip = document.querySelector('#tool-hash .chip.active');
        var algo = algoChip ? algoChip.getAttribute('data-algo') : 'sha256';
        var el = document.getElementById('hash-result');
        showSpinner(el);

        api('/api/toolkit/hash', { body: { text: text, algorithm: algo } }).then(function (res) {
            if (!res.success) return showError(el, res.error || 'Failed');
            var d = res.data;
            el.innerHTML = '<div class="tool-result-box">' +
                copyBtn(d.hash) +
                '<div class="result-row"><span class="result-label">' + t('toolkit.algorithm', 'Algorithm') + '</span><span class="result-value">' + esc(d.algorithm).toUpperCase() + '</span></div>' +
                '<div class="result-row"><span class="result-label">' + t('toolkit.hash_value', 'Hash') + '</span><span class="result-value" style="word-break:break-all">' + esc(d.hash) + '</span></div>' +
                '</div>';
        }).catch(function (e) { showError(el, e.message); });
    });

    // ── Password Generator ──────────────────────────────────────────────

    document.getElementById('pwd-run').addEventListener('click', function () {
        var length = parseInt(document.getElementById('pwd-length').value, 10) || 20;
        var el = document.getElementById('pwd-result');
        showSpinner(el);

        api('/api/toolkit/password', {
            body: {
                length: length,
                uppercase: document.getElementById('pwd-upper').checked,
                lowercase: document.getElementById('pwd-lower').checked,
                digits: document.getElementById('pwd-digits').checked,
                symbols: document.getElementById('pwd-symbols').checked,
            }
        }).then(function (res) {
            if (!res.success) return showError(el, res.error || 'Failed');
            var d = res.data;
            var strength = d.entropy >= 128 ? 'success' : (d.entropy >= 60 ? 'warning' : 'error');
            var strengthLabel = d.entropy >= 128 ? t('toolkit.very_strong', 'Very Strong') : (d.entropy >= 60 ? t('toolkit.strong', 'Strong') : t('toolkit.weak', 'Weak'));
            var pct = Math.min(100, Math.round((d.entropy / 128) * 100));
            var color = d.entropy >= 128 ? '#3fb950' : (d.entropy >= 60 ? '#d29922' : '#f85149');

            el.innerHTML = '<div class="password-display">' +
                '<span class="password-value">' + esc(d.password) + '</span>' +
                '<button class="result-copy-btn" onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent)"><span class="material-icons">content_copy</span></button>' +
                '</div>' +
                '<div class="entropy-bar"><div class="entropy-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
                '<div class="password-meta">' +
                '<span>' + t('toolkit.entropy', 'Entropy') + ': ' + d.entropy + ' bits</span>' +
                '<span class="result-status ' + strength + '">' + strengthLabel + '</span>' +
                '</div>';
        }).catch(function (e) { showError(el, e.message); });
    });

    // ── JWT Decoder ─────────────────────────────────────────────────────

    document.getElementById('jwt-run').addEventListener('click', function () {
        var token = document.getElementById('jwt-input').value.trim();
        if (!token) return;
        var el = document.getElementById('jwt-result');
        showSpinner(el);

        api('/api/toolkit/jwt-decode', { body: { token: token } }).then(function (res) {
            if (!res.success) return showError(el, res.error || 'Failed');
            var d = res.data;
            var html = '<div class="tool-result-box">';
            html += '<div class="result-row"><span class="result-label">Header</span></div>';
            html += '<pre style="margin:0 0 10px;padding:8px;background:var(--bg-tertiary,#161b22);border-radius:6px;font-size:12px;overflow-x:auto">' + esc(JSON.stringify(d.header, null, 2)) + '</pre>';
            html += '<div class="result-row"><span class="result-label">Payload</span></div>';
            html += '<pre style="margin:0 0 10px;padding:8px;background:var(--bg-tertiary,#161b22);border-radius:6px;font-size:12px;overflow-x:auto">' + esc(JSON.stringify(d.payload, null, 2)) + '</pre>';

            if (d.expiry) {
                var status = d.expiry.expired ? 'error' : 'success';
                html += '<div class="result-row"><span class="result-label">' + t('toolkit.expiry', 'Expiry') + '</span><span class="result-status ' + status + '">' +
                    (d.expiry.expired ? t('toolkit.expired', 'Expired') : t('toolkit.valid', 'Valid')) +
                    ' · ' + new Date(d.expiry.date).toLocaleString() + '</span></div>';
            }
            html += '</div>';
            el.innerHTML = html;
        }).catch(function (e) { showError(el, e.message); });
    });

    // ═══════════════════════════════════════════════════════════════════
    // ENCODING TOOLS
    // ═══════════════════════════════════════════════════════════════════

    // ── Base64 ──────────────────────────────────────────────────────────

    function runBase64(mode) {
        var text = document.getElementById('b64-input').value;
        if (!text) return;
        var el = document.getElementById('b64-result');
        showSpinner(el);

        api('/api/toolkit/base64', { body: { text: text, mode: mode } }).then(function (res) {
            if (!res.success) return showError(el, res.error || 'Failed');
            el.innerHTML = '<div class="tool-result-box">' + copyBtn(res.data.result) +
                '<div style="word-break:break-all">' + esc(res.data.result) + '</div></div>';
        }).catch(function (e) { showError(el, e.message); });
    }
    document.getElementById('b64-encode').addEventListener('click', function () { runBase64('encode'); });
    document.getElementById('b64-decode').addEventListener('click', function () { runBase64('decode'); });

    // ── URL Encode/Decode ───────────────────────────────────────────────

    function runUrlEncode(mode) {
        var text = document.getElementById('url-input').value;
        if (!text) return;
        var el = document.getElementById('url-result');
        showSpinner(el);

        api('/api/toolkit/urlencode', { body: { text: text, mode: mode } }).then(function (res) {
            if (!res.success) return showError(el, res.error || 'Failed');
            el.innerHTML = '<div class="tool-result-box">' + copyBtn(res.data.result) +
                '<div style="word-break:break-all">' + esc(res.data.result) + '</div></div>';
        }).catch(function (e) { showError(el, e.message); });
    }
    document.getElementById('url-encode').addEventListener('click', function () { runUrlEncode('encode'); });
    document.getElementById('url-decode').addEventListener('click', function () { runUrlEncode('decode'); });

    // ═══════════════════════════════════════════════════════════════════
    // SYSTEM TOOLS
    // ═══════════════════════════════════════════════════════════════════

    // ── Process List ────────────────────────────────────────────────────

    document.getElementById('proc-run').addEventListener('click', function () {
        var el = document.getElementById('proc-result');
        showSpinner(el);

        apiGet('/api/system/info').then(function (res) {
            var procs = (res.data && res.data.processes) || res.processes || [];
            if (!procs.length) return showError(el, t('toolkit.no_data', 'No data available'));

            var html = '<div class="tool-result-box" style="overflow-x:auto"><table class="proc-table"><thead><tr>' +
                '<th>PID</th><th>' + t('toolkit.process_name', 'Name') + '</th><th>CPU %</th><th>MEM %</th></tr></thead><tbody>';
            procs.forEach(function (p) {
                var cpuColor = p.cpu > 80 ? '#f85149' : (p.cpu > 50 ? '#d29922' : 'inherit');
                html += '<tr><td>' + esc(p.pid) + '</td><td>' + esc(p.name || p.command || '') + '</td>' +
                    '<td style="color:' + cpuColor + '">' + esc(typeof p.cpu !== 'undefined' ? p.cpu.toFixed(1) : '—') + '</td>' +
                    '<td>' + esc(typeof p.mem !== 'undefined' ? p.mem.toFixed(1) : '—') + '</td></tr>';
            });
            html += '</tbody></table></div>';
            el.innerHTML = html;
        }).catch(function (e) { showError(el, e.message); });
    });

    // ── Disk Usage ──────────────────────────────────────────────────────

    document.getElementById('disk-run').addEventListener('click', function () {
        var el = document.getElementById('disk-result');
        showSpinner(el);

        apiGet('/api/system/info').then(function (res) {
            var disks = (res.data && res.data.disks) || res.disks || [];
            if (!disks.length) return showError(el, t('toolkit.no_data', 'No data available'));

            var html = '<div class="tool-result-box">';
            disks.forEach(function (d) {
                var pct = d.use_percent || d.percent || 0;
                var color = pct > 90 ? '#f85149' : (pct > 75 ? '#d29922' : '#3fb950');
                html += '<div class="disk-bar-wrapper">' +
                    '<div class="disk-bar-label"><span class="disk-bar-name">' + esc(d.filesystem || d.mount || d.name || '') + '</span>' +
                    '<span class="disk-bar-size">' + esc(d.used || '') + ' / ' + esc(d.size || d.total || '') + ' (' + esc(pct) + '%)</span></div>' +
                    '<div class="disk-bar"><div class="disk-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div></div>';
            });
            html += '</div>';
            el.innerHTML = html;
        }).catch(function (e) { showError(el, e.message); });
    });

    // ── Database Stats ──────────────────────────────────────────────────

    document.getElementById('db-run').addEventListener('click', function () {
        var el = document.getElementById('db-result');
        showSpinner(el);

        apiGet('/api/database/stats').then(function (res) {
            var d = (res.data) || res;
            var tables = d.tables || {};
            var html = '<div class="tool-result-box">';
            if (d.type) html += '<div class="result-row"><span class="result-label">' + t('toolkit.db_type', 'Type') + '</span><span class="result-value">' + esc(d.type) + '</span></div>';
            if (d.size) html += '<div class="result-row"><span class="result-label">' + t('toolkit.db_size', 'Size') + '</span><span class="result-value">' + esc(d.size) + '</span></div>';

            var keys = Object.keys(tables);
            if (keys.length) {
                html += '<table class="proc-table" style="margin-top:10px"><thead><tr><th>' + t('toolkit.table_name', 'Table') + '</th><th>' + t('toolkit.row_count', 'Rows') + '</th></tr></thead><tbody>';
                keys.forEach(function (k) {
                    html += '<tr><td>' + esc(k) + '</td><td>' + esc(tables[k]) + '</td></tr>';
                });
                html += '</tbody></table>';
            }
            html += '</div>';
            el.innerHTML = html;
        }).catch(function (e) { showError(el, e.message); });
    });

    // ── Docker Containers ───────────────────────────────────────────────

    document.getElementById('docker-run').addEventListener('click', function () {
        var el = document.getElementById('docker-result');
        showSpinner(el);

        apiGet('/api/docker/containers').then(function (res) {
            var containers = (res.data && res.data.containers) || res.containers || [];
            if (!containers.length) return showError(el, t('toolkit.no_docker', 'No Docker containers found or Docker not available'));

            var html = '<div class="tool-result-box">';
            containers.forEach(function (c) {
                var running = (c.state || c.status || '').toLowerCase().indexOf('up') >= 0 || c.state === 'running';
                html += '<div class="docker-container">' +
                    '<span class="docker-status-dot ' + (running ? 'running' : 'stopped') + '"></span>' +
                    '<span class="docker-name">' + esc(c.name || c.names || '') + '</span>' +
                    '<span class="docker-image">' + esc(c.image || '') + '</span>' +
                    '<span class="docker-ports">' + esc(c.ports || '') + '</span>' +
                    '</div>';
            });
            html += '</div>';
            el.innerHTML = html;
        }).catch(function (e) { showError(el, e.message); });
    });

    // ── Log Viewer ──────────────────────────────────────────────────────

    document.getElementById('log-run').addEventListener('click', function () {
        var source = document.getElementById('log-source').value;
        var lines = parseInt(document.getElementById('log-lines').value, 10) || 50;
        var el = document.getElementById('log-result');
        showSpinner(el);

        apiGet('/api/logs/recent?source=' + encodeURIComponent(source) + '&lines=' + lines).then(function (res) {
            var logLines = (res.data && res.data.lines) || res.lines || [];
            if (!logLines.length) return showError(el, t('toolkit.no_logs', 'No log lines available'));

            var html = '<div class="tool-result-box"><div class="log-output">';
            logLines.forEach(function (line) {
                var cls = '';
                var lower = (typeof line === 'string' ? line : '').toLowerCase();
                if (lower.indexOf('error') >= 0 || lower.indexOf('fatal') >= 0) cls = 'log-line-error';
                else if (lower.indexOf('warn') >= 0) cls = 'log-line-warning';
                else if (lower.indexOf('info') >= 0) cls = 'log-line-info';
                html += '<div class="' + cls + '">' + esc(line) + '</div>';
            });
            html += '</div></div>';
            el.innerHTML = html;
        }).catch(function (e) { showError(el, e.message); });
    });

})();
