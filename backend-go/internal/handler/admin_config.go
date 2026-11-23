package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"

	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
	"feedback-api/internal/session"
	"feedback-api/internal/textutil"
	"feedback-api/internal/tz"
)

const adminConfigComment = "defaultSeason: spring/summer/autumn/winter (春/暑/秋/寒). semesterYear: 当前学年. semesterWeeks: 学期总周/次数. retestQuestionSpacing: 错题本拼页题目间隙(pt). retestQrCodeEnabled: 下载PDF是否包含视频讲解二维码. disableQwenFlashTitle: 与senderControl.verifyMode=local联动兼容字段. identifyApiBase / calibrateModel / identifyFastModel / identifyModel / benchmarkModel: 四环节大语言模型视觉配置（API Key 独立存储于 data/.ai_secrets.json 或环境变量）."

func handleAdminConfig(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	sess, ok := session.RequireAdmin(w, r, deps.Sessions)
	if !ok {
		return
	}
	if deps.ConfigLoader == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("配置文件不存在"), http.StatusInternalServerError)
		return
	}

	switch r.Method {
	case http.MethodGet:
		cfgPath := deps.ConfigLoader.ConfigJSONPath()
		rawBytes, err := os.ReadFile(cfgPath)
		if err != nil {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("配置文件不存在"), http.StatusInternalServerError)
			return
		}
		var cfgMap map[string]any
		if err := json.Unmarshal(rawBytes, &cfgMap); err != nil || cfgMap == nil {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("配置文件格式错误"), http.StatusInternalServerError)
			return
		}

		rt := deps.ConfigLoader.Load()
		realKey := rt.VisionAPIKey()
		cfgMap["hasApiKey"] = realKey != ""
		cfgMap["dashscopeApiKey"] = config.MaskAPIKey(realKey)
		if _, exists := cfgMap["identifyApiBase"]; !exists {
			cfgMap["identifyApiBase"] = rt.IdentifyAPIBase()
		}
		if _, exists := cfgMap["identifyModel"]; !exists {
			cfgMap["identifyModel"] = rt.IdentifyModel("full", "")
		}
		if _, exists := cfgMap["identifyFastModel"]; !exists {
			cfgMap["identifyFastModel"] = rt.IdentifyModel("title", "")
		}
		if strings.TrimSpace(config.AsPHPString(cfgMap["calibrateModel"])) == "" {
			m := strings.TrimSpace(config.AsPHPString(cfgMap["identifyModel"]))
			if m == "" {
				m = config.DefaultIdentifyModel
			}
			cfgMap["calibrateModel"] = m
		}
		if strings.TrimSpace(config.AsPHPString(cfgMap["benchmarkModel"])) == "" {
			m := strings.TrimSpace(config.AsPHPString(cfgMap["identifyFastModel"]))
			if m == "" {
				m = config.DefaultIdentifyFastModel
			}
			cfgMap["benchmarkModel"] = m
		}
		cfgMap["senderControl"] = rt.SenderControl()
		httpx.SendResponse(w, true, cfgMap, nil, http.StatusOK)

	case http.MethodPost:
		input, err := decodeAdminJSONBodyWithLimit(w, r, maxAdminJSONBodyBytes)
		if isMaxBytesError(err) {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("请求体大小超过限制"), http.StatusRequestEntityTooLarge)
			return
		}
		if input == nil {
			input = map[string]any{}
		}
		deps.ConfigLoader.LockWrite()
		defer deps.ConfigLoader.UnlockWrite()

		cfgPath := deps.ConfigLoader.ConfigJSONPath()
		rawBytes, err := os.ReadFile(cfgPath)
		if err != nil {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("配置文件不存在"), http.StatusInternalServerError)
			return
		}
		var cfgMap map[string]any
		if err := json.Unmarshal(rawBytes, &cfgMap); err != nil || cfgMap == nil {
			cfgMap = map[string]any{}
		}

		rtBefore := deps.ConfigLoader.Load()
		aiSecrets := make(map[string]any, len(rtBefore.AISecrets))
		for k, v := range rtBefore.AISecrets {
			aiSecrets[k] = v
		}
		// Migrate legacy plaintext dashscopeApiKey from config.json to data/.ai_secrets.json
		legacyKey := strings.TrimSpace(config.AsPHPString(cfgMap["dashscopeApiKey"]))
		if legacyKey != "" && strings.TrimSpace(config.AsPHPString(aiSecrets["dashscopeApiKey"])) == "" {
			aiSecrets["dashscopeApiKey"] = legacyKey
			if err := deps.ConfigLoader.SaveAISecrets(aiSecrets); err != nil {
				httpx.SendResponse(w, false, nil, httpx.StrPtr("迁移 AI 密钥文件失败，请检查 data/ 目录权限"), http.StatusInternalServerError)
				return
			}
		}

		if v, ok := input["defaultSeason"]; ok && v != nil {
			s := config.AsPHPString(v)
			if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
				cfgMap["defaultSeason"] = n
			} else {
				cfgMap["defaultSeason"] = s
			}
		}
		if v, ok := input["semesterYear"]; ok && v != nil {
			cfgMap["semesterYear"] = config.AsPHPInt(v)
		}
		if v, ok := input["semesterWeeks"]; ok && v != nil {
			cfgMap["semesterWeeks"] = config.AsPHPInt(v)
		}
		if v, ok := input["forceIntegerScores"]; ok && v != nil {
			cfgMap["forceIntegerScores"] = config.AsPHPBool(v)
		}
		if v, ok := input["retestQuestionSpacing"]; ok && v != nil {
			sp := config.AsPHPInt(v)
			if sp < 10 {
				sp = 10
			}
			if sp > 260 {
				sp = 260
			}
			cfgMap["retestQuestionSpacing"] = sp
		}
		if v, ok := input["retestQrCodeEnabled"]; ok && v != nil {
			cfgMap["retestQrCodeEnabled"] = config.AsPHPBool(v)
		}
		if v, ok := input["disableQwenFlashTitle"]; ok && v != nil {
			cfgMap["disableQwenFlashTitle"] = config.AsPHPBool(v)
		}

		if scRaw, ok := input["senderControl"].(map[string]any); ok {
			prevSC := config.NormalizeGlobalSenderControl(asStringAnyMap(cfgMap["senderControl"]), cfgMap)
			mergedRaw := senderControlToMap(prevSC)
			for k, v := range scRaw {
				mergedRaw[k] = v
			}
			if dqf, hasDQF := input["disableQwenFlashTitle"]; hasDQF && dqf != nil {
				if _, hasVM := scRaw["verifyMode"]; !hasVM {
					if config.AsPHPBool(dqf) {
						mergedRaw["verifyMode"] = "local"
					} else {
						mergedRaw["verifyMode"] = "auto"
					}
				}
			}
			normSC := config.NormalizeGlobalSenderControl(mergedRaw, cfgMap)
			normSC.PolicyVersion = prevSC.PolicyVersion + 1
			normSC.UpdatedAt = tz.In(deps.now()).Format("2006-01-02 15:04:05")
			cfgMap["senderControl"] = normSC
			cfgMap["disableQwenFlashTitle"] = normSC.VerifyMode == "local"
		} else if dqf, hasDQF := input["disableQwenFlashTitle"]; hasDQF && dqf != nil {
			prevSC := config.NormalizeGlobalSenderControl(asStringAnyMap(cfgMap["senderControl"]), cfgMap)
			if config.AsPHPBool(dqf) {
				prevSC.VerifyMode = "local"
			} else {
				prevSC.VerifyMode = "auto"
			}
			prevSC.PolicyVersion++
			prevSC.UpdatedAt = tz.In(deps.now()).Format("2006-01-02 15:04:05")
			cfgMap["senderControl"] = prevSC
		}

		rt := deps.ConfigLoader.Load()
		prevBase := strings.TrimSpace(rt.IdentifyAPIBase())
		hasNewKey := false
		newSubmittedKey := ""
		if rawKey, ok := input["dashscopeApiKey"]; ok {
			submittedKey := strings.TrimSpace(config.AsPHPString(rawKey))
			if submittedKey != "" && !config.IsMaskedAPIKey(submittedKey) {
				hasNewKey = true
				newSubmittedKey = submittedKey
			}
		}
		clearKeyRequested := config.AsPHPBool(input["clearApiKey"])

		if rawBase, ok := input["identifyApiBase"]; ok && rawBase != nil {
			newBase := strings.TrimSpace(config.AsPHPString(rawBase))
			if newBase != "" {
				newU, parseErr := url.Parse(newBase)
				if parseErr != nil || (!strings.EqualFold(newU.Scheme, "http") && !strings.EqualFold(newU.Scheme, "https")) || strings.TrimSpace(newU.Host) == "" {
					httpx.SendResponse(w, false, nil, httpx.StrPtr("API 端点 Base URL 格式无效"), http.StatusBadRequest)
					return
				}
				if httpx.IsBlockedSSRFHost(newU.Hostname()) {
					httpx.SendResponse(w, false, nil, httpx.StrPtr("API 端点不允许指向内网或本地地址"), http.StatusBadRequest)
					return
				}
				if prevU, prevErr := url.Parse(prevBase); prevErr == nil && prevBase != "" {
					hostChanged := !strings.EqualFold(newU.Scheme, prevU.Scheme) || !strings.EqualFold(newU.Host, prevU.Host)
					if hostChanged && rt.VisionAPIKey() != "" && !hasNewKey {
						externalKeyActive := strings.TrimSpace(os.Getenv("DASHSCOPE_API_KEY")) != "" || strings.TrimSpace(rt.Secrets.DashscopeApiKey) != ""
						if !clearKeyRequested || externalKeyActive {
							httpx.SendResponse(w, false, nil, httpx.StrPtr("更换自定义 API 端点时必须重新填写新的 API Key（或先清空环境变量/本地密钥文件中的旧密钥）"), http.StatusBadRequest)
							return
						}
					}
				}
			}
		}

		if hasNewKey {
			aiSecrets["dashscopeApiKey"] = newSubmittedKey
			if err := deps.ConfigLoader.SaveAISecrets(aiSecrets); err != nil {
				httpx.SendResponse(w, false, nil, httpx.StrPtr("保存 AI 密钥文件失败，请检查 data/ 目录权限"), http.StatusInternalServerError)
				return
			}
		} else if clearKeyRequested {
			delete(aiSecrets, "dashscopeApiKey")
			if err := deps.ConfigLoader.SaveAISecrets(aiSecrets); err != nil {
				httpx.SendResponse(w, false, nil, httpx.StrPtr("清理 AI 密钥文件失败，请检查 data/ 目录权限"), http.StatusInternalServerError)
				return
			}
		}

		delete(cfgMap, "dashscopeApiKey")
		delete(cfgMap, "hasApiKey")

		for _, k := range []string{"identifyApiBase", "identifyModel", "identifyFastModel", "calibrateModel", "benchmarkModel"} {
			if v, ok := input[k]; ok && v != nil {
				cfgMap[k] = strings.TrimSpace(config.AsPHPString(v))
			}
		}
		cfgMap["_comment"] = adminConfigComment

		if err := deps.ConfigLoader.SaveConfigJSON(cfgMap); err != nil {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("保存配置失败，请检查服务器权限"), http.StatusInternalServerError)
			return
		}

		rtAfter := deps.ConfigLoader.Load()
		effectiveKey := rtAfter.VisionAPIKey()

		adminAuditLog(r, deps, sess, "action", "config_updated", map[string]any{
			"semesterYear":          cfgMap["semesterYear"],
			"defaultSeason":         cfgMap["defaultSeason"],
			"semesterWeeks":         cfgMap["semesterWeeks"],
			"retestQrCodeEnabled":   cfgMap["retestQrCodeEnabled"],
			"disableQwenFlashTitle": cfgMap["disableQwenFlashTitle"],
			"hasApiKey":             effectiveKey != "",
			"identifyModel":         config.AsPHPString(cfgMap["identifyModel"]),
			"identifyFastModel":     config.AsPHPString(cfgMap["identifyFastModel"]),
			"message":               "管理员修改系统配置及 AI 大模型接口设置",
		})

		respCfg := make(map[string]any, len(cfgMap)+2)
		for k, v := range cfgMap {
			respCfg[k] = v
		}
		respCfg["hasApiKey"] = effectiveKey != ""
		respCfg["dashscopeApiKey"] = config.MaskAPIKey(effectiveKey)

		httpx.SendResponse(w, true, map[string]any{
			"message": "配置已更新",
			"config":  respCfg,
		}, nil, http.StatusOK)

	default:
		httpx.SendResponse(w, false, nil, httpx.StrPtr("不支持的请求方法"), http.StatusMethodNotAllowed)
	}
}

