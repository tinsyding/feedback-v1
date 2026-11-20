package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"feedback-api/internal/config"
	"feedback-api/internal/handler"
	"feedback-api/internal/httpx"
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
	vc := vision.NewClient()

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", handler.Health)
	mux.HandleFunc("/api/public_config.php", handler.PublicConfig(loader))
	mux.HandleFunc("/api/calibrate_roi.php", handler.CalibrateROI(loader, vc))
	mux.HandleFunc("/api/identify.php", handler.Identify(loader, vc))

	srv := &http.Server{
		Addr:              listenAddr,
		Handler:           httpx.Middleware(mux),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      90 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("feedback-api listening on %s (root=%s)", listenAddr, feedbackRoot)
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
