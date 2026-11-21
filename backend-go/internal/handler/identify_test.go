package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
	"feedback-api/internal/vision"
)

func TestIdentifyEndpointModesGatesAndArchiving(t *testing.T) {
	t.Cleanup(bgCleanupWG.Wait)
	t.Setenv("SENDER_API_TOKEN", "")
	t.Setenv("DASHSCOPE_API_KEY", "")
	t.Setenv("IDENTIFY_API_BASE", "")
	t.Setenv("IDENTIFY_MODEL", "")
	t.Setenv("IDENTIFY_FAST_MODEL", "")

	var lastModel string
	var mockReply string
	mockVision := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req vision.ChatCompletionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatal(err)
		}
		lastModel = req.Model
		_, _ = w.Write([]byte(mockReply))
	}))
	defer mockVision.Close()

	root := t.TempDir()
	writeCfg := func(jsonStr string) {
		if err := os.WriteFile(filepath.Join(root, "config.json"), []byte(jsonStr), 0644); err != nil {
			t.Fatal(err)
		}
	}
	writeCfg(`{
		"dashscopeApiKey": "sk-id",
		"identifyApiBase": "` + mockVision.URL + `/v1/chat/completions"
	}`)

	loader := config.NewLoader(root, "")
	h := httpx.Middleware(Identify(loader, &vision.Client{HTTPClient: mockVision.Client()}))
	pngBytes := buildTestPNG(t, 400, 300)

	// GET -> 405
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/identify.php", nil))
	if rec.Code != 405 {
		t.Fatalf("GET status = %d", rec.Code)
	}

	// Empty target_id & target_name in full mode -> 400
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, makeMultipartReq(t, "/api/identify.php", map[string]string{
		"token": config.DefaultSenderToken,
		"mode":  "full",
	}, nil))
	ok, _, errStr := decodeEnvelope(t, rec)
	if rec.Code != 400 || ok || errStr == nil || *errStr != "target_id 与 target_name 不能同时为空" {
		t.Fatalf("empty target unexpected: %d %v %v", rec.Code, ok, errStr)
	}

	// Missing required upload field in title mode -> 400
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, makeMultipartReq(t, "/api/identify.php", map[string]string{
		"token":       config.DefaultSenderToken,
		"mode":        "title",
		"target_name": "张三",
	}, nil))
	ok, _, errStr = decodeEnvelope(t, rec)
	if rec.Code != 400 || ok || errStr == nil || *errStr != "缺少上传图：image_title" {
		t.Fatalf("missing image_title unexpected: %d %v %v", rec.Code, ok, errStr)
	}

	// Full mode with strict bool coercion (matched: 1 -> false) + invalid last_sender ("hacker" -> "unknown") + needs_reply: null
	mockReply = `{"choices":[{"message":{"content":"{\"matched\":1,\"is_group\":false,\"title_in_header\":true,\"detected_title\":\"10001张三\",\"last_sender\":\"hacker\",\"last_message_text\":\"收到\",\"needs_reply\":null,\"reason\":\"test\"}"}}]}`
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, makeMultipartReq(t, "/api/identify.php", map[string]string{
		"token":       config.DefaultSenderToken,
		"mode":        "full",
		"target_id":   "10001",
		"target_name": "张三",
	}, map[string][]byte{
		"image_title": pngBytes,
		"image_chat":  pngBytes,
	}))
	if rec.Code != 200 {
		t.Fatalf("full status = %d", rec.Code)
	}
	ok, data, errStr := decodeEnvelope(t, rec)
	if !ok || errStr != nil {
		t.Fatalf("full failed: %v %v", ok, errStr)
	}
	if lastModel != "qwen3.8-max" {
		t.Fatalf("full model = %q", lastModel)
	}
	if data["matched"] != false || data["title_in_header"] != true || data["last_sender"] != "unknown" || data["needs_reply"] != nil {
		t.Fatalf("unexpected normalized full output: %+v", data)
	}

	// Verify archive files exist
	matches, err := filepath.Glob(filepath.Join(root, "data", "identify_archive", "*", "*_full_*", "request.json"))
	if err != nil || len(matches) != 1 {
		t.Fatalf("expected 1 archived request.json, got %v (err=%v)", matches, err)
	}
	archiveDir := filepath.Dir(matches[0])
	for _, fn := range []string{"title.png", "chat.png", "request.json", "response.json"} {
		if _, err := os.Stat(filepath.Join(archiveDir, fn)); err != nil {
			t.Fatalf("missing archive file %s: %v", fn, err)
		}
	}

	// Title mode + benchmark purpose -> uses fast/benchmark model
	mockReply = `{"choices":[{"message":{"content":"{\"matched\":true,\"is_group\":false,\"title_in_header\":true,\"detected_title\":\"10001张三\",\"reason\":\"ok\"}"}}]}`
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, makeMultipartReq(t, "/api/identify.php", map[string]string{
		"token":       config.DefaultSenderToken,
		"mode":        "title",
		"purpose":     "BENCHMARK",
		"target_name": "张三",
	}, map[string][]byte{"image_title": pngBytes}))
	ok, _, errStr = decodeEnvelope(t, rec)
	if !ok || errStr != nil || lastModel != "qwen3.8-flash" {
		t.Fatalf("benchmark title unexpected: ok=%v err=%v model=%q", ok, errStr, lastModel)
	}

	// Sidebar mode without target_id/target_name succeeds and uses calibrateModel
	writeCfg(`{
		"dashscopeApiKey": "sk-id",
		"identifyApiBase": "` + mockVision.URL + `",
		"calibrateModel": "cal-model",
		"disableQwenFlashTitle": true,
		"senderControl": {"enableReplyAnalysis": false, "enableBenchmarkModel": false}
	}`)
	mockReply = `{"choices":[{"message":{"content":"{\"has_sidebar\":1,\"sidebar_title\":\"学员详情\",\"reason\":\"展开\"}"}}]}`
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, makeMultipartReq(t, "/api/identify.php", map[string]string{
		"token": config.DefaultSenderToken,
		"mode":  "sidebar",
	}, map[string][]byte{"image_window": pngBytes}))
	ok, data, errStr = decodeEnvelope(t, rec)
	if !ok || errStr != nil || lastModel != "cal-model" || data["has_sidebar"] != true || data["sidebar_title"] != "学员详情" {
		t.Fatalf("sidebar unexpected: ok=%v err=%v model=%q data=%+v", ok, errStr, lastModel, data)
	}

	// Gate checks under updated config:
	// 1) title + benchmark -> ADMIN_DISABLED_BENCHMARK_MODEL
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, makeMultipartReq(t, "/api/identify.php", map[string]string{
		"token":       config.DefaultSenderToken,
		"mode":        "title",
		"purpose":     "benchmark",
		"target_name": "张三",
	}, nil))
	ok, _, errStr = decodeEnvelope(t, rec)
	if ok || errStr == nil || *errStr != "ADMIN_DISABLED_BENCHMARK_MODEL: 管理员已停用基准评测云端大模型" {
		t.Fatalf("benchmark gate unexpected: %v %v", ok, errStr)
	}

	// 2) title -> ADMIN_FORCED_LOCAL_OCR
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, makeMultipartReq(t, "/api/identify.php", map[string]string{
		"token":       config.DefaultSenderToken,
		"mode":        "title",
		"target_name": "张三",
	}, nil))
	ok, _, errStr = decodeEnvelope(t, rec)
	if ok || errStr == nil || *errStr != "ADMIN_FORCED_LOCAL_OCR: 管理员已开启强制本地OCR核验，云端标题核验模型已停用" {
		t.Fatalf("title gate unexpected: %v %v", ok, errStr)
	}

	// 3) reply -> ADMIN_DISABLED_REPLY_ANALYSIS
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, makeMultipartReq(t, "/api/identify.php", map[string]string{
		"token":       config.DefaultSenderToken,
		"mode":        "reply",
		"target_name": "张三",
	}, nil))
	ok, _, errStr = decodeEnvelope(t, rec)
	if ok || errStr == nil || *errStr != "ADMIN_DISABLED_REPLY_ANALYSIS: 管理员已关闭后台家长留言分析大模型" {
		t.Fatalf("reply gate unexpected: %v %v", ok, errStr)
	}

	// 4) full -> ADMIN_FORCED_LOCAL_OCR
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, makeMultipartReq(t, "/api/identify.php", map[string]string{
		"token":       config.DefaultSenderToken,
		"mode":        "full",
		"target_name": "张三",
	}, nil))
	ok, _, errStr = decodeEnvelope(t, rec)
	if ok || errStr == nil || *errStr != "ADMIN_FORCED_LOCAL_OCR: 管理员已开启强制本地OCR核验，云端全图核验已停用" {
		t.Fatalf("full gate unexpected: %v %v", ok, errStr)
	}

	// Reply mode success with parent message & oversize >5MB check
	writeCfg(`{
		"dashscopeApiKey": "sk-id",
		"identifyApiBase": "` + mockVision.URL + `"
	}`)
	oversize := make([]byte, maxIdentifyImageBytes+1)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, makeMultipartReq(t, "/api/identify.php", map[string]string{
		"token":       config.DefaultSenderToken,
		"mode":        "reply",
		"target_name": "张三",
	}, map[string][]byte{"image_chat": oversize}))
	ok, _, errStr = decodeEnvelope(t, rec)
	if rec.Code != 400 || ok || errStr == nil || *errStr != "上传图超过 5MB：image_chat" {
		t.Fatalf("oversize identify unexpected: %d %v %v", rec.Code, ok, errStr)
	}

	mockReply = `{"choices":[{"message":{"content":"{\"last_sender\":\"parent\",\"last_message_text\":\"老师辛苦了\",\"needs_reply\":\"false\",\"reason\":\"家长致谢\"}"}}]}`
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, makeMultipartReq(t, "/api/identify.php", map[string]string{
		"token":          config.DefaultSenderToken,
		"mode":           "reply",
		"target_name":    "张三",
		"detected_title": "10001张三",
	}, map[string][]byte{"image_chat": pngBytes}))
	ok, data, errStr = decodeEnvelope(t, rec)
	if !ok || errStr != nil || lastModel != "qwen3.8-max" || data["last_sender"] != "parent" || data["needs_reply"] != false {
		t.Fatalf("reply mode unexpected: ok=%v err=%v model=%q data=%+v", ok, errStr, lastModel, data)
	}

	// Cleanup retention removes >14d old directories and preserves recent ones
	archiveRoot := filepath.Join(root, "data", "identify_archive")
	oldLeaf := filepath.Join(archiveRoot, "20200101", "010203_full_deadbeef")
	if err := os.MkdirAll(oldLeaf, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(oldLeaf, "request.json"), []byte("{}"), 0644); err != nil {
		t.Fatal(err)
	}
	oldTime := time.Now().Add(-15 * 24 * time.Hour)
	_ = os.Chtimes(oldLeaf, oldTime, oldTime)
	cleanupIdentifyArchive(archiveRoot, time.Now().Add(-14*24*time.Hour))
	if _, err := os.Stat(filepath.Join(archiveRoot, "20200101")); !os.IsNotExist(err) {
		t.Fatalf("expected old archive day dir removed, got err=%v", err)
	}
	if _, err := os.Stat(archiveDir); err != nil {
		t.Fatalf("expected recent archive dir preserved: %v", err)
	}

	// >25MB body -> MaxBytesError returns 400 size error, NOT 200 鉴权失败
	huge := make([]byte, (25<<20)+4096)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, makeMultipartReq(t, "/api/identify.php", map[string]string{
		"token":       config.DefaultSenderToken,
		"mode":        "title",
		"target_name": "张三",
	}, map[string][]byte{"image_title": huge}))
	ok, _, errStr = decodeEnvelope(t, rec)
	if rec.Code != http.StatusBadRequest || ok || errStr == nil || *errStr != "上传图超过 5MB" {
		t.Fatalf("huge body (>25MB) unexpected: %d %v %v", rec.Code, ok, errStr)
	}
}
