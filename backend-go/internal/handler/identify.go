package handler

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	mrand "math/rand/v2"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
	"feedback-api/internal/vision"
)

const (
	maxIdentifyImageBytes = 5 * 1024 * 1024
	identifyTimeout       = 50 * time.Second
)

var shanghaiLoc = loadShanghaiLocation()

func loadShanghaiLocation() *time.Location {
	if loc, err := time.LoadLocation("Asia/Shanghai"); err == nil {
		return loc
	}
	return time.FixedZone("CST", 8*3600)
}

type identifySidebarOutput struct {
	HasSidebar   bool   `json:"has_sidebar"`
	SidebarTitle string `json:"sidebar_title"`
	Reason       string `json:"reason"`
	DurationMs   int    `json:"duration_ms"`
}

type identifyStandardOutput struct {
	Matched         bool    `json:"matched"`
	IsGroup         bool    `json:"is_group"`
	TitleInHeader   bool    `json:"title_in_header"`
	DetectedTitle   string  `json:"detected_title"`
	LastSender      *string `json:"last_sender"`
	LastMessageText string  `json:"last_message_text"`
	NeedsReply      *bool   `json:"needs_reply"`
	Reason          string  `json:"reason"`
	DurationMs      int     `json:"duration_ms"`
}

type uploadedAsset struct {
	field string
	mime  string
	data  []byte
}

