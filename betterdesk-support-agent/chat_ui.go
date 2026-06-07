package main

import (
	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/widget"
)

// showChatWindow opens the support chat dialog (implemented in chat_ui.go phase 3).
func (u *ui) showChatWindow() {
	if u.chatWindow != nil {
		u.chatWindow.Show()
		u.chatWindow.RequestFocus()
		return
	}
	u.openChatDialog()
}

func (u *ui) openChatDialog() {
	if len(u.chatMessages) == 0 && u.brand.HasConnection() {
		if lines, err := LoadChatHistory(u.brand, u.state); err == nil {
			u.chatMessages = append(u.chatMessages, lines...)
		}
	}
	list := widget.NewList(
		func() int { return len(u.chatMessages) },
		func() fyne.CanvasObject {
			return widget.NewLabel("template")
		},
		func(i widget.ListItemID, o fyne.CanvasObject) {
			o.(*widget.Label).SetText(u.chatMessages[i])
		},
	)
	if len(u.chatMessages) == 0 {
		list.Hide()
	}
	entry := widget.NewEntry()
	entry.SetPlaceHolder(t("chat_placeholder"))
	send := func() {
		text := entry.Text
		if text == "" {
			return
		}
		entry.SetText("")
		u.sendChatMessage(text)
		list.Refresh()
	}
	entry.OnSubmitted = func(_ string) { send() }
	sendBtn := widget.NewButton(t("chat_send"), send)
	inputRow := container.NewBorder(nil, nil, nil, sendBtn, entry)
	body := container.NewBorder(nil, inputRow, nil, nil, list)
	if len(u.chatMessages) == 0 {
		empty := widget.NewLabelWithStyle(t("chat_empty"), fyne.TextAlignCenter, fyne.TextStyle{Italic: true})
		body = container.NewBorder(nil, inputRow, nil, nil, empty)
	}
	d := dialog.NewCustom(t("chat_title"), t("close"), body, u.win)
	d.Resize(fyne.NewSize(460, 420))
	d.Show()
}
