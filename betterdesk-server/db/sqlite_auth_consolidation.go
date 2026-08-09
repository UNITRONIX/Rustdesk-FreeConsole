package db

// Safe, one-way consolidation of the legacy Node.js auth.db into the selected
// SQLite database. The legacy file is never changed or deleted by this code.

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const sqliteAuthConsolidationName = "sqlite_auth_consolidation_v1"

var sqliteIdentifier = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// SQLiteAuthConsolidationOptions controls a safe auth.db migration. Services
// using either database must be stopped before a non-dry-run migration.
type SQLiteAuthConsolidationOptions struct {
	DBPath     string
	AuthDBPath string
	BackupDir  string
	DryRun     bool
	Now        func() time.Time
}

// SQLiteAuthConsolidationReport is safe to display in an updater or CLI. It
// deliberately includes no user credentials, tokens, or other secret values.
type SQLiteAuthConsolidationReport struct {
	SourcePath       string   `json:"source_path"`
	TargetPath       string   `json:"target_path"`
	DryRun           bool     `json:"dry_run"`
	AlreadyComplete  bool     `json:"already_complete"`
	SourceSHA256     string   `json:"source_sha256,omitempty"`
	TargetBackupPath string   `json:"target_backup_path,omitempty"`
	SourceBackupPath string   `json:"source_backup_path,omitempty"`
	CandidatePath    string   `json:"candidate_path,omitempty"`
	TablesCopied     []string `json:"tables_copied,omitempty"`
	Warnings         []string `json:"warnings,omitempty"`
}

type sqliteColumn struct {
	Name string
	Type string
	PK   int
}

// ConsolidateSQLiteAuth moves the legacy auth.db content into a candidate copy
// of DBPath, validates it, then atomically replaces DBPath. If anything fails
// before the final rename the active database is untouched. Any conflicting
// data aborts the migration rather than silently picking a winner.
func ConsolidateSQLiteAuth(opts SQLiteAuthConsolidationOptions) (*SQLiteAuthConsolidationReport, error) {
	if strings.TrimSpace(opts.DBPath) == "" || strings.TrimSpace(opts.AuthDBPath) == "" {
		return nil, errors.New("sqlite auth consolidation requires both DBPath and AuthDBPath")
	}
	if isPostgresDSN(opts.DBPath) {
		return nil, errors.New("sqlite auth consolidation is not applicable to PostgreSQL")
	}

	targetPath, err := filepath.Abs(opts.DBPath)
	if err != nil {
		return nil, fmt.Errorf("resolve target database path: %w", err)
	}
	sourcePath, err := filepath.Abs(opts.AuthDBPath)
	if err != nil {
		return nil, fmt.Errorf("resolve legacy auth database path: %w", err)
	}
	if samePath(targetPath, sourcePath) {
		return nil, errors.New("legacy auth database and target database must be different files")
	}
	if _, err := os.Stat(targetPath); err != nil {
		return nil, fmt.Errorf("target database unavailable: %w", err)
	}
	if _, err := os.Stat(sourcePath); err != nil {
		return nil, fmt.Errorf("legacy auth database unavailable: %w", err)
	}

	report := &SQLiteAuthConsolidationReport{
		SourcePath: sourcePath,
		TargetPath: targetPath,
		DryRun:     opts.DryRun,
	}
	if complete, err := SQLiteAuthConsolidated(targetPath); err != nil {
		return nil, err
	} else if complete {
		report.AlreadyComplete = true
		return report, nil
	}

	if err := validateSQLiteFile(sourcePath); err != nil {
		return nil, fmt.Errorf("legacy auth database validation failed: %w", err)
	}
	if err := validateSQLiteFile(targetPath); err != nil {
		return nil, fmt.Errorf("target database validation failed: %w", err)
	}
	sourceHash, err := fileSHA256(sourcePath)
	if err != nil {
		return nil, fmt.Errorf("hash legacy auth database: %w", err)
	}
	report.SourceSHA256 = sourceHash

	if opts.DryRun {
		if err := validateUserCollisions(targetPath, sourcePath); err != nil {
			return nil, err
		}
		src, err := openSQLiteReadOnly(sourcePath)
		if err != nil {
			return nil, err
		}
		defer src.Close()
		tables, err := sqliteTables(src)
		if err != nil {
			return nil, err
		}
		report.TablesCopied = sortedKeys(tables)
		return report, nil
	}

	now := time.Now
	if opts.Now != nil {
		now = opts.Now
	}
	stamp := now().UTC().Format("20060102T150405Z")
	backupDir := opts.BackupDir
	if strings.TrimSpace(backupDir) == "" {
		backupDir = filepath.Join(filepath.Dir(targetPath), "backups")
	}
	if err := os.MkdirAll(backupDir, 0700); err != nil {
		return nil, fmt.Errorf("create consolidation backup directory: %w", err)
	}

	targetBackup := filepath.Join(backupDir, filepath.Base(targetPath)+".pre-auth-consolidation-"+stamp)
	sourceBackup := filepath.Join(backupDir, filepath.Base(sourcePath)+".legacy-auth-"+stamp)
	candidatePath := targetPath + ".auth-consolidation-" + stamp + ".candidate"
	if err := sqliteSnapshot(targetPath, targetBackup); err != nil {
		return nil, fmt.Errorf("backup target database: %w", err)
	}
	if err := sqliteSnapshot(sourcePath, sourceBackup); err != nil {
		return nil, fmt.Errorf("backup legacy auth database: %w", err)
	}
	if err := sqliteSnapshot(targetPath, candidatePath); err != nil {
		return nil, fmt.Errorf("create candidate database: %w", err)
	}
	report.TargetBackupPath = targetBackup
	report.SourceBackupPath = sourceBackup
	report.CandidatePath = candidatePath

	candidate, err := openSQLiteReadWrite(candidatePath)
	if err != nil {
		return nil, err
	}
	defer candidate.Close()
	defer os.Remove(candidatePath)

	if err := migrateLegacyAuthIntoCandidate(candidate, sourcePath, sourceHash, &report.TablesCopied); err != nil {
		return nil, fmt.Errorf("migrate legacy auth into candidate: %w", err)
	}
	if err := validateSQLiteDB(candidate); err != nil {
		return nil, fmt.Errorf("candidate database validation failed: %w", err)
	}
	if err := candidate.Close(); err != nil {
		return nil, fmt.Errorf("close candidate database: %w", err)
	}

	// Keep the existing DB as a second rollback path. os.Rename is atomic on a
	// single volume; the candidate is always created alongside the target.
	rollbackPath := targetPath + ".pre-auth-consolidation-" + stamp
	if err := os.Rename(targetPath, rollbackPath); err != nil {
		return nil, fmt.Errorf("stage original target database for rollback: %w", err)
	}
	if err := os.Rename(candidatePath, targetPath); err != nil {
		_ = os.Rename(rollbackPath, targetPath)
		return nil, fmt.Errorf("activate consolidated candidate: %w", err)
	}
	// Prevent the deferred cleanup from removing the activated file.
	report.CandidatePath = ""
	return report, nil
}

