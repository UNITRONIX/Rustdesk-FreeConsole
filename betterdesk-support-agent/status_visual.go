package main

import (
	"image/color"
	"strings"
)

type statusKind int

const (
	statusKindReady statusKind = iota
	statusKindPending
	statusKindConnected
	statusKindError
)

func shortenStatusText(s string, maxRunes int) string {
	s = strings.TrimSpace(s)
	if maxRunes <= 0 {
		return s
	}
	r := []rune(s)
	if len(r) <= maxRunes {
		return s
	}
	return string(r[:maxRunes-1]) + "…"
}

func statusColor(kind statusKind, b Branding) color.Color {
	switch kind {
	case statusKindConnected, statusKindReady:
		return parseHexColor(b.StatusReadyColor, color.RGBA{R: 0x22, G: 0xc5, B: 0x5e, A: 0xff})
	case statusKindPending:
		return color.RGBA{R: 0xf5, G: 0x9e, B: 0x0b, A: 0xff}
	case statusKindError:
		return color.RGBA{R: 0xef, G: 0x44, B: 0x44, A: 0xff}
	default:
		return parseHexColor(b.StatusReadyColor, color.RGBA{R: 0x22, G: 0xc5, B: 0x5e, A: 0xff})
	}
}

func (u *ui) applyStatus(kind statusKind, text string) {
	text = shortenStatusText(text, 160)
	if u.statusLbl != nil {
		u.statusLbl.SetText(text)
	}
	if u.statusDot != nil {
		u.statusDot.FillColor = statusColor(kind, u.brand)
		u.statusDot.Refresh()
	}
}
