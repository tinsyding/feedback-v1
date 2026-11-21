package admin

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"feedback-api/internal/tz"
)

// MySQLRepository implements Repository backed by MySQL *sql.DB.
type MySQLRepository struct {
	db *sql.DB
}

// NewMySQLRepository creates a MySQLRepository. If db is nil, calls fail closed with HTTP 500.
func NewMySQLRepository(db *sql.DB) *MySQLRepository {
	return &MySQLRepository{db: db}
}

func (r *MySQLRepository) requireDB() error {
	if r == nil || r.db == nil {
		return NewHTTPError(500, "数据库连接失败", nil)
	}
	return nil
}

// FindAdminByUsername fetches an admin user by username from `admin_users`.
func (r *MySQLRepository) FindAdminByUsername(ctx context.Context, username string) (*AdminUser, error) {
	if err := r.requireDB(); err != nil {
		return nil, err
	}
	var u AdminUser
	var realName, role sql.NullString
	err := r.db.QueryRowContext(
		ctx,
		"SELECT `id`, `username`, `password_hash`, `real_name`, `role`, `status` FROM `admin_users` WHERE `username` = ? LIMIT 1",
		username,
	).Scan(&u.ID, &u.Username, &u.PasswordHash, &realName, &role, &u.Status)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if realName.Valid && realName.String != "" {
		u.RealName = realName.String
	} else {
		u.RealName = "超级管理员"
	}
	if role.Valid && role.String != "" {
		u.Role = role.String
	} else {
		u.Role = "super_admin"
	}
	return &u, nil
}

// UpdateAdminPasswordHash updates password_hash for an admin user.
func (r *MySQLRepository) UpdateAdminPasswordHash(ctx context.Context, id int, newHash string) error {
	if err := r.requireDB(); err != nil {
		return err
	}
	_, err := r.db.ExecContext(ctx, "UPDATE `admin_users` SET `password_hash` = ? WHERE `id` = ?", newHash, id)
	return err
}

// UpsertFallbackAdmin inserts or updates the fallback admin into `admin_users`.
func (r *MySQLRepository) UpsertFallbackAdmin(ctx context.Context, username, newHash string) error {
	if err := r.requireDB(); err != nil {
		return err
	}
	_, err := r.db.ExecContext(
		ctx,
		"INSERT INTO `admin_users` (`username`, `password_hash`, `real_name`, `role`, `status`) VALUES (?, ?, '超级管理员', 'super_admin', 1) ON DUPLICATE KEY UPDATE `password_hash` = VALUES(`password_hash`)",
		username, newHash,
	)
	return err
}

// UpdateAdminLastLogin updates last_login_at and last_login_ip for an admin user.
func (r *MySQLRepository) UpdateAdminLastLogin(ctx context.Context, username, ip string) error {
	if err := r.requireDB(); err != nil {
		return err
	}
	_, err := r.db.ExecContext(
		ctx,
		"UPDATE `admin_users` SET `last_login_at` = NOW(), `last_login_ip` = ? WHERE `username` = ?",
		ip, username,
	)
	return err
}

// scanDynamicRows scans arbitrary SELECT rows into []map[string]any preserving PHP PDO-like JSON values.
func scanDynamicRows(rows *sql.Rows) ([]map[string]any, error) {
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	colTypes, _ := rows.ColumnTypes()
	out := make([]map[string]any, 0)
	for rows.Next() {
		rawVals := make([]any, len(cols))
		scanPtrs := make([]any, len(cols))
		for i := range rawVals {
			scanPtrs[i] = &rawVals[i]
		}
		if err := rows.Scan(scanPtrs...); err != nil {
			return nil, err
		}
		m := make(map[string]any, len(cols))
		for i, col := range cols {
			dbType := ""
			if i < len(colTypes) {
				dbType = strings.ToUpper(colTypes[i].DatabaseTypeName())
			}
			m[col] = convertSQLValue(rawVals[i], dbType)
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func convertSQLValue(val any, dbType string) any {
	if val == nil {
		return nil
	}
	switch v := val.(type) {
	case time.Time:
		return tz.In(v).Format("2006-01-02 15:04:05")
	case []byte:
		s := string(v)
		switch {
		case strings.Contains(dbType, "INT"):
			if n, err := strconv.ParseInt(s, 10, 64); err == nil {
				return n
			}
		case strings.Contains(dbType, "DECIMAL"), strings.Contains(dbType, "FLOAT"), strings.Contains(dbType, "DOUBLE"):
			if f, err := strconv.ParseFloat(s, 64); err == nil {
				return f
			}
		}
		return s
	case int64, float64, bool, string:
		return v
	default:
		return fmt.Sprintf("%v", v)
	}
}

func parseDBTimestamp(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	for _, layout := range []string{"2006-01-02 15:04:05", time.RFC3339, "2006-01-02"} {
		if t, err := time.ParseInLocation(layout, s, tz.Shanghai()); err == nil {
			return t.Unix(), true
		}
	}
	return 0, false
}
