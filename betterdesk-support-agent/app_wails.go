//go:build !fyneui

package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/ui
var frontendAssets embed.FS

func run() {
	svc, err := newAppService()
	if err != nil {
		log.Fatalf("[support-agent] state: %v", err)
	}

	err = wails.Run(&options.App{
		Title:     svc.brand.ProductName,
		Width:     480,
		Height:    720,
		MinWidth:  420,
		MinHeight: 640,
		MaxWidth:  560,
		MaxHeight: 900,
		AssetServer: &assetserver.Options{
			Assets: frontendAssets,
		},
		BackgroundColour: &options.RGBA{R: 15, G: 23, B: 42, A: 255},
		OnStartup:        svc.startup,
		OnShutdown:       svc.shutdown,
		// The agent continues to receive supervised-session requests after its
		// window is closed. Keep it available through the Windows notification
		// area instead of terminating the remote-access engine.
		HideWindowOnClose: true,
		Bind:              []interface{}{svc},
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
			DisableWindowIcon:    false,
		},
	})
	if err != nil {
		log.Fatalf("[support-agent] wails: %v", err)
	}
}
