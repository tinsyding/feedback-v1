package handler

import (
	"errors"
	"io"
	"math"
	"net/http"
	"strings"
	"time"

	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
	"feedback-api/internal/vision"
)

const (
	maxCalibrateImageBytes = 10 * 1024 * 1024
	calibrateTimeout       = 45 * time.Second
)

const calibratePrompt = "你是企业微信客户端界面分析专家。图中是一个在 Windows 上运行的企业微信客户端主窗口截图。" +
	"请在图中精准定位当前主聊天会话区域（核心沟通区域）的两个关键矩形：" +
	"1. title_bar（顶部标题栏）：主聊天区域顶部的水平横条，显示当前聊天对象的姓名/群名/在线状态或右侧操作图标。左边界紧贴聊天区左侧分界线，高度约40-70像素。" +
	"2. input_box（底部输入框）：主聊天区域底部的消息输入与发送区域，包含表情工具栏、文字输入区和「发送(S)」按钮，底边界紧贴窗口下沿，高度约120-240像素。" +
	"【边界与防误识别关键规则】：" +
	"① 左边界：绝对不要包含最左侧的深灰/浅蓝导航图标栏与会话/联系人列表栏。" +
	"② 右边界：必须精准止于聊天主区域的右侧垂直分界线。特别注意：若聊天区右侧展开了【查找聊天记录面板】或【学员详情/客户画像/快捷回复侧边栏】等额外功能栏，右边界必须在聊天区与右侧功能栏之间的垂直分割线处截断（即以输入框右下角「发送(S)」按钮右侧边缘为界），绝对不能把右侧的查找记录或侧边栏包含进 title_bar 或 input_box 中！若右侧未展开任何额外面板，则右边界紧贴窗口右沿。" +
	"请严格输出 JSON（无 markdown 标记，无多余文字）：" +
	`{"success":true,"title_bar":[ymin,xmin,ymax,xmax],"input_box":[ymin,xmin,ymax,xmax],"reason":"简述检测到的会话对象或状态"}` +
	`坐标使用 0 到 1000 之间的整数归一化坐标。若图中未打开任何聊天会话，输出 {"success":false,"reason":"未检测到打开的聊天会话"}。`

type calibrateResponseData struct {
	Title      [4]float64 `json:"title"`
	Input      [4]float64 `json:"input"`
	Chat       [4]float64 `json:"chat"`
	Reason     string     `json:"reason"`
	DurationMs int        `json:"duration_ms"`
}

// CalibrateROI ports feedback-v1/api/calibrate_roi.php.
func CalibrateROI(loader *config.Loader, vc *vision.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			httpx.SendResponse(w, true, map[string]string{
				"service": "calibrate_roi",
				"status":  "ready",
			}, httpx.StrPtr("ok"), http.StatusOK)
			return
		}
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
					httpx.SendResponse(w, false, nil, httpx.StrPtr("截图不能超过 10MB"), http.StatusBadRequest)
					return
				}
			}
			if r.MultipartForm != nil {
				defer func() { _ = r.MultipartForm.RemoveAll() }()
			}
		} else if err := r.ParseForm(); err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				httpx.SendResponse(w, false, nil, httpx.StrPtr("截图不能超过 10MB"), http.StatusBadRequest)
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

		imgBytes, imgWidth, imgHeight, imgMime, errMsg, statusCode := readUploadedImage(r, "image", maxCalibrateImageBytes,
			"缺少上传整窗截图：image", "截图不能超过 10MB", "只支持 PNG/JPEG 截图")
		if errMsg != "" {
			httpx.SendResponse(w, false, nil, httpx.StrPtr(errMsg), statusCode)
			return
		}
		if imgWidth < 300 || imgHeight < 200 {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("截图尺寸过小，无法进行界面分析"), http.StatusOK)
			return
		}

		sc := cfg.SenderControl()
		if !sc.EnableAutoCalibration {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("ADMIN_DISABLED_AUTO_CALIBRATION: 管理员已关闭 AI 自动窗口校准，请改用本地手动框选"), http.StatusOK)
			return
		}

		visionKey := cfg.VisionAPIKey()
		if visionKey == "" {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("服务端视觉模型未配置，请联系管理员"), http.StatusOK)
			return
		}
		apiBase := cfg.IdentifyAPIBase()
		model := cfg.CalibrateModel()

		parts := []vision.ContentPart{
			{Type: "text", Text: calibratePrompt},
			{Type: "image_url", ImageURL: &vision.ImageURL{URL: vision.EncodeDataURL(imgMime, imgBytes)}},
		}

		content, err := vc.Complete(r.Context(), apiBase, visionKey, model, calibrateTimeout, parts)
		if err != nil {
			httpx.SendResponse(w, false, nil, httpx.StrPtr(err.Error()), http.StatusOK)
			return
		}

		parsed, err := vision.ParseModelJSON(content)
		if err != nil {
			httpx.SendResponse(w, false, nil, httpx.StrPtr(err.Error()), http.StatusOK)
			return
		}

		if !config.AsPHPBool(parsed["success"]) {
			reason := "多模态未能在截图中检测到会话窗口"
			if v, ok := parsed["reason"]; ok && v != nil {
				reason = config.AsPHPString(v)
			}
			httpx.SendResponse(w, false, nil, httpx.StrPtr(reason), http.StatusOK)
			return
		}

		titleRel, okTitle := parseBoxRel(parsed["title_bar"])
		inputRel, okInput := parseBoxRel(parsed["input_box"])
		if !okTitle || !okInput {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("检测到的窗口区域坐标不完整或越界"), http.StatusOK)
			return
		}

		titleBottom := titleRel[1] + titleRel[3]
		inputTop := inputRel[1]
		if inputTop <= titleBottom {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("检测到输入框位置异常（压住标题栏）"), http.StatusOK)
			return
		}

		chatX := min(titleRel[0], inputRel[0])
		chatY := titleBottom
		chatW := max(titleRel[0]+titleRel[2], inputRel[0]+inputRel[2]) - chatX
		chatH := inputTop - chatY
		if chatH < 0.04 {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("检测到的聊天消息区高度过小"), http.StatusOK)
			return
		}

		chatRel := [4]float64{
			round4(chatX),
			round4(chatY),
			round4(chatW),
			round4(chatH),
		}

		reason := "Qwen3.8-Max 自动识别成功"
		if v, ok := parsed["reason"]; ok && v != nil {
			reason = config.AsPHPString(v)
		}

		out := calibrateResponseData{
			Title:      titleRel,
			Input:      inputRel,
			Chat:       chatRel,
			Reason:     reason,
			DurationMs: int(math.Round(time.Since(t0).Seconds() * 1000)),
		}
		httpx.SendResponse(w, true, out, httpx.StrPtr("ok"), http.StatusOK)
	}
}

