package main

import (
	"log"
	"time"

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
	overlay   *sessionOverlay
	pwShown   bool
	pwLabel   *widget.Label
	statusLbl *widget.Label
	statusDot *canvas.Rectangle
	consentCh chan consentRequest
}

type consentRequest struct {
	sessionID string
	operator  string
	response  chan bool
}

// run boots the GUI.
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
		app:       a,
		brand:     brand,
		state:     st,
		engine:    NewEngine(version),
		consentCh: make(chan consentRequest, 1),
	}
	u.overlay = newSessionOverlay(a, brand.ProductName)

	u.engine.SetCallbacks(u.handleConsent, u.handleSessionStart, u.handleSessionEnd)

	u.win = a.NewWindow(brand.ProductName + " — " + t("window_title"))
	const winW, winH float32 = 480, 660
	body := u.buildContent()
	scroll := container.NewScroll(body)
	scroll.SetMinSize(fyne.NewSize(winW, winH))
	u.win.SetContent(scroll)
	u.win.Resize(fyne.NewSize(winW, winH))
	u.win.SetFixedSize(true)
	u.setupTray()

	go u.consentLoop()

	if brand.HasConnection() {
		u.bootstrapConnection()
	}

	log.Printf("[support-agent] %s starting (device=%s)", version, st.DeviceID)
	u.win.ShowAndRun()
}

func (u *ui) bootstrapConnection() {
	go func() {
		res, err := EnsureEnrolled(u.brand, u.state, version)
		if err != nil {
			log.Printf("[support-agent] enrollment: %v", err)
			u.applyStatus(statusKindError, t("enrollment_error")+" — "+shortenErr(err.Error()))
			return
		}
		u.onEnrollmentUpdate(res)
		if res.Status == EnrollmentApproved {
			if err := u.engine.Start(u.state); err != nil {
				log.Printf("[support-agent] engine start: %v", err)
			}
			_ = SyncAccessPassword(u.brand, u.state)
		} else if res.Status == EnrollmentPending {
			StartEnrollmentPoll(u.brand, u.state, version, 5*time.Second, u.onEnrollmentUpdate)
		}
		u.startStatusLoop()
	}()
}

func (u *ui) onEnrollmentUpdate(res EnrollmentStatus) {
	switch res.Status {
	case EnrollmentApproved:
		if !u.state.IsEnrolled() {
			u.applyStatus(statusKindPending, t("enrollment_pending"))
			return
		}
		if u.engine.Running() {
			u.applyStatus(statusKindConnected, t("connected"))
		} else {
			u.applyStatus(statusKindPending, t("disconnected"))
		}
		if !u.engine.Running() {
			_ = u.engine.Start(u.state)
			_ = SyncAccessPassword(u.brand, u.state)
		}
	case EnrollmentPending:
		msg := t("enrollment_pending")
		if res.Message != "" {
			msg = res.Message
		}
		u.applyStatus(statusKindPending, msg)
	case EnrollmentRejected:
		u.applyStatus(statusKindError, t("enrollment_rejected"))
	default:
		u.applyStatus(statusKindPending, t("disconnected"))
	}
}

func (u *ui) handleConsent(sessionID, operator string) bool {
	resp := make(chan bool, 1)
	req := consentRequest{sessionID: sessionID, operator: operator, response: resp}
	select {
	case u.consentCh <- req:
	default:
		return false
	}
	select {
	case granted := <-resp:
		return granted
	case <-time.After(30 * time.Second):
		return false
	}
}

func (u *ui) consentLoop() {
	for req := range u.consentCh {
		granted := false
		done := make(chan struct{})
		msg := t("consent_prompt") + " " + req.operator
		d := dialog.NewConfirm(t("consent_title"), msg, func(ok bool) {
			granted = ok
			close(done)
		}, u.win)
		d.Show()
		<-done
		req.response <- granted
	}
}

func (u *ui) handleSessionStart(sessionID, operator, mode string) {
	u.overlay.show(operator, mode)
}

func (u *ui) handleSessionEnd(sessionID string) {
	u.overlay.hide()
}

