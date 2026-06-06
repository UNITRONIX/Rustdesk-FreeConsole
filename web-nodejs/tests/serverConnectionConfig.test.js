'use strict';

const svc = require('../services/serverConnectionConfigService');

describe('serverConnectionConfigService', () => {
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

    it('derives connection mode from env vars', () => {
        expect(svc.modeFromEnvVars({ P2P_FIRST: 'Y', ALWAYS_USE_RELAY: 'N' })).toBe('p2p_first');
        expect(svc.modeFromEnvVars({ P2P_FIRST: 'N', ALWAYS_USE_RELAY: 'Y' })).toBe('relay_only');
        expect(svc.modeFromEnvVars({ ALWAYS_USE_RELAY: 'Y' })).toBe('relay_only');
    });

    it('builds env vars from settings', () => {
        const relayVars = svc.envVarsFromSettings({
            mode: 'relay_only',
            p2p_fallback_ms: 3000,
            same_nat_relay: false
        });
        expect(relayVars.P2P_FIRST).toBe('N');
        expect(relayVars.ALWAYS_USE_RELAY).toBe('Y');
        expect(relayVars.P2P_FALLBACK_MS).toBe('3000');
        expect(relayVars.SAME_NAT_RELAY).toBe('N');
    });

    it('parses and patches systemd environment blocks', () => {
        const systemdEnv = svc.parseSystemdEnvironment(sampleSystemd);
        expect(systemdEnv.P2P_FIRST).toBe('Y');
        expect(systemdEnv.ALWAYS_USE_RELAY).toBe('N');

        const relayVars = svc.envVarsFromSettings({
            mode: 'relay_only',
            p2p_fallback_ms: 3000,
            same_nat_relay: false
        });
        const patchedSystemd = svc.patchSystemdEnvironment(sampleSystemd, relayVars);
        expect(patchedSystemd).toContain('Environment=P2P_FIRST=N');
        expect(patchedSystemd).toContain('Environment=ALWAYS_USE_RELAY=Y');
        expect(patchedSystemd.match(/Environment=P2P_FIRST=Y/m)).toBeNull();
    });

    it('parses and patches docker-compose server environment only', () => {
        const composeEnv = svc.parseDockerComposeEnvironment(sampleCompose);
        expect(composeEnv.P2P_FIRST).toBe('Y');
        expect(composeEnv.ALWAYS_USE_RELAY).toBeUndefined();

        const relayVars = svc.envVarsFromSettings({
            mode: 'relay_only',
            p2p_fallback_ms: 3000,
            same_nat_relay: false
        });
        const patchedCompose = svc.patchDockerComposeEnvironment(sampleCompose, relayVars);
        expect(patchedCompose).toContain('- P2P_FIRST=N');
        expect(patchedCompose).toContain('- ALWAYS_USE_RELAY=Y');
        expect(patchedCompose).toContain('- ENCRYPTED_ONLY=1');
        expect(patchedCompose).not.toMatch(/console:\n    environment:\n      - P2P_FIRST/);
    });
});
