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

    it('rejects plaintext transport unless explicitly enabled for development', () => {
        const previous = process.env.BETTERDESK_ALLOW_INSECURE_DEV_AGENT_BUNDLES;
        delete process.env.BETTERDESK_ALLOW_INSECURE_DEV_AGENT_BUNDLES;
        try {
            const result = bundleService.validateBranding({
                ...baseBranding,
                use_https: false,
            });
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('https_required');
        } finally {
            if (previous === undefined) {
                delete process.env.BETTERDESK_ALLOW_INSECURE_DEV_AGENT_BUNDLES;
            } else {
                process.env.BETTERDESK_ALLOW_INSECURE_DEV_AGENT_BUNDLES = previous;
            }
        }
    });
});
