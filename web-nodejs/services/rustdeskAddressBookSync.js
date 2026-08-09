/**
 * RustDesk address book sync helpers.
 *
 * The web panel stores device tags and folders separately. RustDesk address
 * books only own explicit peer tags; BetterDesk folders are exposed through the
 * RustDesk device-group API. Folder names must not be used to infer or remove
 * address book tags because users can intentionally use the same label for both.
 */

'use strict';

const MAX_TAG_LENGTH = 50;

function sanitizeTag(value) {
    if (typeof value !== 'string') return '';
    return value
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
        .trim()
        .slice(0, MAX_TAG_LENGTH);
}

function uniquePush(list, seen, value) {
    const tag = sanitizeTag(value);
    if (!tag || seen.has(tag)) return;
    seen.add(tag);
    list.push(tag);
}

function normalizeTags(value) {
    if (!value) return [];

    let raw = value;
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!trimmed) return [];
        if (trimmed.startsWith('[')) {
            try {
                raw = JSON.parse(trimmed);
            } catch (_) {
                raw = trimmed.split(',');
            }
        } else {
            raw = trimmed.split(',');
        }
    }

    if (!Array.isArray(raw)) return [];

    const tags = [];
    const seen = new Set();
    for (const item of raw) {
        uniquePush(tags, seen, String(item || ''));
    }
    return tags;
}

function filterFolderTags(tags) {
    return normalizeTags(tags);
}

function parseAddressBookData(data) {
    let parsed = {};

    if (data && typeof data === 'object' && !Buffer.isBuffer(data)) {
        parsed = { ...data };
    } else if (typeof data === 'string' && data.trim()) {
        try {
            parsed = JSON.parse(data);
        } catch (_) {
            parsed = {};
        }
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        parsed = {};
    }

    parsed.peers = Array.isArray(parsed.peers) ? parsed.peers : [];
    parsed.tags = normalizeTags(parsed.tags);

    return parsed;
}

function getDeviceTags(device) {
    return normalizeTags(device && device.tags);
}

function mergePeerFields(existing, device, tags) {
    const peer = existing && typeof existing === 'object' && !Array.isArray(existing)
        ? existing
        : {};

    peer.id = String(peer.id || device.id || '');
    const displayName = String(device.display_name || '').trim();
    const deviceNote = String(device.note || '').trim();
    const panelAlias = displayName || deviceNote;

    // Panel display name is the managed RustDesk card title (alias). Note fills
    // alias only when the peer has no alias yet. Stale AB cards often keep the
    // label in note with empty alias — promote that too. Never fall back to
    // hostname (secondary line on stock RustDesk).
    const existingAlias = String(peer.alias || '').trim();
    const existingNote = String(peer.note || '').trim();
    if (displayName) {
        peer.alias = displayName;
    } else if (!existingAlias && deviceNote) {
        peer.alias = deviceNote;
    } else if (!existingAlias && existingNote) {
        peer.alias = existingNote;
    }

    const titleAlias = String(peer.alias || '').trim();
    const managedTitle = Boolean(panelAlias) ||
        (!existingAlias && existingNote && titleAlias === existingNote);
    if (managedTitle && titleAlias) {
        peer.hostname = '';
        peer.username = '';
        if (String(peer.note || '').trim() === titleAlias) {
            peer.note = '';
        }
    } else {
        if (!peer.username && (device.username || device.user)) {
            peer.username = String(device.username || device.user);
        }
        if (!peer.hostname && device.hostname) {
            peer.hostname = String(device.hostname);
        }
    }

    if (!peer.platform && (device.platform || device.os)) {
        peer.platform = String(device.platform || device.os);
    }
    peer.tags = tags;

    return peer;
}

