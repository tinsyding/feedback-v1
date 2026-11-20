package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
	"feedback-api/internal/session"
)

var changelogMu sync.Mutex

func defaultChangelogEntries() []map[string]any {
	return []map[string]any{
		{
			"id":      "update_2026_11_12",
			"version": "v1.2.0",
			"date":    "2026-11-12",
			"title":   "系统更新提示",
			"active":  true,
			"items": []any{
				map[string]any{
					"title": "首页单人错题录入工作台",
					"desc":  "无需上传整班文件，在首页即可直接为单个学员录入或补录预习与课后错题，并即时生成专属错题本链接与薄弱考点家校反馈。",
				},
			},
		},
	}
}

func ensureChangelogFile(dataFile string) error {
	if _, err := os.Stat(dataFile); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(dataFile), 0755); err != nil {
		return err
	}
	return writeChangelogAtomic(dataFile, defaultChangelogEntries())
}

func readChangelogUnlocked(dataFile string) ([]map[string]any, error) {
	if err := ensureChangelogFile(dataFile); err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(dataFile)
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var logs []map[string]any
	if err := dec.Decode(&logs); err != nil || logs == nil {
		return []map[string]any{}, nil
	}
	return logs, nil
}

func writeChangelogAtomic(dataFile string, logs []map[string]any) error {
	if logs == nil {
		logs = []map[string]any{}
	}
	if err := os.MkdirAll(filepath.Dir(dataFile), 0755); err != nil {
		return err
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "    ")
	if err := enc.Encode(logs); err != nil {
		return err
	}
	tmpPath := fmt.Sprintf("%s.tmp.%d", dataFile, time.Now().UnixNano())
	if err := os.WriteFile(tmpPath, bytes.TrimSuffix(buf.Bytes(), []byte("\n")), 0644); err != nil {
		return err
	}
	return os.Rename(tmpPath, dataFile)
}

func withChangelogLock(dataFile string, fn func([]map[string]any) ([]map[string]any, error)) error {
	changelogMu.Lock()
	defer changelogMu.Unlock()

	lockPath := dataFile + ".lock"
	_ = os.MkdirAll(filepath.Dir(lockPath), 0755)
	lf, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0644)
	if err == nil {
		_ = syscall.Flock(int(lf.Fd()), syscall.LOCK_EX)
		defer func() {
			_ = syscall.Flock(int(lf.Fd()), syscall.LOCK_UN)
			_ = lf.Close()
		}()
	}

	logs, err := readChangelogUnlocked(dataFile)
	if err != nil {
		return err
	}
	updated, err := fn(logs)
	if err != nil {
		return err
	}
	return writeChangelogAtomic(dataFile, updated)
}

func sendChangelogError(w http.ResponseWriter, msg string) {
	httpx.SendJSON(w, http.StatusBadRequest, map[string]any{
		"success": false,
		"error":   msg,
	})
}

// Changelog ports feedback-v1/api/changelog.php (getAll/getActive public, save/delete/setActive require admin).
func Changelog(feedbackRoot string, store session.Store) http.HandlerFunc {
	dataFile := filepath.Join(feedbackRoot, "data", "changelog.json")

	return func(w http.ResponseWriter, r *http.Request) {
		action := r.URL.Query().Get("action")
		if action == "" && r.Method == http.MethodPost {
			ct := strings.ToLower(r.Header.Get("Content-Type"))
			if strings.HasPrefix(ct, "application/x-www-form-urlencoded") || strings.HasPrefix(ct, "multipart/form-data") {
				action = r.FormValue("action")
			}
		}

		switch action {
		case "getAll":
			changelogMu.Lock()
			logs, err := readChangelogUnlocked(dataFile)
			changelogMu.Unlock()
			if err != nil {
				sendChangelogError(w, "系统服务异常，请稍后重试")
				return
			}
			httpx.SendJSON(w, http.StatusOK, map[string]any{
				"success": true,
				"data":    logs,
			})

		case "getActive":
			changelogMu.Lock()
			logs, err := readChangelogUnlocked(dataFile)
			changelogMu.Unlock()
			if err != nil {
				sendChangelogError(w, "系统服务异常，请稍后重试")
				return
			}
			var active map[string]any
			for _, item := range logs {
				if config.AsPHPBool(item["active"]) {
					active = item
					break
				}
			}
			httpx.SendJSON(w, http.StatusOK, map[string]any{
				"success": true,
				"data":    active,
			})

		case "save":
			if _, ok := session.RequireAdmin(w, r, store); !ok {
				return
			}
			var input map[string]any
			dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20))
			dec.UseNumber()
			if err := dec.Decode(&input); err != nil || input == nil {
				sendChangelogError(w, "无效的数据")
				return
			}
			newLog, ok := input["log"].(map[string]any)
			if !ok || newLog == nil {
				sendChangelogError(w, "无效的数据")
				return
			}

			err := withChangelogLock(dataFile, func(logs []map[string]any) ([]map[string]any, error) {
				if config.AsPHPBool(newLog["active"]) {
					for i := range logs {
						logs[i]["active"] = false
					}
				}
				newID := config.AsPHPString(newLog["id"])
				found := false
				if newID != "" {
					for i := range logs {
						if config.AsPHPString(logs[i]["id"]) == newID {
							logs[i] = newLog
							found = true
							break
						}
					}
				}
				if !found {
					if !config.AsPHPBool(newLog["id"]) {
						newLog["id"] = fmt.Sprintf("update_%d", time.Now().Unix())
					}
					logs = append([]map[string]any{newLog}, logs...)
				}
				return logs, nil
			})
			if err != nil {
				sendChangelogError(w, "系统服务异常，请稍后重试")
				return
			}
			httpx.SendJSON(w, http.StatusOK, map[string]any{"success": true})

		case "delete":
			if _, ok := session.RequireAdmin(w, r, store); !ok {
				return
			}
			var input map[string]any
			dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
			dec.UseNumber()
			if err := dec.Decode(&input); err != nil || input == nil || !config.AsPHPBool(input["id"]) {
				sendChangelogError(w, "缺少ID")
				return
			}
			targetID := config.AsPHPString(input["id"])
			err := withChangelogLock(dataFile, func(logs []map[string]any) ([]map[string]any, error) {
				kept := make([]map[string]any, 0, len(logs))
				for _, item := range logs {
					if config.AsPHPString(item["id"]) != targetID {
						kept = append(kept, item)
					}
				}
				return kept, nil
			})
			if err != nil {
				sendChangelogError(w, "系统服务异常，请稍后重试")
				return
			}
			httpx.SendJSON(w, http.StatusOK, map[string]any{"success": true})

		case "setActive":
			if _, ok := session.RequireAdmin(w, r, store); !ok {
				return
			}
			var input map[string]any
			dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
			dec.UseNumber()
			if err := dec.Decode(&input); err != nil || input == nil || !config.AsPHPBool(input["id"]) {
				sendChangelogError(w, "缺少ID")
				return
			}
			targetID := config.AsPHPString(input["id"])
			err := withChangelogLock(dataFile, func(logs []map[string]any) ([]map[string]any, error) {
				for i := range logs {
					logs[i]["active"] = (config.AsPHPString(logs[i]["id"]) == targetID)
				}
				return logs, nil
			})
			if err != nil {
				sendChangelogError(w, "系统服务异常，请稍后重试")
				return
			}
			httpx.SendJSON(w, http.StatusOK, map[string]any{"success": true})

		default:
			sendChangelogError(w, "未知的操作")
		}
	}
}
