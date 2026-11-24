package retestkeys

import "strings"

func phpTrim(s string) string {
	return strings.Trim(s, " \t\n\r\x00\x0b")
}

// BuildStudentKey constructs the canonical student identity key:
// "{id}_{name}_{grade}_{subject}".
// Mirrors PHP feedback-v1/api/lib_retest_keys.php build_student_key().
func BuildStudentKey(id, name, grade, subject string) string {
	id = phpTrim(id)
	name = phpTrim(name)
	grade = phpTrim(grade)
	subject = phpTrim(subject)

	if id == "" {
		return name
	}
	if grade == "" || subject == "" {
		return id + "_" + name
	}
	return id + "_" + name + "_" + grade + "_" + subject
}

// LegacyStudentKey returns the pre-migration key "{id}_{name}" (or pure name if id is empty).
// Mirrors PHP legacy_student_key().
func LegacyStudentKey(id, name string) string {
	id = phpTrim(id)
	name = phpTrim(name)
	if id != "" {
		return id + "_" + name
	}
	return name
}

// StudentKeyCandidates returns ordered unique candidate keys (canonical first, then legacy).
// Mirrors PHP student_key_candidates().
func StudentKeyCandidates(id, name, grade, subject string) []string {
	primary := BuildStudentKey(id, name, grade, subject)
	legacy := LegacyStudentKey(id, name)

	out := make([]string, 0, 2)
	if primary != "" {
		out = append(out, primary)
	}
	if legacy != "" && legacy != primary {
		out = append(out, legacy)
	}
	return out
}

// IsLegacyNameOnlyKey reports whether key represents a name-only row (empty or equal to name).
// Mirrors PHP is_legacy_name_only_key().
func IsLegacyNameOnlyKey(key, name string) bool {
	key = phpTrim(key)
	name = phpTrim(name)
	return name != "" && (key == "" || key == name)
}
