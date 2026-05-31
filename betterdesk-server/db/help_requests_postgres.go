package db

import (
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// ── Help Requests ─────────────────────────────────────────────────────

// CreateHelpRequest inserts a new help request and returns its ID.
func (pg *PostgresDB) CreateHelpRequest(r *HelpRequest) (int64, error) {
	status := r.Status
	if status == "" {
		status = HelpStatusPending
	}

	var id int64
	err := pg.pool.QueryRow(pg.ctx,
		`INSERT INTO help_requests (device_id, hostname, org_id, message, status, handled_by)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		r.DeviceID, r.Hostname, r.OrgID, r.Message, status, r.HandledBy,
	).Scan(&id)
	return id, err
}

// GetHelpRequest returns a single help request by ID.
func (pg *PostgresDB) GetHelpRequest(id int64) (*HelpRequest, error) {
	var r HelpRequest
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT id, device_id, hostname, org_id, message, status, handled_by, created_at, updated_at
		 FROM help_requests WHERE id = $1`, id,
	).Scan(&r.ID, &r.DeviceID, &r.Hostname, &r.OrgID, &r.Message, &r.Status, &r.HandledBy, &r.CreatedAt, &r.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// ListHelpRequests returns help requests matching the filter, newest first.
func (pg *PostgresDB) ListHelpRequests(filter HelpRequestFilter) ([]*HelpRequest, error) {
	limit := filter.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}

	var (
		conds []string
		args  []any
	)
	idx := 1
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
	if filter.OrgID != "" {
		conds = append(conds, "org_id = $"+itoa(idx))
		args = append(args, filter.OrgID)
		idx++
	}

	query := `SELECT id, device_id, hostname, org_id, message, status, handled_by, created_at, updated_at
		 FROM help_requests`
	if len(conds) > 0 {
		query += " WHERE " + strings.Join(conds, " AND ")
	}
	query += " ORDER BY id DESC LIMIT $" + itoa(idx)
	args = append(args, limit)

	rows, err := pg.pool.Query(pg.ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var reqs []*HelpRequest
	for rows.Next() {
		var r HelpRequest
		if err := rows.Scan(&r.ID, &r.DeviceID, &r.Hostname, &r.OrgID, &r.Message, &r.Status, &r.HandledBy, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		reqs = append(reqs, &r)
	}
	return reqs, rows.Err()
}

// UpdateHelpRequestStatus changes the status (and handler) of a help request.
func (pg *PostgresDB) UpdateHelpRequestStatus(id int64, status, handledBy string) error {
	_, err := pg.pool.Exec(pg.ctx,
		`UPDATE help_requests SET status = $1, handled_by = $2, updated_at = NOW()
		 WHERE id = $3`,
		status, handledBy, id,
	)
	return err
}

// PruneHelpRequests deletes resolved/cancelled requests older than maxAge.
func (pg *PostgresDB) PruneHelpRequests(maxAge time.Duration) (int64, error) {
	cutoff := time.Now().Add(-maxAge)
	result, err := pg.pool.Exec(pg.ctx,
		`DELETE FROM help_requests
		 WHERE status IN ($1, $2) AND updated_at < $3`,
		HelpStatusResolved, HelpStatusCancelled, cutoff,
	)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected(), nil
}

// GetDeviceOrgID returns the organization ID a device belongs to, or "".
func (pg *PostgresDB) GetDeviceOrgID(deviceID string) (string, error) {
	var orgID string
	err := pg.pool.QueryRow(pg.ctx,
		`SELECT org_id FROM org_devices WHERE device_id = $1 LIMIT 1`, deviceID,
	).Scan(&orgID)
	if err == pgx.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return orgID, nil
}
