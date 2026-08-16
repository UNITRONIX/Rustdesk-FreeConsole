'use strict';

const {
    PRODUCT_TYPES,
    normalizeProductType,
    isQueuedBuildStatus,
    normalizeBuildStatus,
} = require('../lib/generatorBuildTypes');

describe('generator build type compatibility', () => {
    test('normalizes legacy product type aliases to canonical worker types', () => {
        expect(normalizeProductType()).toBe(PRODUCT_TYPES.SUPPORT_AGENT);
        expect(normalizeProductType('agent')).toBe(PRODUCT_TYPES.SUPPORT_AGENT);
        expect(normalizeProductType('support_agent')).toBe(PRODUCT_TYPES.SUPPORT_AGENT);
        expect(normalizeProductType('agent_client')).toBe(PRODUCT_TYPES.AGENT_CLIENT);
        expect(normalizeProductType('rdclient')).toBe(PRODUCT_TYPES.RDCLIENT);
        expect(normalizeProductType('unknown', PRODUCT_TYPES.AGENT_CLIENT))
            .toBe(PRODUCT_TYPES.AGENT_CLIENT);
    });

    test('treats queued and legacy pending jobs as the same queue state', () => {
        expect(isQueuedBuildStatus('queued')).toBe(true);
        expect(isQueuedBuildStatus('PENDING')).toBe(true);
        expect(isQueuedBuildStatus('building')).toBe(false);
        expect(normalizeBuildStatus('pending')).toBe('queued');
        expect(normalizeBuildStatus('ready')).toBe('ready');
    });
});
