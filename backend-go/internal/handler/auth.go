package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	"feedback-api/internal/auditlog"
	"feedback-api/internal/auth"
	"feedback-api/internal/captcha"
	"feedback-api/internal/config"
	"feedback-api/internal/httpx"
	"feedback-api/internal/ratelimit"
	"feedback-api/internal/session"
	"feedback-api/internal/tz"
)

var reValidAssistantUsername = regexp.MustCompile(`^[a-zA-Z0-9_\-\.]{2,30}$`)

// AuthDeps bundles the dependencies for /api/auth.php.
type AuthDeps struct {
	Repo      auth.Repository
	Sessions  session.Store
	RateLimit ratelimit.Store
	Audit     auditlog.Logger
	NowFunc   func() time.Time
}

func (d AuthDeps) nowUnix() int64 {
	if d.NowFunc != nil {
		return d.NowFunc().Unix()
	}
	return tz.Now().Unix()
}

// Auth implements GET|POST /api/auth.php matching feedback-v1/api/auth.php.
func Auth(deps AuthDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		action := strings.TrimSpace(r.URL.Query().Get("action"))
		switch action {
		case "captcha":
			handleAuthCaptcha(w, r, deps)
		case "check":
			handleAuthCheck(w, r, deps)
		case "login":
			handleAuthLogin(w, r, deps)
		case "logout":
			handleAuthLogout(w, r, deps)
		case "reset_password":
			handleAuthResetPassword(w, r, deps)
		case "assistant_list":
			handleAssistantList(w, r, deps)
		case "assistant_create":
			handleAssistantCreate(w, r, deps)
		case "assistant_update":
			handleAssistantUpdate(w, r, deps)
		case "assistant_delete":
			handleAssistantDelete(w, r, deps)
		default:
			httpx.SendResponse(w, false, nil, httpx.StrPtr("无效的操作指令"), http.StatusBadRequest)
		}
	}
}

func loadAuthSession(r *http.Request, store session.Store) (*session.Session, bool) {
	sess, isNew, err := session.LoadOrInit(r.Context(), r, store)
	if err != nil || sess == nil {
		newID, _ := session.NewSessionID()
		return &session.Session{ID: newID, Data: make(map[string]any)}, true
	}
	if sess.Data == nil {
		sess.Data = make(map[string]any)
	}
	return sess, isNew
}

func persistAuthSession(w http.ResponseWriter, r *http.Request, store session.Store, sess *session.Session, isNew bool) {
	if store == nil || sess == nil {
		return
	}
	if err := store.Save(r.Context(), sess); err == nil && isNew && len(sess.Data) > 0 {
		session.SetCookie(w, r, sess.ID)
	}
}

func readJSONBodyMap(r *http.Request) map[string]any {
	if r == nil || r.Body == nil {
		return map[string]any{}
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil || len(raw) == 0 {
		return map[string]any{}
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil || m == nil {
		return map[string]any{}
	}
	return m
}

func getRateStatus(ctx context.Context, rl ratelimit.Store, scope, id string, windowSec int) ratelimit.Status {
	if rl == nil || id == "" {
		return ratelimit.Status{}
	}
	st, err := rl.Status(ctx, scope, id, windowSec)
	if err != nil {
		return ratelimit.Status{}
	}
	return st
}

func recordRateFailure(ctx context.Context, rl ratelimit.Store, scope, id string, maxAttempts, windowSec, lockoutSec int) {
	if rl == nil || id == "" {
		return
	}
	_, _ = rl.RecordFailure(ctx, scope, id, maxAttempts, windowSec, lockoutSec)
}

func clearRateFailure(ctx context.Context, rl ratelimit.Store, scope, id string) {
	if rl == nil || id == "" {
		return
	}
	_ = rl.Clear(ctx, scope, id)
}

func handleAuthCaptcha(w http.ResponseWriter, r *http.Request, deps AuthDeps) {
	sess, isNew := loadAuthSession(r, deps.Sessions)
	code, pngBytes, err := captcha.Generate()
	if err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("验证码生成失败"), http.StatusInternalServerError)
		return
	}
	sess.Data["front_captcha_code"] = strings.ToLower(code)
	sess.Data["front_captcha_time"] = deps.nowUnix()
	if deps.Sessions != nil {
		_ = deps.Sessions.Save(r.Context(), sess)
	}
	if isNew {
		session.SetCookie(w, r, sess.ID)
	}

	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(pngBytes)
}

