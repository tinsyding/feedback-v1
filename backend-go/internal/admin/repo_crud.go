package admin

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/crypto/bcrypt"

	"feedback-api/internal/config"
	"feedback-api/internal/normalize"
	"feedback-api/internal/retestkeys"
)

func placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.Repeat("?,", n-1) + "?"
}

// ListRecords mirrors PHP actions_crud.php action=db_list.
func (r *MySQLRepository) ListRecords(ctx context.Context, q ListQuery) (ListResult, error) {
	tbl := q.Table
	if tbl == "" {
		tbl = "student_records"
	}
	table, err := r.validateTable(ctx, tbl)
	if err != nil {
		return ListResult{}, err
	}
	cols, colMap, pk, err := r.getTableColumns(ctx, table)
	if err != nil {
		return ListResult{}, err
	}

	page := q.Page
	if page < 1 {
		page = 1
	}
	pageSize := q.PageSize
	if pageSize < 1 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}
	offset := (page - 1) * pageSize

	order := "DESC"
	if strings.EqualFold(strings.TrimSpace(q.Order), "asc") {
		order = "ASC"
	}
	rawSort := strings.TrimSpace(q.Sort)
	if rawSort == "" {
		rawSort = pk
	}
	isCustomSort := table == "users" && rawSort == "assistant_count"
	sortCol := pk
	if _, ok := colMap[rawSort]; ok || isCustomSort {
		sortCol = rawSort
	}

	var whereParts []string
	var params []any
	hasCol := func(name string) bool { _, ok := colMap[name]; return ok }

	switch table {
	case "student_records":
		if q.BatchID > 0 && hasCol("batch_id") {
			whereParts = append(whereParts, "`batch_id` = ?")
			params = append(params, q.BatchID)
		}
		if q.BatchCode != "" && hasCol("batch_code") {
			whereParts = append(whereParts, "`batch_code` = ?")
			params = append(params, q.BatchCode)
		}
		if q.WeekNum > 0 && hasCol("week_num") {
			whereParts = append(whereParts, "`week_num` = ?")
			params = append(params, q.WeekNum)
		}
		if q.HasErrors != "" && hasCol("error_count") {
			if q.HasErrors == "1" || q.HasErrors == "has_err" {
				whereParts = append(whereParts, "`error_count` > 0")
			} else if q.HasErrors == "0" || q.HasErrors == "no_err" {
				whereParts = append(whereParts, "`error_count` = 0")
			}
		}
		if q.CreatedBy != "" && hasCol("created_by") {
			if q.CreatedBy == "__empty__" {
				whereParts = append(whereParts, "(`created_by` = '' OR `created_by` IS NULL)")
			} else {
				whereParts = append(whereParts, "`created_by` = ?")
				params = append(params, q.CreatedBy)
			}
		}
		if q.Grade != "" || q.Tier != "" || q.Subject != "" {
			var subW []string
			var subP []any
			if q.Grade != "" {
				subW = append(subW, "`grade` = ?")
				subP = append(subP, q.Grade)
			}
			if q.Tier != "" {
				subW = append(subW, "`tier` = ?")
				subP = append(subP, q.Tier)
			}
			if q.Subject != "" {
				subW = append(subW, "`subject` = ?")
				subP = append(subP, q.Subject)
			}
			whereParts = append(whereParts, "`batch_id` IN (SELECT `id` FROM `class_batches` WHERE "+strings.Join(subW, " AND ")+")")
			params = append(params, subP...)
		}
	case "generation_batches":
		if q.BatchCode != "" && hasCol("batch_code") {
			whereParts = append(whereParts, "`batch_code` = ?")
			params = append(params, q.BatchCode)
		}
		if q.ClassID > 0 && hasCol("class_id") {
			whereParts = append(whereParts, "`class_id` = ?")
			params = append(params, q.ClassID)
		}
		if q.WeekNum > 0 && hasCol("week_num") {
			whereParts = append(whereParts, "`week_num` = ?")
			params = append(params, q.WeekNum)
		}
		if q.CreatedBy != "" && hasCol("created_by") {
			if q.CreatedBy == "__empty__" {
				whereParts = append(whereParts, "(`created_by` = '' OR `created_by` IS NULL)")
			} else {
				whereParts = append(whereParts, "`created_by` = ?")
				params = append(params, q.CreatedBy)
			}
		}
		if q.Grade != "" || q.Tier != "" || q.Subject != "" {
			var subW []string
			var subP []any
			if q.Grade != "" {
				subW = append(subW, "`grade` = ?")
				subP = append(subP, q.Grade)
			}
			if q.Tier != "" {
				subW = append(subW, "`tier` = ?")
				subP = append(subP, q.Tier)
			}
			if q.Subject != "" {
				subW = append(subW, "`subject` = ?")
				subP = append(subP, q.Subject)
			}
			whereParts = append(whereParts, "`class_id` IN (SELECT `id` FROM `class_batches` WHERE "+strings.Join(subW, " AND ")+")")
			params = append(params, subP...)
		}
	case "class_batches":
		if q.Grade != "" && hasCol("grade") {
			whereParts = append(whereParts, "`grade` = ?")
			params = append(params, q.Grade)
		}
		if q.Tier != "" && hasCol("tier") {
			whereParts = append(whereParts, "`tier` = ?")
			params = append(params, q.Tier)
		}
		if q.Subject != "" && hasCol("subject") {
			whereParts = append(whereParts, "`subject` = ?")
			params = append(params, q.Subject)
		}
		if q.Year > 0 && hasCol("year") {
			whereParts = append(whereParts, "`year` = ?")
			params = append(params, q.Year)
		}
		if q.Season != "" && hasCol("season") {
			whereParts = append(whereParts, "`season` = ?")
			params = append(params, q.Season)
		}
	case "qbank_weeks", "qbank_questions":
		if q.Grade != "" && hasCol("grade") {
			whereParts = append(whereParts, "`grade` = ?")
			params = append(params, q.Grade)
		}
		if q.Tier != "" && hasCol("tier") {
			whereParts = append(whereParts, "`tier` = ?")
			params = append(params, q.Tier)
		}
		if q.Subject != "" && hasCol("subject") {
			whereParts = append(whereParts, "`subject` = ?")
			params = append(params, q.Subject)
		}
		if q.Year > 0 && hasCol("year") {
			whereParts = append(whereParts, "`year` = ?")
			params = append(params, q.Year)
		}
		if q.Season != "" && hasCol("season") {
			whereParts = append(whereParts, "`season` = ?")
			params = append(params, q.Season)
		}
		if q.Week > 0 && hasCol("week") {
			whereParts = append(whereParts, "`week` = ?")
			params = append(params, q.Week)
		}
	case "system_logs":
		if q.Level != "" && hasCol("level") {
			whereParts = append(whereParts, "`level` = ?")
			params = append(params, q.Level)
		}
		if q.Module != "" && hasCol("module") {
			whereParts = append(whereParts, "`module` = ?")
			params = append(params, q.Module)
		}
	case "retest_access_logs":
		if q.LogAction != "" && hasCol("action") {
			whereParts = append(whereParts, "`action` = ?")
			params = append(params, q.LogAction)
		}
	case "admin_users":
		if q.Status != "" {
			whereParts = append(whereParts, "`status` = ?")
			params = append(params, config.AsPHPInt(q.Status))
		}
		if q.Role != "" && hasCol("role") {
			whereParts = append(whereParts, "`role` = ?")
			params = append(params, q.Role)
		}
	case "users":
		whereParts = append(whereParts, "(`role` != 'assistant' OR `role` IS NULL)")
		if q.Status != "" {
			whereParts = append(whereParts, "`status` = ?")
			params = append(params, config.AsPHPInt(q.Status))
		}
	}

	search := strings.TrimSpace(q.Search)
	if search != "" {
		var searchConds []string
		isNum := IsNumericString(search)
		for _, c := range cols {
			if c.Name == "password_hash" || c.Name == "initial_password" {
				continue
			}
			t := strings.ToLower(c.Type)
			if strings.Contains(t, "char") || strings.Contains(t, "text") || strings.Contains(t, "json") {
				searchConds = append(searchConds, fmt.Sprintf("`%s` LIKE ?", c.Name))
				params = append(params, "%"+search+"%")
			} else if isNum && (strings.Contains(t, "int") || strings.Contains(t, "decimal")) {
				searchConds = append(searchConds, fmt.Sprintf("`%s` = ?", c.Name))
				params = append(params, search)
			}
		}
		if len(searchConds) > 0 {
			whereParts = append(whereParts, "("+strings.Join(searchConds, " OR ")+")")
		}
	}

	whereSQL := ""
	if len(whereParts) > 0 {
		whereSQL = "WHERE " + strings.Join(whereParts, " AND ")
	}

	var total int
	if err := r.db.QueryRowContext(ctx, fmt.Sprintf("SELECT COUNT(*) FROM `%s` %s", table, whereSQL), params...).Scan(&total); err != nil {
		return ListResult{}, err
	}

	var querySQL string
	switch table {
	case "qbank_questions":
		querySQL = fmt.Sprintf(
			"SELECT id, qbank_id, bank_type, `year`, `season`, subject, grade, tier, `week`, question_num, topic, video_url, exercise_pdf, exercise_name, answer_pdf, answer_name, created_by, updated_by, created_at, updated_at FROM `%s` %s ORDER BY `%s` %s LIMIT %d, %d",
			table, whereSQL, sortCol, order, offset, pageSize,
		)
	case "admin_users":
		querySQL = fmt.Sprintf(
			"SELECT `id`, `username`, '●●●●●●●●' AS `password_hash`, `real_name`, `role`, `status`, `last_login_at`, `last_login_ip`, `created_at`, `updated_at` FROM `%s` %s ORDER BY `%s` %s LIMIT %d, %d",
			table, whereSQL, sortCol, order, offset, pageSize,
		)
	case "users":
		orderClause := fmt.Sprintf("`%s` %s", sortCol, order)
		if sortCol == "assistant_count" {
			orderClause = fmt.Sprintf("(SELECT COUNT(*) FROM `users` `u_ast` WHERE `u_ast`.`role` = 'assistant' AND (`u_ast`.`teacher_id` = `users`.`id` OR `u_ast`.`created_by` = `users`.`username`)) %s, `users`.`id` ASC", order)
		}
		querySQL = fmt.Sprintf(
			"SELECT `id`, `username`, '' AS `initial_password`, `real_name`, `role`, `status`, `last_login_at`, `last_login_ip`, `created_at`, `updated_at` FROM `%s` %s ORDER BY %s LIMIT %d, %d",
			table, whereSQL, orderClause, offset, pageSize,
		)
	default:
		querySQL = fmt.Sprintf(
			"SELECT * FROM `%s` %s ORDER BY `%s` %s LIMIT %d, %d",
			table, whereSQL, sortCol, order, offset, pageSize,
		)
	}

	sqlRows, err := r.db.QueryContext(ctx, querySQL, params...)
	if err != nil {
		return ListResult{}, err
	}
	rows, err := scanDynamicRows(sqlRows)
	_ = sqlRows.Close()
	if err != nil {
		return ListResult{}, err
	}

	// Enrich batch info for student_records & generation_batches
	if (table == "student_records" || table == "generation_batches") && len(rows) > 0 {
		r.enrichBatchInfo(ctx, table, rows)
	}
	// Enrich teacher/assistant owner names
	switch table {
	case "student_records", "class_batches", "qbank_weeks", "qbank_questions", "system_logs", "generation_batches", "student_record_history":
		if len(rows) > 0 {
			r.enrichTeacherNames(ctx, rows)
		}
	}
	// Enrich weak points & source_files_list
	if (table == "student_records" || table == "student_record_history") && len(rows) > 0 {
		r.enrichWeakPoints(ctx, rows)
	}
	// Enrich assistants for users table
	if table == "users" && len(rows) > 0 {
		r.enrichUsersAssistants(ctx, rows)
	}

	totalPages := int(math.Ceil(float64(total) / float64(pageSize)))
	return ListResult{
		Table:      table,
		PrimaryKey: pk,
		Page:       page,
		PageSize:   pageSize,
		PerPage:    pageSize,
		Total:      total,
		TotalPages: totalPages,
		TotalPgs:   totalPages,
		Columns:    cols,
		Schema:     cols,
		Rows:       rows,
		Records:    rows,
	}, nil
}

