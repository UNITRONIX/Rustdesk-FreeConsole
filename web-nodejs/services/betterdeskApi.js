/**
 * BetterDesk Console - BetterDesk Go Server API Client
 * Full client for the BetterDesk Go server REST API (34+ endpoints).
 * Used when serverBackend is set to 'betterdesk'.
 *
 * Auth: X-API-Key header (reads the same .api_key file as hbbs).
 * The Go server accepts X-API-Key for all authenticated endpoints.
 */

const axios = require('axios');
const http = require('http');
const https = require('https');
const fs = require('fs');
const config = require('../config/config');

// Determine whether the Go API URL uses HTTPS so we only set the appropriate
// agent. Setting httpsAgent on plain HTTP connections can trigger spurious
// EPROTO / "wrong version number" errors on some axios/Node.js versions.
const _isApiHttps = (config.betterdeskApiUrl || '').startsWith('https://');

// Axios instance for BetterDesk Go API
const apiClient = axios.create({
    baseURL: config.betterdeskApiUrl,
    timeout: config.betterdeskApiTimeout,
    headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.betterdeskApiKey
    },
    ...(_isApiHttps
        ? { httpsAgent: new https.Agent({ rejectUnauthorized: !config.allowSelfSignedCerts }) }
        : { httpAgent: new http.Agent({ keepAlive: true }) }
    ),
});

// Retry once on 401 by reloading API key from file (handles race condition
// where Go server generated the key after Node.js cached an empty value).
let _keyReloaded = false;
let _tlsMismatchWarned = false;
apiClient.interceptors.response.use(undefined, async (error) => {
    // Detect TLS mismatch: Node.js sends HTTP but Go server expects HTTPS (issue #104)
    if (!_tlsMismatchWarned && error.response?.status === 400) {
        const body = typeof error.response.data === 'string' ? error.response.data : '';
        if (body.includes('HTTP request to an HTTPS server') || body.includes('Client sent an HTTP request')) {
            _tlsMismatchWarned = true;
            console.error('[BetterDesk API] ⚠ TLS MISMATCH: Go server has TLS_API=Y enabled on port ' +
                (config.betterdeskApiUrl || '21114') + ' but this console connects via HTTP.');
            console.error('[BetterDesk API]   Fix: remove TLS_API=Y from Go server environment or add -tls-api removal.');
            console.error('[BetterDesk API]   The API port must stay HTTP for console↔Go communication. See issue #104.');
        }
    }
    if (error.response?.status === 401 && !_keyReloaded) {
        _keyReloaded = true;
        try {
            const fresh = fs.readFileSync(config.apiKeyPath, 'utf8').trim();
            if (fresh && fresh !== config.betterdeskApiKey) {
                apiClient.defaults.headers['X-API-Key'] = fresh;
                config.betterdeskApiKey = fresh;
                console.log('API key reloaded from', config.apiKeyPath);
                // Retry the original request with new key
                error.config.headers['X-API-Key'] = fresh;
                return apiClient.request(error.config);
            }
        } catch (_) { /* file not found — nothing to reload */ }
    }
    return Promise.reject(error);
});

// ---------------------------------------------------------------------------
// Helper: normalise Go API flat responses into { success, data } shape
// that the Node.js panel expects.
// ---------------------------------------------------------------------------
function wrap(data) {
    if (data && typeof data === 'object' && 'error' in data) {
        return { success: false, error: data.error };
    }
    return { success: true, data };
}

// ========================== Health / Stats ==================================

/**
 * GET /api/health
 */
async function getHealth() {
    try {
        const { data } = await apiClient.get('/health');
        // Go server returns status:'ok'; normalise to status:'running' for panel compatibility
        return { ...data, status: 'running', backend: 'betterdesk' };
    } catch (err) {
        return { status: 'unreachable', backend: 'betterdesk', error: err.message };
    }
}

/**
 * GET /api/server/stats
 */
