package admin

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"feedback-api/internal/qbankattest"
)

type rbMockState struct {
	queries       []string
	execArgs      [][]driver.NamedValue
	failOnDelete  bool
	committed     bool
	rolledBack    bool
	variationRows [][]driver.Value
}

type rbMockDriver struct{ state *rbMockState }

func (d *rbMockDriver) Open(_ string) (driver.Conn, error) {
	return &rbMockConn{state: d.state}, nil
}

type rbMockConn struct{ state *rbMockState }

func (c *rbMockConn) Prepare(_ string) (driver.Stmt, error) {
	return &rbMockStmt{state: c.state}, nil
}
func (c *rbMockConn) PrepareContext(_ context.Context, _ string) (driver.Stmt, error) {
	return &rbMockStmt{state: c.state}, nil
}
func (c *rbMockConn) Close() error              { return nil }
func (c *rbMockConn) Begin() (driver.Tx, error) { return &rbMockTx{state: c.state}, nil }
func (c *rbMockConn) BeginTx(_ context.Context, _ driver.TxOptions) (driver.Tx, error) {
	return &rbMockTx{state: c.state}, nil
}
func (c *rbMockConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	c.state.queries = append(c.state.queries, query)
	c.state.execArgs = append(c.state.execArgs, args)
	if c.state.failOnDelete && strings.Contains(query, "DELETE FROM `qbank_questions`") {
		return nil, errors.New("simulated delete error")
	}
	return driver.RowsAffected(1), nil
}
func (c *rbMockConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	c.state.queries = append(c.state.queries, query)
	if strings.Contains(query, "SELECT `id`, `parent_question_num`, `parent_question_nums`, `topic` FROM `qbank_questions` WHERE `bank_type` = 'variation'") {
		return &rbMockRows{cols: []string{"id", "parent_question_num", "parent_question_nums", "topic"}, rows: c.state.variationRows}, nil
	}
	if strings.Contains(query, "SELECT `question_num`, `parent_question_num`") {
		return &rbMockRows{
			cols: []string{"question_num", "parent_question_num", "parent_question_nums", "sub_num", "topic", "video_url", "question_meta", "exercise_pdf", "exercise_name", "answer_pdf", "answer_name"},
			rows: [][]driver.Value{{int64(1), int64(1), "1", int64(1), "受力分析", "", "", "data/pdfs/pdf_var_rb.pdf", "v.pdf", "", ""}},
		}, nil
	}
	if strings.Contains(query, "SELECT `id` FROM `qbank_weeks`") {
		return &rbMockRows{cols: []string{"id"}, rows: [][]driver.Value{{int64(88)}}}, nil
	}
	return &rbMockRows{cols: []string{"id"}, rows: nil}, nil
}

type rbMockStmt struct{ state *rbMockState }

func (s *rbMockStmt) Close() error  { return nil }
func (s *rbMockStmt) NumInput() int { return -1 }
func (s *rbMockStmt) Exec(args []driver.Value) (driver.Result, error) {
	named := make([]driver.NamedValue, len(args))
	for i, v := range args {
		named[i] = driver.NamedValue{Ordinal: i + 1, Value: v}
	}
	return s.ExecContext(context.Background(), named)
}
func (s *rbMockStmt) ExecContext(_ context.Context, args []driver.NamedValue) (driver.Result, error) {
	s.state.execArgs = append(s.state.execArgs, args)
	return driver.RowsAffected(1), nil
}
func (s *rbMockStmt) Query([]driver.Value) (driver.Rows, error) { return nil, driver.ErrSkip }

type rbMockTx struct{ state *rbMockState }

func (t *rbMockTx) Commit() error {
	t.state.committed = true
	return nil
}
func (t *rbMockTx) Rollback() error {
	t.state.rolledBack = true
	return nil
}

type rbMockRows struct {
	cols []string
	rows [][]driver.Value
	idx  int
}

func (r *rbMockRows) Columns() []string { return r.cols }
func (r *rbMockRows) Close() error      { return nil }
func (r *rbMockRows) Next(dest []driver.Value) error {
	if r.idx >= len(r.rows) {
		return io.EOF
	}
	copy(dest, r.rows[r.idx])
	r.idx++
	return nil
}

type rbMockConnector struct{ state *rbMockState }

func (c *rbMockConnector) Connect(_ context.Context) (driver.Conn, error) {
	return &rbMockConn{state: c.state}, nil
}
func (c *rbMockConnector) Driver() driver.Driver { return &rbMockDriver{state: c.state} }

