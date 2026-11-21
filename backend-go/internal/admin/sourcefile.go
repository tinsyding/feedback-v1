package admin

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

var (
	reNonSafeOrig   = regexp.MustCompile(`[^a-zA-Z0-9.\-_]`)
	reArchiveFile   = regexp.MustCompile(`(?i)^(\d{8})_(\d{6})_([a-z_]+)_(.*)$`)
	reBatchCodeTime = regexp.MustCompile(`^B(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})`)
)

// SourceFileMatch holds the best matched archived source file.
type SourceFileMatch struct {
	Path         string
	BaseOrig     string
	ArchivedName string
	Size         int64
	Timestamp    int64
}

type sourceCandidate struct {
	path       string
	ts         int64
	fileType   string
	exactIndex bool
	score      int64
}

// ParseBatchCodeTimestamp parses BYYYYMMDD_HHMMSS... into a Unix timestamp in local time.
func ParseBatchCodeTimestamp(batchCode string) (int64, bool) {
	m := reBatchCodeTime.FindStringSubmatch(strings.TrimSpace(batchCode))
	if len(m) != 7 {
		return 0, false
	}
	t, err := time.ParseInLocation("2006-01-02 15:04:05",
		m[1]+"-"+m[2]+"-"+m[3]+" "+m[4]+":"+m[5]+":"+m[6], time.Local)
	if err != nil {
		return 0, false
	}
	return t.Unix(), true
}

// FindSourceFile locates the best archived upload file matching origFileName under uploadDirs.
// Mirrors PHP actions_crud.php download_source_file lines 1196-1345.
func FindSourceFile(uploadDirs []string, origFileName, studentName string, refTimestamps []int64) (*SourceFileMatch, bool) {
	baseOrig := filepath.Base(strings.ReplaceAll(strings.TrimSpace(origFileName), "\\", "/"))
	if baseOrig == "" || baseOrig == "." || baseOrig == "/" {
		return nil, false
	}
	expectedSanitized := strings.ToLower(reNonSafeOrig.ReplaceAllString(baseOrig, ""))
	expectedType := InferSourceFileType(baseOrig)

	dedupDirs := make([]string, 0, len(uploadDirs))
	seenDir := map[string]struct{}{}
	for _, d := range uploadDirs {
		if strings.TrimSpace(d) == "" {
			continue
		}
		real, err := filepath.EvalSymlinks(d)
		if err != nil {
			continue
		}
		info, err := os.Stat(real)
		if err != nil || !info.IsDir() {
			continue
		}
		if _, ok := seenDir[real]; ok {
			continue
		}
		seenDir[real] = struct{}{}
		dedupDirs = append(dedupDirs, real)
	}

	candidates := map[string]*sourceCandidate{}

	// 1. Exact lookup via index.jsonl
	for _, uDir := range dedupDirs {
		idxPath := filepath.Join(uDir, "index.jsonl")
		f, err := os.Open(idxPath)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" {
				continue
			}
			var item struct {
				Orig string `json:"orig"`
				Rel  string `json:"rel"`
				TS   int64  `json:"ts"`
				Type string `json:"type"`
			}
			if err := json.Unmarshal([]byte(line), &item); err != nil || item.Rel == "" {
				continue
			}
			if item.Orig != baseOrig {
				continue
			}
			relClean := filepath.Clean(strings.TrimLeft(item.Rel, "/"))
			if strings.HasPrefix(relClean, "..") {
				continue
			}
			fullPath := filepath.Join(uDir, relClean)
			info, err := os.Stat(fullPath)
			if err != nil || info.IsDir() {
				continue
			}
			ts := item.TS
			if ts <= 0 {
				ts = info.ModTime().Unix()
			}
			candidates[fullPath] = &sourceCandidate{
				path:       fullPath,
				ts:         ts,
				fileType:   item.Type,
				exactIndex: true,
			}
		}
		_ = f.Close()
	}

	// 2. Scan data/uploads/*/*
	for _, uDir := range dedupDirs {
		matches, _ := filepath.Glob(filepath.Join(uDir, "*", "*"))
		for _, fPath := range matches {
			info, err := os.Stat(fPath)
			if err != nil || info.IsDir() {
				continue
			}
			bName := filepath.Base(fPath)
			m := reArchiveFile.FindStringSubmatch(bName)
			if len(m) != 5 {
				continue
			}
			dStr, tStr, fType, fRest := m[1], m[2], strings.ToLower(m[3]), strings.ToLower(m[4])
			if fRest != expectedSanitized && strings.ToLower(bName) != strings.ToLower(baseOrig) {
				continue
			}
			if expectedType != "" && fType != expectedType {
				continue
			}
			fTs := info.ModTime().Unix()
			if parsed, err := time.ParseInLocation("20060102150405", dStr+tStr, time.Local); err == nil {
				fTs = parsed.Unix()
			}
			if _, exists := candidates[fPath]; !exists {
				candidates[fPath] = &sourceCandidate{
					path:     fPath,
					ts:       fTs,
					fileType: fType,
				}
			}
		}
	}

	if len(candidates) == 0 {
		return nil, false
	}

	// 3. Score candidates
	needContentCheck := len(candidates) > 1 && strings.TrimSpace(studentName) != ""
	nameBytes := []byte(strings.TrimSpace(studentName))

	scored := make([]*sourceCandidate, 0, len(candidates))
	for _, cand := range candidates {
		var score int64
		if cand.exactIndex {
			score += 2000000
		}
		if expectedType != "" && cand.fileType == expectedType {
			score += 1000000
		}
		if len(refTimestamps) > 0 {
			minDiff := int64(1<<62 - 1)
			bestSigned := int64(1<<62 - 1)
			for _, rTs := range refTimestamps {
				signed := rTs - cand.ts
				absDiff := signed
				if absDiff < 0 {
					absDiff = -absDiff
				}
				if absDiff < minDiff {
					minDiff = absDiff
					bestSigned = signed
				}
			}
			if bestSigned >= -300 && bestSigned <= 7200 {
				score += 500000 - minDiff
			} else if minDiff <= 86400 {
				score += 200000 - minDiff
			} else {
				if minDiff > 1000000 {
					score -= 1000000
				} else {
					score -= minDiff
				}
			}
		} else {
			score += cand.ts / 1000
		}

		if needContentCheck {
			if f, err := os.Open(cand.path); err == nil {
				head, _ := io.ReadAll(io.LimitReader(f, 524288))
				_ = f.Close()
				if bytes.Contains(head, nameBytes) {
					score += 300000
				}
			}
		}
		cand.score = score
		scored = append(scored, cand)
	}

	sort.Slice(scored, func(i, j int) bool {
		if scored[i].score != scored[j].score {
			return scored[i].score > scored[j].score
		}
		return scored[i].ts > scored[j].ts
	})

	best := scored[0]
	info, err := os.Stat(best.path)
	if err != nil {
		return nil, false
	}
	return &SourceFileMatch{
		Path:         best.path,
		BaseOrig:     baseOrig,
		ArchivedName: filepath.Base(best.path),
		Size:         info.Size(),
		Timestamp:    best.ts,
	}, true
}
