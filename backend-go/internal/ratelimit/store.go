package ratelimit

import (
	"context"
	"crypto/md5"
	"database/sql"
	"encoding/hex"
	"errors"
	"log"
	"strings"
	"sync"
	"time"

	"feedback-api/internal/textutil"
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

// NormalizeKey matches PHP bootstrap.php normalizeAuthRateLimitKey() so PHP and Go share the exact bucket_key,
// while truncating multi-byte UTF-8 prefixes on rune boundaries to stay <= 191 bytes for MySQL utf8mb4.
func NormalizeKey(scope, identifier string) string {
	key := scope + ":" + strings.ToLower(strings.TrimSpace(identifier))
	if len(key) > 191 {
		sum := md5.Sum([]byte(key))
		key = textutil.TruncateUTF8Bytes(key, 158) + ":" + hex.EncodeToString(sum[:])
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

const defaultMaxMemBuckets = 4096

// MemoryStore is an in-memory Store for unit tests and offline fallback.
type MemoryStore struct {
	mu        sync.Mutex
	buckets   map[string]memEntry
	lastPrune int64
	nowFunc   func() time.Time
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

func (m *MemoryStore) pruneLocked(now int64, windowSeconds int) {
	maxAge := int64(windowSeconds)
	if maxAge < 3600 {
		maxAge = 3600
	}
	for k, e := range m.buckets {
		if e.lockUntil > now {
			continue
		}
		ref := e.updatedAt
		if ref == 0 {
			ref = e.firstAt
		}
		if now-ref > maxAge {
			delete(m.buckets, k)
		}
	}
	m.lastPrune = now
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
		delete(m.buckets, key)
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
	if now-m.lastPrune >= 60 || len(m.buckets) >= defaultMaxMemBuckets {
		m.pruneLocked(now, windowSeconds)
	}
	e, ok := m.buckets[key]
	if !ok && len(m.buckets) >= defaultMaxMemBuckets {
		var oldestKey string
		var oldestTS int64
		for k, v := range m.buckets {
			ts := v.updatedAt
			if oldestKey == "" || ts < oldestTS {
				oldestKey = k
				oldestTS = ts
			}
		}
		if oldestKey != "" {
			delete(m.buckets, oldestKey)
		}
	}
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

// FallbackStore wraps a primary Store (e.g. MySQLStore) and transparently falls back
// to an in-memory Store whenever primary is nil or returns a runtime error.
type FallbackStore struct {
	primary  Store
	fallback Store
}

// NewFallbackStore creates a resilient Store using primary with automatic fallback on error.
func NewFallbackStore(primary, fallback Store) *FallbackStore {
	if fallback == nil {
		fallback = NewMemoryStore()
	}
	return &FallbackStore{
		primary:  primary,
		fallback: fallback,
	}
}

// NewResilientStore creates a FallbackStore backed by MySQL when db != nil and an in-memory Store.
func NewResilientStore(db *sql.DB) *FallbackStore {
	var primary Store
	if db != nil {
		primary = NewMySQLStore(db)
	}
	return NewFallbackStore(primary, NewMemoryStore())
}

// Status returns rate-limit state from primary or falls back to the in-memory Store on error.
func (f *FallbackStore) Status(ctx context.Context, scope, identifier string, windowSeconds int) (Status, error) {
	if f == nil {
		return Status{}, errors.New("rate limit store is nil")
	}
	if f.primary != nil {
		st, err := f.primary.Status(ctx, scope, identifier, windowSeconds)
		if err == nil {
			fbSt, fbErr := f.fallback.Status(ctx, scope, identifier, windowSeconds)
			if fbErr == nil && ((fbSt.Locked && (!st.Locked || fbSt.RemainingSeconds > st.RemainingSeconds)) || (!st.Locked && fbSt.Count > st.Count)) {
				return fbSt, nil
			}
			return st, nil
		}
		log.Printf("warning: ratelimit primary Status(%s) failed (%v); falling back to memory store", scope, err)
	}
	return f.fallback.Status(ctx, scope, identifier, windowSeconds)
}

// RecordFailure records a failure in primary or falls back to the in-memory Store on error.
func (f *FallbackStore) RecordFailure(ctx context.Context, scope, identifier string, maxAttempts, windowSeconds, lockoutSeconds int) (Status, error) {
	if f == nil {
		return Status{}, errors.New("rate limit store is nil")
	}
	if f.primary != nil {
		st, err := f.primary.RecordFailure(ctx, scope, identifier, maxAttempts, windowSeconds, lockoutSeconds)
		if err == nil {
			return st, nil
		}
		log.Printf("warning: ratelimit primary RecordFailure(%s) failed (%v); falling back to memory store", scope, err)
	}
	return f.fallback.RecordFailure(ctx, scope, identifier, maxAttempts, windowSeconds, lockoutSeconds)
}

// Clear removes the bucket from both primary and fallback stores.
func (f *FallbackStore) Clear(ctx context.Context, scope, identifier string) error {
	if f == nil {
		return errors.New("rate limit store is nil")
	}
	if f.primary != nil {
		if err := f.primary.Clear(ctx, scope, identifier); err != nil {
			log.Printf("warning: ratelimit primary Clear(%s) failed (%v); clearing fallback store", scope, err)
		}
	}
	return f.fallback.Clear(ctx, scope, identifier)
}

// CleanupExpired forwards periodic DB cleanup when primary supports it.
func (f *FallbackStore) CleanupExpired(ctx context.Context) (int64, error) {
	if f == nil || f.primary == nil {
		return 0, nil
	}
	if cleaner, ok := f.primary.(interface {
		CleanupExpired(context.Context) (int64, error)
	}); ok {
		return cleaner.CleanupExpired(ctx)
	}
	return 0, nil
}
