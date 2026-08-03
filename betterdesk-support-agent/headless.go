package main

import (
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// runHeadless starts enrollment and the remote engine without a Fyne window.
// Use on Windows hosts without OpenGL/WGL (common in VMs and some RDP sessions).
func runHeadless() {
	brand := GetBranding()

	st, err := LoadState()
	if err != nil {
		log.Fatalf("[support-agent] state: %v", err)
	}
	setLang(st.Language)

	engine := NewEngine(version)
	engine.SetCallbacks(headlessConsent(brand, st), func(string, string, string) {}, func(string) {})

	log.Printf("[support-agent] %s starting headless (device=%s)", version, st.DeviceID)

	if brand.HasConnection() {
		go headlessBootstrap(brand, st, engine)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	log.Printf("[support-agent] shutting down")
	engine.Stop()
}

func headlessBootstrap(brand Branding, st *AppState, engine *Engine) {
	res, err := EnsureEnrolled(brand, st, version)
	if err != nil {
		log.Printf("[support-agent] enrollment: %v", err)
		return
	}
	switch res.Status {
	case EnrollmentApproved:
		if err := engine.Start(st); err != nil {
			log.Printf("[support-agent] engine start: %v", err)
			return
		}
		_ = PullAccessPolicy(brand, st)
		_ = SyncAccessPassword(brand, st)
		go startAccessPolicyPullLoop(brand, st)
	case EnrollmentPending:
		log.Printf("[support-agent] enrollment pending: %s", res.Message)
		StartEnrollmentPoll(brand, st, version, 5*time.Second, func(u EnrollmentStatus) {
			if u.Status == EnrollmentApproved && !engine.Running() {
				_ = engine.Start(st)
				_ = PullAccessPolicy(brand, st)
				_ = SyncAccessPassword(brand, st)
				go startAccessPolicyPullLoop(brand, st)
			}
		})
	case EnrollmentRejected:
		log.Printf("[support-agent] enrollment rejected: %s", res.Message)
	}
}

func headlessConsent(brand Branding, st *AppState) func(string, string) bool {
	return func(sessionID, operator string) bool {
		mode, _, _, _ := st.Snapshot()
		if brand.AllowUnattended || mode == AccessUnattended {
			log.Printf("[support-agent] headless consent auto-allow session=%s operator=%s", sessionID, operator)
			return true
		}
		log.Printf("[support-agent] headless consent denied (supervised, no UI) session=%s operator=%s", sessionID, operator)
		return false
	}
}
