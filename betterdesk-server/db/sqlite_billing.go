package db

import (
	"database/sql"
	"strings"
	"time"
)

func parseSQLiteTime(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	for _, layout := range []string{"2006-01-02 15:04:05", time.RFC3339} {
		if t, err := time.Parse(layout, s); err == nil {
			return t
		}
	}
	return time.Time{}
}

func scanBillingSession(row scanner) (*BillingSession, error) {
	var sess BillingSession
	var startedAt, endedAt, createdAt, updatedAt string
	var clockSynced int
	err := row.Scan(
		&sess.ID, &sess.OrgID, &sess.ContractID, &sess.OperatorID, &sess.OperatorName,
		&sess.DeviceID, &sess.DeviceName, &sess.RelayUUID, &sess.Transport, &sess.Status,
		&sess.BillingPhase, &startedAt, &endedAt, &sess.RawSeconds, &sess.BilledMinutes,
		&sess.IncludedMinutesUsed, &sess.OverageMinutes, &sess.AmountIncluded, &sess.AmountOverage,
		&sess.Currency, &sess.ClockOffsetMSAtStart, &clockSynced, &createdAt, &updatedAt,
	)
	if err != nil {
		return nil, err
	}
	sess.StartedAt = parseSQLiteTime(startedAt)
	if endedAt != "" {
		t := parseSQLiteTime(endedAt)
		sess.EndedAt = &t
	}
	sess.ClockSyncedAtStart = clockSynced != 0
	sess.CreatedAt = parseSQLiteTime(createdAt)
	sess.UpdatedAt = parseSQLiteTime(updatedAt)
	return &sess, nil
}

type scanner interface {
	Scan(dest ...any) error
}

const billingSessionCols = `id, org_id, contract_id, operator_id, operator_name, device_id, device_name,
	relay_uuid, transport, status, billing_phase, started_at, ended_at, raw_seconds, billed_minutes,
	included_minutes_used, overage_minutes, amount_included, amount_overage, currency,
	clock_offset_ms_at_start, clock_synced_at_start, created_at, updated_at`

func (s *SQLiteDB) CreateBillingPackage(p *BillingPackage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`INSERT INTO billing_packages (id, name, description, included_minutes, overage_rate, currency, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
		p.ID, p.Name, p.Description, p.IncludedMinutes, p.OverageRate, p.Currency,
	)
	return err
}

func (s *SQLiteDB) GetBillingPackage(id string) (*BillingPackage, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var p BillingPackage
	var createdAt, updatedAt string
	err := s.db.QueryRow(
		`SELECT id, name, description, included_minutes, overage_rate, currency, created_at, updated_at
		 FROM billing_packages WHERE id = ?`, id,
	).Scan(&p.ID, &p.Name, &p.Description, &p.IncludedMinutes, &p.OverageRate, &p.Currency, &createdAt, &updatedAt)
	if err != nil {
		return nil, err
	}
	p.CreatedAt = parseSQLiteTime(createdAt)
	p.UpdatedAt = parseSQLiteTime(updatedAt)
	return &p, nil
}

func (s *SQLiteDB) ListBillingPackages() ([]*BillingPackage, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows, err := s.db.Query(
		`SELECT id, name, description, included_minutes, overage_rate, currency, created_at, updated_at
		 FROM billing_packages ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*BillingPackage
	for rows.Next() {
		var p BillingPackage
		var createdAt, updatedAt string
		if err := rows.Scan(&p.ID, &p.Name, &p.Description, &p.IncludedMinutes, &p.OverageRate, &p.Currency, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		p.CreatedAt = parseSQLiteTime(createdAt)
		p.UpdatedAt = parseSQLiteTime(updatedAt)
		out = append(out, &p)
	}
	return out, rows.Err()
}

func (s *SQLiteDB) UpdateBillingPackage(p *BillingPackage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`UPDATE billing_packages SET name=?, description=?, included_minutes=?, overage_rate=?, currency=?, updated_at=datetime('now') WHERE id=?`,
		p.Name, p.Description, p.IncludedMinutes, p.OverageRate, p.Currency, p.ID,
	)
	return err
}

