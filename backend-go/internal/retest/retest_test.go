package retest

import (
	"strings"
	"testing"
)

func TestResolveSubmissionStatus(t *testing.T) {
	zero := 0.0
	if got := ResolveSubmissionStatus("unsubmitted", []int{1}, &zero, "ok"); got != "unsubmitted" {
		t.Fatalf("explicit unsubmitted => %q", got)
	}
	if got := ResolveSubmissionStatus("exempt", nil, nil, ""); got != "exempt" {
		t.Fatalf("explicit exempt => %q", got)
	}
	if got := ResolveSubmissionStatus("submitted", nil, nil, "本次作业未交"); got != "unsubmitted" {
		t.Fatalf("comment keyword should override => %q", got)
	}
	if got := ResolveSubmissionStatus("", nil, &zero, ""); got != "submitted" {
		t.Fatalf("real 0 score should be submitted, got %q", got)
	}
	if got := ResolveSubmissionStatus("", nil, nil, ""); got != "unsubmitted" {
		t.Fatalf("all-empty legacy row should be unsubmitted, got %q", got)
	}
}

func TestBuildWeekPDFsGroupingAndVariations(t *testing.T) {
	rows := []QbankQuestionRow{
		{
			ID: 1, BankType: "homework", Tier: "U", Week: 1, QuestionNum: 1,
			Topic: "一元一次方程", VideoURL: "https://v/1", ExercisePDF: "data/pdfs/pdf_group12.pdf", AnswerPDF: "data/pdfs/pdf_ans12.pdf",
			QuestionMeta: `{"groupNums":[1,2]}`,
		},
		{
			ID: 2, BankType: "homework", Tier: "U", Week: 1, QuestionNum: 2,
			Topic: "移项法则", ExercisePDF: "data/pdfs/pdf_group12.pdf",
			QuestionMeta: `{"groupNums":[1,2]}`,
		},
		{
			ID: 3, BankType: "variation", Tier: "U", Week: 1, ParentQuestionNum: 1, ParentQuestionNums: "1,2", SubNum: 1,
			Topic: "举一反三1", ExercisePDF: "data/pdfs/pdf_var1.pdf", AnswerPDF: "data/pdfs/pdf_var1_ans.pdf",
		},
	}

	pdfs := BuildWeekPDFs(rows, "homework", "U", 1, []int{1, 2})
	if len(pdfs) != 2 {
		t.Fatalf("expected 2 items (1 merged group + 1 variation), got %d: %+v", len(pdfs), pdfs)
	}
	if pdfs[0]["topic"] != "[1] 一元一次方程 · [2] 移项法则" {
		t.Fatalf("unexpected merged topic: %v", pdfs[0]["topic"])
	}
	if pdfs[1]["isVariation"] != true {
		t.Fatalf("expected second item to be variation: %+v", pdfs[1])
	}
}

func TestGenerateSVGCaptcha(t *testing.T) {
	code, svg := GenerateSVGCaptcha()
	if len(code) != 4 {
		t.Fatalf("expected 4-char code, got %q", code)
	}
	if !strings.HasPrefix(svg, "<svg ") || !strings.HasSuffix(svg, "</svg>") {
		t.Fatalf("invalid svg markup: %s", svg)
	}
}
