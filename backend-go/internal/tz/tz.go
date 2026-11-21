package tz

import (
	"sync"
	"time"
)

var (
	once        sync.Once
	shanghaiLoc *time.Location
)

// Shanghai returns the Asia/Shanghai *time.Location, falling back to fixed CST (+08:00) if tzdata is unavailable.
func Shanghai() *time.Location {
	once.Do(func() {
		loc, err := time.LoadLocation("Asia/Shanghai")
		if err != nil || loc == nil {
			loc = time.FixedZone("CST", 8*3600)
		}
		shanghaiLoc = loc
	})
	return shanghaiLoc
}

// Now returns the current time in Asia/Shanghai.
func Now() time.Time {
	return time.Now().In(Shanghai())
}

// In converts t to Asia/Shanghai.
func In(t time.Time) time.Time {
	return t.In(Shanghai())
}

// Unix returns the local Asia/Shanghai time corresponding to the given Unix seconds and nanoseconds.
func Unix(sec, nsec int64) time.Time {
	return time.Unix(sec, nsec).In(Shanghai())
}