func (r *MySQLRepository) enrichBatchInfo(ctx context.Context, table string, rows []map[string]any) {
	key := "batch_id"
	if table == "generation_batches" {
		key = "class_id"
	}
	idSet := map[int]struct{}{}
	var args []any
	for _, row := range rows {
		cid := config.AsPHPInt(row[key])
		if cid > 0 {
			if _, ok := idSet[cid]; !ok {
				idSet[cid] = struct{}{}
				args = append(args, cid)
			}
		}
	}
	if len(args) == 0 {
		return
	}
	qRows, err := r.db.QueryContext(ctx,
		fmt.Sprintf("SELECT id, `year`, `season`, `grade`, `tier`, `subject`, `class_name` FROM `class_batches` WHERE id IN (%s)", placeholders(len(args))),
		args...,
	)
	if err != nil {
		return
	}
	bRows, err := scanDynamicRows(qRows)
	_ = qRows.Close()
	if err != nil {
		return
	}
	bMap := make(map[int]map[string]any, len(bRows))
	for _, b := range bRows {
		bMap[config.AsPHPInt(b["id"])] = b
	}
	for _, row := range rows {
		cid := config.AsPHPInt(row[key])
		bInfo := bMap[cid]
		row["_batch"] = bInfo
		if bInfo != nil {
			row["class_name"] = bInfo["class_name"]
			row["grade"] = bInfo["grade"]
			row["tier"] = bInfo["tier"]
			row["subject"] = bInfo["subject"]
		} else {
			row["class_name"] = nil
			row["grade"] = nil
			row["tier"] = nil
			row["subject"] = nil
		}
	}
}

