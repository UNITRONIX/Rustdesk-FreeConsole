package db

import (
	"strings"
	"time"
)

type pgScanner interface {
	Scan(dest ...any) error
}

func scanBillingSessionPG(row pgScanner) (*BillingSession, error) {
	var sess BillingSession
	var endedAt *time.Time
	err := row.Scan(
		&sess.ID, &sess.OrgID, &sess.ContractID, &sess.OperatorID, &sess.OperatorName,
		&sess.DeviceID, &sess.DeviceName, &sess.RelayUUID, &sess.Transport, &sess.Status,
		&sess.BillingPhase, &sess.StartedAt, &endedAt, &sess.RawSeconds, &sess.BilledMinutes,
		&sess.IncludedMinutesUsed, &sess.OverageMinutes, &sess.AmountIncluded, &sess.AmountOverage,
		&sess.Currency, &sess.ClockOffsetMSAtStart, &sess.ClockSyncedAtStart, &sess.CreatedAt, &sess.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	sess.EndedAt = endedAt
	return &sess, nil
}

func (pg *PostgresDB) CreateBillingPackage(p *BillingPackage) error {
	_, err := pg.pool.Exec(pg.ctx,
		`INSERT INTO billing_packages (id, name, description, included_minutes, overage_rate, currency, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
		p.ID, p.Name, p.Description, p.IncludedMinutes, p.OverageRate, p.Currency,
	)
	return err
}

func (pg *PostgresDB) GetBillingPackage(id string) (*BillingPackage, error) {
	var p BillingPackage
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT id, name, description, included_minutes, overage_rate, currency, created_at, updated_at
		 FROM billing_packages WHERE id = $1`, id,
	).Scan(&p.ID, &p.Name, &p.Description, &p.IncludedMinutes, &p.OverageRate, &p.Currency, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func (pg *PostgresDB) ListBillingPackages() ([]*BillingPackage, error) {
	rows, err := pg.pool.Query(pg.ctx,
		`SELECT id, name, description, included_minutes, overage_rate, currency, created_at, updated_at
		 FROM billing_packages ORDER BY name`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*BillingPackage
	for rows.Next() {
		var p BillingPackage
		if err := rows.Scan(&p.ID, &p.Name, &p.Description, &p.IncludedMinutes, &p.OverageRate, &p.Currency, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, &p)
	}
	return out, rows.Err()
}

func (pg *PostgresDB) UpdateBillingPackage(p *BillingPackage) error {
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE billing_packages SET name = $1, description = $2, included_minutes = $3, overage_rate = $4, currency = $5, updated_at = NOW()
		 WHERE id = $6`,
		p.Name, p.Description, p.IncludedMinutes, p.OverageRate, p.Currency, p.ID,
	)
	return err
}

func (pg *PostgresDB) DeleteBillingPackage(id string) error {
	_, err := pg.pool.Exec(pg.ctx, `DELETE FROM billing_packages WHERE id = $1`, id)
	return err
}

func (pg *PostgresDB) CreateBillingContract(c *BillingContract) error {
	_, err := pg.pool.Exec(pg.ctx,
		`INSERT INTO billing_contracts (id, target_type, target_key, package_id, status, remaining_minutes, overage_rate, hourly_rate, currency, valid_from, valid_until, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())`,
		c.ID, c.TargetType, c.TargetKey, c.PackageID, c.Status, c.RemainingMinutes, c.OverageRate, c.HourlyRate, c.Currency,
		c.ValidFrom, c.ValidUntil,
	)
	return err
}

func (pg *PostgresDB) CreateBillingOrgContract(c *BillingOrgContract) error {
	return pg.CreateBillingContract(c)
}

func (pg *PostgresDB) GetBillingContract(id string) (*BillingContract, error) {
	c, err := pg.queryBillingContract(`WHERE c.id = $1`, id)
	if err != nil && strings.Contains(err.Error(), "no rows") {
		return nil, nil
	}
	return c, err
}

func (pg *PostgresDB) GetBillingOrgContract(id string) (*BillingOrgContract, error) {
	return pg.GetBillingContract(id)
}

func (pg *PostgresDB) GetActiveBillingContract(targetType, targetKey string) (*BillingContract, error) {
	c, err := pg.queryBillingContract(
		`WHERE c.target_type = $1 AND c.target_key = $2 AND c.status = 'active' ORDER BY c.updated_at DESC LIMIT 1`,
		targetType, targetKey,
	)
	if err != nil && strings.Contains(err.Error(), "no rows") {
		return nil, nil
	}
	return c, err
}

func (pg *PostgresDB) GetActiveBillingOrgContract(orgID string) (*BillingOrgContract, error) {
	return pg.GetActiveBillingContract(BillingTargetOrg, orgID)
}

const pgBillingContractTargetNameSQL = `
	COALESCE(
		CASE c.target_type
			WHEN 'org' THEN (SELECT name FROM organizations WHERE id = c.target_key LIMIT 1)
			WHEN 'device' THEN (SELECT COALESCE(NULLIF(display_name, ''), hostname, c.target_key) FROM peers WHERE id = c.target_key LIMIT 1)
			WHEN 'device_group' THEN (SELECT name FROM device_groups WHERE guid = c.target_key LIMIT 1)
			WHEN 'folder' THEN (SELECT name FROM folders WHERE id::text = c.target_key LIMIT 1)
			ELSE c.target_key
		END, c.target_key)`

func (pg *PostgresDB) queryBillingContract(where string, args ...any) (*BillingContract, error) {
	query := `SELECT c.id, c.target_type, c.target_key, c.package_id, c.status, c.remaining_minutes, c.overage_rate,
		c.hourly_rate, c.currency, c.valid_from, c.valid_until, c.created_at, c.updated_at,
		COALESCE(p.name, ''), ` + pgBillingContractTargetNameSQL + `
		FROM billing_contracts c
		LEFT JOIN billing_packages p ON p.id = c.package_id ` + where

	var c BillingContract
	var overage *float64
	var validFrom, validUntil *time.Time
	err := pg.pool.QueryRow(pg.ctx, query, args...).Scan(
		&c.ID, &c.TargetType, &c.TargetKey, &c.PackageID, &c.Status, &c.RemainingMinutes, &overage,
		&c.HourlyRate, &c.Currency, &validFrom, &validUntil, &c.CreatedAt, &c.UpdatedAt,
		&c.PackageName, &c.TargetName,
	)
	if err != nil {
		return nil, err
	}
	c.OverageRate = overage
	c.ValidFrom = validFrom
	c.ValidUntil = validUntil
	c.FillLegacyOrgFields()
	return &c, nil
}

func (pg *PostgresDB) ListBillingContracts(filter BillingContractFilter) ([]*BillingContract, error) {
	var (
		conds []string
		args  []any
	)
	idx := 1
	if filter.TargetType != "" && filter.TargetKey != "" {
		conds = append(conds, "c.target_type = $"+itoa(idx))
		args = append(args, filter.TargetType)
		idx++
		conds = append(conds, "c.target_key = $"+itoa(idx))
		args = append(args, filter.TargetKey)
		idx++
	} else if filter.OrgID != "" {
		conds = append(conds, "c.target_type = $"+itoa(idx))
		args = append(args, BillingTargetOrg)
		idx++
		conds = append(conds, "c.target_key = $"+itoa(idx))
		args = append(args, filter.OrgID)
		idx++
	} else if filter.TargetType != "" {
		conds = append(conds, "c.target_type = $"+itoa(idx))
		args = append(args, filter.TargetType)
		idx++
	}
	if filter.Status != "" {
		conds = append(conds, "c.status = $"+itoa(idx))
		args = append(args, filter.Status)
		idx++
	}

	query := `SELECT c.id, c.target_type, c.target_key, c.package_id, c.status, c.remaining_minutes, c.overage_rate,
		c.hourly_rate, c.currency, c.valid_from, c.valid_until, c.created_at, c.updated_at,
		COALESCE(p.name, ''), ` + pgBillingContractTargetNameSQL + `
		FROM billing_contracts c
		LEFT JOIN billing_packages p ON p.id = c.package_id`
	if len(conds) > 0 {
		query += " WHERE " + strings.Join(conds, " AND ")
	}
	query += " ORDER BY c.updated_at DESC"

	rows, err := pg.pool.Query(pg.ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*BillingContract
	for rows.Next() {
		var c BillingContract
		var overage *float64
		var validFrom, validUntil *time.Time
		if err := rows.Scan(
			&c.ID, &c.TargetType, &c.TargetKey, &c.PackageID, &c.Status, &c.RemainingMinutes, &overage,
			&c.HourlyRate, &c.Currency, &validFrom, &validUntil, &c.CreatedAt, &c.UpdatedAt,
			&c.PackageName, &c.TargetName,
		); err != nil {
			return nil, err
		}
		c.OverageRate = overage
		c.ValidFrom = validFrom
		c.ValidUntil = validUntil
		c.FillLegacyOrgFields()
		out = append(out, &c)
	}
	return out, rows.Err()
}

func (pg *PostgresDB) ListBillingOrgContracts(filter BillingContractFilter) ([]*BillingOrgContract, error) {
	return pg.ListBillingContracts(filter)
}

func (pg *PostgresDB) UpdateBillingContract(c *BillingContract) error {
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE billing_contracts SET status = $1, remaining_minutes = $2, overage_rate = $3, hourly_rate = $4, currency = $5,
		 valid_from = $6, valid_until = $7, updated_at = NOW() WHERE id = $8`,
		c.Status, c.RemainingMinutes, c.OverageRate, c.HourlyRate, c.Currency,
		c.ValidFrom, c.ValidUntil, c.ID,
	)
	return err
}

func (pg *PostgresDB) UpdateBillingOrgContract(c *BillingOrgContract) error {
	return pg.UpdateBillingContract(c)
}

func (pg *PostgresDB) DeleteBillingContract(id string) error {
	_, err := pg.pool.Exec(pg.ctx, `DELETE FROM billing_contracts WHERE id = $1`, id)
	return err
}

func (pg *PostgresDB) CountBillingContractsByPackage(packageID string) (int, error) {
	var n int
	err := pg.pool.QueryRow(pg.ctx, `SELECT COUNT(*) FROM billing_contracts WHERE package_id = $1`, packageID).Scan(&n)
	return n, err
}

func (pg *PostgresDB) CountBillingContractsExpiringWithin(days int) (int, error) {
	if days <= 0 {
		days = 30
	}
	var n int
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT COUNT(*) FROM billing_contracts
		 WHERE status = 'active' AND valid_until IS NOT NULL
		 AND valid_until <= NOW() + ($1 * INTERVAL '1 day')`,
		days,
	).Scan(&n)
	return n, err
}

func (pg *PostgresDB) CreateBillingSession(sess *BillingSession) error {
	_, err := pg.pool.Exec(pg.ctx,
		`INSERT INTO billing_sessions (`+billingSessionCols+`)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, NOW(), NOW())`,
		sess.ID, sess.OrgID, sess.ContractID, sess.OperatorID, sess.OperatorName,
		sess.DeviceID, sess.DeviceName, sess.RelayUUID, sess.Transport, sess.Status,
		sess.BillingPhase, sess.StartedAt, sess.EndedAt,
		sess.RawSeconds, sess.BilledMinutes, sess.IncludedMinutesUsed, sess.OverageMinutes,
		sess.AmountIncluded, sess.AmountOverage, sess.Currency, sess.ClockOffsetMSAtStart, sess.ClockSyncedAtStart,
	)
	return err
}

func (pg *PostgresDB) GetBillingSession(id string) (*BillingSession, error) {
	row := pg.pool.QueryRow(pg.ctx, `SELECT `+billingSessionCols+` FROM billing_sessions WHERE id = $1`, id)
	return scanBillingSessionPG(row)
}

func (pg *PostgresDB) GetBillingSessionByRelayUUID(relayUUID string) (*BillingSession, error) {
	row := pg.pool.QueryRow(pg.ctx,
		`SELECT `+billingSessionCols+` FROM billing_sessions WHERE relay_uuid = $1 ORDER BY started_at DESC LIMIT 1`,
		relayUUID,
	)
	return scanBillingSessionPG(row)
}

func (pg *PostgresDB) UpdateBillingSession(sess *BillingSession) error {
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE billing_sessions SET status = $1, billing_phase = $2, ended_at = $3, raw_seconds = $4, billed_minutes = $5,
		 included_minutes_used = $6, overage_minutes = $7, amount_included = $8, amount_overage = $9, updated_at = NOW()
		 WHERE id = $10`,
		sess.Status, sess.BillingPhase, sess.EndedAt, sess.RawSeconds, sess.BilledMinutes,
		sess.IncludedMinutesUsed, sess.OverageMinutes, sess.AmountIncluded, sess.AmountOverage, sess.ID,
	)
	return err
}

func (pg *PostgresDB) ListBillingSessions(filter BillingSessionFilter) ([]*BillingSession, error) {
	limit := filter.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	offset := filter.Offset
	if offset < 0 {
		offset = 0
	}

	var (
		conds []string
		args  []any
	)
	idx := 1
	if filter.OrgID != "" {
		conds = append(conds, "org_id = $"+itoa(idx))
		args = append(args, filter.OrgID)
		idx++
	}
	if filter.Status != "" {
		conds = append(conds, "status = $"+itoa(idx))
		args = append(args, filter.Status)
		idx++
	}
	if filter.DeviceID != "" {
		conds = append(conds, "device_id = $"+itoa(idx))
		args = append(args, filter.DeviceID)
		idx++
	}

	query := `SELECT ` + billingSessionCols + ` FROM billing_sessions`
	if len(conds) > 0 {
		query += " WHERE " + strings.Join(conds, " AND ")
	}
	query += " ORDER BY started_at DESC LIMIT $" + itoa(idx) + " OFFSET $" + itoa(idx+1)
	args = append(args, limit, offset)

	rows, err := pg.pool.Query(pg.ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*BillingSession
	for rows.Next() {
		sess, err := scanBillingSessionPG(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sess)
	}
	return out, rows.Err()
}

func (pg *PostgresDB) InsertBillingLedgerEntry(e *BillingSessionLedger) error {
	_, err := pg.pool.Exec(pg.ctx,
		`INSERT INTO billing_session_ledger (session_id, event_type, details, created_at) VALUES ($1, $2, $3, NOW())`,
		e.SessionID, e.EventType, e.Details,
	)
	return err
}

func (pg *PostgresDB) ListBillingLedger(sessionID string) ([]*BillingSessionLedger, error) {
	rows, err := pg.pool.Query(pg.ctx,
		`SELECT id, session_id, event_type, details, created_at FROM billing_session_ledger WHERE session_id = $1 ORDER BY id`,
		sessionID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*BillingSessionLedger
	for rows.Next() {
		var e BillingSessionLedger
		if err := rows.Scan(&e.ID, &e.SessionID, &e.EventType, &e.Details, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, &e)
	}
	return out, rows.Err()
}

func (pg *PostgresDB) CreateBillingWorkReport(r *BillingWorkReport) error {
	err := pg.pool.QueryRow(pg.ctx,
		`INSERT INTO billing_work_reports (session_id, operator_id, summary, category, ticket_ref, created_at)
		 VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id`,
		r.SessionID, r.OperatorID, r.Summary, r.Category, r.TicketRef,
	).Scan(&r.ID)
	return err
}

func (pg *PostgresDB) GetBillingWorkReportBySession(sessionID string) (*BillingWorkReport, error) {
	var r BillingWorkReport
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT id, session_id, operator_id, summary, category, ticket_ref, created_at FROM billing_work_reports WHERE session_id = $1`,
		sessionID,
	).Scan(&r.ID, &r.SessionID, &r.OperatorID, &r.Summary, &r.Category, &r.TicketRef, &r.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (pg *PostgresDB) ListBillingWorkReports(orgID string, limit int) ([]*BillingWorkReport, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}

	query := `SELECT w.id, w.session_id, w.operator_id, w.summary, w.category, w.ticket_ref, w.created_at
		FROM billing_work_reports w`
	var args []any
	if orgID != "" {
		query += ` INNER JOIN billing_sessions s ON s.id = w.session_id WHERE s.org_id = $1`
		args = append(args, orgID)
		query += ` ORDER BY w.id DESC LIMIT $2`
		args = append(args, limit)
	} else {
		query += ` ORDER BY w.id DESC LIMIT $1`
		args = append(args, limit)
	}

	rows, err := pg.pool.Query(pg.ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []*BillingWorkReport
	for rows.Next() {
		var r BillingWorkReport
		if err := rows.Scan(&r.ID, &r.SessionID, &r.OperatorID, &r.Summary, &r.Category, &r.TicketRef, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, &r)
	}
	return out, rows.Err()
}

func (pg *PostgresDB) ListBillingCurrencies() ([]*BillingCurrency, error) {
	rows, err := pg.pool.Query(pg.ctx,
		`SELECT code, symbol, exchange_rate_to_base FROM billing_currencies ORDER BY code`,
	)
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

func (pg *PostgresDB) UpsertBillingCurrency(c *BillingCurrency) error {
	_, err := pg.pool.Exec(pg.ctx,
		`INSERT INTO billing_currencies (code, symbol, exchange_rate_to_base) VALUES ($1, $2, $3)
		 ON CONFLICT (code) DO UPDATE SET symbol = EXCLUDED.symbol, exchange_rate_to_base = EXCLUDED.exchange_rate_to_base`,
		c.Code, c.Symbol, c.ExchangeRateToBase,
	)
	return err
}

func (pg *PostgresDB) DeleteBillingCurrency(code string) error {
	_, err := pg.pool.Exec(pg.ctx, `DELETE FROM billing_currencies WHERE code = $1`, strings.ToUpper(code))
	return err
}
