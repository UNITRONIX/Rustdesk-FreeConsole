'use strict';

/**
 * BetterDesk Console — Server Attestation (performance benchmark)
 *
 * Runs a load test against the Go signal/relay WebSocket endpoints and
 * measures host CPU/RAM/disk until the 80% threshold is reached.
 * Results are stored in settings and exposed as Bronze/Iron/Platinum/Titanium/Obsidian tiers.
 */

const crypto = require('crypto');
const path = require('path');
const WebSocket = require('ws');
const protobuf = require('protobufjs');
const config = require('../config/config');
const db = require('./database');
const { getResourceSnapshot } = require('./serverManagement');
const betterdeskApi = require('./betterdeskApi');

const SETTINGS_KEY = 'server_attestation_result';
const THRESHOLD = 80;
const STABILIZE_THRESHOLD = 70;
const MAX_CONNECTIONS = 500;
const MAX_TEST_MS = 10 * 60 * 1000;
const BASELINE_MS = 10_000;
const RAMP_INTERVAL_MS = 5_000;
const STABILIZE_MS = 15_000;
const BATCH_SIGNAL = 5;
const BATCH_RELAY = 3;
const CONNECT_TIMEOUT_MS = 8_000;
const ERROR_RATE_ABORT = 0.05;

const TIER_THRESHOLDS = [
    { tier: 'obsidian', min: 401 },
    { tier: 'titanium', min: 201 },
    { tier: 'platinum', min: 76 },
    { tier: 'iron', min: 26 },
    { tier: 'bronze', min: 1 }
];

let protoPromise = null;
let runState = {
    running: false,
    phase: 'idle',
    progress: null,
    abortRequested: false
};
let activePool = null;

async function loadProto() {
    if (!protoPromise) {
        const protoPath = path.join(__dirname, '..', 'protos', 'rendezvous.proto');
        protoPromise = protobuf.load(protoPath).then((root) => ({
            RendezvousMessage: root.lookupType('hbb.RendezvousMessage')
        }));
    }
    return protoPromise;
}

function encodeHealthCheck(types, token) {
    const msg = types.RendezvousMessage.create({
        hc: { token: token || 'bd-bench' }
    });
    return types.RendezvousMessage.encode(msg).finish();
}

function encodeRequestRelay(types, uuid) {
    const msg = types.RendezvousMessage.create({
        requestRelay: {
            id: 'bd-bench',
            uuid
        }
    });
    return types.RendezvousMessage.encode(msg).finish();
}

function determineTier(maxConnections) {
    const n = Math.max(0, Math.floor(maxConnections || 0));
    if (n === 0) return null;
    for (const t of TIER_THRESHOLDS) {
        if (n >= t.min) return t.tier;
    }
    return 'bronze';
}

function getMaxDiskPercent(disks) {
    if (!Array.isArray(disks) || !disks.length) return 0;
    let max = 0;
    for (const d of disks) {
        if (!d.size) continue;
        const pct = (d.used / d.size) * 100;
        if (pct > max) max = pct;
    }
    return Math.round(max * 10) / 10;
}

function parseApiHost() {
    try {
        const raw = config.betterdeskApiUrl || config.hbbsApiUrl || '';
        const u = new URL(raw);
        return u.hostname || null;
    } catch (_) {
        return null;
    }
}

function wsScheme() {
    if ((process.env.WS_USE_TLS || '').toLowerCase() === 'true') return 'wss';
    // Server-side benchmark talks to local Go ports — plain ws unless forced.
    return 'ws';
}