func TestRollbackQBankRevisionAndAnchorsProtection(t *testing.T) {
	t.Setenv("QBANK_ATTESTATION_PRIVATE_KEY", "")
	t.Setenv("QBANK_ATTESTATION_KEY_FILE", "")
	signer, err := qbankattest.LoadSigner("rollback-test-secret")
	if err != nil {
		t.Fatalf("LoadOrDeriveSigner: %v", err)
	}
	attest := qbankattest.NewMemoryStore(signer, t.TempDir())
	ctx := context.Background()

	scope := qbankattest.Scope{Year: 2026, Season: "spring", BankType: "weekly", Subject: "物理", Grade: "高一", Tier: "实验班", Week: 2}
	rev1, err := attest.RecordRevisionTx(ctx, nil, qbankattest.RecordRevisionInput{
		QBankID:  88,
		Action:   qbankattest.ActionCreate,
		Scope:    scope,
		Operator: "teacher1",
		Questions: []qbankattest.SnapshotQuestion{
			{QuestionNum: 1, Topic: "受力分析"},
			{QuestionNum: 2, Topic: "牛顿第二定律", ParentQuestionNums: []int{2, 5}},
		},
	})
	if err != nil {
		t.Fatalf("RecordRevisionTx: %v", err)
	}

	st := &rbMockState{}
	db := sql.OpenDB(&rbMockConnector{state: st})
	defer db.Close()

	repo := NewMySQLRepositoryWithAttest(db, attest)

	// Verify qbank_attestation_anchors is protected against admin CRUD mutations.
	for _, op := range []func() error{
		func() error { _, e := repo.CreateRecord(ctx, "qbank_attestation_anchors", map[string]any{}, "", "admin"); return e },
		func() error { _, _, e := repo.UpdateRecord(ctx, "qbank_attestation_anchors", "1", map[string]any{}, "boss"); return e },
		func() error { _, e := repo.DeleteRecords(ctx, "qbank_attestation_anchors", []string{"1"}, "boss", false); return e },
	} {
		var httpErr *HTTPError
		if err := op(); !errors.As(err, &httpErr) || httpErr.Status != http.StatusForbidden {
			t.Fatalf("expected 403 HTTPError for qbank_attestation_anchors mutation, got %v", err)
		}
	}

	res, err := repo.RollbackQBankRevision(ctx, rev1.ReceiptCode, "boss", "管理员", "127.0.0.1")
	if err != nil {
		t.Fatalf("RollbackQBankRevision: %v", err)
	}
	if !st.committed {
		t.Fatal("expected SQL transaction commit")
	}
	if res.TargetReceiptCode != rev1.ReceiptCode || res.RestoredCount != 2 || res.NewRevisionNo != 2 {
		t.Fatalf("unexpected rollback result: %+v", res)
	}
	foundCSVParentNums := false
	for _, args := range st.execArgs {
		for _, a := range args {
			if s, ok := a.Value.(string); ok {
				if s == "[2,5]" {
					t.Fatalf("parent_question_nums must be CSV, not JSON array: %q", s)
				}
				if s == "2,5" {
					foundCSVParentNums = true
				}
			}
		}
	}
	if !foundCSVParentNums {
		t.Fatalf("expected CSV parent_question_nums '2,5' in rollback INSERT args, got %+v", st.execArgs)
	}

	// Verify a new admin_rollback revision was appended in attest store.
	vr, err := attest.VerifyReceipt(ctx, res.NewReceiptCode)
	if err != nil {
		t.Fatalf("VerifyReceipt: %v", err)
	}
	if vr.Status != qbankattest.StatusValid || vr.Receipt.Action != qbankattest.ActionAdminRollback {
		t.Fatalf("expected VALID admin_rollback receipt, got status=%s action=%s", vr.Status, vr.Receipt.Action)
	}

	// Verify SQL rollback on failure.
	stFail := &rbMockState{failOnDelete: true}
	dbFail := sql.OpenDB(&rbMockConnector{state: stFail})
	defer dbFail.Close()
	repoFail := NewMySQLRepositoryWithAttest(dbFail, attest)
	if _, err := repoFail.RollbackQBankRevision(ctx, rev1.ReceiptCode, "boss", "管理员", "127.0.0.1"); err == nil {
		t.Fatal("expected RollbackQBankRevision failure")
	}
	if !stFail.rolledBack || stFail.committed {
		t.Fatalf("expected tx rollback without commit, got rolledBack=%v committed=%v", stFail.rolledBack, stFail.committed)
	}
}

