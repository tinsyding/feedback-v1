package ratelimit

import (
	"context"
	"crypto/md5"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"time"
)

// Status mirrors PHP getAuthRateLimitStatus / recordAuthRateLimitFailure return shape.
type Status struct {
	Count            int  `json:"count"`
	Locked           bool `json:"locked"`
	RemainingSeconds int  `json:"remaining_seconds"`
}

// Store defines the shared authentication anti-brute-force rate limiter contract.
type Store interface {
	Status(ctx context.Context, scope, identifier string, windowSeconds int) (Status, error)
	RecordFailure(ctx context.Context, scope, identifier string, maxAttempts, windowSeconds, lockoutSeconds int) (Status, error)
	Clear(ctx context.Context, scope, identifier string) error
}

// NormalizeKey matches PHP bootstrap.php normalizeAuthRateLimitKey() so PHP and Go share the exact bucket_key.
func NormalizeKey(scope, identifier string) string {
	key := scope + ":" + strings.ToLower(strings.TrimSpace(identifier))
	if len(key) > 191 {
		sum := md5.Sum([]byte(key))
		key = key[:158] + ":" + hex.EncodeToString(sum[:])
	}
	return key
}

// MySQLStore persists shared auth rate-limit buckets in MySQL `auth_rate_limits`.
type MySQLStore struct {
	db      *sql.DB
	nowFunc func() time.Time
}

// NewMySQLStore creates a MySQLStore backed by *sql.DB.
func NewMySQLStore(db *sql.DB) *MySQLStore {
	return &MySQLStore{
		db:      db,
		nowFunc: time.Now,
	}
}

func (s *MySQLStore) nowUnix() int64 {
	if s != nil && s.nowFunc != nil {
		return s.nowFunc().Unix()
	}
	return time.Now().Unix()
}

// Status returns current failure count and lock state for (scope, identifier).
func (s *MySQLStore) Status(ctx context.Context, scope, identifier string, windowSeconds int) (Status, error) {
	if s == nil || s.db == nil {
		return Status{}, errors.New("rate limit store database is not configured")
	}
	key := NormalizeKey(scope, identifier)
	now := s.nowUnix()

	var count int
	var firstAt, updatedAt, lockUntil int64
	err := s.db.QueryRowContext(
		ctx,
		"SELECT `fail_count`, `first_at`, `updated_at`, `lock_until` FROM `auth_rate_limits` WHERE `bucket_key` = ? LIMIT 1",
		key,
	).Scan(&count, &firstAt, &updatedAt, &lockUntil)
	if errors.Is(err, sql.ErrNoRows) {
		return Status{}, nil
	}
	if err != nil {
		return Status{}, err
	}
	if lockUntil > now {
		return Status{
			Count:            count,
			Locked:           true,
			RemainingSeconds: int(lockUntil - now),
		}, nil
	}
	if firstAt == 0 {
		firstAt = updatedAt
	}
	if windowSeconds > 0 && (now-firstAt) > int64(windowSeconds) {
		return Status{}, nil
	}
	return Status{Count: count}, nil
}

// RecordFailure atomically increments the failure counter and applies lockout if maxAttempts is reached.
func (s *MySQLStore) RecordFailure(ctx context.Context, scope, identifier string, maxAttempts, windowSeconds, lockoutSeconds int) (Status, error) {
	if s == nil || s.db == nil {
		return Status{}, errors.New("rate limit store database is not configured")
	}
	key := NormalizeKey(scope, identifier)
	now := s.nowUnix()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Status{}, err
	}
	defer func() { _ = tx.Rollback() }()

	var prevCount int
	var prevFirst, prevUpdated, prevLock int64
	err = tx.QueryRowContext(
		ctx,
		"SELECT `fail_count`, `first_at`, `updated_at`, `lock_until` FROM `auth_rate_limits` WHERE `bucket_key` = ? FOR UPDATE",
		key,
	).Scan(&prevCount, &prevFirst, &prevUpdated, &prevLock)

	count := 0
	firstAt := now
	lockUntil := int64(0)
	if err == nil {
		if prevLock <= now && windowSeconds > 0 && (now-prevFirst) > int64(windowSeconds) {
			count = 0
			firstAt = now
			lockUntil = 0
		} else {
			count = prevCount
			if prevFirst > 0 {
				firstAt = prevFirst
			}
			lockUntil = prevLock
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return Status{}, err
	}

	count++
	if maxAttempts > 0 && count >= maxAttempts && lockoutSeconds > 0 {
		lockUntil = now + int64(lockoutSeconds)
	}

	_, err = tx.ExecContext(
		ctx,
		`INSERT INTO `+"`auth_rate_limits`"+` (`+"`bucket_key`, `fail_count`, `first_at`, `updated_at`, `lock_until`"+`)
		 VALUES (?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE
		   `+"`fail_count`"+` = VALUES(`+"`fail_count`"+`),
		   `+"`first_at`"+` = VALUES(`+"`first_at`"+`),
		   `+"`updated_at`"+` = VALUES(`+"`updated_at`"+`),
		   `+"`lock_until`"+` = VALUES(`+"`lock_until`"+`)`,
		key, count, firstAt, now, lockUntil,
	)
	if err != nil {
		return Status{}, err
	}
	if err := tx.Commit(); err != nil {
		return Status{}, err
	}

	rem := int(lockUntil - now)
	if rem < 0 {
		rem = 0
	}
	return Status{
		Count:            count,
		Locked:           rem > 0,
		RemainingSeconds: rem,
	}, nil
}

