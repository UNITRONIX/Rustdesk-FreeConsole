//go:build !fyneui

package main

import (
	"bytes"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	"sync"

	"fyne.io/systray"
	"github.com/fyne-io/image/ico"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

var supportTrayQuitOnce sync.Once

// startTray restores the background-agent behavior that the legacy Fyne shell
// exposed. Wails owns the main window; systray only requests Wails actions from
// its menu callbacks.
func (s *AppService) startTray() {
	if s.ctx == nil {
		return
	}
	s.trayOnce.Do(func() {
		go systray.Run(func() {
			systray.SetTooltip(s.brand.ProductName)
			if icon := trayIconBytes(s.brand); len(icon) > 0 {
				systray.SetIcon(icon)
			}

			show := systray.AddMenuItem(s.brand.ProductName, t("window_title"))
			help := systray.AddMenuItem(t("request_help"), t("request_help"))
			systray.AddSeparator()
			quit := systray.AddMenuItem(t("quit"), t("quit"))

			go func() {
				for range show.ClickedCh {
					runtime.WindowUnminimise(s.ctx)
					runtime.WindowShow(s.ctx)
				}
			}()
			go func() {
				for range help.ClickedCh {
					runtime.WindowUnminimise(s.ctx)
					runtime.WindowShow(s.ctx)
					s.emit("open-help", nil)
				}
			}()
			go func() {
				for range quit.ClickedCh {
					s.Quit()
				}
			}()
		}, func() {})
	})
}

func (s *AppService) stopTray() {
	supportTrayQuitOnce.Do(systray.Quit)
}

func trayIconBytes(brand Branding) []byte {
	raw := brand.LogoBytes()
	if len(raw) == 0 {
		return nil
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil
	}
	var buf bytes.Buffer
	if err := ico.Encode(&buf, img); err != nil {
		return nil
	}
	return buf.Bytes()
}