func handleAdminTestAIConfig(w http.ResponseWriter, r *http.Request, deps AdminDeps) {
	if _, ok := session.RequireAdmin(w, r, deps.Sessions); !ok {
		return
	}
	if r.Method != http.MethodPost {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("不支持的请求方法"), http.StatusMethodNotAllowed)
		return
	}
	input, err := decodeAdminJSONBodyWithLimit(w, r, maxAdminJSONBodyBytes)
	if isMaxBytesError(err) {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("请求体大小超过限制"), http.StatusRequestEntityTooLarge)
		return
	}
	if input == nil {
		input = map[string]any{}
	}
	apiKey := strings.TrimSpace(config.AsPHPString(input["api_key"]))
	submittedBase := strings.TrimSpace(config.AsPHPString(input["base_url"]))
	apiBase := submittedBase
	model := strings.TrimSpace(config.AsPHPString(input["model"]))

	var rt config.RuntimeConfig
	hasLoader := deps.ConfigLoader != nil
	if hasLoader {
		rt = deps.ConfigLoader.Load()
		if apiBase == "" {
			apiBase = rt.IdentifyAPIBase()
		}
		if model == "" {
			model = rt.IdentifyModel("full", "")
		}
	}

	if apiBase == "" {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("API 端点 Base URL 为空"), http.StatusBadRequest)
		return
	}
	if !strings.HasSuffix(apiBase, "/chat/completions") {
		apiBase = strings.TrimRight(apiBase, "/") + "/chat/completions"
	}
	parsedBase, err := url.Parse(apiBase)
	if err != nil || (!strings.EqualFold(parsedBase.Scheme, "http") && !strings.EqualFold(parsedBase.Scheme, "https")) || strings.TrimSpace(parsedBase.Host) == "" {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("API 端点 Base URL 格式无效"), http.StatusBadRequest)
		return
	}

	if apiKey == "" || config.IsMaskedAPIKey(apiKey) {
		if hasLoader {
			canReuseStoredKey := submittedBase == ""
			if !canReuseStoredKey {
				if defU, defErr := url.Parse(rt.IdentifyAPIBase()); defErr == nil {
					canReuseStoredKey = strings.EqualFold(parsedBase.Scheme, defU.Scheme) && strings.EqualFold(parsedBase.Host, defU.Host)
				}
			}
			if !canReuseStoredKey {
				httpx.SendResponse(w, false, nil, httpx.StrPtr("更换自定义 API 端点时必须重新填写 API Key，禁止复用已保存密钥"), http.StatusBadRequest)
				return
			}
			apiKey = rt.VisionAPIKey()
		}
	}

	if apiKey == "" {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("API Key 为空，无法进行连通性测试"), http.StatusBadRequest)
		return
	}

	payload := map[string]any{
		"model": model,
		"messages": []map[string]any{
			{"role": "user", "content": "测试连接。请回复简短确认。"},
		},
		"max_tokens":  15,
		"temperature": 0,
	}
	bodyBytes, _ := json.Marshal(payload)

	t0 := deps.now()
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, apiBase, bytes.NewReader(bodyBytes))
	if err != nil {
		httpx.SendResponse(w, false, map[string]any{
			"duration_ms": 0,
			"http_code":   0,
			"error":       "网络连接失败: " + err.Error(),
		}, httpx.StrPtr("API 请求失败: "+err.Error()), http.StatusOK)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := deps.httpClient().Do(req)
	durationMs := math.Round(float64(deps.now().Sub(t0).Milliseconds()))
	if err != nil {
		httpx.SendResponse(w, false, map[string]any{
			"duration_ms": durationMs,
			"http_code":   0,
			"error":       "网络连接失败: " + err.Error(),
		}, httpx.StrPtr("API 请求失败: "+err.Error()), http.StatusOK)
		return
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if len(raw) == 0 {
		httpx.SendResponse(w, false, map[string]any{
			"duration_ms": durationMs,
			"http_code":   resp.StatusCode,
			"error":       "网络连接失败: 未收到响应",
		}, httpx.StrPtr("API 请求失败: 未收到响应"), http.StatusOK)
		return
	}

	var decoded map[string]any
	_ = json.Unmarshal(raw, &decoded)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if choices, ok := decoded["choices"].([]any); ok {
			reply := ""
			if len(choices) > 0 {
				if first, ok := choices[0].(map[string]any); ok {
					if msg, ok := first["message"].(map[string]any); ok {
						reply = strings.TrimSpace(config.AsPHPString(msg["content"]))
					}
				}
			}
			httpx.SendResponse(w, true, map[string]any{
				"duration_ms": durationMs,
				"http_code":   resp.StatusCode,
				"model":       model,
				"reply":       reply,
			}, httpx.StrPtr("连通测试成功"), http.StatusOK)
			return
		}
	}

	errMsg := ""
	if errObj, ok := decoded["error"].(map[string]any); ok {
		errMsg = config.AsPHPString(errObj["message"])
	}
	if errMsg == "" {
		errMsg = config.AsPHPString(decoded["message"])
	}
	if errMsg == "" {
		snippet := textutil.TruncateRunes(string(raw), 150)
		errMsg = fmt.Sprintf("HTTP %d: %s", resp.StatusCode, snippet)
	}
	httpx.SendResponse(w, false, map[string]any{
		"duration_ms": durationMs,
		"http_code":   resp.StatusCode,
		"error":       errMsg,
	}, httpx.StrPtr("API 返回错误: "+errMsg), http.StatusOK)
}

func asStringAnyMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok && m != nil {
		return m
	}
	return map[string]any{}
}

func senderControlToMap(p config.SenderControlPolicy) map[string]any {
	b, _ := json.Marshal(p)
	out := map[string]any{}
	_ = json.Unmarshal(b, &out)
	return out
}