// RollbackSQLiteAuth replaces DBPath with a known-good snapshot generated by
// ConsolidateSQLiteAuth. It never deletes the failed active DB.
func RollbackSQLiteAuth(dbPath, backupPath string) error {
	if isPostgresDSN(dbPath) {
		return errors.New("sqlite auth rollback is not applicable to PostgreSQL")
	}
	targetPath, err := filepath.Abs(dbPath)
	if err != nil {
		return err
	}
	sourcePath, err := filepath.Abs(backupPath)
	if err != nil {
		return err
	}
	if err := validateSQLiteFile(sourcePath); err != nil {
		return fmt.Errorf("rollback snapshot validation failed: %w", err)
	}
	stamp := time.Now().UTC().Format("20060102T150405Z")
	failedPath := targetPath + ".failed-auth-consolidation-" + stamp
	if err := os.Rename(targetPath, failedPath); err != nil {
		return fmt.Errorf("stage failed target database: %w", err)
	}
	if err := sqliteSnapshot(sourcePath, targetPath); err != nil {
		_ = os.Rename(failedPath, targetPath)
		return fmt.Errorf("restore snapshot: %w", err)
	}
	return nil
}

// SQLiteAuthConsolidated reports whether the selected SQLite database already
// contains the successful, versioned consolidation marker.
func SQLiteAuthConsolidated(dbPath string) (bool, error) {
	if isPostgresDSN(dbPath) {
		return true, nil
	}
	if _, err := os.Stat(dbPath); err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	db, err := openSQLiteReadOnly(dbPath)
	if err != nil {
		return false, err
	}
	defer db.Close()
	var count int
	err = db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='betterdesk_migrations'`).Scan(&count)
	if err != nil || count == 0 {
		return false, nil
	}
	var marker int
	err = db.QueryRow(`SELECT COUNT(*) FROM betterdesk_migrations WHERE name = ? AND status = 'complete'`, sqliteAuthConsolidationName).Scan(&marker)
	if err != nil {
		return false, nil
	}
	return marker > 0, nil
}

func migrateLegacyAuthIntoCandidate(candidate *sql.DB, sourcePath, sourceHash string, copied *[]string) error {
	if _, err := candidate.Exec(`ATTACH DATABASE ? AS legacy_auth`, sourcePath); err != nil {
		return fmt.Errorf("attach legacy auth database: %w", err)
	}
	defer candidate.Exec(`DETACH DATABASE legacy_auth`)

	// The candidate is a disposable snapshot, so a failed merge can simply be
	// discarded. Avoid a long explicit transaction across an attached database:
	// it can self-deadlock with SQLite driver connection pooling.
	if _, err := candidate.Exec(`
		CREATE TABLE IF NOT EXISTS betterdesk_migrations (
			name TEXT PRIMARY KEY,
			status TEXT NOT NULL,
			source_sha256 TEXT NOT NULL DEFAULT '',
			completed_at TEXT NOT NULL DEFAULT (datetime('now')),
			details TEXT NOT NULL DEFAULT ''
		)`); err != nil {
		return err
	}
	if _, err := candidate.Exec(`
		INSERT INTO betterdesk_migrations (name, status, source_sha256, details)
		VALUES (?, 'running', ?, 'auth.db to db_v2.sqlite3 consolidation')
		ON CONFLICT(name) DO UPDATE SET status='running', source_sha256=excluded.source_sha256,
			completed_at=datetime('now')`, sqliteAuthConsolidationName, sourceHash); err != nil {
		return err
	}

	sourceTables, err := sqliteTablesAttached(candidate, "legacy_auth")
	if err != nil {
		return err
	}
	targetTables, err := sqliteTables(candidate)
	if err != nil {
		return err
	}
	if _, ok := sourceTables["users"]; !ok {
		return errors.New("legacy auth database has no users table")
	}
	if _, ok := targetTables["users"]; !ok {
		return errors.New("target database has no users table")
	}
	if err := ensureUserColumns(candidate); err != nil {
		return err
	}
	if err := ensureUsersCompatible(candidate); err != nil {
		return err
	}

	tableNames := sortedKeys(sourceTables)
	for _, table := range tableNames {
		if table == "sqlite_sequence" || table == "address_books" {
			continue
		}
		if !sqliteIdentifier.MatchString(table) {
			return fmt.Errorf("unsafe legacy table name %q", table)
		}
		if _, exists := targetTables[table]; !exists {
			if err := createLegacyTable(candidate, sourceTables[table]); err != nil {
				return fmt.Errorf("create legacy table %s: %w", table, err)
			}
			targetTables[table] = sourceTables[table]
		}
		if err := copyCompatibleTable(candidate, table); err != nil {
			return fmt.Errorf("copy legacy table %s: %w", table, err)
		}
		*copied = append(*copied, table)
	}
	if _, hasAddressBooks := sourceTables["address_books"]; hasAddressBooks {
		if err := copyAddressBooks(candidate); err != nil {
			return err
		}
		*copied = append(*copied, "address_books")
	}
	if err := mergeMissingUserProfileFields(candidate); err != nil {
		return err
	}
	if _, err := candidate.Exec(`
		UPDATE betterdesk_migrations
		SET status='complete', completed_at=datetime('now')
		WHERE name = ?`, sqliteAuthConsolidationName); err != nil {
		return err
	}
	return nil
}

func ensureUserColumns(candidate *sql.DB) error {
	legacyCols, err := sqliteColumns(candidate, "legacy_auth", "users")
	if err != nil {
		return err
	}
	targetCols, err := sqliteColumns(candidate, "main", "users")
	if err != nil {
		return err
	}
	existing := make(map[string]bool, len(targetCols))
	for _, col := range targetCols {
		existing[col.Name] = true
	}
	for _, col := range legacyCols {
		if existing[col.Name] || col.Name == "id" {
			continue
		}
		// Profile metadata is safe to add as nullable text. Authentication
		// columns already exist in the Go schema and are handled separately.
		if !sqliteIdentifier.MatchString(col.Name) {
			return fmt.Errorf("unsafe users column name %q", col.Name)
		}
		if _, err := candidate.Exec(`ALTER TABLE users ADD COLUMN "` + col.Name + `" TEXT DEFAULT ''`); err != nil {
			return fmt.Errorf("add users.%s: %w", col.Name, err)
		}
	}
	return nil
}

func ensureUsersCompatible(candidate *sql.DB) error {
	rows, err := candidate.Query(`
		SELECT id, username, COALESCE(password_hash,''), COALESCE(role,''), COALESCE(totp_secret,''), COALESCE(totp_enabled,0)
		FROM legacy_auth.users ORDER BY id`)
	if err != nil {
		return err
	}
	type legacyUser struct {
		id          int64
		username    string
		password    string
		role        string
		totpSecret  string
		totpEnabled int
	}
	var users []legacyUser
	for rows.Next() {
		var user legacyUser
		if err := rows.Scan(&user.id, &user.username, &user.password, &user.role, &user.totpSecret, &user.totpEnabled); err != nil {
			rows.Close()
			return err
		}
		users = append(users, user)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, user := range users {
		var targetID int64
		var targetHash, targetRole, targetSecret string
		var targetEnabled int
		err = candidate.QueryRow(`
			SELECT id, COALESCE(password_hash,''), COALESCE(role,''), COALESCE(totp_secret,''), COALESCE(totp_enabled,0)
			FROM users WHERE username = ?`, user.username).Scan(&targetID, &targetHash, &targetRole, &targetSecret, &targetEnabled)
		if errors.Is(err, sql.ErrNoRows) {
			var otherUsername string
			err = candidate.QueryRow(`SELECT username FROM users WHERE id = ?`, user.id).Scan(&otherUsername)
			if err == nil {
				return fmt.Errorf("user id collision: legacy %q uses id %d already owned by %q", user.username, user.id, otherUsername)
			}
			if !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		if targetID != user.id {
			return fmt.Errorf("user identity conflict for %q: legacy id %d, target id %d", user.username, user.id, targetID)
		}
		if targetHash != user.password || targetRole != user.role || targetSecret != user.totpSecret || targetEnabled != user.totpEnabled {
			return fmt.Errorf("credential or role conflict for user %q; resolve manually before consolidation", user.username)
		}
	}
	return nil
}

func mergeMissingUserProfileFields(candidate *sql.DB) error {
	cols, err := sqliteColumns(candidate, "main", "users")
	if err != nil {
		return err
	}
	legacyCols, err := sqliteColumns(candidate, "legacy_auth", "users")
	if err != nil {
		return err
	}
	legacySet := map[string]bool{}
	for _, col := range legacyCols {
		legacySet[col.Name] = true
	}
	for _, col := range cols {
		if !legacySet[col.Name] || col.Name == "id" || col.Name == "username" ||
			col.Name == "password_hash" || col.Name == "role" || col.Name == "totp_secret" ||
			col.Name == "totp_enabled" || col.Name == "totp_recovery_codes" {
			continue
		}
		if !sqliteIdentifier.MatchString(col.Name) {
			continue
		}
		q := `UPDATE users AS target SET "` + col.Name + `" = (
			SELECT legacy."` + col.Name + `" FROM legacy_auth.users AS legacy
			WHERE legacy.username = target.username
		) WHERE (target."` + col.Name + `" IS NULL OR target."` + col.Name + `" = '')
			AND EXISTS (SELECT 1 FROM legacy_auth.users AS legacy WHERE legacy.username = target.username
				AND legacy."` + col.Name + `" IS NOT NULL AND legacy."` + col.Name + `" != '')`
		if _, err := candidate.Exec(q); err != nil {
			return err
		}
	}
	return nil
}

func copyAddressBooks(candidate *sql.DB) error {
	targetCols, err := sqliteColumns(candidate, "main", "address_books")
	if err != nil {
		if strings.Contains(err.Error(), "no such table") {
			if err := createLegacyTable(candidate, `CREATE TABLE address_books (
				username TEXT NOT NULL, ab_type TEXT NOT NULL DEFAULT 'legacy', data TEXT DEFAULT '{}',
				updated_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (username, ab_type))`); err != nil {
				return err
			}
			return copyAddressBooks(candidate)
		}
		return err
	}
	targetHasUsername := false
	for _, col := range targetCols {
		if col.Name == "username" {
			targetHasUsername = true
			break
		}
	}
	if !targetHasUsername {
		return copyCompatibleTable(candidate, "address_books")
	}
	rows, err := candidate.Query(`
		SELECT u.username, ab.ab_type, ab.data, COALESCE(ab.updated_at,'')
		FROM legacy_auth.address_books ab
		INNER JOIN legacy_auth.users u ON u.id = ab.user_id
		ORDER BY u.username, ab.ab_type`)
	if err != nil {
		return err
	}
	type legacyAddressBook struct {
		username  string
		abType    string
		data      string
		updatedAt string
	}
	var addressBooks []legacyAddressBook
	for rows.Next() {
		var addressBook legacyAddressBook
		if err := rows.Scan(&addressBook.username, &addressBook.abType, &addressBook.data, &addressBook.updatedAt); err != nil {
			rows.Close()
			return err
		}
		addressBooks = append(addressBooks, addressBook)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, addressBook := range addressBooks {
		var existing string
		err = candidate.QueryRow(`SELECT data FROM address_books WHERE username = ? AND ab_type = ?`, addressBook.username, addressBook.abType).Scan(&existing)
		if err == nil {
			if existing != addressBook.data {
				return fmt.Errorf("address book conflict for user %q type %q", addressBook.username, addressBook.abType)
			}
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if _, err := candidate.Exec(`
			INSERT INTO address_books (username, ab_type, data, updated_at) VALUES (?, ?, ?, ?)`,
			addressBook.username, addressBook.abType, addressBook.data, addressBook.updatedAt); err != nil {
			return err
		}
	}
	return nil
}

func copyCompatibleTable(candidate *sql.DB, table string) error {
	sourceCols, err := sqliteColumns(candidate, "legacy_auth", table)
	if err != nil {
		return err
	}
	targetCols, err := sqliteColumns(candidate, "main", table)
	if err != nil {
		return err
	}
	targetSet := make(map[string]bool, len(targetCols))
	for _, col := range targetCols {
		targetSet[col.Name] = true
	}
	var cols []string
	var primary []string
	for _, col := range sourceCols {
		if targetSet[col.Name] {
			cols = append(cols, col.Name)
			if col.PK > 0 {
				primary = append(primary, col.Name)
			}
		}
	}
	if len(cols) == 0 {
		return fmt.Errorf("no common columns")
	}
	for _, col := range cols {
		if !sqliteIdentifier.MatchString(col) {
			return fmt.Errorf("unsafe column name %q", col)
		}
	}
	columnsSQL := quoteIdentifiers(cols)
	if len(primary) == 0 {
		_, err := candidate.Exec(`INSERT INTO "` + table + `" (` + columnsSQL + `)
			SELECT ` + columnsSQL + ` FROM legacy_auth."` + table + `"`)
		return err
	}
	predicates := make([]string, 0, len(primary))
	for _, col := range primary {
		predicates = append(predicates, `target."`+col+`" IS source."`+col+`"`)
	}
	different := make([]string, 0, len(cols))
	for _, col := range cols {
		different = append(different, `NOT (target."`+col+`" IS source."`+col+`")`)
	}
	conflictSQL := `SELECT 1 FROM legacy_auth."` + table + `" source
		INNER JOIN main."` + table + `" target ON ` + strings.Join(predicates, " AND ") +
		` WHERE ` + strings.Join(different, " OR ") + ` LIMIT 1`
	var conflict int
	err = candidate.QueryRow(conflictSQL).Scan(&conflict)
	if err == nil {
		return errors.New("conflicting row with the same primary key")
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	_, err = candidate.Exec(`INSERT INTO "` + table + `" (` + columnsSQL + `)
		SELECT ` + columnsSQL + ` FROM legacy_auth."` + table + `" source
		WHERE NOT EXISTS (SELECT 1 FROM main."` + table + `" target WHERE ` + strings.Join(predicates, " AND ") + `)`)
	return err
}

func createLegacyTable(candidate *sql.DB, ddl string) error {
	if !strings.HasPrefix(strings.ToUpper(strings.TrimSpace(ddl)), "CREATE TABLE") {
		return errors.New("legacy schema is not a CREATE TABLE statement")
	}
	_, err := candidate.Exec(ddl)
	return err
}

func validateUserCollisions(targetPath, sourcePath string) error {
	target, err := openSQLiteReadOnly(targetPath)
	if err != nil {
		return err
	}
	defer target.Close()
	source, err := openSQLiteReadOnly(sourcePath)
	if err != nil {
		return err
	}
	defer source.Close()
	var sourceCount int
	if err := source.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&sourceCount); err != nil {
		return fmt.Errorf("legacy auth users table: %w", err)
	}
	if sourceCount == 0 {
		return nil
	}
	// A dry run is deliberately conservative. The full candidate migration
	// repeats these checks transactionally before it can switch files.
	rows, err := source.Query(`SELECT id, username FROM users ORDER BY id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var username string
		if err := rows.Scan(&id, &username); err != nil {
			return err
		}
		var targetUsername string
		err = target.QueryRow(`SELECT username FROM users WHERE id = ?`, id).Scan(&targetUsername)
		if err == nil && targetUsername != username {
			return fmt.Errorf("dry-run user id collision: legacy %q id %d conflicts with %q", username, id, targetUsername)
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
	}
	return rows.Err()
}

