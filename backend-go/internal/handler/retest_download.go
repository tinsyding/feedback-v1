package handler

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"feedback-api/internal/httpx"
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

func handleRetestCreateTempDownload(w http.ResponseWriter, r *http.Request, deps RetestDeps) {
	if r.Method != http.MethodPost {
		writeRawJSON(w, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "Method Not Allowed"})
		return
	}

	// Parse multipart form if multipart; otherwise read raw body later
	isMultipart := strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "multipart/form-data")
	if isMultipart {
		_ = r.ParseMultipartForm(maxTempPDFSize + (1 << 20))
		if r.MultipartForm != nil {
			defer func() { _ = r.MultipartForm.RemoveAll() }()
		}
	}

	q := r.URL.Query()
	token := strings.TrimSpace(r.PostFormValue("token"))
	if token == "" {
		token = strings.TrimSpace(q.Get("token"))
	}

	sess, isNewSess := loadAuthSession(r, deps.Sessions)
	isTokenVerified := token != "" && sess.StringVal(verifiedTokenSessionKey(token)) != ""
	isUserAuth := sess.IsLoggedIn()
	if !isTokenVerified && !isUserAuth {
		writeRawJSON(w, http.StatusUnauthorized, map[string]any{
			"success": false,
			"error":   "未授权的下载请求：请先通过学生身份验证",
		})
		return
	}

	// Per-session rate limit: max 30 temp files per hour
	nowUnix := deps.now().Unix()
	dlCount := sess.IntVal("temp_download_count")
	dlTime := int64(sess.IntVal("temp_download_time"))
	if dlTime <= 0 || nowUnix-dlTime > 3600 {
		dlCount = 0
		dlTime = nowUnix
	}
	if dlCount >= 30 {
		writeRawJSON(w, http.StatusTooManyRequests, map[string]any{
			"success": false,
			"error":   "生成下载文件过于频繁，请稍后再试",
		})
		return
	}
	sess.Data["temp_download_count"] = dlCount + 1
	sess.Data["temp_download_time"] = dlTime
	persistAuthSession(w, r, deps.Sessions, sess, isNewSess)

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
		if err == nil && len(data) > 10 {
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

	var rnd [16]byte
	_, _ = rand.Read(rnd[:])
	fileKey := hex.EncodeToString(rnd[:])

	tempDir := deps.tempDir()
	_ = os.MkdirAll(tempDir, 0o755)
	targetPath := filepath.Join(tempDir, fileKey+".pdf")
	metaPath := filepath.Join(tempDir, fileKey+".json")

	if err := os.WriteFile(targetPath, pdfBytes, 0o644); err != nil {
		writeRawJSON(w, http.StatusInternalServerError, map[string]any{"success": false, "error": "临时文件写入失败"})
		return
	}

	cleanFileName := sanitizeTempPDFName(fileName)
	metaBytes, _ := json.Marshal(map[string]any{
		"filename":   cleanFileName,
		"created_at": nowUnix,
	})
	_ = os.WriteFile(metaPath, metaBytes, 0o644)

	studentName := strings.TrimSpace(r.PostFormValue("studentName"))
	if studentName == "" {
		studentName = strings.TrimSpace(q.Get("studentName"))
	}
	if studentName == "" && token != "" {
		studentName = sess.StringVal(verifiedTokenSessionKey(token))
	}
	logRetestAccess(r, deps, token, studentName, "create_temp_download", cleanFileName)

	tokenQS := ""
	if token != "" {
		tokenQS = "&token=" + url.PathEscape(token)
	}
	relativeURL := "api/retest.php?action=download_file&key=" + fileKey + "&fn=" + url.PathEscape(cleanFileName) + tokenQS

	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	host := r.Host
	if host == "" {
		host = "localhost"
	}
	fullURL := fmt.Sprintf("%s://%s/api/retest.php?action=download_file&key=%s&fn=%s%s", scheme, host, fileKey, url.PathEscape(cleanFileName), tokenQS)

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

	// 2-hour TTL
	if metaCreatedAt > 0 && deps.now().Unix()-metaCreatedAt > 7200 {
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

	token := strings.TrimSpace(q.Get("token"))
	studentName := ""
	if token != "" {
		sess, _ := loadAuthSession(r, deps.Sessions)
		studentName = sess.StringVal(verifiedTokenSessionKey(token))
	}
	logRetestAccess(r, deps, token, studentName, "download_file", cleanFileName)

	data, err := os.ReadFile(filePath)
	if err != nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	encName := url.PathEscape(cleanFileName)
	w.Header().Set("Content-Description", "File Transfer")
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, encName, encName))
	w.Header().Set("Content-Transfer-Encoding", "binary")
	w.Header().Set("Expires", "0")
	w.Header().Set("Cache-Control", "must-revalidate, post-check=0, pre-check=0")
	w.Header().Set("Pragma", "public")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func handleRetestLogDownload(w http.ResponseWriter, r *http.Request, deps RetestDeps) {
	httpx.ParseRequestForm(r)
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
