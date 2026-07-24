'use strict';

const {
    validateSettings,
    normalizeSettings,
    settingsFromEnvContent,
    isValidNTPServerEntry,
    envToBool,
    boolToEnv,
} = require('../services/billingClockConfigService');

describe('billingClockConfigService', () => {
    test('normalizeSettings trims NTP server list', () => {
        const out = normalizeSettings({
            ntp_servers: ' 10.0.0.1 , ntp.example.com , ',
            max_skew_ms: '3000',
        });
        expect(out.ntp_servers).toBe('10.0.0.1,ntp.example.com');
        expect(out.max_skew_ms).toBe(3000);
    });

    test('validateSettings rejects invalid hostnames', () => {
        expect(() => validateSettings({ ntp_servers: 'bad host name' }))
            .toThrow('invalid_ntp_servers');
    });

    test('validateSettings accepts IPv4 NTP servers', () => {
        const out = validateSettings({ ntp_servers: '192.168.1.1' });
        expect(out.ntp_servers).toBe('192.168.1.1');
    });

    test('settingsFromEnvContent reads billing keys', () => {
        const content = [
            'NTP_SERVERS=10.0.0.1',
            'BILLING_MAX_CLOCK_SKEW_MS=1500',
            'BILLING_REQUIRE_SYNCED_CLOCK=0',
            'BILLING_TRUST_OS_NTP=1',
        ].join('\n');
        const settings = settingsFromEnvContent(content);
        expect(settings.ntp_servers).toBe('10.0.0.1');
        expect(settings.max_skew_ms).toBe(1500);
        expect(settings.require_synced_clock).toBe(false);
        expect(settings.trust_os_ntp).toBe(true);
    });

    test('isValidNTPServerEntry validates IP and hostname', () => {
        expect(isValidNTPServerEntry('10.0.0.1')).toBe(true);
        expect(isValidNTPServerEntry('time.google.com')).toBe(true);
        expect(isValidNTPServerEntry('')).toBe(false);
    });

    test('envToBool and boolToEnv round-trip', () => {
        expect(envToBool('Y', false)).toBe(true);
        expect(envToBool('0', true)).toBe(false);
        expect(boolToEnv(true)).toBe('1');
        expect(boolToEnv(false)).toBe('0');
    });
});
