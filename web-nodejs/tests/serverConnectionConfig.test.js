'use strict';

const assert = require('assert');
const svc = require('../services/serverConnectionConfigService');

const sampleSystemd = `[Unit]
Description=BetterDesk Server

[Service]
Type=simple
ExecStart=/opt/betterdesk/betterdesk-server -mode all
Environment=P2P_FIRST=Y
Environment=ALWAYS_USE_RELAY=N
Restart=always

[Install]
WantedBy=multi-user.target
`;

const sampleCompose = `services:
  server:
    image: betterdesk-server:local
    environment:
      - ENCRYPTED_ONLY=1
      - DB_URL=/opt/rustdesk/db_v2.sqlite3
      - P2P_FIRST=Y
  console:
    environment:
      - NODE_ENV=production
`;

assert.strictEqual(svc.modeFromEnvVars({ P2P_FIRST: 'Y', ALWAYS_USE_RELAY: 'N' }), 'p2p_first');
assert.strictEqual(svc.modeFromEnvVars({ P2P_FIRST: 'N', ALWAYS_USE_RELAY: 'Y' }), 'relay_only');
assert.strictEqual(svc.modeFromEnvVars({ ALWAYS_USE_RELAY: 'Y' }), 'relay_only');

const relayVars = svc.envVarsFromSettings({ mode: 'relay_only', p2p_fallback_ms: 3000, same_nat_relay: false });
assert.strictEqual(relayVars.P2P_FIRST, 'N');
assert.strictEqual(relayVars.ALWAYS_USE_RELAY, 'Y');
assert.strictEqual(relayVars.P2P_FALLBACK_MS, '3000');
assert.strictEqual(relayVars.SAME_NAT_RELAY, 'N');

const systemdEnv = svc.parseSystemdEnvironment(sampleSystemd);
assert.strictEqual(systemdEnv.P2P_FIRST, 'Y');
assert.strictEqual(systemdEnv.ALWAYS_USE_RELAY, 'N');

const patchedSystemd = svc.patchSystemdEnvironment(sampleSystemd, relayVars);
assert(patchedSystemd.includes('Environment=P2P_FIRST=N'), 'patched P2P_FIRST');
assert(patchedSystemd.includes('Environment=ALWAYS_USE_RELAY=Y'), 'patched ALWAYS_USE_RELAY');
assert(!patchedSystemd.match(/Environment=P2P_FIRST=Y/m), 'old P2P_FIRST removed');

const composeEnv = svc.parseDockerComposeEnvironment(sampleCompose);
assert.strictEqual(composeEnv.P2P_FIRST, 'Y');
assert.strictEqual(composeEnv.ALWAYS_USE_RELAY, undefined);

const patchedCompose = svc.patchDockerComposeEnvironment(sampleCompose, relayVars);
assert(patchedCompose.includes('- P2P_FIRST=N'), 'compose P2P_FIRST patched');
assert(patchedCompose.includes('- ALWAYS_USE_RELAY=Y'), 'compose ALWAYS_USE_RELAY added');
assert(patchedCompose.includes('- ENCRYPTED_ONLY=1'), 'other env preserved');
assert(!patchedCompose.includes('console:\n    environment:\n      - P2P_FIRST'), 'console env untouched');

console.log('serverConnectionConfig tests passed');
