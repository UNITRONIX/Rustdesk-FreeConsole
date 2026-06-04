package main

import (
	"bytes"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"runtime"

	"fyne.io/fyne/v2"
	"github.com/fyne-io/image/ico"
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

// TrayIconResource returns a platform-appropriate tray icon (ICO on Windows).
func (b Branding) TrayIconResource() fyne.Resource {
	raw := b.LogoBytes()
	if len(raw) == 0 {
		return nil
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil
	}
	var buf bytes.Buffer
	if runtime.GOOS == "windows" {
		if err := ico.Encode(&buf, img); err != nil {
			return nil
		}
		return fyne.NewStaticResource("logo.ico", buf.Bytes())
	}
	if err := png.Encode(&buf, img); err != nil {
		return nil
	}
	return fyne.NewStaticResource("logo.png", buf.Bytes())
}

func isPNG(data []byte) bool {
	return len(data) >= 8 && data[0] == 0x89 && data[1] == 'P' && data[2] == 'N' && data[3] == 'G'
}
