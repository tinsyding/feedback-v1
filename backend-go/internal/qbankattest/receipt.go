package qbankattest

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"feedback-api/internal/qbank"
	"feedback-api/internal/tz"
)

const (
	// SchemaV1 is the canonical payload and snapshot schema version.
	SchemaV1 = "jifang.qbank.attestation.v1"
	// DefaultIssuer is the default attestation issuer URL when ATTESTATION_ISSUER is unset.
	DefaultIssuer = "https://feedback.wxjifang.cn"

	// Revision action constants stored in qbank_revisions.action.
	ActionCreate      = "create"
	ActionUpdate      = "update"
	ActionTierSync    = "tier_sync"
	ActionDelete      = "delete"
	ActionAdminEdit   = "admin_edit"
	ActionAdminDelete = "admin_delete"

	// Attempt event_type constants stored in qbank_attempt_logs.event_type.
	EventUploadPDF     = "upload_pdf"
	EventSaveRejected  = "save_rejected"
	EventSaveError     = "save_error"
	EventSaveCancelled = "save_cancelled"
	EventClientBlocked = "client_blocked"

	// Receipt verification statuses returned by VerifyReceipt.
	StatusValid      = "VALID"
	StatusSuperseded = "SUPERSEDED"
	StatusDeleted    = "DELETED"
	StatusNotFound   = "NOT_FOUND"

	receiptCodeAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
	shortSHA256Len      = 12
)

// Scope identifies the 7-dimension question bank scope.
type Scope struct {
	BankType string `json:"bank_type"`
	Year     int    `json:"year"`
	Season   string `json:"season"`
	Subject  string `json:"subject"`
	Grade    string `json:"grade"`
	Tier     string `json:"tier"`
	Week     int    `json:"week"`
}

// OperatorInfo represents the teacher or admin who performed the attested operation.
type OperatorInfo struct {
	Username string `json:"username"`
	RealName string `json:"real_name"`
}

// TopicSummary contains the sanitized per-question summary embedded in CanonicalPayload (never contains PDF paths).
type TopicSummary struct {
	QNum                int    `json:"q_num"`
	Topic               string `json:"topic"`
	ExerciseSHA256Short string `json:"exercise_sha256_short"`
	AnswerSHA256Short   string `json:"answer_sha256_short"`
}

// PayloadSummary summarizes question and attachment coverage in CanonicalPayload.
type PayloadSummary struct {
	QuestionCount    int            `json:"question_count"`
	ExercisePDFCount int            `json:"exercise_pdf_count"`
	AnswerPDFCount   int            `json:"answer_pdf_count"`
	TopicFilledCount int            `json:"topic_filled_count"`
	Topics           []TopicSummary `json:"topics"`
}

// CanonicalPayload is the exact JSON object serialized without indentation/HTML-escaping and signed with Ed25519.
type CanonicalPayload struct {
	Schema        string         `json:"schema"`
	ReceiptCode   string         `json:"receipt_code"`
	Action        string         `json:"action"`
	IssuedAt      string         `json:"issued_at"`
	Issuer        string         `json:"issuer"`
	Scope         Scope          `json:"scope"`
	RevisionNo    int            `json:"revision_no"`
	Supersedes    string         `json:"supersedes"`
	Operator      OperatorInfo   `json:"operator"`
	Summary       PayloadSummary `json:"summary"`
	ContentSHA256 string         `json:"content_sha256"`
	PrevEntryHash string         `json:"prev_entry_hash"`
}

// Receipt is the full signed attestation receipt returned to clients and public verification endpoints.
// It intentionally excludes snapshot_json and never exposes internal data/pdfs/pdf_*.pdf paths.
type Receipt struct {
	Schema           string         `json:"schema"`
	ReceiptCode      string         `json:"receipt_code"`
	Action           string         `json:"action"`
	IssuedAt         string         `json:"issued_at"`
	IssuedAtCST      string         `json:"issued_at_cst"`
	Issuer           string         `json:"issuer"`
	Scope            Scope          `json:"scope"`
	RevisionNo       int            `json:"revision_no"`
	Supersedes       string         `json:"supersedes"`
	Operator         OperatorInfo   `json:"operator"`
	Summary          PayloadSummary `json:"summary"`
	ContentSHA256    string         `json:"content_sha256"`
	PrevEntryHash    string         `json:"prev_entry_hash"`
	EntryHash        string         `json:"entry_hash"`
	Kid              string         `json:"kid"`
	Signature        string         `json:"signature"`
	CanonicalPayload string         `json:"canonical_payload"`
	VerifyURL        string         `json:"verify_url"`
}