func (r *MySQLRepository) enrichTeacherNames(ctx context.Context, rows []map[string]any) {
	qRows, err := r.db.QueryContext(ctx, "SELECT `id`, `username`, `real_name`, `role`, `teacher_id`, `created_by` FROM `users`")
	if err != nil {
		return
	}
	uRows, err := scanDynamicRows(qRows)
	_ = qRows.Close()
	if err != nil {
		return
	}
	teacherMap := map[string]string{}
	byUsername := map[string]map[string]any{}
	byID := map[int]map[string]any{}
	for _, u := range uRows {
		uname := config.AsPHPString(u["username"])
		rname := config.AsPHPString(u["real_name"])
		teacherMap[uname] = rname
		byUsername[uname] = u
		byID[config.AsPHPInt(u["id"])] = u
	}
	for _, row := range rows {
		if rawCB, ok := row["created_by"]; ok && rawCB != nil {
			cb := config.AsPHPString(rawCB)
			if name, found := teacherMap[cb]; found {
				row["creator_name"] = name
			} else {
				row["creator_name"] = cb
			}
			creator := byUsername[cb]
			if creator != nil {
				row["creator_role"] = creator["role"]
			} else {
				row["creator_role"] = nil
			}
			row["creator_owner_username"] = nil
			row["creator_owner_name"] = nil
			if creator != nil && config.AsPHPString(creator["role"]) == "assistant" {
				var owner map[string]any
				if tid := config.AsPHPInt(creator["teacher_id"]); tid > 0 {
					owner = byID[tid]
				}
				if owner == nil {
					if oUname := config.AsPHPString(creator["created_by"]); oUname != "" {
						owner = byUsername[oUname]
					}
				}
				if owner != nil {
					oUname := config.AsPHPString(owner["username"])
					oRname := config.AsPHPString(owner["real_name"])
					row["creator_owner_username"] = oUname
					if oRname != "" {
						row["creator_owner_name"] = oRname
					} else {
						row["creator_owner_name"] = oUname
					}
				} else if oUname := config.AsPHPString(creator["created_by"]); oUname != "" {
					row["creator_owner_username"] = oUname
					if n, ok := teacherMap[oUname]; ok {
						row["creator_owner_name"] = n
					} else {
						row["creator_owner_name"] = oUname
					}
				}
			}
		}
		if rawUB, ok := row["updated_by"]; ok && rawUB != nil {
			ub := config.AsPHPString(rawUB)
			if name, found := teacherMap[ub]; found {
				row["updater_name"] = name
			} else {
				row["updater_name"] = ub
			}
		}
		if rawOp, ok := row["operator"]; ok && rawOp != nil {
			op := config.AsPHPString(rawOp)
			if name, found := teacherMap[op]; found {
				row["operator_name"] = name
			} else {
				row["operator_name"] = op
			}
		}
	}
}

