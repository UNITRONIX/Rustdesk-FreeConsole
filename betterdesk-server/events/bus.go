// Package events provides a publish-subscribe event bus for real-time notifications.
// Admin clients can connect via WebSocket to receive live status changes, bans,
// blocklist updates, and other server events as they happen.
package events

import (
	"encoding/json"
	"log"
	"sync"
	"time"
)

// EventType identifies the kind of event being broadcast.
type EventType string

const (
	EventPeerOnline      EventType = "peer_online"
	EventPeerDegraded    EventType = "peer_degraded"
	EventPeerCritical    EventType = "peer_critical"
	EventPeerOffline     EventType = "peer_offline"
	EventPeerBanned      EventType = "peer_banned"
	EventPeerUnbanned    EventType = "peer_unbanned"
	EventPeerDeleted     EventType = "peer_deleted"
	EventPeerRevoked     EventType = "peer_revoked"
	EventPeerRestored    EventType = "peer_restored"
	EventPeerIDChanged   EventType = "peer_id_changed"
	EventBlocklistAdd    EventType = "blocklist_add"
	EventBlocklistRemove EventType = "blocklist_remove"
	EventServerStats     EventType = "server_stats"
)

// Event is a single notification pushed to subscribers.
type Event struct {
	Type      EventType         `json:"type"`
	Timestamp time.Time         `json:"timestamp"`
	Data      map[string]string `json:"data,omitempty"`
}

// Subscriber is a channel that receives events.
type Subscriber struct {
	Ch     chan Event
	Filter EventType // empty string = all events
	id     int64
}

// Bus is the central event bus for broadcasting events to subscribers.
type Bus struct {
	mu          sync.RWMutex
	subscribers map[int64]*Subscriber
	nextID      int64
}

// NewBus creates a new event bus.
func NewBus() *Bus {
	return &Bus{
		subscribers: make(map[int64]*Subscriber),
	}
}

// Subscribe registers a new subscriber. If filter is non-empty, only events
// matching that type will be sent. The returned Subscriber should be closed
// with Unsubscribe when done.
func (b *Bus) Subscribe(filter EventType) *Subscriber {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.nextID++
	sub := &Subscriber{
		Ch:     make(chan Event, 64), // buffered to avoid blocking publishers
		Filter: filter,
		id:     b.nextID,
	}
	b.subscribers[sub.id] = sub
	return sub
}

// Unsubscribe removes a subscriber from the bus and closes its channel.
func (b *Bus) Unsubscribe(sub *Subscriber) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if _, ok := b.subscribers[sub.id]; ok {
		delete(b.subscribers, sub.id)
		close(sub.Ch)
	}
}

// Publish sends an event to all matching subscribers.
// Non-blocking: if a subscriber's channel is full, the event is dropped for that subscriber.
func (b *Bus) Publish(evt Event) {
	evt.Timestamp = time.Now()

	b.mu.RLock()
	defer b.mu.RUnlock()

	for _, sub := range b.subscribers {
		if sub.Filter != "" && sub.Filter != evt.Type {
			continue
		}
		select {
		case sub.Ch <- evt:
		default:
			// Subscriber is slow — drop event to avoid blocking
			log.Printf("[events] Dropped event %s for slow subscriber %d", evt.Type, sub.id)
		}
	}
}

// Count returns the number of active subscribers.
func (b *Bus) Count() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.subscribers)
}

// MarshalEvent serializes an event to JSON bytes.
func MarshalEvent(evt Event) []byte {
	data, _ := json.Marshal(evt)
	return data
}