func handleAuthCheck(w http.ResponseWriter, r *http.Request, deps AuthDeps) {
	sess, _ := loadAuthSession(r, deps.Sessions)
	clientIP := httpx.GetClientIP(r)
	ipRate := getRateStatus(r.Context(), deps.RateLimit, "front_login_ip", clientIP, 600)
	requireCaptcha := sess.IntVal("front_login_fail_count") > 0 || ipRate.Count > 0
	hasAdminSession := sess.IsAdminLoggedIn()

	if sess.IsUserLoggedIn() {
		uRole := sess.StringVal("user_role")
		if uRole == "" {
			uRole = "teacher"
		}
		var userID any
		if v, ok := sess.Data["user_id"]; ok && v != nil {
			userID = v
		}
		httpx.SendResponse(w, true, map[string]any{
			"loggedIn":        true,
			"require_captcha": requireCaptcha,
			"user": map[string]any{
				"id":         userID,
				"username":   sess.StringVal("username"),
				"real_name":  sess.StringVal("real_name"),
				"role":       uRole,
				"is_admin":   hasAdminSession || uRole == "admin" || uRole == "super_admin",
				"created_by": sess.StringVal("user_created_by"),
			},
		}, nil, http.StatusOK)
		return
	}

	if hasAdminSession {
		adminUser := sess.StringVal("admin_username")
		if adminUser == "" {
			adminUser = "admin"
		}
		adminReal := sess.StringVal("admin_realname")
		if adminReal == "" {
			adminReal = "超级管理员"
		}
		adminRole := sess.StringVal("admin_role")
		if adminRole == "" {
			adminRole = "super_admin"
		}
		httpx.SendResponse(w, true, map[string]any{
			"loggedIn":        true,
			"require_captcha": requireCaptcha,
			"user": map[string]any{
				"id":         nil,
				"username":   adminUser,
				"real_name":  adminReal,
				"role":       adminRole,
				"is_admin":   true,
				"created_by": "",
			},
		}, nil, http.StatusOK)
		return
	}

	httpx.SendResponse(w, true, map[string]any{
		"loggedIn":        false,
		"require_captcha": requireCaptcha,
	}, nil, http.StatusOK)
}

