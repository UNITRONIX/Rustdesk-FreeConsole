package billing

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/timesync"
)

const (
	PhaseIncluded = "included"
	PhaseOverage  = "overage"

	StatusActive        = "active"
	StatusPendingReport = "pending_report"
	StatusClosed        = "closed"

	ContractActive    = "active"
	ContractSuspended = "suspended"

	LedgerSessionStart = "session_start"
	LedgerPhaseChange  = "phase_change"
	LedgerSessionEnd   = "session_end"

	pendingRelayTTL = 10 * time.Minute
)

// ConnectionCheckResult is returned before allowing a remote session.
type ConnectionCheckResult struct {
	Allowed   bool   `json:"allowed"`
	Reason    string `json:"reason,omitempty"`
	OrgID     string `json:"org_id,omitempty"`
	HasBilling bool  `json:"has_billing"`
}

// Service manages billable remote sessions.
type Service struct {
	db       db.Database
	clock    *timesync.Service
	roundMin int
	requireReport bool

	mu       sync.Mutex
	pending  map[string]*pendingRelay // relayUUID -> meta
	active   map[string]*activeSession
}

type pendingRelay struct {
	OrgID      string
	DeviceID   string
	OperatorID string
	ContractID string
	Currency   string
	createdAt  time.Time
}

type activeSession struct {
	ID              string
	OrgID           string
	ContractID      string
	RelayUUID       string
	StartedAt       time.Time
	RemainingAtStart int
	OverageRate     float64
	HourlyRate      float64
	Currency        string
	Phase           string
	LastBilledMin   int
}

// NewService creates a billing service.
func NewService(database db.Database, clock *timesync.Service, roundingMinutes int, requireWorkReport bool) *Service {
	if roundingMinutes <= 0 {
		roundingMinutes = 1
	}
	return &Service{
		db:            database,
		clock:         clock,
		roundMin:      roundingMinutes,
		requireReport: requireWorkReport,
		pending:       make(map[string]*pendingRelay),
		active:        make(map[string]*activeSession),
	}
}

// Start launches the session ticker.
func (s *Service) Start(ctx context.Context) {
	go s.ticker(ctx)
}

func (s *Service) ticker(ctx context.Context) {
	tick := time.NewTicker(10 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			s.tickActive()
			s.sweepStalePending()
		}
	}
}

func (s *Service) sweepStalePending() {
	cutoff := time.Now().Add(-pendingRelayTTL)
	s.mu.Lock()
	defer s.mu.Unlock()
	for uuid, meta := range s.pending {
		if meta.createdAt.Before(cutoff) {
			delete(s.pending, uuid)
		}
	}
}

// PendingRelayCount returns billing metadata waiting for relay pairing.
func (s *Service) PendingRelayCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.pending)
}

// CheckConnection evaluates whether a connection to deviceID may proceed.
func (s *Service) CheckConnection(deviceID string) ConnectionCheckResult {
	orgID, err := s.db.GetDeviceOrgID(deviceID)
	if err != nil || orgID == "" {
		return ConnectionCheckResult{Allowed: true}
	}

	if s.clock != nil && !s.clock.IsSynced() {
		return ConnectionCheckResult{Allowed: false, Reason: "clock_unsynced", OrgID: orgID}
	}

	contract, err := s.db.GetActiveBillingOrgContract(orgID)
	if err != nil || contract == nil {
		return ConnectionCheckResult{Allowed: true, OrgID: orgID}
	}
	if contract.Status == ContractSuspended {
		return ConnectionCheckResult{Allowed: false, Reason: "billing_suspended", OrgID: orgID, HasBilling: true}
	}
	return ConnectionCheckResult{Allowed: true, OrgID: orgID, HasBilling: true}
}

