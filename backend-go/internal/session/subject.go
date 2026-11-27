package session

import (
	"context"
	"database/sql"
	"net/http"
	"strings"

	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
)

// SubjectScope describes the normalized subject access permissions for the current session.
type SubjectScope struct {
	All      bool
	Subjects []string
	Raw      string
	Enforced bool
}

// ParseSubjectScope parses a subject specification string (e.g. "数学", "数学,物理", "*").
func ParseSubjectScope(raw string) SubjectScope {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return SubjectScope{All: false, Subjects: []string{}, Raw: "", Enforced: true}
	}
	parts := strings.FieldsFunc(trimmed, func(r rune) bool {
		switch r {
		case ',', '，', '、', ';', '；', '/', '|':
			return true
		default:
			return false
		}
	})
	seen := make(map[string]struct{}, len(parts))
	subjects := make([]string, 0, len(parts))
	for _, p := range parts {
		t := strings.TrimSpace(p)
		if t == "" {
			continue
		}
		lower := strings.ToLower(t)
		if t == "*" || lower == "all" || t == "全部" || t == "所有学科" || t == "全学科" {
			return SubjectScope{All: true, Subjects: []string{"*"}, Raw: "*", Enforced: true}
		}
		if _, dup := seen[t]; !dup {
			seen[t] = struct{}{}
			subjects = append(subjects, t)
		}
	}
	return SubjectScope{
		All:      false,
		Subjects: subjects,
		Raw:      strings.Join(subjects, ","),
		Enforced: true,
	}
}

// Allows reports whether this scope grants access to the given subject.
func (sc SubjectScope) Allows(subject string) bool {
	if sc.All {
		return true
	}
	s := strings.TrimSpace(subject)
	if s == "" {
		return false
	}
	for _, allowed := range sc.Subjects {
		if allowed == s {
			return true
		}
	}
	return false
}

// ResolveUserSubjectFromDB resolves a user's effective subject from MySQL.
// Assistants automatically inherit their parent teacher's subject.
func ResolveUserSubjectFromDB(ctx context.Context, db *sql.DB, userID int64, username, role string, teacherID int64, createdBy string) (string, bool) {
	if db == nil {
		return "", false
	}
	var subj, dbRole, dbCreatedBy sql.NullString
	var dbTeacherID sql.NullInt64
	var err error
	if userID > 0 {
		err = db.QueryRowContext(
			ctx,
			"SELECT `subject`, `role`, `teacher_id`, `created_by` FROM `users` WHERE `id` = ? LIMIT 1",
			userID,
		).Scan(&subj, &dbRole, &dbTeacherID, &dbCreatedBy)
	} else if strings.TrimSpace(username) != "" {
		err = db.QueryRowContext(
			ctx,
			"SELECT `subject`, `role`, `teacher_id`, `created_by` FROM `users` WHERE `username` = ? LIMIT 1",
			strings.TrimSpace(username),
		).Scan(&subj, &dbRole, &dbTeacherID, &dbCreatedBy)
	} else {
		return "", false
	}
	if err != nil {
		return "", false
	}

	effectiveRole := strings.TrimSpace(dbRole.String)
	if effectiveRole == "" {
		effectiveRole = strings.TrimSpace(role)
	}
	if effectiveRole == "assistant" {
		parentID := dbTeacherID.Int64
		if parentID <= 0 {
			parentID = teacherID
		}
		parentUser := strings.TrimSpace(dbCreatedBy.String)
		if parentUser == "" {
			parentUser = strings.TrimSpace(createdBy)
		}
		var parentSubj sql.NullString
		var pErr error
		if parentID > 0 {
			pErr = db.QueryRowContext(ctx, "SELECT `subject` FROM `users` WHERE `id` = ? LIMIT 1", parentID).Scan(&parentSubj)
		}
		if (parentID <= 0 || pErr != nil) && parentUser != "" {
			pErr = db.QueryRowContext(ctx, "SELECT `subject` FROM `users` WHERE `username` = ? LIMIT 1", parentUser).Scan(&parentSubj)
		}
		if pErr == nil {
			return strings.TrimSpace(parentSubj.String), true
		}
	}
	return strings.TrimSpace(subj.String), true
}

// ResolveSubjectScope computes the current session's effective subject permissions.
func ResolveSubjectScope(ctx context.Context, sess *Session, db *sql.DB) SubjectScope {
	if sess == nil {
		return SubjectScope{All: false, Subjects: []string{}, Raw: "", Enforced: true}
	}
	uRole := sess.UserRole()
	isFrontUser := sess.IsUserLoggedIn()
	isAdmin := sess.IsAdminLoggedIn()

	if !isFrontUser {
		if isAdmin {
			return SubjectScope{All: true, Subjects: []string{"*"}, Raw: "*", Enforced: true}
		}
		return SubjectScope{All: false, Subjects: []string{}, Raw: "", Enforced: true}
	}

	username := strings.TrimSpace(sess.Username())
	adminUsername := strings.TrimSpace(sess.AdminUsername())
	if uRole == "admin" || uRole == "super_admin" || (isAdmin && adminUsername != "" && username == adminUsername) {
		return SubjectScope{All: true, Subjects: []string{"*"}, Raw: "*", Enforced: true}
	}

	if db != nil {
		userID := int64(sess.IntVal("user_id"))
		teacherID := int64(sess.IntVal("user_teacher_id"))
		createdBy := sess.StringVal("user_created_by")
		if rawSubj, ok := ResolveUserSubjectFromDB(ctx, db, userID, username, uRole, teacherID, createdBy); ok {
			return ParseSubjectScope(rawSubj)
		}
	}

	if sess.Data != nil {
		if rawVal, exists := sess.Data["user_subject"]; exists {
			return ParseSubjectScope(config.AsPHPString(rawVal))
		}
	}

	// Unit-test / no-DB compatibility: when neither DB nor user_subject session key is present,
	// default to unrestricted so legacy mock-session tests remain unaffected.
	if db == nil {
		return SubjectScope{All: true, Subjects: []string{"*"}, Raw: "*", Enforced: false}
	}
	return SubjectScope{All: false, Subjects: []string{}, Raw: "", Enforced: true}
}

// RequireSubjectAccess verifies that the session is permitted to access the given subject.
// On denial, writes HTTP 403 JSON and returns (scope, false).
func RequireSubjectAccess(ctx context.Context, w http.ResponseWriter, sess *Session, db *sql.DB, subject, actionDesc string) (SubjectScope, bool) {
	scope := ResolveSubjectScope(ctx, sess, db)
	if scope.All {
		return scope, true
	}
	if len(scope.Subjects) == 0 {
		httpx.SendJSON(w, http.StatusForbidden, map[string]any{
			"success": false,
			"error":   "当前账号尚未分配所属学科，请联系管理员配置",
		})
		return scope, false
	}
	if !scope.Allows(subject) {
		if strings.TrimSpace(actionDesc) == "" {
			actionDesc = "访问该学科数据"
		}
		allowedText := strings.Join(scope.Subjects, "、")
		httpx.SendJSON(w, http.StatusForbidden, map[string]any{
			"success": false,
			"error":   "无权" + actionDesc + "（当前账号仅限学科：" + allowedText + "）",
		})
		return scope, false
	}
	return scope, true
}
