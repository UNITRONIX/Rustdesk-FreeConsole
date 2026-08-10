package main

import (
	"image/color"
	"testing"
)

func TestFallbackIconUsesBrandPrimaryColor(t *testing.T) {
	img := fallbackIcon("#123456")
	got := color.RGBAModel.Convert(img.At(10, 10)).(color.RGBA)
	if got != (color.RGBA{R: 0x12, G: 0x34, B: 0x56, A: 0xff}) {
		t.Fatalf("fallback colour = %#v", got)
	}
}

func TestParseHexRejectsInvalidBrandColor(t *testing.T) {
	if _, ok := parseHex("not-a-colour"); ok {
		t.Fatal("invalid colour accepted")
	}
}
