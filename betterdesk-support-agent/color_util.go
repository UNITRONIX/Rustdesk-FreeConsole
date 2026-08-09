package main

import (
	"image/color"
	"strconv"
	"strings"
)

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
		a, err := strconv.ParseUint(s[6:8], 16, 8)
		if err == nil {
			out.A = uint8(a)
		}
	}
	return out
}

func mustRGBA(hex string) color.RGBA {
	return parseHexColor(hex, color.RGBA{R: 0x25, G: 0x63, B: 0xeb, A: 0xff})
}
