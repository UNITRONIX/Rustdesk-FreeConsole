package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/unitronix/betterdesk-server/billing"
	"github.com/unitronix/betterdesk-server/db"
)

// SetBillingService attaches the billing engine.
func (s *Server) SetBillingService(b *billing.Service) {
	s.billing = b
}

// GET /api/billing/packages
func (s *Server) handleListBillingPackages(w http.ResponseWriter, r *http.Request) {
	pkgs, err := s.db.ListBillingPackages()
	if err != nil {
		writeInternalError(w, err, "ListBillingPackages")
		return
	}
	if pkgs == nil {
		pkgs = []*db.BillingPackage{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"packages": pkgs})
}

// POST /api/billing/packages
func (s *Server) handleCreateBillingPackage(w http.ResponseWriter, r *http.Request) {
	var body db.BillingPackage
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name required"})
		return
	}
	if body.ID == "" {
		body.ID = uuid.New().String()
	}
	if body.Currency == "" {
		body.Currency = "PLN"
	}
	if err := s.db.CreateBillingPackage(&body); err != nil {
		writeInternalError(w, err, "CreateBillingPackage")
		return
	}
	writeJSON(w, http.StatusCreated, body)
}

// PUT /api/billing/packages/{id}
func (s *Server) handleUpdateBillingPackage(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body db.BillingPackage
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	body.ID = id
	if err := s.db.UpdateBillingPackage(&body); err != nil {
		writeInternalError(w, err, "UpdateBillingPackage")
		return
	}
	writeJSON(w, http.StatusOK, body)
}

// DELETE /api/billing/packages/{id}
func (s *Server) handleDeleteBillingPackage(w http.ResponseWriter, r *http.Request) {
	if err := s.db.DeleteBillingPackage(r.PathValue("id")); err != nil {
		writeInternalError(w, err, "DeleteBillingPackage")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// GET /api/billing/contracts?org_id=
func (s *Server) handleListBillingContracts(w http.ResponseWriter, r *http.Request) {
	filter := db.BillingContractFilter{
		OrgID:  r.URL.Query().Get("org_id"),
		Status: r.URL.Query().Get("status"),
	}
	contracts, err := s.db.ListBillingOrgContracts(filter)
	if err != nil {
		writeInternalError(w, err, "ListBillingOrgContracts")
		return
	}
	if contracts == nil {
		contracts = []*db.BillingOrgContract{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"contracts": contracts})
}

// POST /api/billing/contracts
func (s *Server) handleCreateBillingContract(w http.ResponseWriter, r *http.Request) {
	var body db.BillingOrgContract
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if body.OrgID == "" || body.PackageID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "org_id and package_id required"})
		return
	}
	if body.ID == "" {
		body.ID = uuid.New().String()
	}
	if body.Status == "" {
		body.Status = billing.ContractActive
	}
	if body.Currency == "" {
		body.Currency = "PLN"
	}
	if body.RemainingMinutes == 0 {
		if pkg, err := s.db.GetBillingPackage(body.PackageID); err == nil && pkg != nil {
			body.RemainingMinutes = pkg.IncludedMinutes
		}
	}
	if err := s.db.CreateBillingOrgContract(&body); err != nil {
		writeInternalError(w, err, "CreateBillingOrgContract")
		return
	}
	writeJSON(w, http.StatusCreated, body)
}