func readUploadedImage(r *http.Request, field string, maxBytes int64, missingMsg, tooBigMsg, badTypeMsg string) ([]byte, int, int, string, string, int) {
	file, fh, err := r.FormFile(field)
	if err != nil {
		return nil, 0, 0, "", missingMsg, http.StatusBadRequest
	}
	defer file.Close()

	if fh != nil && fh.Size > maxBytes {
		return nil, 0, 0, "", tooBigMsg, http.StatusBadRequest
	}

	raw, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return nil, 0, 0, "", missingMsg, http.StatusBadRequest
	}
	if int64(len(raw)) > maxBytes {
		return nil, 0, 0, "", tooBigMsg, http.StatusBadRequest
	}

	w, h, mime, ok := vision.InspectImage(raw)
	if !ok {
		return nil, 0, 0, "", badTypeMsg, http.StatusBadRequest
	}
	return raw, w, h, mime, "", 0
}

func parseBoxRel(raw any) ([4]float64, bool) {
	arr, ok := raw.([]any)
	if !ok || len(arr) < 4 {
		return [4]float64{}, false
	}

	v0 := config.AsPHPFloat(arr[0])
	v1 := config.AsPHPFloat(arr[1])
	v2 := config.AsPHPFloat(arr[2])
	v3 := config.AsPHPFloat(arr[3])
	for _, v := range [4]float64{v0, v1, v2, v3} {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return [4]float64{}, false
		}
	}

	if v0 > 1.0 || v1 > 1.0 || v2 > 1.0 || v3 > 1.0 {
		v0 /= 1000.0
		v1 /= 1000.0
		v2 /= 1000.0
		v3 /= 1000.0
	}

	d02 := math.Abs(v2 - v0)
	d13 := math.Abs(v3 - v1)

	var ymin, ymax, xmin, xmax float64
	if d02 < d13 {
		ymin = min(v0, v2)
		ymax = max(v0, v2)
		xmin = min(v1, v3)
		xmax = max(v1, v3)
	} else {
		ymin = min(v1, v3)
		ymax = max(v1, v3)
		xmin = min(v0, v2)
		xmax = max(v0, v2)
	}

	w := xmax - xmin
	h := ymax - ymin
	if w <= 0.05 || h <= 0.01 || xmin < 0 || ymin < 0 || xmin+w > 1.05 || ymin+h > 1.05 {
		return [4]float64{}, false
	}

	return [4]float64{
		round4(clamp01(xmin)),
		round4(clamp01(ymin)),
		round4(clamp01(w)),
		round4(clamp01(h)),
	}, true
}

func clamp01(v float64) float64 {
	if v < 0.0 {
		return 0.0
	}
	if v > 1.0 {
		return 1.0
	}
	return v
}

func round4(v float64) float64 {
	r := math.Round(v*10000) / 10000
	if r == 0 {
		return 0
	}
	return r
}