func (s *SQLiteDB) DeleteBillingPackage(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`DELETE FROM billing_packages WHERE id = ?`, id)
	return err
}

func formatSQLiteTimePtr(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC().Format("2006-01-02 15:04:05")
}

func (s *SQLiteDB) CreateBillingContract(c *BillingContract) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var overage sql.NullFloat64
	if c.OverageRate != nil {
		overage = sql.NullFloat64{Float64: *c.OverageRate, Valid: true}
	}
	_, err := s.db.Exec(
		`INSERT INTO billing_contracts (id, target_type, target_key, package_id, status, remaining_minutes, overage_rate, hourly_rate, currency, valid_from, valid_until, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
		c.ID, c.TargetType, c.TargetKey, c.PackageID, c.Status, c.RemainingMinutes, overage, c.HourlyRate, c.Currency,
		formatSQLiteTimePtr(c.ValidFrom), formatSQLiteTimePtr(c.ValidUntil),
	)
	return err
}

func (s *SQLiteDB) CreateBillingOrgContract(c *BillingOrgContract) error {
	return s.CreateBillingContract(c)
}

func (s *SQLiteDB) GetBillingContract(id string) (*BillingContract, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c, err := s.queryBillingContract(`WHERE c.id = ?`, id)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return c, err
}

func (s *SQLiteDB) GetBillingOrgContract(id string) (*BillingOrgContract, error) {
	return s.GetBillingContract(id)
}

func (s *SQLiteDB) GetActiveBillingContract(targetType, targetKey string) (*BillingContract, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	c, err := s.queryBillingContract(
		`WHERE c.target_type = ? AND c.target_key = ? AND c.status = 'active' ORDER BY c.updated_at DESC LIMIT 1`,
		targetType, targetKey,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return c, err
}

func (s *SQLiteDB) GetActiveBillingOrgContract(orgID string) (*BillingOrgContract, error) {
	return s.GetActiveBillingContract(BillingTargetOrg, orgID)
}

const billingContractTargetNameSQL = `
	COALESCE(
		CASE c.target_type
			WHEN 'org' THEN (SELECT name FROM organizations WHERE id = c.target_key LIMIT 1)
			WHEN 'device' THEN (SELECT COALESCE(NULLIF(display_name, ''), hostname, c.target_key) FROM peers WHERE id = c.target_key LIMIT 1)
			WHEN 'device_group' THEN (SELECT name FROM device_groups WHERE guid = c.target_key LIMIT 1)
			ELSE c.target_key
		END, c.target_key)`

func (s *SQLiteDB) queryBillingContract(where string, args ...any) (*BillingContract, error) {
	query := `SELECT c.id, c.target_type, c.target_key, c.package_id, c.status, c.remaining_minutes, c.overage_rate,
		c.hourly_rate, c.currency, c.valid_from, c.valid_until, c.created_at, c.updated_at,
		COALESCE(p.name, ''), ` + billingContractTargetNameSQL + `
		FROM billing_contracts c
		LEFT JOIN billing_packages p ON p.id = c.package_id ` + where

	var c BillingContract
	var overage sql.NullFloat64
	var validFrom, validUntil, createdAt, updatedAt sql.NullString
	err := s.db.QueryRow(query, args...).Scan(
		&c.ID, &c.TargetType, &c.TargetKey, &c.PackageID, &c.Status, &c.RemainingMinutes, &overage,
		&c.HourlyRate, &c.Currency, &validFrom, &validUntil, &createdAt, &updatedAt,
		&c.PackageName, &c.TargetName,
	)
	if err != nil {
		return nil, err
	}
	if overage.Valid {
		v := overage.Float64
		c.OverageRate = &v
	}
	if validFrom.Valid {
		t := parseSQLiteTime(validFrom.String)
		c.ValidFrom = &t
	}
	if validUntil.Valid {
		t := parseSQLiteTime(validUntil.String)
		c.ValidUntil = &t
	}
	c.CreatedAt = parseSQLiteTime(createdAt.String)
	c.UpdatedAt = parseSQLiteTime(updatedAt.String)
	c.FillLegacyOrgFields()
	return &c, nil
}

func (s *SQLiteDB) ListBillingContracts(filter BillingContractFilter) ([]*BillingContract, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var conds []string
	var args []any
	if filter.TargetType != "" && filter.TargetKey != "" {
		conds = append(conds, "c.target_type = ?")
		args = append(args, filter.TargetType)
		conds = append(conds, "c.target_key = ?")
		args = append(args, filter.TargetKey)
	} else if filter.OrgID != "" {
		conds = append(conds, "c.target_type = ?")
		args = append(args, BillingTargetOrg)
		conds = append(conds, "c.target_key = ?")
		args = append(args, filter.OrgID)
	} else if filter.TargetType != "" {
		conds = append(conds, "c.target_type = ?")
		args = append(args, filter.TargetType)
	}
	if filter.Status != "" {
		conds = append(conds, "c.status = ?")
		args = append(args, filter.Status)
	}
	query := `SELECT c.id, c.target_type, c.target_key, c.package_id, c.status, c.remaining_minutes, c.overage_rate,
		c.hourly_rate, c.currency, c.valid_from, c.valid_until, c.created_at, c.updated_at,
		COALESCE(p.name, ''), ` + billingContractTargetNameSQL + `
		FROM billing_contracts c
		LEFT JOIN billing_packages p ON p.id = c.package_id`
	if len(conds) > 0 {
		query += " WHERE " + strings.Join(conds, " AND ")
	}
	query += " ORDER BY c.updated_at DESC"
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*BillingContract
	for rows.Next() {
		var c BillingContract
		var overage sql.NullFloat64
		var validFrom, validUntil, createdAt, updatedAt sql.NullString
		if err := rows.Scan(
			&c.ID, &c.TargetType, &c.TargetKey, &c.PackageID, &c.Status, &c.RemainingMinutes, &overage,
			&c.HourlyRate, &c.Currency, &validFrom, &validUntil, &createdAt, &updatedAt,
			&c.PackageName, &c.TargetName,
		); err != nil {
			return nil, err
		}
		if overage.Valid {
			v := overage.Float64
			c.OverageRate = &v
		}
		if validFrom.Valid {
			t := parseSQLiteTime(validFrom.String)
			c.ValidFrom = &t
		}
		if validUntil.Valid {
			t := parseSQLiteTime(validUntil.String)
			c.ValidUntil = &t
		}
		c.CreatedAt = parseSQLiteTime(createdAt.String)
		c.UpdatedAt = parseSQLiteTime(updatedAt.String)
		c.FillLegacyOrgFields()
		out = append(out, &c)
	}
	return out, rows.Err()
}

func (s *SQLiteDB) ListBillingOrgContracts(filter BillingContractFilter) ([]*BillingOrgContract, error) {
	return s.ListBillingContracts(filter)
}

func (s *SQLiteDB) UpdateBillingContract(c *BillingContract) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var overage sql.NullFloat64
	if c.OverageRate != nil {
		overage = sql.NullFloat64{Float64: *c.OverageRate, Valid: true}
	}
	_, err := s.db.Exec(
		`UPDATE billing_contracts SET status=?, remaining_minutes=?, overage_rate=?, hourly_rate=?, currency=?, valid_from=?, valid_until=?, updated_at=datetime('now') WHERE id=?`,
		c.Status, c.RemainingMinutes, overage, c.HourlyRate, c.Currency,
		formatSQLiteTimePtr(c.ValidFrom), formatSQLiteTimePtr(c.ValidUntil), c.ID,
	)
	return err
}

func (s *SQLiteDB) UpdateBillingOrgContract(c *BillingOrgContract) error {
	return s.UpdateBillingContract(c)
}

func (s *SQLiteDB) DeleteBillingContract(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`DELETE FROM billing_contracts WHERE id = ?`, id)
	return err
}

func (s *SQLiteDB) CountBillingContractsByPackage(packageID string) (int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM billing_contracts WHERE package_id = ?`, packageID).Scan(&n)
	return n, err
}