func (r *MySQLRepository) enrichWeakPoints(ctx context.Context, rows []map[string]any) {
	type qKey struct {
		subject, grade, tier string
		week                 int
	}
	hwQueries := map[qKey]struct{}{}
	pvQueries := map[qKey]struct{}{}

	getDim := func(row map[string]any, field string) string {
		if v := config.AsPHPString(row[field]); v != "" {
			return v
		}
		if b, ok := row["_batch"].(map[string]any); ok && b != nil {
			return config.AsPHPString(b[field])
		}
		return ""
	}

	for _, row := range rows {
		sSub := getDim(row, "subject")
		sGrd := getDim(row, "grade")
		sTier := getDim(row, "tier")
		sWk := config.AsPHPInt(row["week_num"])
		if len(DecodeJSONAnyList(row["error_questions"])) > 0 && sSub != "" && sGrd != "" {
			hwQueries[qKey{sSub, sGrd, sTier, sWk}] = struct{}{}
		}
		pWk := sWk
		if row["preview_week_num"] != nil {
			pWk = config.AsPHPInt(row["preview_week_num"])
		}
		if len(DecodeJSONAnyList(row["preview_error_questions"])) > 0 && sSub != "" && sGrd != "" && pWk > 0 {
			pvQueries[qKey{sSub, sGrd, sTier, pWk}] = struct{}{}
		}
	}

	fetchTopics := func(bankType string, queries map[qKey]struct{}) map[string]string {
		res := map[string]string{}
		for qk := range queries {
			gCands := GradeAliasCandidates(qk.grade)
			tCands := TierAliasCandidates(qk.tier)
			if len(gCands) == 0 || len(tCands) == 0 {
				continue
			}
			args := make([]any, 0, 2+len(gCands)+len(tCands))
			args = append(args, bankType, qk.subject)
			for _, g := range gCands {
				args = append(args, g)
			}
			for _, t := range tCands {
				args = append(args, t)
			}
			args = append(args, qk.week)
			qSQL := fmt.Sprintf(
				"SELECT `question_num`, `topic` FROM `qbank_questions` WHERE `bank_type` = ? AND `subject` = ? AND `grade` IN (%s) AND `tier` IN (%s) AND `week` = ?",
				placeholders(len(gCands)), placeholders(len(tCands)),
			)
			tRows, err := r.db.QueryContext(ctx, qSQL, args...)
			if err != nil {
				continue
			}
			subPrefix := fmt.Sprintf("%s___%s___%s___%d___", qk.subject, qk.grade, qk.tier, qk.week)
			for tRows.Next() {
				var qNum int
				var topic sql.NullString
				if err := tRows.Scan(&qNum, &topic); err == nil {
					res[subPrefix+strconv.Itoa(qNum)] = strings.TrimSpace(topic.String)
				}
			}
			_ = tRows.Close()
		}
		return res
	}

	hwTopicMap := fetchTopics("homework", hwQueries)
	pvTopicMap := fetchTopics("preview", pvQueries)

	buildWeak := func(errs []any, subKey string, tMap map[string]string) ([]map[string]any, []string, string) {
		details := []map[string]any{}
		weakList := []string{}
		seen := map[string]struct{}{}
		for _, num := range errs {
			qNum := config.AsPHPInt(num)
			cleanT := CleanTopicText(tMap[subKey+strconv.Itoa(qNum)])
			label := cleanT
			if label == "" {
				label = "未标注考点"
			}
			details = append(details, map[string]any{
				"num":   qNum,
				"topic": label,
			})
			if cleanT != "" {
				if _, ok := seen[cleanT]; !ok {
					seen[cleanT] = struct{}{}
					weakList = append(weakList, cleanT)
				}
			}
		}
		return details, weakList, strings.Join(weakList, "、")
	}

	for _, row := range rows {
		row["source_files_list"] = DecodeSourceFiles(row["source_files"])
		sSub := getDim(row, "subject")
		sGrd := getDim(row, "grade")
		sTier := getDim(row, "tier")
		sWk := config.AsPHPInt(row["week_num"])

		errs := DecodeJSONAnyList(row["error_questions"])
		if len(errs) > 0 && sSub != "" && sGrd != "" {
			subKey := fmt.Sprintf("%s___%s___%s___%d___", sSub, sGrd, sTier, sWk)
			d, w, wt := buildWeak(errs, subKey, hwTopicMap)
			row["error_details"] = d
			row["weak_points"] = w
			row["weak_points_text"] = wt
		} else {
			row["error_details"] = []map[string]any{}
			row["weak_points"] = []string{}
			row["weak_points_text"] = ""
		}

		pErrs := DecodeJSONAnyList(row["preview_error_questions"])
		pWk := sWk
		if row["preview_week_num"] != nil {
			pWk = config.AsPHPInt(row["preview_week_num"])
		}
		if len(pErrs) > 0 && sSub != "" && sGrd != "" && pWk > 0 {
			pSubKey := fmt.Sprintf("%s___%s___%s___%d___", sSub, sGrd, sTier, pWk)
			d, w, wt := buildWeak(pErrs, pSubKey, pvTopicMap)
			row["preview_error_details"] = d
			row["preview_weak_points"] = w
			row["preview_weak_points_text"] = wt
		} else {
			row["preview_error_details"] = []map[string]any{}
			row["preview_weak_points"] = []string{}
			row["preview_weak_points_text"] = ""
		}
	}
}

func (r *MySQLRepository) enrichUsersAssistants(ctx context.Context, rows []map[string]any) {
	qRows, err := r.db.QueryContext(ctx,
		"SELECT `id`, `username`, `real_name`, `role`, `status`, '' AS `initial_password`, `last_login_at`, `last_login_ip`, `created_at`, `teacher_id`, `created_by` FROM `users` WHERE `role` = 'assistant' ORDER BY `id` ASC",
	)
	if err != nil {
		return
	}
	asts, err := scanDynamicRows(qRows)
	_ = qRows.Close()
	if err != nil {
		return
	}
	byTID := map[int][]map[string]any{}
	byUname := map[string][]map[string]any{}
	for _, a := range asts {
		if tid := config.AsPHPInt(a["teacher_id"]); tid > 0 {
			byTID[tid] = append(byTID[tid], a)
		}
		if cb := config.AsPHPString(a["created_by"]); cb != "" {
			byUname[cb] = append(byUname[cb], a)
		}
	}
	for _, row := range rows {
		tid := config.AsPHPInt(row["id"])
		uname := config.AsPHPString(row["username"])
		seen := make(map[int]struct{})
		list := make([]map[string]any, 0, len(byTID[tid])+len(byUname[uname]))
		for _, a := range byTID[tid] {
			aid := config.AsPHPInt(a["id"])
			if aid > 0 {
				seen[aid] = struct{}{}
			}
			list = append(list, a)
		}
		for _, a := range byUname[uname] {
			aid := config.AsPHPInt(a["id"])
			if aid > 0 {
				if _, dup := seen[aid]; dup {
					continue
				}
				seen[aid] = struct{}{}
			}
			list = append(list, a)
		}
		row["assistants"] = list
		row["assistant_count"] = len(list)
	}
}

// GetRecord mirrors PHP actions_crud.php action=db_get.
func (r *MySQLRepository) GetRecord(ctx context.Context, table, id string) (map[string]any, error) {
	validTbl, err := r.validateTable(ctx, table)
	if err != nil {
		return nil, err
	}
	_, _, pk, err := r.getTableColumns(ctx, validTbl)
	if err != nil {
		return nil, err
	}
	qRows, err := r.db.QueryContext(ctx, fmt.Sprintf("SELECT * FROM `%s` WHERE `%s` = ? LIMIT 1", validTbl, pk), id)
	if err != nil {
		return nil, err
	}
	list, err := scanDynamicRows(qRows)
	_ = qRows.Close()
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, NewHTTPError(404, "记录未找到", nil)
	}
	row := list[0]
	if validTbl == "admin_users" {
		row["password_hash"] = ""
		row["password"] = ""
	} else if validTbl == "users" {
		row["password_hash"] = ""
		row["initial_password"] = ""
		if aRows, err := r.db.QueryContext(ctx,
			"SELECT `id`, `username`, `real_name`, `role`, `status`, '' AS `initial_password`, `last_login_at`, `last_login_ip`, `created_at`, `teacher_id`, `created_by` FROM `users` WHERE `role` = 'assistant' AND (`teacher_id` = ? OR `created_by` = ?) ORDER BY `id` ASC",
			row["id"], row["username"],
		); err == nil {
			if asts, err := scanDynamicRows(aRows); err == nil {
				row["assistants"] = asts
				row["assistant_count"] = len(asts)
			} else {
				row["assistants"] = []map[string]any{}
				row["assistant_count"] = 0
			}
			_ = aRows.Close()
		} else {
			row["assistants"] = []map[string]any{}
			row["assistant_count"] = 0
		}
	}
	return row, nil
}

