//go:build fyneui

package main

// The Fyne shell owns its notification-area integration in ui.setupTray.
func (s *AppService) startTray() {}
func (s *AppService) stopTray()  {}
