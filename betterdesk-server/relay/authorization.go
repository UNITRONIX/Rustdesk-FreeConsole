package relay

import (
	"sync"
	"time"

	"github.com/unitronix/betterdesk-server/config"
)

// AuthorizationRegistry permits exactly one relay pair for a UUID that signal
// has authorized. Relay traffic cannot carry an additional BetterDesk-specific
// credential without changing RustDesk's wire framing, so the signal server
// records the already-negotiated UUID here before either peer reaches relay.
type AuthorizationRegistry struct {
	mu      sync.Mutex
	tickets map[string]*relayAuthorization
	used    map[string]time.Time
	now     func() time.Time
}

type relayAuthorization struct {
	initiatorID string
	targetID    string
	expiresAt   time.Time
	claims      uint8
}

// NewAuthorizationRegistry creates an in-memory authorization store. Tickets
// are deliberately process-local: signal and relay run together in BetterDesk's
// all-in-one server mode, and no ticket is persisted across restarts.
func NewAuthorizationRegistry() *AuthorizationRegistry {
	return &AuthorizationRegistry{
		tickets: make(map[string]*relayAuthorization),
		used:    make(map[string]time.Time),
		now:     time.Now,
	}
}

// defaultAuthorizationRegistry is shared by the signal and relay packages in
// the all-in-one process. Keeping it package-owned avoids adding a token field
// to RustDesk's RequestRelay framing.
var defaultAuthorizationRegistry = NewAuthorizationRegistry()

// AuthorizeRelayPair records an authorized initiator/target pair for uuid.
// An active ticket may be retried only by the same pair. A consumed UUID cannot
// be re-authorized until its short expiry passes, preventing relay replay.
func AuthorizeRelayPair(uuid, initiatorID, targetID string) bool {
	return defaultAuthorizationRegistry.Authorize(uuid, initiatorID, targetID)
}

// RevokeRelayPairsForPeer removes unpaired tickets involving a banned peer.
func RevokeRelayPairsForPeer(peerID string) {
	defaultAuthorizationRegistry.RevokeForPeer(peerID)
}

func (r *AuthorizationRegistry) Authorize(uuid, initiatorID, targetID string) bool {
	if uuid == "" || initiatorID == "" || targetID == "" {
		return false
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	now := r.now()
	r.pruneLocked(now)
	if _, used := r.used[uuid]; used {
		return false
	}
	if ticket, exists := r.tickets[uuid]; exists {
		return ticket.initiatorID == initiatorID && ticket.targetID == targetID
	}
	r.tickets[uuid] = &relayAuthorization{
		initiatorID: initiatorID,
		targetID:    targetID,
		expiresAt:   now.Add(config.RelayPairTimeout),
	}
	return true
}

// Claim reserves one of the two connections needed for an authorized relay
// pair. The second successful claim consumes the ticket permanently.
func (r *AuthorizationRegistry) Claim(uuid string) bool {
	if uuid == "" {
		return false
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	now := r.now()
	r.pruneLocked(now)
	ticket := r.tickets[uuid]
	if ticket == nil || ticket.claims >= 2 {
		return false
	}
	ticket.claims++
	if ticket.claims == 2 {
		delete(r.tickets, uuid)
		r.used[uuid] = ticket.expiresAt
	}
	return true
}

// Release returns a first claim to the ticket when its pending relay
// connection times out before a second peer arrives.
func (r *AuthorizationRegistry) Release(uuid string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := r.now()
	r.pruneLocked(now)
	if ticket := r.tickets[uuid]; ticket != nil && ticket.claims > 0 {
		ticket.claims--
	}
}

// RevokeForPeer invalidates all unpaired relay tickets involving peerID.
// Consumed tickets remain tombstoned until expiry so a UUID cannot be replayed.
func (r *AuthorizationRegistry) RevokeForPeer(peerID string) {
	if peerID == "" {
		return
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	now := r.now()
	r.pruneLocked(now)
	for uuid, ticket := range r.tickets {
		if ticket.initiatorID == peerID || ticket.targetID == peerID {
			delete(r.tickets, uuid)
			r.used[uuid] = ticket.expiresAt
		}
	}
}

func (r *AuthorizationRegistry) pruneLocked(now time.Time) {
	for uuid, ticket := range r.tickets {
		if !ticket.expiresAt.After(now) {
			delete(r.tickets, uuid)
		}
	}
	for uuid, expiresAt := range r.used {
		if !expiresAt.After(now) {
			delete(r.used, uuid)
		}
	}
}