function mergeAddressBookData(data, options = {}) {
    const ab = parseAddressBookData(data);
    const devices = Array.isArray(options.devices) ? options.devices : [];
    const includeDevices = options.includeDevices !== false;

    // Issue #138: build set of banned/deleted device IDs to strip from AB
    const bannedIds = new Set();
    for (const device of devices) {
        const id = String(device && device.id || '').trim();
        if (!id) continue;
        if (device.banned || device.soft_deleted) {
            bannedIds.add(id);
        }
    }

    ab.tags = normalizeTags(ab.tags);
    const globalSeen = new Set(ab.tags);

    const peerById = new Map();
    // Filter out banned/deleted peers from existing AB data
    ab.peers = ab.peers.filter(peer => {
        if (!peer || typeof peer !== 'object') return false;
        const id = String(peer.id || '').trim();
        if (!id) return false;
        if (bannedIds.has(id)) return false; // strip banned
        return true;
    });
    for (const peer of ab.peers) {
        const id = String(peer.id || '').trim();
        peer.tags = normalizeTags(peer.tags);
        peerById.set(id, peer);
        for (const tag of peer.tags) {
            uniquePush(ab.tags, globalSeen, tag);
        }
    }

    for (const device of devices) {
        const id = String(device && device.id || '').trim();
        if (!id) continue;

        const existing = peerById.get(id);
        if (!existing && !includeDevices) continue;

        const mergedTags = normalizeTags(existing && existing.tags);
        const tagSeen = new Set(mergedTags);
        for (const tag of getDeviceTags(device)) {
            uniquePush(mergedTags, tagSeen, tag);
            uniquePush(ab.tags, globalSeen, tag);
        }

        const peer = mergePeerFields(existing, device, mergedTags);
        if (!existing) {
            ab.peers.push(peer);
            peerById.set(id, peer);
        }
    }

    return JSON.stringify(ab);
}

function collectVisibleTags(devices, folders, assignments) {
    const tags = [];
    const seen = new Set();

    for (const device of Array.isArray(devices) ? devices : []) {
        for (const tag of getDeviceTags(device)) {
            uniquePush(tags, seen, tag);
        }
    }

    return tags.sort((a, b) => a.localeCompare(b));
}

function collectPeerTagUpdates(data, options = {}) {
    const ab = parseAddressBookData(data);
    const updates = [];
    const seen = new Set();

    for (const peer of ab.peers) {
        if (!peer || typeof peer !== 'object') continue;
        const id = String(peer.id || '').trim();
        if (!id || seen.has(id)) continue;
        if (!Object.prototype.hasOwnProperty.call(peer, 'tags')) continue;
        seen.add(id);
        updates.push({ id, tags: normalizeTags(peer.tags) });
    }

    return updates;
}

/**
 * Strip peers outside the caller's device-group ACL.
 * When visibleIds is null/undefined, no filtering is applied (unrestricted / admin).
 * When knownDeviceIds is non-empty, user-typed remote IDs (not in inventory) are kept.
 * When knownDeviceIds is empty under a non-null visible set, allowlist-only: keep iff
 * visible — otherwise an empty inventory would fail open and re-expose a saved fleet.
 */
function filterAddressBookPeersByScope(data, options = {}) {
    const ab = parseAddressBookData(data);
    const visibleIds = options.visibleIds;
    if (!visibleIds) {
        return JSON.stringify(ab);
    }
    const known = new Set(
        (Array.isArray(options.knownDeviceIds) ? options.knownDeviceIds : [])
            .map(id => String(id || '').trim())
            .filter(Boolean)
    );
    const inventoryLoaded = known.size > 0;
    ab.peers = ab.peers.filter(peer => {
        if (!peer || typeof peer !== 'object') return false;
        const id = String(peer.id || '').trim();
        if (!id) return false;
        if (visibleIds.has(id)) return true;
        if (inventoryLoaded && !known.has(id)) return true;
        return false;
    });
    return JSON.stringify(ab);
}

module.exports = {
    normalizeTags,
    parseAddressBookData,
    filterFolderTags,
    mergeAddressBookData,
    filterAddressBookPeersByScope,
    collectVisibleTags,
    collectPeerTagUpdates
};
