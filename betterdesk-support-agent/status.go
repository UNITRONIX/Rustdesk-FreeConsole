package main

import (
	"time"
)

// startStatusLoop polls the engine connection state and refreshes the status
// label. In Fyne 2.5 widget setters are safe to call from a background
// goroutine, so the label is updated directly.
func (u *ui) startStatusLoop() {
	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			u.updateStatus()
		}
	}()
}

// updateStatus reflects the current engine state in the status label.
func (u *ui) updateStatus() {
	if u.statusLbl == nil {
		return
	}
	if !u.brand.HasConnection() {
		u.statusLbl.SetText("")
		return
	}
	if u.engine.Running() {
		u.statusLbl.SetText(t("connected"))
	} else {
		u.statusLbl.SetText(t("disconnected"))
	}
}
