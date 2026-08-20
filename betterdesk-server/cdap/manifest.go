package cdap

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Manifest describes a CDAP device's capabilities, identity, and widget definitions.
type Manifest struct {
	ManifestVersion   string         `json:"manifest_version"` // "1.0"
	Device            ManifestDevice `json:"device"`
	Bridge            ManifestBridge `json:"bridge,omitempty"`
	Capabilities      []string       `json:"capabilities"`       // telemetry, commands, alerts, logs, ...
	HeartbeatInterval int            `json:"heartbeat_interval"` // seconds (default 15, max 300)
	Widgets           []Widget       `json:"widgets,omitempty"`
	Alerts            []AlertDef     `json:"alerts,omitempty"`
}

// ManifestDevice describes the physical/virtual device identity.
type ManifestDevice struct {
	Name         string   `json:"name"`
	Type         string   `json:"type"` // scada, iot, os_agent, network, camera, desktop, custom
	Vendor       string   `json:"vendor,omitempty"`
	Model        string   `json:"model,omitempty"`
	Firmware     string   `json:"firmware,omitempty"`
	Serial       string   `json:"serial,omitempty"`
	Location     string   `json:"location,omitempty"`
	Tags         []string `json:"tags,omitempty"`
	Icon         string   `json:"icon,omitempty"`
	Description  string   `json:"description,omitempty"`
	LinkedPeerID string   `json:"linked_peer_id,omitempty"` // RustDesk peer ID to link this CDAP device with
}

// ManifestBridge describes the bridge software connecting the device to CDAP.
type ManifestBridge struct {
	Name       string `json:"name,omitempty"`
	Version    string `json:"version,omitempty"`
	Protocol   string `json:"protocol,omitempty"`
	TargetHost string `json:"target_host,omitempty"`
	TargetPort int    `json:"target_port,omitempty"`
}

// Widget represents a single control/display element on the device.
type Widget struct {
	Type     string `json:"type"` // toggle, gauge, button, led, chart, select, slider, text, table, terminal, desktop, video_stream, file_browser
	ID       string `json:"id"`
	Label    string `json:"label"`
	Group    string `json:"group,omitempty"` // collapsible group name
	Value    any    `json:"value,omitempty"` // initial value
	Readonly bool   `json:"readonly,omitempty"`

	// Gauge/Slider fields
	Unit        string  `json:"unit,omitempty"`
	Min         float64 `json:"min,omitempty"`
	Max         float64 `json:"max,omitempty"`
	Step        float64 `json:"step,omitempty"`
	Precision   int     `json:"precision,omitempty"`
	WarningLow  float64 `json:"warning_low,omitempty"`
	WarningHigh float64 `json:"warning_high,omitempty"`

	// Button fields
	Confirm        bool   `json:"confirm,omitempty"`
	ConfirmMessage string `json:"confirm_message,omitempty"`
	Style          string `json:"style,omitempty"` // primary, danger, etc.
	Icon           string `json:"icon,omitempty"`
	Cooldown       int    `json:"cooldown,omitempty"` // seconds

	// Select fields
	Options []WidgetOption `json:"options,omitempty"`

	// Chart fields
	ChartType string        `json:"chart_type,omitempty"` // line, bar, area
	Points    int           `json:"points,omitempty"`
	Series    []ChartSeries `json:"series,omitempty"`
	Retention string        `json:"retention,omitempty"` // 24h, 7d, etc.

	// Table fields
	Columns  []TableColumn `json:"columns,omitempty"`
	MaxRows  int           `json:"max_rows,omitempty"`
	Sortable bool          `json:"sortable,omitempty"`

	// RBAC permissions (optional, defaults applied if nil)
	Permissions *WidgetPermissions `json:"permissions,omitempty"`
}

// WidgetOption for select widgets.
type WidgetOption struct {
	Label string `json:"label"`
	Value any    `json:"value"`
}

// ChartSeries for chart widgets.
type ChartSeries struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Color string `json:"color,omitempty"`
	Unit  string `json:"unit,omitempty"`
}

// TableColumn for table widgets.
type TableColumn struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Type  string `json:"type,omitempty"` // string, number, boolean, date
}

