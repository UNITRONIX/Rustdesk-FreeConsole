/*
 * BetterCore — BetterDesk MeshAgent module (AGPL-3.0).
 * SPDX-License-Identifier: AGPL-3.0-only
 * Copyright (c) BetterDesk contributors
 *
 * Tunnel KVM / terminal / files, consent prompts, WebRTC relay handoff,
 * PowerShell terminals (p=6/9), and runcommands.
 */
'use strict';

process.on('uncaughtException', function (ex) {
    try {
        require('MeshAgent').SendCommand({ action: 'msg', type: 'console', value: 'BetterCore: ' + ex });
    } catch (e) { /* ignore */ }
});

var mesh = require('MeshAgent');
var http = require('http');
var childProcess = require('child_process');
var fs = require('fs');
var pathMod = require('path');

var MESHRIGHT_REMOTECONTROL = 8;
var MESHRIGHT_REMOTEVIEW = 256;
var MESHRIGHT_NOTERMINAL = 512;
var MESHRIGHT_NOFILES = 1024;
var MESHRIGHT_NODESKTOP = 65536;
var MESHRIGHT_ADMIN = 0xFFFFFFFF;

var CONSENT_DESKTOP = 1;
var CONSENT_DESKTOP_NOTIFY = 8;
var CONSENT_TERMINAL = 16;
var CONSENT_FILES = 32;
var CONSENT_CONNECTION_BAR = 64;

var CTRL = '102938';

var tunnels = {};
var nextTunnelIndex = 1;
var cmdChild = null;
var rtcModule = null;

try { rtcModule = require('ILibWebRTC'); } catch (ex1) {
    try { if (mesh.rtc) rtcModule = mesh.rtc; } catch (ex2) { /* ignore */ }
}

var meshCoreObj = {
    action: 'coreinfo',
    value: 'BetterCore',
    caps: 14,
    root: false
};

try {
    meshCoreObj.root = require('user-sessions').isRoot();
} catch (ex) { /* ignore */ }

if (mesh.hasKVM === 1) {
    try {
        if (process.platform === 'win32' || process.platform === 'darwin' ||
            (require('monitor-info').kvm_x11_support)) {
            meshCoreObj.caps |= 1;
        } else if (process.platform === 'linux' || process.platform === 'freebsd') {
            require('monitor-info').on('kvmSupportDetected', function () {
                meshCoreObj.caps |= 1;
                meshCoreObjChanged();
            });
        }
    } catch (ex) { /* ignore */ }
}

function meshCoreObjChanged() {
    try { mesh.SendCommand(meshCoreObj); } catch (ex) { /* ignore */ }
}

function ctrlMsg(type, fields) {
    var o = { ctrlChannel: CTRL, type: type };
    if (fields) {
        for (var k in fields) o[k] = fields[k];
    }
    return JSON.stringify(o);
}

function getServerTargetUrl(path) {
    var x = mesh.ServerUrl;
    if (x == null) return null;
    x = http.parseUri(x);
    if (x == null) return null;
    return x.protocol + '//' + x.host + ':' + x.port + '/' + (path || '');
}

function getServerTargetUrlEx(url) {
    if (url.substring(0, 2) === '*/') return getServerTargetUrl(url.substring(2));
    return url;
}

function tunnel_checkServerIdentity(certs) {
    if (certs == null || certs.length === 0 || certs[0].digest == null) {
        throw new Error('BadCert');
    }
    var ma = require('MeshAgent');
    if (ma.ServerInfo == null || ma.ServerInfo.ControlChannelCertificate == null) return;
    var controlDigest = ma.ServerInfo.ControlChannelCertificate.digest.split(':').join('').toLowerCase();
    var tunnelDigest = certs[0].digest.split(':').join('').toLowerCase();
    if (controlDigest === tunnelDigest) return;
    if (tunnel_checkServerIdentity.servertlshash != null &&
        tunnel_checkServerIdentity.servertlshash.toLowerCase() !== tunnelDigest) {
        throw new Error('BadCert');
    }
}

function tunnel_onError(e) {
    try { mesh.SendCommand({ action: 'log', msg: 'Tunnel error: ' + this.url + ' ' + e }); } catch (ex) { /* ignore */ }
}