// PUT /api/billing/contracts/{id}
func (s *Server) handleUpdateBillingContract(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	existing, err := s.db.GetBillingOrgContract(id)
	if err != nil {
		writeInternalError(w, err, "GetBillingOrgContract")
		return
	}
	if existing == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "contract not found"})
		return
	}
	var patch map[string]json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if raw, ok := patch["status"]; ok {
		var status string
		if err := json.Unmarshal(raw, &status); err == nil && status != "" {
			existing.Status = status
		}
	}
	if raw, ok := patch["remaining_minutes"]; ok {
		var mins int
		if err := json.Unmarshal(raw, &mins); err == nil {
			existing.RemainingMinutes = mins
		}
	}
	if raw, ok := patch["overage_rate"]; ok {
		var rate *float64
		if err := json.Unmarshal(raw, &rate); err == nil {
			existing.OverageRate = rate
		}
	}
	if raw, ok := patch["hourly_rate"]; ok {
		var rate float64
		if err := json.Unmarshal(raw, &rate); err == nil {
			existing.HourlyRate = rate
		}
	}
	if raw, ok := patch["currency"]; ok {
		var cur string
		if err := json.Unmarshal(raw, &cur); err == nil && cur != "" {
			existing.Currency = cur
		}
	}
	if err := s.db.UpdateBillingOrgContract(existing); err != nil {
		writeInternalError(w, err, "UpdateBillingOrgContract")
		return
	}
	writeJSON(w, http.StatusOK, existing)
}

// GET /api/billing/sessions
func (s *Server) handleListBillingSessions(w http.ResponseWriter, r *http.Request) {
	filter := db.BillingSessionFilter{OrgID: r.URL.Query().Get("org_id"), Status: r.URL.Query().Get("status")}
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			filter.Limit = n
		}
	}
	sessions, err := s.db.ListBillingSessions(filter)
	if err != nil {
		writeInternalError(w, err, "ListBillingSessions")
		return
	}
	if sessions == nil {
		sessions = []*db.BillingSession{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": sessions})
}

// GET /api/billing/reports
func (s *Server) handleListBillingReports(w http.ResponseWriter, r *http.Request) {
	limit := 100
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			limit = n
		}
	}
	reports, err := s.db.ListBillingWorkReports(r.URL.Query().Get("org_id"), limit)
	if err != nil {
		writeInternalError(w, err, "ListBillingWorkReports")
		return
	}
	if reports == nil {
		reports = []*db.BillingWorkReport{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"reports": reports})
}

