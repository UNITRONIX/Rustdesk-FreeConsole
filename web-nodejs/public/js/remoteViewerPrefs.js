/**
 * Remote viewer preferences (localStorage, per operator account).
 * Logic mirrored in web-nodejs/lib/remoteViewerPrefs.js for unit tests.
 */
(function (global) {
    'use strict';

    var BACKGROUND_FPS = 1;
    var QUALITY_TO_PRESET = { Best: 'best', Balanced: 'balanced', Low: 'speed' };
    var PRESET_FPS = { best: 60, balanced: 30, quality: 30, speed: 60 };
    var DEFAULTS = {
        quality: 'Best',
        scale: 'fit',
        codec: 'Auto',
        adaptiveQuality: true,
        backgroundFps: BACKGROUND_FPS,
    };

    function sanitizePrefs(raw) {
        var source = raw && typeof raw === 'object' ? raw : {};
        var clean = Object.assign({}, DEFAULTS);
        if (['Best', 'Balanced', 'Low'].indexOf(source.quality) >= 0) clean.quality = source.quality;
        if (['fit', 'fill', '1:1', 'stretch'].indexOf(source.scale) >= 0) clean.scale = source.scale;
        if (typeof source.codec === 'string' && source.codec.length <= 16) clean.codec = source.codec;
        if (typeof source.adaptiveQuality === 'boolean') clean.adaptiveQuality = source.adaptiveQuality;
        var bg = Number(source.backgroundFps);
        if (Number.isFinite(bg) && bg >= 1 && bg <= 5) clean.backgroundFps = Math.round(bg);
        return clean;
    }

    function storageKey(userId) {
        var id = userId != null ? String(userId) : 'anonymous';
        return 'betterdesk_remote_prefs_' + id;
    }

    function loadRemoteViewerPrefs(userId) {
        try {
            var raw = localStorage.getItem(storageKey(userId));
            if (!raw) return Object.assign({}, DEFAULTS);
            return sanitizePrefs(JSON.parse(raw));
        } catch (_) {
            return Object.assign({}, DEFAULTS);
        }
    }

    var _saveTimer = null;
    function saveRemoteViewerPrefs(userId, prefs) {
        var clean = sanitizePrefs(prefs);
        clearTimeout(_saveTimer);
        _saveTimer = setTimeout(function () {
            try {
                localStorage.setItem(storageKey(userId), JSON.stringify(clean));
            } catch (_) { /* localStorage disabled */ }
        }, 400);
        return clean;
    }

    function getPresetForQuality(quality) {
        return QUALITY_TO_PRESET[quality] || 'balanced';
    }

    function getActiveFpsForQuality(quality) {
        return PRESET_FPS[getPresetForQuality(quality)] || 30;
    }

    global.RemoteViewerPrefs = {
        BACKGROUND_FPS: BACKGROUND_FPS,
        DEFAULTS: DEFAULTS,
        sanitizePrefs: sanitizePrefs,
        loadRemoteViewerPrefs: loadRemoteViewerPrefs,
        saveRemoteViewerPrefs: saveRemoteViewerPrefs,
        getPresetForQuality: getPresetForQuality,
        getActiveFpsForQuality: getActiveFpsForQuality,
    };
})(typeof window !== 'undefined' ? window : globalThis);
