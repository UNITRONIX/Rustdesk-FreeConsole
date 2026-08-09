//go:build fyneui

package main

import (
	"log"
	"sync"
	"time"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"
	"fyne.io/fyne/v2/canvas"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/dialog"
	"fyne.io/fyne/v2/driver/desktop"
	"fyne.io/fyne/v2/theme"
	"fyne.io/fyne/v2/widget"

	"github.com/unitronix/betterdesk-support-agent/signalhost"
)

// ui holds the long-lived application objects shared across the window.
type ui struct {
	app          fyne.App
	win          fyne.Window
	brand        Branding
	state        *AppState
	engine       *Engine
	overlay      *sessionOverlay
	pwShown      bool
	pwValueLbl   *widget.Label
	pwBox        fyne.CanvasObject
	statusLbl    *widget.Label
	statusDot    *canvas.Rectangle
	consentCh    chan consentRequest
	chatMessages []string
	chatWindow   fyne.Window
	signalHostMu sync.Mutex
	signalHost   *signalhost.Host
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
	if icon := brand.LogoResource(); icon != nil {
		a.SetIcon(icon)
	}

	u := &ui{
		app:       a,
		brand:     brand,
		state:     st,
		engine:    NewEngine(version),
		consentCh: make(chan consentRequest, 1),
	}
	u.overlay = newSessionOverlay(a, brand.ProductName, u.disconnectActiveSessions)

	u.engine.SetCallbacks(u.handleConsent, u.handleSessionStart, u.handleSessionEnd)
	u.engine.SetChatHandler(u.handleChatMessage)

	u.win = a.NewWindow(brand.ProductName + " — " + t("window_title"))
	if icon := brand.LogoResource(); icon != nil {
		u.win.SetIcon(icon)
	}
	const winW, winH float32 = 480, 720
	u.win.SetContent(u.buildMainLayout())
	u.win.Resize(fyne.NewSize(winW, winH))
	u.win.SetFixedSize(true)
	u.setupTray()

	go u.consentLoop()

	if brand.HasConnection() {
		u.bootstrapConnection()
	}

	log.Printf("[support-agent] %s starting (device=%s)", version, st.DeviceID)
	appLogInfo("startup", "support agent started", map[string]any{"device_id": st.DeviceID, "version": version})
	u.win.ShowAndRun()
}

func (u *ui) bootstrapConnection() {
	go func() {
		// #region agent log
		debugLog("H1", "app.go:bootstrapConnection", "branding connection profile", map[string]any{
			"server_address":           u.brand.ServerAddress,
			"api_base":                 apiBaseURL(u.brand),
			"cdap_health":              u.brand.CDAPHealthURL(),
			"cdap_ws":                  u.brand.CDAPWebSocketURL(),
			"use_https":                u.brand.UseHTTPS,
			"sends_token":              false,
			"branding_embed_has_token": brandingEmbedHasLegacyToken(),
			"bundle_id":                u.brand.BundleID,
			"device_id":                u.state.DeviceID,
		})
		// #endregion
		res, err := EnsureEnrolled(u.brand, u.state, version)
		if err != nil {
			log.Printf("[support-agent] enrollment: %v", err)
			// #region agent log
			debugLog("H2", "app.go:bootstrapConnection", "enrollment failed", map[string]any{"error": err.Error()})
			// #endregion
			u.applyStatus(statusKindError, t("enrollment_error")+" — "+shortenErr(err.Error()))
			return
		}
		// #region agent log
		debugLog("H4", "app.go:bootstrapConnection", "enrollment result", map[string]any{
			"status": res.Status, "token_len": len(res.DeviceToken), "message": res.Message,
			"is_enrolled": u.state.IsEnrolled(),
		})
		// #endregion
		u.onEnrollmentUpdate(res)
		if res.Status == EnrollmentPending {
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
		if err := SyncAccessPassword(u.brand, u.state); err != nil {
			log.Printf("[support-agent] access password sync: %v", err)
		}
		_ = PullAccessPolicy(u.brand, u.state)
		go startAccessPolicyPullLoop(u.brand, u.state)
		if !u.engine.Running() {
			if err := u.engine.Start(u.state); err != nil {
				log.Printf("[support-agent] engine start: %v", err)
				return
			}
		}
		if u.engine.Running() {
			u.startSignalHost()
		}
	case EnrollmentPending:
		u.stopRemoteAccessForEnrollmentState()
		msg := t("enrollment_pending")
		if res.Message != "" {
			msg = res.Message
		}
		u.applyStatus(statusKindPending, msg)
	case EnrollmentRejected:
		u.stopRemoteAccessForEnrollmentState()
		u.applyStatus(statusKindError, t("enrollment_rejected"))
	default:
		u.applyStatus(statusKindPending, t("disconnected"))
	}
}

func (u *ui) stopRemoteAccessForEnrollmentState() {
	if u.engine != nil {
		u.engine.Stop()
	}
	u.stopSignalHost()
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
		acceptBtn := widget.NewButton(t("consent_accept"), func() {
			granted = true
			close(done)
		})
		acceptBtn.Importance = widget.HighImportance
		denyBtn := widget.NewButton(t("consent_deny"), func() {
			close(done)
		})
		body := container.NewVBox(
			widget.NewLabel(msg),
			container.NewGridWithColumns(2, acceptBtn, denyBtn),
		)
		d := dialog.NewCustom(t("consent_title"), t("cancel"), body, u.win)
		d.Show()
		<-done
		d.Hide()
		req.response <- granted
		appLogInfo("consent", "remote access consent answered", map[string]any{
			"session_id": req.sessionID, "operator": req.operator, "granted": granted,
		})
	}
}