func sqliteTables(db *sql.DB) (map[string]string, error) {
	rows, err := db.Query(`SELECT name, sql FROM sqlite_master
		WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var name, ddl sql.NullString
		if err := rows.Scan(&name, &ddl); err != nil {
			return nil, err
		}
		if name.Valid && ddl.Valid {
			out[name.String] = ddl.String
		}
	}
	return out, rows.Err()
}

func sqliteTablesAttached(db *sql.DB, schema string) (map[string]string, error) {
	if !sqliteIdentifier.MatchString(schema) {
		return nil, errors.New("unsafe SQLite schema name")
	}
	rows, err := db.Query(`SELECT name, sql FROM ` + schema + `.sqlite_master
		WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var name, ddl sql.NullString
		if err := rows.Scan(&name, &ddl); err != nil {
			return nil, err
		}
		if name.Valid && ddl.Valid {
			out[name.String] = ddl.String
		}
	}
	return out, rows.Err()
}

func sqliteColumns(db *sql.DB, schema, table string) ([]sqliteColumn, error) {
	if !sqliteIdentifier.MatchString(schema) || !sqliteIdentifier.MatchString(table) {
		return nil, errors.New("unsafe SQLite schema or table name")
	}
	rows, err := db.Query(`PRAGMA ` + schema + `.table_info("` + table + `")`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []sqliteColumn
	for rows.Next() {
		var cid int
		var col sqliteColumn
		var notNull int
		var defaultValue any
		if err := rows.Scan(&cid, &col.Name, &col.Type, &notNull, &defaultValue, &col.PK); err != nil {
			return nil, err
		}
		out = append(out, col)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no such table %s.%s", schema, table)
	}
	return out, nil
}

func validateSQLiteFile(path string) error {
	db, err := openSQLiteReadOnly(path)
	if err != nil {
		return err
	}
	defer db.Close()
	return validateSQLiteDB(db)
}

func validateSQLiteDB(db *sql.DB) error {
	var integrity string
	if err := db.QueryRow(`PRAGMA integrity_check`).Scan(&integrity); err != nil {
		return err
	}
	if integrity != "ok" {
		return fmt.Errorf("integrity_check: %s", integrity)
	}
	rows, err := db.Query(`PRAGMA foreign_key_check`)
	if err != nil {
		return err
	}
	defer rows.Close()
	if rows.Next() {
		return errors.New("foreign_key_check returned violations")
	}
	return rows.Err()
}

func sqliteSnapshot(sourcePath, destinationPath string) error {
	if err := os.RemoveAll(destinationPath); err != nil {
		return err
	}
	db, err := openSQLiteReadWrite(sourcePath)
	if err != nil {
		return err
	}
	defer db.Close()
	if _, err := db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		return err
	}
	if _, err := db.Exec(`VACUUM INTO ?`, destinationPath); err != nil {
		return err
	}
	if err := validateSQLiteFile(destinationPath); err != nil {
		return err
	}
	return nil
}

func openSQLiteReadOnly(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?mode=ro&_busy_timeout=5000&_foreign_keys=ON", path))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	return db, nil
}

func openSQLiteReadWrite(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=ON", path))
	if err != nil {
		return nil, err
	}
	// The candidate is modified only by the migration process.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	return db, nil
}

func quoteIdentifiers(names []string) string {
	quoted := make([]string, 0, len(names))
	for _, name := range names {
		quoted = append(quoted, `"`+name+`"`)
	}
	return strings.Join(quoted, ", ")
}

func sortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func samePath(a, b string) bool {
	return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

func isPostgresDSN(value string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	return strings.HasPrefix(value, "postgres://") || strings.HasPrefix(value, "postgresql://")
}
