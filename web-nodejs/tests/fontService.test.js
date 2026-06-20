/**
 * BetterDesk Console - Font Service Tests
 */

'use strict';

const fontService = require('../services/fontService');

describe('fontService security helpers', () => {
    it('escapes CSS string metacharacters in font families', () => {
        const escaped = fontService.escapeCssString("Bad');}\nbody{color:red}\\Font");

        expect(escaped).toContain("\\'");
        expect(escaped).toContain('\\a ');
        expect(escaped).toContain('\\\\');
        expect(escaped).not.toContain('\n');
    });

    it('uses escaped font families in generated branding CSS', () => {
        const css = fontService.generateFontCss("Heading');}\nbody{color:red}", "Body\\Font");

        expect(css).toContain("--font-heading: 'Heading\\');}\\a body{color:red}'");
        expect(css).toContain("--font-family: 'Body\\\\Font'");
        expect(css).not.toContain('\nbody{color:red}');
    });
});
