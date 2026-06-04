package main

import (
	"bytes"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"

	"fyne.io/fyne/v2"
)

// LogoPNGBytes returns branding logo bytes encoded as PNG for Fyne widgets and
// the system tray. SVG/WebP and other formats are skipped (Fyne cannot load them
// as raw StaticResource payloads).
func (b Branding) LogoPNGBytes() []byte {
	raw := b.LogoBytes()
	if len(raw) == 0 {
		return nil
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil
	}
	return buf.Bytes()
}

func (b Branding) LogoResource() fyne.Resource {
	if data := b.LogoPNGBytes(); isPNG(data) {
		return fyne.NewStaticResource("logo.png", data)
	}
	return nil
}

func isPNG(data []byte) bool {
	return len(data) >= 8 && data[0] == 0x89 && data[1] == 'P' && data[2] == 'N' && data[3] == 'G'
}
