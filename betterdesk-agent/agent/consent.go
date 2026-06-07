package agent

import (
	"fmt"
	"log"
	"os"
	"time"
)

// requestRemoteConsent asks the embedded UI (or stdin reader) before allowing
// remote control features. Returns true when consent is not required.
func (a *Agent) requestRemoteConsent(sessionID, operator, feature string) bool {
	if !a.cfg.RequireConsent {
		return true
	}
	if operator == "" {
		operator = "operator"
	}
	if a.cfg.ConsentHandler != nil {
		granted := a.cfg.ConsentHandler(sessionID, operator)
		if !granted {
			log.Printf("[%s] Consent denied for session %s", feature, sessionID)
		}
		return granted
	}
	granted := a.waitStdinConsent(sessionID, operator)
	if !granted {
		log.Printf("[%s] Consent denied for session %s", feature, sessionID)
	}
	return granted
}

func (a *Agent) waitStdinConsent(sessionID, operator string) bool {
	ch := make(chan bool, 1)
	a.consentWaiters.Store(sessionID, ch)

	fmt.Fprintf(os.Stdout, "CONSENT_REQUEST:{\"session_id\":%q,\"operator\":%q}\n",
		sessionID, operator)

	timer := time.NewTimer(30 * time.Second)
	var granted bool
	select {
	case granted = <-ch:
	case <-timer.C:
		granted = false
	case <-a.ctx.Done():
		a.consentWaiters.Delete(sessionID)
		timer.Stop()
		return false
	}
	timer.Stop()
	a.consentWaiters.Delete(sessionID)
	return granted
}

func (a *Agent) hasActiveDesktopStream(sessionID string) bool {
	if sessionID == "" {
		found := false
		a.desktopStreams.Range(func(_, _ any) bool {
			found = true
			return false
		})
		return found
	}
	_, ok := a.desktopStreams.Load(sessionID)
	return ok
}
