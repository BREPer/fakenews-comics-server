package sources

import (
	"sync"
	"testing"
)

// TestNaturalCompareConcurrent 并发调用自然排序 / 拼音序比较不能 panic。
//
// 回归背景：zhCollator 是包级单例，而 collate.Collator 内部维护可变的迭代器与缓冲
// （compare 过程中复用），**不是并发安全的**。folder 章节目录列页时要对文件名做
// NaturalSort，阅读器预加载、封面生成、列表排序会同时在多个 goroutine 里跑 ——
// 压测（1500 请求 / 并发 32）实测到 `runtime error: index out of range [-1]`，
// 被 recover 兜住后表现为「某张页图 500」，用户看到图裂。
func TestNaturalCompareConcurrent(t *testing.T) {
	names := []string{
		"第01卷", "第02卷", "第10卷", "第100卷", "番外", "序章", "特别篇",
		"Chapter 2", "Chapter 10", "v1", "v10", "001", "1", "封面",
	}
	titles := []string{"海贼王", "阿飞正传", "格林童话", "混合结构", "目录刮削", "样张测试", "都市夜归人", "围城"}

	const goroutines = 32
	const rounds = 300
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for g := 0; g < goroutines; g++ {
		go func() {
			defer wg.Done()
			for i := 0; i < rounds; i++ {
				// 自然排序（读图路径：folder ListPages）
				_ = NaturalSort(names, func(s string) string { return s })
				// 拼音序（列表页按标题排序）
				for k := 1; k < len(titles); k++ {
					_ = CompareZH(titles[k-1], titles[k])
				}
			}
		}()
	}
	wg.Wait()
}

// TestNaturalCompareBasicRules 保证并发修复没改变排序语义。
func TestNaturalCompareBasicRules(t *testing.T) {
	cases := []struct {
		a, b string
		want int // <0 表示 a 在前
	}{
		{"第2卷", "第10卷", -1},   // 数字按数值
		{"v2", "v10", -1},     // 同上
		{"001", "1", 0},       // 前导零不影响
		{"第01卷", "番外", -1},    // 数字段排在同位文本段前
		{"第1卷", "第1卷", 0},     // 相等
		{"第1卷", "第1卷 番外", -1}, // 前缀更短
	}
	for _, c := range cases {
		got := NaturalCompare(c.a, c.b)
		switch {
		case c.want == 0 && got != 0:
			t.Fatalf("%q vs %q = %d, want 0", c.a, c.b, got)
		case c.want < 0 && got >= 0:
			t.Fatalf("%q 应排在 %q 之前，实际 %d", c.a, c.b, got)
		case c.want > 0 && got <= 0:
			t.Fatalf("%q 应排在 %q 之后，实际 %d", c.a, c.b, got)
		}
	}
}