// PrepareRelay registers billing metadata when signal assigns a relay UUID.
func (s *Service) PrepareRelay(relayUUID, deviceID, operatorID string) error {
	if relayUUID == "" {
		return nil
	}
	check := s.CheckConnection(deviceID)
	if !check.Allowed {
		return fmt.Errorf("billing: %s", check.Reason)
	}
	if !check.HasBilling {
		return nil
	}
	contract, err := s.db.GetActiveBillingOrgContract(check.OrgID)
	if err != nil || contract == nil {
		return nil
	}
	overage := contract.OverageRate
	if overage == nil {
		pkg, _ := s.db.GetBillingPackage(contract.PackageID)
		if pkg != nil {
			v := pkg.OverageRate
			overage = &v
		}
	}
	s.mu.Lock()
	s.pending[relayUUID] = &pendingRelay{
		OrgID:      check.OrgID,
		DeviceID:   deviceID,
		OperatorID: operatorID,
		ContractID: contract.ID,
		Currency:   contract.Currency,
		createdAt:  time.Now(),
	}
	s.mu.Unlock()
	return nil
}

// ActivateRelay starts the authoritative billing session when relay pairs.
func (s *Service) ActivateRelay(relayUUID string) {
	if relayUUID == "" {
		return
	}
	s.mu.Lock()
	meta, ok := s.pending[relayUUID]
	if !ok {
		s.mu.Unlock()
		return
	}
	delete(s.pending, relayUUID)
	s.mu.Unlock()

	contract, err := s.db.GetBillingOrgContract(meta.ContractID)
	if err != nil || contract == nil {
		return
	}
	overageRate := contract.HourlyRate
	if contract.OverageRate != nil {
		overageRate = *contract.OverageRate
	} else if pkg, err := s.db.GetBillingPackage(contract.PackageID); err == nil && pkg != nil {
		overageRate = pkg.OverageRate
	}

	now := time.Now().UTC()
	if s.clock != nil {
		now = s.clock.NowUTC()
	}
	sessionID := uuid.New().String()
	synced := true
	var offset int64
	if s.clock != nil {
		st := s.clock.GetStatus()
		synced = st.Synced
		offset = st.OffsetMS
	}

	sess := &db.BillingSession{
		ID:                   sessionID,
		OrgID:                meta.OrgID,
		ContractID:           meta.ContractID,
		OperatorID:           meta.OperatorID,
		DeviceID:             meta.DeviceID,
		RelayUUID:            relayUUID,
		Transport:            "rustdesk",
		Status:               StatusActive,
		BillingPhase:         PhaseIncluded,
		StartedAt:            now,
		Currency:             meta.Currency,
		ClockOffsetMSAtStart: offset,
		ClockSyncedAtStart:   synced,
	}
	if err := s.db.CreateBillingSession(sess); err != nil {
		log.Printf("[billing] CreateBillingSession: %v", err)
		return
	}
	_ = s.db.InsertBillingLedgerEntry(&db.BillingSessionLedger{
		SessionID: sessionID,
		EventType: LedgerSessionStart,
		Details:   relayUUID,
	})

	s.mu.Lock()
	s.active[relayUUID] = &activeSession{
		ID:               sessionID,
		OrgID:            meta.OrgID,
		ContractID:       meta.ContractID,
		RelayUUID:        relayUUID,
		StartedAt:        now,
		RemainingAtStart: contract.RemainingMinutes,
		OverageRate:      overageRate,
		HourlyRate:       contract.HourlyRate,
		Currency:         meta.Currency,
		Phase:            PhaseIncluded,
	}
	s.mu.Unlock()
}

// EndRelay finalizes a billing session when relay ends.
func (s *Service) EndRelay(relayUUID string) {
	if relayUUID == "" {
		return
	}
	s.mu.Lock()
	active, ok := s.active[relayUUID]
	if !ok {
		s.mu.Unlock()
		return
	}
	delete(s.active, relayUUID)
	s.mu.Unlock()
	s.finalizeSession(active)
}

func (s *Service) tickActive() {
	s.mu.Lock()
	snap := make([]*activeSession, 0, len(s.active))
	for _, a := range s.active {
		cp := *a
		snap = append(snap, &cp)
	}
	s.mu.Unlock()

	for _, a := range snap {
		s.updateActiveProgress(a)
	}
}