function buildWsUrlCandidates() {
    const proxy = config.wsProxy || {};
    const signalPort = (parseInt(process.env.WS_HBBS_PORT, 10) || proxy.hbbsPort || 21116) + 2;
    const relayPort = (parseInt(process.env.WS_HBBR_PORT, 10) || proxy.hbbrPort || 21117) + 2;
    const scheme = wsScheme();
    const hosts = [];
    const addHost = (h) => {
        if (h && !hosts.includes(h)) hosts.push(h);
    };
    if (process.env.WS_HBBS_HOST) addHost(process.env.WS_HBBS_HOST);
    if (process.env.WS_HBBR_HOST) addHost(process.env.WS_HBBR_HOST);
    addHost(parseApiHost());
    addHost(proxy.hbbsHost);
    addHost('127.0.0.1');
    addHost('localhost');

    const signal = [];
    const relay = [];
    for (const host of hosts) {
        signal.push(`${scheme}://${host}:${signalPort}`);
        relay.push(`${scheme}://${host}:${relayPort}`);
    }
    return { signal, relay, signalPort, relayPort, hosts, scheme };
}

function getWsUrls(resolved) {
    if (resolved && resolved.signal && resolved.relay) {
        return resolved;
    }
    const c = buildWsUrlCandidates();
    return {
        signal: c.signal[0],
        relay: c.relay[0],
        host: c.hosts[0] || '127.0.0.1',
        signalPort: c.signalPort,
        relayPort: c.relayPort,
        candidates: c
    };
}

async function probeWsUrl(url, types, timeoutMs = 5000) {
    let ws;
    try {
        ws = await connectWs(url, timeoutMs);
        const payload = encodeHealthCheck(types);
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('probe timeout')), timeoutMs);
            ws.once('message', () => {
                clearTimeout(timer);
                resolve();
            });
            ws.once('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
            ws.send(payload);
        });
        return true;
    } catch (_) {
        return false;
    } finally {
        if (ws) {
            try { ws.close(); } catch (_) { /* ignore */ }
        }
    }
}

async function resolveWsTargets(types) {
    const candidates = buildWsUrlCandidates();
    let signalUrl = null;
    let relayUrl = null;
    const probeLog = [];

    for (const url of candidates.signal) {
        const ok = await probeWsUrl(url, types);
        probeLog.push({ url, ok, kind: 'signal' });
        if (ok) {
            signalUrl = url;
            break;
        }
    }

    for (const url of candidates.relay) {
        const ok = await probeWsUrl(url, types);
        probeLog.push({ url, ok, kind: 'relay' });
        if (ok) {
            relayUrl = url;
            break;
        }
    }

    return {
        signal: signalUrl,
        relay: relayUrl,
        host: signalUrl ? new URL(signalUrl).hostname : (candidates.hosts[0] || '127.0.0.1'),
        signalPort: candidates.signalPort,
        relayPort: candidates.relayPort,
        scheme: candidates.scheme,
        probeLog,
        resolved: !!(signalUrl || relayUrl)
    };
}

function estimateCapacity(baseline, snap) {
    const cpuBase = baseline && baseline.cpu != null ? baseline.cpu : 0;
    const memBase = baseline && baseline.memPercent != null ? baseline.memPercent : 0;
    const diskBase = baseline && baseline.diskPercent != null ? baseline.diskPercent : 0;
    const ignoreDisk = diskBase >= 75;

    const cpuHead = Math.max(0, THRESHOLD - cpuBase);
    const memHead = Math.max(0, THRESHOLD - memBase);
    const diskHead = ignoreDisk ? 100 : Math.max(0, THRESHOLD - diskBase);

    const totalMem = (snap && snap.memTotal) || 0;
    const fromCpu = Math.floor(cpuHead / 0.35);
    const fromMem = totalMem > 0
        ? Math.floor((memHead / 100) * totalMem / (8 * 1024 * 1024))
        : Math.floor(memHead / 2);
    const fromDisk = ignoreDisk ? fromMem : Math.floor(diskHead / 0.5);
    const coreBased = Math.max(1, (snap && snap.cpuCount) || 1) * 12;

    return Math.max(0, Math.min(fromCpu, fromMem, fromDisk, coreBased * 4));
}

function isOverThreshold(metrics, baseline) {
    if (metrics.cpu >= THRESHOLD) return true;
    if (metrics.memPercent >= THRESHOLD) return true;
    const diskBase = baseline && baseline.diskPercent != null ? baseline.diskPercent : 0;
    if (diskBase >= 75) return false;
    if (metrics.diskPercent >= THRESHOLD) return true;
    return false;
}