// SnapshotQuestion represents a normalized question entry stored in qbank_revisions.snapshot_json.
type SnapshotQuestion struct {
	QuestionNum        int            `json:"question_num"`
	ParentQuestionNum  *int           `json:"parent_question_num,omitempty"`
	ParentQuestionNums []int          `json:"parent_question_nums,omitempty"`
	SubNum             int            `json:"sub_num"`
	Topic              string         `json:"topic"`
	VideoURL           string         `json:"video_url"`
	QuestionMeta       map[string]any `json:"question_meta,omitempty"`
	ExercisePDF        string         `json:"exercise_pdf"`
	ExerciseName       string         `json:"exercise_name"`
	ExerciseSHA256     string         `json:"exercise_sha256"`
	ExerciseSize       int64          `json:"exercise_size,omitempty"`
	AnswerPDF          string         `json:"answer_pdf"`
	AnswerName         string         `json:"answer_name"`
	AnswerSHA256       string         `json:"answer_sha256"`
	AnswerSize         int64          `json:"answer_size,omitempty"`
}

// Snapshot represents the canonical question bank snapshot stored in qbank_revisions.snapshot_json.
type Snapshot struct {
	Schema    string             `json:"schema"`
	Scope     Scope              `json:"scope"`
	Questions []SnapshotQuestion `json:"questions"`
}

// SnapshotBuildResult contains the canonical Snapshot, its UTF-8 JSON, SHA-256 digest, and sanitized summary.
type SnapshotBuildResult struct {
	Snapshot      Snapshot
	SnapshotJSON  string
	ContentSHA256 string
	Summary       PayloadSummary
}

// ResolveIssuer returns ATTESTATION_ISSUER from environment or DefaultIssuer.
func ResolveIssuer() string {
	if v := strings.TrimSpace(os.Getenv("ATTESTATION_ISSUER")); v != "" {
		return strings.TrimRight(v, "/")
	}
	return DefaultIssuer
}

// BuildVerifyURL constructs the public verification page link for a receipt code.
func BuildVerifyURL(issuer, receiptCode string) string {
	base := strings.TrimRight(strings.TrimSpace(issuer), "/")
	if base == "" {
		base = DefaultIssuer
	}
	return base + "/verify-qbank.html?code=" + url.QueryEscape(strings.TrimSpace(receiptCode))
}

// ShortSHA256 returns the first 12 lowercase hex characters of a SHA-256 digest, or empty when empty.
func ShortSHA256(full string) string {
	s := strings.TrimSpace(full)
	if len(s) > shortSHA256Len {
		return s[:shortSHA256Len]
	}
	return s
}

// SHA256Hex computes the lowercase hex SHA-256 digest of data.
func SHA256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// ComputeFileSHA256 validates relURL as data/pdfs/pdf_*.pdf under feedbackRoot and computes its SHA-256 and byte size.
// If feedbackRoot/relURL is invalid or the file cannot be read, it returns ("", 0) without error.
func ComputeFileSHA256(feedbackRoot, relURL string) (string, int64) {
	root := strings.TrimSpace(feedbackRoot)
	if root == "" {
		return "", 0
	}
	fileName, ok := qbank.IsValidManagedPDFPath(relURL)
	if !ok || fileName == "" || strings.Contains(fileName, "..") || filepath.Base(fileName) != fileName {
		return "", 0
	}

	fullPath := filepath.Join(root, "data", "pdfs", fileName)
	info, err := os.Stat(fullPath)
	if err != nil || info.IsDir() {
		return "", 0
	}
	f, err := os.Open(fullPath)
	if err != nil {
		return "", 0
	}
	defer func() { _ = f.Close() }()

	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0
	}
	return hex.EncodeToString(h.Sum(nil)), n
}

// NormalizeScope trims and canonicalizes a 7-dimension Scope.
func NormalizeScope(s Scope) Scope {
	return Scope{
		BankType: qbank.NormalizeBankType(s.BankType),
		Year:     s.Year,
		Season:   strings.TrimSpace(s.Season),
		Subject:  strings.TrimSpace(s.Subject),
		Grade:    strings.TrimSpace(s.Grade),
		Tier:     strings.TrimSpace(s.Tier),
		Week:     s.Week,
	}
}

