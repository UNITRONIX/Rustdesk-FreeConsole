package main

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/unitronix/betterdesk-support-agent/signalhost"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// AppService is the GUI-agnostic core bound to Wails (and embedded by Fyne UI).
type AppService struct {
	brand  Branding
	state  *AppState
	engine *Engine

	signalHostMu sync.Mutex
	signalHost   *signalhost.Host

	consentMu     sync.Mutex
	pendingConsent *consentRequest
	chatMessages  []string
	chatMu        sync.Mutex

	statusMu   sync.Mutex
	statusKind statusKind
	statusText string

	sessionMu     sync.Mutex
	sessionActive bool
	sessionOp     string
	sessionMode   string

	ctx context.Context
}

type UISnapshot struct {
	ProductName     string   `json:"product_name"`
	CompanyName     string   `json:"company_name"`
	Tagline         string   `json:"tagline"`
	PrimaryColor    string   `json:"primary_color"`
	SurfaceColor    string   `json:"surface_color"`
	BackgroundColor string   `json:"background_color"`
	TextColor       string   `json:"text_color"`
	TextMutedColor  string   `json:"text_muted_color"`
	LogoDataURL     string   `json:"logo_data_url"`
	Version         string   `json:"version"`
	DeviceID        string   `json:"device_id"`
	DeviceIDFmt     string   `json:"device_id_fmt"`
	Password        string   `json:"password"`
	PasswordMasked  string   `json:"password_masked"`
	AccessMode      string   `json:"access_mode"`
	CustomPassword  bool     `json:"custom_password"`
	ShowPassword    bool     `json:"show_password"`
	AllowUnattended bool     `json:"allow_unattended"`
	Language        string   `json:"language"`
	StatusKind      string   `json:"status_kind"`
	StatusText      string   `json:"status_text"`
	SessionActive   bool     `json:"session_active"`
	SessionOperator string   `json:"session_operator"`
	SessionMode     string   `json:"session_mode"`
	ModeOptions     []string `json:"mode_options"`
	Strings         map[string]string `json:"strings"`
}

type ConnTestDTO struct {
	OK         bool   `json:"ok"`
	Title      string `json:"title"`
	Gateway    string `json:"gateway"`
	API        string `json:"api"`
	Enrollment string `json:"enrollment"`
}

func newAppService() (*AppService, error) {
	brand := GetBranding()
	st, err := LoadState()
	if err != nil {
		return nil, err
	}
	setLang(st.Language)
	s := &AppService{
		brand:  brand,
		state:  st,
		engine: NewEngine(version),
	}
	s.engine.SetCallbacks(s.handleConsent, s.handleSessionStart, s.handleSessionEnd)
	s.engine.SetChatHandler(s.handleChatMessage)
	s.applyStatus(statusKindReady, t("status_ready"))
	return s, nil
}

func (s *AppService) startup(ctx context.Context) {
	s.ctx = ctx
	if s.brand.HasConnection() {
		s.bootstrapConnection()
	}
	log.Printf("[support-agent] %s starting (device=%s) ui=wails", version, s.state.DeviceID)
	appLogInfo("startup", "support agent started", map[string]any{"device_id": s.state.DeviceID, "version": version, "ui": "wails"})
}

func (s *AppService) emit(event string, data any) {
	if s.ctx == nil {
		return
	}
	runtime.EventsEmit(s.ctx, event, data)
}

