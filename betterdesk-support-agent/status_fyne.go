//go:build fyneui

package main

func (u *ui) applyStatus(kind statusKind, text string) {
	text = shortenStatusText(text, 160)
	if u.statusLbl != nil {
		u.statusLbl.SetText(text)
	}
	if u.statusDot != nil {
		u.statusDot.FillColor = statusColor(kind, u.brand)
		u.statusDot.Refresh()
	}
}
