'use strict';

const bundleService = require('../services/agentBundleService');

describe('agentBundle slug helpers', () => {
    it('slugifyName transliterates Polish and normalizes separators', () => {
        expect(bundleService.slugifyName('Moja Firma IT')).toBe('moja-firma-it');
        expect(bundleService.slugifyName('  Łódź & Warszawa  ')).toBe('lodz-warszawa');
    });

    it('validateSlug enforces length and charset', () => {
        expect(bundleService.validateSlug('acme').valid).toBe(true);
        expect(bundleService.validateSlug('a').valid).toBe(false);
        expect(bundleService.validateSlug('ACME').valid).toBe(false);
        expect(bundleService.validateSlug('acme_').valid).toBe(false);
    });

    it('allocateUniqueSlug appends numeric suffix on collision', () => {
        const taken = new Set(['acme']);
        const slug = bundleService.allocateUniqueSlug({
            preferred: 'acme',
            name: 'Acme',
            fallbackId: 'deadbeefcafe',
            isTaken: (s) => taken.has(s),
        });
        expect(slug).toBe('acme-2');
    });

    it('publicBundleId prefers slug over legacy bundle id', () => {
        expect(bundleService.publicBundleId({ slug: 'acme', bundle_id: 'c853d6ae677f' })).toBe('acme');
        expect(bundleService.publicBundleId({ bundle_id: 'c853d6ae677f' })).toBe('c853d6ae677f');
    });
});