// SnapshotQuestionsFromSaveInputs converts qbank.SaveQuestionInput slices into SnapshotQuestion slices.
func SnapshotQuestionsFromSaveInputs(inputs []qbank.SaveQuestionInput) []SnapshotQuestion {
	out := make([]SnapshotQuestion, 0, len(inputs))
	for _, in := range inputs {
		if in.QuestionNum <= 0 {
			continue
		}
		var parentNums []int
		if in.ParentNumsStr != nil || in.ParentQuestionNum != nil {
			var pAny any
			if in.ParentQuestionNum != nil {
				pAny = *in.ParentQuestionNum
			}
			var listAny any
			if in.ParentNumsStr != nil {
				listAny = *in.ParentNumsStr
			}
			_, parentNums = qbank.ParseParentNums(pAny, listAny)
		}
		var parentPtr *int
		if in.ParentQuestionNum != nil {
			v := *in.ParentQuestionNum
			parentPtr = &v
		}
		var meta map[string]any
		if in.MetaJSON != nil && strings.TrimSpace(*in.MetaJSON) != "" {
			meta = qbank.SanitizeQuestionMeta(*in.MetaJSON)
		}
		out = append(out, SnapshotQuestion{
			QuestionNum:        in.QuestionNum,
			ParentQuestionNum:  parentPtr,
			ParentQuestionNums: parentNums,
			SubNum:             in.SubNum,
			Topic:              in.Topic,
			VideoURL:           in.VideoURL,
			QuestionMeta:       meta,
			ExercisePDF:        in.ExerciseURL,
			ExerciseName:       in.ExerciseName,
			AnswerPDF:          in.AnswerURL,
			AnswerName:         in.AnswerName,
		})
	}
	return out
}

// SnapshotQuestionsFromWeekDetail converts qbank.QuestionItem slices into SnapshotQuestion slices.
func SnapshotQuestionsFromWeekDetail(items []qbank.QuestionItem) []SnapshotQuestion {
	out := make([]SnapshotQuestion, 0, len(items))
	for _, item := range items {
		if item.ID <= 0 {
			continue
		}
		var parentPtr *int
		if item.ParentQuestionNum != nil {
			v := *item.ParentQuestionNum
			parentPtr = &v
		}
		var parentNums []int
		if len(item.ParentQuestionNums) > 0 {
			parentNums = make([]int, len(item.ParentQuestionNums))
			copy(parentNums, item.ParentQuestionNums)
		}
		var meta map[string]any
		if len(item.QuestionMeta) > 0 {
			meta = qbank.SanitizeQuestionMeta(item.QuestionMeta)
		}
		out = append(out, SnapshotQuestion{
			QuestionNum:        item.ID,
			ParentQuestionNum:  parentPtr,
			ParentQuestionNums: parentNums,
			SubNum:             item.SubNum,
			Topic:              item.Topic,
			VideoURL:           item.VideoURL,
			QuestionMeta:       meta,
			ExercisePDF:        item.ExercisePDF.URL,
			ExerciseName:       item.ExercisePDF.Name,
			AnswerPDF:          item.AnswerPDF.URL,
			AnswerName:         item.AnswerPDF.Name,
		})
	}
	return out
}

