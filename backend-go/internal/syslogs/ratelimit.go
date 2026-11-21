package syslogs

import (
	"sync"
	"time"
)

// IngestLimiter enforces per-IP (60/min) and unauthenticated-guest (30/min) sliding-window rate limits
// for POST /api/logs.php?action=log.
type IngestLimiter struct {
	mu      sync.Mutex
	buckets map[string][]int64
	nowFunc func() time.Time
}

// NewIngestLimiter creates an IngestLimiter.
func NewIngestLimiter() *IngestLimiter {
	return &IngestLimiter{
		buckets: make(map[string][]int64),
		nowFunc: time.Now,
	}
}

func (l *IngestLimiter) nowUnix() int64 {
	if l != nil && l.nowFunc != nil {
		return l.nowFunc().Unix()
	}
	return time.Now().Unix()
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

	// Opportunistic prune when map grows
	if len(l.buckets) > 2000 {
		for k, tsList := range l.buckets {
			if len(tsList) == 0 || tsList[len(tsList)-1] <= cutoff {
				delete(l.buckets, k)
			}
		}
	}

	hist := l.buckets[bucketKey]
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
	kept = append(kept, now)
	l.buckets[bucketKey] = kept
	return true
}