func (u *ui) handleSessionStart(sessionID, operator, mode string) {
	u.overlay.show(operator, mode)
}

func (u *ui) handleSessionEnd(sessionID string) {
	u.overlay.hide()
}

// disconnectActiveSessions is invoked by the local session overlay. The shared
// CDAP engine does not expose a per-session disconnect API, so stopping it is
// the only reliable way to terminate its active local session. The signal host
// can close relay connections without unregistering itself.
func (u *ui) disconnectActiveSessions() {
	if u.engine != nil {
		u.engine.Stop()
	}
	u.disconnectSignalSessions()
}

func (u *ui) handleChatMessage(from, text string) {
	line := from + ": " + text
	u.chatMessages = append(u.chatMessages, line)
}

func (u *ui) buildMainLayout() fyne.CanvasObject {
	header := u.buildBrandedHeaderBar()
	body := u.buildContent()
	footer := u.buildFooterBar()
	return container.NewBorder(header, footer, nil, nil, body)
}

func (u *ui) buildContent() fyne.CanvasObject {
	deviceID, mode, password, custom := u.state.Snapshot()

	bodyLogo := u.buildBodyLogo()

	idBox := u.newInfoBox(t("your_id"), formatDeviceID(deviceID), false, func() {
		u.win.Clipboard().SetContent(deviceID)
		u.notify(t("copied"))
	})

	displayPw := maskPassword(password)
	if u.pwShown {
		displayPw = password
	}
	u.pwValueLbl = widget.NewLabelWithStyle(displayPw, fyne.TextAlignLeading, fyne.TextStyle{Bold: true, Monospace: true})
	u.pwBox = u.newInfoBox(t("access_password"), u.pwValueLbl, true, func() {
		_, _, pw, _ := u.state.Snapshot()
		u.win.Clipboard().SetContent(pw)
		u.notify(t("copied"))
	})
	if !u.shouldShowPasswordBox(mode, custom) {
		u.pwBox.Hide()
	}

	helpBtn := newSecondaryButton(t("request_help"), theme.MailSendIcon(), u.showHelpDialog)
	chatBtn := newPrimaryButton(t("chat_with_support"), theme.MailComposeIcon(), u.showChatWindow)

	u.statusLbl = widget.NewLabelWithStyle(t("status_ready"), fyne.TextAlignLeading, fyne.TextStyle{})
	u.statusDot = canvas.NewRectangle(statusColor(statusKindReady, u.brand))
	u.statusDot.SetMinSize(fyne.NewSize(10, 10))
	u.statusDot.CornerRadius = 5
	dotBox := container.NewCenter(u.statusDot)
	statusRow := container.NewBorder(nil, nil, dotBox, nil, u.statusLbl)
	u.updateStatus()

	items := []fyne.CanvasObject{}
	if bodyLogo != nil {
		items = append(items, bodyLogo)
	}
	items = append(items,
		statusRow,
		idBox,
		u.pwBox,
		helpBtn,
		chatBtn,
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
		// #region agent log
		debugLog("H1", "app.go:showConnTest", "probe urls", map[string]any{
			"cdap_health":  u.brand.CDAPHealthURL(),
			"api_health":   u.brand.APIHealthURL(),
			"register_url": apiBaseURL(u.brand) + "/devices/register",
		})
		// #endregion
		res := TestConnectionExtended(u.brand, u.state)
		logConnectionTest(res)
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
			wrapLabel(line(res.Enrollment.OK, t("test_enrollment"), res.Enrollment)),
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
	if u.pwBox != nil {
		_, newMode, _, newCustom := u.state.Snapshot()
		if u.shouldShowPasswordBox(newMode, newCustom) {
			u.pwBox.Show()
		} else {
			u.pwBox.Hide()
		}
	}
	// AccessDisabled must immediately remove the signal/relay presence, not
	// merely reject a later login attempt.
	u.stopSignalHost()
	if u.brand.HasConnection() && u.state.IsEnrolled() {
		u.engine.Stop()
		go func() {
			if err := SyncAccessPassword(u.brand, u.state); err != nil {
				log.Printf("[support-agent] access password sync: %v", err)
			}
			if err := u.engine.Restart(u.state); err != nil {
				log.Printf("[support-agent] engine restart: %v", err)
				return
			}
			u.startSignalHost()
		}()
	}
}

func (u *ui) rebuildMainLayout() {
	u.win.SetContent(u.buildMainLayout())
}

func (u *ui) refreshPassword() {
	_, mode, pw, custom := u.state.Snapshot()
	display := maskPassword(pw)
	if u.pwShown {
		display = pw
	}
	if u.pwValueLbl != nil {
		u.pwValueLbl.SetText(display)
	}
	if u.pwBox != nil {
		if u.shouldShowPasswordBox(mode, custom) {
			u.pwBox.Show()
		} else {
			u.pwBox.Hide()
		}
		u.pwBox.Refresh()
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