// Clear removes the rate-limit bucket after a successful authentication.
func (s *MySQLStore) Clear(ctx context.Context, scope, identifier string) error {
	if s == nil || s.db == nil {
		return errors.New("rate limit store database is not configured")
	}
	key := NormalizeKey(scope, identifier)
	_, err := s.db.ExecContext(ctx, "DELETE FROM `auth_rate_limits` WHERE `bucket_key` = ?", key)
	return err
}

// CleanupExpired deletes unlocked buckets older than 24 hours.
func (s *MySQLStore) CleanupExpired(ctx context.Context) (int64, error) {
	if s == nil || s.db == nil {
		return 0, nil
	}
	now := s.nowUnix()
	res, err := s.db.ExecContext(ctx, "DELETE FROM `auth_rate_limits` WHERE `lock_until` < ? AND `updated_at` < ?", now, now-86400)
	if err != nil {
		return 0, err
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return 0, nil
	}
	return affected, nil
}

type memEntry struct {
	count     int
	firstAt   int64
	updatedAt int64
	lockUntil int64
}

// MemoryStore is an in-memory Store for unit tests and offline fallback.
type MemoryStore struct {
	mu      sync.Mutex
	buckets map[string]memEntry
	nowFunc func() time.Time
}

// NewMemoryStore initializes an empty MemoryStore.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		buckets: make(map[string]memEntry),
		nowFunc: time.Now,
	}
}

func (m *MemoryStore) nowUnix() int64 {
	if m != nil && m.nowFunc != nil {
		return m.nowFunc().Unix()
	}
	return time.Now().Unix()
}

// Status returns the current rate-limit state from memory.
func (m *MemoryStore) Status(_ context.Context, scope, identifier string, windowSeconds int) (Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	key := NormalizeKey(scope, identifier)
	now := m.nowUnix()
	e, ok := m.buckets[key]
	if !ok {
		return Status{}, nil
	}
	if e.lockUntil > now {
		return Status{Count: e.count, Locked: true, RemainingSeconds: int(e.lockUntil - now)}, nil
	}
	firstAt := e.firstAt
	if firstAt == 0 {
		firstAt = e.updatedAt
	}
	if windowSeconds > 0 && (now-firstAt) > int64(windowSeconds) {
		return Status{}, nil
	}
	return Status{Count: e.count}, nil
}

// RecordFailure records a failure in memory and applies lockout when threshold is reached.
func (m *MemoryStore) RecordFailure(_ context.Context, scope, identifier string, maxAttempts, windowSeconds, lockoutSeconds int) (Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	key := NormalizeKey(scope, identifier)
	now := m.nowUnix()
	e, ok := m.buckets[key]
	if !ok || (e.lockUntil <= now && windowSeconds > 0 && (now-e.firstAt) > int64(windowSeconds)) {
		e = memEntry{firstAt: now}
	}
	e.count++
	e.updatedAt = now
	if maxAttempts > 0 && e.count >= maxAttempts && lockoutSeconds > 0 {
		e.lockUntil = now + int64(lockoutSeconds)
	}
	m.buckets[key] = e

	rem := int(e.lockUntil - now)
	if rem < 0 {
		rem = 0
	}
	return Status{Count: e.count, Locked: rem > 0, RemainingSeconds: rem}, nil
}

// Clear deletes the bucket from memory.
func (m *MemoryStore) Clear(_ context.Context, scope, identifier string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.buckets, NormalizeKey(scope, identifier))
	return nil
}