// CreateRecord mirrors PHP actions_crud.php action=db_create.
func (r *MySQLRepository) CreateRecord(ctx context.Context, table string, input map[string]any, retestSecret string) (int64, error) {
	validTbl, err := r.validateTable(ctx, table)
	if err != nil {
		return 0, err
	}
	cols, _, _, err := r.getTableColumns(ctx, validTbl)
	if err != nil {
		return 0, err
	}

	data := make(map[string]any, len(input))
	for k, v := range input {
		data[k] = v
	}
	delete(data, "table")

	if validTbl == "admin_users" || validTbl == "users" {
		uname := strings.TrimSpace(config.AsPHPString(data["username"]))
		if uname == "" {
			return 0, NewHTTPError(400, "账号不能为空", nil)
		}
		data["username"] = uname
		var existsID int
		err := r.db.QueryRowContext(ctx, fmt.Sprintf("SELECT `id` FROM `%s` WHERE `username` = ? LIMIT 1", validTbl), uname).Scan(&existsID)
		if err == nil {
			return 0, NewHTTPError(400, fmt.Sprintf("账号 [%s] 已存在，请更换其它账号", uname), nil)
		}
		rawPwd := strings.TrimSpace(config.AsPHPString(data["password"]))
		if rawPwd == "" {
			rawPwd = strings.TrimSpace(config.AsPHPString(data["password_hash"]))
		}
		if rawPwd == "" {
			return 0, NewHTTPError(400, "新增账号必须设置登录密码", nil)
		}
		if len(rawPwd) < 6 {
			return 0, NewHTTPError(400, "登录密码长度不能少于 6 位", nil)
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(rawPwd), bcrypt.DefaultCost)
		if err != nil {
			if errors.Is(err, bcrypt.ErrPasswordTooLong) {
				return 0, NewHTTPError(400, "登录密码长度不能超过 72 字节", nil)
			}
			return 0, err
		}
		data["password_hash"] = string(hash)
		if validTbl == "users" {
			data["initial_password"] = ""
		}
		delete(data, "password")
	}

	if validTbl == "class_batches" {
		if rawSeason, ok := data["season"]; ok && rawSeason != nil {
			data["season"] = normalize.Season(config.AsPHPString(rawSeason), "zh")
		}
	}

	if validTbl == "student_records" {
		if config.AsPHPInt(data["batch_id"]) <= 0 {
			var latestBatch int
			if err := r.db.QueryRowContext(ctx, "SELECT id FROM class_batches ORDER BY id DESC LIMIT 1").Scan(&latestBatch); err == nil && latestBatch > 0 {
				data["batch_id"] = latestBatch
			}
		}
		var sGrade, sSubject sql.NullString
		if bid := config.AsPHPInt(data["batch_id"]); bid > 0 {
			_ = r.db.QueryRowContext(ctx, "SELECT grade, subject FROM class_batches WHERE id = ? LIMIT 1", bid).Scan(&sGrade, &sSubject)
		}
		_, hasSID := data["student_id"]
		_, hasSName := data["student_name"]
		if hasSID && hasSName && strings.TrimSpace(config.AsPHPString(data["student_key"])) == "" {
			data["student_key"] = retestkeys.BuildStudentKey(
				config.AsPHPString(data["student_id"]),
				config.AsPHPString(data["student_name"]),
				sGrade.String,
				sSubject.String,
			)
		}
		if rawEQ, ok := data["error_questions"]; ok && rawEQ != nil {
			eqJSON, eqCount := ParseErrorQuestions(rawEQ)
			data["error_questions"] = eqJSON
			if cnt, hasCnt := data["error_count"]; !hasCnt || cnt == nil {
				data["error_count"] = eqCount
			}
		}
		if rawPEQ, ok := data["preview_error_questions"]; ok {
			peqPtr, isNull := ParsePreviewErrorQuestions(rawPEQ)
			if isNull {
				data["preview_error_questions"] = nil
			} else {
				data["preview_error_questions"] = *peqPtr
			}
		}
		rt := strings.TrimSpace(config.AsPHPString(data["retest_token"]))
		if rt == "" || rt == "auto" {
			if strings.TrimSpace(retestSecret) == "" {
				return 0, NewHTTPError(500, "服务端密钥未配置，无法生成错题本凭证", nil)
			}
			sKeyForToken := config.AsPHPString(data["student_key"])
			if sKeyForToken == "" {
				sKeyForToken = retestkeys.BuildStudentKey(
					config.AsPHPString(data["student_id"]),
					config.AsPHPString(data["student_name"]),
					sGrade.String,
					sSubject.String,
				)
			}
			data["retest_token"] = normalize.DeriveRetestToken(sSubject.String, sGrade.String, sKeyForToken, retestSecret)
		}
	}

	if validTbl == "qbank_questions" && config.AsPHPInt(data["qbank_id"]) > 0 {
		if qRows, err := r.db.QueryContext(ctx,
			"SELECT `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week` FROM `qbank_weeks` WHERE `id` = ? LIMIT 1",
			config.AsPHPInt(data["qbank_id"]),
		); err == nil {
			if list, err := scanDynamicRows(qRows); err == nil && len(list) > 0 {
				pw := list[0]
				for _, k := range []string{"bank_type", "year", "season", "subject", "grade", "tier", "week"} {
					if v, exists := data[k]; !exists || v == nil || config.AsPHPString(v) == "" {
						data[k] = pw[k]
					}
				}
			}
			_ = qRows.Close()
		}
	}

	var fields, phs []string
	var values []any
	for _, col := range cols {
		if col.Key == "PRI" && (col.Extra == "auto_increment" || config.AsPHPString(data[col.Name]) == "") {
			continue
		}
		if col.Name == "created_at" || col.Name == "updated_at" {
			if v, ok := data[col.Name]; ok && v != nil {
				fields = append(fields, fmt.Sprintf("`%s`", col.Name))
				phs = append(phs, "?")
				values = append(values, marshalIfComposite(v))
			}
			continue
		}
		if v, exists := data[col.Name]; exists {
			fields = append(fields, fmt.Sprintf("`%s`", col.Name))
			phs = append(phs, "?")
			values = append(values, marshalIfComposite(v))
		}
	}
	if len(fields) == 0 {
		return 0, NewHTTPError(400, "未提供有效的数据字段", nil)
	}

	insertSQL := fmt.Sprintf("INSERT INTO `%s` (%s) VALUES (%s)", validTbl, strings.Join(fields, ", "), strings.Join(phs, ", "))
	res, err := r.db.ExecContext(ctx, insertSQL, values...)
	if err != nil {
		return 0, NewHTTPError(500, "新增记录失败: "+err.Error(), nil)
	}
	newID, _ := res.LastInsertId()

	if validTbl == "qbank_questions" && config.AsPHPInt(data["qbank_id"]) > 0 {
		qid := config.AsPHPInt(data["qbank_id"])
		_, _ = r.db.ExecContext(ctx,
			"UPDATE `qbank_weeks` SET `question_count` = (SELECT COUNT(*) FROM `qbank_questions` WHERE `qbank_id` = ?), `updated_at` = NOW() WHERE `id` = ?",
			qid, qid,
		)
	}
	return newID, nil
}

