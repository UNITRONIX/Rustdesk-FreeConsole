package db

import (
	"database/sql"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
//  Help Requests (SQLite)
// ---------------------------------------------------------------------------

// CreateHelpRequest inserts a new help request and returns its ID.
func (s *SQLiteDB) CreateHelpRequest(r *HelpRequest) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	status := r.Status
	if status == "" {
		status = HelpStatusPending
	}

	result, err := s.db.Exec(
		`INSERT INTO help_requests (device_id, hostname, org_id, message, status, handled_by)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		r.DeviceID, r.Hostname, r.OrgID, r.Message, status, r.HandledBy,
	)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

// GetHelpRequest returns a single help request by ID.
func (s *SQLiteDB) GetHelpRequest(id int64) (*HelpRequest, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var r HelpRequest
	var createdAt, updatedAt string
	err := s.db.QueryRow(
		`SELECT id, device_id, hostname, org_id, message, status, handled_by, created_at, updated_at
		 FROM help_requests WHERE id = ?`, id,
	).Scan(&r.ID, &r.DeviceID, &r.Hostname, &r.OrgID, &r.Message, &r.Status, &r.HandledBy, &createdAt, &updatedAt)
	if err != nil {
		return nil, err
	}
	r.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", createdAt)
	r.UpdatedAt, _ = time.Parse("2006-01-02 15:04:05", updatedAt)
	return &r, nil
}

// ListHelpRequests returns help requests matching the filter, newest first.
func (s *SQLiteDB) ListHelpRequests(filter HelpRequestFilter) ([]*HelpRequest, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	limit := filter.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}

	var (
		conds []string
		args  []any
	)
	if filter.Status != "" {
		conds = append(conds, "status = ?")
		args = append(args, filter.Status)
	}
	if filter.DeviceID != "" {
		conds = append(conds, "device_id = ?")
		args = append(args, filter.DeviceID)
	}
	if filter.OrgID != "" {
		conds = append(conds, "org_id = ?")
		args = append(args, filter.OrgID)
	}

	query := `SELECT id, device_id, hostname, org_id, message, status, handled_by, created_at, updated_at
		 FROM help_requests`
	if len(conds) > 0 {
		query += " WHERE " + strings.Join(conds, " AND ")
	}
	query += " ORDER BY id DESC LIMIT ?"
	args = append(args, limit)

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var reqs []*HelpRequest
	for rows.Next() {
		var r HelpRequest
		var createdAt, updatedAt string
		if err := rows.Scan(&r.ID, &r.DeviceID, &r.Hostname, &r.OrgID, &r.Message, &r.Status, &r.HandledBy, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		r.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", createdAt)
		r.UpdatedAt, _ = time.Parse("2006-01-02 15:04:05", updatedAt)
		reqs = append(reqs, &r)
	}
	return reqs, rows.Err()
}

// UpdateHelpRequestStatus changes the status (and handler) of a help request.
func (s *SQLiteDB) UpdateHelpRequestStatus(id int64, status, handledBy string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(
		`UPDATE help_requests SET status = ?, handled_by = ?, updated_at = datetime('now')
		 WHERE id = ?`,
		status, handledBy, id,
	)
	return err
}

// PruneHelpRequests deletes resolved/cancelled requests older than maxAge.
func (s *SQLiteDB) PruneHelpRequests(maxAge time.Duration) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	cutoff := time.Now().Add(-maxAge).UTC().Format("2006-01-02 15:04:05")
	result, err := s.db.Exec(
		`DELETE FROM help_requests
		 WHERE status IN (?, ?) AND updated_at < ?`,
		HelpStatusResolved, HelpStatusCancelled, cutoff,
	)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// GetDeviceOrgID returns the organization ID a device belongs to, or "".
func (s *SQLiteDB) GetDeviceOrgID(deviceID string) (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var orgID string
	err := s.db.QueryRow(
		`SELECT org_id FROM org_devices WHERE device_id = ? LIMIT 1`, deviceID,
	).Scan(&orgID)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return orgID, nil
}