func handleAuthLogin(w http.ResponseWriter, r *http.Request, deps AuthDeps) {
	if r.Method != http.MethodPost {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("只支持 POST 请求"), http.StatusMethodNotAllowed)
		return
	}

	ctx := r.Context()
	sess, isNew := loadAuthSession(r, deps.Sessions)
	input := readJSONBodyMap(r)
	username := strings.TrimSpace(config.AsPHPString(input["username"]))
	password := strings.TrimSpace(config.AsPHPString(input["password"]))
	clientIP := httpx.GetClientIP(r)

	ipRate := getRateStatus(ctx, deps.RateLimit, "front_login_ip", clientIP, 600)
	userRate := getRateStatus(ctx, deps.RateLimit, "front_login_user", username, 600)
	if ipRate.Locked || userRate.Locked {
		remainSec := ipRate.RemainingSeconds
		if userRate.RemainingSeconds > remainSec {
			remainSec = userRate.RemainingSeconds
		}
		if remainSec < 1 {
			remainSec = 1
		}
		httpx.SendResponse(w, false, map[string]any{"require_captcha": true},
			httpx.StrPtr(fmt.Sprintf("登录失败次数过多，请 %d 秒后再试", remainSec)), http.StatusTooManyRequests)
		return
	}

	requireCaptcha := sess.IntVal("front_login_fail_count") > 0 || ipRate.Count > 0 || userRate.Count > 0
	if requireCaptcha {
		captchaInput := strings.ToLower(strings.TrimSpace(config.AsPHPString(input["captcha"])))
		sessionCaptcha := sess.StringVal("front_captcha_code")
		if captchaInput == "" {
			httpx.SendResponse(w, false, map[string]any{"require_captcha": true}, httpx.StrPtr("请输入图形验证码"), http.StatusBadRequest)
			return
		}
		if sessionCaptcha == "" || captchaInput != sessionCaptcha {
			delete(sess.Data, "front_captcha_code")
			sess.Data["front_login_fail_count"] = sess.IntVal("front_login_fail_count") + 1
			persistAuthSession(w, r, deps.Sessions, sess, isNew)
			recordRateFailure(ctx, deps.RateLimit, "front_login_ip", clientIP, 10, 600, 600)
			httpx.SendResponse(w, false, map[string]any{"require_captcha": true}, httpx.StrPtr("验证码错误，请重新输入"), http.StatusBadRequest)
			return
		}
	}

	if username == "" || password == "" {
		httpx.SendResponse(w, false, map[string]any{"require_captcha": requireCaptcha}, httpx.StrPtr("请输入账号和密码"), http.StatusBadRequest)
		return
	}

	if username == "0" {
		sess.Data["front_login_fail_count"] = sess.IntVal("front_login_fail_count") + 1
		delete(sess.Data, "front_captcha_code")
		persistAuthSession(w, r, deps.Sessions, sess, isNew)
		recordRateFailure(ctx, deps.RateLimit, "front_login_ip", clientIP, 10, 600, 600)
		httpx.SendResponse(w, false, map[string]any{"require_captcha": true},
			httpx.StrPtr("测试账号已退出历史舞台，请使用已分配的教师专属账号登录"), http.StatusForbidden)
		return
	}

	if deps.Repo == nil {
		httpx.SendResponse(w, false, map[string]any{"require_captcha": requireCaptcha}, httpx.StrPtr("数据库连接异常，请稍后重试"), http.StatusInternalServerError)
		return
	}

	user, err := deps.Repo.FindUserByUsername(ctx, username)
	if err != nil {
		httpx.SendResponse(w, false, map[string]any{"require_captcha": requireCaptcha}, httpx.StrPtr("数据库连接异常，请稍后重试"), http.StatusInternalServerError)
		return
	}
	adminUser, _ := deps.Repo.FindAdminByUsername(ctx, username)

	if user == nil && adminUser == nil {
		sess.Data["front_login_fail_count"] = sess.IntVal("front_login_fail_count") + 1
		delete(sess.Data, "front_captcha_code")
		persistAuthSession(w, r, deps.Sessions, sess, isNew)
		recordRateFailure(ctx, deps.RateLimit, "front_login_ip", clientIP, 10, 600, 600)
		recordRateFailure(ctx, deps.RateLimit, "front_login_user", username, 5, 600, 600)
		auditlog.RecordFromRequest(ctx, deps.Audit, r, "warn", "user_auth", "login_failed_not_found", "", map[string]any{
			"username": username,
			"ip":       clientIP,
			"message":  "账号不存在: " + username,
		})
		httpx.SendResponse(w, false, map[string]any{"require_captcha": true}, httpx.StrPtr("账号或密码错误"), http.StatusUnauthorized)
		return
	}

	userActive := user != nil && user.Status == 1
	adminActive := adminUser != nil && adminUser.Status == 1
	if !userActive && !adminActive {
		sess.Data["front_login_fail_count"] = sess.IntVal("front_login_fail_count") + 1
		delete(sess.Data, "front_captcha_code")
		persistAuthSession(w, r, deps.Sessions, sess, isNew)
		recordRateFailure(ctx, deps.RateLimit, "front_login_ip", clientIP, 10, 600, 600)
		recordRateFailure(ctx, deps.RateLimit, "front_login_user", username, 5, 600, 600)
		auditlog.RecordFromRequest(ctx, deps.Audit, r, "warn", "user_auth", "login_failed_disabled", "", map[string]any{
			"username": username,
			"ip":       clientIP,
			"message":  "账号已停用: " + username,
		})
		httpx.SendResponse(w, false, map[string]any{"require_captcha": true}, httpx.StrPtr("该账号已被停用，请联系管理员"), http.StatusForbidden)
		return
	}

	userValid := userActive && auth.VerifyBcrypt(password, user.PasswordHash)
	adminValid := false
	if adminActive {
		valid, needsUpgrade := auth.VerifyAdminPassword(password, adminUser.PasswordHash)
		if valid {
			adminValid = true
			if needsUpgrade {
				if newHash, hErr := auth.HashPassword(password); hErr == nil {
					_ = deps.Repo.UpgradeAdminPasswordHash(ctx, adminUser.ID, newHash)
				}
			}
		}
	}

	if !userValid && !adminValid {
		sess.Data["front_login_fail_count"] = sess.IntVal("front_login_fail_count") + 1
		delete(sess.Data, "front_captcha_code")
		persistAuthSession(w, r, deps.Sessions, sess, isNew)
		recordRateFailure(ctx, deps.RateLimit, "front_login_ip", clientIP, 10, 600, 600)
		recordRateFailure(ctx, deps.RateLimit, "front_login_user", username, 5, 600, 600)
		auditlog.RecordFromRequest(ctx, deps.Audit, r, "warn", "user_auth", "login_failed_wrong_password", "", map[string]any{
			"username": username,
			"ip":       clientIP,
			"message":  "密码错误: " + username,
		})
		httpx.SendResponse(w, false, map[string]any{"require_captcha": true}, httpx.StrPtr("账号或密码错误"), http.StatusUnauthorized)
		return
	}

	// Login succeeded: reset failure counters & captcha
	delete(sess.Data, "front_login_fail_count")
	delete(sess.Data, "front_captcha_code")
	clearRateFailure(ctx, deps.RateLimit, "front_login_ip", clientIP)
	clearRateFailure(ctx, deps.RateLimit, "front_login_user", username)

	nowTs := deps.nowUnix()
	if userValid {
		uRole := user.Role
		if uRole == "" {
			uRole = "teacher"
		}
		sess.Data["user_logged_in"] = true
		sess.Data["user_id"] = user.ID
		sess.Data["username"] = user.Username
		sess.Data["real_name"] = user.RealName
		sess.Data["user_role"] = uRole
		sess.Data["user_teacher_id"] = user.TeacherID
		sess.Data["user_created_by"] = user.CreatedBy
		sess.Data["user_login_time"] = nowTs
		_ = deps.Repo.UpdateUserLogin(ctx, user.ID, clientIP)
	} else {
		clearUserSessionKeys(sess.Data)
	}

	if adminValid {
		aReal := adminUser.RealName
		if aReal == "" {
			aReal = "管理员"
		}
		aRole := adminUser.Role
		if aRole == "" {
			aRole = "super_admin"
		}
		sess.Data["admin_logged_in"] = true
		sess.Data["admin_username"] = adminUser.Username
		sess.Data["admin_realname"] = aReal
		sess.Data["admin_role"] = aRole
		sess.Data["login_time"] = nowTs
		_ = deps.Repo.UpdateAdminLogin(ctx, adminUser.ID, clientIP)
	}

	if err := session.Regenerate(ctx, w, r, deps.Sessions, sess); err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("登录会话保存失败，请稍后重试"), http.StatusInternalServerError)
		return
	}

	logUsername := username
	logRealName := ""
	logMsg := ""
	if userValid {
		logUsername = user.Username
		logRealName = user.RealName
		logMsg = "用户登录成功: " + logUsername
	} else {
		logUsername = adminUser.Username
		logRealName = adminUser.RealName
		if logRealName == "" {
			logRealName = "管理员"
		}
		logMsg = "管理员从前台登录成功: " + logUsername
	}
	auditlog.RecordFromRequest(ctx, deps.Audit, r, "action", "user_auth", "login_success", logUsername, map[string]any{
		"username":  logUsername,
		"real_name": logRealName,
		"ip":        clientIP,
		"message":   logMsg,
	})

	if userValid {
		uRole := user.Role
		if uRole == "" {
			uRole = "teacher"
		}
		hasAdminSession := adminValid || sess.IsAdminLoggedIn()
		httpx.SendResponse(w, true, map[string]any{
			"username":   user.Username,
			"real_name":  user.RealName,
			"role":       uRole,
			"is_admin":   hasAdminSession || uRole == "admin" || uRole == "super_admin",
			"created_by": user.CreatedBy,
			"message":    "登录成功",
		}, nil, http.StatusOK)
		return
	}

	aReal := adminUser.RealName
	if aReal == "" {
		aReal = "管理员"
	}
	aRole := adminUser.Role
	if aRole == "" {
		aRole = "super_admin"
	}
	httpx.SendResponse(w, true, map[string]any{
		"username":   adminUser.Username,
		"real_name":  aReal,
		"role":       aRole,
		"is_admin":   true,
		"created_by": "",
		"message":    "登录成功",
	}, nil, http.StatusOK)
}

