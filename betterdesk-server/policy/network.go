// Package policy resolves organization network policies for signal routing.
package policy

import (
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/unitronix/betterdesk-server/db"
)

const networkPolicyKey = "policy_network"

// NetworkSettings is stored JSON under org_settings policy_network.
type NetworkSettings struct {
	BlockDirectP2P      bool     `json:"block_direct_p2p"`
	AllowedRelayServers []string `json:"allowed_relay_servers"`
	IPAllowlist         []string `json:"ip_allowlist"`
}

type cachedEntry struct {
	settings NetworkSettings
	expires  time.Time
}

// NetworkResolver loads and caches org network policy for signal decisions.
type NetworkResolver struct {
	db  db.Database
	mu  sync.Mutex
	org map[string]cachedEntry
	dev map[string]cachedEntry
	ttl time.Duration
}

// NewNetworkResolver creates a resolver with a 60s TTL cache.
func NewNetworkResolver(database db.Database) *NetworkResolver {
	return &NetworkResolver{
		db:  database,
		org: make(map[string]cachedEntry),
		dev: make(map[string]cachedEntry),
		ttl: 60 * time.Second,
	}
}

func (r *NetworkResolver) settingsForOrg(orgID string) NetworkSettings {
	if orgID == "" {
		return NetworkSettings{}
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if ce, ok := r.org[orgID]; ok && time.Now().Before(ce.expires) {
		return ce.settings
	}

	settings := NetworkSettings{}
	raw, err := r.db.GetOrgSetting(orgID, networkPolicyKey)
	if err == nil && raw != "" {
		_ = json.Unmarshal([]byte(raw), &settings)
	}
	r.org[orgID] = cachedEntry{settings: settings, expires: time.Now().Add(r.ttl)}
	return settings
}

// SettingsForDevice returns effective network policy for a registered device.
func (r *NetworkResolver) SettingsForDevice(deviceID string) NetworkSettings {
	if deviceID == "" {
		return NetworkSettings{}
	}

	r.mu.Lock()
	if ce, ok := r.dev[deviceID]; ok && time.Now().Before(ce.expires) {
		s := ce.settings
		r.mu.Unlock()
		return s
	}
	r.mu.Unlock()

	orgID, _ := r.db.GetDeviceOrgID(deviceID)
	settings := r.settingsForOrg(orgID)

	r.mu.Lock()
	r.dev[deviceID] = cachedEntry{settings: settings, expires: time.Now().Add(r.ttl)}
	r.mu.Unlock()
	return settings
}

// ShouldForceRelay returns true when any listed device belongs to an org with block_direct_p2p.
func (r *NetworkResolver) ShouldForceRelay(deviceIDs ...string) bool {
	for _, id := range deviceIDs {
		if id == "" {
			continue
		}
		if r.SettingsForDevice(id).BlockDirectP2P {
			return true
		}
	}
	return false
}

// ResolveRelay picks a relay address allowed by org policy when an allowlist is configured.
func (r *NetworkResolver) ResolveRelay(defaultRelay string, deviceIDs ...string) string {
	var allowed []string
	for _, id := range deviceIDs {
		if id == "" {
			continue
		}
		s := r.SettingsForDevice(id)
		if len(s.AllowedRelayServers) > 0 {
			allowed = s.AllowedRelayServers
			break
		}
	}
	if len(allowed) == 0 {
		return defaultRelay
	}

	normalizedDefault := strings.TrimSpace(defaultRelay)
	for _, entry := range allowed {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		if entry == normalizedDefault {
			return defaultRelay
		}
		if normalizedDefault != "" && strings.HasPrefix(normalizedDefault, entry) {
			return defaultRelay
		}
	}
	return strings.TrimSpace(allowed[0])
}

// InvalidateOrg drops cached org/device entries after policy updates.
func (r *NetworkResolver) InvalidateOrg(orgID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.org, orgID)
	for devID, _ := range r.dev {
		delete(r.dev, devID)
	}
}
