/**
 * BetterDesk RdClient — encrypted credential storage (browser).
 * Passwords are stored in IndexedDB with AES-GCM (Web Crypto); never plaintext in localStorage.
 */
var RdClientSecureStore = (function () {
    'use strict';

    var DB_NAME = 'betterdesk-rdclient';
    var DB_VERSION = 2;
    var STORE = 'vault';
    var KEY_ID = 'device-key';
    var CRED_ID = 'credentials';
    var USERNAME_KEY = 'bd_rdclient_last_user';

    function openDb() {
        return new Promise(function (resolve, reject) {
            if (!window.indexedDB) {
                reject(new Error('IndexedDB unavailable'));
                return;
            }
            var req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onerror = function () { reject(req.error || new Error('IndexedDB open failed')); };
            req.onupgradeneeded = function (ev) {
                var db = ev.target.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE);
                }
            };
            req.onsuccess = function () { resolve(req.result); };
        });
    }

    function idbGet(db, key) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(STORE, 'readonly');
            var req = tx.objectStore(STORE).get(key);
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
    }

    function idbPut(db, key, value) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(STORE, 'readwrite');
            var req = tx.objectStore(STORE).put(value, key);
            req.onsuccess = function () { resolve(); };
            req.onerror = function () { reject(req.error); };
        });
    }

    function idbDelete(db, key) {
        return new Promise(function (resolve, reject) {
            var tx = db.transaction(STORE, 'readwrite');
            var req = tx.objectStore(STORE).delete(key);
            req.onsuccess = function () { resolve(); };
            req.onerror = function () { reject(req.error); };
        });
    }

    function bufToB64(buf) {
        var bytes = new Uint8Array(buf);
        var bin = '';
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }

    function b64ToBuf(b64) {
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
    }

    async function getOrCreateDeviceKey(db) {
        var existing = await idbGet(db, KEY_ID);
        if (existing && existing.key) {
            return crypto.subtle.importKey(
                'raw',
                b64ToBuf(existing.key),
                { name: 'AES-GCM', length: 256 },
                false,
                ['encrypt', 'decrypt']
            );
        }
        var raw = crypto.getRandomValues(new Uint8Array(32));
        await idbPut(db, KEY_ID, { key: bufToB64(raw.buffer) });
        return crypto.subtle.importKey(
            'raw',
            raw,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    async function encryptPassword(key, password) {
        var iv = crypto.getRandomValues(new Uint8Array(12));
        var enc = new TextEncoder().encode(password);
        var cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc);
        return { iv: bufToB64(iv.buffer), data: bufToB64(cipher) };
    }

    async function decryptPassword(key, payload) {
        if (!payload || !payload.iv || !payload.data) return '';
        var iv = new Uint8Array(b64ToBuf(payload.iv));
        var data = b64ToBuf(payload.data);
        var plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, data);
        return new TextDecoder().decode(plain);
    }

    function saveLastUsername(username) {
        try {
            if (username) localStorage.setItem(USERNAME_KEY, username);
            else localStorage.removeItem(USERNAME_KEY);
        } catch (_) { /* quota / private mode */ }
    }

    function loadLastUsername() {
        try {
            return localStorage.getItem(USERNAME_KEY) || '';
        } catch (_) {
            return '';
        }
    }

    async function saveCredentials(username, password, rememberPassword) {
        saveLastUsername(username);
        if (!rememberPassword || !password) {
            await clearStoredPassword();
            return;
        }
        if (!window.crypto || !window.crypto.subtle) return;
        var db = await openDb();
        try {
            var key = await getOrCreateDeviceKey(db);
            var encrypted = await encryptPassword(key, password);
            await idbPut(db, CRED_ID, {
                username: username,
                password: encrypted,
                rememberPassword: true,
                updatedAt: Date.now()
            });
        } finally {
            db.close();
        }
    }

    async function clearStoredPassword() {
        if (!window.indexedDB) return;
        var db = await openDb();
        try {
            await idbDelete(db, CRED_ID);
        } finally {
            db.close();
        }
    }

    async function clearCredentials() {
        saveLastUsername('');
        await clearStoredPassword();
    }

    async function loadCredentials() {
        var username = loadLastUsername();
        var result = { username: username, password: '', rememberPassword: false };
        if (!window.crypto || !window.crypto.subtle || !window.indexedDB) {
            return result;
        }
        var db = await openDb();
        try {
            var record = await idbGet(db, CRED_ID);
            if (!record || !record.rememberPassword || !record.password) {
                return result;
            }
            var key = await getOrCreateDeviceKey(db);
            var password = await decryptPassword(key, record.password);
            result.username = record.username || username;
            result.password = password;
            result.rememberPassword = true;
            return result;
        } catch (_) {
            return result;
        } finally {
            db.close();
        }
    }

    async function hasStoredPassword() {
        if (!window.indexedDB) return false;
        var db = await openDb();
        try {
            var record = await idbGet(db, CRED_ID);
            return !!(record && record.rememberPassword && record.password);
        } catch (_) {
            return false;
        } finally {
            db.close();
        }
    }

    function peerKey(deviceId) {
        return 'peer:' + String(deviceId || '').trim();
    }

    async function savePeerPassword(deviceId, password) {
        if (!deviceId || !password || !window.crypto || !window.crypto.subtle) return;
        var db = await openDb();
        try {
            var key = await getOrCreateDeviceKey(db);
            var encrypted = await encryptPassword(key, password);
            await idbPut(db, peerKey(deviceId), {
                encrypted: encrypted,
                updatedAt: Date.now()
            });
        } finally {
            db.close();
        }
    }

    async function loadPeerPassword(deviceId) {
        if (!deviceId || !window.crypto || !window.crypto.subtle || !window.indexedDB) return '';
        var db = await openDb();
        try {
            var record = await idbGet(db, peerKey(deviceId));
            if (!record || !record.encrypted) return '';
            var key = await getOrCreateDeviceKey(db);
            return await decryptPassword(key, record.encrypted);
        } catch (_) {
            return '';
        } finally {
            db.close();
        }
    }

    async function clearPeerPassword(deviceId) {
        if (!deviceId || !window.indexedDB) return;
        var db = await openDb();
        try {
            await idbDelete(db, peerKey(deviceId));
        } finally {
            db.close();
        }
    }

    async function clearAllPeerPasswords() {
        if (!window.indexedDB) return;
        var db = await openDb();
        try {
            var tx = db.transaction(STORE, 'readwrite');
            var store = tx.objectStore(STORE);
            var req = store.openCursor();
            await new Promise(function (resolve, reject) {
                req.onsuccess = function () {
                    var cursor = req.result;
                    if (!cursor) { resolve(); return; }
                    if (String(cursor.key).indexOf('peer:') === 0) {
                        cursor.delete();
                    }
                    cursor.continue();
                };
                req.onerror = function () { reject(req.error); };
            });
        } finally {
            db.close();
        }
    }

    return {
        saveCredentials: saveCredentials,
        loadCredentials: loadCredentials,
        clearCredentials: clearCredentials,
        clearStoredPassword: clearStoredPassword,
        hasStoredPassword: hasStoredPassword,
        loadLastUsername: loadLastUsername,
        savePeerPassword: savePeerPassword,
        loadPeerPassword: loadPeerPassword,
        clearPeerPassword: clearPeerPassword,
        clearAllPeerPasswords: clearAllPeerPasswords
    };
})();

if (typeof window !== 'undefined') {
    window.RdClientSecureStore = RdClientSecureStore;
}