func clearUserSessionKeys(data map[string]any) {
	delete(data, "user_logged_in")
	delete(data, "user_id")
	delete(data, "username")
	delete(data, "real_name")
	delete(data, "user_role")
	delete(data, "user_teacher_id")
	delete(data, "user_created_by")
	delete(data, "user_login_time")
}

func clearAdminSessionKeys(data map[string]any) {
	delete(data, "admin_logged_in")
	delete(data, "admin_username")
	delete(data, "admin_realname")
	delete(data, "admin_role")
	delete(data, "login_time")
}

func handleAuthLogout(w http.ResponseWriter, r *http.Request, deps AuthDeps) {
	ctx := r.Context()
	sess, isNew := loadAuthSession(r, deps.Sessions)

	uname := sess.StringVal("username")
	if uname == "" {
		uname = sess.StringVal("admin_username")
	}
	if uname == "" {
		uname = "unknown"
	}
	hadUserSession := sess.IsUserLoggedIn()
	clearUserSessionKeys(sess.Data)
	// 仅当前台是以纯管理员会话登录（无独立教师会话）时，才一并清除管理员会话
	if !hadUserSession {
		clearAdminSessionKeys(sess.Data)
	}
	if !isNew && deps.Sessions != nil {
		_, _ = session.Update(ctx, deps.Sessions, sess.ID, func(data map[string]any) (bool, error) {
			had := config.AsPHPBool(data["user_logged_in"])
			clearUserSessionKeys(data)
			if !had {
				clearAdminSessionKeys(data)
			}
			return true, nil
		})
	}

	auditlog.RecordFromRequest(ctx, deps.Audit, r, "action", "user_auth", "logout", uname, map[string]any{
		"username": uname,
		"ip":       httpx.GetClientIP(r),
		"message":  "用户退出登录: " + uname,
	})
	httpx.SendResponse(w, true, map[string]any{"message": "已成功退出登录"}, nil, http.StatusOK)
}

