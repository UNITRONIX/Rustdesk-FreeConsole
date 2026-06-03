package main

import (
	"image/color"
	"strconv"
	"strings"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/theme"
)

// brandedTheme overrides the default Fyne theme with the deployment's brand
// colours so the support agent matches the appearance configured in the
// Console generator.
type brandedTheme struct {
	primary color.Color
	accent  color.Color
	base    fyne.Theme
}

// newBrandedTheme builds a theme from the branding primary/accent colours.
func newBrandedTheme(b Branding) fyne.Theme {
	return &brandedTheme{
		primary: parseHexColor(b.PrimaryColor, color.RGBA{R: 0x25, G: 0x63, B: 0xeb, A: 0xff}),
		accent:  parseHexColor(b.AccentColor, color.RGBA{R: 0x0e, G: 0xa5, B: 0xe9, A: 0xff}),
		base:    theme.DefaultTheme(),
	}
}

func (t *brandedTheme) Color(name fyne.ThemeColorName, variant fyne.ThemeVariant) color.Color {
	switch name {
	case theme.ColorNamePrimary, theme.ColorNameHyperlink, theme.ColorNameFocus:
		return t.primary
	case theme.ColorNameSelection:
		return t.accent
	}
	return t.base.Color(name, variant)
}

func (t *brandedTheme) Font(style fyne.TextStyle) fyne.Resource { return t.base.Font(style) }

func (t *brandedTheme) Icon(name fyne.ThemeIconName) fyne.Resource { return t.base.Icon(name) }

func (t *brandedTheme) Size(name fyne.ThemeSizeName) float32 { return t.base.Size(name) }

// parseHexColor parses #RGB / #RRGGBB / #RRGGBBAA strings, returning fallback on
// any parse error.
func parseHexColor(s string, fallback color.RGBA) color.RGBA {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "#")
	switch len(s) {
	case 3:
		s = string([]byte{s[0], s[0], s[1], s[1], s[2], s[2]})
	case 6, 8:
	default:
		return fallback
	}
	val, err := strconv.ParseUint(s[:6], 16, 32)
	if err != nil {
		return fallback
	}
	c := color.RGBA{
		R: uint8(val >> 16),
		G: uint8(val >> 8),
		B: uint8(val),
		A: 0xff,
	}
	if len(s) == 8 {
		if a, err := strconv.ParseUint(s[6:8], 16, 32); err == nil {
			c.A = uint8(a)
		}
	}
	return c
}