func TestRollbackPDFCheckEmptyLockOrderMetaAndVariationCascade(t *testing.T) {
	t.Setenv("QBANK_ATTESTATION_PRIVATE_KEY", "")
	t.Setenv("QBANK_ATTESTATION_KEY_FILE", "")
	signer, err := qbankattest.LoadSigner("rollback-extra-secret")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	pdfDir := filepath.Join(root, "data", "pdfs")
	if err := os.MkdirAll(pdfDir, 0755); err != nil {
		t.Fatal(err)
	}
	attest := qbankattest.NewMemoryStore(signer, root)
	ctx := context.Background()

	scope := qbankattest.Scope{Year: 2026, Season: "spring", BankType: "homework", Subject: "物理", Grade: "高一", Tier: "实验班", Week: 2}
	pdfURL := "data/pdfs/pdf_rb_check.pdf"
	revPDF, err := attest.RecordRevisionTx(ctx, nil, qbankattest.RecordRevisionInput{
		QBankID:  88,
		Action:   qbankattest.ActionCreate,
		Scope:    scope,
		Operator: "teacher1",
		Questions: []qbankattest.SnapshotQuestion{
			{
				QuestionNum:  1,
				Topic:        "受力分析",
				ExercisePDF:  pdfURL,
				QuestionMeta: map[string]any{"mode": "region_crop", "note": "x < 5 & y > 0"},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	// 1. Missing referenced PDF on disk -> 409 Conflict before DB tx.
	stMissing := &rbMockState{}
	dbMissing := sql.OpenDB(&rbMockConnector{state: stMissing})
	defer dbMissing.Close()
	repoMissing := NewMySQLRepositoryWithAttest(dbMissing, attest)
	var httpErr *HTTPError
	err = func() error {
		_, e := repoMissing.RollbackQBankRevision(ctx, revPDF.ReceiptCode, "boss", "管理员", "127.0.0.1")
		return e
	}()
	if !errors.As(err, &httpErr) || httpErr.Status != http.StatusConflict {
		t.Fatalf("expected 409 HTTPError when snapshot PDF missing, got %v", err)
	}
	if len(stMissing.queries) != 0 {
		t.Fatalf("expected no SQL queries when PDF precheck fails, got %v", stMissing.queries)
	}

	// 2. When PDF exists on disk, rollback restores unescaped meta + cascades variation + attests variation.
	if err := os.WriteFile(filepath.Join(pdfDir, "pdf_rb_check.pdf"), []byte("%PDF-1.4"), 0644); err != nil {
		t.Fatal(err)
	}
	stOK := &rbMockState{
		variationRows: [][]driver.Value{
			{int64(901), int64(1), "1", "旧变式考点"},
		},
	}
	dbOK := sql.OpenDB(&rbMockConnector{state: stOK})
	defer dbOK.Close()
	repoOK := NewMySQLRepositoryWithAttest(dbOK, attest)
	resOK, err := repoOK.RollbackQBankRevision(ctx, revPDF.ReceiptCode, "boss", "管理员", "127.0.0.1")
	if err != nil {
		t.Fatalf("RollbackQBankRevision with existing PDF failed: %v", err)
	}
	if !stOK.committed {
		t.Fatal("expected tx commit")
	}
	// Check SetEscapeHTML(false) on QuestionMeta (no \u003c or \u0026).
	foundUnescapedMeta := false
	for _, args := range stOK.execArgs {
		for _, a := range args {
			if s, ok := a.Value.(string); ok && strings.Contains(s, "region_crop") {
				if strings.Contains(s, `\u003c`) || strings.Contains(s, `\u0026`) {
					t.Fatalf("expected MarshalMetaJSON with SetEscapeHTML(false), got %q", s)
				}
				foundUnescapedMeta = true
			}
		}
	}
	if !foundUnescapedMeta {
		t.Fatal("expected QuestionMeta in rollback INSERT args")
	}
	// Check variation attestation revision was recorded.
	varScope := qbankattest.RevisionFilter{BankType: "variation", Year: &scope.Year, Season: scope.Season, Subject: scope.Subject, Grade: scope.Grade, Tier: scope.Tier, Week: &scope.Week}
	varRevs, err := attest.ListRevisions(ctx, varScope)
	if err != nil || len(varRevs) != 1 || varRevs[0].Action != qbankattest.ActionUpdate {
		t.Fatalf("expected 1 variation update revision after homework rollback cascade, got %+v err=%v", varRevs, err)
	}
	if vr, err := attest.VerifyReceipt(ctx, resOK.NewReceiptCode); err != nil || vr.Status != qbankattest.StatusValid {
		t.Fatalf("expected VALID rollback receipt, got %+v err=%v", vr, err)
	}

	// 3. Empty-snapshot (delete) rollback locks qbank_weeks FOR UPDATE before DELETE qbank_questions, and VerifyReceipt returns DELETED.
	revEmpty, err := attest.RecordRevisionTx(ctx, nil, qbankattest.RecordRevisionInput{
		QBankID:   88,
		Action:    qbankattest.ActionDelete,
		Scope:     scope,
		Operator:  "teacher1",
		Questions: nil,
	})
	if err != nil {
		t.Fatal(err)
	}
	stEmpty := &rbMockState{}
	dbEmpty := sql.OpenDB(&rbMockConnector{state: stEmpty})
	defer dbEmpty.Close()
	repoEmpty := NewMySQLRepositoryWithAttest(dbEmpty, attest)
	resEmpty, err := repoEmpty.RollbackQBankRevision(ctx, revEmpty.ReceiptCode, "boss", "管理员", "127.0.0.1")
	if err != nil {
		t.Fatalf("empty rollback failed: %v", err)
	}
	if len(stEmpty.queries) < 2 || !strings.Contains(stEmpty.queries[0], "FOR UPDATE") || !strings.Contains(stEmpty.queries[1], "DELETE FROM `qbank_questions`") {
		t.Fatalf("expected qbank_weeks FOR UPDATE before DELETE qbank_questions, got %v", stEmpty.queries)
	}
	vrEmpty, err := attest.VerifyReceipt(ctx, resEmpty.NewReceiptCode)
	if err != nil || vrEmpty.Status != qbankattest.StatusDeleted {
		t.Fatalf("expected DELETED status for empty rollback receipt, got %+v err=%v", vrEmpty, err)
	}
}