func handleAuthResetPassword(w http.ResponseWriter, r *http.Request, deps AuthDeps) {
	if r.Method != http.MethodPost {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("只支持 POST 请求"), http.StatusMethodNotAllowed)
		return
	}

	ctx := r.Context()
	sess, isNew := loadAuthSession(r, deps.Sessions)
	clientIP := httpx.GetClientIP(r)
	input := readJSONBodyMap(r)

	username := strings.TrimSpace(config.AsPHPString(input["username"]))
	oldPassword := strings.TrimSpace(config.AsPHPString(input["old_password"]))
	newPassword := strings.TrimSpace(config.AsPHPString(input["new_password"]))
	confirmPassword := strings.TrimSpace(config.AsPHPString(input["confirm_password"]))

	ipRate := getRateStatus(ctx, deps.RateLimit, "reset_pwd_ip", clientIP, 600)
	userRate := getRateStatus(ctx, deps.RateLimit, "reset_pwd_user", username, 600)
	if ipRate.Locked || userRate.Locked {
		auditlog.RecordFromRequest(ctx, deps.Audit, r, "warn", "user_auth", "reset_pwd_rate_limit_exceeded", username, map[string]any{
			"ip":       clientIP,
			"username": username,
			"message":  "密码重置尝试过于频繁，已触发限频锁定",
		})
		httpx.SendResponse(w, false, map[string]any{"require_captcha": true},
			httpx.StrPtr("密码重置尝试过于频繁，请10分钟后再试"), http.StatusTooManyRequests)
		return
	}

	requireCaptcha := sess.IntVal("reset_pwd_fail_count") > 0 || ipRate.Count > 0 || userRate.Count > 0
	if requireCaptcha {
		captchaInput := strings.ToLower(strings.TrimSpace(config.AsPHPString(input["captcha"])))
		sessionCaptcha := sess.StringVal("front_captcha_code")
		if captchaInput == "" || sessionCaptcha == "" || captchaInput != sessionCaptcha {
			delete(sess.Data, "front_captcha_code")
			sess.Data["reset_pwd_fail_count"] = sess.IntVal("reset_pwd_fail_count") + 1
			persistAuthSession(w, r, deps.Sessions, sess, isNew)
			recordRateFailure(ctx, deps.RateLimit, "reset_pwd_ip", clientIP, 5, 600, 600)
			if username != "" {
				recordRateFailure(ctx, deps.RateLimit, "reset_pwd_user", username, 5, 600, 600)
			}
			httpx.SendResponse(w, false, map[string]any{"require_captcha": true}, httpx.StrPtr("验证码错误，请重新输入"), http.StatusBadRequest)
			return
		}
	}

	if username == "" {
		httpx.SendResponse(w, false, map[string]any{"require_captcha": requireCaptcha}, httpx.StrPtr("请输入教师账号"), http.StatusBadRequest)
		return
	}
	if username == "0" {
		auditlog.RecordFromRequest(ctx, deps.Audit, r, "warn", "user_auth", "reset_pwd_blocked_test_account", "0", map[string]any{
			"username": "0",
			"ip":       clientIP,
			"message":  "测试账号不支持重置密码功能",
		})
		httpx.SendResponse(w, false, map[string]any{"require_captcha": true},
			httpx.StrPtr("测试账号为公共过渡体验账号，不支持重置密码"), http.StatusForbidden)
		return
	}
	if oldPassword == "" {
		httpx.SendResponse(w, false, map[string]any{"require_captcha": requireCaptcha}, httpx.StrPtr("请输入原密码以验证身份"), http.StatusBadRequest)
		return
	}
	if newPassword == "" {
		httpx.SendResponse(w, false, map[string]any{"require_captcha": requireCaptcha}, httpx.StrPtr("请输入新密码"), http.StatusBadRequest)
		return
	}
	if len(newPassword) < 6 {
		httpx.SendResponse(w, false, map[string]any{"require_captcha": requireCaptcha}, httpx.StrPtr("新密码长度不能少于 6 位"), http.StatusBadRequest)
		return
	}
	if _, hasConfirm := input["confirm_password"]; hasConfirm && newPassword != confirmPassword {
		httpx.SendResponse(w, false, map[string]any{"require_captcha": requireCaptcha}, httpx.StrPtr("两次输入的新密码不一致"), http.StatusBadRequest)
		return
	}
	if newPassword == oldPassword {
		httpx.SendResponse(w, false, map[string]any{"require_captcha": requireCaptcha}, httpx.StrPtr("新密码不能与原密码相同"), http.StatusBadRequest)
		return
	}

	if deps.Repo == nil {
		httpx.SendResponse(w, false, map[string]any{"require_captcha": requireCaptcha}, httpx.StrPtr("数据库连接异常，请稍后重试"), http.StatusInternalServerError)
		return
	}
	user, err := deps.Repo.FindUserByUsername(ctx, username)
	if err != nil {
		httpx.SendResponse(w, false, map[string]any{"require_captcha": requireCaptcha}, httpx.StrPtr("数据库连接异常，请稍后重试"), http.StatusInternalServerError)
		return
	}

	authFailed := user == nil || user.Status != 1 || user.Username == "0" || !auth.VerifyBcrypt(oldPassword, user.PasswordHash)
	if authFailed {
		sess.Data["reset_pwd_fail_count"] = sess.IntVal("reset_pwd_fail_count") + 1
		delete(sess.Data, "front_captcha_code")
		persistAuthSession(w, r, deps.Sessions, sess, isNew)
		recordRateFailure(ctx, deps.RateLimit, "reset_pwd_ip", clientIP, 5, 600, 600)
		recordRateFailure(ctx, deps.RateLimit, "reset_pwd_user", username, 5, 600, 600)
		auditlog.RecordFromRequest(ctx, deps.Audit, r, "warn", "user_auth", "reset_pwd_failed_auth", username, map[string]any{
			"username": username,
			"ip":       clientIP,
			"message":  "重置密码身份核验未通过: " + username,
		})
		httpx.SendResponse(w, false, map[string]any{"require_captcha": true}, httpx.StrPtr("账号或原密码错误，请核对后重试"), http.StatusBadRequest)
		return
	}

	newHash, err := auth.HashPassword(newPassword)
	if err != nil {
		if errors.Is(err, bcrypt.ErrPasswordTooLong) {
			httpx.SendResponse(w, false, map[string]any{"require_captcha": true}, httpx.StrPtr("密码长度不能超过 72 字节"), http.StatusBadRequest)
			return
		}
		httpx.SendResponse(w, false, map[string]any{"require_captcha": true}, httpx.StrPtr("密码更新失败，请稍后重试"), http.StatusInternalServerError)
		return
	}
	if err := deps.Repo.UpdateUserPassword(ctx, user.ID, newHash); err != nil {
		httpx.SendResponse(w, false, map[string]any{"require_captcha": true}, httpx.StrPtr("密码更新失败，请稍后重试"), http.StatusInternalServerError)
		return
	}

	delete(sess.Data, "reset_pwd_fail_count")
	delete(sess.Data, "front_captcha_code")
	persistAuthSession(w, r, deps.Sessions, sess, isNew)
	clearRateFailure(ctx, deps.RateLimit, "reset_pwd_ip", clientIP)
	clearRateFailure(ctx, deps.RateLimit, "reset_pwd_user", username)

	auditlog.RecordFromRequest(ctx, deps.Audit, r, "action", "user_auth", "password_reset_success", user.Username, map[string]any{
		"username":  user.Username,
		"real_name": user.RealName,
		"operator":  user.Username,
		"ip":        clientIP,
		"message":   fmt.Sprintf("教师 %s (%s) 成功重置密码", user.Username, user.RealName),
	})
	httpx.SendResponse(w, true, map[string]any{
		"username": user.Username,
		"message":  "密码重置成功，请使用新密码登录",
	}, nil, http.StatusOK)
}

