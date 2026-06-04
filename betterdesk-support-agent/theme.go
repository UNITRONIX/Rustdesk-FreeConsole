package main

import (
	"image/color"
	"strconv"
	"strings"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/theme"
)

type brandedTheme struct {
	primary    color.Color
	accent     color.Color
	background color.Color
	surface    color.Color
	text       color.Color
	textMuted  color.Color
	base       fyne.Theme
}

func newBrandedTheme(b Branding) fyne.Theme {
	d := brandingDefaults()
	return &brandedTheme{
		primary:    parseHexColor(b.PrimaryColor, mustRGBA(d.PrimaryColor)),
		accent:     parseHexColor(b.AccentColor, mustRGBA(d.AccentColor)),
		background: parseHexColor(b.BackgroundColor, mustRGBA(d.BackgroundColor)),
		surface:    parseHexColor(b.SurfaceColor, mustRGBA(d.SurfaceColor)),
		text:       parseHexColor(b.TextColor, mustRGBA(d.TextColor)),
		textMuted:  parseHexColor(b.TextMutedColor, mustRGBA(d.TextMutedColor)),
		base:       theme.DefaultTheme(),
	}
}

func mustRGBA(hex string) color.RGBA {
	return parseHexColor(hex, color.RGBA{R: 0x25, G: 0x63, B: 0xeb, A: 0xff})
}

func (t *brandedTheme) Color(name fyne.ThemeColorName, variant fyne.ThemeVariant) color.Color {
	switch name {
	case theme.ColorNamePrimary, theme.ColorNameHyperlink, theme.ColorNameFocus:
		return t.primary
	case theme.ColorNameSelection:
		return t.accent
	case theme.ColorNameBackground:
		return t.background
	case theme.ColorNameInputBackground:
		return t.surface
	case theme.ColorNameForeground:
		return t.text
	case theme.ColorNameDisabled:
		return t.textMuted
	}
	return t.base.Color(name, variant)
}

func (t *brandedTheme) Font(style fyne.TextStyle) fyne.Resource { return t.base.Font(style) }
func (t *brandedTheme) Icon(name fyne.ThemeIconName) fyne.Resource { return t.base.Icon(name) }
func (t *brandedTheme) Size(name fyne.ThemeSizeName) float32     { return t.base.Size(name) }

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
	out := color.RGBA{
		R: uint8(val >> 16),
		G: uint8(val >> 8),
		B: uint8(val),
		A: 0xff,
	}
	if len(s) == 8 {
		out.A = uint8(val >> 24)
	}
	return out
}