function tunnel_finalized() { delete tunnels[this.index]; }

function consentTimeout(httprequest) {
    if (httprequest.soptions && httprequest.soptions.consentTimeout) {
        return httprequest.soptions.consentTimeout;
    }
    return 30;
}

function consentTitle(httprequest) {
    if (httprequest.soptions && httprequest.soptions.consentTitle) {
        return httprequest.soptions.consentTitle;
    }
    return 'BetterDesk';
}

function needsConsent(httprequest, flag) {
    return httprequest.consent && (httprequest.consent & flag);
}

function consentAsk(ws, message, onOk) {
    var hr = ws.httprequest;
    ws.write(ctrlMsg('console', { msg: 'Waiting for user to grant access...', msgid: 1 }));
    var title = consentTitle(hr);
    var timeout = consentTimeout(hr);
    try {
        var pr = require('message-box').create(title, message, timeout);
        ws.pause();
        ws._consentpromise = pr;
        pr.then(function () {
            ws._consentpromise = null;
            ws.resume();
            ws.write(ctrlMsg('console', { msg: null, msgid: 0 }));
            onOk(ws);
        }, function (e) {
            ws._consentpromise = null;
            ws.write(ctrlMsg('console', { msg: e.toString(), msgid: 2 }));
            ws.end();
        });
    } catch (ex) {
        onOk(ws);
    }
}

function hasRemoteControl(httprequest) {
    return httprequest.rights === MESHRIGHT_ADMIN ||
        ((httprequest.rights & MESHRIGHT_REMOTECONTROL) !== 0 &&
            (httprequest.rights & MESHRIGHT_REMOTEVIEW) === 0);
}

function onTunnelUpgrade(response, s) {
    this.s = s;
    s.httprequest = this;
    s.tunnel = this;
    s.end = onTunnelClosed;
    s.descriptorMetadata = 'BetterCore_relayTunnel';

    if (mesh.idleTimeout != null) {
        s.setTimeout(mesh.idleTimeout * 1000);
        s.on('timeout', function () { this.ping(); this.setTimeout(mesh.idleTimeout * 1000); });
    }

    if (this.tcpport != null) {
        s.pause();
        s.data = onTcpRelayServerTunnelData;
        var opts = { port: parseInt(this.tcpport, 10), host: this.tcpaddr || '127.0.0.1' };
        s.tcprelay = require('net').createConnection(opts, onTcpRelayTargetTunnelConnect);
        s.tcprelay.peerindex = this.index;
    } else if (this.udpport != null) {
        s.data = onUdpRelayServerTunnelData;
        s.udprelay = require('dgram').createSocket({ type: 'udp4' });
        s.udprelay.bind({ port: 0 });
        s.udprelay.peerindex = this.index;
        s.udprelay.on('message', onUdpRelayTargetTunnelConnect);
        s.udprelay.udpport = this.udpport;
        s.udprelay.udpaddr = this.udpaddr;
        s.udprelay.first = true;
    } else {
        s.data = onTunnelData;
    }
}

function onTcpRelayTargetTunnelConnect() {
    var peerTunnel = tunnels[this.peerindex];
    this.pipe(peerTunnel.s);
    peerTunnel.s.first = true;
    peerTunnel.s.resume();
}

function onTcpRelayServerTunnelData(data) {
    if (this.first === true) {
        this.first = false;
        this.pipe(this.tcprelay, { dataTypeSkip: 1 });
    }
}

function onUdpRelayTargetTunnelConnect(data) { tunnels[this.peerindex].s.write(data); }

function onUdpRelayServerTunnelData(data) {
    if (this.udprelay.first === true) delete this.udprelay.first;
    else this.udprelay.send(data, parseInt(this.udprelay.udpport, 10), this.udprelay.udpaddr || '127.0.0.1');
}

function onTunnelClosed() {
    if (tunnels[this.httprequest.index] == null) return;
    if (this.webrtc) {
        try { this.webrtc.close(); } catch (ex) { /* ignore */ }
        delete this.webrtc;
    }
    delete tunnels[this.httprequest.index];
    if (this.tunnel) { this.tunnel.s = null; this.tunnel = null; }
    this.removeAllListeners('data');
}

