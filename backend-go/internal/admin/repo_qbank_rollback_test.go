package admin

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"feedback-api/internal/qbankattest"
)

type rbMockState struct {
	queries      []string
	failOnDelete bool
	committed    bool
	rolledBack   bool
}

type rbMockDriver struct{ state *rbMockState }

func (d *rbMockDriver) Open(_ string) (driver.Conn, error) {
	return &rbMockConn{state: d.state}, nil
}

type rbMockConn struct{ state *rbMockState }

func (c *rbMockConn) Prepare(_ string) (driver.Stmt, error) { return nil, errors.New("unused") }
func (c *rbMockConn) Close() error                          { return nil }
func (c *rbMockConn) Begin() (driver.Tx, error)             { return &rbMockTx{state: c.state}, nil }
func (c *rbMockConn) BeginTx(_ context.Context, _ driver.TxOptions) (driver.Tx, error) {
	return &rbMockTx{state: c.state}, nil
}
func (c *rbMockConn) ExecContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	c.state.queries = append(c.state.queries, query)
	if c.state.failOnDelete && strings.Contains(query, "DELETE FROM `qbank_questions`") {
		return nil, errors.New("simulated delete error")
	}
	return driver.RowsAffected(1), nil
}
func (c *rbMockConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	c.state.queries = append(c.state.queries, query)
	if strings.Contains(query, "SELECT `id` FROM `qbank_weeks`") {
		return &rbMockRows{cols: []string{"id"}, rows: [][]driver.Value{{int64(88)}}}, nil
	}
	return &rbMockRows{cols: []string{"id"}, rows: nil}, nil
}

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
			{QuestionNum: 2, Topic: "牛顿第二定律"},
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
		func() error { _, e := repo.CreateRecord(ctx, "qbank_attestation_anchors", map[string]any{}, ""); return e },
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
