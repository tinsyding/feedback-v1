package syslogs

import (
	"sync"
	"time"

	"feedback-api/internal/tz"
)

const defaultMaxBuckets = 4096

// IngestLimiter enforces per-IP (60/min) and unauthenticated-guest (30/min) sliding-window rate limits
// for POST /api/logs.php?action=log.
type IngestLimiter struct {
	mu         sync.Mutex
	buckets    map[string][]int64
	lastPrune  int64
	maxBuckets int
	nowFunc    func() time.Time
}

// NewIngestLimiter creates an IngestLimiter.
func NewIngestLimiter() *IngestLimiter {
	return &IngestLimiter{
		buckets:    make(map[string][]int64),
		maxBuckets: defaultMaxBuckets,
		nowFunc:    tz.Now,
	}
}

func (l *IngestLimiter) nowUnix() int64 {
	if l != nil && l.nowFunc != nil {
		return l.nowFunc().Unix()
	}
	return tz.Now().Unix()
}

func (l *IngestLimiter) capLimit() int {
	if l != nil && l.maxBuckets > 0 {
		return l.maxBuckets
	}
	return defaultMaxBuckets
}

// Allow checks and records an event in the 60-second sliding window for bucketKey.
func (l *IngestLimiter) Allow(bucketKey string, maxPerMin int) bool {
	if l == nil || maxPerMin <= 0 {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.nowUnix()
	cutoff := now - 60

	// Periodic or high-water prune of expired buckets
	if now-l.lastPrune >= 60 || len(l.buckets) > 1000 {
		for k, tsList := range l.buckets {
			if len(tsList) == 0 || tsList[len(tsList)-1] <= cutoff {
				delete(l.buckets, k)
			}
		}
		l.lastPrune = now
	}

	hist, exists := l.buckets[bucketKey]
	kept := hist[:0]
	for _, ts := range hist {
		if ts > cutoff {
			kept = append(kept, ts)
		}
	}
	if len(kept) >= maxPerMin {
		l.buckets[bucketKey] = kept
		return false
	}

	// Hard cap eviction if map still exceeds maxBuckets after pruning expired keys.
	maxCap := l.capLimit()
	if !exists && len(l.buckets) >= maxCap {
		oldestKey := ""
		var oldestTS int64
		for k, tsList := range l.buckets {
			var last int64
			if len(tsList) > 0 {
				last = tsList[len(tsList)-1]
			}
			if oldestKey == "" || last < oldestTS {
				oldestKey = k
				oldestTS = last
			}
		}
		if oldestKey != "" {
			delete(l.buckets, oldestKey)
		}
	}

	kept = append(kept, now)
	l.buckets[bucketKey] = kept
	return true
}
