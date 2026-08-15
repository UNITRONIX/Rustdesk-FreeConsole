#!/usr/bin/env node
'use strict';

/**
 * Cross-platform installer protocol harness.
 *
 * It deliberately uses only Node.js built-ins so Linux, Windows and Docker
 * can run the same checks without curl/OpenSSL-specific behaviour.
 */
const http = require('http');
const https = require('https');
const net = require('net');
const { URL } = require('url');

function parseArgs(argv) {
    const options = {
        apiUrl: 'http://127.0.0.1:21121/api/health',
        panelUrl: 'http://127.0.0.1:5000/health',
        proxyUrl: '',
        ports: [],
        timeoutMs: 5000,
        insecure: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === '--api-url') options.apiUrl = next;
        else if (arg === '--panel-url') options.panelUrl = next;
        else if (arg === '--proxy-url') options.proxyUrl = next;
        else if (arg === '--port') options.ports.push(next);
        else if (arg === '--timeout-ms') options.timeoutMs = Number(next);
        else if (arg === '--insecure') options.insecure = true;
        else if (arg === '--help' || arg === '-h') options.help = true;
        else throw new Error(`Unknown option: ${arg}`);
        if (arg !== '--insecure' && arg !== '--help' && arg !== '-h') i += 1;
    }
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 250) {
        throw new Error('--timeout-ms must be at least 250');
    }
    return options;
}

function requestEndpoint(rawUrl, options = {}) {
    const target = new URL(rawUrl);
    const transport = target.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const request = transport.request(target, {
            method: 'GET',
            timeout: options.timeoutMs || 5000,
            rejectUnauthorized: options.insecure === true ? false : true,
            headers: { 'User-Agent': 'BetterDesk-Installer-Protocol-Check/1' },
        }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => resolve({
                statusCode: response.statusCode || 0,
                headers: response.headers,
                body,
                certificate: response.socket?.getPeerCertificate?.() || null,
            }));
        });
        request.on('timeout', () => request.destroy(new Error('request timed out')));
        request.on('error', reject);
        request.end();
    });
}

function checkCertificateHostname(certificate, hostname) {
    if (!certificate || !hostname) return false;
    const names = String(certificate.subjectaltname || '')
        .split(',')
        .map((name) => name.trim().replace(/^DNS:/i, ''))
        .filter(Boolean);
    return names.includes(hostname)
        || names.some((name) => name.startsWith('*.') && hostname.endsWith(name.slice(1)));
}

async function checkEndpoint(rawUrl, options = {}) {
    const target = new URL(rawUrl);
    const result = { url: rawUrl, ok: false, statusCode: 0, redirect: null };
    try {
        const response = await requestEndpoint(rawUrl, options);
        result.statusCode = response.statusCode;
        if (response.statusCode >= 200 && response.statusCode < 300) {
            result.ok = true;
        } else if (response.statusCode >= 300 && response.statusCode < 400) {
            result.redirect = response.headers.location || null;
            result.ok = Boolean(result.redirect);
        }
        if (target.protocol === 'https:' && !options.insecure) {
            result.certificateValid = checkCertificateHostname(response.certificate, target.hostname);
            result.ok = result.ok && result.certificateValid;
        }
    } catch (error) {
        result.error = error.message;
    }
    return result;
}

function checkPort(rawPort, timeoutMs = 5000) {
    const [host, portText] = String(rawPort).includes(':')
        ? String(rawPort).split(/:(?=[^:]+$)/)
        : ['127.0.0.1', rawPort];
    const port = Number(portText);
    return new Promise((resolve) => {
        const socket = net.connect({ host, port, timeout: timeoutMs });
        const finish = (ok, error) => {
            socket.destroy();
            resolve({ port: rawPort, ok, error: error?.message || null });
        };
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false, new Error('connection timed out')));
        socket.once('error', (error) => finish(false, error));
    });
}

async function run(options) {
    const checks = [];
    for (const endpoint of [options.apiUrl, options.panelUrl, options.proxyUrl].filter(Boolean)) {
        checks.push(await checkEndpoint(endpoint, options));
    }
    for (const port of options.ports) checks.push(await checkPort(port, options.timeoutMs));
    return { ok: checks.every((check) => check.ok), checks };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log('Usage: installer-protocol-check.js [--api-url URL] [--panel-url URL] [--proxy-url URL] [--port HOST:PORT] [--insecure]');
        return;
    }
    const result = await run(options);
    for (const check of result.checks) {
        const label = check.url || check.port;
        console.log(`${check.ok ? 'PASS' : 'FAIL'} ${label}${check.statusCode ? ` (${check.statusCode})` : ''}${check.error ? `: ${check.error}` : ''}`);
    }
    if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`FAIL ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    parseArgs,
    requestEndpoint,
    checkEndpoint,
    checkCertificateHostname,
    checkPort,
    run,
};
