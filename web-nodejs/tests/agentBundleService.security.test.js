'use strict';

const bundleService = require('../services/agentBundleService');

describe('Support Agent bundle transport policy', () => {
    const baseBranding = {
        company_name: 'Example Support',
        server_host: 'desk.example.test',
    };

    it('defaults generated Support Agent profiles to HTTPS', () => {
        const result = bundleService.validateBranding(baseBranding);
        expect(result.valid).toBe(true);
        expect(result.normalized.use_https).toBe(true);
    });

    it('allows HTTP/WS transport for LAN deployments (RustDesk-style)', () => {
        const result = bundleService.validateBranding({
            ...baseBranding,
            use_https: false,
        });
        expect(result.valid).toBe(true);
        expect(result.errors).not.toContain('https_required');
        expect(result.normalized.use_https).toBe(false);
    });
});