// Identify ports feedback-v1/api/identify.php.
func Identify(loader *config.Loader, vc *vision.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("仅支持 POST"), http.StatusMethodNotAllowed)
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, 25<<20)
		ct := strings.ToLower(r.Header.Get("Content-Type"))
		if strings.HasPrefix(ct, "multipart/form-data") {
			if err := r.ParseMultipartForm(16 << 20); err != nil {
				var maxErr *http.MaxBytesError
				if errors.As(err, &maxErr) {
					httpx.SendResponse(w, false, nil, httpx.StrPtr("上传图超过 5MB"), http.StatusBadRequest)
					return
				}
			}
			if r.MultipartForm != nil {
				defer func() { _ = r.MultipartForm.RemoveAll() }()
			}
		} else if err := r.ParseForm(); err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				httpx.SendResponse(w, false, nil, httpx.StrPtr("上传图超过 5MB"), http.StatusBadRequest)
				return
			}
		}

		cfg := loader.Load()
		token := httpx.ExtractBearerOrFormToken(r)
		if !cfg.VerifySenderToken(token) {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("鉴权失败"), http.StatusOK)
			return
		}

		t0 := time.Now()

		targetId := clipText(r.PostFormValue("target_id"), 64)
		targetName := clipText(r.PostFormValue("target_name"), 64)
		mode := clipText(r.PostFormValue("mode"), 16)
		switch mode {
		case "full", "title", "reply", "sidebar":
		default:
			mode = "full"
		}
		purpose := strings.ToLower(clipText(r.PostFormValue("purpose"), 24))
		detectedTitleIn := clipText(r.PostFormValue("detected_title"), 128)

		if mode != "sidebar" && targetId == "" && targetName == "" {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("target_id 与 target_name 不能同时为空"), http.StatusBadRequest)
			return
		}

		sc := cfg.SenderControl()
		disableFlash := cfg.IsTruthy("disableQwenFlashTitle")

		if mode == "title" && purpose == "benchmark" {
			if !sc.EnableBenchmarkModel {
				httpx.SendResponse(w, false, nil, httpx.StrPtr("ADMIN_DISABLED_BENCHMARK_MODEL: 管理员已停用基准评测云端大模型"), http.StatusOK)
				return
			}
		} else if mode == "title" {
			if disableFlash || sc.VerifyMode == "local" {
				httpx.SendResponse(w, false, nil, httpx.StrPtr("ADMIN_FORCED_LOCAL_OCR: 管理员已开启强制本地OCR核验，云端标题核验模型已停用"), http.StatusOK)
				return
			}
		} else if mode == "reply" {
			if !sc.EnableReplyAnalysis {
				httpx.SendResponse(w, false, nil, httpx.StrPtr("ADMIN_DISABLED_REPLY_ANALYSIS: 管理员已关闭后台家长留言分析大模型"), http.StatusOK)
				return
			}
		} else if mode == "sidebar" {
			// Sidebar check is not blocked by local OCR mode gate.
		} else {
			if disableFlash || sc.VerifyMode == "local" {
				httpx.SendResponse(w, false, nil, httpx.StrPtr("ADMIN_FORCED_LOCAL_OCR: 管理员已开启强制本地OCR核验，云端全图核验已停用"), http.StatusOK)
				return
			}
		}

		requiredFields := []string{"image_title", "image_chat"}
		switch mode {
		case "title":
			requiredFields = []string{"image_title"}
		case "reply":
			requiredFields = []string{"image_chat"}
		case "sidebar":
			requiredFields = []string{"image_window"}
		}

		assets := make(map[string]uploadedAsset, len(requiredFields))
		for _, field := range requiredFields {
			raw, _, _, mime, errMsg, statusCode := readUploadedImage(
				r,
				field,
				maxIdentifyImageBytes,
				"缺少上传图："+field,
				"上传图超过 5MB："+field,
				"只收 PNG/JPEG："+field,
			)
			if errMsg != "" {
				httpx.SendResponse(w, false, nil, httpx.StrPtr(errMsg), statusCode)
				return
			}
			assets[field] = uploadedAsset{field: field, mime: mime, data: raw}
		}

		visionKey := cfg.VisionAPIKey()
		if visionKey == "" {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("服务端视觉模型未配置，请联系管理员"), http.StatusOK)
			return
		}
		apiBase := cfg.IdentifyAPIBase()
		model := cfg.IdentifyModel(mode, purpose)

		parts := buildIdentifyUserContent(mode, targetId, targetName, detectedTitleIn, assets)
		content, err := vc.Complete(r.Context(), apiBase, visionKey, model, identifyTimeout, parts)
		if err != nil {
			httpx.SendResponse(w, false, nil, httpx.StrPtr(err.Error()), http.StatusOK)
			return
		}

		parsed, err := vision.ParseModelJSON(content)
		if err != nil {
			httpx.SendResponse(w, false, nil, httpx.StrPtr(err.Error()), http.StatusOK)
			return
		}

		durationMs := int(math.Round(time.Since(t0).Seconds() * 1000))
		var out any
		if mode == "sidebar" {
			b := asBoolOrNull(parsed["has_sidebar"])
			out = identifySidebarOutput{
				HasSidebar:   b != nil && *b,
				SidebarTitle: config.AsPHPString(parsed["sidebar_title"]),
				Reason:       config.AsPHPString(parsed["reason"]),
				DurationMs:   durationMs,
			}
		} else {
			out = identifyStandardOutput{
				Matched:         strictBoolTrue(parsed["matched"]),
				IsGroup:         strictBoolTrue(parsed["is_group"]),
				TitleInHeader:   strictBoolTrue(parsed["title_in_header"]),
				DetectedTitle:   config.AsPHPString(parsed["detected_title"]),
				LastSender:      normalizeLastSender(parsed["last_sender"]),
				LastMessageText: config.AsPHPString(parsed["last_message_text"]),
				NeedsReply:      asBoolOrNull(parsed["needs_reply"]),
				Reason:          config.AsPHPString(parsed["reason"]),
				DurationMs:      durationMs,
			}
		}

		archiveIdentifyResult(loader.FeedbackRoot, mode, targetId, targetName, detectedTitleIn, model, httpx.GetClientIP(r), assets, out, content)

		httpx.SendResponse(w, true, out, nil, http.StatusOK)

		if loader.FeedbackRoot != "" && mrand.IntN(10) == 0 {
			archiveRoot := filepath.Join(loader.FeedbackRoot, "data", "identify_archive")
			runAsyncCleanup(&identifyCleanupRunning, func() {
				cleanupIdentifyArchive(archiveRoot, time.Now().Add(-14*24*time.Hour))
			})
		}
	}
}

