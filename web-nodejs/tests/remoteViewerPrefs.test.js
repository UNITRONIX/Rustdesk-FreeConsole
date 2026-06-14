'use strict';

const {
    BACKGROUND_FPS,
    sanitizePrefs,
    getActiveFpsForQuality,
    getPresetForQuality,
    loadRemoteViewerPrefs,
    saveRemoteViewerPrefs,
} = require('../lib/remoteViewerPrefs');

describe('remoteViewerPrefs', () => {
    it('defaults Best quality to 60fps preset', () => {
        expect(getPresetForQuality('Best')).toBe('best');
        expect(getActiveFpsForQuality('Best')).toBe(60);
    });

    it('sanitizes unknown values', () => {
        const clean = sanitizePrefs({ quality: 'Invalid', scale: 'fit', codec: 'Auto' });
        expect(clean.quality).toBe('Best');
        expect(clean.scale).toBe('fit');
        expect(clean.backgroundFps).toBe(BACKGROUND_FPS);
    });

    it('persists via in-memory storage', () => {
        const storage = new Map();
        const store = {
            getItem: (k) => storage.get(k) || null,
            setItem: (k, v) => storage.set(k, v),
        };
        saveRemoteViewerPrefs(7, { quality: 'Balanced', scale: '1:1' }, store);
        const loaded = loadRemoteViewerPrefs(7, store);
        expect(loaded.quality).toBe('Balanced');
        expect(loaded.scale).toBe('1:1');
        expect(getActiveFpsForQuality(loaded.quality)).toBe(30);
    });
});
