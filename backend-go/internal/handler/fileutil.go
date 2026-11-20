package handler

import (
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
)

var (
	bgCleanupWG            sync.WaitGroup
	captureCleanupRunning  atomic.Bool
	identifyCleanupRunning atomic.Bool
)

// writeFileAtomic writes data to a temporary file in targetPath's directory, sets perm, and renames atomically.
func writeFileAtomic(targetPath string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(targetPath)
	f, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmpPath := f.Name()
	cleanupTmp := true
	defer func() {
		if cleanupTmp {
			_ = os.Remove(tmpPath)
		}
	}()

	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpPath, perm); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, targetPath); err != nil {
		return err
	}
	cleanupTmp = false
	return nil
}

// runAsyncCleanup runs fn in a background goroutine unless another run for this guard is already active.
func runAsyncCleanup(running *atomic.Bool, fn func()) {
	if !running.CompareAndSwap(false, true) {
		return
	}
	bgCleanupWG.Add(1)
	go func() {
		defer bgCleanupWG.Done()
		defer running.Store(false)
		fn()
	}()
}
