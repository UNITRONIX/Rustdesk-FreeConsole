// Package audit provides structured audit logging for admin-visible operations.
// Each event is recorded with a timestamp, actor, action type, and details.
// Events are stored in memory (ring buffer) and optionally written to a file.
package audit

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"
)

// Action represents the type of auditable operation.
type Action string

const (
	ActionPeerBanned       Action = "peer_banned"
	ActionPeerUnbanned     Action = "peer_unbanned"
	ActionPeerDeleted      Action = "peer_deleted"
	ActionPeerRevoked      Action = "peer_revoked"
	ActionPeerRestored     Action = "peer_restored"
	ActionPeerUpdated      Action = "peer_updated"
	ActionPeerIDChanged    Action = "peer_id_changed"
	ActionPeerTagsUpdated  Action = "peer_tags_updated"
	// ActionEnrollmentPending is logged when an unknown device is placed into
	// the pending enrollment queue (managed mode) awaiting operator approval.
	ActionEnrollmentPending Action = "enrollment_pending"
	// ActionPeerRegistrationRejected is logged when a registration attempt is
	// rejected by the signal server (soft-deleted, banned, blocklisted,
	// enrollment policy, renamed ID). Used for forensic visibility of
	// attempted identity replays (GHSA-3v82-3gf8-fxx8). The "reason" field
	// in details carries the specific cause.
	ActionPeerRegistrationRejected Action = "peer_registration_rejected"
	// ActionConnectionDenied is logged when PunchHole/RequestRelay is refused
	// because the initiator is not an authorized/enrolled peer (#302).
	ActionConnectionDenied Action = "connection_denied"
	ActionBlocklistAdd     Action = "blocklist_add"
	ActionBlocklistRemove  Action = "blocklist_remove"
	ActionConfigChanged    Action = "config_changed"
	ActionAdminLogin       Action = "admin_login"
	ActionServerStart      Action = "server_start"
	ActionServerStop       Action = "server_stop"
	ActionBlocklistReload  Action = "blocklist_reload"
	ActionStatusTransition Action = "status_transition"
	ActionAuthLogin        Action = "auth_login"
	ActionAuthLoginFailed  Action = "auth_login_failed"
	ActionUserCreated      Action = "user_created"
	ActionUserUpdated      Action = "user_updated"
	ActionUserDeleted      Action = "user_deleted"
	ActionAPIKeyCreated    Action = "apikey_created"
	ActionAPIKeyRevoked    Action = "apikey_revoked"
	ActionSysinfoUpdated   Action = "sysinfo_updated"
	ActionSysinfoError     Action = "sysinfo_error"
	// Help requests and chat (raised by agent devices via CDAP).
	ActionHelpRequestCreated Action = "help_request_created"
	ActionHelpRequestUpdated Action = "help_request_updated"
	ActionChatMessage        Action = "chat_message"
)

// Event represents a single audit log entry.
type Event struct {
	Timestamp time.Time         `json:"timestamp"`
	Action    Action            `json:"action"`
	Actor     string            `json:"actor"` // "api", "admin", "system", IP address, etc.
	Target    string            `json:"target,omitempty"`
	Details   map[string]string `json:"details,omitempty"`
}

// Logger is the audit event logger.
// It maintains a ring buffer of recent events and optionally writes to a file.
type Logger struct {
	mu       sync.RWMutex
	events   []Event
	maxSize  int // ring buffer capacity
	cursor   int // next write position
	total    int64
	file     *os.File
	filePath string
}

const defaultMaxEvents = 10000
const maxRecentLimit = 500

// NewLogger creates a new audit logger.
// If filePath is non-empty, events are also appended to that file as JSON lines.
func NewLogger(filePath string) *Logger {
	l := &Logger{
		events:   make([]Event, defaultMaxEvents),
		maxSize:  defaultMaxEvents,
		filePath: filePath,
	}

	if filePath != "" {
		f, err := os.OpenFile(filePath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
		if err != nil {
			log.Printf("[audit] Failed to open audit log file %s: %v", filePath, err)
		} else {
			l.file = f
		}
	}

	return l
}

// Log records an audit event.
func (l *Logger) Log(action Action, actor, target string, details map[string]string) {
	event := Event{
		Timestamp: time.Now(),
		Action:    action,
		Actor:     actor,
		Target:    target,
		Details:   details,
	}

	l.mu.Lock()
	l.events[l.cursor] = event
	l.cursor = (l.cursor + 1) % l.maxSize
	l.total++

	// Write to file if configured (inside lock to prevent interleaved writes)
	if l.file != nil {
		data, err := json.Marshal(event)
		if err == nil {
			l.file.Write(append(data, '\n'))
		}
	}
	l.mu.Unlock()

	log.Printf("[audit] %s actor=%s target=%s %v", action, actor, target, redactDetailsForLog(details))
}

func redactDetailsForLog(details map[string]string) map[string]string {
	if len(details) == 0 {
		return nil
	}
	out := make(map[string]string, len(details))
	for k, v := range details {
		lk := strings.ToLower(k)
		if strings.Contains(lk, "password") || strings.Contains(lk, "secret") ||
			strings.Contains(lk, "token") || strings.Contains(lk, "api_key") || lk == "key" {
			out[k] = "***"
		} else {
			out[k] = v
		}
	}
	return out
}

func clampRecentLimit(n int) int {
	if n <= 0 {
		return 0
	}
	if n > maxRecentLimit {
		return maxRecentLimit
	}
	return n
}

// Recent returns the most recent n events (newest first).
func (l *Logger) Recent(n int) []Event {
	l.mu.RLock()
	defer l.mu.RUnlock()

	n = clampRecentLimit(n)
	count := int(l.total)
	if count > l.maxSize {
		count = l.maxSize
	}
	if n > count {
		n = count
	}
	if n <= 0 {
		return nil
	}

	result := make([]Event, n)
	for i := 0; i < n; i++ {
		idx := (l.cursor - 1 - i + l.maxSize) % l.maxSize
		result[i] = l.events[idx]
	}
	return result
}

// RecentByAction returns the most recent n events filtered by action type.
func (l *Logger) RecentByAction(action Action, n int) []Event {
	l.mu.RLock()
	defer l.mu.RUnlock()

	n = clampRecentLimit(n)
	count := int(l.total)
	if count > l.maxSize {
		count = l.maxSize
	}

	result := make([]Event, 0, n)
	for i := 0; i < count && len(result) < n; i++ {
		idx := (l.cursor - 1 - i + l.maxSize) % l.maxSize
		if l.events[idx].Action == action {
			result = append(result, l.events[idx])
		}
	}
	return result
}

// Total returns the total number of events logged since start.
func (l *Logger) Total() int64 {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.total
}

// Close flushes and closes the audit log file.
func (l *Logger) Close() error {
	if l.file != nil {
		return l.file.Close()
	}
	return nil
}

// String returns a human-readable summary.
func (l *Logger) String() string {
	return fmt.Sprintf("AuditLogger(total=%d, file=%s)", l.Total(), l.filePath)
}