// WidgetPermissions defines per-widget RBAC rules.
// Each field names the minimum role required for that operation class.
// Valid roles: "admin", "operator", "viewer".  Empty string means unrestricted.
type WidgetPermissions struct {
	Read    string `json:"read,omitempty"`    // required role to see widget state (default: viewer)
	Control string `json:"control,omitempty"` // required role for set/trigger/reset (default: operator)
	Execute string `json:"execute,omitempty"` // required role for execute action (default: admin)
}

// AlertDef defines a threshold-based alert.
type AlertDef struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Severity  string `json:"severity"`  // critical, warning, info
	Condition string `json:"condition"` // expression string
	Message   string `json:"message"`
}

// Allowed device types.
var allowedDeviceTypes = map[string]bool{
	"scada":    true,
	"iot":      true,
	"os_agent": true,
	"network":  true,
	"camera":   true,
	"desktop":  true,
	"custom":   true,
}

// Allowed widget types.
var allowedWidgetTypes = map[string]bool{
	"toggle":       true,
	"gauge":        true,
	"button":       true,
	"led":          true,
	"chart":        true,
	"select":       true,
	"slider":       true,
	"text":         true,
	"table":        true,
	"terminal":     true,
	"desktop":      true,
	"video_stream": true,
	"file_browser": true,
}

// Allowed capabilities.
var allowedCapabilities = map[string]bool{
	"telemetry":         true,
	"commands":          true,
	"alerts":            true,
	"logs":              true,
	"remote_desktop":    true,
	"video_stream":      true,
	"audio":             true,
	"clipboard":         true,
	"file_transfer":     true,
	"input_control":     true,
	"keyboard_input":    true,
	"mouse_input":       true,
	"multi_monitor":     true,
	"unattended_access": true,
}

// maxWidgets is the hard limit on widget count per device.
const maxWidgets = 200

// roleLevel maps a role name to a numeric authority level.
// Higher number = more privilege.
var roleLevel = map[string]int{
	"viewer":   1,
	"operator": 2,
	"admin":    3,
}

// RoleLevel returns the numeric authority level for a role name.
// Returns 0 for unknown roles.
func RoleLevel(role string) int {
	return roleLevel[role]
}

// allowedRoles is used for validation of permission fields.
var allowedRoles = map[string]bool{
	"admin":    true,
	"operator": true,
	"viewer":   true,
}

// dangerousWidgetTypes default to admin-level execute permission.
var dangerousWidgetTypes = map[string]bool{
	"terminal":     true,
	"desktop":      true,
	"file_browser": true,
}

// DefaultPermissions returns the default RBAC permissions for a widget type.
func DefaultPermissions(widgetType string) *WidgetPermissions {
	p := &WidgetPermissions{
		Read:    "viewer",
		Control: "operator",
		Execute: "operator",
	}
	if dangerousWidgetTypes[widgetType] {
		p.Control = "admin"
		p.Execute = "admin"
	}
	return p
}

// EffectivePermissions returns the permissions for a widget,
// using explicit values when set and defaults otherwise.
func EffectivePermissions(w *Widget) *WidgetPermissions {
	def := DefaultPermissions(w.Type)
	if w.Permissions == nil {
		return def
	}
	p := *w.Permissions
	if p.Read == "" {
		p.Read = def.Read
	}
	if p.Control == "" {
		p.Control = def.Control
	}
	if p.Execute == "" {
		p.Execute = def.Execute
	}
	return &p
}

// actionPermissionType maps a command action to the permission class it requires.
func actionPermissionType(action string) string {
	switch action {
	case "query":
		return "read"
	case "execute":
		return "execute"
	default: // set, trigger, reset
		return "control"
	}
}

// CheckWidgetPermission returns true if the given role has sufficient
// privilege to perform the specified action on the widget.
func CheckWidgetPermission(role, action string, w *Widget) bool {
	perm := EffectivePermissions(w)
	permType := actionPermissionType(action)

	var requiredRole string
	switch permType {
	case "read":
		requiredRole = perm.Read
	case "execute":
		requiredRole = perm.Execute
	default:
		requiredRole = perm.Control
	}

	userLevel := roleLevel[role]
	requiredLevel := roleLevel[requiredRole]
	return userLevel >= requiredLevel
}