func resolveAssistantOwnerContext(w http.ResponseWriter, r *http.Request, deps AuthDeps, deniedSuffix string) (int64, string, bool) {
	sess, _ := loadAuthSession(r, deps.Sessions)
	hasAdmin := sess.IsAdminLoggedIn()
	hasFrontUser := sess.IsUserLoggedIn()

	if !hasFrontUser && !hasAdmin {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("需要教师或管理员登录后才可"+deniedSuffix), http.StatusUnauthorized)
		return 0, "", false
	}

	var role string
	if hasFrontUser {
		role = sess.StringVal("user_role")
		if role == "" {
			role = "teacher"
		}
	} else {
		role = sess.StringVal("admin_role")
		if role == "" {
			role = "super_admin"
		}
	}
	if role == "assistant" {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("助教账号无权"+deniedSuffix), http.StatusForbidden)
		return 0, "", false
	}

	var ownerUsername string
	if hasFrontUser {
		ownerUsername = sess.StringVal("username")
	} else {
		ownerUsername = sess.StringVal("admin_username")
	}
	if ownerUsername == "0" || ownerUsername == "" {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("测试账号为公共体验账号，不支持"+deniedSuffix), http.StatusForbidden)
		return 0, "", false
	}

	var ownerID int64
	if hasFrontUser {
		ownerID = int64(sess.IntVal("user_id"))
	}
	if ownerID <= 0 && deps.Repo != nil {
		if linked, err := deps.Repo.FindUserByUsername(r.Context(), ownerUsername); err == nil && linked != nil {
			ownerID = linked.ID
		}
	}
	return ownerID, ownerUsername, true
}