// BuildSnapshot normalizes questions, computes PDF SHA-256 digests under feedbackRoot,
// serializes canonical snapshot_json, and computes content_sha256 and sanitized summary.
func BuildSnapshot(feedbackRoot string, scope Scope, questions []SnapshotQuestion) (SnapshotBuildResult, error) {
	normScope := NormalizeScope(scope)
	normQuestions := make([]SnapshotQuestion, 0, len(questions))
	for _, q := range questions {
		if q.QuestionNum <= 0 {
			continue
		}
		nq := normalizeSnapshotQuestion(feedbackRoot, q)
		normQuestions = append(normQuestions, nq)
	}
	sort.Slice(normQuestions, func(i, j int) bool {
		return normQuestions[i].QuestionNum < normQuestions[j].QuestionNum
	})

	topics := make([]TopicSummary, 0, len(normQuestions))
	exCount := 0
	ansCount := 0
	topicCount := 0

	for _, q := range normQuestions {
		if q.ExercisePDF != "" || q.ExerciseSHA256 != "" {
			exCount++
		}
		if q.AnswerPDF != "" || q.AnswerSHA256 != "" {
			ansCount++
		}
		if strings.TrimSpace(q.Topic) != "" {
			topicCount++
		}
		topics = append(topics, TopicSummary{
			QNum:                q.QuestionNum,
			Topic:               q.Topic,
			ExerciseSHA256Short: ShortSHA256(q.ExerciseSHA256),
			AnswerSHA256Short:   ShortSHA256(q.AnswerSHA256),
		})
	}

	snap := Snapshot{
		Schema:    SchemaV1,
		Scope:     normScope,
		Questions: normQuestions,
	}
	snapBytes, err := MarshalCanonicalJSON(snap)
	if err != nil {
		return SnapshotBuildResult{}, fmt.Errorf("marshal snapshot_json: %w", err)
	}

	return SnapshotBuildResult{
		Snapshot:      snap,
		SnapshotJSON:  string(snapBytes),
		ContentSHA256: SHA256Hex(snapBytes),
		Summary: PayloadSummary{
			QuestionCount:    len(normQuestions),
			ExercisePDFCount: exCount,
			AnswerPDFCount:   ansCount,
			TopicFilledCount: topicCount,
			Topics:           topics,
		},
	}, nil
}

func normalizeSnapshotQuestion(feedbackRoot string, q SnapshotQuestion) SnapshotQuestion {
	subNum := q.SubNum
	if subNum <= 0 {
		subNum = 1
	}

	var parentPtr *int
	if q.ParentQuestionNum != nil {
		v := *q.ParentQuestionNum
		parentPtr = &v
	}

	var parentNums []int
	if len(q.ParentQuestionNums) > 0 {
		seen := make(map[int]struct{}, len(q.ParentQuestionNums))
		parentNums = make([]int, 0, len(q.ParentQuestionNums))
		for _, n := range q.ParentQuestionNums {
			if n > 0 {
				if _, ok := seen[n]; !ok {
					seen[n] = struct{}{}
					parentNums = append(parentNums, n)
				}
			}
		}
		sort.Ints(parentNums)
		if len(parentNums) == 0 {
			parentNums = nil
		}
	}

	var meta map[string]any
	if len(q.QuestionMeta) > 0 {
		meta = qbank.SanitizeQuestionMeta(q.QuestionMeta)
	}

	exURL := strings.TrimSpace(q.ExercisePDF)
	exSHA := strings.ToLower(strings.TrimSpace(q.ExerciseSHA256))
	exSize := q.ExerciseSize
	if exURL != "" && feedbackRoot != "" {
		if diskSHA, diskSize := ComputeFileSHA256(feedbackRoot, exURL); diskSHA != "" {
			exSHA = diskSHA
			exSize = diskSize
		}
	}
	if exURL == "" {
		exSHA = ""
		exSize = 0
	}

	ansURL := strings.TrimSpace(q.AnswerPDF)
	ansSHA := strings.ToLower(strings.TrimSpace(q.AnswerSHA256))
	ansSize := q.AnswerSize
	if ansURL != "" && feedbackRoot != "" {
		if diskSHA, diskSize := ComputeFileSHA256(feedbackRoot, ansURL); diskSHA != "" {
			ansSHA = diskSHA
			ansSize = diskSize
		}
	}
	if ansURL == "" {
		ansSHA = ""
		ansSize = 0
	}

	return SnapshotQuestion{
		QuestionNum:        q.QuestionNum,
		ParentQuestionNum:  parentPtr,
		ParentQuestionNums: parentNums,
		SubNum:             subNum,
		Topic:              qbank.CleanTopic(q.Topic),
		VideoURL:           strings.TrimSpace(q.VideoURL),
		QuestionMeta:       meta,
		ExercisePDF:        exURL,
		ExerciseName:       strings.TrimSpace(q.ExerciseName),
		ExerciseSHA256:     exSHA,
		ExerciseSize:       exSize,
		AnswerPDF:          ansURL,
		AnswerName:         strings.TrimSpace(q.AnswerName),
		AnswerSHA256:       ansSHA,
		AnswerSize:         ansSize,
	}
}

