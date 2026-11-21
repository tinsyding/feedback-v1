package handler

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
	"feedback-api/internal/vision"
)

func buildTestPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	img.Set(0, 0, color.RGBA{R: 12, G: 34, B: 56, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func makeMultipartReq(t *testing.T, target string, fields map[string]string, files map[string][]byte) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	for k, v := range fields {
		_ = mw.WriteField(k, v)
	}
	for k, data := range files {
		fw, err := mw.CreateFormFile(k, k+".png")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = fw.Write(data)
	}
	_ = mw.Close()
	req := httptest.NewRequest(http.MethodPost, target, &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return req
}

func decodeEnvelope(t *testing.T, rec *httptest.ResponseRecorder) (bool, map[string]any, *string) {
	t.Helper()
	var raw struct {
		Success bool           `json:"success"`
		Data    map[string]any `json:"data"`
		Error   *string        `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatalf("invalid json %s: %v", rec.Body.String(), err)
	}
	return raw.Success, raw.Data, raw.Error
}

func TestCalibrateROIEndpoint(t *testing.T) {
	t.Setenv("SENDER_API_TOKEN", "")
	t.Setenv("DASHSCOPE_API_KEY", "")
	t.Setenv("IDENTIFY_API_BASE", "")
	t.Setenv("IDENTIFY_MODEL", "")

	var mockContent string
	mockVision := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{
				{"message": map[string]any{"content": mockContent}},
			},
		})
	}))
	defer mockVision.Close()

	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "config.json"), []byte(`{
		"dashscopeApiKey": "sk-cal",
		"identifyApiBase": "`+mockVision.URL+`/v1"
	}`), 0644); err != nil {
		t.Fatal(err)
	}

	loader := config.NewLoader(root, "")
	h := httpx.Middleware(CalibrateROI(loader, &vision.Client{HTTPClient: mockVision.Client()}))

	// GET readiness
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/calibrate_roi.php", nil))
	if rec.Code != 200 {
		t.Fatalf("GET status = %d", rec.Code)
	}
	ok, data, errStr := decodeEnvelope(t, rec)
	if !ok || errStr == nil || *errStr != "ok" || data["status"] != "ready" {
		t.Fatalf("GET unexpected: %v %+v %v", ok, data, errStr)
	}

	// DELETE -> 405
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/calibrate_roi.php", nil))
	if rec.Code != 405 {
		t.Fatalf("DELETE status = %d, want 405", rec.Code)
	}

	// Bad token -> 200 鉴权失败
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, makeMultipartReq(t, "/api/calibrate_roi.php", map[string]string{"token": "wrong"}, nil))
	ok, _, errStr = decodeEnvelope(t, rec)
	if rec.Code != 200 || ok || errStr == nil || *errStr != "鉴权失败" {
		t.Fatalf("bad token unexpected: %d %v %v", rec.Code, ok, errStr)
	}

	// Missing image -> 400
	rec = httptest.NewRecorder()
	req := makeMultipartReq(t, "/api/calibrate_roi.php", nil, nil)
	req.Header.Set("Authorization", "Bearer "+config.DefaultSenderToken)
	h.ServeHTTP(rec, req)
	ok, _, errStr = decodeEnvelope(t, rec)
	if rec.Code != 400 || ok || errStr == nil || *errStr != "缺少上传整窗截图：image" {
		t.Fatalf("missing image unexpected: %d %v %v", rec.Code, ok, errStr)
	}

	// Non-image -> 400
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, makeMultipartReq(t, "/api/calibrate_roi.php",
		map[string]string{"token": config.DefaultSenderToken},
		map[string][]byte{"image": []byte("not-a-png")}))
	ok, _, errStr = decodeEnvelope(t, rec)
	if rec.Code != 400 || ok || errStr == nil || *errStr != "只支持 PNG/JPEG 截图" {
		t.Fatalf("non-image unexpected: %d %v %v", rec.Code, ok, errStr)
	}

	// <300x200 -> 200
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, makeMultipartReq(t, "/api/calibrate_roi.php",
		map[string]string{"token": config.DefaultSenderToken},
		map[string][]byte{"image": buildTestPNG(t, 100, 100)}))
	ok, _, errStr = decodeEnvelope(t, rec)
	if rec.Code != 200 || ok || errStr == nil || *errStr != "截图尺寸过小，无法进行界面分析" {
		t.Fatalf("small image unexpected: %d %v %v", rec.Code, ok, errStr)
	}

	// >10MB -> 400
	oversize := make([]byte, maxCalibrateImageBytes+1)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, makeMultipartReq(t, "/api/calibrate_roi.php",
		map[string]string{"token": config.DefaultSenderToken},
		map[string][]byte{"image": oversize}))
	ok, _, errStr = decodeEnvelope(t, rec)
	if rec.Code != 400 || ok || errStr == nil || *errStr != "截图不能超过 10MB" {
		t.Fatalf("oversize image unexpected: %d %v %v", rec.Code, ok, errStr)
	}

	// Valid 400x300 with <think> + 0..1000 coords
	mockContent = "<think>check</think>\n```json\n" +
		`{"success":true,"title_bar":[20,300,80,980],"input_box":[780,300,980,980],"reason":"张三"}` +
		"\n```"
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, makeMultipartReq(t, "/api/calibrate_roi.php",
		map[string]string{"token": config.DefaultSenderToken},
		map[string][]byte{"image": buildTestPNG(t, 400, 300)}))
	ok, data, errStr = decodeEnvelope(t, rec)
	if rec.Code != 200 || !ok || errStr == nil || *errStr != "ok" {
		t.Fatalf("success calibrate unexpected: %d %v %+v %v", rec.Code, ok, data, errStr)
	}
	wantChat := []float64{0.3, 0.08, 0.68, 0.7}
	gotChat := data["chat"].([]any)
	for i := range wantChat {
		if gotChat[i].(float64) != wantChat[i] {
			t.Fatalf("chat[%d] = %v, want %v (full=%+v)", i, gotChat[i], wantChat[i], data)
		}
	}

	// Overlapping input_box <= title_bar -> 200 error
	mockContent = `{"success":true,"title_bar":[200,300,260,980],"input_box":[220,300,360,980],"reason":"overlap"}`
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, makeMultipartReq(t, "/api/calibrate_roi.php",
		map[string]string{"token": config.DefaultSenderToken},
		map[string][]byte{"image": buildTestPNG(t, 400, 300)}))
	ok, _, errStr = decodeEnvelope(t, rec)
	if rec.Code != 200 || ok || errStr == nil || *errStr != "检测到输入框位置异常（压住标题栏）" {
		t.Fatalf("overlap unexpected: %d %v %v", rec.Code, ok, errStr)
	}

	// NaN/Inf string coordinates must return 200 error instead of 500 JSON encode error
	mockContent = `{"success":true,"title_bar":["NaN",300,80,980],"input_box":[780,300,980,980],"reason":"nan"}`
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, makeMultipartReq(t, "/api/calibrate_roi.php",
		map[string]string{"token": config.DefaultSenderToken},
		map[string][]byte{"image": buildTestPNG(t, 400, 300)}))
	ok, _, errStr = decodeEnvelope(t, rec)
	if rec.Code != 200 || ok || errStr == nil || *errStr != "检测到的窗口区域坐标不完整或越界" {
		t.Fatalf("NaN coord unexpected: %d %v %v", rec.Code, ok, errStr)
	}

	// Too small chatH < 0.04 -> 200 error
	mockContent = `{"success":true,"title_bar":[20,300,80,980],"input_box":[100,300,250,980],"reason":"tiny"}`
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, makeMultipartReq(t, "/api/calibrate_roi.php",
		map[string]string{"token": config.DefaultSenderToken},
		map[string][]byte{"image": buildTestPNG(t, 400, 300)}))
	ok, _, errStr = decodeEnvelope(t, rec)
	if rec.Code != 200 || ok || errStr == nil || *errStr != "检测到的聊天消息区高度过小" {
		t.Fatalf("tiny chat unexpected: %d %v %v", rec.Code, ok, errStr)
	}

	// Upstream success=false -> 200 with reason
	mockContent = `{"success":false,"reason":"未检测到打开的聊天会话"}`
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, makeMultipartReq(t, "/api/calibrate_roi.php",
		map[string]string{"token": config.DefaultSenderToken},
		map[string][]byte{"image": buildTestPNG(t, 400, 300)}))
	ok, _, errStr = decodeEnvelope(t, rec)
	if rec.Code != 200 || ok || errStr == nil || *errStr != "未检测到打开的聊天会话" {
		t.Fatalf("success=false unexpected: %d %v %v", rec.Code, ok, errStr)
	}

	// Missing visionKey -> 200
	if err := os.WriteFile(filepath.Join(root, "config.json"), []byte(`{}`), 0644); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, makeMultipartReq(t, "/api/calibrate_roi.php",
		map[string]string{"token": config.DefaultSenderToken},
		map[string][]byte{"image": buildTestPNG(t, 400, 300)}))
	ok, _, errStr = decodeEnvelope(t, rec)
	if rec.Code != 200 || ok || errStr == nil || *errStr != "服务端视觉模型未配置，请联系管理员" {
		t.Fatalf("missing vision key unexpected: %d %v %v", rec.Code, ok, errStr)
	}

	// Gate disabled
	if err := os.WriteFile(filepath.Join(root, "config.json"), []byte(`{
		"dashscopeApiKey": "sk-cal",
		"identifyApiBase": "`+mockVision.URL+`/v1",
		"senderControl": {"enableAutoCalibration": false}
	}`), 0644); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, makeMultipartReq(t, "/api/calibrate_roi.php",
		map[string]string{"token": config.DefaultSenderToken},
		map[string][]byte{"image": buildTestPNG(t, 400, 300)}))
	ok, _, errStr = decodeEnvelope(t, rec)
	if rec.Code != 200 || ok || errStr == nil || *errStr != "ADMIN_DISABLED_AUTO_CALIBRATION: 管理员已关闭 AI 自动窗口校准，请改用本地手动框选" {
		t.Fatalf("gate disabled unexpected: %d %v %v", rec.Code, ok, errStr)
	}

	// >25MB body -> MaxBytesError returns 400 size error, NOT 200 鉴权失败 (even with form token)
	huge := make([]byte, (25<<20)+4096)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, makeMultipartReq(t, "/api/calibrate_roi.php",
		map[string]string{"token": config.DefaultSenderToken},
		map[string][]byte{"image": huge}))
	ok, _, errStr = decodeEnvelope(t, rec)
	if rec.Code != http.StatusBadRequest || ok || errStr == nil || *errStr != "截图不能超过 10MB" {
		t.Fatalf("huge body (>25MB) unexpected: %d %v %v", rec.Code, ok, errStr)
	}
}
