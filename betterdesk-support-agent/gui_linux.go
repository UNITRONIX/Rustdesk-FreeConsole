//go:build linux

package main

import (
	"log"
	"os"
)

func prepWindowsGraphics() {}

// prepLinuxDisplay logs the detected session; binary choice is handled by the launcher script.
func prepLinuxDisplay() {
	switch {
	case os.Getenv("BETTERDESK_UI_BACKEND") == "wayland":
		log.Printf("[support-agent] UI backend: wayland (forced)")
	case os.Getenv("BETTERDESK_UI_BACKEND") == "x11":
		log.Printf("[support-agent] UI backend: x11 (forced)")
	case os.Getenv("WAYLAND_DISPLAY") != "" && os.Getenv("DISPLAY") == "":
		log.Printf("[support-agent] UI backend: wayland (WAYLAND_DISPLAY=%s)", os.Getenv("WAYLAND_DISPLAY"))
	default:
		if d := os.Getenv("DISPLAY"); d != "" {
			log.Printf("[support-agent] UI backend: x11 (DISPLAY=%s)", d)
		}
	}
}