// MarshalCanonicalJSON encodes v as compact single-line UTF-8 JSON with SetEscapeHTML(false) and no trailing newline.
func MarshalCanonicalJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// MarshalCanonicalPayload serializes CanonicalPayload into the exact signed UTF-8 JSON string.
func MarshalCanonicalPayload(p CanonicalPayload) (string, error) {
	if p.Schema == "" {
		p.Schema = SchemaV1
	}
	if p.Summary.Topics == nil {
		p.Summary.Topics = []TopicSummary{}
	}
	b, err := MarshalCanonicalJSON(p)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// ParseCanonicalPayload decodes a stored canonical_payload JSON string.
func ParseCanonicalPayload(raw string) (*CanonicalPayload, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil, errors.New("empty canonical_payload")
	}
	var p CanonicalPayload
	if err := json.Unmarshal([]byte(s), &p); err != nil {
		return nil, err
	}
	if p.Summary.Topics == nil {
		p.Summary.Topics = []TopicSummary{}
	}
	return &p, nil
}

// ComputeEntryHash computes SHA256(prevEntryHash + "\n" + receiptCode + "\n" + contentSHA256 + "\n" + issuedAtUTC).
func ComputeEntryHash(prevEntryHash, receiptCode, contentSHA256, issuedAtUTC string) string {
	raw := prevEntryHash + "\n" + receiptCode + "\n" + contentSHA256 + "\n" + issuedAtUTC
	return SHA256Hex([]byte(raw))
}

// GenerateReceiptCode generates a unique-format receipt code `QB-YYYYMMDD-XXXXXX-XXXX`.
func GenerateReceiptCode(now time.Time) (string, error) {
	if now.IsZero() {
		now = tz.Now()
	}
	datePart := tz.In(now).Format("20060102")
	partA, err := randomCodeChars(6)
	if err != nil {
		return "", err
	}
	partB, err := randomCodeChars(4)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("QB-%s-%s-%s", datePart, partA, partB), nil
}

func randomCodeChars(n int) (string, error) {
	if n <= 0 {
		return "", nil
	}
	max := big.NewInt(int64(len(receiptCodeAlphabet)))
	var b strings.Builder
	b.Grow(n)
	for i := 0; i < n; i++ {
		idx, err := rand.Int(rand.Reader, max)
		if err != nil {
			return "", err
		}
		b.WriteByte(receiptCodeAlphabet[idx.Int64()])
	}
	return b.String(), nil
}

// FormatIssuedAtCST parses an RFC3339 UTC timestamp string and formats it in Asia/Shanghai ("2006-01-02 15:04:05").
func FormatIssuedAtCST(issuedAtUTC string) string {
	s := strings.TrimSpace(issuedAtUTC)
	if s == "" {
		return ""
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		t, err = time.Parse(time.RFC3339, s)
	}
	if err != nil {
		return s
	}
	return tz.In(t).Format("2006-01-02 15:04:05")
}

// DiffSnapshots compares two serialized snapshot_json strings and returns human-readable diff lines
// without exposing internal data/pdfs/pdf_*.pdf paths.
func DiffSnapshots(prevJSON, nextJSON string) []string {
	var prevSnap, nextSnap Snapshot
	if strings.TrimSpace(prevJSON) != "" {
		if err := json.Unmarshal([]byte(prevJSON), &prevSnap); err != nil {
			return []string{"无法解析上一版本快照进行比对"}
		}
	}
	if strings.TrimSpace(nextJSON) != "" {
		if err := json.Unmarshal([]byte(nextJSON), &nextSnap); err != nil {
			return []string{"无法解析新版本快照进行比对"}
		}
	}
	return DiffSnapshotStructs(&prevSnap, &nextSnap)
}

