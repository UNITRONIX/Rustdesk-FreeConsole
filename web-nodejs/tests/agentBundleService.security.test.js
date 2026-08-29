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

describe('Download portal product label branding (#386)', () => {
    const baseBranding = {
        company_name: 'Example Support',
        server_host: 'desk.example.test',
    };

    it('normalizes product_label and hide_product_type', () => {
        const result = bundleService.validateBranding({
            ...baseBranding,
            product_label: '  Acme Remote Client  ',
            hide_product_type: true,
        });
        expect(result.valid).toBe(true);
        expect(result.normalized.product_label).toBe('Acme Remote Client');
        expect(result.normalized.hide_product_type).toBe(true);
    });

    it('defaults portal product fields when omitted', () => {
        const result = bundleService.validateBranding(baseBranding);
        expect(result.valid).toBe(true);
        expect(result.normalized.product_label).toBe('');
        expect(result.normalized.hide_product_type).toBe(false);
    });

    it('clips product_label to MAX_PRODUCT_LABEL', () => {
        const long = 'x'.repeat(bundleService.MAX_PRODUCT_LABEL + 50);
        const result = bundleService.validateBranding({
            ...baseBranding,
            product_label: long,
        });
        expect(result.normalized.product_label).toHaveLength(bundleService.MAX_PRODUCT_LABEL);
    });

    it('excludes portal-only fields from branding hash (no rebuild)', () => {
        const a = bundleService.validateBranding(baseBranding).normalized;
        const b = bundleService.validateBranding({
            ...baseBranding,
            product_label: 'Custom label',
            hide_product_type: true,
        }).normalized;
        expect(bundleService.hashBranding(a)).toBe(bundleService.hashBranding(b));
    });

    it('applies portal fields for RdClient branding too', () => {
        const result = bundleService.validateRdclientBranding({
            company_name: 'Ops',
            server_host: 'panel.example.test',
            product_label: 'Ops RdClient',
            hide_product_type: true,
        });
        expect(result.valid).toBe(true);
        expect(result.normalized.product_label).toBe('Ops RdClient');
        expect(result.normalized.hide_product_type).toBe(true);
    });
});
