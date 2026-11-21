package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"feedback-api/internal/auditlog"
	"feedback-api/internal/auth"
	"feedback-api/internal/config"
	"feedback-api/internal/db"
	"feedback-api/internal/handler"
	"feedback-api/internal/httpx"
	"feedback-api/internal/qbank"
	"feedback-api/internal/ratelimit"
	"feedback-api/internal/session"
	"feedback-api/internal/vision"
)

func main() {
	if err := config.LoadEnvFileFromEnv(); err != nil {
		log.Fatalf("load FEEDBACK_ENV_FILE failed: %v", err)
	}

	listenFlag := flag.String("listen", "", "HTTP listen address (default: FEEDBACK_LISTEN_ADDR or 127.0.0.1:8090)")
	rootFlag := flag.String("root", "", "Path to feedback-v1 root (default: FEEDBACK_ROOT)")
	flag.Parse()

	listenAddr := strings.TrimSpace(*listenFlag)
	if listenAddr == "" {
		listenAddr = strings.TrimSpace(os.Getenv("FEEDBACK_LISTEN_ADDR"))
	}
	if listenAddr == "" {
		listenAddr = "127.0.0.1:8090"
	}

	feedbackRoot := config.ResolveFeedbackRoot(strings.TrimSpace(*rootFlag))
	loader := config.NewLoader(feedbackRoot, "")
	if bootCfg := loader.Load(); len(bootCfg.ServerSenderTokens()) == 0 {
		if bootCfg.AllowDefaultSenderToken() {
			log.Printf("[SECURITY WARNING] SENDER_API_TOKEN / SENDER_API_TOKENS not configured; falling back to built-in DefaultSenderToken (configure SENDER_API_TOKEN or set ALLOW_DEFAULT_SENDER_TOKEN=false in production)")
		} else {
			log.Printf("info: SENDER_API_TOKEN not configured and ALLOW_DEFAULT_SENDER_TOKEN=false; sender endpoints will fail closed")
		}
	}
	vc := vision.NewClient()

	var sqlDB *sql.DB
	dbCfg := loader.LoadDBConfig()
	openedDB, dbErr := db.Open(dbCfg)
	if dbErr != nil {
		log.Printf("warning: MySQL connection not ready (%v); session-protected endpoints will fail closed until DB is reachable", dbErr)
	}
	if openedDB != nil {
		sqlDB = openedDB
		defer func() { _ = sqlDB.Close() }()
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	sessStore := session.NewMySQLStore(sqlDB)
	sessStore.StartCleanupLoop(ctx, 10*time.Minute)

	var rlStore ratelimit.Store
	if sqlDB != nil {
		rlMySQL := ratelimit.NewMySQLStore(sqlDB)
		rlStore = rlMySQL
		go func() {
			ticker := time.NewTicker(30 * time.Minute)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					cleanCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
					_, _ = rlMySQL.CleanupExpired(cleanCtx)
					cancel()
				}
			}
		}()
	} else {
		rlStore = ratelimit.NewMemoryStore()
	}

	auditLogger := auditlog.NewDualLogger(sqlDB, feedbackRoot)
	authRepo := auth.NewMySQLRepository(sqlDB)
	qbankRepo := qbank.NewMySQLRepository(sqlDB)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", handler.Health)
	mux.HandleFunc("/api/public_config.php", handler.PublicConfig(loader))
	mux.HandleFunc("/api/calibrate_roi.php", handler.CalibrateROI(loader, vc))
	mux.HandleFunc("/api/identify.php", handler.Identify(loader, vc))
	mux.HandleFunc("/api/upload_pdf.php", handler.UploadPDF(feedbackRoot, sessStore))
	mux.HandleFunc("/api/upload_capture.php", handler.UploadCapture(feedbackRoot, sessStore))
	mux.HandleFunc("/api/changelog.php", handler.Changelog(feedbackRoot, sessStore))
	mux.HandleFunc("/api/auth.php", handler.Auth(handler.AuthDeps{
		Repo:      authRepo,
		Sessions:  sessStore,
		RateLimit: rlStore,
		Audit:     auditLogger,
	}))
	mux.HandleFunc("/api/qbank.php", handler.QBank(handler.QBankDeps{
		Repo:         qbankRepo,
		Sessions:     sessStore,
		ConfigLoader: loader,
		Audit:        auditLogger,
		FeedbackRoot: feedbackRoot,
	}))

	srv := &http.Server{
		Addr:              listenAddr,
		Handler:           httpx.Middleware(mux),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       90 * time.Second,
		WriteTimeout:      120 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		log.Printf("feedback-api listening on %s (root=%s, db=%s:%d/%s)", listenAddr, feedbackRoot, dbCfg.Host, dbCfg.Port, dbCfg.DBName)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http server error: %v", err)
		}
	}()

	<-ctx.Done()
	log.Printf("shutting down feedback-api...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("graceful shutdown error: %v", err)
	}
}