func handleAssistantList(w http.ResponseWriter, r *http.Request, deps AuthDeps) {
	ownerID, ownerUsername, ok := resolveAssistantOwnerContext(w, r, deps, "管理助教账号")
	if !ok {
		return
	}
	if deps.Repo == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("查询助教列表失败"), http.StatusInternalServerError)
		return
	}
	assistants, err := deps.Repo.ListAssistants(r.Context(), ownerID, ownerUsername)
	if err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("查询助教列表失败"), http.StatusInternalServerError)
		return
	}
	httpx.SendResponse(w, true, map[string]any{"assistants": assistants}, nil, http.StatusOK)
}

func stripTeacherPrefix(teacherUsername, rawUsername string) string {
	tRunes := []rune(teacherUsername)
	rRunes := []rune(rawUsername)
	s := rawUsername
	if len(tRunes) > 0 && len(rRunes) >= len(tRunes) && strings.EqualFold(string(rRunes[:len(tRunes)]), teacherUsername) {
		s = string(rRunes[len(tRunes):])
	}
	return strings.TrimLeft(s, "_")
}

func handleAssistantCreate(w http.ResponseWriter, r *http.Request, deps AuthDeps) {
	if r.Method != http.MethodPost {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("只支持 POST 请求"), http.StatusMethodNotAllowed)
		return
	}
	ownerID, ownerUsername, ok := resolveAssistantOwnerContext(w, r, deps, "创建助教账号")
	if !ok {
		return
	}

	input := readJSONBodyMap(r)
	rawUsername := strings.TrimSpace(config.AsPHPString(input["username"]))
	realName := strings.TrimSpace(config.AsPHPString(input["real_name"]))
	password := strings.TrimSpace(config.AsPHPString(input["password"]))

	if rawUsername == "" || realName == "" || password == "" {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("请完整填写助教账号、姓名和初始密码"), http.StatusBadRequest)
		return
	}

	cleanSuffix := stripTeacherPrefix(ownerUsername, rawUsername)
	if cleanSuffix == "" {
		httpx.SendResponse(w, false, nil,
			httpx.StrPtr(fmt.Sprintf("助教账号请在教师前缀 [%s_] 后输入后缀编号，如 01 或 ta1", ownerUsername)), http.StatusBadRequest)
		return
	}
	username := ownerUsername + "_" + cleanSuffix
	if !reValidAssistantUsername.MatchString(username) {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("助教账号只能包含字母、数字、下划线、减号或点，长度2-30位"), http.StatusBadRequest)
		return
	}
	if len(password) < 6 {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("密码长度不能少于 6 位"), http.StatusBadRequest)
		return
	}
	if deps.Repo == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("创建助教账号失败，数据库服务异常"), http.StatusInternalServerError)
		return
	}

	ctx := r.Context()
	exist, err := deps.Repo.FindUserByUsername(ctx, username)
	if err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("创建助教账号失败，数据库服务异常"), http.StatusInternalServerError)
		return
	}
	if exist != nil {
		httpx.SendResponse(w, false, nil,
			httpx.StrPtr(fmt.Sprintf("账号 [%s] 已被注册，请更换其它账号名称", username)), http.StatusBadRequest)
		return
	}

	pwdHash, err := auth.HashPassword(password)
	if err != nil {
		if errors.Is(err, bcrypt.ErrPasswordTooLong) {
			httpx.SendResponse(w, false, nil, httpx.StrPtr("密码长度不能超过 72 字节"), http.StatusBadRequest)
			return
		}
		httpx.SendResponse(w, false, nil, httpx.StrPtr("创建助教账号失败，数据库服务异常"), http.StatusInternalServerError)
		return
	}
	newID, err := deps.Repo.CreateAssistant(ctx, username, pwdHash, realName, ownerID, ownerUsername)
	if err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("创建助教账号失败，数据库服务异常"), http.StatusInternalServerError)
		return
	}

	auditlog.RecordFromRequest(ctx, deps.Audit, r, "action", "user_auth", "assistant_created", ownerUsername, map[string]any{
		"teacher":        ownerUsername,
		"assistant_id":   newID,
		"assistant_user": username,
		"assistant_name": realName,
		"ip":             httpx.GetClientIP(r),
		"message":        fmt.Sprintf("教师 %s 创建了助教账号 %s (%s)", ownerUsername, username, realName),
	})
	httpx.SendResponse(w, true, map[string]any{
		"id":        newID,
		"username":  username,
		"real_name": realName,
		"message":   fmt.Sprintf("助教账号 [%s] 创建成功", username),
	}, nil, http.StatusOK)
}