function onTunnelData(data) {
    if (this.httprequest.uploadFile && typeof data === 'object' && data[0] !== 123) {
        var off = data[0] === 0 ? 1 : 0;
        try { fs.writeSync(this.httprequest.uploadFile, data, off, data.length - off); } catch (ex) { /* ignore */ }
        this.write(Buffer.from(JSON.stringify({ action: 'uploadack', reqid: this.httprequest.uploadFileid })));
        return;
    }

    if (this.httprequest.state === 0) {
        if (data === 'c' || data === 'cr') this.httprequest.state = 1;
        return;
    }

    if (this.httprequest.protocol === 0) {
        if (data.length > 3 && data[0] === '{') {
            onTunnelControlData(data, this);
            return;
        }
        this.httprequest.protocol = parseInt(data, 10);
        if (isNaN(this.httprequest.protocol)) this.httprequest.protocol = 0;

        if (this.httprequest.protocol === 1 || this.httprequest.protocol === 6 ||
            this.httprequest.protocol === 8 || this.httprequest.protocol === 9) {
            startTerminalTunnel(this, this.httprequest.protocol);
        } else if (this.httprequest.protocol === 2) {
            startKvmTunnel(this);
        } else if (this.httprequest.protocol === 5) {
            startFilesTunnel(this);
        }
        return;
    }

    if (this.httprequest.protocol === 1 || this.httprequest.protocol === 6 ||
        this.httprequest.protocol === 8 || this.httprequest.protocol === 9) {
        if (this.httprequest.process && this.httprequest.process.stdin) {
            this.httprequest.process.stdin.write(data);
        } else if (this.httprequest._term) {
            this.httprequest._term.write(data);
        }
    } else if (this.httprequest.protocol === 2) {
        if (this.httprequest.desktop && this.httprequest.desktop.kvm) {
            this.httprequest.desktop.kvm.write(data);
        }
    } else if (this.httprequest.protocol === 5) {
        handleFilesCommand(this, data);
    }
}