func (s *AppService) GetSnapshot() UISnapshot {
	deviceID, mode, password, custom := s.state.Snapshot()
	s.statusMu.Lock()
	kind, text := s.statusKind, s.statusText
	s.statusMu.Unlock()
	s.sessionMu.Lock()
	active, op, smode := s.sessionActive, s.sessionOp, s.sessionMode
	s.sessionMu.Unlock()

	keys := []string{
		"window_title", "your_id", "access_password", "request_help", "chat_with_support",
		"settings", "quit", "copied", "mode_supervised", "mode_unattended", "mode_disabled",
		"language", "test_connection", "set_custom", "regenerate", "totp", "send", "cancel",
		"save", "close", "consent_title", "consent_accept", "consent_deny", "consent_prompt",
		"help_message", "help_sent", "help_failed", "session_active", "disconnect",
		"connected", "disconnected", "status_ready", "enrollment_pending", "enrollment_rejected",
	}
	strs := make(map[string]string, len(keys))
	for _, k := range keys {
		strs[k] = t(k)
	}

	return UISnapshot{
		ProductName:     s.brand.ProductName,
		CompanyName:     s.brand.CompanyName,
		Tagline:         s.brand.Tagline,
		PrimaryColor:    s.brand.PrimaryColor,
		SurfaceColor:    s.brand.SurfaceColor,
		BackgroundColor: s.brand.BackgroundColor,
		TextColor:       s.brand.TextColor,
		TextMutedColor:  s.brand.TextMutedColor,
		LogoDataURL:     s.brand.LogoDataURL,
		Version:         version,
		DeviceID:        deviceID,
		DeviceIDFmt:     formatDeviceID(deviceID),
		Password:        password,
		PasswordMasked:  maskPassword(password),
		AccessMode:      mode,
		CustomPassword:  custom,
		ShowPassword:    s.shouldShowPasswordBox(mode, custom),
		AllowUnattended: s.brand.AllowUnattended,
		Language:        s.state.Language,
		StatusKind:      statusKindName(kind),
		StatusText:      text,
		SessionActive:   active,
		SessionOperator: op,
		SessionMode:     smode,
		ModeOptions:     s.accessModeOptions(),
		Strings:         strs,
	}
}

func (s *AppService) accessModeOptions() []string {
	if s.brand.AllowUnattended {
		return []string{t("mode_supervised"), t("mode_unattended"), t("mode_disabled")}
	}
	return []string{t("mode_supervised"), t("mode_disabled")}
}

func (s *AppService) shouldShowPasswordBox(mode string, custom bool) bool {
	return mode != AccessDisabled
}

func (s *AppService) SetAccessMode(label string) error {
	mode := modeFromLabel(label)
	_, cur, _, _ := s.state.Snapshot()
	if mode == cur {
		return nil
	}
	if !s.brand.AllowUnattended && mode == AccessUnattended {
		return nil
	}
	if err := s.state.SetAccessMode(mode); err != nil {
		return err
	}
	s.stopSignalHost()
	if s.brand.HasConnection() && s.state.IsEnrolled() {
		s.engine.Stop()
		go func() {
			if err := SyncAccessPassword(s.brand, s.state); err != nil {
				log.Printf("[support-agent] access password sync: %v", err)
			}
			if err := s.engine.Restart(s.state); err != nil {
				log.Printf("[support-agent] engine restart: %v", err)
				return
			}
			s.startSignalHost()
			s.emit("snapshot", s.GetSnapshot())
		}()
	}
	s.emit("snapshot", s.GetSnapshot())
	return nil
}

func (s *AppService) SetLanguage(lang string) error {
	if err := s.state.SetLanguage(lang); err != nil {
		return err
	}
	setLang(lang)
	s.emit("snapshot", s.GetSnapshot())
	return nil
}

func (s *AppService) SetCustomPassword(pw string) error {
	if err := s.state.SetCustomPassword(pw); err != nil {
		return err
	}
	go func() { _ = SyncAccessPassword(s.brand, s.state) }()
	s.emit("snapshot", s.GetSnapshot())
	return nil
}

func (s *AppService) RegeneratePassword() error {
	if err := s.state.RegeneratePassword(); err != nil {
		return err
	}
	go func() { _ = SyncAccessPassword(s.brand, s.state) }()
	s.emit("snapshot", s.GetSnapshot())
	return nil
}

func (s *AppService) SendHelp(message string) error {
	err := SendHelpRequest(s.engine, s.brand, s.state, message)
	if err != nil {
		return err
	}
	s.emit("toast", t("help_sent"))
	return nil
}

func (s *AppService) SendChat(text string) error {
	if text == "" {
		return nil
	}
	s.chatMu.Lock()
	s.chatMessages = append(s.chatMessages, "me: "+text)
	s.chatMu.Unlock()
	if err := SendChatMessage(s.engine, text); err != nil {
		return err
	}
	s.emit("chat", s.GetChatHistory())
	return nil
}

func (s *AppService) GetChatHistory() []string {
	s.chatMu.Lock()
	defer s.chatMu.Unlock()
	out := make([]string, len(s.chatMessages))
	copy(out, s.chatMessages)
	return out
}

