package db

import (
	"testing"

	"feedback-api/internal/config"
)

func TestOpenUnreachableAndCharsetConfig(t *testing.T) {
	// 1. Default utf8mb4 charset against unreachable local port returns non-nil *sql.DB and ping error
	sqlDB, err := Open(config.DBConfig{
		Host:     "127.0.0.1",
		Port:     1,
		DBName:   "feedback_test",
		Username: "root",
		Password: "p@ss:word/with?special#chars",
		Charset:  "utf8mb4",
	})
	if err == nil {
		if sqlDB != nil {
			_ = sqlDB.Close()
		}
		t.Fatal("expected ping error for unreachable port 127.0.0.1:1, got nil")
	}
	if sqlDB == nil {
		t.Fatalf("expected non-nil *sql.DB handle even when PingContext fails, got nil (err=%v)", err)
	}
	_ = sqlDB.Close()

	// 2. Custom non-utf8mb4 charset branch (clears collation)
	sqlDB2, err2 := Open(config.DBConfig{
		Host:     "127.0.0.1",
		Port:     1,
		DBName:   "feedback_test",
		Username: "root",
		Password: "",
		Charset:  "latin1",
	})
	if err2 == nil {
		if sqlDB2 != nil {
			_ = sqlDB2.Close()
		}
		t.Fatal("expected ping error for unreachable port 127.0.0.1:1 with custom charset, got nil")
	}
	if sqlDB2 == nil {
		t.Fatalf("expected non-nil *sql.DB handle for custom charset, got nil (err=%v)", err2)
	}
	_ = sqlDB2.Close()
}
