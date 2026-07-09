package db

import "time"

// Billing package / contract target types.
const (
	BillingTargetOrg         = "org"
	BillingTargetDeviceGroup = "device_group"
	BillingTargetFolder      = "folder"
	BillingTargetDevice      = "device"
)

// BillingPackage is a reusable support-hours template.
type BillingPackage struct {
	ID              string    `json:"id"`
	Name            string    `json:"name"`
	Description     string    `json:"description,omitempty"`
	IncludedMinutes int       `json:"included_minutes"`
	OverageRate     float64   `json:"overage_rate"` // per hour when included pool exhausted
	Currency        string    `json:"currency"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

// BillingContract links a billing package to an org, group, folder, or device.
type BillingContract struct {
	ID               string     `json:"id"`
	TargetType       string     `json:"target_type"`
	TargetKey        string     `json:"target_key"`
	PackageID        string     `json:"package_id"`
	Status           string     `json:"status"` // active, suspended, expired
	RemainingMinutes int        `json:"remaining_minutes"`
	OverageRate      *float64   `json:"overage_rate,omitempty"`
	HourlyRate       float64    `json:"hourly_rate"`
	Currency         string     `json:"currency"`
	ValidFrom        *time.Time `json:"valid_from,omitempty"`
	ValidUntil       *time.Time `json:"valid_until,omitempty"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`
	PackageName      string     `json:"package_name,omitempty"`
	TargetName       string     `json:"target_name,omitempty"`
	// Legacy JSON fields when target_type=org
	OrgID   string `json:"org_id,omitempty"`
	OrgName string `json:"org_name,omitempty"`
}

// FillLegacyOrgFields sets org_id/org_name when the target is an organization.
func (c *BillingContract) FillLegacyOrgFields() {
	if c == nil {
		return
	}
	if c.TargetType == BillingTargetOrg {
		c.OrgID = c.TargetKey
		if c.TargetName != "" {
			c.OrgName = c.TargetName
		}
	}
}

// BillingOrgContract is kept as a type alias for backward-compatible internal references.
type BillingOrgContract = BillingContract

// BillingSession is the authoritative billable remote session record.
type BillingSession struct {
	ID                   string     `json:"id"`
	OrgID                string     `json:"org_id"`
	ContractID           string     `json:"contract_id,omitempty"`
	OperatorID           string     `json:"operator_id"`
	OperatorName         string     `json:"operator_name,omitempty"`
	DeviceID             string     `json:"device_id"`
	DeviceName           string     `json:"device_name,omitempty"`
	RelayUUID            string     `json:"relay_uuid,omitempty"`
	Transport            string     `json:"transport"`
	Status               string     `json:"status"` // active, pending_report, closed
	BillingPhase         string     `json:"billing_phase"` // included, overage
	StartedAt            time.Time  `json:"started_at"`
	EndedAt              *time.Time `json:"ended_at,omitempty"`
	RawSeconds           int        `json:"raw_seconds"`
	BilledMinutes        int        `json:"billed_minutes"`
	IncludedMinutesUsed  int        `json:"included_minutes_used"`
	OverageMinutes       int        `json:"overage_minutes"`
	AmountIncluded       float64    `json:"amount_included"`
	AmountOverage        float64    `json:"amount_overage"`
	Currency             string     `json:"currency"`
	ClockOffsetMSAtStart int64      `json:"clock_offset_ms_at_start"`
	ClockSyncedAtStart   bool       `json:"clock_synced_at_start"`
	CreatedAt            time.Time  `json:"created_at"`
	UpdatedAt            time.Time  `json:"updated_at"`
}

// BillingSessionLedger records in-session billing events.
type BillingSessionLedger struct {
	ID        int64     `json:"id"`
	SessionID string    `json:"session_id"`
	EventType string    `json:"event_type"`
	Details   string    `json:"details,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

// BillingWorkReport is submitted by a technician after a session.
type BillingWorkReport struct {
	ID         int64     `json:"id"`
	SessionID  string    `json:"session_id"`
	OperatorID string    `json:"operator_id"`
	Summary    string    `json:"summary"`
	Category   string    `json:"category,omitempty"`
	TicketRef  string    `json:"ticket_ref,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
}

// BillingCurrency stores manual FX rates relative to server base currency.
type BillingCurrency struct {
	Code               string  `json:"code"`
	Symbol             string  `json:"symbol"`
	ExchangeRateToBase float64 `json:"exchange_rate_to_base"`
}

// BillingSessionFilter filters session listings.
type BillingSessionFilter struct {
	OrgID    string
	DeviceID string
	Status   string
	Limit    int
	Offset   int
}

// BillingContractFilter filters billing contracts.
type BillingContractFilter struct {
	TargetType string
	TargetKey  string
	OrgID      string // legacy: maps to org target
	Status     string
}