func (s *Service) updateActiveProgress(a *activeSession) {
	now := time.Now().UTC()
	if s.clock != nil {
		now = s.clock.NowUTC()
	}
	rawSecs := int(now.Sub(a.StartedAt).Seconds())
	if rawSecs < 0 {
		rawSecs = 0
	}
	billedMin := roundUpMinutes(rawSecs, s.roundMin)

	s.mu.Lock()
	cur, ok := s.active[a.RelayUUID]
	if !ok {
		s.mu.Unlock()
		return
	}
	cur.LastBilledMin = billedMin

	overageMin := 0
	if billedMin > cur.RemainingAtStart {
		overageMin = billedMin - cur.RemainingAtStart
	}
	newPhase := PhaseIncluded
	if overageMin > 0 {
		newPhase = PhaseOverage
	}
	if newPhase != cur.Phase {
		cur.Phase = newPhase
		s.mu.Unlock()
		_ = s.db.InsertBillingLedgerEntry(&db.BillingSessionLedger{
			SessionID: cur.ID,
			EventType: LedgerPhaseChange,
			Details:   newPhase,
		})
		s.mu.Lock()
	}
	s.mu.Unlock()
}

func (s *Service) finalizeSession(a *activeSession) {
	now := time.Now().UTC()
	if s.clock != nil {
		now = s.clock.NowUTC()
	}
	rawSecs := int(now.Sub(a.StartedAt).Seconds())
	if rawSecs < 0 {
		rawSecs = 0
	}
	billedMin := roundUpMinutes(rawSecs, s.roundMin)
	includedUsed := min(billedMin, a.RemainingAtStart)
	overageMin := 0
	if billedMin > a.RemainingAtStart {
		overageMin = billedMin - a.RemainingAtStart
	}
	phase := PhaseIncluded
	if overageMin > 0 {
		phase = PhaseOverage
	}

	amountIncluded := (float64(includedUsed) / 60.0) * a.HourlyRate
	amountOverage := (float64(overageMin) / 60.0) * a.OverageRate
	status := StatusPendingReport
	if !s.requireReport {
		status = StatusClosed
	}

	sess, err := s.db.GetBillingSession(a.ID)
	if err != nil || sess == nil {
		return
	}
	sess.EndedAt = &now
	sess.RawSeconds = rawSecs
	sess.BilledMinutes = billedMin
	sess.IncludedMinutesUsed = includedUsed
	sess.OverageMinutes = overageMin
	sess.BillingPhase = phase
	sess.AmountIncluded = amountIncluded
	sess.AmountOverage = amountOverage
	sess.Status = status
	_ = s.db.UpdateBillingSession(sess)
	_ = s.db.InsertBillingLedgerEntry(&db.BillingSessionLedger{
		SessionID: a.ID,
		EventType: LedgerSessionEnd,
	})

	if contract, err := s.db.GetBillingOrgContract(a.ContractID); err == nil && contract != nil {
		newRemaining := contract.RemainingMinutes - includedUsed
		if newRemaining < 0 {
			newRemaining = 0
		}
		contract.RemainingMinutes = newRemaining
		_ = s.db.UpdateBillingOrgContract(contract)
	}
}

// SubmitWorkReport attaches a technician report and closes the session.
func (s *Service) SubmitWorkReport(sessionID, operatorID, summary, category, ticketRef string) error {
	summary = trim(summary, 8000)
	if summary == "" {
		return errors.New("summary required")
	}
	sess, err := s.db.GetBillingSession(sessionID)
	if err != nil {
		return err
	}
	if sess.Status == StatusClosed {
		return errors.New("session already closed")
	}
	if _, err := s.db.GetBillingWorkReportBySession(sessionID); err == nil {
		return errors.New("report already submitted")
	}
	if err := s.db.CreateBillingWorkReport(&db.BillingWorkReport{
		SessionID:  sessionID,
		OperatorID: operatorID,
		Summary:    summary,
		Category:   trim(category, 128),
		TicketRef:  trim(ticketRef, 128),
	}); err != nil {
		return err
	}
	sess.Status = StatusClosed
	return s.db.UpdateBillingSession(sess)
}

func roundUpMinutes(seconds, roundMin int) int {
	if roundMin <= 0 {
		roundMin = 1
	}
	mins := float64(seconds) / 60.0
	return int(math.Ceil(mins/float64(roundMin))) * roundMin
}

func trim(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