func (s *SQLiteDB) CountBillingContractsExpiringWithin(days int) (int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if days <= 0 {
		days = 30
	}
	var n int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM billing_contracts
		 WHERE status = 'active' AND valid_until IS NOT NULL
		 AND valid_until <= datetime('now', '+' || ? || ' days')`,
		days,
	).Scan(&n)
	return n, err
}

func (s *SQLiteDB) CreateBillingSession(sess *BillingSession) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	synced := 0
	if sess.ClockSyncedAtStart {
		synced = 1
	}
	var ended any
	if sess.EndedAt != nil {
		ended = sess.EndedAt.UTC().Format("2006-01-02 15:04:05")
	}
	now := time.Now().UTC().Format("2006-01-02 15:04:05")
	_, err := s.db.Exec(
		`INSERT INTO billing_sessions (`+billingSessionCols+`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		sess.ID, sess.OrgID, sess.ContractID, sess.OperatorID, sess.OperatorName,
		sess.DeviceID, sess.DeviceName, sess.RelayUUID, sess.Transport, sess.Status,
		sess.BillingPhase, sess.StartedAt.UTC().Format("2006-01-02 15:04:05"), ended,
		sess.RawSeconds, sess.BilledMinutes, sess.IncludedMinutesUsed, sess.OverageMinutes,
		sess.AmountIncluded, sess.AmountOverage, sess.Currency, sess.ClockOffsetMSAtStart, synced,
		now, now,
	)
	return err
}