async function getServerStats() {
    try {
        const { data } = await apiClient.get('/server/stats');
        return wrap(data);
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ========================== Peers (Devices) =================================

/**
 * GET /api/peers  — full device list
 * Returns array of peer objects already normalised.
 */
async function getAllPeers() {
    try {
        const { data } = await apiClient.get('/peers');
        // Go server returns flat array or { peers: [...] }
        const peers = Array.isArray(data) ? data : (data.peers || []);
        return peers.map(normalisePeer);
    } catch (err) {
        console.warn('BetterDesk API getAllPeers error:', err.message);
        return [];
    }
}

/**
 * GET /api/peers/:id
 */
async function getPeer(id) {
    try {
        const { data } = await apiClient.get(`/peers/${encodeURIComponent(id)}`);
        return normalisePeer(data);
    } catch (err) {
        return null;
    }
}

/**
 * DELETE /api/peers/:id
 * @param {string} id - Peer ID
 * @param {object} [options] - Optional: { revoke: bool, cascade: bool, hard: bool }
 */
async function deletePeer(id, options = {}) {
    try {
        const params = new URLSearchParams();
        if (options.revoke) params.set('revoke', 'true');
        if (options.cascade) params.set('cascade', 'true');
        if (options.hard) params.set('hard', 'true');
        const qs = params.toString();
        const url = `/peers/${encodeURIComponent(id)}${qs ? '?' + qs : ''}`;
        const { data } = await apiClient.delete(url);
        return wrap(data);
    } catch (err) {
        if (err.response?.data) return wrap(err.response.data);
        return { success: false, error: err.message };
    }
}

/**
 * POST /api/peers/:id/ban
 */
async function banPeer(id, reason = '') {
    try {
        const { data } = await apiClient.post(`/peers/${encodeURIComponent(id)}/ban`, { reason });
        return wrap(data);
    } catch (err) {
        if (err.response?.data) return wrap(err.response.data);
        return { success: false, error: err.message };
    }
}

/**
 * POST /api/peers/:id/unban
 */
async function unbanPeer(id) {
    try {
        const { data } = await apiClient.post(`/peers/${encodeURIComponent(id)}/unban`);
        return wrap(data);
    } catch (err) {
        if (err.response?.data) return wrap(err.response.data);
        return { success: false, error: err.message };
    }
}

/**
 * POST /api/peers/:id/change-id
 */
async function changePeerId(oldId, newId) {
    try {
        const { data } = await apiClient.post(`/peers/${encodeURIComponent(oldId)}/change-id`, { new_id: newId });
        return wrap(data);
    } catch (err) {
        if (err.response?.data) return wrap(err.response.data);
        return { success: false, error: err.message };
    }
}

// ========================== Status ==========================================

/**
 * GET /api/peers/status/summary
 */
async function getStatusSummary() {
    try {
        const { data } = await apiClient.get('/peers/status/summary');
        return wrap(data);
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * GET /api/peers/online
 */
async function getOnlinePeers() {
    try {
        const { data } = await apiClient.get('/peers/online');
        const peers = Array.isArray(data) ? data : (data.peers || []);
        return peers;
    } catch (err) {
        console.warn('BetterDesk API getOnlinePeers error:', err.message);
        return [];
    }
}

/**
 * GET /api/peers/:id/status
 */
async function getPeerStatus(id) {
    try {
        const { data } = await apiClient.get(`/peers/${encodeURIComponent(id)}/status`);
        return wrap(data);
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ========================== Blocklist ========================================

/**
 * GET /api/blocklist
 */
async function getBlocklist() {
    try {
        const { data } = await apiClient.get('/blocklist');
        return wrap(data);
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * POST /api/blocklist
 */
async function addBlocklistEntry(entry) {
    try {
        const { data } = await apiClient.post('/blocklist', { entry });
        return wrap(data);
    } catch (err) {
        if (err.response?.data) return wrap(err.response.data);
        return { success: false, error: err.message };
    }
}

/**
 * DELETE /api/blocklist/:entry
 */
async function removeBlocklistEntry(entry) {
    try {
        const { data } = await apiClient.delete(`/blocklist/${encodeURIComponent(entry)}`);
        return wrap(data);
    } catch (err) {
        if (err.response?.data) return wrap(err.response.data);
        return { success: false, error: err.message };
    }
}

// ========================== Tags =============================================

/**
 * PUT /api/peers/:id/tags
 */
async function setPeerTags(id, tags) {
    try {
        // Ensure tags is sent as an array (Go server now accepts both string and array)
        const payload = Array.isArray(tags) ? tags : (typeof tags === 'string' ? tags.split(',').map(t => t.trim()).filter(Boolean) : []);
        const { data } = await apiClient.put(`/peers/${encodeURIComponent(id)}/tags`, { tags: payload });
        return wrap(data);
    } catch (err) {
        if (err.response?.data) return wrap(err.response.data);
        return { success: false, error: err.message };
    }
}

/**
 * PATCH /api/peers/:id - Update peer fields (note, user, tags)
 */
async function updatePeer(id, fields) {
    try {
        const { data } = await apiClient.patch(`/peers/${encodeURIComponent(id)}`, fields);
        return wrap(data);
    } catch (err) {
        if (err.response?.data) return wrap(err.response.data);
        return { success: false, error: err.message };
    }
}

/**
 * GET /api/tags/:tag/peers
 */
async function getPeersByTag(tag) {
    try {
        const { data } = await apiClient.get(`/tags/${encodeURIComponent(tag)}/peers`);
        const peers = Array.isArray(data) ? data : (data.peers || []);
        return peers.map(normalisePeer);
    } catch (err) {
        return [];
    }
}

// ========================== Audit ============================================

/**
 * GET /api/audit/events?limit=N
 */
async function getAuditEvents(limit = 100) {
    try {
        const { data } = await apiClient.get('/audit/events', { params: { limit } });
        return wrap(data);
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ========================== Config ===========================================

/**
 * GET /api/config/:key
 */
async function getConfig(key) {
    try {
        const { data } = await apiClient.get(`/config/${encodeURIComponent(key)}`);
        return wrap(data);
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * PUT /api/config/:key
 */
async function setConfig(key, value) {
    try {
        const { data } = await apiClient.put(`/config/${encodeURIComponent(key)}`, { value });
        return wrap(data);
    } catch (err) {
        if (err.response?.data) return wrap(err.response.data);
        return { success: false, error: err.message };
    }
}

// ========================== Server Info ======================================

/**
 * Combined server info for the panel settings page
 */
async function getServerInfo() {
    try {
        const [healthRes, statsRes] = await Promise.all([
            apiClient.get('/health').catch(() => ({ data: {} })),
            apiClient.get('/server/stats').catch(() => ({ data: {} }))
        ]);
        return {
            health: healthRes.data,
            stats: statsRes.data,
            backend: 'betterdesk'
        };
    } catch (err) {
        return null;
    }
}

// ========================== Sync (no-op for BetterDesk) ======================

/**
 * In BetterDesk mode the Go server owns the peer map, so status sync
 * is not needed. This is a no-op kept for interface compatibility.
 */
async function syncOnlineStatus(/* db */) {
    return { synced: 0, skipped: true, reason: 'betterdesk_manages_state' };
}

// ========================== Helpers ==========================================

/**
 * Normalise a Go-server peer object to the shape the panel expects.
 *
 * Go server /api/peers returns (see db.Peer struct + peerResponse):
 *   id, uuid, pk, ip, user, hostname, os, version, status,
 *   nat_type, last_online, created_at, disabled, banned,
 *   ban_reason, banned_at, soft_deleted, deleted_at, note, tags,
 *   live_online (bool), live_status ("online"|"degraded"|"critical"|"offline")
 *
 * Panel expected shape: id, hostname, username, platform, ip, note,
 *   online (bool), banned (bool), created_at, last_online, ban_reason,
 *   folder_id, tags[], status_tier, uuid, disabled, os, version
 */
function normalisePeer(peer) {
    if (!peer) return peer;

    // Parse tags: Go server sends comma-separated string or JSON array
    let tags = [];
    if (Array.isArray(peer.tags)) {
        tags = peer.tags;
    } else if (typeof peer.tags === 'string' && peer.tags) {
        try {
            const parsed = JSON.parse(peer.tags);
            tags = Array.isArray(parsed) ? parsed : [peer.tags];
        } catch {
            tags = peer.tags.split(',').map(t => t.trim()).filter(Boolean);
        }
    }

    return {
        id: peer.id || '',
        hostname: peer.hostname || '',
        display_name: peer.display_name || '',
        username: peer.user || '',
        platform: peer.os || '',
        os: peer.os || '',
        version: peer.version || '',
        ip: peer.ip || '',
        note: peer.note || '',
        online: !!(peer.live_online),
        banned: !!(peer.banned),
        created_at: peer.created_at || '',
        last_online: peer.last_online || '',
        ban_reason: peer.ban_reason || '',
        banned_at: peer.banned_at || null,
        folder_id: peer.folder_id || null,
        tags,
        status_tier: peer.live_status || (peer.live_online ? 'online' : 'offline'),
        uuid: peer.uuid || '',
        nat_type: peer.nat_type || 0,
        disabled: !!(peer.disabled || peer.soft_deleted),
        device_type: peer.device_type || '',
        cdap_connected: !!peer.cdap_connected
    };
}

// ---------------------------------------------------------------------------
// CDAP (Custom Device Automation Protocol) endpoints
// ---------------------------------------------------------------------------

async function getCDAPStatus() {
    try {
        const { data } = await apiClient.get('/cdap/status');
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function getCDAPDevices() {
    try {
        const { data } = await apiClient.get('/cdap/devices');
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function getCDAPDeviceInfo(id) {
    try {
        const { data } = await apiClient.get(`/cdap/devices/${encodeURIComponent(id)}`);
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function getCDAPDeviceManifest(id) {
    try {
        const { data } = await apiClient.get(`/cdap/devices/${encodeURIComponent(id)}/manifest`);
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function getCDAPDeviceState(id) {
    try {
        const { data } = await apiClient.get(`/cdap/devices/${encodeURIComponent(id)}/state`);
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function sendCDAPCommand(id, widgetId, action, value, reason) {
    try {
        const { data } = await apiClient.post(`/cdap/devices/${encodeURIComponent(id)}/command`, {
            widget_id: widgetId,
            action,
            value,
            reason: reason || ''
        });
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function getCDAPAlerts(deviceId) {
    try {
        const params = deviceId ? { device_id: deviceId } : {};
        const { data } = await apiClient.get('/cdap/alerts', { params });
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message, alerts: [], total: 0 };
    }
}

async function getLinkedPeers(id) {
    try {
        const { data } = await apiClient.get(`/peers/${encodeURIComponent(id)}/linked`);
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message, linked: [], total: 0 };
    }
}

async function linkDevice(id, linkedPeerId) {
    try {
        const { data } = await apiClient.patch(`/peers/${encodeURIComponent(id)}`, {
            linked_peer_id: linkedPeerId || ''
        });
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ========================== Device Tokens ====================================

/**
 * GET /api/tokens
 */
async function listDeviceTokens(includeRevoked) {
    try {
        const params = includeRevoked ? { include_revoked: 'true' } : {};
        const { data } = await apiClient.get('/tokens', { params });
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * POST /api/tokens
 */
async function createDeviceToken(body) {
    try {
        const { data } = await apiClient.post('/tokens', body);
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * GET /api/tokens/:id
 */
async function getDeviceToken(id) {
    try {
        const { data } = await apiClient.get(`/tokens/${id}`);
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * PUT /api/tokens/:id
 */
async function updateDeviceToken(id, body) {
    try {
        const { data } = await apiClient.put(`/tokens/${id}`, body);
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * DELETE /api/tokens/:id
 */
async function revokeDeviceToken(id) {
    try {
        const { data } = await apiClient.delete(`/tokens/${id}`);
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * POST /api/tokens/generate-bulk
 */
async function bulkGenerateTokens(body) {
    try {
        const { data } = await apiClient.post('/tokens/generate-bulk', body);
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * POST /api/tokens/:id/bind
 */
async function bindTokenToPeer(id, peerId) {
    try {
        const { data } = await apiClient.post(`/tokens/${id}/bind`, { peer_id: peerId });
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * GET /api/enrollment/mode
 */
async function getEnrollmentMode() {
    try {
        const { data } = await apiClient.get('/enrollment/mode');
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * PUT /api/enrollment/mode
 */
async function setEnrollmentMode(mode) {
    try {
        const { data } = await apiClient.put('/enrollment/mode', { mode });
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ---------------------------------------------------------------------------
// Enrollment — pending device management (proxied from Go server)
// ---------------------------------------------------------------------------

/**
 * Get list of pending enrollment requests from Go server.
 */
async function getEnrollmentPending() {
    try {
        const { data } = await apiClient.get('/enrollment/pending');
        return { success: true, data: data.devices || [], count: data.count || 0 };
    } catch (e) {
        return { success: false, error: e.message, data: [], count: 0 };
    }
}

/**
 * Approve a pending enrollment request on Go server.
 * @param {string} deviceId - Device ID to approve
 * @param {string} displayName - Operator-assigned display name
 * @param {string} syncMode - Sync mode: silent, standard, turbo
 */
async function approveEnrollment(deviceId, displayName, syncMode) {
    try {
        const { data } = await apiClient.post(`/enrollment/approve/${encodeURIComponent(deviceId)}`, {
            display_name: displayName || '',
            sync_mode: syncMode || 'standard'
        });
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * Reject a pending enrollment request on Go server.
 * @param {string} deviceId - Device ID to reject
 */
async function rejectEnrollment(deviceId) {
    try {
        const { data } = await apiClient.post(`/enrollment/reject/${encodeURIComponent(deviceId)}`);
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * Get branding configuration from Go server (public endpoint).
 */
async function getBranding() {
    try {
        const { data } = await apiClient.get('/branding');
        return { success: true, data };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * Save branding configuration to Go server.
 */
async function saveBranding(brandingData) {
    try {
        const { data } = await apiClient.post('/branding', brandingData);
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * Get unattended access policy for a peer device.
 */
async function getAccessPolicy(id) {
    try {
        const { data } = await apiClient.get(`/peers/${id}/access-policy`);
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * Save unattended access policy for a peer device.
 */
async function saveAccessPolicy(id, policy) {
    try {
        const { data } = await apiClient.put(`/peers/${id}/access-policy`, policy);
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * Delete unattended access policy for a peer device.
 */
async function deleteAccessPolicy(id) {
    try {
        const { data } = await apiClient.delete(`/peers/${id}/access-policy`);
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ── RBAC: Roles & Permissions (Phase 52) ─────────────────────

/**
 * List all built-in roles with their default permission sets.
 */
async function listRoles() {
    try {
        const { data } = await apiClient.get('/roles');
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * Get effective permissions for a specific role (defaults + overrides).
 */
async function getRolePermissions(role) {
    try {
        const { data } = await apiClient.get(`/roles/${encodeURIComponent(role)}/permissions`);
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * List all custom permission overrides from the DB.
 */
async function listRolePermissionOverrides(role) {
    try {
        const url = role ? `/role-permissions?role=${encodeURIComponent(role)}` : '/role-permissions';
        const { data } = await apiClient.get(url);
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * Set a custom permission override for a role.
 * @param {string} role
 * @param {string} permission
 * @param {boolean} granted
 */
async function setRolePermission(role, permission, granted) {
    try {
        const { data } = await apiClient.post('/role-permissions', { role, permission, granted });
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * Delete a custom permission override (revert to default).
 */
async function deleteRolePermission(role, permission) {
    try {
        const { data } = await apiClient.delete(`/role-permissions/${encodeURIComponent(role)}/${encodeURIComponent(permission)}`);
        return wrap(data);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

module.exports = {
    // Health / Stats
    getHealth,
    getServerStats,
    getServerInfo,
    // Peers
    getAllPeers,
    getPeer,
    deletePeer,
    banPeer,
    unbanPeer,
    changePeerId,
    // Status
    getStatusSummary,
    getOnlinePeers,
    getPeerStatus,
    // Blocklist
    getBlocklist,
    addBlocklistEntry,
    removeBlocklistEntry,
    // Tags
    setPeerTags,
    getPeersByTag,
    // Peer update
    updatePeer,
    // Audit
    getAuditEvents,
    // Config
    getConfig,
    setConfig,
    // Sync (no-op)
    syncOnlineStatus,
    // CDAP
    getCDAPStatus,
    getCDAPDevices,
    getCDAPDeviceInfo,
    getCDAPDeviceManifest,
    getCDAPDeviceState,
    sendCDAPCommand,
    getCDAPAlerts,
    getLinkedPeers,
    linkDevice,
    // Device Tokens
    listDeviceTokens,
    createDeviceToken,
    getDeviceToken,
    updateDeviceToken,
    revokeDeviceToken,
    bulkGenerateTokens,
    bindTokenToPeer,
    getEnrollmentMode,
    setEnrollmentMode,
    // Enrollment — pending devices
    getEnrollmentPending,
    approveEnrollment,
    rejectEnrollment,
    // Branding (Go server)
    getBranding: getBranding,
    saveBranding: saveBranding,
    // Access Policies (Unattended Access)
    getAccessPolicy,
    saveAccessPolicy,
    deleteAccessPolicy,
    // RBAC: Roles & Permissions (Phase 52)
    listRoles,
    getRolePermissions,
    listRolePermissionOverrides,
    setRolePermission,
    deleteRolePermission,
    // Helpers
    normalisePeer,
    // Raw axios client (for services that need direct API access)
    apiClient,
};
