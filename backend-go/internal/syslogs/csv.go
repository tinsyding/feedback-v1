package syslogs

import (
	"encoding/csv"
	"encoding/json"
	"io"
	"strings"

	"feedback-api/internal/config"
)

// SanitizeCSVCell defends against Excel/WPS formula injection (=, +, -, @, \t, \r).
func SanitizeCSVCell(val string) string {
	if val == "" {
		return val
	}
	switch val[0] {
	case '=', '+', '-', '@', '\t', '\r':
		return "'" + val
	default:
		return val
	}
}

// LevelLabel returns the Chinese level label for CSV export.
func LevelLabel(level string) string {
	switch level {
	case "error":
		return "错误"
	case "warn":
		return "警告"
	case "action":
		return "操作"
	case "info":
		return "信息"
	default:
		return level
	}
}

// FormatDetailsForExport formats details map as human-readable text matching PHP formatDetailsForExport().
func FormatDetailsForExport(details map[string]any) string {
	if len(details) == 0 {
		return "-"
	}
	if msg := strings.TrimSpace(config.AsPHPString(details["message"])); msg != "" {
		return msg
	}
	b, err := json.Marshal(details)
	if err != nil {
		return "-"
	}
	s := string(b)
	if len(s) > 300 {
		return s[:300] + "..."
	}
	return s
}

// WriteExportCSV writes UTF-8 BOM + header + sanitized rows to w.
func WriteExportCSV(w io.Writer, rows []ExportRow) error {
	// UTF-8 BOM for Excel Chinese display
	if _, err := w.Write([]byte{0xEF, 0xBB, 0xBF}); err != nil {
		return err
	}
	cw := csv.NewWriter(w)
	header := []string{"时间", "级别", "模块", "事件", "操作人/设备", "详情", "页面", "学科", "Session", "IP 地址", "用户代理"}
	if err := cw.Write(header); err != nil {
		return err
	}
	for _, r := range rows {
		op := r.Operator
		if op == "" {
			op = "-"
		}
		page := strings.TrimSpace(config.AsPHPString(r.Context["page"]))
		if page == "" {
			page = "-"
		}
		subject := strings.TrimSpace(config.AsPHPString(r.Context["subject"]))
		if subject == "" {
			subject = strings.TrimSpace(config.AsPHPString(r.Details["subject"]))
		}
		if subject == "" {
			subject = "-"
		}
		sessID := strings.TrimSpace(config.AsPHPString(r.Context["sessionId"]))
		if sessID == "" {
			sessID = "-"
		}
		ip := r.ClientIP
		if ip == "" {
			ip = "-"
		}
		ua := strings.TrimSpace(config.AsPHPString(r.ClientInfo["userAgent"]))
		if ua == "" {
			ua = "-"
		}
		rec := []string{
			SanitizeCSVCell(r.CreatedAt),
			SanitizeCSVCell(LevelLabel(r.Level)),
			SanitizeCSVCell(r.Module),
			SanitizeCSVCell(r.Event),
			SanitizeCSVCell(op),
			SanitizeCSVCell(FormatDetailsForExport(r.Details)),
			SanitizeCSVCell(page),
			SanitizeCSVCell(subject),
			SanitizeCSVCell(sessID),
			SanitizeCSVCell(ip),
			SanitizeCSVCell(ua),
		}
		if err := cw.Write(rec); err != nil {
			return err
		}
	}
	cw.Flush()
	return cw.Error()
}
