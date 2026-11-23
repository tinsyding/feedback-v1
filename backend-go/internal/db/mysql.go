package db

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"feedback-api/internal/config"

	"github.com/go-sql-driver/mysql"
)

// Open creates a pooled MySQL connection handle using mysql.Config (safe for special characters in passwords).
func Open(cfg config.DBConfig) (*sql.DB, error) {
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		loc = time.FixedZone("CST", 8*3600)
	}

	collation := "utf8mb4_unicode_ci"
	if cfg.Charset != "" && cfg.Charset != "utf8mb4" {
		collation = ""
	}

	mc := mysql.NewConfig()
	mc.User = cfg.Username
	mc.Passwd = cfg.Password
	mc.Net = "tcp"
	mc.Addr = fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	mc.DBName = cfg.DBName
	mc.Collation = collation
	mc.ParseTime = true
	mc.Loc = loc
	mc.Params = map[string]string{
		"time_zone": "'+08:00'",
	}
	mc.Timeout = 5 * time.Second
	mc.ReadTimeout = 10 * time.Second
	mc.WriteTimeout = 10 * time.Second

	sqlDB, err := sql.Open("mysql", mc.FormatDSN())
	if err != nil {
		return nil, err
	}
	sqlDB.SetMaxOpenConns(20)
	sqlDB.SetMaxIdleConns(5)
	sqlDB.SetConnMaxLifetime(5 * time.Minute)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := sqlDB.PingContext(ctx); err != nil {
		return sqlDB, err
	}
	return sqlDB, nil
}