// DiffSnapshotStructs compares two Snapshot structs and produces human-readable Chinese diff lines
// without exposing any internal file paths.
func DiffSnapshotStructs(prev, next *Snapshot) []string {
	var prevQs, nextQs []SnapshotQuestion
	if prev != nil {
		prevQs = prev.Questions
	}
	if next != nil {
		nextQs = next.Questions
	}

	if len(prevQs) > 0 && len(nextQs) == 0 {
		return []string{fmt.Sprintf("已删除该专题全部 %d 道题目配置", len(prevQs))}
	}

	prevMap := make(map[int]SnapshotQuestion, len(prevQs))
	nextMap := make(map[int]SnapshotQuestion, len(nextQs))
	numSet := make(map[int]struct{}, len(prevQs)+len(nextQs))
	for _, q := range prevQs {
		prevMap[q.QuestionNum] = q
		numSet[q.QuestionNum] = struct{}{}
	}
	for _, q := range nextQs {
		nextMap[q.QuestionNum] = q
		numSet[q.QuestionNum] = struct{}{}
	}

	nums := make([]int, 0, len(numSet))
	for n := range numSet {
		nums = append(nums, n)
	}
	sort.Ints(nums)

	diffs := make([]string, 0)
	for _, n := range nums {
		pq, inPrev := prevMap[n]
		nq, inNext := nextMap[n]
		if !inPrev && inNext {
			if t := strings.TrimSpace(nq.Topic); t != "" {
				diffs = append(diffs, fmt.Sprintf("新增第 %d 题（知识点：%s）", n, t))
			} else {
				diffs = append(diffs, fmt.Sprintf("新增第 %d 题", n))
			}
			continue
		}
		if inPrev && !inNext {
			diffs = append(diffs, fmt.Sprintf("删除第 %d 题", n))
			continue
		}

		if pq.Topic != nq.Topic {
			diffs = append(diffs, fmt.Sprintf("第 %d 题：知识点「%s」→「%s」", n, pq.Topic, nq.Topic))
		}
		if msg := diffPDFField(n, "题目 PDF", pq.ExercisePDF, pq.ExerciseSHA256, nq.ExercisePDF, nq.ExerciseSHA256); msg != "" {
			diffs = append(diffs, msg)
		}
		if msg := diffPDFField(n, "答案 PDF", pq.AnswerPDF, pq.AnswerSHA256, nq.AnswerPDF, nq.AnswerSHA256); msg != "" {
			diffs = append(diffs, msg)
		}
		if strings.TrimSpace(pq.VideoURL) != strings.TrimSpace(nq.VideoURL) {
			diffs = append(diffs, fmt.Sprintf("第 %d 题：更新了视频讲解链接", n))
		}
		if metaCanonicalString(pq.QuestionMeta) != metaCanonicalString(nq.QuestionMeta) {
			diffs = append(diffs, fmt.Sprintf("第 %d 题：更新了题框标注/分组信息", n))
		}
		if pq.SubNum != nq.SubNum || intsKey(pq.ParentQuestionNums) != intsKey(nq.ParentQuestionNums) || intPtrVal(pq.ParentQuestionNum) != intPtrVal(nq.ParentQuestionNum) {
			diffs = append(diffs, fmt.Sprintf("第 %d 题：更新了关联原题号/变式序号", n))
		}
	}

	if len(diffs) == 0 {
		return []string{"题目配置内容无变化（重新保存或同步）"}
	}
	return diffs
}

func diffPDFField(qNum int, label, prevURL, prevSHA, nextURL, nextSHA string) string {
	hasPrev := strings.TrimSpace(prevURL) != "" || strings.TrimSpace(prevSHA) != ""
	hasNext := strings.TrimSpace(nextURL) != "" || strings.TrimSpace(nextSHA) != ""
	if !hasPrev && !hasNext {
		return ""
	}
	if !hasPrev && hasNext {
		if s := ShortSHA256(nextSHA); s != "" {
			return fmt.Sprintf("第 %d 题：上传了%s（%s）", qNum, label, s)
		}
		return fmt.Sprintf("第 %d 题：上传了%s", qNum, label)
	}
	if hasPrev && !hasNext {
		return fmt.Sprintf("第 %d 题：移除了%s", qNum, label)
	}
	if prevSHA != nextSHA || strings.TrimSpace(prevURL) != strings.TrimSpace(nextURL) {
		pShort := ShortSHA256(prevSHA)
		nShort := ShortSHA256(nextSHA)
		if pShort != "" && nShort != "" && pShort != nShort {
			return fmt.Sprintf("第 %d 题：更换了%s（%s → %s）", qNum, label, pShort, nShort)
		}
		return fmt.Sprintf("第 %d 题：更换了%s", qNum, label)
	}
	return ""
}

func metaCanonicalString(m map[string]any) string {
	if len(m) == 0 {
		return ""
	}
	b, err := MarshalCanonicalJSON(m)
	if err != nil {
		return ""
	}
	return string(b)
}

func intsKey(nums []int) string {
	if len(nums) == 0 {
		return ""
	}
	cp := make([]int, len(nums))
	copy(cp, nums)
	sort.Ints(cp)
	parts := make([]string, len(cp))
	for i, n := range cp {
		parts[i] = fmt.Sprintf("%d", n)
	}
	return strings.Join(parts, ",")
}

func intPtrVal(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}