func (s *SQLiteDB) GetBillingSession(id string) (*BillingSession, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	row := s.db.QueryRow(`SELECT `+billingSessionCols+` FROM billing_sessions WHERE id = ?`, id)
	return scanBillingSession(row)
}

func (s *SQLiteDB) GetBillingSessionByRelayUUID(relayUUID string) (*BillingSession, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	row := s.db.QueryRow(`SELECT `+billingSessionCols+` FROM billing_sessions WHERE relay_uuid = ? ORDER BY started_at DESC LIMIT 1`, relayUUID)
	return scanBillingSession(row)
}

func (s *SQLiteDB) UpdateBillingSession(sess *BillingSession) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var ended any
	if sess.EndedAt != nil {
		ended = sess.EndedAt.UTC().Format("2006-01-02 15:04:05")
	}
	_, err := s.db.Exec(
		`UPDATE billing_sessions SET status=?, billing_phase=?, ended_at=?, raw_seconds=?, billed_minutes=?,
		 included_minutes_used=?, overage_minutes=?, amount_included=?, amount_overage=?, updated_at=datetime('now')
		 WHERE id=?`,
		sess.Status, sess.BillingPhase, ended, sess.RawSeconds, sess.BilledMinutes,
		sess.IncludedMinutesUsed, sess.OverageMinutes, sess.AmountIncluded, sess.AmountOverage, sess.ID,
	)
	return err
}

func (s *SQLiteDB) ListBillingSessions(filter BillingSessionFilter) ([]*BillingSession, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	limit := filter.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	offset := filter.Offset
	if offset < 0 {
		offset = 0
	}
	var conds []string
	var args []any
	if filter.OrgID != "" {
		conds = append(conds, "org_id = ?")
		args = append(args, filter.OrgID)
	}
	if filter.Status != "" {
		conds = append(conds, "status = ?")
		args = append(args, filter.Status)
	}
	if filter.DeviceID != "" {
		conds = append(conds, "device_id = ?")
		args = append(args, filter.DeviceID)
	}
	query := `SELECT ` + billingSessionCols + ` FROM billing_sessions`
	if len(conds) > 0 {
		query += " WHERE " + strings.Join(conds, " AND ")
	}
	query += " ORDER BY started_at DESC LIMIT ? OFFSET ?"
	args = append(args, limit, offset)
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*BillingSession
	for rows.Next() {
		sess, err := scanBillingSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sess)
	}
	return out, rows.Err()
}