function onTunnelControlData(data, ws) {
    var obj;
    if (typeof data === 'string') {
        try { obj = JSON.parse(data); } catch (ex) { return; }
    } else obj = data;

    if (obj.ctrlChannel !== CTRL) return;

    switch (obj.type) {
        case 'termsize':
            if (ws.httprequest.process && ws.httprequest.process.tcsetsize) {
                ws.httprequest.process.tcsetsize(obj.rows, obj.cols);
            } else if (ws.httprequest._term && ws.httprequest._term.tcsetsize) {
                ws.httprequest._term.tcsetsize(obj.rows, obj.cols);
            }
            break;
        case 'webrtc0':
            if (ws.httprequest.protocol === 2 && ws.httprequest.desktop && ws.httprequest.desktop.kvm) {
                ws.httprequest.desktop.kvm.unpipe(ws);
            } else if (ws.httprequest._term) {
                ws.httprequest._term.unpipe(ws);
            } else if (ws.httprequest.process && ws.httprequest.process.stdout) {
                ws.httprequest.process.stdout.unpipe(ws);
                ws.httprequest.process.stderr.unpipe(ws);
            }
            ws.write(ctrlMsg('webrtc1'));
            break;
        case 'webrtc1':
            if (ws.httprequest.protocol === 2 && ws.webrtc && ws.webrtc.rtcchannel &&
                ws.httprequest.desktop && ws.httprequest.desktop.kvm && hasRemoteControl(ws.httprequest)) {
                ws.unpipe(ws.httprequest.desktop.kvm);
                ws.webrtc.rtcchannel.pipe(ws.httprequest.desktop.kvm, { dataTypeSkip: 1, end: false });
            } else if (ws.webrtc && ws.webrtc.rtcchannel && ws.httprequest._term) {
                ws.unpipe(ws.httprequest._term);
                ws.webrtc.rtcchannel.pipe(ws.httprequest._term, { dataTypeSkip: 1, end: false });
            } else if (ws.webrtc && ws.webrtc.rtcchannel && ws.httprequest.process) {
                ws.unpipe(ws.httprequest.process.stdin);
                ws.webrtc.rtcchannel.pipe(ws.httprequest.process.stdin, { dataTypeSkip: 1, end: false });
            }
            ws.resume();
            ws.write(ctrlMsg('webrtc2'));
            break;
        case 'webrtc2':
            if (ws.httprequest.protocol === 2 && ws.webrtc && ws.webrtc.rtcchannel &&
                ws.httprequest.desktop && ws.httprequest.desktop.kvm) {
                ws.httprequest.desktop.kvm.pipe(ws.webrtc.rtcchannel, { dataTypeSkip: 1 });
            } else if (ws.webrtc && ws.webrtc.rtcchannel && ws.httprequest._term) {
                ws.httprequest._term.pipe(ws.webrtc.rtcchannel, { dataTypeSkip: 1, end: false });
            } else if (ws.webrtc && ws.webrtc.rtcchannel && ws.httprequest.process) {
                ws.httprequest.process.stdout.pipe(ws.webrtc.rtcchannel, { dataTypeSkip: 1, end: false });
                ws.httprequest.process.stderr.pipe(ws.webrtc.rtcchannel, { dataTypeSkip: 1, end: false });
            }
            break;
        case 'offer':
            if (!rtcModule || !obj.sdp) return;
            ws.webrtc = rtcModule.createConnection();
            ws.webrtc.websocket = ws;
            ws.webrtc.once('~', function () { delete ws.webrtc; });
            ws.webrtc.on('dataChannel', function (channel) {
                ws.rtcchannel = channel;
                channel.httprequest = ws.httprequest;
            });
            if (ws.httprequest.webrtcconfig && ws.httprequest.webrtcconfig.iceServers && rtcModule.setTurn) {
                try {
                    var servers = ws.httprequest.webrtcconfig.iceServers;
                    for (var i = 0; i < servers.length; i++) {
                        var urls = servers[i].urls || [];
                        for (var j = 0; j < urls.length; j++) {
                            if (urls[j].indexOf('turn:') === 0) {
                                var parts = urls[j].replace('turn:', '').split(':');
                                rtcModule.setTurn({
                                    Host: parts[0],
                                    Port: parseInt(parts[1] || '3478', 10),
                                    Username: servers[i].username,
                                    Password: servers[i].credential
                                });
                            }
                        }
                    }
                } catch (ex) { /* ignore */ }
            }
            try {
                ws.webrtc.setLocalDescription(obj.sdp, function (answer) {
                    ws.write(ctrlMsg('answer', { sdp: answer }));
                });
            } catch (ex) { /* ignore */ }
            break;
        case 'answer':
            if (ws.webrtc && obj.sdp) {
                try { ws.webrtc.setRemoteDescription(obj.sdp); } catch (ex) { /* ignore */ }
            }
            break;
        case 'candidate':
            if (ws.webrtc && obj.candidate) {
                try { ws.webrtc.addIceCandidate(obj.candidate); } catch (ex) { /* ignore */ }
            }
            break;
        default:
            break;
    }
}

function spawnWinTerminal(ws, protocol, cols, rows) {
    var wt = require('win-terminal');
    if (protocol === 6 || protocol === 9) {
        if (!wt.PowerShellCapable || !wt.PowerShellCapable()) {
            ws.write(ctrlMsg('console', { msg: 'PowerShell is not supported on this Windows version', msgid: 2 }));
            ws.end();
            return false;
        }
        ws.httprequest._term = wt.StartPowerShell(cols, rows);
    } else {
        ws.httprequest._term = wt.Start(cols, rows);
    }
    ws.httprequest._term.pipe(ws, { dataTypeSkip: 1 });
    ws.pipe(ws.httprequest._term, { dataTypeSkip: 1, end: false });
    return true;
}

function terminalReady(ws) {
    ws.removeAllListeners('data');
    ws.on('data', onTunnelData);
}

