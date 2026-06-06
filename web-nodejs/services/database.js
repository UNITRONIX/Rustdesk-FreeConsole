/**
 * BetterDesk Console  Database Service (Facade)
 *
 * This module is a backward-compatible async facade over dbAdapter.js.
 * It re-exports all adapter methods using the legacy API names so that
 * existing callers keep working after adding `await`.
 *
 * When DB_TYPE=sqlite  -> SQLite via better-sqlite3 (fast, synchronous under the hood)
 * When DB_TYPE=postgres -> PostgreSQL via pg Pool (truly async)
 *
 * IMPORTANT: All exported methods are async (return Promises).
 * Callers MUST use `await` when invoking them.
 */

'use strict';

const { getAdapter, DB_TYPE } = require('./dbAdapter');
const config = require('../config/config');

// Create (or retrieve) the singleton adapter.  This does NOT open any
// database connections yet  that happens lazily on first use or on init().
const adapter = getAdapter(config);

// =========================================================================
//  Facade  Legacy Name Mappings
// =========================================================================

const facade = {
    // Expose the adapter type so callers can branch if needed
    get type() { return adapter.type; },
    get DB_TYPE() { return DB_TYPE; },

    // ---- Lifecycle ----
    init:  () => adapter.init(),
    close: () => adapter.close(),

    // ---- Peers / Devices (with legacy aliases) ----
    getAllPeers:   (filters) => adapter.getAllPeers(filters),
    getAllDevices:  (filters) => adapter.getAllPeers(filters),
    getPeerById:   (id) => adapter.getPeerById(id),
    getDeviceById: (id) => adapter.getPeerById(id),
    getDevice:     (id) => adapter.getPeerById(id),
    upsertPeer:    (data) => adapter.upsertPeer(data),
    updatePeer:    (id, data) => adapter.updatePeer(id, data),
    updateDevice:  (id, data) => adapter.updatePeer(id, data),
    softDeletePeer: (id) => adapter.softDeletePeer(id),
    deleteDevice:   (id) => adapter.softDeletePeer(id),
    getRenamedPeerId: (id) => adapter.getRenamedPeerId ? adapter.getRenamedPeerId(id) : null,
    setBanStatus:  (id, banned, reason) => adapter.setBanStatus(id, banned, reason),
    getPeerStats:  () => adapter.getPeerStats(),
    getStats:      () => adapter.getPeerStats(),
    countDevices:  (filters) => adapter.countDevices(filters),
    resetAllOnlineStatus: () => adapter.resetAllOnlineStatus(),
    markPeersOnline: (ids) => adapter.markPeersOnline(ids),

    // ---- Peer Online Status / Heartbeat ----
    updatePeerOnlineStatus: (peerId) => adapter.updatePeerOnlineStatus(peerId),
    cleanupStaleOnlinePeers: (thresholdSeconds) => adapter.cleanupStaleOnlinePeers(thresholdSeconds),

    // ---- Peer Sysinfo ----
    upsertPeerSysinfo: (peerId, data) => adapter.upsertPeerSysinfo(peerId, data),
    getPeerSysinfo:    (peerId) => adapter.getPeerSysinfo(peerId),
    getAllPeerSysinfo:  () => adapter.getAllPeerSysinfo(),

    // ---- Peer Metrics ----
    insertPeerMetric:  (peerId, cpu, mem, disk) => adapter.insertPeerMetric(peerId, cpu, mem, disk),
    getPeerMetrics:    (peerId, limit) => adapter.getPeerMetrics(peerId, limit),
    getLatestPeerMetric: (peerId) => adapter.getLatestPeerMetric(peerId),
    cleanupOldMetrics:   (days) => adapter.cleanupOldMetrics(days),

    // ---- Users ----
    getUserByUsername: (username) => adapter.getUserByUsername(username),
    getUserById:      (id) => adapter.getUserById(id),
    createUser:       (username, passwordHash, role, authProvider) =>
        adapter.createUser(username, passwordHash, role, authProvider),
    syncUserFromGo:   (id, sync) => adapter.syncUserFromGo(id, sync),
    updateUserPassword: (id, hash) => adapter.updateUserPassword(id, hash),
    updateLastLogin:  (id) => adapter.touchLastLogin(id),
    touchLastLogin:   (id) => adapter.touchLastLogin(id),
    hasUsers:         () => adapter.hasUsers(),
    getAllUsers:       () => adapter.getAllUsers(),
    updateUserRole:   (id, role) => adapter.updateUserRole(id, role),
    updateUserLanguage: (id, lang) => typeof adapter.updateUserLanguage === 'function'
        ? adapter.updateUserLanguage(id, lang)
        : Promise.resolve(),
    deleteUser:       (id) => adapter.deleteUser(id),
    countAdmins:      () => adapter.countAdmins(),
    resetAdminPassword: (hash) => adapter.resetAdminPassword(hash),
    deleteAllUsers:   () => adapter.deleteAllUsers(),

    // ---- TOTP ----
    saveTotpSecret: (userId, secret) => adapter.saveTotpSecret(userId, secret),
    enableTotp:     (userId, codes) => adapter.enableTotp(userId, codes),
    disableTotp:    (userId) => adapter.disableTotp(userId),
    useRecoveryCode: (userId, codes) => adapter.useRecoveryCode(userId, codes),

    // ---- Folders ----
    getAllFolders:    () => adapter.getAllFolders(),
    getFolderById:   (id) => adapter.getFolderById(id),
    createFolder:    (name, color, icon) => adapter.createFolder({ name, color, icon }),
    updateFolder:    (id, updates) => adapter.updateFolder(id, updates),
    deleteFolder:    (id) => adapter.deleteFolder(id),
    assignDeviceToFolder:   (deviceId, folderId) => adapter.assignDeviceToFolder(deviceId, folderId),
    assignDevicesToFolder:  (deviceIds, folderId) => adapter.assignDevicesToFolder(deviceIds, folderId),
    unassignDevicesFromFolder: (folderId) => adapter.unassignDevicesFromFolder(folderId),
    getUnassignedDeviceCount:  () => adapter.getUnassignedDeviceCount(),
    getAllFolderAssignments:   () => adapter.getAllFolderAssignments(),

    // ---- Audit Log ----
    logAction:   (userId, action, details, ip) => adapter.logAction(userId, action, details, ip),
    getAuditLogs: (limit) => adapter.getAuditLogs(limit),

    // ---- Audit: Connections ----
    insertAuditConnection: (data) => adapter.insertAuditConnection(data),
    getAuditConnections:   (filters) => adapter.getAuditConnections(filters),
    countAuditConnections: (filters) => adapter.countAuditConnections(filters),

    // ---- Audit: File Transfers ----
    insertAuditFile:  (data) => adapter.insertAuditFile(data),
    getAuditFiles:    (filters) => adapter.getAuditFiles(filters),
    countAuditFiles:  (filters) => adapter.countAuditFiles(filters),

    // ---- Audit: Security Alarms ----
    insertAuditAlarm: (data) => adapter.insertAuditAlarm(data),
    getAuditAlarms:   (filters) => adapter.getAuditAlarms(filters),
    countAuditAlarms: (filters) => adapter.countAuditAlarms(filters),

    // ---- Access Tokens ----
    createAccessToken: (token, userId, clientId, clientUuid, expiresAt, ipAddress) =>
        adapter.createAccessToken({ token, userId, clientId, clientUuid, expiresAt, ipAddress }),
    getAccessToken:    (token) => adapter.getAccessToken(token),
    touchAccessToken:  (token) => adapter.touchAccessToken(token),
    revokeAccessToken: (token) => adapter.revokeAccessToken(token),
    revokeUserClientTokens: (userId, clientId, clientUuid) =>
        adapter.revokeUserClientTokens(userId, clientUuid),
    revokeAllUserTokens: (userId) => adapter.revokeAllUserTokens(userId),
    cleanupExpiredTokens: () => adapter.cleanupExpiredTokens(),

    // ---- Login Tracking ----
    recordLoginAttempt: (username, ip, success) => adapter.recordLoginAttempt(username, ip, success),
    countRecentFailedAttempts: (username, mins) => adapter.countRecentFailedAttempts(username, mins),
    countRecentFailedAttemptsFromIp: (ip, mins) => adapter.countRecentFailedAttemptsFromIp(ip, mins),
    lockAccount:          (username, until, count) => adapter.lockAccount(username, until, count),
    getAccountLockout:    (username) => adapter.getAccountLockout(username),
    clearAccountLockout:  (username) => adapter.clearAccountLockout(username),
    cleanupOldLoginAttempts: () => adapter.cleanupOldLoginAttempts(),

    // ---- Address Books ----
    getAddressBook:     (userId, abType) => adapter.getAddressBook(userId, abType),
    saveAddressBook:    (userId, data, abType) => adapter.saveAddressBook(userId, abType || 'legacy', data),
    getAddressBookTags: (userId) => adapter.getAddressBookTags(userId),

    // ---- Console Settings ----
    getSetting:    (key, defaultValue) => adapter.getSetting(key).then(v => v ?? defaultValue ?? null),
    setSetting:    (key, value) => adapter.setSetting(key, value),
    getAllSettings: () => adapter.getAllSettings(),

    // ---- Branding Config ----
    getBrandingConfig:        () => adapter.getBrandingConfig(),
    saveBrandingConfigBatch:  (entries) => adapter.saveBrandingConfigBatch(entries),
    resetBrandingConfig:      () => adapter.resetBrandingConfig(),

    // ---- Backup Helpers ----
    getAllUsersForBackup: () => adapter.getAllUsersForBackup(),
    getAllAddressBooks:   () => adapter.getAllAddressBooks(),
    restoreUsers:        (users) => adapter.restoreUsers(users),
    getBackupStats:      () => adapter.getBackupStats(),
    dumpAllTables:       () => adapter.dumpAllTables(),
    importAllTables:     (dump) => adapter.importAllTables(dump),
    getDatabaseFilePath: () => adapter.getDatabaseFilePath(),

    // ---- Pending Registrations ----
    getPendingRegistrations:        (filters) => adapter.getPendingRegistrations(filters),
    getPendingRegistrationById:     (id) => adapter.getPendingRegistrationById(id),
    getPendingRegistrationByDeviceId: (deviceId) => adapter.getPendingRegistrationByDeviceId(deviceId),
    createPendingRegistration:      (data) => adapter.createPendingRegistration(data),
    approvePendingRegistration:     (id, approvedBy, cfg) => adapter.approvePendingRegistration(id, approvedBy, cfg),
    rejectPendingRegistration:      (id, reason) => adapter.rejectPendingRegistration(id, reason),
    deletePendingRegistration:      (id) => adapter.deletePendingRegistration(id),
    getPendingRegistrationCount:    () => adapter.getPendingRegistrationCount(),

    // ---- Agent installer bundles (Generator) ----
    listAgentBundles:           (opts) => adapter.listAgentBundles(opts),
    getAgentBundle:             (bundleId) => adapter.getAgentBundle(bundleId),
    getAgentBundleByPublicId:   (publicId) => adapter.getAgentBundleByPublicId(publicId),
    isAgentBundleSlugTaken:     (slug, excludeBundleId) => adapter.isAgentBundleSlugTaken(slug, excludeBundleId),
    createAgentBundle:          (data) => adapter.createAgentBundle(data),
    updateAgentBundle:          (bundleId, data) => adapter.updateAgentBundle(bundleId, data),
    setAgentBundleRevoked:      (bundleId, revoked) => adapter.setAgentBundleRevoked(bundleId, revoked),
    deleteAgentBundle:          (bundleId) => adapter.deleteAgentBundle(bundleId),
    incrementAgentBundleDownload: (bundleId) => adapter.incrementAgentBundleDownload(bundleId),
    listAgentBundleBuildsForHash: (hash) => adapter.listAgentBundleBuildsForHash(hash),
    getAgentBundleBuild:        (q) => adapter.getAgentBundleBuild(q),
    upsertAgentBundleBuild:     (data) => adapter.upsertAgentBundleBuild(data),

    // ---- User Groups ----
    getAllUserGroups:    () => adapter.getAllUserGroups(),
    getUserGroupByGuid: (guid) => adapter.getUserGroupByGuid(guid),
    createUserGroup:    (data) => adapter.createUserGroup(data),
    updateUserGroup:    (guid, data) => adapter.updateUserGroup(guid, data),
    deleteUserGroup:    (guid) => adapter.deleteUserGroup(guid),
    getUserGroupsForUser: (userId) => adapter.getUserGroupsForUser(userId),
    setUserGroupMemberships: (userId, groupGuids) => adapter.setUserGroupMemberships(userId, groupGuids),

    // ---- Device Groups ----
    getAllDeviceGroups:    () => adapter.getAllDeviceGroups(),
    getDeviceGroupByGuid: (guid) => adapter.getDeviceGroupByGuid(guid),
    createDeviceGroup:    (data) => adapter.createDeviceGroup(data),
    updateDeviceGroup:    (guid, data) => adapter.updateDeviceGroup(guid, data),
    deleteDeviceGroup:    (guid) => adapter.deleteDeviceGroup(guid),
    addDeviceToGroup:     (groupGuid, peerId) => adapter.addDeviceToGroup(groupGuid, peerId),
    removeDeviceFromGroup: (groupGuid, peerId) => adapter.removeDeviceFromGroup(groupGuid, peerId),
    getDeviceGroupMembers: (groupGuid) => adapter.getDeviceGroupMembers(groupGuid),
    getDeviceGroupsForPeer: (peerId) => adapter.getDeviceGroupsForPeer(peerId),
    setDeviceGroupUserAccess: (groupGuid, usernames) => adapter.setDeviceGroupUserAccess(groupGuid, usernames),
    setDeviceGroupUserGroupAccess: (groupGuid, groupGuids) => adapter.setDeviceGroupUserGroupAccess(groupGuid, groupGuids),
    getDeviceGroupAccessForUser: (userId) => adapter.getDeviceGroupAccessForUser(userId),

    // ---- Strategies / Policies ----
    getAllStrategies:  () => adapter.getAllStrategies(),
    getStrategyByGuid: (guid) => adapter.getStrategyByGuid(guid),
    createStrategy:   (data) => adapter.createStrategy(data),
    updateStrategy:   (guid, data) => adapter.updateStrategy(guid, data),
    deleteStrategy:   (guid) => adapter.deleteStrategy(guid),

    // ---- Housekeeping ----
    runIntegrationHousekeeping: () => adapter.runIntegrationHousekeeping(),

    // ---- Close ----
    closeAll: () => adapter.close(),
};