func buildIdentifyUserContent(mode, targetId, targetName, detectedTitleIn string, assets map[string]uploadedAsset) []vision.ContentPart {
	switch mode {
	case "title":
		prompt := "你是企业微信窗口核验器。看聊天窗口顶部标题栏截图。" +
			"目标学生学号为“" + targetId + "”，姓名为“" + targetName + "”。" +
			"只输出 JSON（无 markdown、无多余文字），字段：" +
			`{"matched":bool(是否为目标学生的私聊窗口),` +
			`"is_group":bool(是群聊/多人会话为true),` +
			`"title_in_header":bool(标题栏能读到有效标题),` +
			`"detected_title":string(标题栏读到的完整原文),` +
			`"reason":string(一句话理由)}。` +
			"【核验规则(方案1：学号精确+姓名容错)】：" +
			"1. 红线拦截：只要标题呈现群聊/讨论组特征（如带人数括号“(45)”、交流群、多位人名顿号逗号分隔等），matched必须为false，is_group必须为true；" +
			"2. 私聊判定：" +
			"   - 若目标学号非空（如5位数字）：学号为机构唯一主键，标题必须精准包含该学号。在此前提下，若姓名完全一致、或仅相差1个字（形近字/生僻字OCR误差，如“耔”识别为“籽”、“峰”识别为“夆”等）、或带“@微信/爸爸/妈妈”等后缀，均判定 matched=true；只有当学号缺失不符、或完全是另一个互不相干的人名时，matched 才为 false；" +
			"   - 若目标学号为空：标题必须完全包含目标姓名且非群聊才 matched=true。"
		a := assets["image_title"]
		return []vision.ContentPart{
			{Type: "text", Text: prompt},
			{Type: "image_url", ImageURL: &vision.ImageURL{URL: vision.EncodeDataURL(a.mime, a.data)}},
		}

	case "reply":
		titleCtx := detectedTitleIn
		if titleCtx == "" {
			titleCtx = targetId + targetName
		}
		prompt := "你是企业微信家长留言分析器。看聊天窗口消息区末尾截图（当前会话：“" + titleCtx + "”）。" +
			"只输出 JSON（无 markdown、无多余文字），字段：" +
			`{"last_sender":"me"|"parent"|"unknown"|null(聊天末尾最后一条是谁发的：我(右侧气泡)/家长(左侧气泡)/无法判断/无消息),` +
			`"last_message_text":string(最后一条文本内容，无则为空字符串),` +
			`"needs_reply":bool|null(家长最后一条需要老师回复为true，明确无需回或最后一条是我发的为false，判不出为null),` +
			`"reason":string(一句话理由)}`
		a := assets["image_chat"]
		return []vision.ContentPart{
			{Type: "text", Text: prompt},
			{Type: "image_url", ImageURL: &vision.ImageURL{URL: vision.EncodeDataURL(a.mime, a.data)}},
		}

	case "sidebar":
		prompt := "你是企业微信客户端界面布局分析专家。图中是一个在 Windows 上运行的企业微信主窗口截图。" +
			"请判断当前主聊天窗口【最右侧】是否额外展开了独立的右侧边栏面板（例如：「学员详情 / 客户详情 / 客户画像 / 快捷回复 / 服务总结」、「查找聊天记录」或「聊天信息」等右侧功能栏）。" +
			"【关键判断依据】：" +
			"1. 正常未展开右侧边栏时，整个窗口从左到右只有 3 栏：①最左侧导航图标栏、②会话列表栏、③主聊天窗口（底部输入框右下角的「发送(S)」按钮紧贴整个企微窗口最右边缘）。" +
			"2. 若展开了右侧边栏，整个窗口会变成 4 栏：在主聊天窗口（「发送(S)」按钮与聊天消息区）的右侧，还会多出一整块独立的垂直面板区域（通常顶部或内部有「学员详情」「客户详情」「快捷回复」「服务总结」「查找聊天记录」等标签或资料栏）。" +
			"3. 最左侧的导航栏、会话列表栏、以及主聊天区内部的气泡卡片都不算右侧边栏；只有主聊天区右侧多出来的独立侧边栏才算 has_sidebar=true。" +
			"只输出 JSON（无 markdown、无多余文字）：" +
			`{"has_sidebar":bool(右侧是否展开了独立侧边栏),"sidebar_title":string(识别到的侧边栏标签或标题，无则为空字符串),"reason":string(一句话判断依据)}`
		a := assets["image_window"]
		return []vision.ContentPart{
			{Type: "text", Text: prompt},
			{Type: "image_url", ImageURL: &vision.ImageURL{URL: vision.EncodeDataURL(a.mime, a.data)}},
		}

	default:
		prompt := "你是企业微信窗口核验器。看两张图：图1是聊天窗口顶部标题栏截图，图2是同一窗口聊天区末尾截图。" +
			"目标学生学号为“" + targetId + "”，姓名为“" + targetName + "”。" +
			"只输出 JSON（无 markdown、无多余文字），字段：" +
			`{"matched":bool(是否为目标学生的私聊窗口),` +
			`"is_group":bool(是群聊/多人会话为true),` +
			`"title_in_header":bool(标题栏能读到有效标题),` +
			`"detected_title":string(标题栏读到的完整原文),` +
			`"last_sender":"me"|"parent"|"unknown"|null(聊天末尾最后一条是谁发的：我/家长/无法判断/无消息),` +
			`"last_message_text":string(最后一条文本内容，无则为空字符串),` +
			`"needs_reply":bool|null(家长最后一条需要老师回复为true，明确无需回为false，判不出为null),` +
			`"reason":string(一句话理由)}。` +
			"【核验规则(方案1：学号精确+姓名容错)】：" +
			"1. 红线拦截：只要呈现群聊/讨论组特征，matched必须为false，is_group必须为true；" +
			"2. 私聊判定：若目标学号非空，学号为唯一主键，标题必须包含该学号；在此前提下，若姓名一致、或仅相差1字(形近字/生僻字OCR误差，如“耔”和“籽”)、或带后缀，matched=true；" +
			"若目标学号为空，则标题中姓名必须完全一致且非群聊。"
		t := assets["image_title"]
		c := assets["image_chat"]
		return []vision.ContentPart{
			{Type: "text", Text: prompt},
			{Type: "image_url", ImageURL: &vision.ImageURL{URL: vision.EncodeDataURL(t.mime, t.data)}},
			{Type: "image_url", ImageURL: &vision.ImageURL{URL: vision.EncodeDataURL(c.mime, c.data)}},
		}
	}
}