func (s *AppService) TestConnection() ConnTestDTO {
	res := TestConnectionExtended(s.brand, s.state)
	logConnectionTest(res)
	line := func(ok bool, name string, p ProbeResult) string {
		mark := "✕"
		if ok {
			mark = "✓"
		}
		return mark + " " + name + " — " + p.Detail
	}
	title := t("test_failed")
	if res.AllOK() {
		title = t("test_ok")
	}
	return ConnTestDTO{
		OK:         res.AllOK(),
		Title:      title,
		Gateway:    line(res.CDAP.OK, t("test_gateway"), res.CDAP),
		API:        line(res.API.OK, t("test_api"), res.API),
		Enrollment: line(res.Enrollment.OK, t("test_enrollment"), res.Enrollment),
	}
}

func (s *AppService) AnswerConsent(granted bool) {
	s.consentMu.Lock()
	req := s.pendingConsent
	s.pendingConsent = nil
	s.consentMu.Unlock()
	if req != nil {
		select {
		case req.response <- granted:
		default:
		}
	}
}

func (s *AppService) DisconnectSession() {
	if s.engine != nil {
		s.engine.Stop()
	}
	s.disconnectSignalSessions()
	s.handleSessionEnd("")
}

func (s *AppService) Quit() {
	if s.ctx != nil {
		runtime.Quit(s.ctx)
	}
}

func (s *AppService) applyStatus(kind statusKind, text string) {
	text = shortenStatusText(text, 160)
	s.statusMu.Lock()
	s.statusKind = kind
	s.statusText = text
	s.statusMu.Unlock()
	s.emit("status", map[string]string{"kind": statusKindName(kind), "text": text})
	s.emit("snapshot", s.GetSnapshot())
}

func statusKindName(kind statusKind) string {
	switch kind {
	case statusKindConnected:
		return "connected"
	case statusKindPending:
		return "pending"
	case statusKindError:
		return "error"
	default:
		return "ready"
	}
}

func (s *AppService) bootstrapConnection() {
	go func() {
		res, err := EnsureEnrolled(s.brand, s.state, version)
		if err != nil {
			log.Printf("[support-agent] enrollment: %v", err)
			s.applyStatus(statusKindError, t("enrollment_error")+" — "+shortenErr(err.Error()))
			return
		}
		s.onEnrollmentUpdate(res)
		if res.Status == EnrollmentPending {
			StartEnrollmentPoll(s.brand, s.state, version, 5*time.Second, s.onEnrollmentUpdate)
		}
		s.startStatusLoop()
	}()
}

func (s *AppService) onEnrollmentUpdate(res EnrollmentStatus) {
	switch res.Status {
	case EnrollmentApproved:
		if !s.state.IsEnrolled() {
			s.applyStatus(statusKindPending, t("enrollment_pending"))
			return
		}
		if s.engine.Running() {
			s.applyStatus(statusKindConnected, t("connected"))
		} else {
			s.applyStatus(statusKindPending, t("disconnected"))
		}
		if err := SyncAccessPassword(s.brand, s.state); err != nil {
			log.Printf("[support-agent] access password sync: %v", err)
		}
		if !s.engine.Running() {
			if err := s.engine.Start(s.state); err != nil {
				log.Printf("[support-agent] engine start: %v", err)
				return
			}
		}
		if s.engine.Running() {
			s.startSignalHost()
		}
	case EnrollmentPending:
		s.stopRemoteAccessForEnrollmentState()
		msg := t("enrollment_pending")
		if res.Message != "" {
			msg = res.Message
		}
		s.applyStatus(statusKindPending, msg)
	case EnrollmentRejected:
		s.stopRemoteAccessForEnrollmentState()
		s.applyStatus(statusKindError, t("enrollment_rejected"))
	default:
		s.applyStatus(statusKindPending, t("disconnected"))
	}
}

func (s *AppService) stopRemoteAccessForEnrollmentState() {
	if s.engine != nil {
		s.engine.Stop()
	}
	s.stopSignalHost()
}

func (s *AppService) handleConsent(sessionID, operator string) bool {
	resp := make(chan bool, 1)
	req := &consentRequest{sessionID: sessionID, operator: operator, response: resp}
	s.consentMu.Lock()
	if s.pendingConsent != nil {
		s.consentMu.Unlock()
		return false
	}
	s.pendingConsent = req
	s.consentMu.Unlock()
	s.emit("consent", map[string]string{
		"session_id": sessionID,
		"operator":   operator,
		"prompt":     t("consent_prompt") + " " + operator,
	})
	select {
	case granted := <-resp:
		appLogInfo("consent", "remote access consent answered", map[string]any{
			"session_id": sessionID, "operator": operator, "granted": granted,
		})
		return granted
	case <-time.After(30 * time.Second):
		s.consentMu.Lock()
		if s.pendingConsent == req {
			s.pendingConsent = nil
		}
		s.consentMu.Unlock()
		return false
	}
}