function startTerminalTunnel(ws, protocol) {
    if ((ws.httprequest.rights & MESHRIGHT_REMOTECONTROL) === 0 ||
        (ws.httprequest.rights !== MESHRIGHT_ADMIN && (ws.httprequest.rights & MESHRIGHT_NOTERMINAL) !== 0)) {
        ws.end();
        return;
    }
    ws.descriptorMetadata = 'Remote Terminal';
    ws.end = terminal_tunnel_end;
    ws.httprequest.terminalProtocol = protocol;

    var begin = function () {
        var cols = 120, rows = 40;
        if (process.platform === 'win32') {
            if (!spawnWinTerminal(ws, protocol, cols, rows)) return;
        } else {
            try {
                var term = childProcess.execFile('/bin/sh', ['sh'], { type: childProcess.SpawnTypes.TERM });
                ws.httprequest.process = term;
                term.stdout.pipe(ws, { dataTypeSkip: 1 });
                term.stderr.pipe(ws, { dataTypeSkip: 1 });
                ws.pipe(term.stdin, { dataTypeSkip: 1, end: false });
                term.on('exit', function () { ws.end(); });
            } catch (ex) {
                ws.write(ctrlMsg('console', { msg: ex.toString(), msgid: 2 }));
                ws.end();
                return;
            }
        }
        terminalReady(ws);
    };

    if (needsConsent(ws.httprequest, CONSENT_TERMINAL)) {
        var who = ws.httprequest.realname || ws.httprequest.username || 'operator';
        consentAsk(ws, who + ' requests remote terminal access. Grant access?', begin);
    } else {
        begin();
    }
}

function terminal_tunnel_end() {
    if (this._consentpromise && this._consentpromise.close) try { this._consentpromise.close(); } catch (ex) { /* ignore */ }
    if (this.httprequest.process) try { this.httprequest.process.kill(); } catch (ex) { /* ignore */ }
    if (this.httprequest._term) try { this.httprequest._term.end(); } catch (ex) { /* ignore */ }
    onTunnelClosed.call(this);
}

function kvm_consent_ok(ws) {
    if (needsConsent(ws.httprequest, CONSENT_DESKTOP_NOTIFY)) {
        try {
            var who = ws.httprequest.realname || ws.httprequest.username || 'operator';
            require('toaster').Toast('BetterDesk', 'Remote desktop session started by ' + who, ws.tsid);
        } catch (ex) { /* ignore */ }
    }
    if ((ws.httprequest.desktopviewonly !== true) && hasRemoteControl(ws.httprequest)) {
        ws.pipe(ws.httprequest.desktop.kvm, { dataTypeSkip: 1, end: false });
    }
}

function startKvmTunnel(ws) {
    if (((ws.httprequest.rights & MESHRIGHT_REMOTECONTROL) === 0 &&
        (ws.httprequest.rights & MESHRIGHT_REMOTEVIEW) === 0) ||
        (ws.httprequest.rights !== MESHRIGHT_ADMIN && (ws.httprequest.rights & MESHRIGHT_NODESKTOP) !== 0)) {
        ws.end();
        return;
    }
    ws.descriptorMetadata = 'Remote KVM';

    var tsid = null;
    if (ws.httprequest.xoptions && typeof ws.httprequest.xoptions.tsid === 'number') {
        tsid = ws.httprequest.xoptions.tsid;
    }
    mesh._tsid = tsid;
    ws.tsid = tsid;

    var kvm = mesh.getRemoteDesktopStream(tsid);
    ws.httprequest.desktop = { state: 0, kvm: kvm, tunnel: ws };
    ws.desktop = ws.httprequest.desktop;
    ws.end = kvm_tunnel_end;

    kvm.pipe(ws, { dataTypeSkip: 1 });
    ws.removeAllListeners('data');
    ws.on('data', onTunnelData);

    if (needsConsent(ws.httprequest, CONSENT_DESKTOP)) {
        var who = ws.httprequest.realname || ws.httprequest.username || 'operator';
        consentAsk(ws, who + ' requests remote desktop access. Grant access?', kvm_consent_ok);
    } else {
        kvm_consent_ok(ws);
    }
}

function kvm_tunnel_end() {
    var desk = this.httprequest.desktop;
    if (desk && desk.kvm) {
        try {
            this.unpipe(desk.kvm);
            desk.kvm.unpipe(this);
            desk.kvm.end();
        } catch (ex) { /* ignore */ }
    }
    onTunnelClosed.call(this);
}

function files_consent_ok(ws) {
    ws.write(ctrlMsg('console', { msg: null }));
}

