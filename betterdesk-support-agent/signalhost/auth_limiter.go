package signalhost

import (
	"strings"
	"sync"
	"time"
)

const (
	authFailureWindow  = 5 * time.Minute
	authLockoutPeriod  = 15 * time.Minute
	maxAuthFailures    = 5
	maxTrackedAuthKeys = 1024
)

type authenticationAttempt struct {
	failures    int
	windowStart time.Time
	lockedUntil time.Time
	lastSeen    time.Time
}

// authenticationLimiter bounds repeated credential failures without retaining
// credentials, TOTP values, or session contents. RustDesk-compatible relay
// handshakes do not expose an end-client address to the host, so keys use the
// claimed operator identity and the map is deliberately bounded.
type authenticationLimiter struct {
	mu       sync.Mutex
	now      func() time.Time
	attempts map[string]authenticationAttempt
}

func newAuthenticationLimiter(now func() time.Time) *authenticationLimiter {
	if now == nil {
		now = time.Now
	}
	return &authenticationLimiter{
		now:      now,
		attempts: make(map[string]authenticationAttempt),
	}
}

func (l *authenticationLimiter) allow(operator string) bool {
	if l == nil {
		return true
	}
	key := authenticationAttemptKey(operator)
	now := l.now()

	l.mu.Lock()
	defer l.mu.Unlock()
	l.pruneLocked(now)
	entry, ok := l.attempts[key]
	if !ok {
		return true
	}
	entry.lastSeen = now
	l.attempts[key] = entry
	return entry.lockedUntil.IsZero() || !now.Before(entry.lockedUntil)
}

func (l *authenticationLimiter) failure(operator string) {
	if l == nil {
		return
	}
	key := authenticationAttemptKey(operator)
	now := l.now()

	l.mu.Lock()
	defer l.mu.Unlock()
	l.pruneLocked(now)
	entry := l.attempts[key]
	if entry.windowStart.IsZero() || now.Sub(entry.windowStart) >= authFailureWindow {
		entry.failures = 0
		entry.windowStart = now
	}
	entry.failures++
	entry.lastSeen = now
	if entry.failures >= maxAuthFailures {
		entry.lockedUntil = now.Add(authLockoutPeriod)
		entry.failures = 0
		entry.windowStart = now
	}
	l.attempts[key] = entry
}

func (l *authenticationLimiter) success(operator string) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, authenticationAttemptKey(operator))
}

func (l *authenticationLimiter) pruneLocked(now time.Time) {
	for key, entry := range l.attempts {
		if now.Sub(entry.lastSeen) > authLockoutPeriod+authFailureWindow {
			delete(l.attempts, key)
		}
	}
	for len(l.attempts) >= maxTrackedAuthKeys {
		var oldestKey string
		var oldest time.Time
		for key, entry := range l.attempts {
			if oldestKey == "" || entry.lastSeen.Before(oldest) {
				oldestKey = key
				oldest = entry.lastSeen
			}
		}
		if oldestKey == "" {
			return
		}
		delete(l.attempts, oldestKey)
	}
}

func authenticationAttemptKey(operator string) string {
	operator = strings.TrimSpace(operator)
	if operator == "" {
		return "anonymous"
	}
	if len(operator) > 128 {
		operator = operator[:128]
	}
	return operator
}
