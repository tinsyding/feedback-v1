package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"

	"golang.org/x/crypto/bcrypt"

	"feedback-api/internal/tz"
)

// User represents a row in the `users` table.
type User struct {
	ID           int64
	Username     string
	PasswordHash string
	RealName     string
	Role         string
	Subject      string
	TeacherID    int64
	CreatedBy    string
	Status       int
}

// AdminUser represents a row in the `admin_users` table.
type AdminUser struct {
	ID           int64
	Username     string
	PasswordHash string
	RealName     string
	Role         string
	Status       int
}

// AssistantRecord represents a row returned by assistant_list.
type AssistantRecord struct {
	ID          int64   `json:"id"`
	Username    string  `json:"username"`
	RealName    string  `json:"real_name"`
	Role        string  `json:"role"`
	TeacherID   int64   `json:"teacher_id"`
	CreatedBy   string  `json:"created_by"`
	Status      int     `json:"status"`
	LastLoginAt *string `json:"last_login_at"`
	CreatedAt   *string `json:"created_at"`
	UpdatedAt   *string `json:"updated_at"`
}

// AssistantUpdatePatch holds optional fields for assistant_update.
type AssistantUpdatePatch struct {
	RealName     *string
	Status       *int
	PasswordHash *string
}

// Repository abstracts database access for foreground authentication and assistant management.
type Repository interface {
	FindUserByUsername(ctx context.Context, username string) (*User, error)
	FindAdminByUsername(ctx context.Context, username string) (*AdminUser, error)
	UpdateUserLogin(ctx context.Context, userID int64, ip string) error
	UpdateAdminLogin(ctx context.Context, adminID int64, ip string) error
	UpgradeAdminPasswordHash(ctx context.Context, adminID int64, bcryptHash string) error
	UpdateUserPassword(ctx context.Context, userID int64, bcryptHash string) error
	ListAssistants(ctx context.Context, ownerID int64, ownerUsername string) ([]AssistantRecord, error)
	CreateAssistant(ctx context.Context, username, passwordHash, realName string, teacherID int64, createdBy string) (int64, error)
	FindAssistantOwned(ctx context.Context, targetID, ownerID int64, ownerUsername string) (*User, error)
	UpdateAssistant(ctx context.Context, targetID int64, patch AssistantUpdatePatch) error
	DeleteAssistant(ctx context.Context, targetID int64) error
}

// VerifyBcrypt checks a plaintext password against a bcrypt hash ($2a$, $2b$, or PHP $2y$).
func VerifyBcrypt(password, storedHash string) bool {
	if password == "" || storedHash == "" {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(storedHash), []byte(password)) == nil
}

// VerifyAdminPassword checks bcrypt first, then falls back to legacy lowercase hex SHA256.
// The second return value (needsUpgrade) is true when matched via legacy SHA256.
func VerifyAdminPassword(password, storedHash string) (valid bool, needsUpgrade bool) {
	if password == "" || storedHash == "" {
		return false, false
	}
	if VerifyBcrypt(password, storedHash) {
		return true, false
	}
	sum := sha256.Sum256([]byte(password))
	hexSum := hex.EncodeToString(sum[:])
	if subtle.ConstantTimeCompare([]byte(storedHash), []byte(hexSum)) == 1 {
		return true, true
	}
	return false, false
}

// HashPassword generates a bcrypt hash compatible with PHP password_verify().
func HashPassword(password string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// MySQLRepository implements Repository backed by *sql.DB.
type MySQLRepository struct {
	db *sql.DB
}

// NewMySQLRepository creates a MySQLRepository.
func NewMySQLRepository(db *sql.DB) *MySQLRepository {
	return &MySQLRepository{db: db}
}

func (r *MySQLRepository) requireDB() (*sql.DB, error) {
	if r == nil || r.db == nil {
		return nil, errors.New("database is not configured")
	}
	return r.db, nil
}

func (r *MySQLRepository) FindUserByUsername(ctx context.Context, username string) (*User, error) {
	db, err := r.requireDB()
	if err != nil {
		return nil, err
	}
	var u User
	var role, subject, createdBy, realName sql.NullString
	err = db.QueryRowContext(
		ctx,
		"SELECT `id`, `username`, `password_hash`, `real_name`, `role`, `subject`, `teacher_id`, `created_by`, `status` FROM `users` WHERE `username` = ? LIMIT 1",
		username,
	).Scan(&u.ID, &u.Username, &u.PasswordHash, &realName, &role, &subject, &u.TeacherID, &createdBy, &u.Status)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	u.RealName = realName.String
	u.Role = role.String
	u.Subject = subject.String
	u.CreatedBy = createdBy.String
	return &u, nil
}

func (r *MySQLRepository) FindAdminByUsername(ctx context.Context, username string) (*AdminUser, error) {
	db, err := r.requireDB()
	if err != nil {
		return nil, err
	}
	var a AdminUser
	var realName, role sql.NullString
	err = db.QueryRowContext(
		ctx,
		"SELECT `id`, `username`, `password_hash`, `real_name`, `role`, `status` FROM `admin_users` WHERE `username` = ? LIMIT 1",
		username,
	).Scan(&a.ID, &a.Username, &a.PasswordHash, &realName, &role, &a.Status)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	a.RealName = realName.String
	a.Role = role.String
	return &a, nil
}

func (r *MySQLRepository) UpdateUserLogin(ctx context.Context, userID int64, ip string) error {
	db, err := r.requireDB()
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, "UPDATE `users` SET `last_login_at` = NOW(), `last_login_ip` = ? WHERE `id` = ?", ip, userID)
	return err
}

