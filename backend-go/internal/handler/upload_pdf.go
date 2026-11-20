package handler

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"feedback-api/internal/httpx"
	"feedback-api/internal/session"
)

const (
	maxUploadPDFSize = 20 << 20 // 20MB
	maxPDFBodySize   = 25 << 20
)

// phpBaseName mimics PHP basename() on Linux (splits on '/' and ignores trailing slashes).
func phpBaseName(name string) string {
	trimmed := strings.TrimRight(name, "/")
	if trimmed == "" {
		return ""
	}
	if idx := strings.LastIndexByte(trimmed, '/'); idx >= 0 {
		return trimmed[idx+1:]
	}
	return trimmed
}

// UploadPDF ports feedback-v1/api/upload_pdf.php (requires teacher/admin session, blocks assistants).
func UploadPDF(feedbackRoot string, store session.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, ok := session.RequireAuth(w, r, store)
		if !ok {
			return
		}
		if !session.RequireNonAssistant(w, sess, "上传或修改题库 PDF") {
			return
		}
		if r.Method != http.MethodPost {
			httpx.SendJSON(w, http.StatusMethodNotAllowed, map[string]any{
				"success": false,
				"error":   "不支持的请求方法",
			})
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, maxPDFBodySize)
		if err := r.ParseMultipartForm(8 << 20); err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
					"success": false,
					"error":   "文件大小不能超过 20MB",
				})
				return
			}
			httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
				"success": false,
				"error":   "没有文件被上传",
			})
			return
		}
		if r.MultipartForm != nil {
			defer func() { _ = r.MultipartForm.RemoveAll() }()
		}

		file, fh, err := r.FormFile("file")
		if err != nil {
			httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
				"success": false,
				"error":   "没有文件被上传",
			})
			return
		}
		defer func() { _ = file.Close() }()

		originalName := phpBaseName(fh.Filename)
		ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(originalName), "."))
		if ext != "pdf" {
			httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
				"success": false,
				"error":   "仅支持上传 PDF 文件",
			})
			return
		}

		if fh.Size > maxUploadPDFSize {
			httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
				"success": false,
				"error":   "文件大小不能超过 20MB",
			})
			return
		}

		data, err := io.ReadAll(io.LimitReader(file, maxUploadPDFSize+1))
		if err != nil {
			httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
				"success": false,
				"error":   "未知上传错误",
			})
			return
		}
		if len(data) > maxUploadPDFSize {
			httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
				"success": false,
				"error":   "文件大小不能超过 20MB",
			})
			return
		}

		if len(data) < 4 || string(data[:4]) != "%PDF" {
			httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
				"success": false,
				"error":   "文件非合法 PDF 格式",
			})
			return
		}

		uploadDir := filepath.Join(feedbackRoot, "data", "pdfs")
		if err := os.MkdirAll(uploadDir, 0755); err != nil {
			httpx.SendJSON(w, http.StatusInternalServerError, map[string]any{
				"success": false,
				"error":   "保存文件失败，请检查目录权限",
			})
			return
		}

		var randBuf [4]byte
		_, _ = rand.Read(randBuf[:])
		safeName := fmt.Sprintf("pdf_%d_%s.pdf", time.Now().Unix(), hex.EncodeToString(randBuf[:]))
		targetPath := filepath.Join(uploadDir, safeName)

		if err := writeFileAtomic(targetPath, data, 0644); err != nil {
			httpx.SendJSON(w, http.StatusInternalServerError, map[string]any{
				"success": false,
				"error":   "保存文件失败，请检查目录权限",
			})
			return
		}

		httpx.SendJSON(w, http.StatusOK, map[string]any{
			"success":      true,
			"url":          "data/pdfs/" + safeName,
			"originalName": originalName,
		})
	}
}