function sleep(ms, abortSignal) {
    return new Promise((resolve, reject) => {
        if (abortSignal && abortSignal.aborted) {
            reject(new Error('aborted'));
            return;
        }
        const timer = setTimeout(resolve, ms);
        if (abortSignal) {
            abortSignal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new Error('aborted'));
            }, { once: true });
        }
    });
}

function connectWs(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, {
            handshakeTimeout: timeoutMs,
            rejectUnauthorized: !config.allowSelfSignedCerts
        });
        const timer = setTimeout(() => {
            ws.terminate();
            reject(new Error('connect timeout'));
        }, timeoutMs);
        ws.once('open', () => {
            clearTimeout(timer);
            resolve(ws);
        });
        ws.once('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

class ConnectionPool {
    constructor() {
        this.signalConns = [];
        this.relayConns = [];
        this.relayPairs = 0;
        this.attempts = 0;
        this.failures = 0;
    }

    get totalConnections() {
        return this.signalConns.length + this.relayConns.length;
    }

    closeAll() {
        for (const ws of [...this.signalConns, ...this.relayConns]) {
            try { ws.close(); } catch (_) { /* ignore */ }
        }
        this.signalConns = [];
        this.relayConns = [];
        this.relayPairs = 0;
    }
}

async function addSignalConnections(pool, types, count, urls) {
    if (!urls || !urls.signal) return 0;
    const added = [];
    for (let i = 0; i < count; i++) {
        pool.attempts += 1;
        try {
            const ws = await connectWs(urls.signal, CONNECT_TIMEOUT_MS);
            const payload = encodeHealthCheck(types);
            ws.send(payload);
            ws.on('message', () => { /* health-check response */ });
            pool.signalConns.push(ws);
            added.push(ws);
        } catch (_) {
            pool.failures += 1;
        }
    }
    return added.length;
}

async function addRelayPairs(pool, types, pairCount, urls) {
    if (!urls || !urls.relay) return 0;
    let addedPairs = 0;
    for (let i = 0; i < pairCount; i++) {
        const uuid = `bd-bench-${crypto.randomBytes(8).toString('hex')}`;
        pool.attempts += 2;
        try {
            const ws1 = await connectWs(urls.relay, CONNECT_TIMEOUT_MS);
            const ws2 = await connectWs(urls.relay, CONNECT_TIMEOUT_MS);
            const payload = encodeRequestRelay(types, uuid);
            ws1.send(payload);
            ws2.send(payload);
            pool.relayConns.push(ws1, ws2);
            addedPairs += 1;
            pool.relayPairs += 1;
        } catch (_) {
            pool.failures += 1;
        }
    }
    return addedPairs;
}

async function collectMetrics() {
    const snap = getResourceSnapshot();
    let goStats = null;
    try {
        const res = await betterdeskApi.getServerStats();
        if (res && res.success) goStats = res.data;
    } catch (_) { /* optional */ }

    return {
        ts: Date.now(),
        cpu: snap.cpu,
        memPercent: snap.mem.percent,
        diskPercent: getMaxDiskPercent(snap.disks),
        hostname: snap.hostname,
        cpuCount: snap.cpuCount,
        memTotal: snap.mem.total,
        goStats
    };
}

function metricsFromSnapshot(snap) {
    return {
        ts: Date.now(),
        cpu: snap.cpu,
        memPercent: snap.mem.percent,
        diskPercent: getMaxDiskPercent(snap.disks),
        hostname: snap.hostname,
        cpuCount: snap.cpuCount,
        memTotal: snap.mem.total,
        goStats: null
    };
}

function isUnderStabilize(metrics, baseline) {
    if (metrics.cpu >= STABILIZE_THRESHOLD) return false;
    if (metrics.memPercent >= STABILIZE_THRESHOLD) return false;
    const diskBase = baseline && baseline.diskPercent != null ? baseline.diskPercent : 0;
    if (diskBase >= 75) return true;
    return metrics.diskPercent < STABILIZE_THRESHOLD;
}

function errorRate(pool) {
    if (!pool.attempts) return 0;
    return pool.failures / pool.attempts;
}

function poolAttemptsExceeded(pool) {
    return pool.attempts >= 12 && pool.totalConnections === 0;
}

async function getLastResult() {
    try {
        const raw = await db.getSetting(SETTINGS_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

async function saveResult(result) {
    await db.setSetting(SETTINGS_KEY, JSON.stringify(result));
}

function buildPublicSummary(result) {
    if (!result || !result.tier) {
        return { tier: null, maxConnections: 0, testedAt: null, valid: false };
    }
    return {
        tier: result.tier,
        maxConnections: result.maxConnections || 0,
        testedAt: result.testedAt || result.completedAt || null,
        valid: result.valid !== false
    };
}

function getStatus() {
    return {
        running: runState.running,
        phase: runState.phase,
        progress: runState.progress,
        lastResult: runState.cachedLastResult || null
    };
}

let cachedLastResult = null;

async function refreshCachedResult() {
    cachedLastResult = await getLastResult();
    runState.cachedLastResult = cachedLastResult;
    return cachedLastResult;
}

function requestAbort() {
    if (!runState.running) return false;
    runState.abortRequested = true;
    if (activePool) activePool.closeAll();
    return true;
}

async function runLoadTest({ onProgress } = {}) {
    if (runState.running) {
        throw new Error('Benchmark already running');
    }

    runState.running = true;
    runState.abortRequested = false;
    runState.phase = 'baseline';
    activePool = new ConnectionPool();

    const startedAt = Date.now();
    const rampSteps = [];
    const types = await loadProto();
    const abortSignal = {
        aborted: false,
        addEventListener: (ev, fn) => {
            const check = setInterval(() => {
                if (runState.abortRequested) {
                    clearInterval(check);
                    abortSignal.aborted = true;
                    fn();
                }
            }, 200);
        }
    };

    let bestStable = { connections: 0, metrics: null };
    let lastStable = { connections: 0, metrics: null };
    let urls = null;
    let probeLog = [];
    let baseline = null;

    const emit = (patch) => {
        runState.progress = { ...runState.progress, ...patch };
        if (typeof onProgress === 'function') onProgress(runState.progress);
    };

    try {
        emit({
            phase: 'baseline',
            message: 'Collecting baseline metrics…',
            connections: 0,
            rampSteps: []
        });

        await sleep(BASELINE_MS, abortSignal);
        baseline = await collectMetrics();

        emit({
            phase: 'probe',
            message: 'Probing WebSocket endpoints…',
            connections: 0,
            baseline,
            rampSteps: []
        });

        urls = await resolveWsTargets(types);
        probeLog = urls.probeLog || [];

        runState.phase = 'ramp-up';
        emit({
            phase: 'ramp-up',
            message: urls.resolved
                ? 'Ramping up connections…'
                : 'WebSocket unreachable — using capacity estimate…',
            connections: 0,
            baseline,
            rampSteps: [],
            probeLog
        });

        if (urls.resolved) {
            while (activePool.totalConnections < MAX_CONNECTIONS) {
                if (Date.now() - startedAt > MAX_TEST_MS) break;
                if (runState.abortRequested) break;

                await addSignalConnections(activePool, types, BATCH_SIGNAL, urls);
                await addRelayPairs(activePool, types, BATCH_RELAY, urls);

                await sleep(1500, abortSignal).catch(() => { /* continue */ });

                const metrics = await collectMetrics();
                const step = {
                    ts: metrics.ts,
                    connections: activePool.totalConnections,
                    signalConnections: activePool.signalConns.length,
                    relaySessions: activePool.relayPairs,
                    cpu: metrics.cpu,
                    mem: metrics.memPercent,
                    disk: metrics.diskPercent,
                    errorRate: errorRate(activePool)
                };
                rampSteps.push(step);

                emit({
                    phase: 'ramp-up',
                    message: `Testing ${activePool.totalConnections} connections…`,
                    connections: activePool.totalConnections,
                    metrics,
                    rampSteps: [...rampSteps]
                });

                const successes = activePool.totalConnections;
                if (successes === 0 && poolAttemptsExceeded(activePool)) {
                    break;
                }
                if (successes > 0 && errorRate(activePool) > ERROR_RATE_ABORT && activePool.attempts > 20) {
                    break;
                }

                if (isOverThreshold(metrics, baseline)) {
                    lastStable = {
                        connections: Math.max(0, activePool.totalConnections - BATCH_SIGNAL - BATCH_RELAY * 2),
                        metrics
                    };
                    break;
                }

                bestStable = { connections: activePool.totalConnections, metrics };
                await sleep(RAMP_INTERVAL_MS, abortSignal);
            }
        }

        runState.phase = 'stabilize';
        emit({
            phase: 'stabilize',
            message: 'Stabilizing…',
            connections: activePool.totalConnections,
            rampSteps: [...rampSteps]
        });

        const stabilizeStart = Date.now();
        let finalConnections = bestStable.connections;
        let finalMetrics = bestStable.metrics || await collectMetrics();

        while (Date.now() - stabilizeStart < STABILIZE_MS) {
            if (runState.abortRequested) break;
            const metrics = await collectMetrics();
            if (isUnderStabilize(metrics, baseline) && lastStable.connections > 0) {
                finalConnections = lastStable.connections;
                finalMetrics = lastStable.metrics || metrics;
                break;
            }
            if (!isOverThreshold(metrics, baseline)) {
                finalConnections = activePool.totalConnections;
                finalMetrics = metrics;
            }
            await sleep(3000, abortSignal).catch(() => { /* ignore */ });
        }

        let mode = urls && urls.resolved ? 'loadtest' : 'estimated';
        if (finalConnections <= 0) {
            const snap = getResourceSnapshot();
            const estimated = estimateCapacity(baseline, metricsFromSnapshot(snap));
            if (estimated > 0) {
                finalConnections = estimated;
                mode = 'estimated';
            }
        } else if (activePool.totalConnections > 0) {
            mode = 'loadtest';
        }

        const maxConnections = finalConnections;
        const tier = determineTier(maxConnections);
        const diskBaselineHigh = baseline && baseline.diskPercent >= 75;

        const result = {
            valid: maxConnections > 0 && !!tier,
            mode,
            tier,
            maxConnections,
            signalConnections: activePool.signalConns.length,
            relaySessions: activePool.relayPairs,
            threshold: THRESHOLD,
            testedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            aborted: runState.abortRequested,
            metricsHost: finalMetrics && finalMetrics.hostname,
            finalMetrics: finalMetrics ? {
                cpu: finalMetrics.cpu,
                mem: finalMetrics.memPercent,
                disk: finalMetrics.diskPercent
            } : null,
            baseline,
            rampSteps,
            targets: urls || getWsUrls(),
            probeLog,
            errorRate: errorRate(activePool),
            diskBaselineHigh,
            wsResolved: !!(urls && urls.resolved)
        };

        await saveResult(result);
        cachedLastResult = result;
        runState.cachedLastResult = result;

        runState.phase = 'done';
        emit({
            phase: 'done',
            message: 'Benchmark complete',
            result,
            rampSteps: [...rampSteps]
        });

        return result;
    } finally {
        runState.phase = 'cool-down';
        if (activePool) activePool.closeAll();
        activePool = null;
        runState.running = false;
        runState.abortRequested = false;
        runState.progress = runState.progress
            ? { ...runState.progress, phase: 'idle' }
            : null;
    }
}

refreshCachedResult().catch(() => {});

module.exports = {
    THRESHOLD,
    TIER_THRESHOLDS,
    determineTier,
    getLastResult,
    saveResult,
    buildPublicSummary,
    getStatus,
    refreshCachedResult,
    requestAbort,
    runLoadTest,
    getWsUrls
};