func (r *MySQLRepository) UpdateAdminLogin(ctx context.Context, adminID int64, ip string) error {
	db, err := r.requireDB()
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, "UPDATE `admin_users` SET `last_login_at` = NOW(), `last_login_ip` = ? WHERE `id` = ?", ip, adminID)
	return err
}

func (r *MySQLRepository) UpgradeAdminPasswordHash(ctx context.Context, adminID int64, bcryptHash string) error {
	db, err := r.requireDB()
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, "UPDATE `admin_users` SET `password_hash` = ? WHERE `id` = ?", bcryptHash, adminID)
	return err
}

func (r *MySQLRepository) UpdateUserPassword(ctx context.Context, userID int64, bcryptHash string) error {
	db, err := r.requireDB()
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, "UPDATE `users` SET `password_hash` = ?, `initial_password` = '', `updated_at` = NOW() WHERE `id` = ?", bcryptHash, userID)
	return err
}

func buildAssistantOwnerSQL(ownerID int64, ownerUsername string) (string, []any) {
	if ownerID > 0 {
		return "(`teacher_id` = ? OR `created_by` = ?)", []any{ownerID, ownerUsername}
	}
	return "`created_by` = ?", []any{ownerUsername}
}

func (r *MySQLRepository) ListAssistants(ctx context.Context, ownerID int64, ownerUsername string) ([]AssistantRecord, error) {
	db, err := r.requireDB()
	if err != nil {
		return nil, err
	}
	cond, params := buildAssistantOwnerSQL(ownerID, ownerUsername)
	rows, err := db.QueryContext(
		ctx,
		"SELECT `id`, `username`, `real_name`, `role`, `teacher_id`, `created_by`, `status`, `last_login_at`, `created_at`, `updated_at` "+
			"FROM `users` WHERE `role` = 'assistant' AND "+cond+" ORDER BY `id` DESC",
		params...,
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	out := make([]AssistantRecord, 0)
	for rows.Next() {
		var rec AssistantRecord
		var realName, role, createdBy sql.NullString
		var lastLoginAt, createdAt, updatedAt sql.NullTime
		if err := rows.Scan(
			&rec.ID, &rec.Username, &realName, &role, &rec.TeacherID, &createdBy, &rec.Status,
			&lastLoginAt, &createdAt, &updatedAt,
		); err != nil {
			return nil, err
		}
		rec.RealName = realName.String
		rec.Role = role.String
		rec.CreatedBy = createdBy.String
		if lastLoginAt.Valid {
			v := tz.In(lastLoginAt.Time).Format("2006-01-02 15:04:05")
			rec.LastLoginAt = &v
		}
		if createdAt.Valid {
			v := tz.In(createdAt.Time).Format("2006-01-02 15:04:05")
			rec.CreatedAt = &v
		}
		if updatedAt.Valid {
			v := tz.In(updatedAt.Time).Format("2006-01-02 15:04:05")
			rec.UpdatedAt = &v
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

func (r *MySQLRepository) CreateAssistant(ctx context.Context, username, passwordHash, realName string, teacherID int64, createdBy string) (int64, error) {
	db, err := r.requireDB()
	if err != nil {
		return 0, err
	}
	res, err := db.ExecContext(
		ctx,
		"INSERT INTO `users` (`username`, `password_hash`, `initial_password`, `real_name`, `role`, `teacher_id`, `created_by`, `status`, `created_at`, `updated_at`) "+
			"VALUES (?, ?, '', ?, 'assistant', ?, ?, 1, NOW(), NOW())",
		username, passwordHash, realName, teacherID, createdBy,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (r *MySQLRepository) FindAssistantOwned(ctx context.Context, targetID, ownerID int64, ownerUsername string) (*User, error) {
	db, err := r.requireDB()
	if err != nil {
		return nil, err
	}
	cond, ownerParams := buildAssistantOwnerSQL(ownerID, ownerUsername)
	params := append([]any{targetID}, ownerParams...)
	var u User
	var role, createdBy, realName sql.NullString
	err = db.QueryRowContext(
		ctx,
		"SELECT `id`, `username`, `password_hash`, `real_name`, `role`, `teacher_id`, `created_by`, `status` "+
			"FROM `users` WHERE `id` = ? AND `role` = 'assistant' AND "+cond+" LIMIT 1",
		params...,
	).Scan(&u.ID, &u.Username, &u.PasswordHash, &realName, &role, &u.TeacherID, &createdBy, &u.Status)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	u.RealName = realName.String
	u.Role = role.String
	u.CreatedBy = createdBy.String
	return &u, nil
}

func (r *MySQLRepository) UpdateAssistant(ctx context.Context, targetID int64, patch AssistantUpdatePatch) error {
	db, err := r.requireDB()
	if err != nil {
		return err
	}
	var sets []string
	var params []any
	if patch.RealName != nil {
		sets = append(sets, "`real_name` = ?")
		params = append(params, *patch.RealName)
	}
	if patch.Status != nil {
		sets = append(sets, "`status` = ?")
		params = append(params, *patch.Status)
	}
	if patch.PasswordHash != nil {
		sets = append(sets, "`password_hash` = ?", "`initial_password` = ''")
		params = append(params, *patch.PasswordHash)
	}
	if len(sets) == 0 {
		return nil
	}
	sets = append(sets, "`updated_at` = NOW()")
	params = append(params, targetID)
	_, err = db.ExecContext(ctx, "UPDATE `users` SET "+strings.Join(sets, ", ")+" WHERE `id` = ?", params...)
	return err
}

func (r *MySQLRepository) DeleteAssistant(ctx context.Context, targetID int64) error {
	db, err := r.requireDB()
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, "DELETE FROM `users` WHERE `id` = ?", targetID)
	return err
}
