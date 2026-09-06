'use strict';

/**
 * Canonical product and queue values shared by generator persistence, routes,
 * and build workers. Legacy rows used "agent" / "support-agent" for the old
 * Go Support Agent; they normalize to betterdesk-support (template + custom.txt).
 */

const PRODUCT_TYPES = Object.freeze({
    BETTERDESK_SUPPORT: 'betterdesk-support',
});

const QUEUED_BUILD_STATUSES = new Set(['queued', 'pending']);

function canonicalProductType(raw) {
    const value = String(raw ?? '').trim().toLowerCase();
    if (
        value === PRODUCT_TYPES.BETTERDESK_SUPPORT
        || value === 'betterdesk_support'
        || value === 'support-agent'
        || value === 'support_agent'
        || value === 'agent'
        || value === 'agent-client'
        || value === 'agent_client'
        || value === 'rdclient'
    ) {
        return PRODUCT_TYPES.BETTERDESK_SUPPORT;
    }
    return null;
}

function normalizeProductType(raw, fallback = PRODUCT_TYPES.BETTERDESK_SUPPORT) {
    return canonicalProductType(raw)
        || canonicalProductType(fallback)
        || PRODUCT_TYPES.BETTERDESK_SUPPORT;
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