// UpdateRecord mirrors PHP actions_crud.php action=db_update.
func (r *MySQLRepository) UpdateRecord(ctx context.Context, table, id string, input map[string]any, adminOp string) (int64, []string, error) {
	validTbl, err := r.validateTable(ctx, table)
	if err != nil {
		return 0, nil, err
	}
	cols, _, pk, err := r.getTableColumns(ctx, validTbl)
	if err != nil {
		return 0, nil, err
	}

	data := make(map[string]any, len(input))
	for k, v := range input {
		data[k] = v
	}
	delete(data, "table")
	delete(data, "id")

	if validTbl == "users" {
		var uname sql.NullString
		_ = r.db.QueryRowContext(ctx, fmt.Sprintf("SELECT username FROM `users` WHERE `%s` = ? LIMIT 1", pk), id).Scan(&uname)
		if uname.String == "0" {
			if config.AsPHPString(data["password"]) != "" || config.AsPHPString(data["password_hash"]) != "" || config.AsPHPString(data["initial_password"]) != "" {
				return 0, nil, NewHTTPError(403, "测试账号(0)为系统保留账号，禁止修改或重置密码", nil)
			}
		}
	}

	if validTbl == "admin_users" || validTbl == "users" {
		rawPwd := strings.TrimSpace(config.AsPHPString(data["password"]))
		if rawPwd == "" {
			rawPwd = strings.TrimSpace(config.AsPHPString(data["password_hash"]))
		}
		if rawPwd == "" || rawPwd == "●●●●●●●●" || strings.HasPrefix(rawPwd, "●") {
			delete(data, "password_hash")
			delete(data, "password")
		} else if !strings.HasPrefix(rawPwd, "$2y$") && !strings.HasPrefix(rawPwd, "$2a$") && !strings.HasPrefix(rawPwd, "$2b$") {
			if len(rawPwd) < 6 {
				return 0, nil, NewHTTPError(400, "登录密码长度不能少于 6 位", nil)
			}
			hash, err := bcrypt.GenerateFromPassword([]byte(rawPwd), bcrypt.DefaultCost)
			if err != nil {
				if errors.Is(err, bcrypt.ErrPasswordTooLong) {
					return 0, nil, NewHTTPError(400, "登录密码长度不能超过 72 字节", nil)
				}
				return 0, nil, err
			}
			data["password_hash"] = string(hash)
			if validTbl == "users" {
				data["initial_password"] = ""
			}
			delete(data, "password")
		}
	}

	if validTbl == "class_batches" {
		if rawSeason, ok := data["season"]; ok && rawSeason != nil {
			data["season"] = normalize.Season(config.AsPHPString(rawSeason), "zh")
		}
	}

	if validTbl == "student_records" {
		_, hasSID := data["student_id"]
		_, hasSName := data["student_name"]
		_, hasBatchID := data["batch_id"]
		if hasSID || hasSName || hasBatchID {
			var currSID, currSName sql.NullString
			var currBatchID int
			_ = r.db.QueryRowContext(ctx, "SELECT student_id, student_name, batch_id FROM student_records WHERE id = ? LIMIT 1", id).Scan(&currSID, &currSName, &currBatchID)
			sID := strings.TrimSpace(currSID.String)
			if hasSID {
				sID = strings.TrimSpace(config.AsPHPString(data["student_id"]))
			}
			sName := strings.TrimSpace(currSName.String)
			if hasSName {
				sName = strings.TrimSpace(config.AsPHPString(data["student_name"]))
			}
			sBatchID := currBatchID
			if v, ok := data["batch_id"]; ok && config.AsPHPInt(v) > 0 {
				sBatchID = config.AsPHPInt(v)
			}
			var sGrade, sSubject sql.NullString
			if sBatchID > 0 {
				_ = r.db.QueryRowContext(ctx, "SELECT grade, subject FROM class_batches WHERE id = ? LIMIT 1", sBatchID).Scan(&sGrade, &sSubject)
			}
			data["student_key"] = retestkeys.BuildStudentKey(sID, sName, sGrade.String, sSubject.String)
		}
		if rawEQ, ok := data["error_questions"]; ok && rawEQ != nil {
			eqJSON, eqCount := ParseErrorQuestions(rawEQ)
			data["error_questions"] = eqJSON
			if cnt, hasCnt := data["error_count"]; !hasCnt || cnt == nil {
				data["error_count"] = eqCount
			}
		}
		if rawPEQ, ok := data["preview_error_questions"]; ok {
			peqPtr, isNull := ParsePreviewErrorQuestions(rawPEQ)
			if isNull {
				data["preview_error_questions"] = nil
			} else {
				data["preview_error_questions"] = *peqPtr
			}
		}
	}

	if validTbl == "qbank_questions" {
		if qid, ok := data["qbank_id"]; ok && qid != nil {
			if qRows, err := r.db.QueryContext(ctx,
				"SELECT `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week` FROM `qbank_weeks` WHERE `id` = ? LIMIT 1",
				marshalIfComposite(qid),
			); err == nil {
				if list, err := scanDynamicRows(qRows); err == nil && len(list) > 0 {
					pw := list[0]
					for _, k := range []string{"bank_type", "year", "season", "subject", "grade", "tier", "week"} {
						data[k] = pw[k]
					}
				}
				_ = qRows.Close()
			}
		}
	}

	var setParts []string
	var values []any
	for _, col := range cols {
		if col.Key == "PRI" || col.Name == "created_at" {
			continue
		}
		if col.Name == "updated_at" {
			if v, exists := data["updated_at"]; !exists || v == nil {
				setParts = append(setParts, "`updated_at` = NOW()")
				continue
			}
		}
		if v, exists := data[col.Name]; exists {
			setParts = append(setParts, fmt.Sprintf("`%s` = ?", col.Name))
			values = append(values, marshalIfComposite(v))
		}
	}
	if len(setParts) == 0 {
		return 0, nil, NewHTTPError(400, "未提供任何修改字段", nil)
	}

	values = append(values, id)
	updateSQL := fmt.Sprintf("UPDATE `%s` SET %s WHERE `%s` = ?", validTbl, strings.Join(setParts, ", "), pk)

	var affected int64
	if validTbl == "student_records" {
		tx, txErr := r.db.BeginTx(ctx, nil)
		if txErr != nil {
			return 0, nil, NewHTTPError(500, "更新失败: "+txErr.Error(), nil)
		}
		defer func() { _ = tx.Rollback() }()
		archiveStudentRecordForAdminEditTx(ctx, tx, id, adminOp)
		res, err := tx.ExecContext(ctx, updateSQL, values...)
		if err != nil {
			return 0, nil, NewHTTPError(500, "更新失败: "+err.Error(), nil)
		}
		affected, _ = res.RowsAffected()
		if err := tx.Commit(); err != nil {
			return 0, nil, NewHTTPError(500, "更新失败: "+err.Error(), nil)
		}
	} else {
		res, err := r.db.ExecContext(ctx, updateSQL, values...)
		if err != nil {
			return 0, nil, NewHTTPError(500, "更新失败: "+err.Error(), nil)
		}
		affected, _ = res.RowsAffected()
	}

	if validTbl == "qbank_weeks" {
		if qRows, err := r.db.QueryContext(ctx,
			"SELECT `bank_type`, `year`, `season`, `subject`, `grade`, `tier`, `week` FROM `qbank_weeks` WHERE `id` = ? LIMIT 1",
			id,
		); err == nil {
			if list, err := scanDynamicRows(qRows); err == nil && len(list) > 0 {
				nw := list[0]
				bt := config.AsPHPString(nw["bank_type"])
				if bt == "" {
					bt = "homework"
				}
				_, _ = r.db.ExecContext(ctx,
					"UPDATE `qbank_questions` SET `bank_type` = ?, `year` = ?, `season` = ?, `subject` = ?, `grade` = ?, `tier` = ?, `week` = ?, `updated_at` = NOW() WHERE `qbank_id` = ?",
					bt, nw["year"], nw["season"], nw["subject"], nw["grade"], nw["tier"], nw["week"], id,
				)
			}
			_ = qRows.Close()
		}
	}

	fields := make([]string, 0, len(data))
	for k := range data {
		fields = append(fields, k)
	}
	sort.Strings(fields)
	return affected, fields, nil
}

