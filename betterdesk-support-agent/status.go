package main

import (
	"time"
)

const enrollmentRevalidationInterval = time.Minute

// startStatusLoop polls the engine connection state and refreshes the status
// label. In Fyne 2.5 widget setters are safe to call from a background
// goroutine, so the label is updated directly.
func (u *ui) startStatusLoop() {
	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()
		var lastEnrollmentCheck time.Time
		for range ticker.C {
			u.updateStatus()
			if !lastEnrollmentCheck.IsZero() &&
				time.Since(lastEnrollmentCheck) < enrollmentRevalidationInterval {
				continue
			}
			status, _, _ := u.state.EnrollmentSnapshot()
			if status != EnrollmentApproved || !u.brand.HasConnection() {
				continue
			}
			lastEnrollmentCheck = time.Now()
			go u.revalidateEnrollment()
		}
	}()
}

func (u *ui) revalidateEnrollment() {
	result, err := PollEnrollment(u.brand, u.state, version)
	if err != nil {
		// Retain the currently active enrollment on transient network failures;
		// a verified rejected/revoked response is handled below and fails closed.
		return
	}
	if result.Status != EnrollmentApproved {
		u.onEnrollmentUpdate(result)
	}
}

// updateStatus reflects enrollment and engine state in the status label and dot.
func (u *ui) updateStatus() {
	if u.statusLbl == nil {
		return
	}
	if !u.brand.HasConnection() {
		u.applyStatus(statusKindReady, t("status_ready"))
		return
	}
	status, _, _ := u.state.EnrollmentSnapshot()
	switch status {
	case EnrollmentPending:
		u.applyStatus(statusKindPending, t("enrollment_pending"))
		return
	case EnrollmentRejected:
		u.applyStatus(statusKindError, t("enrollment_rejected"))
		return
	case EnrollmentApproved:
		if u.state.IsEnrolled() && u.engine.Running() {
			u.applyStatus(statusKindConnected, t("connected"))
		} else if u.state.IsEnrolled() {
			u.applyStatus(statusKindPending, t("disconnected"))
		} else {
			u.applyStatus(statusKindPending, t("enrollment_pending"))
		}
		return
	}
	if u.engine.Running() {
		u.applyStatus(statusKindConnected, t("connected"))
	} else {
		u.applyStatus(statusKindReady, t("status_ready"))
	}
}
