'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const conn = require('../services/agentBundleConnection');

test('normalizeServerHost strips scheme and port', () => {
    const r = conn.normalizeServerHost('https://desk.example.com:8443/path');
    assert.equal(r.valid, true);
    assert.equal(r.host, 'desk.example.com');
});

test('buildServerUrls omits default https port', () => {
    const urls = conn.buildServerUrls('desk.example.com', true, '443');
    assert.equal(urls.address, 'https://desk.example.com');
    assert.equal(urls.api_url, 'https://desk.example.com/api');
});

test('buildServerUrls bakes CDAP and console endpoints', () => {
    const urls = conn.buildServerUrls('desk.example.com', false, '21114');
    assert.equal(urls.address, 'http://desk.example.com:21114');
    assert.equal(urls.cdap_url, 'ws://desk.example.com:21122/cdap');
    assert.equal(urls.console_url, 'http://desk.example.com:5000');
    assert.equal(urls.cdap_port, 21122);
    assert.equal(urls.console_port, 5000);
});

test('connectionFingerprint compares host and TLS only', () => {
    const a = { server_host: 'a.example.com', use_https: true };
    const b = { server: { address: 'https://a.example.com:21114' }, use_https: true };
    assert.equal(conn.connectionFingerprint(a), conn.connectionFingerprint(b));
});
