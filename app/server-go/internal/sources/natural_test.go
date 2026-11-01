package sources

import (
	"testing"
)

// 自然排序核心语义：第02卷 < 第10卷、01 < 1、数字段先于文本段。
func TestNaturalCompare(t *testing.T) {
	cases := []struct {
		a, b string
		want int // -1 / 0 / 1
	}{
		{"第02卷", "第10卷", -1},
		{"第10卷", "第02卷", 1},
		{"01", "1", 0}, // 数值相等（与 TS 的 Number("01")===Number("1") 一致）
		{"v2", "v10", -1},
		{"001.jpg", "002.jpg", -1},
		{"第01卷", "番外", -1}, // 数字段先于文本段
		{"abc", "abc", 0},
	}
	for _, c := range cases {
		got := sign(NaturalCompare(c.a, c.b))
		if got != c.want {
			t.Errorf("NaturalCompare(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

// 中文按拼音序：阿 < 格 < 海（对齐 Intl.Collator('zh')）。
func TestNaturalCompareChinese(t *testing.T) {
	if NaturalCompare("阿飞正传", "格林童话") >= 0 {
		t.Error("阿飞正传 应排在 格林童话 之前（拼音序）")
	}
	if NaturalCompare("格林童话", "海贼王") >= 0 {
		t.Error("格林童话 应排在 海贼王 之前（拼音序）")
	}
}

func sign(n int) int {
	if n < 0 {
		return -1
	}
	if n > 0 {
		return 1
	}
	return 0
}

func TestNaturalSort(t *testing.T) {
	in := []string{"第10卷", "第02卷", "第01卷", "番外"}
	got := NaturalSort(in, func(s string) string { return s })
	want := []string{"第01卷", "第02卷", "第10卷", "番外"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("排序结果 %v, want %v", got, want)
		}
	}
}
