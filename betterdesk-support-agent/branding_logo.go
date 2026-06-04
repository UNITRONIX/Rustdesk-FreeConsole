package main

import (
	"bytes"
	stdpng "encoding/png"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"

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
	if err := stdpng.Encode(&buf, img); err != nil {
		return nil
	}
	return buf.Bytes()
}

func (b Branding) LogoResource() fyne.Resource {
	if data := b.LogoPNGBytes(); len(data) > 0 {
		return fyne.NewStaticResource("logo.png", data)
	}
	return nil
}
