//go:build fyneui

package main

import (
	"image/color"

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
func (t *brandedTheme) Size(name fyne.ThemeSizeName) float32       { return t.base.Size(name) }
