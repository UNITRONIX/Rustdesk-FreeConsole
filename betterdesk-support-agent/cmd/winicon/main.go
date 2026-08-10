// Command winicon creates a Windows ICO resource from a Support Agent branding
// profile. It intentionally accepts PNG/JPEG logos only: unsupported artwork
// falls back to a recognizable BetterDesk-blue icon instead of producing an
// unbranded Windows executable.
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"strings"

	"github.com/fyne-io/image/ico"
)

type branding struct {
	LogoDataURL  string `json:"logo_data_url"`
	PrimaryColor string `json:"primary_color"`
}

func main() {
	in := flag.String("branding", "", "branding JSON path")
	out := flag.String("out", "", "output ICO path")
	flag.Parse()
	if *in == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "usage: winicon -branding branding.json -out app.ico")
		os.Exit(2)
	}

	raw, err := os.ReadFile(*in)
	if err != nil {
		fail(err)
	}
	var b branding
	if err := json.Unmarshal(raw, &b); err != nil {
		fail(err)
	}

	img := decodeLogo(b.LogoDataURL)
	if img == nil {
		img = fallbackIcon(b.PrimaryColor)
	}
	var buf bytes.Buffer
	if err := ico.Encode(&buf, img); err != nil {
		fail(err)
	}
	if err := os.WriteFile(*out, buf.Bytes(), 0o644); err != nil {
		fail(err)
	}
}

func decodeLogo(dataURL string) image.Image {
	parts := strings.SplitN(dataURL, ",", 2)
	if len(parts) != 2 || !strings.Contains(parts[0], ";base64") {
		return nil
	}
	data, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return nil
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil
	}
	return img
}

func fallbackIcon(primary string) image.Image {
	c := color.RGBA{R: 37, G: 99, B: 235, A: 255}
	if parsed, ok := parseHex(primary); ok {
		c = parsed
	}
	img := image.NewRGBA(image.Rect(0, 0, 256, 256))
	draw.Draw(img, img.Bounds(), &image.Uniform{C: c}, image.Point{}, draw.Src)
	// A minimal white “B” mark remains identifiable at notification-area size.
	white := color.RGBA{255, 255, 255, 255}
	for _, r := range []image.Rectangle{
		image.Rect(70, 52, 94, 204),
		image.Rect(94, 52, 170, 76),
		image.Rect(94, 116, 170, 140),
		image.Rect(94, 180, 170, 204),
		image.Rect(154, 68, 178, 124),
		image.Rect(154, 132, 178, 188),
	} {
		draw.Draw(img, r, &image.Uniform{C: white}, image.Point{}, draw.Src)
	}
	return img
}

func parseHex(value string) (color.RGBA, bool) {
	value = strings.TrimPrefix(strings.TrimSpace(value), "#")
	if len(value) != 6 {
		return color.RGBA{}, false
	}
	var r, g, b uint8
	if _, err := fmt.Sscanf(value, "%02x%02x%02x", &r, &g, &b); err != nil {
		return color.RGBA{}, false
	}
	return color.RGBA{R: r, G: g, B: b, A: 255}, true
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "winicon:", err)
	os.Exit(1)
}