func archiveStudentRecordForAdminEditTx(ctx context.Context, tx *sql.Tx, id, adminOp string) {
	qRows, err := tx.QueryContext(ctx, "SELECT * FROM `student_records` WHERE `id` = ? LIMIT 1", id)
	if err != nil {
		return
	}
	list, err := scanDynamicRows(qRows)
	_ = qRows.Close()
	if err != nil || len(list) == 0 {
		return
	}
	oldRec := list[0]
	var bCode, bCreatedBy sql.NullString
	_ = tx.QueryRowContext(ctx,
		"SELECT batch_code, created_by FROM `generation_batches` WHERE `class_id` = ? AND `week_num` = ? ORDER BY id DESC LIMIT 1",
		oldRec["batch_id"], oldRec["week_num"],
	).Scan(&bCode, &bCreatedBy)
	if adminOp == "" {
		adminOp = "admin"
	}
	_, _ = tx.ExecContext(ctx, `
		INSERT INTO student_record_history (
			record_id, batch_id, batch_code, student_id, student_name, student_key,
			week_num, preview_week_num, homework_score, preview_score, total_score, error_count,
			error_questions, preview_error_questions, teacher_comment, preview_comment, source_files, retest_token,
			created_by, operator, operation_type, record_created_at, record_updated_at, archived_at
		) VALUES (
			?, ?, ?, ?, ?, ?,
			?, ?, ?, ?, ?, ?,
			?, ?, ?, ?, ?, ?,
			?, ?, 'admin_edit', ?, ?, NOW()
		)`,
		oldRec["id"],
		oldRec["batch_id"],
		bCode.String,
		config.AsPHPString(oldRec["student_id"]),
		oldRec["student_name"],
		config.AsPHPString(oldRec["student_key"]),
		oldRec["week_num"],
		oldRec["preview_week_num"],
		oldRec["homework_score"],
		oldRec["preview_score"],
		oldRec["total_score"],
		oldRec["error_count"],
		oldRec["error_questions"],
		oldRec["preview_error_questions"],
		oldRec["teacher_comment"],
		oldRec["preview_comment"],
		oldRec["source_files"],
		oldRec["retest_token"],
		bCreatedBy.String,
		adminOp,
		oldRec["created_at"],
		oldRec["updated_at"],
	)
}