// POST /api/billing/sessions/{id}/report
func (s *Server) handleSubmitBillingReport(w http.ResponseWriter, r *http.Request) {
	if s.billing == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "billing not configured"})
		return
	}
	sessionID := r.PathValue("id")
	var body struct {
		Summary   string `json:"summary"`
		Category  string `json:"category"`
		TicketRef string `json:"ticket_ref"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	operatorID := getUsernameFromCtx(r)
	if operatorID == "" {
		operatorID = r.Header.Get("X-Operator-Id")
	}
	if operatorID == "" {
		operatorID = "operator"
	}
	if err := s.billing.SubmitWorkReport(sessionID, operatorID, body.Summary, body.Category, body.TicketRef); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

// GET /api/billing/currencies
func (s *Server) handleListBillingCurrencies(w http.ResponseWriter, r *http.Request) {
	cur, err := s.db.ListBillingCurrencies()
	if err != nil {
		writeInternalError(w, err, "ListBillingCurrencies")
		return
	}
	if cur == nil {
		cur = []*db.BillingCurrency{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"currencies": cur})
}

// PUT /api/billing/currencies/{code}
func (s *Server) handleUpsertBillingCurrency(w http.ResponseWriter, r *http.Request) {
	var body db.BillingCurrency
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	body.Code = strings.ToUpper(r.PathValue("code"))
	if body.Code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "code required"})
		return
	}
	if err := s.db.UpsertBillingCurrency(&body); err != nil {
		writeInternalError(w, err, "UpsertBillingCurrency")
		return
	}
	writeJSON(w, http.StatusOK, body)
}

// GET /api/billing/check?device_id=
func (s *Server) handleBillingConnectionCheck(w http.ResponseWriter, r *http.Request) {
	deviceID := r.URL.Query().Get("device_id")
	if deviceID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "device_id required"})
		return
	}
	if s.billing == nil {
		writeJSON(w, http.StatusOK, billing.ConnectionCheckResult{Allowed: true})
		return
	}
	writeJSON(w, http.StatusOK, s.billing.CheckConnection(deviceID))
}

// GET /api/billing/sessions/pending?device_id=
func (s *Server) handleGetPendingBillingSession(w http.ResponseWriter, r *http.Request) {
	deviceID := strings.TrimSpace(r.URL.Query().Get("device_id"))
	if deviceID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "device_id required"})
		return
	}
	sessions, err := s.db.ListBillingSessions(db.BillingSessionFilter{
		DeviceID: deviceID,
		Status:   billing.StatusPendingReport,
		Limit:    1,
	})
	if err != nil {
		writeInternalError(w, err, "ListBillingSessions")
		return
	}
	if len(sessions) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"session": nil})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"session": sessions[0]})
}

// GET /api/billing/reports/export?format=csv|pdf&org_id=
func (s *Server) handleExportBillingReports(w http.ResponseWriter, r *http.Request) {
	format := strings.ToLower(r.URL.Query().Get("format"))
	if format == "" {
		format = "csv"
	}
	orgID := r.URL.Query().Get("org_id")
	reports, err := s.db.ListBillingWorkReports(orgID, 5000)
	if err != nil {
		writeInternalError(w, err, "ListBillingWorkReports")
		return
	}
	sessions, err := s.db.ListBillingSessions(db.BillingSessionFilter{OrgID: orgID, Limit: 5000})
	if err != nil {
		writeInternalError(w, err, "ListBillingSessions")
		return
	}
	sessMap := make(map[string]*db.BillingSession, len(sessions))
	for _, sess := range sessions {
		sessMap[sess.ID] = sess
	}
	rows := billing.BuildReportExportRows(reports, sessMap)
	stamp := time.Now().UTC().Format("20060102")

	switch format {
	case "csv":
		data, err := billing.WriteReportsCSV(rows)
		if err != nil {
			writeInternalError(w, err, "WriteReportsCSV")
			return
		}
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="billing-reports-%s.csv"`, stamp))
		w.Write(data)
	case "pdf":
		data := billing.WriteReportsPDF(rows, "BetterDesk — Work Reports")
		w.Header().Set("Content-Type", "application/pdf")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="billing-reports-%s.pdf"`, stamp))
		w.Write(data)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "format must be csv or pdf"})
	}
}

// GET /api/billing/sessions/export?format=csv&org_id=
func (s *Server) handleExportBillingSessions(w http.ResponseWriter, r *http.Request) {
	format := strings.ToLower(r.URL.Query().Get("format"))
	if format != "csv" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "only csv supported"})
		return
	}
	orgID := r.URL.Query().Get("org_id")
	sessions, err := s.db.ListBillingSessions(db.BillingSessionFilter{OrgID: orgID, Limit: 5000})
	if err != nil {
		writeInternalError(w, err, "ListBillingSessions")
		return
	}
	exportRows := make([]billing.SessionExportRow, 0, len(sessions))
	for _, sess := range sessions {
		exportRows = append(exportRows, billing.SessionExportRow{
			ID:            sess.ID,
			OrgID:         sess.OrgID,
			DeviceID:      sess.DeviceID,
			OperatorID:    sess.OperatorID,
			Status:        sess.Status,
			BillingPhase:  sess.BillingPhase,
			BilledMinutes: sess.BilledMinutes,
			AmountOverage: sess.AmountOverage,
			Currency:      sess.Currency,
			StartedAt:     sess.StartedAt,
			EndedAt:       sess.EndedAt,
		})
	}
	data, err := billing.WriteSessionsCSV(exportRows)
	if err != nil {
		writeInternalError(w, err, "WriteSessionsCSV")
		return
	}
	stamp := time.Now().UTC().Format("20060102")
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="billing-sessions-%s.csv"`, stamp))
	w.Write(data)
}