function startFilesTunnel(ws) {
    if ((ws.httprequest.rights & MESHRIGHT_REMOTECONTROL) === 0 ||
        (ws.httprequest.rights !== MESHRIGHT_ADMIN && (ws.httprequest.rights & MESHRIGHT_NOFILES) !== 0)) {
        ws.end();
        return;
    }
    ws.descriptorMetadata = 'Remote Files';
    ws.end = files_tunnel_end;
    ws.removeAllListeners('data');
    ws.on('data', onTunnelData);

    if (needsConsent(ws.httprequest, CONSENT_FILES)) {
        var who = ws.httprequest.realname || ws.httprequest.username || 'operator';
        consentAsk(ws, who + ' requests remote file access. Grant access?', files_consent_ok);
    } else {
        files_consent_ok(ws);
    }
}

function files_tunnel_end() {
    if (this.httprequest.downloadFile) {
        try { this.httprequest.downloadFile.close(); } catch (ex) { /* ignore */ }
        delete this.httprequest.downloadFile;
    }
    onTunnelClosed.call(this);
}

function getDirectoryInfo(dirPath) {
    var ret = { action: 'ls', path: dirPath, dir: [] };
    try {
        var base = dirPath || (process.platform === 'win32' ? 'C:\\' : '/');
        var names = fs.readdirSync(base);
        for (var i = 0; i < names.length; i++) {
            var full = pathMod.join(base, names[i]);
            try {
                var st = fs.statSync(full);
                ret.dir.push({ n: names[i], s: st.size, dt: Math.floor(st.mtimeMs / 1000) });
            } catch (ex) { /* skip */ }
        }
    } catch (ex) { ret.error = ex.toString(); }
    return ret;
}

function handleFilesCommand(ws, data) {
    var cmd;
    try { cmd = JSON.parse(data); } catch (ex) { return; }
    if (cmd.ctrlChannel === CTRL) {
        onTunnelControlData(cmd, ws);
        return;
    }
    if (!cmd.action) return;
    if (cmd.path && process.platform !== 'win32' && cmd.path[0] !== '/') cmd.path = '/' + cmd.path;

    switch (cmd.action) {
        case 'ls': {
            var response = getDirectoryInfo(cmd.path);
            response.reqid = cmd.reqid;
            ws.write(Buffer.from(JSON.stringify(response)));
            break;
        }
        case 'mkdir': try { fs.mkdirSync(cmd.path); } catch (ex) { /* ignore */ } break;
        case 'mkfile': try { fs.closeSync(fs.openSync(cmd.path, 'w')); } catch (ex) { /* ignore */ } break;
        case 'rm': {
            if (!cmd.delfiles) break;
            for (var j = 0; j < cmd.delfiles.length; j++) {
                var target = pathMod.join(cmd.path, cmd.delfiles[j]);
                try {
                    if (cmd.rec) deleteFolderRecursive(target);
                    else fs.unlinkSync(target);
                } catch (ex) { /* ignore */ }
            }
            break;
        }
        case 'download': {
            try {
                ws.httprequest.downloadFile = fs.createReadStream(cmd.path, { flags: 'rb' });
                ws.httprequest.downloadFile.pipe(ws);
            } catch (ex) {
                ws.write(Buffer.from(JSON.stringify({ action: 'downloaderror', reqid: cmd.reqid })));
            }
            break;
        }
        case 'upload': {
            try {
                ws.httprequest.uploadFile = fs.openSync(cmd.path, 'w');
                ws.httprequest.uploadFileid = cmd.reqid;
                ws.write(Buffer.from(JSON.stringify({ action: 'uploadack', reqid: cmd.reqid })));
            } catch (ex) {
                ws.write(Buffer.from(JSON.stringify({ action: 'uploaderror', reqid: cmd.reqid })));
            }
            break;
        }
        default: break;
    }
}

function deleteFolderRecursive(p) {
    if (!fs.existsSync(p)) return;
    var entries = fs.readdirSync(p);
    for (var i = 0; i < entries.length; i++) {
        var cur = pathMod.join(p, entries[i]);
        if (fs.lstatSync(cur).isDirectory()) deleteFolderRecursive(cur);
        else fs.unlinkSync(cur);
    }
    fs.rmdirSync(p);
}

