package admin

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"feedback-api/internal/config"
)

func (r *MySQLRepository) validTables(ctx context.Context) ([]string, error) {
	if err := r.requireDB(); err != nil {
		return nil, err
	}
	rows, err := r.db.QueryContext(ctx, "SHOW TABLES")
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		if name == "" || IsHiddenTable(name) {
			continue
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

func (r *MySQLRepository) validateTable(ctx context.Context, table string) (string, error) {
	if !IsValidIdentifier(table) {
		return "", NewHTTPError(400, "无效的数据表名称", nil)
	}
	if IsHiddenTable(table) {
		return "", NewHTTPError(403, fmt.Sprintf("系统表 '%s' 禁止通过通用后台接口访问", table), nil)
	}
	tables, err := r.validTables(ctx)
	if err != nil {
		return "", err
	}
	for _, t := range tables {
		if t == table {
			return table, nil
		}
	}
	return "", NewHTTPError(404, fmt.Sprintf("数据表 '%s' 不存在", table), nil)
}

func (r *MySQLRepository) getTableColumns(ctx context.Context, table string) ([]ColumnMeta, map[string]ColumnMeta, string, error) {
	rows, err := r.db.QueryContext(ctx, fmt.Sprintf("SHOW FULL COLUMNS FROM `%s`", table))
	if err != nil {
		return nil, nil, "", err
	}
	defer func() { _ = rows.Close() }()

	rawRows, err := scanDynamicRows(rows)
	if err != nil {
		return nil, nil, "", err
	}

	cols := make([]ColumnMeta, 0, len(rawRows))
	colMap := make(map[string]ColumnMeta, len(rawRows))
	pk := "id"
	pkFound := false
	for _, m := range rawRows {
		field := config.AsPHPString(m["Field"])
		var defPtr *string
		if m["Default"] != nil {
			s := config.AsPHPString(m["Default"])
			defPtr = &s
		}
		cm := ColumnMeta{
			Field:   field,
			Name:    field,
			Type:    config.AsPHPString(m["Type"]),
			Null:    strings.EqualFold(config.AsPHPString(m["Null"]), "YES"),
			Key:     config.AsPHPString(m["Key"]),
			Default: defPtr,
			Extra:   config.AsPHPString(m["Extra"]),
			Comment: config.AsPHPString(m["Comment"]),
		}
		cols = append(cols, cm)
		colMap[field] = cm
		if !pkFound && cm.Key == "PRI" {
			pk = field
			pkFound = true
		}
	}
	return cols, colMap, pk, nil
}

// ListTables mirrors PHP actions_tables.php action=db_tables.
func (r *MySQLRepository) ListTables(ctx context.Context) ([]TableSummary, error) {
	if err := r.requireDB(); err != nil {
		return nil, err
	}
	rows, err := r.db.QueryContext(ctx, "SHOW TABLE STATUS")
	if err != nil {
		return nil, err
	}
	statusRows, err := scanDynamicRows(rows)
	_ = rows.Close()
	if err != nil {
		return nil, err
	}

	tables := make([]TableSummary, 0, len(statusRows))
	for _, sr := range statusRows {
		name := config.AsPHPString(sr["Name"])
		if name == "" {
			name = config.AsPHPString(sr["name"])
		}
		if name == "" || IsHiddenTable(name) {
			continue
		}
		var exactCount int
		if name == "users" {
			_ = r.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM `users` WHERE (`role` != 'assistant' OR `role` IS NULL)").Scan(&exactCount)
		} else {
			_ = r.db.QueryRowContext(ctx, fmt.Sprintf("SELECT COUNT(*) FROM `%s`", name)).Scan(&exactCount)
		}
		rawComment := config.AsPHPString(sr["Comment"])
		friendly, ok := FriendlyTableNames[name]
		if !ok {
			if rawComment != "" {
				friendly = rawComment
			} else {
				friendly = name
			}
		}
		comment := rawComment
		if comment == "" {
			comment = friendly
		}
		var autoInc *int64
		if sr["Auto_increment"] != nil {
			v := int64(config.AsPHPInt(sr["Auto_increment"]))
			if v != 0 {
				autoInc = &v
			}
		}
		var updTime *string
		if sr["Update_time"] != nil {
			s := config.AsPHPString(sr["Update_time"])
			if s != "" {
				updTime = &s
			}
		} else if sr["Create_time"] != nil {
			s := config.AsPHPString(sr["Create_time"])
			if s != "" {
				updTime = &s
			}
		}

		tables = append(tables, TableSummary{
			Name:          name,
			FriendlyName:  friendly,
			Count:         exactCount,
			Rows:          exactCount,
			Comment:       comment,
			AvgRowLength:  int64(config.AsPHPInt(sr["Avg_row_length"])),
			DataLength:    int64(config.AsPHPInt(sr["Data_length"])),
			AutoIncrement: autoInc,
			UpdateTime:    updTime,
		})
	}
	return tables, nil
}

// GetTableSchema mirrors PHP actions_tables.php action=db_schema.
func (r *MySQLRepository) GetTableSchema(ctx context.Context, table string) (string, []ColumnMeta, error) {
	validTbl, err := r.validateTable(ctx, table)
	if err != nil {
		return "", nil, err
	}
	cols, _, pk, err := r.getTableColumns(ctx, validTbl)
	if err != nil {
		return "", nil, err
	}
	return pk, cols, nil
}

// ListBatchOptions mirrors PHP actions_tables.php action=db_batches_options.
func (r *MySQLRepository) ListBatchOptions(ctx context.Context) ([]BatchOption, error) {
	if err := r.requireDB(); err != nil {
		return nil, err
	}
	rows, err := r.db.QueryContext(ctx, "SELECT id, `year`, `season`, `grade`, `tier`, `subject`, `class_name` FROM `class_batches` ORDER BY id DESC")
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	rawRows, err := scanDynamicRows(rows)
	if err != nil {
		return nil, err
	}
	opts := make([]BatchOption, 0, len(rawRows))
	for _, b := range rawRows {
		id := config.AsPHPInt(b["id"])
		className := config.AsPHPString(b["class_name"])
		label := className
		if label == "" {
			label = fmt.Sprintf("%s%s %s%s %s",
				config.AsPHPString(b["year"]),
				config.AsPHPString(b["season"]),
				config.AsPHPString(b["grade"]),
				config.AsPHPString(b["tier"]),
				config.AsPHPString(b["subject"]),
			)
		}
		opts = append(opts, BatchOption{
			ID:    id,
			Label: fmt.Sprintf("#%d %s", id, label),
			Raw:   b,
		})
	}
	return opts, nil
}

// GetFilterOptions mirrors PHP actions_tables.php action=dimensions / db_filter_options.
func (r *MySQLRepository) GetFilterOptions(ctx context.Context) (FilterOptions, error) {
	if err := r.requireDB(); err != nil {
		return FilterOptions{}, err
	}
	out := FilterOptions{
		Grades:         []string{},
		Tiers:          []string{},
		Subjects:       []string{},
		LogLevels:      []string{},
		LogModules:     []string{},
		Teachers:       []TeacherOption{},
		ActiveTeachers: []string{},
	}
	queryDistinct := func(q string) []string {
		rows, err := r.db.QueryContext(ctx, q)
		if err != nil {
			return []string{}
		}
		defer func() { _ = rows.Close() }()
		res := []string{}
		for rows.Next() {
			var s sql.NullString
			if err := rows.Scan(&s); err == nil && s.Valid && s.String != "" {
				res = append(res, s.String)
			}
		}
		return res
	}

	out.Grades = queryDistinct("SELECT DISTINCT `grade` FROM `class_batches` WHERE `grade` IS NOT NULL AND `grade` != '' ORDER BY `grade`")
	out.Tiers = queryDistinct("SELECT DISTINCT `tier` FROM `class_batches` WHERE `tier` IS NOT NULL AND `tier` != '' ORDER BY `tier`")
	out.Subjects = queryDistinct("SELECT DISTINCT `subject` FROM `class_batches` WHERE `subject` IS NOT NULL AND `subject` != '' ORDER BY `subject`")
	out.LogLevels = queryDistinct("SELECT DISTINCT `level` FROM `system_logs` WHERE `level` IS NOT NULL AND `level` != '' ORDER BY `level`")
	out.LogModules = queryDistinct("SELECT DISTINCT `module` FROM `system_logs` WHERE `module` IS NOT NULL AND `module` != '' ORDER BY `module`")

	if tRows, err := r.db.QueryContext(ctx, "SELECT `username`, `real_name` FROM `users` WHERE `status` = 1 AND (`role` != 'assistant' OR `role` IS NULL) ORDER BY (username != '0'), username ASC"); err == nil {
		for tRows.Next() {
			var uname, rname sql.NullString
			if err := tRows.Scan(&uname, &rname); err == nil {
				out.Teachers = append(out.Teachers, TeacherOption{
					Username: uname.String,
					RealName: rname.String,
				})
			}
		}
		_ = tRows.Close()
	}
	out.ActiveTeachers = queryDistinct("SELECT DISTINCT `created_by` FROM `student_records` WHERE `created_by` IS NOT NULL AND `created_by` != ''")
	return out, nil
}

// GetStudentRecordsStats mirrors PHP actions_tables.php action=student_records_stats.
func (r *MySQLRepository) GetStudentRecordsStats(ctx context.Context) (StudentRecordsStats, error) {
	if err := r.requireDB(); err != nil {
		return StudentRecordsStats{}, err
	}
	var st StudentRecordsStats
	_ = r.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM `student_records`").Scan(&st.Total)
	_ = r.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM `student_records` WHERE `error_count` > 0").Scan(&st.HasErr)
	_ = r.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM `student_records` WHERE `error_count` = 0").Scan(&st.NoErr)
	_ = r.db.QueryRowContext(ctx, "SELECT COUNT(DISTINCT `batch_id`) FROM `student_records` WHERE `batch_id` IS NOT NULL AND `batch_id` > 0").Scan(&st.Batches)
	_ = r.db.QueryRowContext(ctx, "SELECT COUNT(DISTINCT `student_name`) FROM `student_records` WHERE `student_name` IS NOT NULL AND `student_name` != ''").Scan(&st.Students)
	return st, nil
}
