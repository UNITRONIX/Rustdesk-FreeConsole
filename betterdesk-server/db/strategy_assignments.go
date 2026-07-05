package db

import "strings"

const (
	StrategyTargetPeer        = "peer"
	StrategyTargetUser        = "user"
	StrategyTargetDeviceGroup = "device_group"
)

// StrategyAssignmentSummary counts direct Pro-style strategy assignments.
type StrategyAssignmentSummary struct {
	PeerCount        int      `json:"peer_count"`
	UserCount        int      `json:"user_count"`
	DeviceGroupCount int      `json:"device_group_count"`
	Peers            []string `json:"peers,omitempty"`
	Users            []string `json:"users,omitempty"`
	Groups           []string `json:"groups,omitempty"`
}

// ProDeviceRef is the minimal device record for RustDesk Pro admin scripts.
type ProDeviceRef struct {
	ID   string `json:"id"`
	GUID string `json:"guid"`
}

func normalizeStrategyTargetType(t string) string {
	switch strings.ToLower(strings.TrimSpace(t)) {
	case StrategyTargetPeer, "peers", "device", "devices":
		return StrategyTargetPeer
	case StrategyTargetUser, "users":
		return StrategyTargetUser
	case StrategyTargetDeviceGroup, "group", "groups", "device_groups":
		return StrategyTargetDeviceGroup
	default:
		return ""
	}
}

func isUUIDLike(s string) bool {
	s = strings.TrimSpace(s)
	return len(s) == 36 && strings.Count(s, "-") == 4
}
