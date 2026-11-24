package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math/rand/v2"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"feedback-api/internal/httpx"
	"feedback-api/internal/session"
)

const (
	maxCaptureSize     = 10 << 20 // 10MB
	maxCaptureBodySize = 12 << 20
)

var (
	reSafeSlug     = regexp.MustCompile(`[^a-zA-Z0-9_\-]`)
	reSafeFilename = regexp.MustCompile(`[^a-zA-Z0-9.\-_]`)
)

// UploadCapture ports feedback-v1/api/upload_capture.php (requires auth, archives csv/xlsx/xls/json + index.jsonl).
func UploadCapture(feedbackRoot string, store session.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := session.RequireAuth(w, r, store); !ok {
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, maxCaptureBodySize)
		ct := strings.ToLower(r.Header.Get("Content-Type"))
		if strings.HasPrefix(ct, "multipart/form-data") {
			if err := r.ParseMultipartForm(4 << 20); err != nil {
				var maxErr *http.MaxBytesError
				if errors.As(err, &maxErr) {
					httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
						"success": false,
						"error":   "文件大小不能超过 10MB",
					})
					return
				}
			}
			if r.MultipartForm != nil {
				defer func() { _ = r.MultipartForm.RemoveAll() }()
			}
		} else {
			_ = r.ParseForm()
		}

		file, fh, err := r.FormFile("file")
		if err != nil {
			httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
				"error": "No file",
			})
			return
		}
		defer func() { _ = file.Close() }()

		if fh.Size > maxCaptureSize {
			httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
				"success": false,
				"error":   "文件大小不能超过 10MB",
			})
			return
		}

		data, err := io.ReadAll(io.LimitReader(file, maxCaptureSize+1))
		if err != nil {
			httpx.SendJSON(w, http.StatusOK, map[string]any{
				"success": false,
				"error":   "Failed to move",
			})
			return
		}
		if len(data) > maxCaptureSize {
			httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
				"success": false,
				"error":   "文件大小不能超过 10MB",
			})
			return
		}

		fpRaw := r.PostFormValue("fingerprint")
		if fpRaw == "" {
			fpRaw = "unknown_fp"
		}
		fingerprint := reSafeSlug.ReplaceAllString(fpRaw, "")
		if fingerprint == "" {
			fingerprint = "unknown_fp"
		}

		typeRaw := r.PostFormValue("type")
		if typeRaw == "" {
			typeRaw = "unknown_type"
		}
		typ := reSafeSlug.ReplaceAllString(typeRaw, "")
		if typ == "" {
			typ = "unknown_type"
		}

		origBase := phpBaseName(fh.Filename)
		cleanBase := reSafeFilename.ReplaceAllString(origBase, "")
		nowShanghai := time.Now().In(shanghaiLoc)
		filename := nowShanghai.Format("20060102_150405") + "_" + typ + "_" + cleanBase

		ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(filename), "."))
		switch ext {
		case "csv", "xlsx", "xls", "json":
		default:
			httpx.SendJSON(w, http.StatusForbidden, map[string]any{
				"success": false,
				"error":   "File type not allowed",
			})
			return
		}

		uploadDir := filepath.Join(feedbackRoot, "data", "uploads")
		targetDir := filepath.Join(uploadDir, fingerprint)
		if err := os.MkdirAll(targetDir, 0755); err != nil {
			httpx.SendJSON(w, http.StatusOK, map[string]any{
				"success": false,
				"error":   "Failed to move",
			})
			return
		}

		targetFile := filepath.Join(targetDir, filename)
		if err := writeFileAtomic(targetFile, data, 0644); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				if mkErr := os.MkdirAll(targetDir, 0755); mkErr == nil {
					err = writeFileAtomic(targetFile, data, 0644)
				}
			}
			if err != nil {
				httpx.SendJSON(w, http.StatusOK, map[string]any{
					"success": false,
					"error":   "Failed to move",
				})
				return
			}
		}

		appendCaptureIndex(filepath.Join(uploadDir, "index.jsonl"), map[string]any{
			"ts":   time.Now().Unix(),
			"rel":  fingerprint + "/" + filename,
			"orig": origBase,
			"type": typ,
		})

		httpx.SendJSON(w, http.StatusOK, map[string]any{
			"success": true,
		})

		if rand.IntN(10) == 0 {
			runAsyncCleanup(&captureCleanupRunning, func() {
				cleanupUploadCaptures(uploadDir, time.Now().Add(-30*24*time.Hour))
			})
		}
	}
}

func appendCaptureIndex(idxPath string, entry map[string]any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(entry); err != nil {
		return
	}
	f, err := os.OpenFile(idxPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return
	}
	defer func() { _ = f.Close() }()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		return
	}
	defer func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }()
	_, _ = f.Write(buf.Bytes())
}

func cleanupUploadCaptures(uploadDir string, cutoff time.Time) {
	dirs, err := os.ReadDir(uploadDir)
	if err == nil {
		for _, d := range dirs {
			if !d.IsDir() {
				continue
			}
			dirPath := filepath.Join(uploadDir, d.Name())
			dirInfo, dirStatErr := d.Info()
			entries, err := os.ReadDir(dirPath)
			if err != nil {
				continue
			}
			empty := true
			removedAny := false
			for _, e := range entries {
				if e.IsDir() {
					empty = false
					continue
				}
				info, err := e.Info()
				if err != nil {
					empty = false
					continue
				}
				if info.ModTime().Before(cutoff) {
					if os.Remove(filepath.Join(dirPath, e.Name())) == nil {
						removedAny = true
					}
				} else {
					empty = false
				}
			}
			if empty && (removedAny || (dirStatErr == nil && dirInfo.ModTime().Before(cutoff))) {
				_ = os.Remove(dirPath)
			}
		}
	}

	idxPath := filepath.Join(uploadDir, "index.jsonl")
	f, err := os.OpenFile(idxPath, os.O_RDWR, 0644)
	if err != nil {
		return
	}
	defer func() { _ = f.Close() }()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		return
	}
	defer func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }()

	raw, err := io.ReadAll(f)
	if err != nil {
		return
	}
	cutoffUnix := cutoff.Unix()
	lines := strings.Split(string(raw), "\n")
	var kept []string
	removed := 0
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var obj map[string]any
		if err := json.Unmarshal([]byte(line), &obj); err != nil {
			removed++
			continue
		}
		var ts int64
		switch v := obj["ts"].(type) {
		case float64:
			ts = int64(v)
		}
		rel, _ := obj["rel"].(string)
		if (ts > 0 && ts < cutoffUnix) || rel == "" {
			removed++
			continue
		}
		info, statErr := os.Stat(filepath.Join(uploadDir, filepath.FromSlash(rel)))
		if statErr != nil || info.IsDir() {
			removed++
			continue
		}
		kept = append(kept, line)
	}
	if removed > 0 {
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return
		}
		if err := f.Truncate(0); err != nil {
			return
		}
		if len(kept) > 0 {
			_, _ = f.WriteString(strings.Join(kept, "\n") + "\n")
		}
		_ = f.Sync()
	}
}