// DeleteRecords mirrors PHP actions_crud.php action=db_delete.
func (r *MySQLRepository) DeleteRecords(ctx context.Context, table string, ids []string, currentAdmin string, forceCascade bool) (int64, error) {
	validTbl, err := r.validateTable(ctx, table)
	if err != nil {
		return 0, err
	}
	_, _, pk, err := r.getTableColumns(ctx, validTbl)
	if err != nil {
		return 0, err
	}
	if len(ids) == 0 {
		return 0, NewHTTPError(400, "请指定要删除的记录 ID", nil)
	}

	args := make([]any, len(ids))
	for i, v := range ids {
		args[i] = v
	}
	inPH := placeholders(len(ids))

	if validTbl == "admin_users" {
		var adminCount int
		_ = r.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM `admin_users`").Scan(&adminCount)
		if adminCount <= len(ids) {
			return 0, NewHTTPError(400, "系统必须保留至少一个管理员账号，无法全部删除", nil)
		}
		qRows, err := r.db.QueryContext(ctx, fmt.Sprintf("SELECT username FROM `admin_users` WHERE `id` IN (%s)", inPH), args...)
		if err == nil {
			for qRows.Next() {
				var u string
				if err := qRows.Scan(&u); err == nil && u == currentAdmin {
					_ = qRows.Close()
					return 0, NewHTTPError(400, "无法删除当前正在登录的管理员账号", nil)
				}
			}
			_ = qRows.Close()
		}
	}

	if validTbl == "users" {
		var hasTestAcc int
		_ = r.db.QueryRowContext(ctx, fmt.Sprintf("SELECT COUNT(*) FROM `users` WHERE `id` IN (%s) AND `username` = '0'", inPH), args...).Scan(&hasTestAcc)
		if hasTestAcc > 0 {
			return 0, NewHTTPError(403, "测试账号(0)为系统公共过渡账号，禁止删除", nil)
		}
	}

	if validTbl == "class_batches" {
		var relatedCount int
		_ = r.db.QueryRowContext(ctx, fmt.Sprintf("SELECT COUNT(*) FROM `student_records` WHERE `batch_id` IN (%s)", inPH), args...).Scan(&relatedCount)
		if relatedCount > 0 && !forceCascade {
			return 0, NewHTTPError(
				409,
				fmt.Sprintf("所选班级期次关联了 %d 条学生学情记录，直接删除将触发外键级联清空。请先清理关联学情，或显式传入 force_cascade=true 确认级联删除", relatedCount),
				map[string]any{"related_student_records": relatedCount},
			)
		}
	}

	if validTbl == "qbank_weeks" {
		tx, err := r.db.BeginTx(ctx, nil)
		if err != nil {
			return 0, NewHTTPError(500, "删除失败", nil)
		}
		defer func() { _ = tx.Rollback() }()
		if _, err := tx.ExecContext(ctx, fmt.Sprintf("DELETE FROM `qbank_questions` WHERE `qbank_id` IN (%s)", inPH), args...); err != nil {
			return 0, NewHTTPError(500, "删除失败", nil)
		}
		res, err := tx.ExecContext(ctx, fmt.Sprintf("DELETE FROM `%s` WHERE `%s` IN (%s)", validTbl, pk, inPH), args...)
		if err != nil {
			return 0, NewHTTPError(500, "删除失败", nil)
		}
		deleted, _ := res.RowsAffected()
		if err := tx.Commit(); err != nil {
			return 0, NewHTTPError(500, "删除失败", nil)
		}
		return deleted, nil
	}

	var affectedQbankIDs []int
	if validTbl == "qbank_questions" {
		if qRows, err := r.db.QueryContext(ctx, fmt.Sprintf("SELECT DISTINCT `qbank_id` FROM `qbank_questions` WHERE `id` IN (%s)", inPH), args...); err == nil {
			for qRows.Next() {
				var qid sql.NullInt64
				if err := qRows.Scan(&qid); err == nil && qid.Valid && qid.Int64 > 0 {
					affectedQbankIDs = append(affectedQbankIDs, int(qid.Int64))
				}
			}
			_ = qRows.Close()
		}
	}

	res, err := r.db.ExecContext(ctx, fmt.Sprintf("DELETE FROM `%s` WHERE `%s` IN (%s)", validTbl, pk, inPH), args...)
	if err != nil {
		return 0, NewHTTPError(500, "删除失败", nil)
	}
	deleted, _ := res.RowsAffected()

	if validTbl == "qbank_questions" && len(affectedQbankIDs) > 0 {
		for _, wid := range affectedQbankIDs {
			_, _ = r.db.ExecContext(ctx,
				"UPDATE `qbank_weeks` SET `question_count` = (SELECT COUNT(*) FROM `qbank_questions` WHERE `qbank_id` = ?), `updated_at` = NOW() WHERE `id` = ?",
				wid, wid,
			)
		}
	}
	return deleted, nil
}

// ResetTeacherPassword mirrors PHP actions_crud.php action=db_reset_teacher_password.
func (r *MySQLRepository) ResetTeacherPassword(ctx context.Context, userID int, username, newPassword string) (ResetTeacherResult, error) {
	if err := r.requireDB(); err != nil {
		return ResetTeacherResult{}, err
	}
	var id int
	var uname, rname sql.NullString
	var err error
	if userID > 0 {
		err = r.db.QueryRowContext(ctx, "SELECT `id`, `username`, `real_name` FROM `users` WHERE `id` = ? LIMIT 1", userID).Scan(&id, &uname, &rname)
	} else {
		err = r.db.QueryRowContext(ctx, "SELECT `id`, `username`, `real_name` FROM `users` WHERE `username` = ? LIMIT 1", username).Scan(&id, &uname, &rname)
	}
	if err == sql.ErrNoRows {
		return ResetTeacherResult{}, NewHTTPError(404, "未找到指定教师账号", nil)
	}
	if err != nil {
		return ResetTeacherResult{}, err
	}
	if uname.String == "0" {
		return ResetTeacherResult{}, NewHTTPError(403, "测试账号(0)为系统公共过渡账号，禁止重置密码", nil)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		if errors.Is(err, bcrypt.ErrPasswordTooLong) {
			return ResetTeacherResult{}, NewHTTPError(400, "新密码长度不能超过 72 字节", nil)
		}
		return ResetTeacherResult{}, err
	}
	if _, err := r.db.ExecContext(ctx, "UPDATE `users` SET `password_hash` = ?, `initial_password` = '', `updated_at` = NOW() WHERE `id` = ?", string(hash), id); err != nil {
		return ResetTeacherResult{}, NewHTTPError(500, "重置密码写入失败，请稍后重试", nil)
	}
	return ResetTeacherResult{
		Username: uname.String,
		RealName: rname.String,
	}, nil
}

func marshalIfComposite(v any) any {
	switch x := v.(type) {
	case json.Number:
		if i, err := x.Int64(); err == nil {
			return i
		}
		if f, err := x.Float64(); err == nil {
			return f
		}
		return x.String()
	case map[string]any, []any, []string, []int:
		if b, err := json.Marshal(x); err == nil {
			return string(b)
		}
	}
	return v
}