func (s *SQLiteDB) InsertBillingLedgerEntry(e *BillingSessionLedger) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`INSERT INTO billing_session_ledger (session_id, event_type, details, created_at) VALUES (?, ?, ?, datetime('now'))`,
		e.SessionID, e.EventType, e.Details,
	)
	return err
}

func (s *SQLiteDB) ListBillingLedger(sessionID string) ([]*BillingSessionLedger, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows, err := s.db.Query(
		`SELECT id, session_id, event_type, details, created_at FROM billing_session_ledger WHERE session_id = ? ORDER BY id`,
		sessionID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*BillingSessionLedger
	for rows.Next() {
		var e BillingSessionLedger
		var createdAt string
		if err := rows.Scan(&e.ID, &e.SessionID, &e.EventType, &e.Details, &createdAt); err != nil {
			return nil, err
		}
		e.CreatedAt = parseSQLiteTime(createdAt)
		out = append(out, &e)
	}
	return out, rows.Err()
}

func (s *SQLiteDB) CreateBillingWorkReport(r *BillingWorkReport) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(
		`INSERT INTO billing_work_reports (session_id, operator_id, summary, category, ticket_ref, created_at)
		 VALUES (?, ?, ?, ?, ?, datetime('now'))`,
		r.SessionID, r.OperatorID, r.Summary, r.Category, r.TicketRef,
	)
	if err != nil {
		return err
	}
	r.ID, _ = res.LastInsertId()
	return nil
}

func (s *SQLiteDB) GetBillingWorkReportBySession(sessionID string) (*BillingWorkReport, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var r BillingWorkReport
	var createdAt string
	err := s.db.QueryRow(
		`SELECT id, session_id, operator_id, summary, category, ticket_ref, created_at FROM billing_work_reports WHERE session_id = ?`,
		sessionID,
	).Scan(&r.ID, &r.SessionID, &r.OperatorID, &r.Summary, &r.Category, &r.TicketRef, &createdAt)
	if err != nil {
		return nil, err
	}
	r.CreatedAt = parseSQLiteTime(createdAt)
	return &r, nil
}

func (s *SQLiteDB) ListBillingWorkReports(orgID string, limit int) ([]*BillingWorkReport, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	query := `SELECT w.id, w.session_id, w.operator_id, w.summary, w.category, w.ticket_ref, w.created_at
		FROM billing_work_reports w`
	var args []any
	if orgID != "" {
		query += ` INNER JOIN billing_sessions s ON s.id = w.session_id WHERE s.org_id = ?`
		args = append(args, orgID)
	}
	query += ` ORDER BY w.id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*BillingWorkReport
	for rows.Next() {
		var r BillingWorkReport
		var createdAt string
		if err := rows.Scan(&r.ID, &r.SessionID, &r.OperatorID, &r.Summary, &r.Category, &r.TicketRef, &createdAt); err != nil {
			return nil, err
		}
		r.CreatedAt = parseSQLiteTime(createdAt)
		out = append(out, &r)
	}
	return out, rows.Err()
}

func (s *SQLiteDB) ListBillingCurrencies() ([]*BillingCurrency, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rows, err := s.db.Query(`SELECT code, symbol, exchange_rate_to_base FROM billing_currencies ORDER BY code`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*BillingCurrency
	for rows.Next() {
		var c BillingCurrency
		if err := rows.Scan(&c.Code, &c.Symbol, &c.ExchangeRateToBase); err != nil {
			return nil, err
		}
		out = append(out, &c)
	}
	return out, rows.Err()
}

func (s *SQLiteDB) UpsertBillingCurrency(c *BillingCurrency) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`INSERT INTO billing_currencies (code, symbol, exchange_rate_to_base) VALUES (?, ?, ?)
		 ON CONFLICT(code) DO UPDATE SET symbol=excluded.symbol, exchange_rate_to_base=excluded.exchange_rate_to_base`,
		c.Code, c.Symbol, c.ExchangeRateToBase,
	)
	return err
}

func (s *SQLiteDB) DeleteBillingCurrency(code string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`DELETE FROM billing_currencies WHERE code = ?`, strings.ToUpper(code))
	return err
}
