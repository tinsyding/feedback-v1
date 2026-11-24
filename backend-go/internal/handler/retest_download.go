package handler

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
	"feedback-api/internal/session"
)

const maxTempPDFSize = 25 * 1024 * 1024

var (
	reTempFileKey     = regexp.MustCompile(`^[a-f0-9]{32}$`)
	reUnsafeTempFname = regexp.MustCompile(`[\\/:*?"<>|]`)
)

func sanitizeTempPDFName(raw string) string {
	clean := reUnsafeTempFname.ReplaceAllString(strings.TrimSpace(raw), "_")
	if clean == "" {
		clean = "错题本.pdf"
	}
	if !strings.HasSuffix(strings.ToLower(clean), ".pdf") {
		clean += ".pdf"
	}
	return clean
}

func hasAnyVerifiedRetestToken(sess *session.Session) bool {
	if sess == nil || sess.Data == nil {
		return false
	}
	for k, v := range sess.Data {
		if strings.HasPrefix(k, "verified_token_") && strings.TrimSpace(config.AsPHPString(v)) != "" {
			return true
		}
	}
	return false
}

func handleRetestCreateTempDownload(w http.ResponseWriter, r *http.Request, deps RetestDeps) {
	if r.Method != http.MethodPost {
		writeRawJSON(w, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "Method Not Allowed"})
		return
	}

	sess, isNewSess := loadAuthSession(r, deps.Sessions)
	isUserAuth := sess.IsLoggedIn()
	if !isUserAuth && !hasAnyVerifiedRetestToken(sess) {
		writeRawJSON(w, http.StatusUnauthorized, map[string]any{
			"success": false,
			"error":   "未授权的下载请求：请先通过学生身份验证",
		})
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxTempPDFSize+(2<<20))

	q := r.URL.Query()
	token := strings.TrimSpace(q.Get("token"))

	// Parse multipart form with a 1 MiB memory cap (spills large files to disk);
	// for non-multipart raw PDF streams, never call PostFormValue so r.Body is not drained.
	isMultipart := strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "multipart/form-data")
	if isMultipart {
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				writeRawJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"success": false, "error": "文件大小超出限制（最大 25MB）"})
				return
			}
		}
		if r.MultipartForm != nil {
			defer func() { _ = r.MultipartForm.RemoveAll() }()
		}
		if postTok := strings.TrimSpace(r.PostFormValue("token")); postTok != "" {
			token = postTok
		}
	}

	isTokenVerified := token != "" && sess.StringVal(verifiedTokenSessionKey(token)) != ""
	if !isTokenVerified && !isUserAuth {
		writeRawJSON(w, http.StatusUnauthorized, map[string]any{
			"success": false,
			"error":   "未授权的下载请求：请先通过学生身份验证",
		})
		return
	}
	if token != "" && deps.Repo != nil && !sess.IsAdminLoggedIn() {
		revoked, revErr := deps.Repo.IsTokenRevoked(r.Context(), token)
		if revErr != nil {
			writeRawJSON(w, http.StatusInternalServerError, map[string]any{
				"success": false,
				"error":   "数据库查询服务异常，请稍后重试",
			})
			return
		}
		if revoked {
			writeRawJSON(w, http.StatusForbidden, map[string]any{
				"success": false,
				"error":   "该错题本链接已被教师作废，无法下载",
			})
			return
		}
	}

	var pdfBytes []byte
	fileName := "错题本.pdf"
	if isMultipart {
		f, fh, err := r.FormFile("file")
		if err == nil {
			defer func() { _ = f.Close() }()
			if fh.Size > maxTempPDFSize {
				writeRawJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"success": false, "error": "文件大小超出限制（最大 25MB）"})
				return
			}
			data, readErr := io.ReadAll(io.LimitReader(f, maxTempPDFSize+1))
			if readErr == nil {
				pdfBytes = data
			}
			if fn := strings.TrimSpace(r.PostFormValue("filename")); fn != "" {
				fileName = fn
			} else if fh.Filename != "" {
				fileName = fh.Filename
			}
		}
	} else {
		data, err := io.ReadAll(io.LimitReader(r.Body, maxTempPDFSize+1))
		if err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				writeRawJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"success": false, "error": "文件大小超出限制（最大 25MB）"})
				return
			}
		} else if len(data) > 10 {
			pdfBytes = data
			if fn := strings.TrimSpace(q.Get("filename")); fn != "" {
				fileName = fn
			}
		}
	}

	if len(pdfBytes) == 0 {
		writeRawJSON(w, http.StatusBadRequest, map[string]any{"success": false, "error": "未检测到有效的 PDF 文件流"})
		return
	}
	if len(pdfBytes) > maxTempPDFSize {
		writeRawJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"success": false, "error": "文件大小超出限制（最大 25MB）"})
		return
	}
	if len(pdfBytes) < 4 || string(pdfBytes[:4]) != "%PDF" {
		writeRawJSON(w, http.StatusBadRequest, map[string]any{"success": false, "error": "文件非合法 PDF 格式"})
		return
	}

	// Per-session rate limit: max 30 temp files per hour (atomic read-modify-write, after payload validation)
	nowUnix := deps.now().Unix()
	rateLimited := false
	if deps.Sessions != nil {
		if _, err := session.Update(r.Context(), deps.Sessions, sess.ID, func(data map[string]any) (bool, error) {
			rateLimited = false
			dlCount := config.AsPHPInt(data["temp_download_count"])
			dlTime := int64(config.AsPHPInt(data["temp_download_time"]))
			if dlTime <= 0 || nowUnix-dlTime > 3600 {
				dlCount = 0
				dlTime = nowUnix
			}
			if dlCount >= 30 {
				rateLimited = true
				return false, nil
			}
			data["temp_download_count"] = dlCount + 1
			data["temp_download_time"] = dlTime
			return true, nil
		}); err != nil {
			writeRawJSON(w, http.StatusInternalServerError, map[string]any{
				"success": false,
				"error":   "会话状态保存失败，请稍后重试",
			})
			return
		} else if isNewSess {
			session.SetCookie(w, r, sess.ID)
		}
	} else {
		dlCount := sess.IntVal("temp_download_count")
		dlTime := int64(sess.IntVal("temp_download_time"))
		if dlTime <= 0 || nowUnix-dlTime > 3600 {
			dlCount = 0
			dlTime = nowUnix
		}
		if dlCount >= 30 {
			rateLimited = true
		} else {
			sess.Data["temp_download_count"] = dlCount + 1
			sess.Data["temp_download_time"] = dlTime
		}
	}
	if rateLimited {
		writeRawJSON(w, http.StatusTooManyRequests, map[string]any{
			"success": false,
			"error":   "生成下载文件过于频繁，请稍后再试",
		})
		return
	}

	var rnd [16]byte
	_, _ = rand.Read(rnd[:])
	fileKey := hex.EncodeToString(rnd[:])

	tempDir := deps.tempDir()
	_ = os.MkdirAll(tempDir, 0o755)
	targetPath := filepath.Join(tempDir, fileKey+".pdf")
	metaPath := filepath.Join(tempDir, fileKey+".json")

	if err := writeFileAtomic(targetPath, pdfBytes, 0o644); err != nil {
		writeRawJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "error": "临时文件写入失败"})
		return
	}

	cleanFileName := sanitizeTempPDFName(fileName)
	metaBytes, _ := json.Marshal(map[string]any{
		"filename":   cleanFileName,
		"created_at": nowUnix,
	})
	if err := writeFileAtomic(metaPath, metaBytes, 0o644); err != nil {
		_ = os.Remove(targetPath)
		writeRawJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "error": "临时文件写入失败"})
		return
	}

	studentName := ""
	if isMultipart {
		studentName = strings.TrimSpace(r.PostFormValue("studentName"))
	}
	if studentName == "" {
		studentName = strings.TrimSpace(q.Get("studentName"))
	}
	if studentName == "" && token != "" {
		studentName = sess.StringVal(verifiedTokenSessionKey(token))
	}
	logRetestAccess(r, deps, token, studentName, "create_temp_download", cleanFileName)

	tokenQS := ""
	if token != "" {
		tokenQS = "&token=" + url.QueryEscape(token)
	}
	encFN := url.QueryEscape(cleanFileName)
	relativeURL := "api/retest.php?action=download_file&key=" + fileKey + "&fn=" + encFN + tokenQS

	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	host := r.Host
	if host == "" {
		host = "localhost"
	}
	fullURL := fmt.Sprintf("%s://%s/api/retest.php?action=download_file&key=%s&fn=%s%s", scheme, host, fileKey, encFN, tokenQS)

	writeRawJSON(w, http.StatusOK, map[string]any{
		"success":     true,
		"key":         fileKey,
		"downloadUrl": relativeURL,
		"fullUrl":     fullURL,
		"fileName":    cleanFileName,
	})
}

