package db

import "time"

// DeviceOnlineSession is one server-observed device presence interval.
// EndedAt is nil while the server still considers the device online.
type DeviceOnlineSession struct {
	ID         int64      `json:"id"`
	PeerID     string     `json:"peer_id"`
	StartedAt  time.Time  `json:"started_at"`
	LastSeenAt time.Time  `json:"last_seen_at"`
	EndedAt    *time.Time `json:"ended_at,omitempty"`
	EndReason  string     `json:"end_reason,omitempty"`
}

// DeviceOnlineSessionFilter selects sessions that overlap [From, To).
// An empty PeerIDs slice includes every device.
type DeviceOnlineSessionFilter struct {
	PeerIDs []string
	From    time.Time
	To      time.Time
}
