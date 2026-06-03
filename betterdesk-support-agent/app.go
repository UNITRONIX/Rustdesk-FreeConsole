package main

import (
	"log"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/driver/desktop"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"
)

// ui holds the long-lived application objects shared across the window.
type ui struct {
	app       fyne.App
	win       fyne.Window
	brand     Branding
	state     *AppState
	engine    *Engine
	pwShown   bool
	pwLabel   *widget.Label
	statusLbl *widget.Label
}

// run boots the GUI: loads branding + state, starts the remote-desktop engine
// (when the branding carries connection details), and shows the quick-help
// window.
func run() {
	brand := GetBranding()

	st, err := LoadState()
	if err != nil {
		log.Fatalf("[support-agent] state: %v", err)
	}
	setLang(st.Language)

	a := app.NewWithID("com.betterdesk.supportagent")
	a.Settings().SetTheme(newBrandedTheme(brand))

	u := &ui{
		app:    a,
		brand:  brand,
		state:  st,
		engine: NewEngine(version),
	}

	u.win = a.NewWindow(brand.ProductName + " — " + t("window_title"))
	u.win.SetContent(u.buildContent())
	u.win.Resize(fyne.NewSize(420, 560))
	u.win.SetFixedSize(true)
	u.setupTray()

	// Start the engine in the background; failures are surfaced in the status
	// label rather than blocking the UI.
	if brand.HasConnection() {
		if err := u.engine.Start(st); err != nil {
			log.Printf("[support-agent] engine start: %v", err)
		}
		u.startStatusLoop()
	}

	log.Printf("[support-agent] %s starting (device=%s)", version, st.DeviceID)
	u.win.ShowAndRun()
}

// buildContent assembles the main window layout.
func (u *ui) buildContent() fyne.CanvasObject {
	deviceID, mode, password, _ := u.state.Snapshot()

	header := u.buildHeader()

	idValue := widget.NewLabelWithStyle(deviceID, fyne.TextAlignCenter, fyne.TextStyle{Bold: true})
	idCopy := widget.NewButtonWithIcon(t("copy"), theme.ContentCopyIcon(), func() {
		u.win.Clipboard().SetContent(deviceID)
		u.notify(t("copied"))
	})
	idCard := widget.NewCard(t("your_id"), "", container.NewVBox(idValue, idCopy))

	u.pwLabel = widget.NewLabelWithStyle(maskPassword(password), fyne.TextAlignCenter, fyne.TextStyle{Bold: true, Monospace: true})
	u.pwShown = false
	showBtn := widget.NewButton(t("show"), nil)
	showBtn.OnTapped = func() {
		u.pwShown = !u.pwShown
		_, _, pw, _ := u.state.Snapshot()
		if u.pwShown {
			u.pwLabel.SetText(pw)
			showBtn.SetText(t("hide"))
		} else {
			u.pwLabel.SetText(maskPassword(pw))
			showBtn.SetText(t("show"))
		}
	}
	pwCopy := widget.NewButtonWithIcon(t("copy"), theme.ContentCopyIcon(), func() {
		_, _, pw, _ := u.state.Snapshot()
		u.win.Clipboard().SetContent(pw)
		u.notify(t("copied"))
	})
	pwRegen := widget.NewButtonWithIcon(t("regenerate"), theme.ViewRefreshIcon(), func() {
		if err := u.state.RegeneratePassword(); err != nil {
			u.notify(err.Error())
			return
		}
		u.refreshPassword()
	})
	pwCustom := widget.NewButton(t("set_custom"), u.showCustomPasswordDialog)
	pwButtons := container.NewGridWithColumns(2, showBtn, pwCopy, pwRegen, pwCustom)
	pwCard := widget.NewCard(t("access_password"), "", container.NewVBox(u.pwLabel, pwButtons))

	modeSelect := widget.NewSelect(
		[]string{t("mode_supervised"), t("mode_unattended"), t("mode_disabled")},
		func(sel string) {
			u.onModeChange(sel)
		},
	)
	modeSelect.SetSelected(modeLabel(mode))
	modeCard := widget.NewCard(t("access_mode"), "", modeSelect)

	helpBtn := widget.NewButtonWithIcon(t("request_help"), theme.MailSendIcon(), u.showHelpDialog)
	helpBtn.Importance = widget.HighImportance

	testBtn := widget.NewButtonWithIcon(t("test_connection"), theme.SearchIcon(), u.showConnTest)

	u.statusLbl = widget.NewLabelWithStyle("", fyne.TextAlignCenter, fyne.TextStyle{Italic: true})
	u.updateStatus()

	return container.NewVBox(
		header,
		widget.NewSeparator(),
		idCard,
		pwCard,
		modeCard,
		widget.NewSeparator(),
		helpBtn,
		testBtn,
		u.statusLbl,
	)
}

// buildHeader renders the brand logo (when present) plus name and tagline.
func (u *ui) buildHeader() fyne.CanvasObject {
	title := widget.NewLabelWithStyle(u.brand.ProductName, fyne.TextAlignCenter, fyne.TextStyle{Bold: true})
	items := []fyne.CanvasObject{}

	if logo := u.brand.LogoBytes(); logo != nil {
		res := fyne.NewStaticResource("logo", logo)
		img := canvas.NewImageFromResource(res)
		img.FillMode = canvas.ImageFillContain
		img.SetMinSize(fyne.NewSize(96, 96))
		items = append(items, container.NewCenter(img))
	}
	items = append(items, title)
	if u.brand.Tagline != "" {
		items = append(items, widget.NewLabelWithStyle(u.brand.Tagline, fyne.TextAlignCenter, fyne.TextStyle{Italic: true}))
	}
	return container.NewVBox(items...)
}

