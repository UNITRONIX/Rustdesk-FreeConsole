package main

import (
	"log"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/unitronix/betterdesk-support-agent/signalhost"
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

	var hostMu sync.Mutex
	var host *signalhost.Host
	stopSignalHost := func() {
		hostMu.Lock()
		activeHost := host
		host = nil
		hostMu.Unlock()
		if activeHost != nil {
			activeHost.Stop()
		}
	}
	startSignalHost := func() {
		hostMu.Lock()
		if host != nil {
			hostMu.Unlock()
			return
		}
		hostMu.Unlock()

		candidate, reason := newSignalHost(brand, st, true, signalHostCallbacks{
			consent: func(operator string) bool {
				return headlessConsent(brand, st)("signal", operator)
			},
			audit: func(policy hostCapabilityPolicy) {
				auditHostCapabilityPolicy(hostCapabilityAuditTransportSignal, policy)
			},
		})
		if candidate == nil {
			log.Printf("[support-agent] headless RustDesk-compatible host disabled: %s", reason)
			return
		}
		if !candidate.Start() {
			log.Printf("[support-agent] headless RustDesk-compatible host disabled: access policy changed")
			return
		}

		hostMu.Lock()
		if host == nil {
			host = candidate
			candidate = nil
		}
		hostMu.Unlock()
		if candidate != nil {
			candidate.Stop()
			return
		}
		log.Printf("[support-agent] headless RustDesk-compatible host started")
	}

	if brand.HasConnection() {
		go headlessBootstrap(brand, st, engine, startSignalHost, stopSignalHost)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	log.Printf("[support-agent] shutting down")
	stopSignalHost()
	engine.Stop()
}

func headlessBootstrap(brand Branding, st *AppState, engine *Engine, onApproved, onRejected func()) {
	startApproved := func() {
		if err := SyncAccessPassword(brand, st); err != nil {
			log.Printf("[support-agent] access password sync: %v", err)
		}
		policy := accessPolicyFor(brand, st)
		if !policy.allowsSignalHost(true) {
			// A headless process has no trustworthy local consent surface.
			// Fail before registering the CDAP engine so supervised, disabled,
			// and passwordless modes cannot advertise an unreachable session.
			log.Printf("[support-agent] headless remote access disabled: %s", policy.signalHostDisabledReason(true))
			return
		}
		if !engine.Running() {
			if err := engine.Start(st); err != nil {
				log.Printf("[support-agent] engine start: %v", err)
				return
			}
		}
		if onApproved != nil {
			onApproved()
		}
		StartEnrollmentRevalidation(brand, st, version, enrollmentRevalidationInterval, func(result EnrollmentStatus) {
			if result.Status != EnrollmentRejected {
				return
			}
			log.Printf("[support-agent] enrollment revoked: %s", result.Message)
			if onRejected != nil {
				onRejected()
			}
			engine.Stop()
		})
	}

	res, err := EnsureEnrolled(brand, st, version)
	if err != nil {
		log.Printf("[support-agent] enrollment: %v", err)
		return
	}
	switch res.Status {
	case EnrollmentApproved:
		startApproved()
	case EnrollmentPending:
		log.Printf("[support-agent] enrollment pending: %s", res.Message)
		StartEnrollmentPoll(brand, st, version, 5*time.Second, func(u EnrollmentStatus) {
			if u.Status == EnrollmentApproved {
				startApproved()
			}
		})
	case EnrollmentRejected:
		log.Printf("[support-agent] enrollment rejected: %s", res.Message)
	}
}

func headlessConsent(brand Branding, st *AppState) func(string, string) bool {
	return func(sessionID, operator string) bool {
		policy := accessPolicyFor(brand, st)
		if policy.allowsUnattended() {
			log.Printf("[support-agent] headless consent auto-allow session=%s operator=%s", sessionID, operator)
			return true
		}
		if policy.mode == AccessDisabled {
			log.Printf("[support-agent] headless consent denied (access disabled) session=%s operator=%s", sessionID, operator)
			return false
		}
		log.Printf("[support-agent] headless consent denied (no approved unattended policy) session=%s operator=%s", sessionID, operator)
		return false
	}
}