func (s *AppService) handleSessionStart(sessionID, operator, mode string) {
	s.sessionMu.Lock()
	s.sessionActive = true
	s.sessionOp = operator
	s.sessionMode = mode
	s.sessionMu.Unlock()
	s.emit("session", map[string]any{"active": true, "operator": operator, "mode": mode})
	s.emit("snapshot", s.GetSnapshot())
}

func (s *AppService) handleSessionEnd(sessionID string) {
	s.sessionMu.Lock()
	s.sessionActive = false
	s.sessionOp = ""
	s.sessionMode = ""
	s.sessionMu.Unlock()
	s.emit("session", map[string]any{"active": false})
	s.emit("snapshot", s.GetSnapshot())
}

func (s *AppService) handleChatMessage(from, text string) {
	s.chatMu.Lock()
	s.chatMessages = append(s.chatMessages, from+": "+text)
	s.chatMu.Unlock()
	s.emit("chat", s.GetChatHistory())
}

func (s *AppService) startStatusLoop() {
	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()
		var lastEnrollmentCheck time.Time
		for range ticker.C {
			s.updateStatus()
			if !lastEnrollmentCheck.IsZero() &&
				time.Since(lastEnrollmentCheck) < enrollmentRevalidationInterval {
				continue
			}
			status, _, _ := s.state.EnrollmentSnapshot()
			if status != EnrollmentApproved || !s.brand.HasConnection() {
				continue
			}
			lastEnrollmentCheck = time.Now()
			go s.revalidateEnrollment()
		}
	}()
}

func (s *AppService) revalidateEnrollment() {
	result, err := PollEnrollment(s.brand, s.state, version)
	if err != nil {
		return
	}
	if result.Status != EnrollmentApproved {
		s.onEnrollmentUpdate(result)
	}
}

func (s *AppService) updateStatus() {
	if !s.brand.HasConnection() {
		s.applyStatus(statusKindReady, t("status_ready"))
		return
	}
	status, _, _ := s.state.EnrollmentSnapshot()
	switch status {
	case EnrollmentPending:
		s.applyStatus(statusKindPending, t("enrollment_pending"))
		return
	case EnrollmentRejected:
		s.applyStatus(statusKindError, t("enrollment_rejected"))
		return
	case EnrollmentApproved:
		if s.state.IsEnrolled() && s.engine.Running() {
			s.applyStatus(statusKindConnected, t("connected"))
		} else if s.state.IsEnrolled() {
			s.applyStatus(statusKindPending, t("disconnected"))
		} else {
			s.applyStatus(statusKindPending, t("enrollment_pending"))
		}
		return
	}
	if s.engine.Running() {
		s.applyStatus(statusKindConnected, t("connected"))
	} else {
		s.applyStatus(statusKindReady, t("status_ready"))
	}
}

func (s *AppService) startSignalHost() {
	s.signalHostMu.Lock()
	defer s.signalHostMu.Unlock()
	if s.signalHost != nil {
		return
	}
	host, _ := newSignalHost(s.brand, s.state, false, signalHostCallbacks{
		consent: func(operator string) bool {
			return s.handleConsent("signal", operator)
		},
		audit: func(policy hostCapabilityPolicy) {
			auditHostCapabilityPolicy(hostCapabilityAuditTransportSignal, policy)
		},
		onSession: func(start bool, operator string) {
			if start {
				s.handleSessionStart("signal", operator, "signal")
			} else {
				s.handleSessionEnd("signal")
			}
		},
	})
	if host == nil {
		return
	}
	if !host.Start() {
		return
	}
	s.signalHost = host
}

func (s *AppService) stopSignalHost() {
	s.signalHostMu.Lock()
	defer s.signalHostMu.Unlock()
	if s.signalHost == nil {
		return
	}
	s.signalHost.Stop()
	s.signalHost = nil
}

func (s *AppService) disconnectSignalSessions() {
	s.signalHostMu.Lock()
	host := s.signalHost
	s.signalHostMu.Unlock()
	if host != nil {
		host.DisconnectSessions()
	}
}