// showHelpDialog prompts for a problem description and sends a help request.
func (u *ui) showHelpDialog() {
	entry := widget.NewMultiLineEntry()
	entry.SetPlaceHolder(t("help_message"))
	entry.SetMinRowsVisible(3)

	form := dialog.NewCustomConfirm(t("request_help"), t("send"), t("cancel"),
		entry, func(ok bool) {
			if !ok {
				return
			}
			go func() {
				err := SendHelpRequest(u.brand, u.state.DeviceID, entry.Text)
				if err != nil {
					u.notify(t("help_failed"))
					log.Printf("[support-agent] help request: %v", err)
					return
				}
				u.notify(t("help_sent"))
			}()
		}, u.win)
	form.Resize(fyne.NewSize(360, 220))
	form.Show()
}

// showConnTest runs the connection self-test and shows the result in a dialog.
func (u *ui) showConnTest() {
	progress := dialog.NewCustom(t("test_connection"), t("close"),
		widget.NewLabelWithStyle(t("test_running"), fyne.TextAlignCenter, fyne.TextStyle{Italic: true}), u.win)
	progress.Show()

	go func() {
		res := TestConnection(u.brand)
		progress.Hide()

		line := func(ok bool, name string, p ProbeResult) string {
			mark := "✕"
			if ok {
				mark = "✓"
			}
			return mark + " " + name + " — " + p.Detail
		}
		content := container.NewVBox(
			widget.NewLabel(line(res.CDAP.OK, t("test_gateway"), res.CDAP)),
			widget.NewLabel(line(res.Console.OK, t("test_console"), res.Console)),
		)
		title := t("test_failed")
		if res.AllOK() {
			title = t("test_ok")
		}
		dialog.NewCustom(title, t("close"), content, u.win).Show()
	}()
}

// showCustomPasswordDialog lets the user set or clear a custom access password.
func (u *ui) showCustomPasswordDialog() {
	entry := widget.NewPasswordEntry()
	entry.SetPlaceHolder(t("custom_password"))

	d := dialog.NewCustomConfirm(t("set_custom"), t("save"), t("cancel"),
		entry, func(ok bool) {
			if !ok {
				return
			}
			if err := u.state.SetCustomPassword(entry.Text); err != nil {
				u.notify(err.Error())
				return
			}
			u.refreshPassword()
		}, u.win)
	d.Show()
}

// onModeChange persists the chosen access mode and restarts the engine so the
// new policy takes effect immediately.
func (u *ui) onModeChange(label string) {
	mode := modeFromLabel(label)
	if mode == u.state.AccessMode {
		return
	}
	if err := u.state.SetAccessMode(mode); err != nil {
		u.notify(err.Error())
		return
	}
	if u.brand.HasConnection() {
		u.engine.Stop()
		if err := u.engine.Start(u.state); err != nil {
			log.Printf("[support-agent] engine restart: %v", err)
		}
	}
}

// refreshPassword re-renders the password label honouring the current mask.
func (u *ui) refreshPassword() {
	_, _, pw, _ := u.state.Snapshot()
	if u.pwShown {
		u.pwLabel.SetText(pw)
	} else {
		u.pwLabel.SetText(maskPassword(pw))
	}
}

// setupTray installs a system-tray icon with show/quit actions on desktop.
func (u *ui) setupTray() {
	deskApp, ok := u.app.(desktop.App)
	if !ok {
		return
	}
	menu := fyne.NewMenu(u.brand.ProductName,
		fyne.NewMenuItem(t("window_title"), func() {
			u.win.Show()
			u.win.RequestFocus()
		}),
		fyne.NewMenuItem(t("request_help"), u.showHelpDialog),
	)
	deskApp.SetSystemTrayMenu(menu)
	if logo := u.brand.LogoBytes(); logo != nil {
		deskApp.SetSystemTrayIcon(fyne.NewStaticResource("tray", logo))
	}
	// Keep running in the tray when the window is closed.
	u.win.SetCloseIntercept(func() {
		u.win.Hide()
	})
}

// notify shows a transient confirmation to the user.
func (u *ui) notify(msg string) {
	u.app.SendNotification(fyne.NewNotification(u.brand.ProductName, msg))
}

// maskPassword returns a dotted placeholder of the same length.
func maskPassword(pw string) string {
	out := make([]rune, len([]rune(pw)))
	for i := range out {
		out[i] = '•'
	}
	if len(out) == 0 {
		return "—"
	}
	return string(out)
}

// modeLabel / modeFromLabel translate between AccessMode constants and the
// localized select labels.
func modeLabel(mode string) string {
	switch mode {
	case AccessUnattended:
		return t("mode_unattended")
	case AccessDisabled:
		return t("mode_disabled")
	default:
		return t("mode_supervised")
	}
}

func modeFromLabel(label string) string {
	switch label {
	case t("mode_unattended"):
		return AccessUnattended
	case t("mode_disabled"):
		return AccessDisabled
	default:
		return AccessSupervised
	}
}