func (u *ui) buildContent() fyne.CanvasObject {
	deviceID, mode, password, _ := u.state.Snapshot()

	header := u.buildHeader()
	bodyLogo := u.buildBodyLogo()

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
		go func() { _ = SyncAccessPassword(u.brand, u.state) }()
	})
	pwCustom := widget.NewButton(t("set_custom"), u.showCustomPasswordDialog)
	pwButtons := container.NewGridWithColumns(2, showBtn, pwCopy, pwRegen, pwCustom)
	pwCard := widget.NewCard(t("access_password"), "", container.NewVBox(u.pwLabel, pwButtons))

	modeOptions := u.accessModeOptions()
	modeSelect := widget.NewSelect(modeOptions, func(sel string) {
		u.onModeChange(sel)
	})
	modeSelect.SetSelected(modeLabel(mode))
	modeCard := widget.NewCard(t("access_mode"), "", modeSelect)

	helpBtn := widget.NewButtonWithIcon(t("request_help"), theme.MailSendIcon(), u.showHelpDialog)
	helpBtn.Importance = widget.HighImportance

	testBtn := widget.NewButtonWithIcon(t("test_connection"), theme.SearchIcon(), u.showConnTest)

	u.statusLbl = widget.NewLabelWithStyle(t("status_ready"), fyne.TextAlignLeading, fyne.TextStyle{Italic: true})
	u.statusLbl.Wrapping = fyne.TextWrapOff

	u.statusDot = canvas.NewRectangle(statusColor(statusKindReady, u.brand))
	u.statusDot.SetMinSize(fyne.NewSize(10, 10))
	u.statusDot.CornerRadius = 5
	dotBox := container.NewCenter(u.statusDot)
	dotBox.Resize(fyne.NewSize(18, 18))
	statusRow := container.NewBorder(nil, nil, dotBox, nil, u.statusLbl)
	u.updateStatus()

	items := []fyne.CanvasObject{header}
	if bodyLogo != nil {
		items = append(items, bodyLogo)
	}
	items = append(items,
		statusRow,
		widget.NewSeparator(),
		idCard,
	)
	if u.brand.AllowUnattended {
		items = append(items, pwCard)
	}
	items = append(items,
		modeCard,
		widget.NewSeparator(),
		helpBtn,
		testBtn,
	)
	return container.NewPadded(container.NewVBox(items...))
}

func (u *ui) accessModeOptions() []string {
	opts := []string{t("mode_supervised"), t("mode_disabled")}
	if u.brand.AllowUnattended {
		opts = []string{t("mode_supervised"), t("mode_unattended"), t("mode_disabled")}
	}
	return opts
}

func (u *ui) buildHeader() fyne.CanvasObject {
	title := widget.NewLabelWithStyle(u.brand.CompanyName, fyne.TextAlignCenter, fyne.TextStyle{Bold: true})
	items := []fyne.CanvasObject{title}
	tagline := u.brand.Tagline
	if tagline == "" {
		tagline = u.brand.ProductName
	}
	if tagline != "" && tagline != u.brand.CompanyName {
		items = append(items, widget.NewLabelWithStyle(tagline, fyne.TextAlignCenter, fyne.TextStyle{Italic: true}))
	}
	return container.NewVBox(items...)
}

func (u *ui) buildBodyLogo() fyne.CanvasObject {
	if res := u.brand.LogoResource(); res != nil {
		img := canvas.NewImageFromResource(res)
		img.FillMode = canvas.ImageFillContain
		img.SetMinSize(fyne.NewSize(120, 80))
		return container.NewCenter(img)
	}
	return nil
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
				err := SendHelpRequest(u.engine, u.brand, u.state, entry.Text)
				if err != nil {
					u.notify(t("help_failed"))
					log.Printf("[support-agent] help request: %v", err)
					return
				}
				u.notify(t("help_sent"))
			}()
		}, u.win)
	form.Resize(fyne.NewSize(420, 240))
	form.Show()
}

func wrapLabel(text string) *widget.Label {
	lbl := widget.NewLabel(text)
	lbl.Wrapping = fyne.TextWrapWord
	return lbl
}

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
			wrapLabel(line(res.CDAP.OK, t("test_gateway"), res.CDAP)),
			wrapLabel(line(res.API.OK, t("test_api"), res.API)),
		)
		scroll := container.NewScroll(content)
		scroll.SetMinSize(fyne.NewSize(440, 120))
		title := t("test_failed")
		if res.AllOK() {
			title = t("test_ok")
		}
		d := dialog.NewCustom(title, t("close"), scroll, u.win)
		d.Resize(fyne.NewSize(520, 220))
		d.Show()
	}()
}

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
			go func() { _ = SyncAccessPassword(u.brand, u.state) }()
		}, u.win)
	d.Show()
}

func (u *ui) onModeChange(label string) {
	mode := modeFromLabel(label)
	_, cur, _, _ := u.state.Snapshot()
	if mode == cur {
		return
	}
	if !u.brand.AllowUnattended && mode == AccessUnattended {
		return
	}
	if err := u.state.SetAccessMode(mode); err != nil {
		u.notify(err.Error())
		return
	}
	if u.brand.HasConnection() && u.state.IsEnrolled() {
		u.engine.Stop()
		if err := u.engine.Start(u.state); err != nil {
			log.Printf("[support-agent] engine restart: %v", err)
		}
		go func() { _ = SyncAccessPassword(u.brand, u.state) }()
	}
}

func (u *ui) refreshPassword() {
	_, _, pw, _ := u.state.Snapshot()
	if u.pwShown {
		u.pwLabel.SetText(pw)
	} else {
		u.pwLabel.SetText(maskPassword(pw))
	}
}

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
	if res := u.brand.TrayIconResource(); res != nil {
		deskApp.SetSystemTrayIcon(res)
	}
	u.win.SetCloseIntercept(func() { u.win.Hide() })
}

func (u *ui) notify(msg string) {
	u.app.SendNotification(fyne.NewNotification(u.brand.ProductName, msg))
}

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
