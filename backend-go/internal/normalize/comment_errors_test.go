package normalize

import (
	"reflect"
	"testing"
)

func TestParseErrorQuestionsFromComment(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want []int
	}{
		{"empty", "", []int{}},
		{"no_error_header", "本次作业错题：无。", []int{}},
		{"all_correct", "本次作业全部做对，继续保持！", []int{}},
		{"prefix_colon_and_han_cutoff", "错题：1、３、5 几何概念还需加强第99分", []int{1, 3, 5}},
		{"prefix_next_line", "本次错题：\n2, 4, 6\n加油", []int{2, 4, 6}},
		{"prefix_space_no_colon", "做错 第2题、第7题，计算粗心", []int{2, 7}},
		{"pure_numbers_first_line", "第1题、第3题、第8题。", []int{1, 3, 8}},
		{"ignore_score_in_prose", "本次考了98分，班级第1名，表现优秀！", []int{}},
		{"filter_out_of_range", "错题：0, 1, 101, 5, 5", []int{1, 5}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseErrorQuestionsFromComment(tc.in)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("ParseErrorQuestionsFromComment(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}
