package main

import (
	"log"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"
)

func (u *ui) showSettings() {
	deviceID, mode, _, _ := u.state.Snapshot()

	modeOptions := u.accessModeOptions()
	modeSelect := widget.NewSelect(modeOptions, nil)
	modeSelect.SetSelected(modeLabel(mode))

	langOptions := []string{"en", "pl"}
	langSelect := widget.NewSelect(langOptions, nil)
	langSelect.SetSelected(u.state.Language)

	content := container.NewVBox(
		widget.NewLabelWithStyle(t("settings"), fyne.TextAlignLeading, fyne.TextStyle{Bold: true}),
		widget.NewForm(
			widget.NewFormItem(t("access_mode"), modeSelect),
			widget.NewFormItem(t("settings_language"), langSelect),
		),
		widget.NewButtonWithIcon(t("set_custom"), theme.LoginIcon(), u.showCustomPasswordDialog),
		widget.NewButtonWithIcon(t("regenerate"), theme.ViewRefreshIcon(), func() {
			if err := u.state.RegeneratePassword(); err != nil {
				u.notify(err.Error())
				return
			}
			u.refreshPassword()
			go func() { _ = SyncAccessPassword(u.brand, u.state) }()
		}),
		widget.NewButtonWithIcon(t("test_connection"), theme.SearchIcon(), u.showConnTest),
		widget.NewButton(t("totp_title"), u.showTOTPSettings),
	)

	d := dialog.NewCustomConfirm(t("settings"), t("save"), t("cancel"), content, func(ok bool) {
		if !ok {
			return
		}
		if sel := modeSelect.Selected; sel != "" {
			u.onModeChange(sel)
		}
		if lang := langSelect.Selected; lang != "" && lang != u.state.Language {
			if err := u.state.SetLanguage(lang); err != nil {
				u.notify(err.Error())
				return
			}
			setLang(lang)
		}
		_, newMode, _, newCustom := u.state.Snapshot()
		if u.pwBox != nil {
			if u.shouldShowPasswordBox(newMode, newCustom) {
				u.pwBox.Show()
			} else {
				u.pwBox.Hide()
			}
		}
		log.Printf("[support-agent] settings saved device=%s mode=%s", deviceID, newMode)
	}, u.win)
	d.Resize(fyne.NewSize(440, 360))
	d.Show()
}
