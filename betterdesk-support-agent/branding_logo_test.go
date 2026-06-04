package main

import (
	"encoding/base64"
	"testing"
)

func TestLogoPNGBytesSkipsSVG(t *testing.T) {
	svg := "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`))
	b := Branding{LogoDataURL: svg}.normalize()
	if b.LogoPNGBytes() != nil {
		t.Fatal("expected SVG logo to be skipped for Fyne")
	}
}

func TestLogoPNGBytesAcceptsPNG(t *testing.T) {
	// 1×1 red PNG
	raw, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
	b := Branding{LogoDataURL: "data:image/png;base64," + base64.StdEncoding.EncodeToString(raw)}
	png := b.LogoPNGBytes()
	if len(png) == 0 {
		t.Fatal("expected PNG logo bytes")
	}
	if b.LogoResource() == nil {
		t.Fatal("expected LogoResource")
	}
}