function openTunnel(data) {
    if (data.value == null) return;
    var xurl = getServerTargetUrlEx(data.value);
    if (xurl == null) return;

    xurl = xurl.split('$').join('%24').split('@').join('%40');
    var woptions = http.parseUri(xurl);
    woptions.perMessageDeflate = false;
    woptions.rejectUnauthorized = 0;
    woptions.checkServerIdentity = tunnel_checkServerIdentity;
    woptions.checkServerIdentity.servertlshash = data.servertlshash;

    var tunnel = http.request(woptions);
    tunnel.upgrade = onTunnelUpgrade;
    tunnel.on('error', tunnel_onError);
    tunnel.sessionid = data.sessionid;
    tunnel.rights = (typeof data.rights === 'number') ? data.rights : MESHRIGHT_ADMIN;
    tunnel.consent = (typeof data.consent === 'number') ? data.consent : 0;
    tunnel.username = data.username || 'operator';
    tunnel.realname = data.realname || data.username || 'operator';
    tunnel.userid = data.userid;
    tunnel.desktopviewonly = data.desktopviewonly === true;
    tunnel.remoteaddr = data.remoteaddr;
    tunnel.state = 0;
    tunnel.url = xurl;
    tunnel.protocol = 0;
    tunnel.soptions = data.soptions;
    tunnel.tcpaddr = data.tcpaddr;
    tunnel.tcpport = data.tcpport;
    tunnel.udpaddr = data.udpaddr;
    tunnel.udpport = data.udpport;
    tunnel.xoptions = data.xoptions;
    tunnel.webrtcconfig = data.webrtcconfig;

    var index = nextTunnelIndex++;
    tunnel.index = index;
    tunnels[index] = tunnel;
    tunnel.once('~', tunnel_finalized);
    tunnel.end();
}

function runCommands(data) {
    if (cmdChild != null) return;
    var options = {};
    if (data.runAsUser > 0) {
        try { options.uid = require('user-sessions').consoleUid(); } catch (ex) { /* ignore */ }
        options.type = childProcess.SpawnTypes.TERM;
    }
    if (data.runAsUser === 2 && options.uid == null) return;

    var replydata = '';
    var onExit = function () {
        if (data.reply) {
            mesh.SendCommand({
                action: 'msg', type: 'runcommands',
                result: replydata, sessionid: data.sessionid, responseid: data.responseid
            });
        }
        cmdChild = null;
    };

    if (process.platform === 'win32') {
        if (data.type === 2) {
            var ps = process.env.windir + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
            cmdChild = childProcess.execFile(ps, ['powershell', '-noprofile', '-nologo', '-command', '-'], options);
            cmdChild.stdin.write(data.cmds + '\r\nexit\r\n');
        } else {
            cmdChild = childProcess.execFile(process.env.windir + '\\system32\\cmd.exe', ['cmd'], options);
            cmdChild.stdin.write(data.cmds + '\r\nexit\r\n');
        }
    } else {
        cmdChild = childProcess.execFile('/bin/sh', ['sh'], options);
        cmdChild.stdin.write(data.cmds.split('\r').join('') + '\nexit\n');
    }
    cmdChild.stdout.on('data', function (c) { replydata += c.toString(); });
    cmdChild.stderr.on('data', function (c) { replydata += c.toString(); });
    cmdChild.on('exit', onExit);
}

function handleServerCommand(data) {
    if (typeof data !== 'object') return;
    switch (data.action) {
        case 'msg':
            if (data.type === 'tunnel') openTunnel(data);
            break;
        case 'runcommands':
            runCommands(data);
            break;
        case 'poweraction':
            if (mesh.ExecPowerState && data.actiontype) {
                mesh.ExecPowerState(parseInt(data.actiontype, 10), data.forced === 1 ? 1 : 0);
            }
            break;
        default: break;
    }
}

function handleServerConnection(state) {
    if (state !== 0) {
        meshCoreObj.value = 'BetterCore';
        meshCoreObjChanged();
    }
}

mesh.AddCommandHandler(handleServerCommand);
mesh.AddConnectHandler(handleServerConnection);