func handleRetestDownloadFile(w http.ResponseWriter, r *http.Request, deps RetestDeps) {
	q := r.URL.Query()
	fileKey := strings.TrimSpace(q.Get("key"))
	if !reTempFileKey.MatchString(fileKey) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("无效的文件凭证（Invalid Key）"))
		return
	}

	tempDir := deps.tempDir()
	filePath := filepath.Join(tempDir, fileKey+".pdf")
	metaPath := filepath.Join(tempDir, fileKey+".json")

	info, err := os.Stat(filePath)
	if err != nil || info.IsDir() {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("文件不存在或已过期，请返回页面重新生成"))
		return
	}

	fileName := "错题本.pdf"
	var metaCreatedAt int64
	if rawMeta, err := os.ReadFile(metaPath); err == nil {
		var meta struct {
			Filename  string `json:"filename"`
			CreatedAt int64  `json:"created_at"`
		}
		if json.Unmarshal(rawMeta, &meta) == nil {
			if meta.Filename != "" {
				fileName = meta.Filename
			}
			metaCreatedAt = meta.CreatedAt
		}
	}

	// 2-hour TTL (fall back to file ModTime if metadata is missing or invalid)
	createdAt := metaCreatedAt
	if createdAt <= 0 {
		createdAt = info.ModTime().Unix()
	}
	if createdAt > 0 && deps.now().Unix()-createdAt > 7200 {
		_ = os.Remove(filePath)
		_ = os.Remove(metaPath)
		w.WriteHeader(http.StatusGone)
		_, _ = w.Write([]byte("下载链接已过期（有效期2小时），请返回页面重新生成"))
		return
	}

	if fn := strings.TrimSpace(q.Get("fn")); fn != "" {
		fileName = fn
	}
	cleanFileName := sanitizeTempPDFName(fileName)

	f, err := os.Open(filePath)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	defer func() { _ = f.Close() }()
	fi, err := f.Stat()
	if err != nil || fi.IsDir() {
		w.WriteHeader(http.StatusNotFound)
		return
	}

	token := strings.TrimSpace(q.Get("token"))
	studentName := ""
	if token != "" {
		sess, _ := loadAuthSession(r, deps.Sessions)
		studentName = sess.StringVal(verifiedTokenSessionKey(token))
	}
	logRetestAccess(r, deps, token, studentName, "download_file", cleanFileName)
	encName := strings.ReplaceAll(url.QueryEscape(cleanFileName), "+", "%20")
	w.Header().Set("Content-Description", "File Transfer")
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, encName, encName))
	w.Header().Set("Content-Transfer-Encoding", "binary")
	w.Header().Set("Expires", "0")
	w.Header().Set("Cache-Control", "must-revalidate, post-check=0, pre-check=0")
	w.Header().Set("Pragma", "public")
	w.Header().Set("Content-Length", strconv.FormatInt(fi.Size(), 10))
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, f)
}

func handleRetestLogDownload(w http.ResponseWriter, r *http.Request, deps RetestDeps) {
	if r.Body != nil {
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	}
	httpx.ParseRequestForm(r)
	if r.MultipartForm != nil {
		defer func() { _ = r.MultipartForm.RemoveAll() }()
	}
	q := r.URL.Query()
	getVal := func(key string) string {
		if v := strings.TrimSpace(r.PostFormValue(key)); v != "" {
			return v
		}
		return strings.TrimSpace(q.Get(key))
	}
	token := getVal("token")
	fileName := getVal("filename")
	studentName := getVal("studentName")
	if studentName == "" && token != "" {
		sess, _ := loadAuthSession(r, deps.Sessions)
		studentName = sess.StringVal(verifiedTokenSessionKey(token))
	}
	logRetestAccess(r, deps, token, studentName, "download_pdf", fileName)
	writeRawJSON(w, http.StatusOK, map[string]any{"success": true})
}