// =========================================================================
//  Legacy getDb / getAuthDb  Only available in SQLite mode
// =========================================================================

if (DB_TYPE === 'sqlite' || DB_TYPE === '') {
    const Database = require('better-sqlite3');
    const path = require('path');
    let _mainDb = null;
    let _authDb = null;

    facade.getDb = function getDb() {
        if (!_mainDb) {
            _mainDb = new Database(config.dbPath, { readonly: false, fileMustExist: false });
            _mainDb.pragma('journal_mode = WAL');
            _mainDb.pragma('foreign_keys = ON');
        }
        return _mainDb;
    };

    facade.getAuthDb = function getAuthDb() {
        if (!_authDb) {
            const authDbPath = path.join(config.dataDir, 'auth.db');
            _authDb = new Database(authDbPath, { readonly: false, fileMustExist: false });
            _authDb.pragma('journal_mode = WAL');
        }
        return _authDb;
    };
} else {
    facade.getDb = function getDb() {
        throw new Error('[DB] getDb() is not available in PostgreSQL mode. Use the adapter methods instead.');
    };
    facade.getAuthDb = function getAuthDb() {
        throw new Error('[DB] getAuthDb() is not available in PostgreSQL mode. Use the adapter methods instead.');
    };
}

module.exports = facade;
