'use strict';

/**
 * Canonical product and queue values shared by generator persistence, routes,
 * and build workers. Legacy rows used "agent" for Support Agent bundles.
 */

const PRODUCT_TYPES = Object.freeze({
    SUPPORT_AGENT: 'support-agent',
    AGENT_CLIENT: 'agent-client',
    RDCLIENT: 'rdclient',
});

const QUEUED_BUILD_STATUSES = new Set(['queued', 'pending']);

function canonicalProductType(raw) {
    const value = String(raw ?? '').trim().toLowerCase();
    if (value === PRODUCT_TYPES.RDCLIENT) return PRODUCT_TYPES.RDCLIENT;
    if (value === PRODUCT_TYPES.AGENT_CLIENT || value === 'agent_client') {
        return PRODUCT_TYPES.AGENT_CLIENT;
    }
    if (value === PRODUCT_TYPES.SUPPORT_AGENT || value === 'support_agent' || value === 'agent') {
        return PRODUCT_TYPES.SUPPORT_AGENT;
    }
    return null;
}

function normalizeProductType(raw, fallback = PRODUCT_TYPES.SUPPORT_AGENT) {
    return canonicalProductType(raw)
        || canonicalProductType(fallback)
        || PRODUCT_TYPES.SUPPORT_AGENT;
}

function isProductType(raw, expected) {
    return normalizeProductType(raw) === expected;
}

function isQueuedBuildStatus(status) {
    return QUEUED_BUILD_STATUSES.has(String(status ?? '').trim().toLowerCase());
}

function normalizeBuildStatus(status, fallback = 'queued') {
    const value = String(status ?? '').trim().toLowerCase();
    if (isQueuedBuildStatus(value)) return 'queued';
    return value || fallback;
}

module.exports = {
    PRODUCT_TYPES,
    QUEUED_BUILD_STATUSES,
    normalizeProductType,
    isProductType,
    isQueuedBuildStatus,
    normalizeBuildStatus,
};
