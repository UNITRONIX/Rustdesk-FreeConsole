'use strict';

/**
 * BetterDesk Console — Server Attestation (performance benchmark)
 *
 * Runs a load test against the Go signal/relay WebSocket endpoints and
 * measures host CPU/RAM/disk until the 80% threshold is reached.
 * Results are stored in settings and exposed as Bronze/Iron/Titanium/Platinum tiers.
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

function getWsUrls() {
    const proxy = config.wsProxy || {};
    const host = proxy.hbbsHost || 'localhost';
    const signalPort = (proxy.hbbsPort || 21116) + 2;
    const relayPort = (proxy.hbbrPort || 21117) + 2;
    const apiHttps = (config.betterdeskApiUrl || '').startsWith('https://');
    const scheme = apiHttps ? 'wss' : 'ws';
    return {
        signal: `${scheme}://${host}:${signalPort}`,
        relay: `${scheme}://${host}:${relayPort}`,
        host,
        signalPort,
        relayPort
    };
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

function isOverThreshold(metrics) {
    return metrics.cpu >= THRESHOLD
        || metrics.memPercent >= THRESHOLD
        || metrics.diskPercent >= THRESHOLD;
}

function isUnderStabilize(metrics) {
    return metrics.cpu < STABILIZE_THRESHOLD
        && metrics.memPercent < STABILIZE_THRESHOLD
        && metrics.diskPercent < STABILIZE_THRESHOLD;
}

function errorRate(pool) {
    if (!pool.attempts) return 0;
    return pool.failures / pool.attempts;
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
    const urls = getWsUrls();
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
        const baseline = await collectMetrics();

        runState.phase = 'ramp-up';
        emit({
            phase: 'ramp-up',
            message: 'Ramping up connections…',
            connections: 0,
            baseline,
            rampSteps: []
        });

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

            if (errorRate(activePool) > ERROR_RATE_ABORT && activePool.attempts > 20) {
                break;
            }

            if (isOverThreshold(metrics)) {
                lastStable = {
                    connections: Math.max(0, activePool.totalConnections - BATCH_SIGNAL - BATCH_RELAY * 2),
                    metrics
                };
                break;
            }

            bestStable = { connections: activePool.totalConnections, metrics };
            await sleep(RAMP_INTERVAL_MS, abortSignal);
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
            if (isUnderStabilize(metrics) && lastStable.connections > 0) {
                finalConnections = lastStable.connections;
                finalMetrics = lastStable.metrics || metrics;
                break;
            }
            if (!isOverThreshold(metrics)) {
                finalConnections = activePool.totalConnections;
                finalMetrics = metrics;
            }
            await sleep(3000, abortSignal).catch(() => { /* ignore */ });
        }

        const maxConnections = finalConnections;
        const tier = determineTier(maxConnections);

        const result = {
            valid: maxConnections > 0 && !!tier,
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
            targets: urls,
            errorRate: errorRate(activePool)
        };

        if (result.valid) {
            await saveResult(result);
            cachedLastResult = result;
            runState.cachedLastResult = result;
        }

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