// ParseManifest parses and validates a CDAP device manifest from raw JSON.
func ParseManifest(data json.RawMessage) (*Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("parse manifest: %w", err)
	}
	if err := ValidateManifest(&m); err != nil {
		return nil, err
	}
	return &m, nil
}

// ValidateManifest checks that a manifest is well-formed.
func ValidateManifest(m *Manifest) error {
	if m.ManifestVersion == "" {
		m.ManifestVersion = "1.0"
	}
	if m.ManifestVersion != "1.0" {
		return fmt.Errorf("unsupported manifest version: %s", m.ManifestVersion)
	}

	// Device name required
	m.Device.Name = strings.TrimSpace(m.Device.Name)
	if m.Device.Name == "" {
		return fmt.Errorf("device name is required")
	}
	if len(m.Device.Name) > 128 {
		return fmt.Errorf("device name too long (max 128 chars)")
	}

	// Device type validation
	m.Device.Type = strings.ToLower(strings.TrimSpace(m.Device.Type))
	if m.Device.Type == "" {
		m.Device.Type = "custom"
	}
	if !allowedDeviceTypes[m.Device.Type] {
		return fmt.Errorf("invalid device type: %s", m.Device.Type)
	}

	// Heartbeat interval bounds
	if m.HeartbeatInterval <= 0 {
		m.HeartbeatInterval = 15
	}
	if m.HeartbeatInterval > 300 {
		m.HeartbeatInterval = 300
	}

	// Capabilities validation
	for _, cap := range m.Capabilities {
		if !allowedCapabilities[strings.ToLower(cap)] {
			return fmt.Errorf("unknown capability: %s", cap)
		}
	}

	// Widget validation
	if len(m.Widgets) > maxWidgets {
		return fmt.Errorf("too many widgets (%d, max %d)", len(m.Widgets), maxWidgets)
	}

	widgetIDs := make(map[string]bool, len(m.Widgets))
	for i := range m.Widgets {
		w := &m.Widgets[i]
		w.Type = strings.ToLower(strings.TrimSpace(w.Type))
		if !allowedWidgetTypes[w.Type] {
			return fmt.Errorf("widget %d: invalid type: %s", i, w.Type)
		}
		w.ID = strings.TrimSpace(w.ID)
		if w.ID == "" {
			return fmt.Errorf("widget %d: id is required", i)
		}
		if len(w.ID) > 64 {
			return fmt.Errorf("widget %d: id too long (max 64 chars)", i)
		}
		if widgetIDs[w.ID] {
			return fmt.Errorf("widget %d: duplicate id: %s", i, w.ID)
		}
		widgetIDs[w.ID] = true

		w.Label = strings.TrimSpace(w.Label)
		if w.Label == "" {
			w.Label = w.ID
		}

		// Permission field validation
		if w.Permissions != nil {
			for _, rv := range []struct{ name, val string }{
				{"read", w.Permissions.Read},
				{"control", w.Permissions.Control},
				{"execute", w.Permissions.Execute},
			} {
				if rv.val != "" && !allowedRoles[rv.val] {
					return fmt.Errorf("widget %s: invalid permission role for %s: %s", w.ID, rv.name, rv.val)
				}
			}
		}
	}

	// Alert validation
	alertIDs := make(map[string]bool, len(m.Alerts))
	for i := range m.Alerts {
		a := &m.Alerts[i]
		a.ID = strings.TrimSpace(a.ID)
		if a.ID == "" {
			return fmt.Errorf("alert %d: id is required", i)
		}
		if alertIDs[a.ID] {
			return fmt.Errorf("alert %d: duplicate id: %s", i, a.ID)
		}
		alertIDs[a.ID] = true

		a.Severity = strings.ToLower(strings.TrimSpace(a.Severity))
		if a.Severity != "critical" && a.Severity != "warning" && a.Severity != "info" {
			return fmt.Errorf("alert %d: invalid severity: %s", i, a.Severity)
		}
	}

	// Tags: max 20 tags, max 64 chars each
	if len(m.Device.Tags) > 20 {
		return fmt.Errorf("too many device tags (%d, max 20)", len(m.Device.Tags))
	}
	for i, tag := range m.Device.Tags {
		if len(tag) > 64 {
			return fmt.Errorf("device tag %d too long (max 64 chars)", i)
		}
	}

	return nil
}