func clipText(v string, maxRunes int) string {
	v = strings.TrimSpace(v)
	if maxRunes <= 0 || utf8.RuneCountInString(v) <= maxRunes {
		return v
	}
	var b strings.Builder
	count := 0
	for _, r := range v {
		if count >= maxRunes {
			break
		}
		b.WriteRune(r)
		count++
	}
	return b.String()
}

func strictBoolTrue(v any) bool {
	b, ok := v.(bool)
	return ok && b
}

func asBoolOrNull(v any) *bool {
	if v == nil {
		return nil
	}
	switch x := v.(type) {
	case bool:
		return &x
	case json.Number:
		if i, err := x.Int64(); err == nil {
			if i == 1 {
				t := true
				return &t
			}
			if i == 0 {
				f := false
				return &f
			}
		}
		return nil
	case int:
		if x == 1 {
			t := true
			return &t
		}
		if x == 0 {
			f := false
			return &f
		}
		return nil
	case string:
		if x == "true" {
			t := true
			return &t
		}
		if x == "false" {
			f := false
			return &f
		}
		return nil
	default:
		return nil
	}
}

func normalizeLastSender(v any) *string {
	if v == nil {
		return nil
	}
	if s, ok := v.(string); ok {
		switch s {
		case "me", "parent", "unknown":
			return &s
		}
	}
	unknown := "unknown"
	return &unknown
}

func archiveIdentifyResult(feedbackRoot, mode, targetId, targetName, detectedTitleIn, model, ip string, assets map[string]uploadedAsset, mapped any, rawContent string) {
	if feedbackRoot == "" {
		return
	}
	now := time.Now().In(shanghaiLoc)
	archiveRoot := filepath.Join(feedbackRoot, "data", "identify_archive")
	var randBuf [4]byte
	_, _ = rand.Read(randBuf[:])
	leafName := now.Format("150405") + "_" + mode + "_" + hex.EncodeToString(randBuf[:])
	dayDir := filepath.Join(archiveRoot, now.Format("20060102"), leafName)
	if err := os.MkdirAll(dayDir, 0755); err != nil {
		return
	}

	writeAsset := func(field, filename string) {
		if a, ok := assets[field]; ok {
			_ = os.WriteFile(filepath.Join(dayDir, filename), a.data, 0644)
		}
	}
	writeAsset("image_title", "title.png")
	writeAsset("image_chat", "chat.png")
	writeAsset("image_window", "window.png")

	reqDoc := map[string]any{
		"mode":           mode,
		"target_id":      targetId,
		"target_name":    targetName,
		"detected_title": detectedTitleIn,
		"model":          model,
		"ip":             ip,
		"time":           now.Format("2006-01-02 15:04:05"),
	}
	writePrettyJSON(filepath.Join(dayDir, "request.json"), reqDoc)

	respDoc := map[string]any{
		"mapped":      mapped,
		"raw_content": rawContent,
	}
	writePrettyJSON(filepath.Join(dayDir, "response.json"), respDoc)
}

func writePrettyJSON(path string, v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "    ")
	if err := enc.Encode(v); err != nil {
		return
	}
	_ = os.WriteFile(path, bytes.TrimSuffix(buf.Bytes(), []byte("\n")), 0644)
}

func cleanupIdentifyArchive(archiveRoot string, cutoff time.Time) {
	dayEntries, err := os.ReadDir(archiveRoot)
	if err != nil {
		return
	}
	for _, dd := range dayEntries {
		if !dd.IsDir() {
			continue
		}
		ddPath := filepath.Join(archiveRoot, dd.Name())
		leaves, err := os.ReadDir(ddPath)
		if err != nil {
			continue
		}
		for _, leaf := range leaves {
			leafPath := filepath.Join(ddPath, leaf.Name())
			info, err := leaf.Info()
			if err != nil {
				continue
			}
			if info.ModTime().Before(cutoff) {
				if leaf.IsDir() {
					_ = os.RemoveAll(leafPath)
				} else {
					_ = os.Remove(leafPath)
				}
			}
		}
		if remaining, err := os.ReadDir(ddPath); err == nil && len(remaining) == 0 {
			_ = os.Remove(ddPath)
		}
	}
}
