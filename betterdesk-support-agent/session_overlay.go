//go:build fyneui

package main

import (
	"sync"
	"time"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/widget"
)

// sessionOverlay shows an always-on-top bar during remote sessions.
type sessionOverlay struct {
	win          fyne.Window
	label        *widget.Label
	operator     string
	start        time.Time
	ticker       *time.Ticker
	mu           sync.Mutex
	onDisconnect func()
}

func newSessionOverlay(app fyne.App, productName string, onDisconnect func()) *sessionOverlay {
	o := &sessionOverlay{start: time.Now(), onDisconnect: onDisconnect}
	o.win = app.NewWindow(productName + " — " + t("session_active"))
	o.win.SetFixedSize(true)
	o.label = widget.NewLabel("")
	disconnect := widget.NewButton(t("session_disconnect"), func() {
		o.requestDisconnect()
		o.hide()
	})
	o.win.SetContent(container.NewVBox(o.label, disconnect))
	o.win.SetCloseIntercept(func() { o.win.Hide() })
	return o
}

func (o *sessionOverlay) requestDisconnect() {
	if o.onDisconnect != nil {
		o.onDisconnect()
	}
}

func (o *sessionOverlay) show(operator, mode string) {
	o.mu.Lock()
	o.operator = operator
	o.start = time.Now()
	o.mu.Unlock()

	o.updateLabel(mode)
	if o.ticker != nil {
		o.ticker.Stop()
	}
	o.ticker = time.NewTicker(time.Second)
	go func() {
		for range o.ticker.C {
			o.updateLabel(mode)
		}
	}()
	o.win.Show()
}

func (o *sessionOverlay) hide() {
	if o.ticker != nil {
		o.ticker.Stop()
		o.ticker = nil
	}
	o.win.Hide()
}

func (o *sessionOverlay) updateLabel(mode string) {
	elapsed := time.Since(o.start).Truncate(time.Second)
	o.label.SetText(t("session_with") + " " + o.operator + " · " + mode + " · " + elapsed.String())
}
