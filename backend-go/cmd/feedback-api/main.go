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

	"feedback-api/internal/admin"
	"feedback-api/internal/auditlog"
	"feedback-api/internal/auth"
	"feedback-api/internal/config"
	"feedback-api/internal/db"
	"feedback-api/internal/handler"
	"feedback-api/internal/httpx"
	"feedback-api/internal/qbank"
	"feedback-api/internal/qbankattest"
	"feedback-api/internal/ratelimit"
	"feedback-api/internal/retest"
	"feedback-api/internal/senderctrl"
	"feedback-api/internal/senderlogs"
	"feedback-api/internal/session"
	"feedback-api/internal/syslogs"
	"feedback-api/internal/tz"
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
	bootCfg := loader.Load()
	if len(bootCfg.ServerSenderTokens()) == 0 {
		if bootCfg.AllowDefaultSenderToken() {
			log.Printf("[SECURITY WARNING] SENDER_API_TOKEN / SENDER_API_TOKENS not configured; falling back to built-in DefaultSenderToken (configure SENDER_API_TOKEN or set ALLOW_DEFAULT_SENDER_TOKEN=false in production)")
		} else {
			log.Printf("info: SENDER_API_TOKEN not configured and ALLOW_DEFAULT_SENDER_TOKEN=false; sender endpoints will fail closed")
		}
	}
	retestSecret := strings.TrimSpace(bootCfg.Secrets.RetestSecret)
	if retestSecret == "" {
		retestSecret = strings.TrimSpace(bootCfg.RawString("retestSecret"))
	}
	if retestSecret == "default_fallback_secret_please_change" || retestSecret == "your-secret-key-template-placeholder" {
		retestSecret = ""
	}
	attestSigner, err := qbankattest.LoadSigner(retestSecret)
	if err != nil {
		log.Fatalf("load qbank attestation signer failed: %v", err)
	}
	if attestSigner.IsEphemeral() {
		log.Printf("[WARNING] qbank attestation using ephemeral Ed25519 key (kid=%s); configure QBANK_ATTESTATION_PRIVATE_KEY or retestSecret in production", attestSigner.Kid())
	} else {
		log.Printf("info: qbank attestation signer ready (kid=%s, issuer=%s)", attestSigner.Kid(), qbankattest.ResolveIssuer())
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

	rlStore := ratelimit.NewResilientStore(sqlDB)
	if sqlDB != nil {
		go func() {
			ticker := time.NewTicker(30 * time.Minute)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					cleanCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
					_, _ = rlStore.CleanupExpired(cleanCtx)
					cancel()
				}
			}
		}()
	}

	attestStore := qbankattest.NewMySQLStore(sqlDB, attestSigner, feedbackRoot)
	if sqlDB != nil {
		regCtx, regCancel := context.WithTimeout(ctx, 5*time.Second)
		if err := attestStore.EnsureKeyRegistered(regCtx); err != nil {
			log.Printf("warning: qbank attestation key registration failed: %v", err)
		}
		regCancel()
	}

	auditLogger := auditlog.NewDualLogger(sqlDB, feedbackRoot)
	authRepo := auth.NewMySQLRepository(sqlDB)
	qbankRepo := qbank.NewMySQLRepositoryWithAttest(sqlDB, attestStore)
	sysLogsRepo := syslogs.NewMySQLRepository(sqlDB, feedbackRoot)
	go func() {
		runOnce := func() {
			cleanCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			if _, err := sysLogsRepo.CleanupOld(cleanCtx, tz.Now(), syslogs.RetentionDays); err != nil && !errors.Is(err, context.Canceled) {
				log.Printf("warning: system_logs retention cleanup failed: %v", err)
			}
		}
		runOnce()
		ticker := time.NewTicker(6 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				runOnce()
			}
		}
	}()
	senderCtrlStore := senderctrl.NewStore(feedbackRoot, loader)
	senderLogsMgr := senderlogs.NewManager(feedbackRoot, senderCtrlStore)
	adminRepo := admin.NewMySQLRepositoryWithAttest(sqlDB, attestStore)
	retestRepo := retest.NewMySQLRepository(sqlDB)
	verifyLimiter := syslogs.NewIngestLimiter()

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", handler.Health)
	mux.HandleFunc("/.well-known/jwks.json", handler.QBankJWKS(attestStore, attestSigner))
	mux.HandleFunc("/api/v1/qbank/verify", handler.QBankVerify(handler.QBankVerifyDeps{
		Attest:  attestStore,
		Limiter: verifyLimiter,
	}))
	mux.HandleFunc("/api/v1/qbank/anchors", handler.QBankAnchors(handler.QBankVerifyDeps{
		Attest:  attestStore,
		Limiter: verifyLimiter,
	}))

	// Optional periodic Merkle + RFC 3161 TSA anchoring loop (default 24h; set ATTESTATION_ANCHOR_INTERVAL=off to disable).
	if rawInterval := strings.TrimSpace(os.Getenv("ATTESTATION_ANCHOR_INTERVAL")); !strings.EqualFold(rawInterval, "off") && !strings.EqualFold(rawInterval, "0") {
		interval := 24 * time.Hour
		if rawInterval != "" {
			if parsed, pErr := time.ParseDuration(rawInterval); pErr == nil && parsed > 0 {
				interval = parsed
			}
		}
		go func() {
			ticker := time.NewTicker(interval)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					ancCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
					if _, aErr := attestStore.AnchorUnanchoredRevisions(ancCtx, qbankattest.NewTSAClientFromEnv()); aErr != nil && !errors.Is(aErr, context.Canceled) {
						log.Printf("warning: periodic qbank merkle anchor failed: %v", aErr)
					}
					cancel()
				}
			}
		}()
	}
	mux.HandleFunc("/api/public_config.php", handler.PublicConfig(loader))
	mux.HandleFunc("/api/calibrate_roi.php", handler.CalibrateROI(loader, vc))
	mux.HandleFunc("/api/identify.php", handler.Identify(loader, vc))
	mux.HandleFunc("/api/upload_pdf.php", handler.UploadPDFWithAttest(feedbackRoot, sessStore, attestStore))
	mux.HandleFunc("/api/upload_capture.php", handler.UploadCapture(feedbackRoot, sessStore))
	mux.HandleFunc("/api/changelog.php", handler.Changelog(feedbackRoot, sessStore))
	mux.HandleFunc("/api/auth.php", handler.Auth(handler.AuthDeps{
		Repo:      authRepo,
		Sessions:  sessStore,
		RateLimit: rlStore,
		Audit:     auditLogger,
		DB:        sqlDB,
	}))
	mux.HandleFunc("/api/qbank.php", handler.QBank(handler.QBankDeps{
		Repo:         qbankRepo,
		Sessions:     sessStore,
		ConfigLoader: loader,
		Audit:        auditLogger,
		Attest:       attestStore,
		DB:           sqlDB,
		FeedbackRoot: feedbackRoot,
	}))
	mux.HandleFunc("/api/logs.php", handler.Logs(handler.LogsDeps{
		Repo:         sysLogsRepo,
		Sessions:     sessStore,
		ConfigLoader: loader,
		Audit:        auditLogger,
		SenderCtrl:   senderCtrlStore,
		SenderLogs:   senderLogsMgr,
		Limiter:      syslogs.NewIngestLimiter(),
	}))
	mux.HandleFunc("/api/admin.php", handler.Admin(handler.AdminDeps{
		Repo:         adminRepo,
		Sessions:     sessStore,
		RateLimit:    rlStore,
		ConfigLoader: loader,
		Audit:        auditLogger,
		Attest:       attestStore,
		FeedbackRoot: feedbackRoot,
	}))
	mux.HandleFunc("/api/retest.php", handler.Retest(handler.RetestDeps{
		Repo:         retestRepo,
		Sessions:     sessStore,
		RateLimit:    rlStore,
		ConfigLoader: loader,
		Audit:        auditLogger,
		DB:           sqlDB,
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
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 50*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("graceful shutdown error: %v", err)
	}
	bgCtx, bgCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer bgCancel()
	if err := handler.WaitBackgroundCleanups(bgCtx); err != nil {
		log.Printf("background cleanup wait interrupted: %v", err)
	}
}
