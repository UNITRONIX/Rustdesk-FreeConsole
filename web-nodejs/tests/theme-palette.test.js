/**
 * Theme palette resolution for UX 3.5 light/dark/custom
 */
const {
    resolveThemeColors,
    normalizeThemeMode,
    hexToMutedRgba,
    BUILTIN_THEME_PALETTES
} = require('../services/brandingService');

describe('UX 3.5 theme palettes', () => {
    test('normalizeThemeMode maps auto → dark and rejects junk', () => {
        expect(normalizeThemeMode('auto')).toBe('dark');
        expect(normalizeThemeMode('light')).toBe('light');
        expect(normalizeThemeMode('custom')).toBe('custom');
        expect(normalizeThemeMode('nope')).toBe('dark');
    });

    test('light mode ignores stale dark DB colors', () => {
        const colors = resolveThemeColors({
            themeMode: 'light',
            colors: {
                bgPrimary: '#0d1117',
                textPrimary: '#e6edf3'
            }
        });
        expect(colors.bgPrimary).toBe(BUILTIN_THEME_PALETTES.light.bgPrimary);
        expect(colors.textPrimary).toBe(BUILTIN_THEME_PALETTES.light.textPrimary);
        expect(colors.accentBlue).toBe('#0969da');
    });

    test('dark mode uses built-in dark palette', () => {
        const colors = resolveThemeColors({ themeMode: 'dark', colors: {} });
        expect(colors.bgPrimary).toBe('#0d1117');
        expect(colors.textPrimary).toBe('#e6edf3');
    });

    test('custom mode keeps operator colors over dark defaults', () => {
        const colors = resolveThemeColors({
            themeMode: 'custom',
            colors: { bgPrimary: '#112233', textPrimary: '#abcdef' }
        });
        expect(colors.bgPrimary).toBe('#112233');
        expect(colors.textPrimary).toBe('#abcdef');
        expect(colors.bgSecondary).toBe(BUILTIN_THEME_PALETTES.dark.bgSecondary);
    });
});

describe('hexToMutedRgba', () => {
    test('converts solid accent hex to translucent rgba (branding.css + theme preview)', () => {
        expect(hexToMutedRgba('#58a6ff')).toBe('rgba(88, 166, 255, 0.15)');
        expect(hexToMutedRgba('#0969da')).toBe('rgba(9, 105, 218, 0.15)');
        expect(hexToMutedRgba('58a6ff')).toBe('rgba(88, 166, 255, 0.15)');
    });

    test('accepts custom alpha and rejects invalid hex', () => {
        expect(hexToMutedRgba('#58a6ff', 0.1)).toBe('rgba(88, 166, 255, 0.1)');
        expect(hexToMutedRgba('#fff')).toBeNull();
        expect(hexToMutedRgba('not-a-color')).toBeNull();
        expect(hexToMutedRgba(null)).toBeNull();
    });

    test('built-in muted palette keys convert without staying solid', () => {
        const darkMuted = hexToMutedRgba(BUILTIN_THEME_PALETTES.dark.accentBlueMuted);
        const lightMuted = hexToMutedRgba(BUILTIN_THEME_PALETTES.light.accentBlueMuted);
        expect(darkMuted).toMatch(/^rgba\(/);
        expect(lightMuted).toMatch(/^rgba\(/);
        expect(darkMuted).not.toBe(BUILTIN_THEME_PALETTES.dark.accentBlueMuted);
        expect(lightMuted).not.toBe(BUILTIN_THEME_PALETTES.light.accentBlueMuted);
    });
});