func handleAssistantUpdate(w http.ResponseWriter, r *http.Request, deps AuthDeps) {
	if r.Method != http.MethodPost {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("只支持 POST 请求"), http.StatusMethodNotAllowed)
		return
	}
	ownerID, ownerUsername, ok := resolveAssistantOwnerContext(w, r, deps, "修改助教账号")
	if !ok {
		return
	}

	input := readJSONBodyMap(r)
	targetID := int64(config.AsPHPInt(input["id"]))
	if targetID <= 0 {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("缺少助教ID参数"), http.StatusBadRequest)
		return
	}
	if deps.Repo == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("更新助教账号失败"), http.StatusInternalServerError)
		return
	}

	ctx := r.Context()
	target, err := deps.Repo.FindAssistantOwned(ctx, targetID, ownerID, ownerUsername)
	if err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("更新助教账号失败"), http.StatusInternalServerError)
		return
	}
	if target == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("未找到指定助教账号，或您无权修改此账号"), http.StatusNotFound)
		return
	}

	var patch auth.AssistantUpdatePatch
	hasAny := false
	if v, exists := input["real_name"]; exists {
		rName := strings.TrimSpace(config.AsPHPString(v))
		if rName != "" {
			patch.RealName = &rName
			hasAny = true
		}
	}
	if v, exists := input["status"]; exists && v != nil {
		st := 0
		if config.AsPHPInt(v) == 1 {
			st = 1
		}
		patch.Status = &st
		hasAny = true
	}
	if v, exists := input["password"]; exists {
		pwd := strings.TrimSpace(config.AsPHPString(v))
		if pwd != "" {
			if len(pwd) < 6 {
				httpx.SendResponse(w, false, nil, httpx.StrPtr("新密码长度至少为 6 位"), http.StatusBadRequest)
				return
			}
			hash, hErr := auth.HashPassword(pwd)
			if hErr != nil {
				if errors.Is(hErr, bcrypt.ErrPasswordTooLong) {
					httpx.SendResponse(w, false, nil, httpx.StrPtr("新密码长度不能超过 72 字节"), http.StatusBadRequest)
					return
				}
				httpx.SendResponse(w, false, nil, httpx.StrPtr("更新助教账号失败"), http.StatusInternalServerError)
				return
			}
			patch.PasswordHash = &hash
			hasAny = true
		}
	}
	if !hasAny {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("未提供任何需修改的参数"), http.StatusBadRequest)
		return
	}

	if err := deps.Repo.UpdateAssistant(ctx, targetID, patch); err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("更新助教账号失败"), http.StatusInternalServerError)
		return
	}

	auditlog.RecordFromRequest(ctx, deps.Audit, r, "action", "user_auth", "assistant_updated", ownerUsername, map[string]any{
		"teacher":        ownerUsername,
		"assistant_id":   targetID,
		"assistant_user": target.Username,
		"ip":             httpx.GetClientIP(r),
		"message":        fmt.Sprintf("教师 %s 更新了助教账号 %s", ownerUsername, target.Username),
	})
	httpx.SendResponse(w, true, map[string]any{
		"message": fmt.Sprintf("助教账号 [%s] 更新成功", target.Username),
	}, nil, http.StatusOK)
}

func handleAssistantDelete(w http.ResponseWriter, r *http.Request, deps AuthDeps) {
	if r.Method != http.MethodPost {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("只支持 POST 请求"), http.StatusMethodNotAllowed)
		return
	}
	ownerID, ownerUsername, ok := resolveAssistantOwnerContext(w, r, deps, "删除助教账号")
	if !ok {
		return
	}

	input := readJSONBodyMap(r)
	targetID := int64(config.AsPHPInt(input["id"]))
	if targetID <= 0 {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("缺少助教ID参数"), http.StatusBadRequest)
		return
	}
	if deps.Repo == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("删除助教账号失败"), http.StatusInternalServerError)
		return
	}

	ctx := r.Context()
	target, err := deps.Repo.FindAssistantOwned(ctx, targetID, ownerID, ownerUsername)
	if err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("删除助教账号失败"), http.StatusInternalServerError)
		return
	}
	if target == nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("未找到指定助教账号，或您无权删除此账号"), http.StatusNotFound)
		return
	}

	if err := deps.Repo.DeleteAssistant(ctx, targetID); err != nil {
		httpx.SendResponse(w, false, nil, httpx.StrPtr("删除助教账号失败"), http.StatusInternalServerError)
		return
	}

	auditlog.RecordFromRequest(ctx, deps.Audit, r, "warn", "user_auth", "assistant_deleted", ownerUsername, map[string]any{
		"teacher":        ownerUsername,
		"assistant_id":   targetID,
		"assistant_user": target.Username,
		"ip":             httpx.GetClientIP(r),
		"message":        fmt.Sprintf("教师 %s 删除了助教账号 %s", ownerUsername, target.Username),
	})
	httpx.SendResponse(w, true, map[string]any{
		"message": fmt.Sprintf("已成功删除助教账号 [%s]", target.Username),
	}, nil, http.StatusOK)
}
